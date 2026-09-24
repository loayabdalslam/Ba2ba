"""In-memory token-bucket rate limiter."""

from __future__ import annotations

import time
from typing import Dict, Tuple


class RateLimiter:
    def __init__(self, per_minute: int, burst: int | None = None, max_keys: int = 100_000):
        self.rate = per_minute / 60.0
        self.capacity = float(burst if burst is not None else per_minute)
        self.max_keys = max_keys
        self._buckets: Dict[str, Tuple[float, float]] = {}

    def allow(self, key: str, cost: float = 1.0) -> Tuple[bool, float]:
        """Return (allowed, retry_after_seconds)."""
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if tokens >= cost:
            self._buckets[key] = (tokens - cost, now)
            self._evict_if_needed()
            return True, 0.0
        self._buckets[key] = (tokens, now)
        return False, (cost - tokens) / self.rate if self.rate else 60.0

    def _evict_if_needed(self) -> None:
        if len(self._buckets) <= self.max_keys:
            return
        # Drop the stalest half; full buckets carry no information anyway.
        ordered = sorted(self._buckets.items(), key=lambda kv: kv[1][1])
        for key, _ in ordered[: len(ordered) // 2]:
            self._buckets.pop(key, None)
