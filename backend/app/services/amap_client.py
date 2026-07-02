from __future__ import annotations

from typing import Any

import httpx

MAX_AMAP_CALLS_PER_COMMUNITY = 4


class AmapBudgetExhausted(Exception):
    pass


class AmapClient:
    """Thin Amap Web API wrapper with a hard per-community call budget."""

    def __init__(self, client: httpx.Client, key: str, max_calls: int = MAX_AMAP_CALLS_PER_COMMUNITY):
        self._client = client
        self._key = key
        self._max_calls = max_calls
        self.calls_used = 0
        self.call_log: list[dict[str, Any]] = []

    def remaining(self) -> int:
        return self._max_calls - self.calls_used

    def _request(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        if self.calls_used >= self._max_calls:
            raise AmapBudgetExhausted(f"Amap call budget exhausted ({self._max_calls})")
        payload = {**params, "key": self._key}
        response = self._client.get(url, params=payload, timeout=30.0)
        response.raise_for_status()
        data = response.json()
        self.calls_used += 1
        self.call_log.append({"url": url, "params": {k: v for k, v in payload.items() if k != "key"}})
        return data

    def place_text(
        self,
        keywords: str,
        *,
        city: str = "西安",
        citylimit: bool = True,
        types: str | None = None,
        offset: int = 5,
        extensions: str = "base",
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "keywords": keywords,
            "city": city,
            "citylimit": "true" if citylimit else "false",
            "offset": offset,
            "extensions": extensions,
        }
        if types:
            params["types"] = types
        return self._request("https://restapi.amap.com/v3/place/text", params)

    def place_detail(self, poi_id: str, *, extensions: str = "all") -> dict[str, Any]:
        return self._request(
            "https://restapi.amap.com/v3/place/detail",
            {"id": poi_id, "extensions": extensions},
        )

    def geocode(self, address: str, *, city: str = "西安") -> dict[str, Any]:
        return self._request(
            "https://restapi.amap.com/v3/geocode/geo",
            {"address": address, "city": city},
        )
