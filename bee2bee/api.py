"""HTTP API for a Bee2Bee node (FastAPI).

Security defaults: every endpoint except ``/``, ``/healthz`` and ``/readyz``
requires an API key (``X-API-KEY`` or ``Authorization: Bearer``). If
``BEE2BEE_API_KEY`` is not set, a random key is generated on first start and
stored in ``~/.bee2bee/api_key`` (mode 0600).
"""

from __future__ import annotations

import contextlib
import hmac
import json
import time
import uuid
from contextlib import aclosing, asynccontextmanager
from typing import Any, AsyncIterator, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field

from ._version import __version__
from .p2p_runtime import GenerationError, P2PNode
from .protocol import GenerationRequest, ProtocolError, parse_generation_request
from .ratelimit import RateLimiter
from .settings import Settings, get_settings
from .utils import bee2bee_home, new_secret, write_secret_file

API_KEY_FILE = "api_key"
PUBLIC_PATHS = {"/", "/healthz", "/readyz", "/docs", "/openapi.json", "/redoc"}

HTTP_STATUS_FOR_CODE = {
    "bad_request": 400,
    "unauthorized": 401,
    "rate_limited": 429,
    "no_provider": 503,
    "busy": 503,
    "timeout": 504,
    "provider_error": 502,
    "cancelled": 502,
}


def load_or_create_api_key(settings: Settings) -> Optional[str]:
    if settings.api_auth == "off":
        return None
    if settings.api_key:
        return settings.api_key
    path = bee2bee_home() / API_KEY_FILE
    if path.exists():
        key = path.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = new_secret()
    write_secret_file(path, key)
    logger.warning(f"Generated a new API key and saved it to {path}")
    return key


class ChatRequest(BaseModel):
    prompt: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = Field(default=None, max_length=200)
    provider_id: Optional[str] = Field(default=None, max_length=100)
    max_new_tokens: Optional[int] = Field(default=None, ge=1)
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    stream: bool = False


class ConnectRequest(BaseModel):
    addr: str = Field(max_length=512)


class OpenAIMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class OpenAIChatRequest(BaseModel):
    model: Optional[str] = Field(default=None, max_length=200)
    messages: List[OpenAIMessage] = Field(min_length=1, max_length=256)
    max_tokens: Optional[int] = Field(default=None, ge=1)
    max_completion_tokens: Optional[int] = Field(default=None, ge=1)
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    stream: bool = False


class _QuietServer:
    """uvicorn.Server that leaves signal handling to the node runner."""

    @staticmethod
    def build(config):
        import uvicorn

        class Server(uvicorn.Server):
            def install_signal_handlers(self) -> None:  # uvicorn < 0.29
                pass

            def capture_signals(self):  # uvicorn >= 0.29
                return contextlib.nullcontext()

        return Server(config)


async def serve_api(app: FastAPI, settings: Settings, port: int):
    """Start uvicorn in the current event loop and return the server handle."""
    import asyncio

    import uvicorn

    config = uvicorn.Config(
        app,
        host=settings.api_host,
        port=port,
        log_level="warning",
        access_log=False,
        ssl_certfile=settings.tls_cert,
        ssl_keyfile=settings.tls_key,
        proxy_headers=settings.trust_proxy,
        forwarded_allow_ips="*" if settings.trust_proxy else None,
    )
    server = _QuietServer.build(config)
    asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    return server


