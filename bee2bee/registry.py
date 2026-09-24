"""Node registry client.

Two modes:

* **Gateway (default for public nodes):** POST a registration signed with the
  node's Ed25519 key to ``{BEE2BEE_REGISTRY_URL}/api/nodes/register``. The
  gateway verifies the signature, probes the node, and writes to Supabase with
  its service-role key. Nodes never hold database credentials.
* **Direct (operators only):** upsert into Supabase with a service-role key
  from ``SUPABASE_URL`` + ``SUPABASE_SERVICE_ROLE_KEY``. The anon key is never
  used for writes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from loguru import logger

from .identity import Identity, new_nonce
from .protocol import now_ms


class RegistryClient:
    def __init__(self, settings, identity: Identity):
        self.settings = settings
        self.identity = identity
        self.mode: Optional[str] = None
        if settings.registry_url:
            self.mode = "gateway"
            self.url = settings.registry_url.rstrip("/") + "/api/nodes/register"
        elif settings.supabase_url and settings.supabase_service_key:
            self.mode = "direct"
            self.url = settings.supabase_url.rstrip("/") + "/rest/v1/active_nodes?on_conflict=peer_id"
        self._client: Optional[httpx.AsyncClient] = None
        self._failures = 0

    @property
    def enabled(self) -> bool:
        return self.mode is not None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=10.0)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def build_registration(
        self, addr: str, models: List[str], region: str, metrics: Dict[str, Any], api_port: Optional[int]
    ) -> Dict[str, Any]:
        body = {
            "peer_id": self.identity.peer_id,
            "pubkey": self.identity.pubkey,
            "addr": addr,
            "models": sorted(models),
            "region": region,
            "api_port": api_port or 0,
            "ts": now_ms(),
            "nonce": new_nonce(),
        }
        # Metrics are informational and excluded from the signature so float
        # formatting differences between languages cannot break verification.
        return {**body, "sig": self.identity.sign(body), "metrics": metrics}

    async def sync_node(
        self,
        addr: str,
        models: List[str],
        region: str = "Auto",
        metrics: Optional[Dict[str, Any]] = None,
        api_port: Optional[int] = None,
    ) -> bool:
        if not self.enabled:
            return False
        try:
            if self.mode == "gateway":
                payload = self.build_registration(addr, models, region, metrics or {}, api_port)
                resp = await self._http().post(self.url, json=payload)
            else:
                key = self.settings.supabase_service_key
                row = {
                    "peer_id": self.identity.peer_id,
                    "pubkey": self.identity.pubkey,
                    "addr": addr,
                    "models": models,
                    "region": region,
                    "metrics": {**(metrics or {}), "api_port": api_port},
                    "verified": True,
                    "last_seen": datetime.now(timezone.utc).isoformat(),
                }
                resp = await self._http().post(
                    self.url,
                    json=row,
                    headers={
                        "apikey": key,
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                        "Prefer": "resolution=merge-duplicates,return=minimal",
                    },
                )
            if resp.status_code in (200, 201, 204):
                if self._failures:
                    logger.info("Registry sync recovered")
                self._failures = 0
                return True
            self._failures += 1
            logger.warning(f"Registry sync failed: HTTP {resp.status_code} {resp.text[:200]}")
        except httpx.HTTPError as e:
            self._failures += 1
            if self._failures in (1, 10) or self._failures % 100 == 0:
                logger.warning(f"Registry unreachable ({self._failures} consecutive failures): {e}")
        return False
