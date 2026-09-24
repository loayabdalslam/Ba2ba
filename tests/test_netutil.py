import pytest

from bee2bee.netutil import AddressError, validate_peer_addr


def test_accepts_ws_and_wss():
    assert validate_peer_addr("ws://example.com:4003", resolve=False)
    assert validate_peer_addr("wss://example.com", resolve=False)


@pytest.mark.parametrize("addr", ["http://x:1", "file:///etc/passwd", "ws://", "ws://u:p@host:1", "ws://host:99999", 5])
def test_rejects_bad_addresses(addr):
    with pytest.raises(AddressError):
        validate_peer_addr(addr, resolve=False)


def test_require_tls():
    with pytest.raises(AddressError, match="TLS"):
        validate_peer_addr("ws://example.com:1", require_tls=True, resolve=False)


@pytest.mark.parametrize("addr", ["ws://127.0.0.1:1", "ws://10.0.0.5:1", "ws://169.254.169.254:80", "ws://[::1]:1"])
def test_private_addresses_blocked_when_requested(addr):
    with pytest.raises(AddressError, match="private"):
        validate_peer_addr(addr, allow_private=False)
    assert validate_peer_addr(addr, allow_private=True)
