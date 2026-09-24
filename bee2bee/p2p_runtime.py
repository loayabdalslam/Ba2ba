"""Bee2Bee P2P node: authenticated WebSocket mesh with inference routing."""

from __future__ import annotations

import asyncio
import json
import random
import signal
import ssl
import time
from contextlib import aclosing
from dataclasses import replace
from typing import Any, AsyncGenerator, Dict, Iterable, List, Optional, Set, Union
from urllib.parse import urlparse

from loguru import logger
from websockets.asyncio.client import connect
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import protocol as P
from ._version import __version__
from .identity import Identity, new_nonce
from .metrics import Registry
from .netutil import AddressError, validate_peer_addr
from .p2p import parse_join_link
from .protocol import GenerationRequest, ProtocolError, Usage
from .ratelimit import RateLimiter
from .registry import RegistryClient
from .services import BaseService, ServiceError
from .settings import Settings, get_settings
from .utils import get_lan_ip, get_system_metrics, new_id

StreamItem = Union[str, Dict[str, Any]]

CLOSE_PROTOCOL = 4001
CLOSE_FORBIDDEN = 4003
CLOSE_FULL = 4008
CLOSE_DUPLICATE = 4009

MAX_MODELS_PER_SERVICE = 50
MAX_SERVICES_PER_PEER = 16
MAX_KNOWN_ADDRS = 1000
MAX_FAILOVER_ATTEMPTS = 3


class GenerationError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class ProviderStats:
    """Outcome-based reputation used to rank providers."""

    def __init__(self) -> None:
        self.successes = 0
        self.failures = 0
        self.latency_ms: Optional[float] = None

    def success(self, latency_ms: float) -> None:
        self.successes += 1
        self.latency_ms = latency_ms if self.latency_ms is None else 0.8 * self.latency_ms + 0.2 * latency_ms

    def failure(self) -> None:
        self.failures += 1

    @property
    def score(self) -> float:
        # Laplace-smoothed success rate: new peers start at 0.5.
        return (self.successes + 1) / (self.successes + self.failures + 2)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "successes": self.successes,
            "failures": self.failures,
            "reputation": round(self.score, 3),
            "avg_latency_ms": round(self.latency_ms, 1) if self.latency_ms is not None else None,
        }


class Connection:
    def __init__(self, ws, outbound: bool, dial_addr: str = ""):
        self.ws = ws
        self.outbound = outbound
        self.dial_addr = dial_addr
        self.challenge = new_nonce()
        self.authenticated = False
        self.awaiting_auth = False
        self.peer_id: Optional[str] = None
        self.pubkey: Optional[str] = None
        self.role: str = P.ROLE_NODE
        self.addr: str = ""
        self.region: str = ""
        self.version: str = ""
        self.api_port: Optional[int] = None
        self.api_host: Optional[str] = None
        self.metrics: Dict[str, Any] = {}
        self.services: Dict[str, Dict[str, Any]] = {}
        self.last_seen = time.monotonic()
        self.last_pong_ms: Optional[float] = None
        self.connected_at = time.time()
        self.tasks: Dict[str, asyncio.Task] = {}

    @property
    def remote(self) -> str:
        try:
            host, port = self.ws.remote_address[:2]
            return f"{host}:{port}"
        except Exception:
            return "?"

    def info(self) -> Dict[str, Any]:
        return {
            "peer_id": self.peer_id,
            "addr": self.addr,
            "role": self.role,
            "region": self.region,
            "version": self.version,
            "latency_ms": round(self.last_pong_ms, 1) if self.last_pong_ms is not None else None,
            "metrics": self.metrics,
            "outbound": self.outbound,
            "connected_at": int(self.connected_at),
        }


class _Pending:
    def __init__(self, peer_id: str):
        self.peer_id = peer_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self.started = time.monotonic()


