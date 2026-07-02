from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from geoalchemy2.shape import from_shape, to_shape
from shapely.geometry import Point, Polygon
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.crawlers.zjj_client import (
    USER_AGENT,
    ZjjClient,
    enrich_project_metrics,
    parse_current_sale_projects,
    parse_presale_projects,
)
from app.models import Community, CrawlJob, Project
from app.services.boundary import resolve_boundary
from app.services.classifier import classify_project


def _community_name_matches(community_name: str, feature_name: str) -> bool:
    normalized_feature = (feature_name or "").replace(" (OSM)", "").strip()
    return community_name == normalized_feature or community_name in normalized_feature


def _extract_district(location: str) -> str:
    import re

    match = re.search(r"西安市([^市区县]+[市区县])", location or "")
    return match.group(1) if match else ""


def polygon_to_geom(polygon_coords: list[list[float]]):
    return from_shape(Polygon(polygon_coords), srid=4326)


def point_to_geom(point_coords: list[float]):
    return from_shape(Point(point_coords), srid=4326)


def upsert_project(db: Session, data: dict[str, Any], boundary: dict[str, Any]) -> Community:
    project = db.scalar(select(Project).where(Project.external_id == data["external_id"]))
    classified = classify_project(data, data.get("filing_price"))
    if not project:
        project = Project(external_id=data["external_id"])
        db.add(project)

    project.name = data["name"]
    project.district = data.get("district")
    project.developer = data.get("developer")
    project.location_text = data.get("location_text")
    project.permit_no = data.get("permit_no")
    project.sale_type = data["sale_type"]
    project.published_at = data.get("published_at")
    project.total_units = data.get("total_units")
    project.sold_units = data.get("sold_units")
    project.available_units = data.get("available_units")
    project.sold_ratio = data.get("sold_ratio")
    project.status = classified["status"]
    project.data_source = "zjj.xa.gov.cn"
    project.metadata_json = {"buildings": data.get("buildings"), "detail_url": data.get("detail_url")}
    db.flush()

    community = db.scalar(select(Community).where(Community.project_id == project.id))
    if not community:
        community = Community(project_id=project.id)
        db.add(community)

    community.name = data["name"]
    community.category = classified["category"]
    community.filing_price = data.get("filing_price")
    community.market_price = data.get("market_price")
    community.display_price = classified["display_price"]
    community.boundary_source = boundary.get("boundary_source")
    if boundary.get("polygon"):
        community.geom = polygon_to_geom(boundary["polygon"])
    if boundary.get("center"):
        community.center = point_to_geom(boundary["center"])
    community.metadata_json = {
        "confidence": boundary.get("confidence"),
        "location_text": data.get("location_text"),
    }
    db.flush()
    return community


def crawl_list_pages(
    db: Session,
    source: str,
    max_pages: int,
    delay: float,
    *,
    max_records: int | None = None,
    amap_key: str = "",
    boundary_provider: str = "osm",
    overpass_urls: list[str] | None = None,
    road_fetch_delay: float = 1.0,
) -> int:
    job = CrawlJob(source=source, status="running")
    db.add(job)
    db.commit()
    count = 0
    try:
        with ZjjClient(delay=delay) as zjj_client, httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=120.0
        ) as map_client:
            for page in range(1, max_pages + 1):
                if max_records is not None and count >= max_records:
                    break
                if source == "presale":
                    html = zjj_client.get_html(f"http://zjj.xa.gov.cn/ygsf/index.aspx?page={page}")
                    projects = parse_presale_projects(html)
                else:
                    html = zjj_client.get_html(f"https://zjj.xa.gov.cn/xsgs/index.aspx?page={page}")
                    projects = parse_current_sale_projects(html)

                for item in projects:
                    if max_records is not None and count >= max_records:
                        break
                    enriched = enrich_project_metrics(zjj_client, item)
                    boundary = resolve_boundary(
                        map_client,
                        enriched["name"],
                        enriched.get("location_text") or "",
                        amap_key=amap_key,
                        boundary_provider=boundary_provider,
                        overpass_urls=overpass_urls,
                        road_fetch_delay=road_fetch_delay,
                    )
                    upsert_project(db, enriched, boundary)
                    count += 1
                db.commit()
        job.status = "success"
        job.records_count = count
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise
    return count


