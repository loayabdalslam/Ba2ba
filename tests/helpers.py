import asyncio
from typing import AsyncGenerator

from bee2bee.protocol import GenerationRequest, Usage
from bee2bee.services import BaseService, ServiceError


async def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)


class FailingService(BaseService):
    backend = "failing"

    def __init__(self, model_name: str):
        super().__init__("failing", model_name)
        self.calls = 0

    async def stream(self, req: GenerationRequest) -> AsyncGenerator:
        self.calls += 1
        raise ServiceError("boom")
        yield  # pragma: no cover


class SlowService(BaseService):
    """Streams one chunk then blocks until cancelled."""

    backend = "slow"

    def __init__(self, model_name: str):
        super().__init__("slow", model_name)
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def stream(self, req: GenerationRequest) -> AsyncGenerator:
        yield "first"
        self.started.set()
        try:
            await asyncio.sleep(60)
        finally:
            self.cancelled.set()
        yield Usage()
