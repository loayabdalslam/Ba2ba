"""Heartbeats to the central Bee2Bee directory (server/ on Vercel + Neon).

Every ``BEE2BEE_DIRECTORY_INTERVAL`` seconds the node POSTs a heartbeat signed
with its Ed25519 key to ``{BEE2BEE_DIRECTORY_URL}/api/nodes/heartbeat``. The
directory verifies the signature, connects back once to check that the address
belongs to this peer id, and lists the node with its models, providers and
performance so desktop clients can find it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
from loguru import logger

from ._version import __version__
from .identity import Identity, new_nonce
from .protocol import now_ms

SIGNED_FIELDS = ("peer_id", "pubkey", "addr", "name", "region", "version", "api_port", "models", "ts", "nonce")


class DirectoryClient:
    def __init__(self, settings, identity: Identity):
        self.settings = settings
        self.identity = identity
        self.url = settings.directory_url.rstrip("/") + "/api/nodes/heartbeat" if settings.directory_url else None
        self._client: Optional[httpx.AsyncClient] = None
        self._failures = 0
        self.last_result: Dict[str, Any] = {}

    @property
    def enabled(self) -> bool:
        return self.url is not None

    def build(
        self,
        addr: str,
        models: List[Dict[str, str]],
        metrics: Dict[str, Any],
        api_port: Optional[int],
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "peer_id": self.identity.peer_id,
            "pubkey": self.identity.pubkey,
            "addr": addr,
            "name": self.settings.node_name[:64],
            "region": (self.settings.region or "Auto")[:64],
            "version": __version__,
            "api_port": int(api_port or 0),
            "models": sorted(models, key=lambda m: (m["name"], m["provider"])),
            "ts": now_ms(),
            "nonce": new_nonce(),
        }
        body["sig"] = self.identity.sign({k: body[k] for k in SIGNED_FIELDS})
        # Metrics may contain floats, so they are sent unsigned.
        body["metrics"] = metrics
        return body

    async def heartbeat(self, addr: str, models: List[Dict[str, str]], metrics: Dict[str, Any], api_port: Optional[int]) -> bool:
        if not self.url:
            return False
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=20.0)
        try:
            resp = await self._client.post(self.url, json=self.build(addr, models, metrics, api_port))
        except httpx.HTTPError as e:
            self._failures += 1
            if self._failures in (1, 10) or self._failures % 100 == 0:
                logger.warning(f"Directory unreachable ({self._failures} consecutive failures): {e}")
            return False
        if resp.status_code == 200:
            result = resp.json()
            if result.get("reachable") is False and self.last_result.get("reachable") is not False:
                logger.warning(
                    f"Directory could not reach this node at {addr}: {result.get('probe_error')}. "
                    "Check BEE2BEE_ANNOUNCE_ADDR / firewall so other users can connect."
                )
            self.last_result = result
            self._failures = 0
            return True
        if resp.status_code != 429:
            self._failures += 1
            logger.warning(f"Directory heartbeat rejected: HTTP {resp.status_code} {resp.text[:200]}")
        return False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