def import_spike_seed(db: Session, spike_dir: Path, settings) -> int:
    count = 0
    overpass_urls = [
        url.strip()
        for url in settings.overpass_urls.split(",")
        if url.strip()
    ] or None
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30.0) as map_client:
        for filename, sale_type in [
            ("spike_1_presale.json", "presale"),
            ("spike_2_current_sale.json", "current_sale"),
        ]:
            path = spike_dir / filename
            if not path.exists():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            sample = payload.get("sample_project", {})
            if not sample:
                continue
            metrics = payload.get("building_metrics", {})
            data = {
                "external_id": sample.get("yszid") or sample.get("xsbh") or sample.get("name"),
                "name": sample.get("name"),
                "location_text": sample.get("location"),
                "developer": sample.get("developer"),
                "permit_no": sample.get("permit_no"),
                "published_at": sample.get("published_at"),
                "sale_type": sale_type,
                "district": _extract_district(sample.get("location", "")),
                **metrics,
            }
            boundary = resolve_boundary(
                map_client,
                data["name"],
                data.get("location_text") or "",
                amap_key=settings.amap_web_key,
                boundary_provider=settings.boundary_provider,
                overpass_urls=overpass_urls,
                road_fetch_delay=settings.osm_road_fetch_delay_seconds,
            )
            upsert_project(db, data, boundary)
            count += 1

        price_path = spike_dir / "spike_2b_price.json"
        if price_path.exists():
            price_payload = json.loads(price_path.read_text(encoding="utf-8"))
            avg_price = price_payload.get("avg_unit_price")
            sample = price_payload.get("sample_project", {})
            project = db.scalar(
                select(Project).where(Project.name.contains(sample.get("name", "")[:4]))
            )
            if project and avg_price:
                project.metadata_json = {
                    **(project.metadata_json or {}),
                    "filing_price_avg": avg_price,
                }
                if project.community:
                    project.community.filing_price = avg_price
                    project.community.display_price = avg_price
                count += 1

        geojson_path = spike_dir / "osm_boundary_sample.geojson"
        if not geojson_path.exists():
            geojson_path = spike_dir / "boundary_sample.geojson"
        if geojson_path.exists():
            features = json.loads(geojson_path.read_text(encoding="utf-8")).get("features", [])
            for feature in features:
                props = feature.get("properties", {})
                community = None
                for existing in db.scalars(select(Community)).all():
                    if _community_name_matches(existing.name, props.get("name", "")):
                        community = existing
                        break
                if not community:
                    continue
                coords = feature.get("geometry", {}).get("coordinates")
                if coords:
                    community.geom = polygon_to_geom(coords[0])
                    community.boundary_source = props.get("boundary_source")
                    center = to_shape(community.geom).centroid
                    community.center = point_to_geom([center.x, center.y])
                    count += 1
    db.commit()
    return count


def communities_to_geojson(db: Session) -> dict[str, Any]:
    communities = db.scalars(select(Community)).all()
    features = []
    prices = [c.display_price for c in communities if c.display_price]
    min_price = min(prices) if prices else 0
    max_price = max(prices) if prices else 1

    for community in communities:
        if community.geom is None:
            continue
        shape = to_shape(community.geom)
        project = community.project
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": community.id,
                    "name": community.name,
                    "display_price": community.display_price,
                    "category": community.category,
                    "district": project.district if project else None,
                    "developer": project.developer if project else None,
                    "sold_ratio": project.sold_ratio if project else None,
                    "boundary_source": community.boundary_source,
                    "price_min": min_price,
                    "price_max": max_price,
                },
                "geometry": json.loads(json.dumps(shape.__geo_interface__)),
            }
        )
    return {"type": "FeatureCollection", "coordinate_system": "wgs84", "features": features}


def summary_stats(db: Session) -> dict[str, Any]:
    total = db.scalar(select(func.count(Community.id))) or 0
    by_category = dict(
        db.execute(
            select(Community.category, func.count(Community.id)).group_by(Community.category)
        ).all()
    )
    avg_price = db.scalar(select(func.avg(Community.display_price)))
    return {
        "total_communities": total,
        "by_category": by_category,
        "avg_display_price": round(float(avg_price), 2) if avg_price else None,
    }


def bootstrap_data(db: Session) -> None:
    settings = get_settings()
    spike_dir = Path(settings.spike_results_dir)
    if db.scalar(select(func.count(Community.id))):
        return
    if spike_dir.exists():
        import_spike_seed(db, spike_dir, settings)


def re_resolve_boundaries(db: Session, settings) -> dict[str, int]:
    overpass_urls = [
        url.strip()
        for url in settings.overpass_urls.split(",")
        if url.strip()
    ] or None
    updated = 0
    skipped = 0
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=120.0) as map_client:
        communities = db.scalars(select(Community)).all()
        for community in communities:
            project = community.project
            if not project:
                skipped += 1
                continue
            boundary = resolve_boundary(
                map_client,
                community.name,
                project.location_text or "",
                amap_key=settings.amap_web_key,
                boundary_provider=settings.boundary_provider,
                overpass_urls=overpass_urls,
                road_fetch_delay=settings.osm_road_fetch_delay_seconds,
            )
            if boundary.get("polygon"):
                community.geom = polygon_to_geom(boundary["polygon"])
                community.boundary_source = boundary.get("boundary_source")
                if boundary.get("center"):
                    community.center = point_to_geom(boundary["center"])
                community.metadata_json = {
                    **(community.metadata_json or {}),
                    "confidence": boundary.get("confidence"),
                    "boundary_details": boundary.get("details"),
                }
                updated += 1
            else:
                skipped += 1
            db.flush()
    db.commit()
    return {"updated": updated, "skipped": skipped, "total": updated + skipped}
