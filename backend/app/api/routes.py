from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import Community, CrawlJob
from app.schemas import CommunityDetail, CrawlJobOut, CrawlTriggerResponse
from app.services.pipeline import (
    bootstrap_data,
    communities_to_geojson,
    crawl_list_pages,
    re_resolve_boundaries,
    summary_stats,
)

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/communities/re-resolve-boundaries")
def resolve_community_boundaries(db: Session = Depends(get_db)) -> dict[str, int]:
    settings = get_settings()
    return re_resolve_boundaries(db, settings)


@router.get("/communities/geojson")
def get_communities_geojson(db: Session = Depends(get_db)) -> dict[str, Any]:
    return communities_to_geojson(db)


@router.get("/communities/{community_id}", response_model=CommunityDetail)
def get_community(community_id: int, db: Session = Depends(get_db)) -> CommunityDetail:
    community = db.scalar(select(Community).where(Community.id == community_id))
    if not community:
        raise HTTPException(status_code=404, detail="Community not found")
    project = community.project
    return CommunityDetail(
        id=community.id,
        name=community.name,
        category=community.category,
        display_price=community.display_price,
        district=project.district if project else None,
        developer=project.developer if project else None,
        sold_ratio=project.sold_ratio if project else None,
        boundary_source=community.boundary_source,
        location_text=project.location_text if project else None,
        sale_type=project.sale_type if project else None,
        permit_no=project.permit_no if project else None,
        total_units=project.total_units if project else None,
        sold_units=project.sold_units if project else None,
        available_units=project.available_units if project else None,
        filing_price=community.filing_price,
        market_price=community.market_price,
        status=project.status if project else None,
        published_at=project.published_at if project else None,
        metadata=community.metadata_json,
    )


@router.get("/stats/summary")
def get_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    return summary_stats(db)


@router.post("/crawl/trigger", response_model=CrawlTriggerResponse)
def trigger_crawl(
    source: str = "presale",
    max_records: int | None = None,
    db: Session = Depends(get_db),
) -> CrawlTriggerResponse:
    settings = get_settings()
    if source not in {"presale", "current_sale"}:
        raise HTTPException(status_code=400, detail="source must be presale or current_sale")
    if max_records is not None and max_records < 1:
        raise HTTPException(status_code=400, detail="max_records must be at least 1")
    count = crawl_list_pages(
        db,
        source=source,
        max_pages=settings.crawl_max_pages,
        delay=settings.crawl_delay_seconds,
        max_records=max_records,
        amap_key=settings.amap_web_key,
        boundary_provider=settings.boundary_provider,
        overpass_urls=[
            url.strip()
            for url in settings.overpass_urls.split(",")
            if url.strip()
        ] or None,
        road_fetch_delay=settings.osm_road_fetch_delay_seconds,
    )
    return CrawlTriggerResponse(source=source, records_count=count)


@router.get("/crawl/jobs", response_model=list[CrawlJobOut])
def list_crawl_jobs(db: Session = Depends(get_db)) -> list[CrawlJob]:
    return list(db.scalars(select(CrawlJob).order_by(CrawlJob.id.desc()).limit(20)))
