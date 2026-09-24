"""Ed25519 node identity.

A node's ``peer_id`` is derived from its public key, so a peer can only claim
an id it holds the private key for. Signatures are computed over a canonical
JSON encoding that the JavaScript gateway reproduces byte for byte
(sorted keys, no whitespace, UTF-8, integers only).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from pathlib import Path
from typing import Any, Mapping, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

PEER_ID_PREFIX = "peer-"
KEY_FILE = "node_key.pem"


def canonical_json(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"), validate=True)


def peer_id_from_pubkey(pubkey_b64: str) -> str:
    raw = b64decode(pubkey_b64)
    return PEER_ID_PREFIX + hashlib.sha256(raw).hexdigest()[:32]


def new_nonce() -> str:
    return secrets.token_hex(16)


def verify(pubkey_b64: str, payload: Mapping[str, Any], signature_b64: str) -> bool:
    try:
        raw = b64decode(pubkey_b64)
        if len(raw) != 32:
            return False
        Ed25519PublicKey.from_public_bytes(raw).verify(b64decode(signature_b64), canonical_json(payload))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


class Identity:
    def __init__(self, private_key: Ed25519PrivateKey):
        self._key = private_key
        raw = private_key.public_key().public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
        self.pubkey = b64encode(raw)
        self.peer_id = peer_id_from_pubkey(self.pubkey)

    @classmethod
    def generate(cls) -> Identity:
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def load_or_create(cls, path: Optional[Path] = None) -> Identity:
        if path is None:
            from .utils import bee2bee_home

            path = bee2bee_home() / KEY_FILE
        if path.exists():
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError(f"{path} is not an Ed25519 private key")
            return cls(key)
        identity = cls.generate()
        pem = identity._key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(pem)
        return identity

    def sign(self, payload: Mapping[str, Any]) -> str:
        return b64encode(self._key.sign(canonical_json(payload)))
