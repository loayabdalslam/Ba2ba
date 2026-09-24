import pytest

from bee2bee import protocol as P
from bee2bee.identity import Identity


def _hello(ident, **kw):
    return P.build_hello(ident, role="node", addr="ws://1.2.3.4:4003", challenge="c" * 32, **kw)


def test_valid_hello_verifies():
    ident = Identity.generate()
    P.verify_hello(_hello(ident))


def test_hello_with_foreign_peer_id_is_rejected():
    ident, other = Identity.generate(), Identity.generate()
    msg = _hello(ident)
    msg["peer_id"] = other.peer_id
    with pytest.raises(P.ProtocolError, match="peer_id does not match"):
        P.verify_hello(msg)


def test_tampered_signed_field_is_rejected():
    msg = _hello(Identity.generate())
    msg["addr"] = "ws://evil:1"
    with pytest.raises(P.ProtocolError, match="signature"):
        P.verify_hello(msg)


def test_unsigned_extras_do_not_break_verification():
    msg = _hello(Identity.generate(), extra={"services": {"x": {"models": ["m"]}}, "region": "eu"})
    msg["metrics"] = {"cpu_percent": 12.5}
    P.verify_hello(msg)


def test_stale_timestamp_is_rejected():
    ident = Identity.generate()
    msg = _hello(ident)
    msg["ts"] -= P.MAX_CLOCK_SKEW_MS + 1000
    msg["sig"] = ident.sign({k: msg[k] for k in P.HELLO_SIGNED_FIELDS})
    with pytest.raises(P.ProtocolError, match="clock skew"):
        P.verify_hello(msg)


def test_hello_must_answer_our_challenge():
    msg = _hello(Identity.generate(), response_to="x" * 32)
    with pytest.raises(P.ProtocolError, match="challenge"):
        P.verify_hello(msg, expected_response="y" * 32)
    P.verify_hello(msg, expected_response="x" * 32)


def test_wrong_protocol_version_is_rejected():
    msg = _hello(Identity.generate())
    msg["protocol_version"] = 1
    with pytest.raises(P.ProtocolError, match="protocol_version"):
        P.verify_hello(msg)


def test_auth_roundtrip():
    ident = Identity.generate()
    msg = P.build_auth(ident, "chal" * 8)
    P.verify_auth(msg, ident.pubkey, ident.peer_id, "chal" * 8)
    with pytest.raises(P.ProtocolError):
        P.verify_auth(msg, ident.pubkey, ident.peer_id, "other" * 8)


LIMITS = dict(max_prompt_chars=100, max_new_tokens=64, max_hops=2)


def test_generation_request_is_clamped():
    req = P.parse_generation_request({"prompt": "hi", "max_new_tokens": 10_000, "temperature": 9}, **LIMITS)
    assert req.max_new_tokens == 64
    assert req.temperature == 2.0


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"prompt": ""},
        {"prompt": 5},
        {"prompt": "x" * 101},
        {"messages": [{"role": "hacker", "content": "x"}]},
        {"messages": []},
        {"prompt": "hi", "hops": 3},
        {"prompt": "hi", "max_new_tokens": "lots"},
    ],
)
def test_invalid_generation_requests(data):
    with pytest.raises(P.ProtocolError):
        P.parse_generation_request(data, **LIMITS)


def test_legacy_max_tokens_alias():
    assert P.parse_generation_request({"prompt": "hi", "max_tokens": 7}, **LIMITS).max_new_tokens == 7


def test_models_match_is_exact():
    assert P.models_match("llama3", "llama3:latest")
    assert P.models_match("Llama3:latest", "llama3")
    assert P.models_match(None, "anything")
    assert not P.models_match("llama", "llama3:70b")
    assert not P.models_match("llama3:70b", "llama3")


def test_prompt_text_flattens_messages():
    req = P.GenerationRequest(messages=[{"role": "user", "content": "hi"}])
    assert req.prompt_text() == "user: hi\nassistant:"
