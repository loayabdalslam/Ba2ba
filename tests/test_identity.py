import stat

from bee2bee.identity import Identity, peer_id_from_pubkey, verify


def test_sign_and_verify_roundtrip():
    ident = Identity.generate()
    payload = {"b": 2, "a": "é", "n": [1, 2]}
    sig = ident.sign(payload)
    assert verify(ident.pubkey, payload, sig)
    assert not verify(ident.pubkey, {**payload, "b": 3}, sig)
    assert not verify(Identity.generate().pubkey, payload, sig)
    assert not verify("not-base64!!", payload, sig)


def test_peer_id_is_derived_from_pubkey():
    ident = Identity.generate()
    assert ident.peer_id == peer_id_from_pubkey(ident.pubkey)
    assert ident.peer_id.startswith("peer-") and len(ident.peer_id) == 37


def test_load_or_create_persists_with_private_permissions(tmp_path):
    path = tmp_path / "key.pem"
    first = Identity.load_or_create(path)
    second = Identity.load_or_create(path)
    assert first.peer_id == second.peer_id
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
