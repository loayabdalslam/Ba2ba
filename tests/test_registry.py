import json

import httpx
import respx

from bee2bee.identity import Identity, peer_id_from_pubkey, verify
from bee2bee.registry import RegistryClient


@respx.mock
async def test_gateway_registration_is_signed(settings_factory):
    route = respx.post("https://gw.example/api/nodes/register").mock(return_value=httpx.Response(200, json={"ok": True}))
    ident = Identity.generate()
    client = RegistryClient(settings_factory(registry_url="https://gw.example"), ident)
    assert await client.sync_node(
        addr="wss://node.example:4003", models=["m"], region="eu", metrics={"cpu_percent": 1.5}, api_port=4002
    )
    body = json.loads(route.calls[0].request.content)
    sig = body.pop("sig")
    body.pop("metrics")
    assert peer_id_from_pubkey(body["pubkey"]) == body["peer_id"] == ident.peer_id
    assert verify(body["pubkey"], body, sig)
    await client.close()


@respx.mock
async def test_direct_mode_uses_service_key_only(settings_factory):
    route = respx.post(url__startswith="https://sb.example/rest/v1/active_nodes").mock(return_value=httpx.Response(201))
    client = RegistryClient(settings_factory(supabase_url="https://sb.example", supabase_service_key="svc"), Identity.generate())
    assert await client.sync_node(addr="ws://x:1", models=[])
    assert route.calls[0].request.headers["apikey"] == "svc"
    await client.close()


def test_disabled_without_configuration(settings_factory):
    assert not RegistryClient(settings_factory(), Identity.generate()).enabled


@respx.mock
async def test_failure_returns_false(settings_factory):
    respx.post("https://gw.example/api/nodes/register").mock(return_value=httpx.Response(403, text="bad sig"))
    client = RegistryClient(settings_factory(registry_url="https://gw.example"), Identity.generate())
    assert not await client.sync_node(addr="ws://x:1", models=[])
    await client.close()