def create_app(node: Optional[P2PNode] = None, settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or (node.settings if node else get_settings())
    state: Dict[str, Any] = {"node": node, "owns_node": node is None}
    api_metrics: Dict[str, Any] = {}

    def _register_api_metrics(n: P2PNode) -> None:
        if "requests" not in api_metrics:
            api_metrics["requests"] = n.metrics.counter("bee2bee_api_requests_total", "HTTP API requests")
            api_metrics["latency"] = n.metrics.histogram("bee2bee_api_request_seconds", "HTTP API latency")

    if node is not None:
        _register_api_metrics(node)
    api_key = load_or_create_api_key(settings)
    limiter = RateLimiter(settings.rate_limit_per_minute)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if state["node"] is None:
            n = P2PNode(settings=settings)
            await n.start()
            for addr in settings.bootstrap:
                n._spawn(n._dial_quietly(addr))
            state["node"] = n
        _register_api_metrics(state["node"])
        if api_key is None:
            logger.warning("API authentication is DISABLED (BEE2BEE_API_AUTH=off). Do not expose this node publicly.")
        yield
        if state["owns_node"] and state["node"] is not None:
            await state["node"].stop()

    app = FastAPI(title="Bee2Bee Node API", version=__version__, lifespan=lifespan)
    app.state.bee2bee = state

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type", "X-API-KEY", "X-Request-ID"],
        )

    def client_ip(request: Request) -> str:
        if settings.trust_proxy:
            fwd = request.headers.get("x-forwarded-for")
            if fwd:
                return fwd.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def guard(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id[:64]
        t0 = time.monotonic()
        path = request.url.path
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_message_bytes:
            return JSONResponse({"detail": "request body too large"}, status_code=413)
        if path not in PUBLIC_PATHS:
            allowed, retry = limiter.allow(client_ip(request))
            if not allowed:
                return JSONResponse(
                    {"detail": "rate limit exceeded"},
                    status_code=429,
                    headers={"Retry-After": str(int(retry) + 1)},
                )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        route = request.scope.get("route")
        route_path = getattr(route, "path", "unmatched")
        if "requests" in api_metrics:
            api_metrics["requests"].inc(method=request.method, route=route_path, status=str(response.status_code))
            api_metrics["latency"].observe(time.monotonic() - t0, route=route_path)
        logger.bind(request_id=request.state.request_id).debug(
            f"{request.method} {path} -> {response.status_code} ({(time.monotonic() - t0) * 1000:.0f}ms)"
        )
        return response

    async def require_key(request: Request) -> None:
        if api_key is None:
            return
        supplied = request.headers.get("x-api-key")
        if not supplied:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                supplied = auth[7:].strip()
        if not supplied or not hmac.compare_digest(supplied.encode(), api_key.encode()):
            raise HTTPException(status_code=401, detail="invalid or missing API key")

    def get_node() -> P2PNode:
        n = state["node"]
        if n is None:
            raise HTTPException(status_code=503, detail="node is starting")
        return n

    def build_request(body: Dict[str, Any], n: P2PNode) -> GenerationRequest:
        try:
            return parse_generation_request(
                body,
                max_prompt_chars=settings.max_prompt_chars,
                max_new_tokens=settings.max_new_tokens,
                max_hops=0,
            )
        except ProtocolError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def open_stream(n: P2PNode, req: GenerationRequest, provider_id: Optional[str]):
        """Start a generation and wait for its first item so errors map to HTTP codes."""
        stream = n.stream_generation(req, provider_id=provider_id)
        try:
            first = await stream.__anext__()
        except StopAsyncIteration:
            first = None
        except GenerationError as e:
            await stream.aclose()
            raise HTTPException(status_code=HTTP_STATUS_FOR_CODE.get(e.code, 502), detail={"code": e.code, "message": str(e)})
        return first, stream

    async def _chain(first, stream) -> AsyncIterator[Any]:
        async with aclosing(stream):
            if first is not None:
                yield first
            async for item in stream:
                yield item

    # ------------------------------------------------------------ endpoints

    @app.get("/")
    def home():
        n = state["node"]
        if n is None:
            return {"status": "starting", "version": __version__}
        models = sorted({m for s in n.local_services.values() for m in s.models()})
        return {
            "status": "ok",
            "name": "bee2bee-node",
            "version": __version__,
            "peer_id": n.peer_id,
            "node_id": n.peer_id,
            "region": n.region,
            "addr": n.addr,
            "models": models,
            "services": {name: s.get_metadata() for name, s in n.local_services.items()},
            "metrics": {"uptime": int(time.time() - n.start_time), "pool_size": len(n.peers)},
        }

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        n = state["node"]
        if n is None or not n.ready:
            return JSONResponse({"status": "not_ready"}, status_code=503)
        return {"status": "ready", "peers": len(n.peers), "services": len(n.local_services)}

    metrics_deps = [] if settings.metrics_public else [Depends(require_key)]

    @app.get("/metrics", dependencies=metrics_deps, response_class=PlainTextResponse)
    def metrics():
        return PlainTextResponse(get_node().metrics.render(), media_type="text/plain; version=0.0.4")

    @app.get("/peers", dependencies=[Depends(require_key)])
    def peers():
        return [c.info() for c in get_node().peers.values()]

    @app.get("/providers", dependencies=[Depends(require_key)])
    def providers():
        return get_node().list_providers()

    @app.post("/connect", dependencies=[Depends(require_key)])
    async def connect_peer(body: ConnectRequest):
        n = get_node()
        try:
            if "://join" in body.addr:
                ok = await n.connect_bootstrap(body.addr)
                if not ok:
                    raise ConnectionError("could not reach any bootstrap address in the link")
            else:
                await n.connect(body.addr)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except ConnectionError as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"status": "connected", "addr": body.addr}

    @app.post("/chat", dependencies=[Depends(require_key)])
    @app.post("/generate", dependencies=[Depends(require_key)])
    async def chat(body: ChatRequest):
        n = get_node()
        req = build_request(body.model_dump(exclude_none=True), n)
        provider = body.provider_id if body.provider_id not in (None, "", "auto") else None
        first, stream = await open_stream(n, req, provider)

        if body.stream:

            async def ndjson():
                try:
                    async for item in _chain(first, stream):
                        if isinstance(item, dict):
                            yield json.dumps({"done": True, **item}) + "\n"
                        else:
                            yield json.dumps({"text": item}) + "\n"
                except GenerationError as e:
                    yield json.dumps({"error": str(e), "code": e.code}) + "\n"

            return StreamingResponse(ndjson(), media_type="application/x-ndjson")

        parts: List[str] = []
        final: Dict[str, Any] = {}
        try:
            async for item in _chain(first, stream):
                if isinstance(item, dict):
                    final = item
                else:
                    parts.append(item)
        except GenerationError as e:
            raise HTTPException(status_code=HTTP_STATUS_FOR_CODE.get(e.code, 502), detail={"code": e.code, "message": str(e)})
        return {
            "status": "ok",
            "text": "".join(parts),
            "rid": f"gen-{uuid.uuid4().hex[:12]}",
            "metadata": final,
            "usage": final.get("usage", {}),
        }

    # ---------------------------------------------------- OpenAI compatible

    @app.get("/v1/models", dependencies=[Depends(require_key)])
    def list_models():
        n = get_node()
        names = {m for s in n.local_services.values() for m in s.models()}
        for p in n.list_providers():
            names.update(p["models"])
        return {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "bee2bee"} for m in sorted(names)]}

    @app.post("/v1/chat/completions", dependencies=[Depends(require_key)])
    async def chat_completions(body: OpenAIChatRequest):
        n = get_node()
        req = build_request(
            {
                "messages": [m.model_dump() for m in body.messages],
                "model": body.model,
                "max_new_tokens": body.max_completion_tokens or body.max_tokens,
                "temperature": body.temperature,
            },
            n,
        )
        try:
            first, stream = await open_stream(n, req, None)
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, dict) else {"code": "error", "message": str(e.detail)}
            return JSONResponse(
                {"error": {"message": detail.get("message"), "type": "bee2bee_error", "code": detail.get("code")}},
                status_code=e.status_code,
            )
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        model = body.model or "bee2bee"

        if body.stream:

            def chunk(delta: Dict[str, Any], finish: Optional[str] = None, usage: Optional[Dict[str, Any]] = None) -> str:
                payload: Dict[str, Any] = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                if usage is not None:
                    payload["usage"] = usage
                return f"data: {json.dumps(payload)}\n\n"

            async def sse():
                yield chunk({"role": "assistant"})
                try:
                    async for item in _chain(first, stream):
                        if isinstance(item, dict):
                            yield chunk({}, "stop", _openai_usage(item))
                        else:
                            yield chunk({"content": item})
                except GenerationError as e:
                    err = {"error": {"message": str(e), "type": "bee2bee_error", "code": e.code}}
                    yield f"data: {json.dumps(err)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(sse(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

        parts: List[str] = []
        final: Dict[str, Any] = {}
        try:
            async for item in _chain(first, stream):
                if isinstance(item, dict):
                    final = item
                else:
                    parts.append(item)
        except GenerationError as e:
            return JSONResponse(
                {"error": {"message": str(e), "type": "bee2bee_error", "code": e.code}},
                status_code=HTTP_STATUS_FOR_CODE.get(e.code, 502),
            )
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)}, "finish_reason": "stop"}],
            "usage": _openai_usage(final),
        }

    return app


def _openai_usage(final: Dict[str, Any]) -> Dict[str, int]:
    usage = final.get("usage") or {}
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def __getattr__(name: str):
    # `from bee2bee.api import app` keeps working (e.g. `uvicorn bee2bee.api:app`).
    if name == "app":
        return create_app()
    raise AttributeError(name)
