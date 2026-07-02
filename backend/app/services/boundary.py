from __future__ import annotations

import re
from typing import Any

import httpx

from app.services.amap_client import AmapBudgetExhausted, AmapClient, MAX_AMAP_CALLS_PER_COMMUNITY
from app.services.geo import gcj02_to_wgs84, haversine_m, intersect_lines
from app.services.osm_boundary import (
    DEFAULT_OVERPASS_URLS,
    geocode_fallback_osm,
    polygon_from_road_bounds_osm,
)

from app.services.boundary_parse import (
    CORNER_ROLES,
    buffer_polygon,
    has_road_bounds,
    parse_district_prefix,
    parse_road_bounds,
    polygon_centroid,
)

PHASE_PATTERN = re.compile(r"([一二三四五六七八九十\d]+)期")
DOOR_NUMBER_PATTERN = re.compile(r"(\d+)号")

ROLE_BOUNDARY_AXIS = {
    "west": "vertical",
    "east": "vertical",
    "north": "horizontal",
    "south": "horizontal",
}


def phase_token(value: str | None) -> str | None:
    if not value:
        return None
    token = value.strip()
    mapping = {"1": "一", "2": "二", "3": "三", "4": "四", "5": "五"}
    return mapping.get(token, token) if token.isdigit() else token


def phases_conflict(requested_name: str, poi_name: str) -> bool:
    requested = PHASE_PATTERN.search(requested_name)
    resolved = PHASE_PATTERN.search(poi_name)
    if requested and resolved:
        return phase_token(requested.group(1)) != phase_token(resolved.group(1))
    return False


def normalize_project_label(text: str) -> str:
    normalized = re.sub(r"[（(].*?[）)]", "", text.strip())
    normalized = normalized.replace("1期", "一期").replace("2期", "二期").replace("3期", "三期")
    normalized = re.sub(r"(小区|项目|苑|花园)$", "", normalized)
    return normalized.replace(" ", "")


def labels_match(requested: str, candidate: str) -> bool:
    if phases_conflict(requested, candidate):
        return False
    requested_norm = normalize_project_label(requested)
    candidate_norm = normalize_project_label(candidate)
    if not requested_norm or not candidate_norm:
        return False
    if PHASE_PATTERN.search(requested) and not PHASE_PATTERN.search(candidate):
        return False
    return requested_norm in candidate_norm or candidate_norm in requested_norm


def poi_matches_name(poi: dict[str, Any], project_name: str) -> bool:
    name = poi.get("name") or ""
    address = poi.get("address") or ""
    if not (labels_match(project_name, name) or labels_match(project_name, address)):
        return False
    return not phases_conflict(project_name, name)


def poi_location(poi: dict[str, Any]) -> list[float] | None:
    location = poi.get("location", "")
    if "," not in location:
        return None
    lng, lat = location.split(",", 1)
    return [float(lng), float(lat)]


def parse_amap_polyline(polyline: str) -> list[list[float]]:
    points: list[list[float]] = []
    for chunk in polyline.split(";"):
        if "," not in chunk:
            continue
        lng, lat = chunk.split(",", 1)
        points.append([float(lng), float(lat)])
    return points


def polygon_from_polyline(polyline: str) -> list[list[float]] | None:
    ring = parse_amap_polyline(polyline)
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def mean_location(points: list[list[float]]) -> list[float] | None:
    if not points:
        return None
    lngs = [point[0] for point in points]
    lats = [point[1] for point in points]
    return [sum(lngs) / len(lngs), sum(lats) / len(lats)]


def boundary_line_through_point(point: list[float], role: str, extend_m: float = 3_000) -> list[list[float]]:
    lng, lat = point
    lng_delta = extend_m / 85_000
    lat_delta = extend_m / 111_000
    if ROLE_BOUNDARY_AXIS[role] == "vertical":
        return [[lng, lat - lat_delta], [lng, lat + lat_delta]]
    return [[lng - lng_delta, lat], [lng + lng_delta, lat]]


def corner_from_roles(
    roads: dict[str, dict[str, Any]], role_a: str, role_b: str
) -> list[float] | None:
    if role_a not in roads or role_b not in roads:
        return None
    seg_a = roads[role_a]["line"]
    seg_b = roads[role_b]["line"]
    return intersect_lines(seg_a[0], seg_a[1], seg_b[0], seg_b[1])


def polygon_from_road_roles(roads: dict[str, dict[str, Any]]) -> list[list[float]] | None:
    corners: list[list[float]] = []
    for _, role_a, role_b in CORNER_ROLES:
        corner = corner_from_roles(roads, role_a, role_b)
        if corner is None:
            return None
        corners.append(corner)
    if len(corners) < 3:
        return None
    corners.append(corners[0])
    return corners


