"""Integration tests: real nodes talking over localhost WebSockets."""

import asyncio
import json
from contextlib import aclosing

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from bee2bee import protocol as P
from bee2bee.identity import Identity
from bee2bee.p2p_runtime import GenerationError
from bee2bee.protocol import GenerationRequest
from bee2bee.services import EchoService

from .helpers import FailingService, SlowService, wait_for


async def _link(a, b):
    await a.connect(b.addr)
    await wait_for(lambda: b.peer_id in a.peers and a.peer_id in b.peers)


async def test_handshake_authenticates_both_sides(node_factory):
    a = await node_factory()
    b = await node_factory(services=[EchoService("echo-model")])
    await _link(a, b)
    assert a.peers[b.peer_id].authenticated and b.peers[a.peer_id].authenticated
    assert a.providers[b.peer_id]["echo"]["models"] == ["echo-model"]


async def test_remote_generation_returns_result(node_factory):
    """Regression: responses used to be sent as gen_success but only gen_result was handled."""
    a = await node_factory()
    b = await node_factory(services=[EchoService("echo-model")])
    await _link(a, b)
    result = await a.generate(GenerationRequest(prompt="hello mesh world", model="echo-model"))
    assert result["text"] == "hello mesh world"
    assert result["provider"] == b.peer_id
    assert result["usage"]["completion_tokens"] == 3
    assert a.provider_stats[b.peer_id].successes == 1


async def test_remote_streaming_yields_chunks(node_factory):
    a = await node_factory()
    b = await node_factory(services=[EchoService("echo-model")])
    await _link(a, b)
    chunks = []
    async with aclosing(a.stream_generation(GenerationRequest(prompt="one two three", model="echo-model"))) as s:
        async for item in s:
            chunks.append(item)
    assert chunks[:3] == ["one", " two", " three"]
    assert isinstance(chunks[-1], dict) and chunks[-1]["usage"]["completion_tokens"] == 3


async def test_relay_through_intermediate_node(node_factory):
    a = await node_factory()
    b = await node_factory()
    c = await node_factory(services=[EchoService("far-model")])
    await _link(b, c)
    await _link(a, b)
    # a only knows b; b announces no model, so a must ask b explicitly.
    result = await a.generate(GenerationRequest(prompt="relayed text", model="far-model"), provider_id=b.peer_id)
    assert result["text"] == "relayed text"
    assert result["provider"] == c.peer_id


async def test_failover_to_next_provider(node_factory):
    a = await node_factory()
    bad = FailingService("m")
    b1 = await node_factory(services=[bad])
    b2 = await node_factory(services=[EchoService("m")])
    await _link(a, b1)
    await _link(a, b2)
    # Force b1 to rank first.
    a.provider_stats.clear()
    a.providers[b1.peer_id]["failing"]["price_per_token"] = 0.0
    a.providers[b2.peer_id]["echo"]["price_per_token"] = 1.0
    result = await a.generate(GenerationRequest(prompt="still works", model="m"))
    assert result["text"] == "still works"
    assert bad.calls == 1
    assert a.provider_stats[b1.peer_id].failures == 1


async def test_no_provider_error(node_factory):
    a = await node_factory()
    with pytest.raises(GenerationError) as exc:
        await a.generate(GenerationRequest(prompt="x", model="missing"))
    assert exc.value.code == "no_provider"


async def test_disconnect_fails_pending_request_fast(node_factory):
    a = await node_factory()
    slow = SlowService("slow")
    b = await node_factory(services=[slow])
    await _link(a, b)

    async def consume():
        async with aclosing(a.stream_generation(GenerationRequest(prompt="x", model="slow"))) as s:
            async for _ in s:
                pass

    task = asyncio.create_task(consume())
    await asyncio.wait_for(slow.started.wait(), 5)
    await b.stop()
    with pytest.raises(GenerationError) as exc:
        await asyncio.wait_for(task, 5)
    assert exc.value.code == "provider_error"


