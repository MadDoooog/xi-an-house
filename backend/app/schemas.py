from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class CommunitySummary(BaseModel):
    id: int
    name: str
    category: str
    display_price: float | None
    district: str | None
    developer: str | None
    sold_ratio: float | None
    boundary_source: str | None
    location_text: str | None


class CommunityDetail(CommunitySummary):
    sale_type: str | None
    permit_no: str | None
    total_units: int | None
    sold_units: int | None
    available_units: int | None
    filing_price: float | None
    market_price: float | None
    status: str | None
    published_at: str | None
    metadata: dict[str, Any] | None


class CrawlTriggerResponse(BaseModel):
    source: str
    records_count: int


class CrawlJobOut(BaseModel):
    id: int
    source: str
    status: str
    records_count: int
    error: str | None
    started_at: datetime
    finished_at: datetime | None

    model_config = {"from_attributes": True}