def fetch_road_candidates(
    amap: AmapClient, district_prefix: str, road_name: str, role: str
) -> list[dict[str, Any]]:
    payload = amap.place_text(
        f"{district_prefix}{road_name}",
        citylimit=True,
        offset=10,
    )
    candidates: list[dict[str, Any]] = []
    for poi in payload.get("pois") or []:
        location = poi_location(poi)
        if not location:
            continue
        label = f"{poi.get('name') or ''}{poi.get('address') or ''}"
        if road_name not in label:
            continue
        candidates.append(
            {
                "road": road_name,
                "role": role,
                "name": poi.get("name"),
                "address": poi.get("address"),
                "location": location,
                "poi_id": poi.get("id"),
                "query": f"{district_prefix}{road_name}",
            }
        )
    if candidates:
        return candidates
    poi = (payload.get("pois") or [None])[0]
    if not poi:
        return []
    location = poi_location(poi)
    if not location:
        return []
    return [
        {
            "road": road_name,
            "role": role,
            "name": poi.get("name"),
            "address": poi.get("address"),
            "location": location,
            "poi_id": poi.get("id"),
            "query": f"{district_prefix}{road_name}",
        }
    ]


def select_roads_for_bounds(
    candidate_map: dict[str, list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    reference = mean_location(
        [items[0]["location"] for items in candidate_map.values() if items]
    )
    for _ in range(3):
        if reference is None:
            break
        for role, items in candidate_map.items():
            if not items:
                continue
            if reference is not None:
                items = sorted(items, key=lambda item: haversine_m(reference, item["location"]))
            match = items[0]
            selected[role] = {
                **match,
                "line": boundary_line_through_point(match["location"], role),
            }
        reference = mean_location([item["location"] for item in selected.values()])
    return selected


def polygon_from_road_bounds(
    amap: AmapClient, location_text: str
) -> dict[str, Any] | None:
    bounds = parse_road_bounds(location_text)
    if len(bounds) < 2:
        return None

    district = parse_district_prefix(location_text)
    candidate_map: dict[str, list[dict[str, Any]]] = {}
    for road_name, direction, role in bounds:
        if amap.remaining() <= 0:
            break
        try:
            candidate_map[role] = fetch_road_candidates(amap, district, road_name, role)
        except AmapBudgetExhausted:
            break

    roads = select_roads_for_bounds(candidate_map)
    if len(roads) < 2:
        return None

    anchor = mean_location([item["location"] for item in roads.values()])
    if anchor is not None and len(roads) < 4:
        roads = fill_missing_roles_with_anchor(roads, anchor)

    polygon = polygon_from_road_roles(roads)
    if polygon is None and anchor is not None:
        roads = fill_missing_roles_with_anchor(roads, anchor)
        polygon = polygon_from_road_roles(roads)

    if polygon is None:
        return None

    return {
        "method": "road_lines",
        "district_prefix": district,
        "roads": roads,
        "anchor": anchor,
        "polygon": polygon,
    }


def fill_missing_roles_with_anchor(
    roads: dict[str, dict[str, Any]], anchor: list[float]
) -> dict[str, dict[str, Any]]:
    lng, lat = anchor
    defaults = {
        "west": {"road": "west", "role": "west", "name": "synthetic-west", "location": [lng - 0.0015, lat]},
        "east": {"road": "east", "role": "east", "name": "synthetic-east", "location": [lng + 0.0015, lat]},
        "south": {"road": "south", "role": "south", "name": "synthetic-south", "location": [lng, lat - 0.0015]},
        "north": {"road": "north", "role": "north", "name": "synthetic-north", "location": [lng, lat + 0.0015]},
    }
    filled = dict(roads)
    for role, item in defaults.items():
        if role not in filled:
            item = {**item, "line": boundary_line_through_point(item["location"], role), "synthetic": True}
            filled[role] = item
    return filled


def pick_project_poi(pois: list[dict[str, Any]], project_name: str) -> dict[str, Any] | None:
    for poi in pois:
        if poi_matches_name(poi, project_name):
            return poi
    return None


def fetch_poi_polygon(
    amap: AmapClient, project_name: str
) -> dict[str, Any] | None:
    if amap.remaining() <= 0:
        return None
    payload = amap.place_text(project_name, citylimit=True, offset=5)
    poi = pick_project_poi(payload.get("pois") or [], project_name)
    if not poi:
        core = normalize_project_label(project_name)
        if core and amap.remaining() > 0:
            payload = amap.place_text(core, citylimit=True, offset=5)
            poi = pick_project_poi(payload.get("pois") or [], project_name)
    if not poi:
        return None

    location = poi_location(poi)
    result: dict[str, Any] = {
        "source": "poi_name",
        "poi": {
            "id": poi.get("id"),
            "name": poi.get("name"),
            "address": poi.get("address"),
            "type": poi.get("type"),
            "location": location,
        },
    }
    if not location:
        return None

    polyline = poi.get("polyline")
    if not polyline and poi.get("id") and amap.remaining() > 0:
        detail = amap.place_detail(poi["id"])
        detail_poi = (detail.get("pois") or [None])[0] or {}
        polyline = detail_poi.get("polyline")
        result["poi"]["detail_type"] = detail_poi.get("type")

    if polyline:
        polygon = polygon_from_polyline(polyline)
        if polygon:
            result.update(
                {
                    "source": "poi_aoi",
                    "polygon": polygon,
                    "center": polygon_centroid(polygon),
                }
            )
            return result

    result.update({"center": location, "polygon": buffer_polygon(location)})
    return result


def geocode_matches_request(request: str, formatted_address: str | None) -> bool:
    requested = DOOR_NUMBER_PATTERN.search(request)
    if not requested:
        return True
    resolved = DOOR_NUMBER_PATTERN.search(formatted_address or "")
    return bool(resolved and requested.group(1) == resolved.group(1))


def fetch_geocode_anchor(amap: AmapClient, location_text: str) -> dict[str, Any] | None:
    if amap.remaining() <= 0:
        return None
    payload = amap.geocode(location_text)
    geocodes = payload.get("geocodes") or []
    if not geocodes:
        return None
    item = geocodes[0]
    location = poi_location(item)
    if not location:
        return None
    if not geocode_matches_request(location_text, item.get("formatted_address")):
        return None
    return {
        "source": "geocode",
        "center": location,
        "polygon": buffer_polygon(location),
        "geocode": {
            "formatted_address": item.get("formatted_address"),
            "level": item.get("level"),
            "location": location,
        },
    }


def resolve_boundary(
    client: httpx.Client,
    name: str,
    location_text: str,
    *,
    amap_key: str = "",
    boundary_provider: str = "osm",
    overpass_urls: list[str] | None = None,
    road_fetch_delay: float = 1.0,
) -> dict[str, Any]:
    provider = (boundary_provider or "osm").lower()
    result: dict[str, Any] = {
        "boundary_source": None,
        "confidence": "low",
        "center": None,
        "polygon": None,
        "coordinate_system": "wgs84",
        "details": {"provider": provider},
    }

    def _apply_polygon(
        source: str,
        confidence: str,
        polygon: list[list[float]],
        center: list[float] | None,
        details: dict[str, Any],
        *,
        input_crs: str = "wgs84",
    ) -> dict[str, Any]:
        if input_crs == "gcj02":
            polygon = [gcj02_to_wgs84(point[0], point[1]) for point in polygon]
            if center:
                center = gcj02_to_wgs84(center[0], center[1])
        result.update(
            {
                "boundary_source": source,
                "confidence": confidence,
                "center": center or polygon_centroid(polygon),
                "polygon": polygon,
                "coordinate_system": "wgs84",
                "details": {**result["details"], **details},
            }
        )
        return result

    if provider in {"osm", "auto"} and has_road_bounds(location_text):
        try:
            road_result = polygon_from_road_bounds_osm(
                client,
                location_text,
                project_name=name,
                overpass_urls=overpass_urls or DEFAULT_OVERPASS_URLS,
                road_fetch_delay=road_fetch_delay,
            )
            if road_result and road_result.get("polygon"):
                return _apply_polygon(
                    road_result["method"],
                    "medium",
                    road_result["polygon"],
                    road_result.get("anchor"),
                    {"osm": road_result},
                )
        except Exception as exc:  # noqa: BLE001
            result["details"]["osm_error"] = str(exc)

    if provider in {"amap", "auto"} and amap_key:
        amap = AmapClient(client, amap_key, max_calls=MAX_AMAP_CALLS_PER_COMMUNITY)
        try:
            if has_road_bounds(location_text):
                road_result = polygon_from_road_bounds(amap, location_text)
                if road_result and road_result.get("polygon"):
                    polygon = road_result["polygon"]
                    return _apply_polygon(
                        road_result["method"],
                        "medium",
                        polygon,
                        polygon_centroid(polygon),
                        {
                            "amap_calls": amap.calls_used,
                            "amap_call_log": amap.call_log,
                            "roads": road_result,
                        },
                        input_crs="gcj02",
                    )

            poi_result = fetch_poi_polygon(amap, name)
            if poi_result and poi_result.get("polygon"):
                confidence = "high" if poi_result["source"] == "poi_aoi" else "medium"
                return _apply_polygon(
                    poi_result["source"],
                    confidence,
                    poi_result["polygon"],
                    poi_result.get("center"),
                    {
                        "amap_calls": amap.calls_used,
                        "amap_call_log": amap.call_log,
                        "poi": poi_result,
                    },
                    input_crs="gcj02",
                )

            if amap.remaining() > 0:
                geocode_result = fetch_geocode_anchor(amap, location_text)
                if geocode_result and geocode_result.get("polygon"):
                    return _apply_polygon(
                        geocode_result["source"],
                        "low",
                        geocode_result["polygon"],
                        geocode_result["center"],
                        {
                            "amap_calls": amap.calls_used,
                            "amap_call_log": amap.call_log,
                            "geocode": geocode_result,
                        },
                        input_crs="gcj02",
                    )
        except AmapBudgetExhausted:
            pass
        result["details"]["amap_calls"] = amap.calls_used
        result["details"]["amap_call_log"] = amap.call_log

    if provider in {"osm", "auto"} and not has_road_bounds(location_text):
        geocode_result = geocode_fallback_osm(client, name, location_text)
        if geocode_result and geocode_result.get("polygon"):
            return _apply_polygon(
                geocode_result["method"],
                "low",
                geocode_result["polygon"],
                geocode_result.get("center"),
                {"osm": geocode_result},
            )

    return result