async def test_consumer_cancel_propagates_to_provider(node_factory):
    a = await node_factory()
    slow = SlowService("slow")
    b = await node_factory(services=[slow])
    await _link(a, b)
    stream = a.stream_generation(GenerationRequest(prompt="x", model="slow"))
    assert await stream.__anext__() == "first"
    await asyncio.wait_for(slow.started.wait(), 5)
    await stream.aclose()
    await asyncio.wait_for(slow.cancelled.wait(), 5)
    await wait_for(lambda: not b.peers[a.peer_id].tasks)


async def test_capacity_limit_returns_busy_and_fails_over(node_factory):
    a = await node_factory()
    slow = SlowService("m")
    b1 = await node_factory(services=[slow], max_concurrent_generations=1)
    b2 = await node_factory(services=[EchoService("m")])
    await _link(a, b1)
    await _link(a, b2)
    first = b1.stream_generation(GenerationRequest(prompt="x", model="m"))
    assert await first.__anext__() == "first"  # occupies b1's only slot
    a.providers[b2.peer_id]["echo"]["price_per_token"] = 1.0
    result = await a.generate(GenerationRequest(prompt="overflow ok", model="m"))
    assert result["provider"] == b2.peer_id
    await first.aclose()


async def _raw_client(addr):
    return await connect(addr)


async def test_messages_before_handshake_are_rejected(node_factory):
    b = await node_factory(services=[EchoService("m")])
    ws = await _raw_client(b.addr)
    await ws.send(json.dumps({"type": "gen_request", "rid": "r1", "prompt": "free compute?", "model": "m"}))
    with pytest.raises(ConnectionClosed):
        while True:
            await asyncio.wait_for(ws.recv(), 3)
    assert ws.close_code == 4003
    assert not b.peers


async def test_impersonation_is_rejected(node_factory):
    b = await node_factory()
    victim, attacker = Identity.generate(), Identity.generate()
    hello = P.build_hello(attacker, role="node", addr="", challenge="c" * 32)
    hello["peer_id"] = victim.peer_id  # claim someone else's id
    ws = await _raw_client(b.addr)
    await ws.send(json.dumps(hello))
    with pytest.raises(ConnectionClosed):
        while True:
            await asyncio.wait_for(ws.recv(), 3)
    assert ws.close_code == 4003
    assert victim.peer_id not in b.peers


async def test_client_must_prove_key_possession_with_auth(node_factory):
    """A replayed hello alone must not authenticate: the auth step signs the server's fresh challenge."""
    b = await node_factory()
    ident = Identity.generate()
    ws = await _raw_client(b.addr)
    await ws.send(json.dumps(P.build_hello(ident, role="client", addr="", challenge="c" * 32)))
    reply = json.loads(await ws.recv())
    assert reply["type"] == "hello" and reply["response_to"] == "c" * 32
    await ws.send(json.dumps(P.build_auth(ident, "wrong-challenge-value-000000")))
    with pytest.raises(ConnectionClosed):
        while True:
            await asyncio.wait_for(ws.recv(), 3)
    assert ident.peer_id not in b.peers


async def test_client_role_can_request_generation(node_factory):
    b = await node_factory(services=[EchoService("m")])
    ident = Identity.generate()
    ws = await _raw_client(b.addr)
    await ws.send(json.dumps(P.build_hello(ident, role="client", addr="", challenge="c" * 32)))
    reply = json.loads(await ws.recv())
    await ws.send(json.dumps(P.build_auth(ident, reply["challenge"])))
    await wait_for(lambda: ident.peer_id in b.peers)
    await ws.send(json.dumps({"type": "gen_request", "rid": "r1", "prompt": "a b", "model": "m", "stream": True}))
    seen = []
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
        if msg["type"] in ("ping", "peer_list"):
            continue
        seen.append(msg["type"])
        if msg["type"] == "gen_done":
            assert msg["usage"]["completion_tokens"] == 2
            break
    assert seen == ["gen_chunk", "gen_chunk", "gen_done"]
    await ws.close()


