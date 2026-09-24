"""Runtime settings loaded from environment variables (``BEE2BEE_*``).

Every knob that affects security or resource usage lives here so it can be
validated once at startup instead of being read ad hoc with ``os.getenv``.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

_TRUE = {"1", "true", "yes", "on"}


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(f"BEE2BEE_{name}")
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.lower() in _TRUE


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    return int(value) if value is not None else default


def _env_float(name: str, default: float) -> float:
    value = _env(name)
    return float(value) if value is not None else default


def _env_list(name: str) -> List[str]:
    value = _env(name)
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


class Settings(BaseModel):
    # --- Networking -------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = Field(default=4003, ge=0, le=65535)
    announce_host: Optional[str] = None
    announce_port: Optional[int] = Field(default=None, ge=1, le=65535)
    # Full public URL (e.g. wss://mesh.example.com) when TLS is terminated by a
    # reverse proxy or tunnel. Overrides announce_host/announce_port.
    announce_addr: Optional[str] = None
    bootstrap: List[str] = Field(default_factory=list)
    region: str = "Auto"
    upnp: bool = True

    # TLS for the P2P WebSocket server (wss://) and the HTTP API.
    tls_cert: Optional[str] = None
    tls_key: Optional[str] = None
    # Refuse plain ws:// outbound connections (recommended in production).
    require_tls: bool = False
    # Allow connecting to peers on private/loopback addresses (LAN meshes).
    allow_private_peers: bool = True

    # --- API --------------------------------------------------------------
    api_host: str = "0.0.0.0"
    api_port: int = Field(default=4002, ge=1, le=65535)
    api_key: Optional[str] = None
    # "on" (default) requires an API key; "off" is for local development only.
    api_auth: str = "on"
    cors_origins: List[str] = Field(default_factory=list)
    metrics_public: bool = False
    rate_limit_per_minute: int = Field(default=60, ge=1)
    # Trust X-Forwarded-For (only behind a reverse proxy you control).
    trust_proxy: bool = False

    # --- Mesh policy & limits --------------------------------------------
    allowed_peers: List[str] = Field(default_factory=list)
    # Peers exempt from the per-peer rate limit, e.g. a gateway that carries
    # many users' traffic over one connection. The concurrency cap still applies.
    trusted_peers: List[str] = Field(default_factory=list)
    max_peers: int = Field(default=50, ge=1)
    target_peers: int = Field(default=8, ge=0)
    max_prompt_chars: int = Field(default=32_000, ge=1)
    max_new_tokens: int = Field(default=4096, ge=1)
    max_message_bytes: int = Field(default=1_048_576, ge=1024)
    max_concurrent_generations: int = Field(default=4, ge=1)
    max_hops: int = Field(default=3, ge=0, le=8)
    peer_rate_limit_per_minute: int = Field(default=120, ge=1)
    request_timeout: float = Field(default=300.0, gt=0)
    ping_interval: float = Field(default=15.0, gt=0)
    registry_interval: float = Field(default=30.0, gt=0)
    handshake_timeout: float = Field(default=10.0, gt=0)

    # --- Registry ---------------------------------------------------------
    # Gateway that accepts signed node registrations (preferred).
    registry_url: Optional[str] = None
    # Operator-only direct mode. Never ship the service-role key to clients.
    supabase_url: Optional[str] = None
    supabase_service_key: Optional[str] = None

    # --- Backends ---------------------------------------------------------
    ollama_host: str = "http://localhost:11434"
    hf_token: Optional[str] = None

    # --- Observability ----------------------------------------------------
    log_level: str = "INFO"
    log_json: bool = False
    log_file: Optional[str] = None
    sentry_dsn: Optional[str] = None

    @field_validator("api_auth")
    @classmethod
    def _check_auth(cls, value: str) -> str:
        value = value.lower()
        if value not in {"on", "off"}:
            raise ValueError("BEE2BEE_API_AUTH must be 'on' or 'off'")
        return value

    @field_validator("tls_key")
    @classmethod
    def _check_tls_pair(cls, value: Optional[str], info) -> Optional[str]:
        cert = info.data.get("tls_cert")
        if bool(cert) != bool(value):
            raise ValueError("BEE2BEE_TLS_CERT and BEE2BEE_TLS_KEY must be set together")
        return value

    @property
    def tls_enabled(self) -> bool:
        return bool(self.tls_cert and self.tls_key)


def load_settings(**overrides) -> Settings:
    """Build settings from the environment, with keyword overrides on top."""
    from .config import load_config

    cfg = load_config()
    bootstrap = _env_list("BOOTSTRAP")
    if not bootstrap and cfg.get("bootstrap_url"):
        bootstrap = [cfg["bootstrap_url"]]

    data: Dict[str, Any] = dict(
        host=_env("HOST", "0.0.0.0"),
        port=_env_int("PORT", 4003),
        announce_host=_env("ANNOUNCE_HOST"),
        announce_port=_env_int("ANNOUNCE_PORT", 0) or None,
        announce_addr=_env("ANNOUNCE_ADDR"),
        bootstrap=bootstrap,
        region=_env("REGION", "Auto"),
        upnp=_env_bool("UPNP", True),
        tls_cert=_env("TLS_CERT"),
        tls_key=_env("TLS_KEY"),
        require_tls=_env_bool("REQUIRE_TLS", False),
        allow_private_peers=_env_bool("ALLOW_PRIVATE_PEERS", True),
        api_host=_env("API_HOST", "0.0.0.0"),
        api_port=_env_int("API_PORT", 4002),
        api_key=_env("API_KEY"),
        api_auth=_env("API_AUTH", "on"),
        cors_origins=_env_list("CORS_ORIGINS"),
        metrics_public=_env_bool("METRICS_PUBLIC", False),
        rate_limit_per_minute=_env_int("RATE_LIMIT_PER_MINUTE", 60),
        trust_proxy=_env_bool("TRUST_PROXY", False),
        allowed_peers=_env_list("ALLOWED_PEERS"),
        trusted_peers=_env_list("TRUSTED_PEERS"),
        max_peers=_env_int("MAX_PEERS", 50),
        target_peers=_env_int("TARGET_PEERS", 8),
        max_prompt_chars=_env_int("MAX_PROMPT_CHARS", 32_000),
        max_new_tokens=_env_int("MAX_NEW_TOKENS", 4096),
        max_message_bytes=_env_int("MAX_MESSAGE_BYTES", 1_048_576),
        max_concurrent_generations=_env_int("MAX_CONCURRENT_GENERATIONS", 4),
        max_hops=_env_int("MAX_HOPS", 3),
        peer_rate_limit_per_minute=_env_int("PEER_RATE_LIMIT_PER_MINUTE", 120),
        request_timeout=_env_float("REQUEST_TIMEOUT", 300.0),
        ping_interval=_env_float("PING_INTERVAL", 15.0),
        registry_interval=_env_float("REGISTRY_INTERVAL", 30.0),
        handshake_timeout=_env_float("HANDSHAKE_TIMEOUT", 10.0),
        registry_url=_env("REGISTRY_URL"),
        supabase_url=_env("SUPABASE_URL") or os.getenv("SUPABASE_URL"),
        supabase_service_key=_env("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        ollama_host=_env("OLLAMA_HOST") or os.getenv("OLLAMA_HOST") or "http://localhost:11434",
        hf_token=_env("HF_TOKEN") or os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN"),
        log_level=_env("LOG_LEVEL") or os.getenv("LOG_LEVEL") or "INFO",
        log_json=_env_bool("LOG_JSON", False),
        log_file=_env("LOG_FILE"),
        sentry_dsn=_env("SENTRY_DSN") or os.getenv("SENTRY_DSN"),
    )
    data.update({k: v for k, v in overrides.items() if v is not None})
    return Settings(**data)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
