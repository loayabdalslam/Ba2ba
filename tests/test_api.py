import json

import httpx
import pytest

from bee2bee.api import create_app
from bee2bee.services import EchoService

H = {"X-API-KEY": "test-key"}


@pytest.fixture
async def api(node_factory):
    node = await node_factory(services=[EchoService("echo")], rate_limit_per_minute=1000)
    app = create_app(node=node)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, node


async def test_public_endpoints(api):
    client, node = api
    assert (await client.get("/healthz")).json() == {"status": "ok"}
    assert (await client.get("/readyz")).status_code == 200
    home = (await client.get("/")).json()
    assert home["peer_id"] == node.peer_id and home["models"] == ["echo"]


@pytest.mark.parametrize("path", ["/peers", "/providers", "/metrics", "/v1/models"])
async def test_protected_endpoints_require_key(api, path):
    client, _ = api
    assert (await client.get(path)).status_code == 401
    assert (await client.get(path, headers={"X-API-KEY": "wrong"})).status_code == 401
    assert (await client.get(path, headers=H)).status_code == 200
    assert (await client.get(path, headers={"Authorization": "Bearer test-key"})).status_code == 200


async def test_chat_buffered(api):
    client, _ = api
    r = await client.post("/chat", json={"prompt": "hello there", "model": "echo"}, headers=H)
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "hello there" and body["usage"]["completion_tokens"] == 2


async def test_chat_stream_is_ndjson(api):
    client, _ = api
    r = await client.post("/generate", json={"prompt": "a b c", "stream": True}, headers=H)
    lines = [json.loads(line) for line in r.text.strip().splitlines()]
    assert [line.get("text") for line in lines[:3]] == ["a", " b", " c"]
    assert lines[-1]["done"] is True and lines[-1]["usage"]["completion_tokens"] == 3


async def test_chat_errors_map_to_http_status(api):
    client, _ = api
    r = await client.post("/chat", json={"prompt": "x", "model": "nope"}, headers=H)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "no_provider"
    assert (await client.post("/chat", json={}, headers=H)).status_code == 400
    assert (await client.post("/chat", json={"prompt": "x", "temperature": 5}, headers=H)).status_code == 422


async def test_prompt_size_limit(node_factory):
    node = await node_factory(services=[EchoService("echo")], max_prompt_chars=10)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(node=node)), base_url="http://t") as c:
        assert (await c.post("/chat", json={"prompt": "x" * 11}, headers=H)).status_code == 400


async def test_body_size_limit(node_factory):
    node = await node_factory(max_message_bytes=2048)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(node=node)), base_url="http://t") as c:
        r = await c.post("/chat", content=b"x" * 5000, headers={**H, "content-type": "application/json"})
        assert r.status_code == 413


async def test_rate_limit(node_factory):
    node = await node_factory(rate_limit_per_minute=3)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(node=node)), base_url="http://t") as c:
        codes = [(await c.get("/peers", headers=H)).status_code for _ in range(5)]
        assert codes[0] == 200 and 429 in codes
        assert (await c.get("/healthz")).status_code == 200  # health checks are never limited


async def test_connect_validates_address(api):
    client, _ = api
    r = await client.post("/connect", json={"addr": "http://169.254.169.254/latest"}, headers=H)
    assert r.status_code == 400
    assert (await client.get("/connect", params={"addr": "ws://x:1"}, headers=H)).status_code == 405


async def test_openai_chat_completions(api):
    client, _ = api
    body = {"model": "echo", "messages": [{"role": "user", "content": "ping pong"}]}
    r = await client.post("/v1/chat/completions", json=body, headers=H)
    data = r.json()
    assert data["object"] == "chat.completion"
    assert data["choices"][0]["message"]["content"] == "user: ping pong assistant:"
    assert data["usage"]["completion_tokens"] == 4


async def test_openai_streaming(api):
    client, _ = api
    body = {"model": "echo", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    r = await client.post("/v1/chat/completions", json=body, headers=H)
    events = [line[6:] for line in r.text.split("\n\n") if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert text == "user: hi assistant:"
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"


async def test_openai_error_format(api):
    client, _ = api
    body = {"model": "missing", "messages": [{"role": "user", "content": "hi"}]}
    r = await client.post("/v1/chat/completions", json=body, headers=H)
    assert r.status_code == 503 and r.json()["error"]["code"] == "no_provider"


async def test_metrics_exposes_counters(api):
    client, _ = api
    await client.post("/chat", json={"prompt": "a"}, headers=H)
    text = (await client.get("/metrics", headers=H)).text
    assert "bee2bee_peers" in text and "bee2bee_api_requests_total" in text


async def test_generated_api_key_when_unset(node_factory, tmp_path):
    from bee2bee.api import load_or_create_api_key

    node = await node_factory(api_key=None)
    key = load_or_create_api_key(node.settings)
    assert key and len(key) > 30
    assert load_or_create_api_key(node.settings) == key
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(node=node)), base_url="http://t") as c:
        assert (await c.get("/peers")).status_code == 401
        assert (await c.get("/peers", headers={"X-API-KEY": key})).status_code == 200


async def test_auth_can_be_disabled_explicitly(node_factory):
    node = await node_factory(api_auth="off")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(node=node)), base_url="http://t") as c:
        assert (await c.get("/peers")).status_code == 200


async def test_cors_closed_by_default(api):
    client, _ = api
    r = await client.options("/chat", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers
