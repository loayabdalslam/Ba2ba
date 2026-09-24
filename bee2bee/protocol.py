"""Bee2Bee wire protocol (v2).

All messages are JSON objects with a ``type`` field. See docs/PROTOCOL.md for
the full specification; the gateway (gateway/src/protocol.js) implements the
same rules.

Handshake (mutual challenge/response):

1. The connecting side sends ``hello`` with a fresh ``challenge``.
2. The accepting side verifies it and answers with its own ``hello`` whose
   ``response_to`` echoes that challenge (proving it holds its key *now*) and
   which carries a new ``challenge``.
3. The connecting side answers with ``auth`` signing ``response_to`` = the
   accepting side's challenge.

No other message is processed on a connection until it is authenticated.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import identity

PROTOCOL_VERSION = 2
MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

ROLE_NODE = "node"
ROLE_CLIENT = "client"
ROLES = {ROLE_NODE, ROLE_CLIENT}

HELLO = "hello"
AUTH = "auth"
PEER_LIST = "peer_list"
PING = "ping"
PONG = "pong"
SERVICE_ANNOUNCE = "service_announce"
GEN_REQUEST = "gen_request"
GEN_CHUNK = "gen_chunk"
GEN_DONE = "gen_done"
GEN_ERROR = "gen_error"
GEN_CANCEL = "gen_cancel"

# Older peers used these names for the final message of a generation.
GEN_DONE_ALIASES = {GEN_DONE, "gen_result", "gen_success", "gen_response"}

# Fields covered by the hello signature. Everything else in a hello is
# informational and bound to the connection by the handshake itself.
HELLO_SIGNED_FIELDS = (
    "type",
    "protocol_version",
    "peer_id",
    "pubkey",
    "role",
    "addr",
    "ts",
    "nonce",
    "challenge",
    "response_to",
)

ERROR_CODES = {
    "bad_request",
    "busy",
    "no_provider",
    "rate_limited",
    "timeout",
    "provider_error",
    "cancelled",
    "unauthorized",
}


class ProtocolError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def now_ms() -> int:
    return int(time.time() * 1000)


def build_hello(
    ident: identity.Identity,
    *,
    role: str,
    addr: str,
    challenge: str,
    response_to: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    msg: Dict[str, Any] = {
        "type": HELLO,
        "protocol_version": PROTOCOL_VERSION,
        "peer_id": ident.peer_id,
        "pubkey": ident.pubkey,
        "role": role,
        "addr": addr or "",
        "ts": now_ms(),
        "nonce": identity.new_nonce(),
        "challenge": challenge,
        "response_to": response_to or "",
    }
    msg["sig"] = ident.sign({k: msg[k] for k in HELLO_SIGNED_FIELDS})
    if extra:
        for key, value in extra.items():
            if key not in msg:
                msg[key] = value
    return msg


def verify_hello(msg: Dict[str, Any], expected_response: Optional[str] = None) -> None:
    """Validate a hello message; raise ProtocolError if it is not acceptable."""
    try:
        version = int(msg.get("protocol_version", 0))
    except (TypeError, ValueError):
        raise ProtocolError("bad_request", "invalid protocol_version")
    if version != PROTOCOL_VERSION:
        raise ProtocolError("bad_request", f"unsupported protocol_version {version}")
    for key in HELLO_SIGNED_FIELDS:
        if key not in msg:
            raise ProtocolError("bad_request", f"hello missing {key}")
    if msg.get("role") not in ROLES:
        raise ProtocolError("bad_request", "invalid role")
    for key in ("peer_id", "pubkey", "nonce", "challenge", "sig", "addr", "response_to"):
        if not isinstance(msg.get(key), str):
            raise ProtocolError("bad_request", f"invalid {key}")
    if not isinstance(msg.get("ts"), int):
        raise ProtocolError("bad_request", "invalid ts")
    if abs(now_ms() - msg["ts"]) > MAX_CLOCK_SKEW_MS:
        raise ProtocolError("unauthorized", "hello timestamp outside allowed clock skew")
    if len(msg["challenge"]) < 16:
        raise ProtocolError("bad_request", "challenge too short")
    try:
        derived = identity.peer_id_from_pubkey(msg["pubkey"])
    except Exception:
        raise ProtocolError("unauthorized", "invalid pubkey")
    if derived != msg["peer_id"]:
        raise ProtocolError("unauthorized", "peer_id does not match pubkey")
    signed = {k: msg[k] for k in HELLO_SIGNED_FIELDS}
    if not identity.verify(msg["pubkey"], signed, msg["sig"]):
        raise ProtocolError("unauthorized", "invalid hello signature")
    if expected_response is not None and msg["response_to"] != expected_response:
        raise ProtocolError("unauthorized", "hello does not answer our challenge")


def build_auth(ident: identity.Identity, response_to: str) -> Dict[str, Any]:
    body = {"type": AUTH, "peer_id": ident.peer_id, "response_to": response_to}
    return {**body, "sig": ident.sign(body)}


def verify_auth(msg: Dict[str, Any], pubkey: str, peer_id: str, challenge: str) -> None:
    body = {"type": AUTH, "peer_id": msg.get("peer_id"), "response_to": msg.get("response_to")}
    if body["peer_id"] != peer_id or body["response_to"] != challenge:
        raise ProtocolError("unauthorized", "auth does not answer our challenge")
    if not isinstance(msg.get("sig"), str) or not identity.verify(pubkey, body, msg["sig"]):
        raise ProtocolError("unauthorized", "invalid auth signature")


# --- Generation requests --------------------------------------------------


@dataclass
class GenerationRequest:
    prompt: Optional[str] = None
    messages: Optional[List[Dict[str, str]]] = None
    model: Optional[str] = None
    max_new_tokens: int = 512
    temperature: float = 0.7
    stream: bool = False
    hops: int = 0

    def to_wire(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "model": self.model,
            "max_new_tokens": self.max_new_tokens,
            "temperature": self.temperature,
            "stream": self.stream,
            "hops": self.hops,
        }
        if self.prompt is not None:
            out["prompt"] = self.prompt
        if self.messages is not None:
            out["messages"] = self.messages
        return out

    def prompt_text(self) -> str:
        """Flatten chat messages into a plain prompt for text-only backends."""
        if self.prompt is not None:
            return self.prompt
        lines = [f"{m['role']}: {m['content']}" for m in self.messages or []]
        lines.append("assistant:")
        return "\n".join(lines)


VALID_ROLES = {"system", "user", "assistant"}


def parse_generation_request(
    data: Dict[str, Any], *, max_prompt_chars: int, max_new_tokens: int, max_hops: int
) -> GenerationRequest:
    """Validate an untrusted generation request (from a peer or the API)."""
    prompt = data.get("prompt")
    messages = data.get("messages")
    if prompt is None and messages is None:
        raise ProtocolError("bad_request", "prompt or messages is required")
    total_chars = 0
    if prompt is not None:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ProtocolError("bad_request", "prompt must be a non-empty string")
        total_chars += len(prompt)
    clean_messages: Optional[List[Dict[str, str]]] = None
    if messages is not None:
        if not isinstance(messages, list) or not messages or len(messages) > 256:
            raise ProtocolError("bad_request", "messages must be a non-empty list (max 256)")
        clean_messages = []
        for m in messages:
            if not isinstance(m, dict) or m.get("role") not in VALID_ROLES or not isinstance(m.get("content"), str):
                raise ProtocolError("bad_request", "each message needs a valid role and string content")
            total_chars += len(m["content"])
            clean_messages.append({"role": m["role"], "content": m["content"]})
    if total_chars > max_prompt_chars:
        raise ProtocolError("bad_request", f"prompt exceeds {max_prompt_chars} characters")

    model = data.get("model")
    if model is not None and (not isinstance(model, str) or len(model) > 200):
        raise ProtocolError("bad_request", "invalid model")

    raw_tokens = data.get("max_new_tokens", data.get("max_tokens"))
    try:
        tokens = int(raw_tokens) if raw_tokens is not None else min(512, max_new_tokens)
    except (TypeError, ValueError):
        raise ProtocolError("bad_request", "max_new_tokens must be an integer")
    tokens = max(1, min(tokens, max_new_tokens))

    raw_temp = data.get("temperature", 0.7)
    try:
        temperature = float(raw_temp) if raw_temp is not None else 0.7
    except (TypeError, ValueError):
        raise ProtocolError("bad_request", "temperature must be a number")
    temperature = max(0.0, min(temperature, 2.0))

    try:
        hops = int(data.get("hops", 0) or 0)
    except (TypeError, ValueError):
        hops = max_hops
    if hops < 0 or hops > max_hops:
        raise ProtocolError("bad_request", "hop limit exceeded")

    return GenerationRequest(
        prompt=prompt,
        messages=clean_messages,
        model=model or None,
        max_new_tokens=tokens,
        temperature=temperature,
        stream=bool(data.get("stream", False)),
        hops=hops,
    )


def normalize_model(name: str) -> str:
    name = name.strip().lower()
    if name.endswith(":latest"):
        name = name[: -len(":latest")]
    return name


def models_match(requested: Optional[str], offered: str) -> bool:
    """Exact model match, treating ``name`` and ``name:latest`` as equal."""
    if not requested:
        return True
    return normalize_model(requested) == normalize_model(offered)


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def tokens_per_sec(self) -> float:
        if self.latency_ms <= 0:
            return 0.0
        return round(self.completion_tokens / (self.latency_ms / 1000.0), 2)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "latency_ms": self.latency_ms,
            "tokens_per_sec": self.tokens_per_sec,
            **self.extra,
        }