async def test_allowlist_blocks_unknown_peers(node_factory):
    b = await node_factory(allowed_peers=["peer-someone-else"])
    a = await node_factory()
    with pytest.raises(ConnectionError):
        await a.connect(b.addr)
    assert not b.peers


async def test_peer_rate_limit(node_factory):
    a = await node_factory()
    b = await node_factory(services=[EchoService("m")], peer_rate_limit_per_minute=1)
    await _link(a, b)
    b._peer_limiter.capacity = 1
    b._peer_limiter._buckets.clear()
    await a.generate(GenerationRequest(prompt="ok", model="m"))
    with pytest.raises(GenerationError) as exc:
        await a.generate(GenerationRequest(prompt="again", model="m"))
    assert exc.value.code == "rate_limited"


async def test_peer_list_discovery(node_factory):
    a = await node_factory(target_peers=5)
    b = await node_factory(target_peers=5)
    c = await node_factory(target_peers=5)
    await _link(b, c)
    await _link(a, b)
    # b tells a about c; a's maintenance loop dials it.
    await wait_for(lambda: c.peer_id in a.peers, timeout=5)


async def test_reconnects_to_bootstrap_after_it_restarts(node_factory, settings_factory):
    from bee2bee.p2p_runtime import P2PNode

    b = await node_factory()
    port = b.port
    a = await node_factory(bootstrap=[f"ws://127.0.0.1:{port}"])
    await wait_for(lambda: b.peer_id in a.peers, timeout=5)
    await b.stop()
    await wait_for(lambda: not a.peers, timeout=5)
    a._backoff.clear()
    b2 = P2PNode(settings=settings_factory(port=port), identity=b.identity)
    await b2.start()
    try:
        await wait_for(lambda: b2.peer_id in a.peers, timeout=8)
    finally:
        await b2.stop()


async def test_simultaneous_dial_keeps_single_connection(node_factory):
    a = await node_factory()
    b = await node_factory()
    await asyncio.gather(a.connect(b.addr), b.connect(a.addr), return_exceptions=True)
    await asyncio.sleep(0.5)
    assert b.peer_id in a.peers and a.peer_id in b.peers
    assert len(a.peers) == 1 and len(b.peers) == 1


async def test_dead_peer_is_evicted(node_factory):
    a = await node_factory()
    b = await node_factory()
    await _link(a, b)

    async def silent(conn, obj):  # b stops answering at the application level
        return True

    b._send = silent
    # ping_interval is 0.5s, so a evicts b after ~1.5s of silence.
    await wait_for(lambda: b.peer_id not in a.peers, timeout=5)


async def test_trusted_peer_bypasses_rate_limit(node_factory):
    a = await node_factory()
    b = await node_factory(services=[EchoService("m")], peer_rate_limit_per_minute=1, trusted_peers=[a.peer_id])
    await _link(a, b)
    for _ in range(5):
        assert (await a.generate(GenerationRequest(prompt="ok", model="m")))["text"] == "ok"


async def test_capacity_errors_do_not_hurt_reputation(node_factory):
    a = await node_factory()
    b = await node_factory(services=[EchoService("m")], peer_rate_limit_per_minute=1)
    await _link(a, b)
    b._peer_limiter.capacity = 1
    b._peer_limiter._buckets.clear()
    await a.generate(GenerationRequest(prompt="ok", model="m"))
    with pytest.raises(GenerationError):
        await a.generate(GenerationRequest(prompt="again", model="m"))
    assert a.provider_stats[b.peer_id].failures == 0


async def test_announce_addr_override(node_factory):
    a = await node_factory(announce_addr="wss://mesh.example.com")
    assert a.addr == "wss://mesh.example.com"
