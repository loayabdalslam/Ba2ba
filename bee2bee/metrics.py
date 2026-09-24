"""Minimal Prometheus text-format metrics (no external dependency)."""

from __future__ import annotations

import threading
from typing import Dict, Iterable, List, Optional, Tuple

LabelKey = Tuple[Tuple[str, str], ...]


def _key(labels: Optional[Dict[str, str]]) -> LabelKey:
    return tuple(sorted((labels or {}).items()))


def _fmt_labels(key: LabelKey, extra: Iterable[Tuple[str, str]] = ()) -> str:
    items = list(key) + list(extra)
    if not items:
        return ""
    body = ",".join(f'{k}="{str(v).replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"' for k, v in items)
    return "{" + body + "}"


class _Metric:
    kind = "untyped"

    def __init__(self, name: str, help_text: str):
        self.name = name
        self.help = help_text
        self._lock = threading.Lock()

    def render(self) -> List[str]:
        return [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.kind}"] + self._samples()

    def _samples(self) -> List[str]:
        raise NotImplementedError


class Counter(_Metric):
    kind = "counter"

    def __init__(self, name: str, help_text: str):
        super().__init__(name, help_text)
        self._values: Dict[LabelKey, float] = {}

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        k = _key(labels)
        with self._lock:
            self._values[k] = self._values.get(k, 0.0) + amount

    def value(self, **labels: str) -> float:
        return self._values.get(_key(labels), 0.0)

    def _samples(self) -> List[str]:
        return [f"{self.name}{_fmt_labels(k)} {v}" for k, v in sorted(self._values.items())]


class Gauge(_Metric):
    kind = "gauge"

    def __init__(self, name: str, help_text: str, fn=None):
        super().__init__(name, help_text)
        self._values: Dict[LabelKey, float] = {}
        self._fn = fn

    def set(self, value: float, **labels: str) -> None:
        with self._lock:
            self._values[_key(labels)] = value

    def _samples(self) -> List[str]:
        if self._fn is not None:
            return [f"{self.name} {float(self._fn())}"]
        return [f"{self.name}{_fmt_labels(k)} {v}" for k, v in sorted(self._values.items())]


class Histogram(_Metric):
    kind = "histogram"
    DEFAULT_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300)

    def __init__(self, name: str, help_text: str, buckets: Iterable[float] = DEFAULT_BUCKETS):
        super().__init__(name, help_text)
        self.buckets = tuple(sorted(buckets))
        self._data: Dict[LabelKey, Tuple[List[int], float, int]] = {}

    def observe(self, value: float, **labels: str) -> None:
        k = _key(labels)
        with self._lock:
            counts, total, n = self._data.get(k, ([0] * len(self.buckets), 0.0, 0))
            for i, b in enumerate(self.buckets):
                if value <= b:
                    counts[i] += 1
            self._data[k] = (counts, total + value, n + 1)

    def _samples(self) -> List[str]:
        out: List[str] = []
        for k, (counts, total, n) in sorted(self._data.items()):
            for b, c in zip(self.buckets, counts, strict=True):
                out.append(f"{self.name}_bucket{_fmt_labels(k, [('le', str(b))])} {c}")
            out.append(f"{self.name}_bucket{_fmt_labels(k, [('le', '+Inf')])} {n}")
            out.append(f"{self.name}_sum{_fmt_labels(k)} {total}")
            out.append(f"{self.name}_count{_fmt_labels(k)} {n}")
        return out


class Registry:
    def __init__(self) -> None:
        self._metrics: List[_Metric] = []

    def register(self, metric: _Metric) -> _Metric:
        self._metrics.append(metric)
        return metric

    def counter(self, name: str, help_text: str) -> Counter:
        return self.register(Counter(name, help_text))  # type: ignore[return-value]

    def gauge(self, name: str, help_text: str, fn=None) -> Gauge:
        return self.register(Gauge(name, help_text, fn))  # type: ignore[return-value]

    def histogram(self, name: str, help_text: str, buckets: Iterable[float] = Histogram.DEFAULT_BUCKETS) -> Histogram:
        return self.register(Histogram(name, help_text, buckets))  # type: ignore[return-value]

    def render(self) -> str:
        lines: List[str] = []
        for metric in self._metrics:
            lines.extend(metric.render())
        return "\n".join(lines) + "\n"
