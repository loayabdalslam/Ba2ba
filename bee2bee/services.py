"""Inference backends.

Every service implements one async streaming primitive, ``stream()``, which
yields text deltas (``str``) followed by exactly one final ``Usage`` object.
``generate()`` is derived from it, so buffered and streamed responses always
agree. Blocking work (model loading, torch generation) runs in threads so it
never stalls the event loop that also serves pings and other peers.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

import httpx
from loguru import logger

from .protocol import GenerationRequest, Usage, models_match


class ServiceError(Exception):
    pass


StreamItem = Union[str, Usage]


class BaseService:
    backend = "base"

    def __init__(self, name: str, model_name: str, price_per_token: float = 0.0):
        self.name = name
        self.model_name = model_name
        self.price_per_token = price_per_token
        self._tps_ewma: Optional[float] = None

    async def load(self) -> None:
        """Prepare the backend (download weights, check connectivity...)."""

    async def close(self) -> None:
        """Release resources."""

    def models(self) -> List[str]:
        return [self.model_name]

    def serves(self, model: Optional[str]) -> bool:
        return any(models_match(model, m) for m in self.models())

    def get_metadata(self) -> Dict[str, Any]:
        meta: Dict[str, Any] = {
            "models": self.models(),
            "price_per_token": self.price_per_token,
            "backend": self.backend,
        }
        if self._tps_ewma is not None:
            meta["tokens_per_sec"] = round(self._tps_ewma, 2)
        return meta

    def stream(self, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        raise NotImplementedError

    def record_usage(self, usage: Usage) -> None:
        tps = usage.tokens_per_sec
        if tps > 0:
            self._tps_ewma = tps if self._tps_ewma is None else 0.8 * self._tps_ewma + 0.2 * tps

    async def generate(self, req: GenerationRequest) -> Dict[str, Any]:
        parts: List[str] = []
        usage = Usage()
        async for item in self.stream(req):
            if isinstance(item, Usage):
                usage = item
            else:
                parts.append(item)
        return {
            "text": "".join(parts),
            "usage": usage.to_dict(),
            "backend": self.backend,
            "cost": round(self.price_per_token * usage.completion_tokens, 8),
        }


class EchoService(BaseService):
    """Deterministic backend for tests, demos and load testing (no model)."""

    backend = "echo"

    def __init__(self, model_name: str = "echo", delay: float = 0.0):
        super().__init__("echo", model_name)
        self.delay = delay

    async def stream(self, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        t0 = time.monotonic()
        prompt = req.prompt_text()
        words = prompt.split()[: req.max_new_tokens]
        for i, word in enumerate(words):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield word if i == 0 else " " + word
        usage = Usage(len(prompt.split()), len(words), int((time.monotonic() - t0) * 1000))
        self.record_usage(usage)
        yield usage


class OllamaService(BaseService):
    backend = "ollama"

    def __init__(self, model_name: str, host: str = "http://localhost:11434", price_per_token: float = 0.0):
        super().__init__("ollama", model_name, price_per_token)
        self.host = host.rstrip("/")
        self.actual_model = model_name
        self._client = httpx.AsyncClient(base_url=self.host, timeout=httpx.Timeout(10.0, read=300.0))

    async def load(self) -> None:
        try:
            res = await self._client.get("/api/tags", timeout=5.0)
            res.raise_for_status()
        except httpx.HTTPError as e:
            raise ServiceError(f"Ollama not reachable at {self.host}: {e}") from e
        available = [m.get("name", "") for m in res.json().get("models", [])]
        match = next((m for m in available if models_match(self.model_name, m)), None)
        if match is None:
            raise ServiceError(
                f"Model '{self.model_name}' is not pulled in Ollama. "
                f"Run 'ollama pull {self.model_name}'. Available: {', '.join(available) or 'none'}"
            )
        self.actual_model = match
        logger.info(f"Ollama model ready: {self.actual_model}")

    async def close(self) -> None:
        await self._client.aclose()

    def models(self) -> List[str]:
        return sorted({self.model_name, self.actual_model})

    async def stream(self, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        t0 = time.monotonic()
        options = {"num_predict": req.max_new_tokens, "temperature": req.temperature}
        if req.messages is not None:
            path, payload = (
                "/api/chat",
                {"model": self.actual_model, "messages": req.messages, "stream": True, "options": options},
            )
        else:
            path, payload = (
                "/api/generate",
                {"model": self.actual_model, "prompt": req.prompt, "stream": True, "options": options},
            )
        prompt_tokens = completion_tokens = 0
        try:
            async with self._client.stream("POST", path, json=payload) as res:
                if res.status_code != 200:
                    body = (await res.aread()).decode("utf-8", "replace")[:500]
                    raise ServiceError(f"Ollama returned {res.status_code}: {body}")
                async for line in res.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if data.get("error"):
                        raise ServiceError(f"Ollama error: {data['error']}")
                    text = data.get("response") if req.messages is None else (data.get("message") or {}).get("content")
                    if text:
                        yield text
                    if data.get("done"):
                        prompt_tokens = int(data.get("prompt_eval_count") or 0)
                        completion_tokens = int(data.get("eval_count") or 0)
                        break
        except httpx.HTTPError as e:
            raise ServiceError(f"Ollama request failed: {e}") from e
        usage = Usage(prompt_tokens, completion_tokens, int((time.monotonic() - t0) * 1000))
        self.record_usage(usage)
        yield usage


class HFService(BaseService):
    """Local Hugging Face transformers model (CPU/GPU)."""

    backend = "hf"

    def __init__(self, model_name: str, price_per_token: float = 0.0):
        super().__init__("hf", model_name, price_per_token)
        self.model: Any = None
        self.tokenizer: Any = None
        self.device: Optional[str] = None
        # One generation at a time per loaded model; torch is not re-entrant here.
        self._gen_lock = asyncio.Lock()

    async def load(self) -> None:
        from .hf import has_transformers, load_model_and_tokenizer

        if not has_transformers():
            raise ServiceError("transformers is not installed. Run: pip install 'bee2bee[hf,torch]'")
        try:
            self.model, self.tokenizer, self.device = await asyncio.to_thread(load_model_and_tokenizer, self.model_name)
        except Exception as e:
            raise ServiceError(f"Failed to load model '{self.model_name}': {e}") from e

    def _count(self, text: str) -> int:
        try:
            assert self.tokenizer is not None
            return len(self.tokenizer.encode(text, add_special_tokens=False))
        except Exception:
            return max(1, len(text) // 4)

    async def stream(self, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        if self.model is None:
            raise ServiceError("Model not loaded")
        from .hf import start_generation_thread

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        stop = threading.Event()
        sentinel = object()

        def on_text(text: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, text)

        async with self._gen_lock:
            t0 = time.monotonic()
            prompt_tokens, worker = start_generation_thread(
                self.model, self.tokenizer, self.device or "cpu", req, stop, on_text, sentinel
            )
            parts: List[str] = []
            try:
                while True:
                    item = await queue.get()
                    if item is sentinel:
                        break
                    if isinstance(item, BaseException):
                        raise ServiceError(f"Generation failed: {item}")
                    parts.append(item)
                    yield item
            finally:
                stop.set()
                await asyncio.to_thread(worker.join, 30)
        usage = Usage(prompt_tokens, self._count("".join(parts)), int((time.monotonic() - t0) * 1000))
        self.record_usage(usage)
        yield usage


class HFRemoteService(BaseService):
    """Proxy to the Hugging Face serverless Inference API."""

    backend = "hf_remote"

    def __init__(self, model_name: str, token: Optional[str] = None, price_per_token: float = 0.0):
        super().__init__("hf_remote", model_name, price_per_token)
        self.token = token
        self.client: Any = None

    async def load(self) -> None:
        if not self.token:
            raise ServiceError("A Hugging Face token is required. Set HF_TOKEN in the environment.")
        try:
            from huggingface_hub import AsyncInferenceClient
        except ImportError as e:
            raise ServiceError("huggingface_hub is not installed") from e
        self.client = AsyncInferenceClient(model=self.model_name, token=self.token, timeout=300)

    def get_metadata(self) -> Dict[str, Any]:
        return {**super().get_metadata(), "tag": "remote"}

    async def stream(self, req: GenerationRequest) -> AsyncGenerator[StreamItem, None]:
        if self.client is None:
            raise ServiceError("Remote client not initialized")
        t0 = time.monotonic()
        completion_tokens = 0
        try:
            if req.messages is not None:
                stream = await self.client.chat_completion(
                    messages=req.messages,
                    max_tokens=req.max_new_tokens,
                    temperature=req.temperature or None,
                    stream=True,
                )
                async for chunk in stream:
                    delta = chunk.choices[0].delta.content if chunk.choices else None
                    if delta:
                        completion_tokens += 1
                        yield delta
            else:
                stream = await self.client.text_generation(
                    req.prompt or "",
                    max_new_tokens=req.max_new_tokens,
                    temperature=req.temperature or None,
                    do_sample=req.temperature > 0,
                    stream=True,
                    details=True,
                )
                async for event in stream:
                    token = getattr(event, "token", None)
                    if token is not None and not getattr(token, "special", False) and token.text:
                        completion_tokens += 1
                        yield token.text
        except Exception as e:
            raise ServiceError(f"Hugging Face Inference API error: {e}") from e
        usage = Usage(0, completion_tokens, int((time.monotonic() - t0) * 1000))
        self.record_usage(usage)
        yield usage


def create_service(backend: str, model: str, *, price_per_token: float = 0.0, settings=None) -> BaseService:
    from .settings import get_settings

    settings = settings or get_settings()
    if backend == "hf":
        return HFService(model, price_per_token)
    if backend == "hf_remote":
        return HFRemoteService(model, token=settings.hf_token, price_per_token=price_per_token)
    if backend == "ollama":
        return OllamaService(model, host=settings.ollama_host, price_per_token=price_per_token)
    if backend == "echo":
        return EchoService(model)
    raise ServiceError(f"Unknown backend: {backend}")
