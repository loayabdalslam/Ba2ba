import os

import pytest

from bee2bee.identity import Identity
from bee2bee.settings import Settings, get_settings


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BEE2BEE_HOME", str(tmp_path / "home"))
    for key in list(os.environ):
        if key.startswith("BEE2BEE_") and key != "BEE2BEE_HOME":
            monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def make_settings(**overrides) -> Settings:
    base = dict(
        host="127.0.0.1",
        port=0,
        upnp=False,
        api_key="test-key",
        ping_interval=0.5,
        handshake_timeout=2.0,
        request_timeout=5.0,
        registry_interval=3600,
        target_peers=0,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def settings_factory():
    return make_settings


@pytest.fixture
async def node_factory():
    from bee2bee.p2p_runtime import P2PNode

    nodes = []

    async def _make(services=(), **overrides):
        node = P2PNode(settings=make_settings(**overrides), identity=Identity.generate())
        for svc in services:
            node.local_services[svc.name] = svc
        await node.start()
        nodes.append(node)
        return node

    yield _make
    for node in nodes:
        await node.stop()