def _sanitize_services(raw: Any) -> Dict[str, Dict[str, Any]]:
    """Keep only well-formed service metadata announced by a peer."""
    out: Dict[str, Dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for name, meta in list(raw.items())[:MAX_SERVICES_PER_PEER]:
        if not isinstance(name, str) or not isinstance(meta, dict) or len(name) > 64:
            continue
        models = [m for m in meta.get("models", []) if isinstance(m, str) and 0 < len(m) <= 200]
        if not models:
            continue
        try:
            price = max(0.0, float(meta.get("price_per_token", 0.0) or 0.0))
        except (TypeError, ValueError):
            price = 0.0
        clean: Dict[str, Any] = {"models": models[:MAX_MODELS_PER_SERVICE], "price_per_token": price}
        for key in ("backend", "tag"):
            if isinstance(meta.get(key), str):
                clean[key] = meta[key][:64]
        if isinstance(meta.get("tokens_per_sec"), (int, float)):
            clean["tokens_per_sec"] = float(meta["tokens_per_sec"])
        out[name] = clean
    return out


class P2PNode:
    def __init__(
        self,
        host: Optional[str] = None,
        port: Optional[int] = None,
        announce_host: Optional[str] = None,
        announce_port: Optional[int] = None,
        entrypoint_url: Optional[str] = None,
        region: Optional[str] = None,
        *,
        settings: Optional[Settings] = None,
        identity: Optional[Identity] = None,
        role: str = P.ROLE_NODE,
    ):
        base = settings or get_settings()
        overrides = {
            k: v
            for k, v in dict(
                host=host,
                port=port,
                announce_host=announce_host,
                announce_port=announce_port,
                registry_url=entrypoint_url,
                region=region,
            ).items()
            if v is not None
        }
        self.settings = base.model_copy(update=overrides) if overrides else base
        self.identity = identity or Identity.load_or_create()
        self.peer_id = self.identity.peer_id
        self.role = role
        self.host = self.settings.host
        self.port = self.settings.port
        self.region = self.settings.region
        self.addr = ""
        self.public_host: Optional[str] = None
        self.api_port: Optional[int] = None
        self.start_time = time.time()

        self.peers: Dict[str, Connection] = {}
        self.local_services: Dict[str, BaseService] = {}
        self.providers: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.provider_stats: Dict[str, ProviderStats] = {}
        self.bootstrap: List[str] = list(self.settings.bootstrap)
        self.known_addrs: Set[str] = set()

        self.registry = RegistryClient(self.settings, self.identity)
        self.metrics = Registry()
        self._m_gen = self.metrics.counter("bee2bee_generations_total", "Generation requests by source and outcome")
        self._m_gen_latency = self.metrics.histogram("bee2bee_generation_seconds", "End-to-end generation latency")
        self._m_tokens = self.metrics.counter("bee2bee_tokens_generated_total", "Completion tokens generated locally")
        self._m_conn = self.metrics.counter("bee2bee_connections_total", "Connection attempts by direction and outcome")
        self.metrics.gauge("bee2bee_peers", "Authenticated peers", fn=lambda: len(self.peers))
        self.metrics.gauge("bee2bee_active_local_generations", "Generations running on this node", fn=lambda: self._active_local)
        self.metrics.gauge("bee2bee_uptime_seconds", "Node uptime", fn=lambda: int(time.time() - self.start_time))

        self._server: Optional[Server] = None
        self._conns: Set[Connection] = set()
        self._pending: Dict[str, _Pending] = {}
        self._tasks: Set[asyncio.Task] = set()
        self._dialing: Set[str] = set()
        self._backoff: Dict[str, tuple] = {}  # addr -> (failures, next_attempt_monotonic)
        self._peer_limiter = RateLimiter(
            self.settings.peer_rate_limit_per_minute, burst=max(10, self.settings.peer_rate_limit_per_minute // 4)
        )
        self._active_local: int = 0
        self._local_metrics: Dict[str, Any] = {}
        self._forwarder: Any = None
        self._running = False

    # ------------------------------------------------------------------ utils

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    @property
    def ready(self) -> bool:
        return self._running

    def _stats(self, pid: str) -> ProviderStats:
        return self.provider_stats.setdefault(pid, ProviderStats())

    # -------------------------------------------------------------- lifecycle

    def _ssl_server_context(self) -> Optional[ssl.SSLContext]:
        if not self.settings.tls_enabled:
            return None
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(str(self.settings.tls_cert), str(self.settings.tls_key))
        return ctx

    async def start(self) -> None:
        logger.info(f"Starting P2P node {self.peer_id} on {self.host}:{self.port}")
        self._server = await serve(
            self._handle_inbound,
            self.host,
            self.port,
            max_size=self.settings.max_message_bytes,
            ssl=self._ssl_server_context(),
            ping_interval=20,
            ping_timeout=20,
            process_request=self._process_http_request,
        )
        if self.port == 0:
            self.port = self._server.sockets[0].getsockname()[1]
        self._running = True
        await self._resolve_announce_addr()
        self._spawn(self._maintenance_loop())
        logger.success(f"P2P node listening, announced as {self.addr}")

    async def _process_http_request(self, connection: ServerConnection, request):
        # Plain HTTP GET /healthz on the P2P port for load balancers.
        if request.path == "/healthz":
            return connection.respond(200, "ok\n")
        return None

    async def _resolve_announce_addr(self) -> None:
        if self.settings.announce_addr:
            self.addr = validate_peer_addr(self.settings.announce_addr, resolve=False)
            self.public_host = urlparse(self.addr).hostname
            return
        scheme = "wss" if self.settings.tls_enabled else "ws"
        host = self.settings.announce_host
        port = self.settings.announce_port or self.port
        if not host:
            if self.host not in ("0.0.0.0", "::", ""):
                host = self.host
            else:
                host = get_lan_ip()
                if self.settings.upnp:
                    host, port = await self._try_nat(host, port)
        self.public_host = host
        self.addr = f"{scheme}://{host}:{port}"

    async def _try_nat(self, host: str, port: int):
        try:
            from .nat import PortForwarder

            self._forwarder = PortForwarder()
            result = await asyncio.wait_for(self._forwarder.auto_forward_port(self.port, "TCP"), timeout=20)
            # Only an actual port mapping makes us reachable; STUN merely reveals the public IP.
            if result and result.success and result.external_ip and result.method in ("UPnP", "NAT-PMP", "PCP"):
                return result.external_ip, result.external_port or port
        except Exception as e:
            logger.warning(f"Automatic port forwarding failed: {e}")
        logger.warning(
            f"Announcing LAN address {host}:{port}. Set BEE2BEE_ANNOUNCE_HOST if peers outside your network must reach you."
        )
        return host, port

    async def stop(self) -> None:
        if not self._running:
            return
        logger.info("Stopping P2P node")
        self._running = False
        for pending in list(self._pending.values()):
            pending.queue.put_nowait(("error", {"code": "cancelled", "error": "node shutting down"}))
        for conn in list(self._conns):
            for task in list(conn.tasks.values()):
                task.cancel()
            try:
                await conn.ws.close(1001, "shutdown")
            except Exception:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for svc in self.local_services.values():
            try:
                await svc.close()
            except Exception:
                pass
        await self.registry.close()
        if self._forwarder is not None:
            try:
                await self._forwarder.cleanup()
            except Exception:
                pass
        logger.success("P2P node stopped")

    # ------------------------------------------------------------ connections

    async def connect_bootstrap(self, link_or_addr: str) -> bool:
        """Add bootstrap address(es) (plain ws URL or join link) and dial them."""
        if "://join" in link_or_addr:
            addrs = parse_join_link(link_or_addr).get("bootstrap", [])
        else:
            addrs = [a.strip() for a in link_or_addr.split(",") if a.strip()]
        ok = False
        for addr in addrs:
            if addr not in self.bootstrap:
                self.bootstrap.append(addr)
            try:
                await self.connect(addr)
                ok = True
            except Exception as e:
                logger.warning(f"Bootstrap {addr} failed: {e}")
        return ok

    async def connect(self, addr: str) -> None:
        """Dial a peer and complete the authenticated handshake."""
        addr = validate_peer_addr(
            addr,
            require_tls=self.settings.require_tls,
            allow_private=self.settings.allow_private_peers,
            resolve=False,
        )
        if not self.settings.allow_private_peers:
            await asyncio.to_thread(validate_peer_addr, addr, require_tls=self.settings.require_tls, allow_private=False)
        if addr == self.addr or addr in self._dialing:
            return
        if any(c.addr == addr or c.dial_addr == addr for c in self.peers.values()):
            return
        if len(self.peers) >= self.settings.max_peers:
            raise ConnectionError("peer limit reached")
        self._dialing.add(addr)
        try:
            try:
                ws = await connect(addr, max_size=self.settings.max_message_bytes, open_timeout=10)
            except Exception as e:
                self._m_conn.inc(direction="outbound", outcome="error")
                self._note_failure(addr)
                raise ConnectionError(f"could not connect to {addr}: {e}") from e
            conn = Connection(ws, outbound=True, dial_addr=addr)
            self._conns.add(conn)
            await self._send(conn, self._hello(conn, response_to=None))
            authenticated = asyncio.get_running_loop().create_future()
            self._spawn(self._reader(conn, authenticated))
            try:
                await asyncio.wait_for(asyncio.shield(authenticated), timeout=self.settings.handshake_timeout + 1)
            except asyncio.TimeoutError:
                self._note_failure(addr)
                raise ConnectionError(f"handshake with {addr} timed out")
            if not authenticated.result():
                self._note_failure(addr)
                raise ConnectionError(f"handshake with {addr} failed")
            self._backoff.pop(addr, None)
            self._m_conn.inc(direction="outbound", outcome="ok")
        finally:
            self._dialing.discard(addr)

    # Backwards-compatible name.
    _connect_peer = connect

    def _note_failure(self, addr: str) -> None:
        failures, _ = self._backoff.get(addr, (0, 0.0))
        failures += 1
        delay = min(300.0, 2.0**failures) * (0.8 + 0.4 * random.random())
        self._backoff[addr] = (failures, time.monotonic() + delay)

    async def _handle_inbound(self, ws: ServerConnection) -> None:
        conn = Connection(ws, outbound=False)
        self._conns.add(conn)
        self._m_conn.inc(direction="inbound", outcome="accepted")
        await self._reader(conn, None)

    def _hello(self, conn: Connection, response_to: Optional[str]) -> Dict[str, Any]:
        return P.build_hello(
            self.identity,
            role=self.role,
            addr=self.addr if self.role == P.ROLE_NODE else "",
            challenge=conn.challenge,
            response_to=response_to,
            extra={
                "region": self.region,
                "version": __version__,
                "services": {n: s.get_metadata() for n, s in self.local_services.items()},
                "api_port": self.api_port,
                "api_host": self.public_host,
                "metrics": self._local_metrics,
            },
        )

    async def _reader(self, conn: Connection, authenticated: Optional[asyncio.Future]) -> None:
        close_code, close_reason = 1000, ""
        try:
            deadline = time.monotonic() + self.settings.handshake_timeout
            while not conn.authenticated:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProtocolError("unauthorized", "handshake timeout")
                raw = await asyncio.wait_for(conn.ws.recv(), timeout=remaining)
                await self._process_raw(conn, raw)
            if authenticated is not None and not authenticated.done():
                authenticated.set_result(True)
            async for raw in conn.ws:
                await self._process_raw(conn, raw)
        except ConnectionClosed:
            pass
        except asyncio.TimeoutError:
            close_code, close_reason = CLOSE_PROTOCOL, "handshake timeout"
        except ProtocolError as e:
            logger.warning(f"Protocol error from {conn.peer_id or conn.remote}: {e}")
            close_code, close_reason = (CLOSE_FORBIDDEN if e.code == "unauthorized" else CLOSE_PROTOCOL), str(e)[:120]
        except _CloseConnection as e:
            close_code, close_reason = e.code, e.reason
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(f"Unexpected error on connection {conn.peer_id or conn.remote}")
            close_code, close_reason = 1011, "internal error"
        finally:
            if authenticated is not None and not authenticated.done():
                authenticated.set_result(False)
            try:
                await conn.ws.close(close_code, close_reason)
            except Exception:
                pass
            await self._on_disconnect(conn)

    async def _process_raw(self, conn: Connection, raw: Union[str, bytes]) -> None:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ProtocolError("bad_request", "invalid JSON")
        if not isinstance(data, dict) or not isinstance(data.get("type"), str):
            raise ProtocolError("bad_request", "message must be an object with a type")
        conn.last_seen = time.monotonic()
        msg_type = data["type"]
        if not conn.authenticated:
            if msg_type == P.HELLO:
                await self._on_hello(conn, data)
            elif msg_type == P.AUTH:
                await self._on_auth(conn, data)
            else:
                raise ProtocolError("unauthorized", f"'{msg_type}' before handshake completed")
            return
        handler = self._handlers.get(msg_type)
        if handler is None and msg_type in P.GEN_DONE_ALIASES:
            handler = P2PNode._on_gen_done
        if handler is None:
            logger.debug(f"Ignoring unknown message type {msg_type!r} from {conn.peer_id}")
            return
        await handler(self, conn, data)

    async def _on_hello(self, conn: Connection, data: Dict[str, Any]) -> None:
        if conn.peer_id is not None:
            raise ProtocolError("bad_request", "duplicate hello")
        P.verify_hello(data, expected_response=conn.challenge if conn.outbound else None)
        conn.peer_id = data["peer_id"]
        conn.pubkey = data["pubkey"]
        conn.role = data["role"]
        conn.addr = data["addr"] if conn.role == P.ROLE_NODE else ""
        conn.region = str(data.get("region") or "")[:64]
        conn.version = str(data.get("version") or "")[:32]
        conn.services = _sanitize_services(data.get("services")) if conn.role == P.ROLE_NODE else {}
        metrics = data.get("metrics")
        conn.metrics = metrics if isinstance(metrics, dict) else {}
        api_port = data.get("api_port")
        conn.api_port = api_port if isinstance(api_port, int) and 0 < api_port < 65536 else None
        conn.api_host = data.get("api_host") if isinstance(data.get("api_host"), str) else None
        if conn.peer_id == self.peer_id:
            raise _CloseConnection(CLOSE_FORBIDDEN, "self connection")
        if self.settings.allowed_peers and conn.peer_id not in self.settings.allowed_peers:
            raise _CloseConnection(CLOSE_FORBIDDEN, "peer not allowed")
        if conn.outbound:
            await self._send(conn, P.build_auth(self.identity, data["challenge"]))
            self._register(conn)
        else:
            conn.awaiting_auth = True
            conn._peer_challenge = data["challenge"]  # type: ignore[attr-defined]
            await self._send(conn, self._hello(conn, response_to=data["challenge"]))

    async def _on_auth(self, conn: Connection, data: Dict[str, Any]) -> None:
        if conn.outbound or not conn.awaiting_auth or not conn.pubkey or not conn.peer_id:
            raise ProtocolError("unauthorized", "unexpected auth")
        P.verify_auth(data, conn.pubkey, conn.peer_id, conn.challenge)
        self._register(conn)

    def _register(self, conn: Connection) -> None:
        pid = conn.peer_id
        assert pid is not None
        existing = self.peers.get(pid)
        if existing is not None and existing is not conn:
            # Simultaneous dials: keep the connection initiated by the smaller peer id.
            def initiator(c: Connection) -> str:
                return self.peer_id if c.outbound else pid  # type: ignore[return-value]

            if initiator(existing) <= initiator(conn):
                raise _CloseConnection(CLOSE_DUPLICATE, "duplicate connection")
            self._spawn(existing.ws.close(CLOSE_DUPLICATE, "replaced by duplicate connection"))
        elif len(self.peers) >= self.settings.max_peers:
            raise _CloseConnection(CLOSE_FULL, "peer limit reached")
        conn.authenticated = True
        conn.awaiting_auth = False
        self.peers[pid] = conn
        if conn.services:
            self.providers[pid] = conn.services
        logger.info(f"Peer authenticated: {pid} role={conn.role} addr={conn.addr or conn.remote}")
        self._spawn(self._send(conn, {"type": P.PING, "ts": P.now_ms(), "metrics": self._local_metrics}))
        if conn.role == P.ROLE_NODE:
            if conn.addr:
                self._remember_addr(conn.addr)
            peer_addrs = [c.addr for p, c in self.peers.items() if p != pid and c.role == P.ROLE_NODE and c.addr]
            self._spawn(self._send(conn, {"type": P.PEER_LIST, "peers": peer_addrs[:100]}))

    async def _on_disconnect(self, conn: Connection) -> None:
        self._conns.discard(conn)
        for task in list(conn.tasks.values()):
            task.cancel()
        pid = conn.peer_id
        if pid and self.peers.get(pid) is conn:
            self.peers.pop(pid, None)
            self.providers.pop(pid, None)
            logger.info(f"Peer disconnected: {pid}")
            for pending in self._pending.values():
                if pending.peer_id == pid:
                    pending.queue.put_nowait(("error", {"code": "provider_error", "error": "peer disconnected"}))

    async def _send(self, conn: Connection, obj: Dict[str, Any]) -> bool:
        try:
            await conn.ws.send(json.dumps(obj))
            return True
        except Exception as e:
            logger.debug(f"Send to {conn.peer_id or conn.remote} failed: {e}")
            return False

    async def _broadcast(self, obj: Dict[str, Any]) -> None:
        await asyncio.gather(*(self._send(c, obj) for c in list(self.peers.values())), return_exceptions=True)

    def _remember_addr(self, addr: str) -> None:
        if addr == self.addr or len(self.known_addrs) >= MAX_KNOWN_ADDRS:
            return
        try:
            validate_peer_addr(addr, require_tls=self.settings.require_tls, resolve=False)
        except AddressError:
            return
        self.known_addrs.add(addr)

    # ------------------------------------------------------------ maintenance

    async def _maintenance_loop(self) -> None:
        last_registry = 0.0
        while self._running:
            try:
                self._local_metrics = await asyncio.to_thread(get_system_metrics)
                now = time.monotonic()
                dead_after = 3 * self.settings.ping_interval
                for conn in list(self.peers.values()):
                    if now - conn.last_seen > dead_after:
                        logger.warning(f"Evicting unresponsive peer {conn.peer_id}")
                        self._spawn(conn.ws.close(1001, "ping timeout"))
                    else:
                        self._spawn(self._send(conn, {"type": P.PING, "ts": P.now_ms(), "metrics": self._local_metrics}))
                self._ensure_connectivity()
                if self.registry.enabled and now - last_registry >= self.settings.registry_interval:
                    last_registry = now
                    await self.sync_with_registry()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Maintenance loop error")
            await asyncio.sleep(self.settings.ping_interval)

    def _ensure_connectivity(self) -> None:
        node_peers = sum(1 for c in self.peers.values() if c.role == P.ROLE_NODE)
        budget = self.settings.target_peers - node_peers - len(self._dialing)
        if node_peers == 0 and not self._dialing:
            budget = max(budget, 1)
        if budget <= 0:
            return
        connected = {c.addr for c in self.peers.values()} | {c.dial_addr for c in self.peers.values()}
        now = time.monotonic()
        candidates = [a for a in self.bootstrap if a not in connected] + [
            a for a in self.known_addrs if a not in connected and a not in self.bootstrap
        ]
        for addr in candidates:
            if budget <= 0:
                break
            if addr in self._dialing or addr == self.addr:
                continue
            _, next_attempt = self._backoff.get(addr, (0, 0.0))
            if next_attempt > now:
                continue
            budget -= 1
            self._spawn(self._dial_quietly(addr))

    async def _dial_quietly(self, addr: str) -> None:
        try:
            await self.connect(addr)
        except Exception as e:
            logger.debug(f"Dial {addr} failed: {e}")

    async def sync_with_registry(self) -> bool:
        if not self.addr or self.role != P.ROLE_NODE:
            return False
        models = sorted({m for s in self.local_services.values() for m in s.models()})
        return await self.registry.sync_node(
            addr=self.addr,
            models=models,
            region=self.region,
            metrics={**self._local_metrics, **self._service_metrics()},
            api_port=self.api_port,
        )

    def _service_metrics(self) -> Dict[str, Any]:
        tps: List[float] = [float(t) for s in self.local_services.values() if (t := s.get_metadata().get("tokens_per_sec"))]
        return {"tokens_per_sec": round(sum(tps), 2)} if tps else {}

    # ------------------------------------------------------------- handlers

    async def _on_peer_list(self, conn: Connection, data: Dict[str, Any]) -> None:
        peers = data.get("peers")
        if not isinstance(peers, list):
            return
        for addr in peers[:100]:
            if isinstance(addr, str):
                self._remember_addr(addr)
        self._ensure_connectivity()

    async def _on_ping(self, conn: Connection, data: Dict[str, Any]) -> None:
        if isinstance(data.get("metrics"), dict):
            conn.metrics = data["metrics"]
        await self._send(conn, {"type": P.PONG, "ts": data.get("ts")})

    async def _on_pong(self, conn: Connection, data: Dict[str, Any]) -> None:
        ts = data.get("ts")
        if isinstance(ts, (int, float)):
            rtt = P.now_ms() - float(ts)
            if 0 <= rtt < 600_000:
                conn.last_pong_ms = rtt

    async def _on_service_announce(self, conn: Connection, data: Dict[str, Any]) -> None:
        if conn.role != P.ROLE_NODE:
            return
        svc = _sanitize_services({data.get("service"): data.get("meta")})
        if svc:
            conn.services.update(svc)
            self.providers[conn.peer_id] = conn.services  # type: ignore[index]

    async def _on_gen_request(self, conn: Connection, data: Dict[str, Any]) -> None:
        rid = data.get("rid") or data.get("task_id")
        if not isinstance(rid, str) or not rid or len(rid) > 100:
            return
        trusted = conn.peer_id in self.settings.trusted_peers
        allowed = trusted or self._peer_limiter.allow(conn.peer_id or conn.remote)[0]
        if not allowed:
            await self._send(conn, {"type": P.GEN_ERROR, "rid": rid, "code": "rate_limited", "error": "rate limited"})
            return
        if rid in conn.tasks:
            await self._send(conn, {"type": P.GEN_ERROR, "rid": rid, "code": "bad_request", "error": "duplicate rid"})
            return
        try:
            req = P.parse_generation_request(
                data,
                max_prompt_chars=self.settings.max_prompt_chars,
                max_new_tokens=self.settings.max_new_tokens,
                max_hops=self.settings.max_hops,
            )
        except ProtocolError as e:
            await self._send(conn, {"type": P.GEN_ERROR, "rid": rid, "code": e.code, "error": str(e)})
            return
        task = asyncio.create_task(self._serve_generation(conn, rid, req))
        conn.tasks[rid] = task
        task.add_done_callback(lambda _t: conn.tasks.pop(rid, None))

    async def _serve_generation(self, conn: Connection, rid: str, req: GenerationRequest) -> None:
        t0 = time.monotonic()
        parts: List[str] = []
        try:
            final: Dict[str, Any] = {}
            exclude = {conn.peer_id} if conn.peer_id else set()
            async with aclosing(self.stream_generation(req, exclude=exclude)) as stream:
                async for item in stream:
                    if isinstance(item, dict):
                        final = item
                    elif req.stream:
                        if not await self._send(conn, {"type": P.GEN_CHUNK, "rid": rid, "text": item}):
                            raise GenerationError("cancelled", "requester went away")
                    else:
                        parts.append(item)
            done = {"type": P.GEN_DONE, "rid": rid, **final}
            if not req.stream:
                done["text"] = "".join(parts)
            await self._send(conn, done)
            self._m_gen.inc(source="peer", outcome="ok")
            self._m_gen_latency.observe(time.monotonic() - t0)
        except asyncio.CancelledError:
            self._m_gen.inc(source="peer", outcome="cancelled")
            raise
        except GenerationError as e:
            self._m_gen.inc(source="peer", outcome=e.code)
            await self._send(conn, {"type": P.GEN_ERROR, "rid": rid, "code": e.code, "error": str(e)})
        except Exception as e:
            logger.exception(f"Generation {rid} failed")
            self._m_gen.inc(source="peer", outcome="provider_error")
            await self._send(conn, {"type": P.GEN_ERROR, "rid": rid, "code": "provider_error", "error": str(e)[:300]})

    async def _on_gen_cancel(self, conn: Connection, data: Dict[str, Any]) -> None:
        task = conn.tasks.get(data.get("rid"))  # type: ignore[arg-type]
        if task:
            task.cancel()

    def _pending_for(self, conn: Connection, data: Dict[str, Any]) -> Optional[_Pending]:
        rid = data.get("rid") or data.get("task_id")
        pending = self._pending.get(rid) if isinstance(rid, str) else None
        # Only the peer we asked may answer a request.
        if pending is None or pending.peer_id != conn.peer_id:
            return None
        return pending

    async def _on_gen_chunk(self, conn: Connection, data: Dict[str, Any]) -> None:
        pending = self._pending_for(conn, data)
        if pending and isinstance(data.get("text"), str):
            pending.queue.put_nowait(("chunk", data["text"]))

    async def _on_gen_done(self, conn: Connection, data: Dict[str, Any]) -> None:
        pending = self._pending_for(conn, data)
        if pending is None:
            return
        if data.get("error"):  # legacy gen_result carrying an error
            pending.queue.put_nowait(("error", {"code": "provider_error", "error": str(data["error"])}))
        else:
            pending.queue.put_nowait(("done", data))

    async def _on_gen_error(self, conn: Connection, data: Dict[str, Any]) -> None:
        pending = self._pending_for(conn, data)
        if pending:
            pending.queue.put_nowait(("error", data))

    _handlers = {
        P.PEER_LIST: _on_peer_list,
        P.PING: _on_ping,
        P.PONG: _on_pong,
        P.SERVICE_ANNOUNCE: _on_service_announce,
        P.GEN_REQUEST: _on_gen_request,
        P.GEN_CANCEL: _on_gen_cancel,
        P.GEN_CHUNK: _on_gen_chunk,
        P.GEN_DONE: _on_gen_done,
        P.GEN_ERROR: _on_gen_error,
    }

    # ------------------------------------------------------------- services

    async def add_service(self, service: BaseService) -> None:
        self.local_services[service.name] = service
        logger.success(f"Serving {service.backend} models: {', '.join(service.models())}")
        await self._broadcast({"type": P.SERVICE_ANNOUNCE, "service": service.name, "meta": service.get_metadata()})

    def local_service_for(self, model: Optional[str]) -> Optional[BaseService]:
        for svc in self.local_services.values():
            if svc.serves(model):
                return svc
        return None

    def list_providers(self) -> List[Dict[str, Any]]:
        out = []
        for pid, svcs in self.providers.items():
            conn = self.peers.get(pid)
            if conn is None:
                continue
            models = sorted({m for meta in svcs.values() for m in meta.get("models", [])})
            prices = [meta.get("price_per_token", 0.0) for meta in svcs.values()]
            tag = next((meta["tag"] for meta in svcs.values() if meta.get("tag")), None)
            out.append(
                {
                    "peer_id": pid,
                    "addr": conn.addr,
                    "latency_ms": conn.last_pong_ms,
                    "models": models,
                    "price_per_token": min(prices) if prices else 0.0,
                    "tag": tag,
                    **self._stats(pid).to_dict(),
                }
            )
        return out

    def pick_providers(self, model: Optional[str], exclude: Iterable[str] = ()) -> List[str]:
        excluded = set(exclude)
        ranked = []
        for pid, svcs in self.providers.items():
            conn = self.peers.get(pid)
            if pid in excluded or conn is None:
                continue
            for meta in svcs.values():
                if any(P.models_match(model, m) for m in meta.get("models", [])):
                    latency = conn.last_pong_ms if conn.last_pong_ms is not None else 1e9
                    ranked.append((meta.get("price_per_token", 0.0), -round(self._stats(pid).score, 1), latency, pid))
                    break
        ranked.sort()
        return [r[-1] for r in ranked]

    def pick_provider(self, model_name: str):
        """Backwards-compatible single best provider lookup."""
        pids = self.pick_providers(model_name)
        return (pids[0], self.providers[pids[0]]) if pids else None

    # ----------------------------------------------------------- generation

    async def stream_generation(
        self,
        req: GenerationRequest,
        provider_id: Optional[str] = None,
        exclude: Iterable[str] = (),
    ) -> AsyncGenerator[StreamItem, None]:
        """Yield text chunks, then one final dict with usage/provider info."""
        local = provider_id in (None, "local", self.peer_id)
        svc = self.local_service_for(req.model) if local else None
        if svc is not None:
            async with aclosing(self._local_stream(svc, req)) as local_stream:
                async for item in local_stream:
                    yield item
            return
        if provider_id in ("local", self.peer_id):
            raise GenerationError("no_provider", f"this node does not serve model '{req.model}'")
        if provider_id:
            candidates = [provider_id] if provider_id in self.peers else []
        else:
            if req.hops >= self.settings.max_hops:
                raise GenerationError("no_provider", "hop limit reached")
            candidates = self.pick_providers(req.model, exclude=exclude)
        if not candidates:
            raise GenerationError("no_provider", f"no provider available for model '{req.model or 'any'}'")
        async with aclosing(self._remote_stream(replace(req, hops=req.hops + 1), candidates)) as remote:
            async for item in remote:
                yield item

    async def _local_stream(self, svc: BaseService, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        if self._active_local >= self.settings.max_concurrent_generations:
            raise GenerationError("busy", "node is at capacity")
        self._active_local += 1
        try:
            async with aclosing(svc.stream(req)) as svc_stream:
                async for item in svc_stream:
                    if isinstance(item, Usage):
                        self._m_tokens.inc(item.completion_tokens)
                        yield {
                            "usage": item.to_dict(),
                            "provider": self.peer_id,
                            "backend": svc.backend,
                            "cost": round(svc.price_per_token * item.completion_tokens, 8),
                        }
                    else:
                        yield item
        except ServiceError as e:
            raise GenerationError("provider_error", str(e)) from e
        finally:
            self._active_local -= 1

    async def _remote_stream(self, req: GenerationRequest, candidates: List[str]) -> AsyncGenerator[StreamItem, None]:
        last_error: Optional[GenerationError] = None
        for pid in candidates[:MAX_FAILOVER_ATTEMPTS]:
            conn = self.peers.get(pid)
            if conn is None:
                continue
            rid = new_id("req")
            pending = _Pending(pid)
            self._pending[rid] = pending
            emitted = False
            finished = False
            try:
                wire = {"type": P.GEN_REQUEST, "rid": rid, **req.to_wire(), "stream": True}
                if not await self._send(conn, wire):
                    raise GenerationError("provider_error", "send failed")
                while True:
                    try:
                        kind, payload = await asyncio.wait_for(pending.queue.get(), timeout=self.settings.request_timeout)
                    except asyncio.TimeoutError:
                        raise GenerationError("timeout", f"provider {pid} timed out")
                    if kind == "chunk":
                        emitted = True
                        yield payload
                    elif kind == "done":
                        finished = True
                        self._stats(pid).success((time.monotonic() - pending.started) * 1000)
                        if not emitted and isinstance(payload.get("text"), str) and payload["text"]:
                            yield payload["text"]
                        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
                        yield {
                            "usage": usage,
                            "provider": payload.get("provider") or pid,
                            "backend": payload.get("backend"),
                            "cost": payload.get("cost"),
                            "via": pid,
                        }
                        return
                    else:
                        finished = True
                        code = payload.get("code") if payload.get("code") in P.ERROR_CODES else "provider_error"
                        raise GenerationError(code, str(payload.get("error") or code)[:300])
            except GenerationError as e:
                # Capacity signals (busy, rate_limited) are not failures of the node.
                if e.code not in ("bad_request", "cancelled", "busy", "rate_limited"):
                    self._stats(pid).failure()
                last_error = e
                if emitted or e.code == "bad_request":
                    raise
                logger.warning(f"Provider {pid} failed ({e.code}); trying next candidate")
            finally:
                self._pending.pop(rid, None)
                if not finished and pid in self.peers:
                    await self._send(self.peers[pid], {"type": P.GEN_CANCEL, "rid": rid})
        raise last_error or GenerationError("no_provider", "no provider available")

    async def generate(self, req: GenerationRequest, provider_id: Optional[str] = None) -> Dict[str, Any]:
        parts: List[str] = []
        final: Dict[str, Any] = {}
        async with aclosing(self.stream_generation(req, provider_id=provider_id)) as stream:
            async for item in stream:
                if isinstance(item, dict):
                    final = item
                else:
                    parts.append(item)
        return {"text": "".join(parts), **final}

    async def request_generation(
        self, provider_id: str, prompt: str, max_new_tokens: int = 256, model_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Backwards-compatible wrapper around :meth:`generate`."""
        req = GenerationRequest(prompt=prompt, model=model_name, max_new_tokens=max_new_tokens)
        return await self.generate(req, provider_id=provider_id)


class _CloseConnection(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


async def run_p2p_node(
    host: Optional[str] = None,
    port: Optional[int] = None,
    bootstrap_link: Optional[str] = None,
    model_name: Optional[str] = None,
    price_per_token: float = 0.0,
    announce_host: Optional[str] = None,
    backend: str = "hf",
    api_port: Optional[int] = None,
    entrypoint_url: Optional[str] = None,
    region: Optional[str] = None,
    settings: Optional[Settings] = None,
) -> None:
    """Run a node (optionally serving a model and the HTTP API) until SIGINT/SIGTERM."""
    from rich.console import Console

    from .services import create_service

    console = Console()
    node = P2PNode(
        host=host,
        port=port,
        announce_host=announce_host,
        entrypoint_url=entrypoint_url,
        region=region,
        settings=settings,
    )
    node.api_port = api_port
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, RuntimeError):  # Windows
            pass

    api_server = None
    try:
        if model_name:
            svc = create_service(backend, model_name, price_per_token=price_per_token, settings=node.settings)
            console.print(f"[yellow]Loading {backend} model '{model_name}'...[/yellow]")
            try:
                await svc.load()
            except ServiceError as e:
                console.print(f"[red]Failed to load model: {e}[/red]")
                raise SystemExit(1)
            node.local_services[svc.name] = svc

        await node.start()
        for addr in node.settings.bootstrap:
            node._spawn(node._dial_quietly(addr))
        if bootstrap_link and bootstrap_link not in node.settings.bootstrap:
            node._spawn(node.connect_bootstrap(bootstrap_link))

        if api_port:
            from .api import create_app, serve_api

            api_server = await serve_api(create_app(node=node), node.settings, api_port)

        console.print(f"\n[bold green]Node {node.peer_id} running[/bold green]")
        console.print(f"[cyan]P2P address:[/cyan] {node.addr}")
        if api_port:
            scheme = "https" if node.settings.tls_enabled else "http"
            console.print(f"[cyan]HTTP API:[/cyan] {scheme}://{node.settings.api_host}:{api_port}")
        if model_name:
            from urllib.parse import quote

            from .p2p import generate_join_link, sha256_hex_bytes

            link = generate_join_link("bee2bee", model_name, sha256_hex_bytes(model_name.encode()), [node.addr])
            console.print(f"[cyan]Join link:[/cyan] {link}")
            reg = f"https://coithub.org/register?link={quote(link, safe='')}&region={quote(node.region, safe='')}&tag={quote(backend, safe='')}"
            if api_port:
                reg += f"&api_port={api_port}"
            console.print(f"[cyan]Register on the dashboard:[/cyan] {reg}")
        console.print("[dim]Press Ctrl+C to stop.[/dim]")
        await stop_event.wait()
    finally:
        if api_server is not None:
            api_server.should_exit = True
            await asyncio.sleep(0.2)
        await node.stop()
