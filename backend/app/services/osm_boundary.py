"""Build community boundaries from OSM road linestrings (Overpass API, WGS84)."""

from __future__ import annotations

import math
import time
from typing import Any

import httpx
from shapely.geometry import LineString, MultiLineString, Point, Polygon
from shapely.ops import linemerge, nearest_points, unary_union

from app.services.boundary_parse import (
    CORNER_ROLES,
    buffer_polygon,
    boundary_line_through_point,
    clean_road_name,
    has_road_bounds,
    parse_district_prefix,
    parse_road_bounds,
    polygon_centroid,
)

CORNER_HINTS: dict[str, tuple[int, int]] = {
    "sw": (-1, -1),
    "se": (1, -1),
    "ne": (1, 1),
    "nw": (-1, 1),
}

DEFAULT_OVERPASS_URLS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "xi-an-house/1.0 (boundary research; contact: local-dev)"

# Xi'an metropolitan area (WGS84)
XIAN_LNG_RANGE = (108.65, 109.25)
XIAN_LAT_RANGE = (34.05, 34.55)
NOMINATIM_VIEWBOX = "108.65,34.05,109.25,34.55"  # left,bottom,right,top

DISTRICT_ANCHORS: dict[str, list[float]] = {
    "雁塔区": [108.959, 34.215],
    "未央区": [108.946, 34.356],
    "灞桥区": [109.064, 34.273],
    "碑林区": [108.960, 34.251],
    "莲湖区": [108.933, 34.267],
    "新城区": [108.962, 34.266],
    "长安区": [108.907, 34.155],
    "高新区": [108.892, 34.198],
    "浐灞生态区": [109.050, 34.320],
    "曲江新区": [108.995, 34.195],
    "国际港务区": [109.070, 34.380],
    "航天基地": [108.958, 34.158],
    "经开区": [108.920, 34.365],
}
XIAN_CITY_CENTER = [108.940, 34.260]
XIAN_METRO_BBOX = "34.05,108.65,34.55,109.25"  # south,west,north,east for Overpass


def in_xian_bounds(lng: float, lat: float) -> bool:
    return XIAN_LNG_RANGE[0] <= lng <= XIAN_LNG_RANGE[1] and XIAN_LAT_RANGE[0] <= lat <= XIAN_LAT_RANGE[1]


def district_anchor_fallback(location_text: str) -> list[float]:
    district = parse_district_prefix(location_text)
    for key, anchor in DISTRICT_ANCHORS.items():
        if key in district:
            return anchor
    return XIAN_CITY_CENTER


def ensure_xian_query(query: str) -> str:
    text = query.strip()
    if not text:
        return "西安市"
    if "西安" not in text:
        return f"西安市{text}"
    return text


def geocode_nominatim(client: httpx.Client, query: str) -> list[float] | None:
    headers = {"User-Agent": USER_AGENT}
    params = {
        "q": ensure_xian_query(query),
        "format": "json",
        "limit": 5,
        "countrycodes": "cn",
        "viewbox": NOMINATIM_VIEWBOX,
        "bounded": 1,
    }
    try:
        response = client.get(NOMINATIM_URL, params=params, headers=headers, timeout=30.0)
        response.raise_for_status()
        results = response.json()
        for item in results:
            lng = float(item["lon"])
            lat = float(item["lat"])
            if in_xian_bounds(lng, lat):
                return [lng, lat]
        return None
    except Exception:  # noqa: BLE001
        return None


def resolve_anchor(
    client: httpx.Client, project_name: str, location_text: str
) -> list[float]:
    queries: list[str] = []
    if location_text:
        queries.append(location_text)
    district = parse_district_prefix(location_text)
    if project_name:
        queries.append(f"{district}{project_name}")
        queries.append(f"西安市{project_name}")
    for query in queries:
        location = geocode_nominatim(client, query)
        if location:
            return location
    return district_anchor_fallback(location_text)


def overpass_query(
    query: str, client: httpx.Client, overpass_urls: list[str]
) -> dict[str, Any]:
    headers = {"User-Agent": USER_AGENT}
    last_error: Exception | None = None
    for url in overpass_urls:
        try:
            response = client.post(url, data={"data": query}, headers=headers, timeout=90.0)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"Overpass query failed: {last_error}")


def fetch_road_ways(
    client: httpx.Client, road_name: str, bbox: str, overpass_urls: list[str]
) -> list[dict[str, Any]]:
    query = f'[out:json][timeout:25];way["name"="{road_name}"]({bbox});out geom;'
    payload = overpass_query(query, client, overpass_urls)
    return [element for element in payload.get("elements", []) if element.get("type") == "way"]


def ways_to_geometry(ways: list[dict[str, Any]]) -> LineString | MultiLineString | None:
    lines: list[LineString] = []
    for way in ways:
        coords = [(node["lon"], node["lat"]) for node in way.get("geometry", [])]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    if not lines:
        return None
    union = unary_union(lines)
    if union.is_empty:
        return None
    if isinstance(union, LineString):
        return union
    try:
        merged = linemerge(union)
        if not merged.is_empty:
            return merged
    except ValueError:
        pass
    if isinstance(union, MultiLineString):
        return union
    return lines[0]


def synthetic_boundary_line(anchor: list[float], role: str) -> LineString:
    segment = boundary_line_through_point(anchor, role)
    return LineString(segment)


def positioned_synthetic_line(
    anchor: list[float],
    role: str,
    roads_geom: dict[str, LineString | MultiLineString],
    road_meta: dict[str, Any],
) -> LineString:
    point = Point(anchor)
    lng, lat = anchor
    span = 0.012
    offset = 0.0025

    def nearest_on_real(target_role: str) -> tuple[float, float] | None:
        meta = road_meta.get(target_role, {})
        if meta.get("synthetic") or target_role not in roads_geom:
            return None
        geom = pick_geometry_near_anchor(roads_geom[target_role], anchor)
        nearest = nearest_points(geom, point)[0]
        return nearest.x, nearest.y

    if role == "south":
        north = nearest_on_real("north")
        if north:
            y = north[1] - offset
            return LineString([[lng - span, y], [lng + span, y]])
    elif role == "north":
        south = nearest_on_real("south")
        if south:
            y = south[1] + offset
            return LineString([[lng - span, y], [lng + span, y]])
    elif role == "west":
        east = nearest_on_real("east")
        if east:
            x = east[0] - offset
            return LineString([[x, lat - span], [x, lat + span]])
    elif role == "east":
        west = nearest_on_real("west")
        if west:
            x = west[0] + offset
            return LineString([[x, lat - span], [x, lat + span]])
    return synthetic_boundary_line(anchor, role)


def refine_anchor_from_roads(
    roads_geom: dict[str, LineString | MultiLineString],
    road_meta: dict[str, Any],
    anchor: list[float],
) -> list[float]:
    points: list[list[float]] = []
    anchor_point = Point(anchor)
    for role, geometry in roads_geom.items():
        if road_meta.get(role, {}).get("synthetic"):
            continue
        for part in line_parts(geometry):
            nearest = nearest_points(part, anchor_point)[0]
            points.append([nearest.x, nearest.y])
    if not points:
        return anchor
    lngs = [point[0] for point in points]
    lats = [point[1] for point in points]
    refined = [sum(lngs) / len(lngs), sum(lats) / len(lats)]
    return refined if in_xian_bounds(refined[0], refined[1]) else anchor


def fill_missing_roles(
    bounds: list[tuple[str, str, str]],
    anchor_point: list[float],
    roads_geom: dict[str, LineString | MultiLineString],
    road_meta: dict[str, Any],
) -> None:
    parsed_roles = {role for _, _, role in bounds}
    for role in {"west", "east", "north", "south"} - parsed_roles:
        if role in roads_geom:
            continue
        roads_geom[role] = synthetic_boundary_line(anchor_point, role)
        road_meta[role] = {
            "road": f"inferred-{role}",
            "role": role,
            "way_count": 0,
            "segment_count": 1,
            "length_m": 0.0,
            "synthetic": True,
            "inferred": True,
        }

    for role, meta in list(road_meta.items()):
        if meta.get("synthetic"):
            roads_geom[role] = positioned_synthetic_line(
                anchor_point, role, roads_geom, road_meta
            )


def extend_line(geometry: LineString | MultiLineString, extra_m: float = 2_000) -> LineString | MultiLineString:
    if isinstance(geometry, MultiLineString):
        parts = [extend_line(part, extra_m) for part in geometry.geoms]
        return unary_union(parts)

    coords = list(geometry.coords)
    if len(coords) < 2:
        return geometry

    def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
        lng1, lat1 = map(math.radians, a)
        lng2, lat2 = map(math.radians, b)
        dlng = lng2 - lng1
        y = math.sin(dlng) * math.cos(lat2)
        x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
        return math.atan2(y, x)

    def offset(lng: float, lat: float, angle: float, meters: float) -> tuple[float, float]:
        dlat = (meters * math.cos(angle)) / 111_000
        dlng = (meters * math.sin(angle)) / (111_000 * math.cos(math.radians(lat)))
        return lng + dlng, lat + dlat

    angle_start = bearing(coords[1], coords[0])
    angle_end = bearing(coords[-2], coords[-1])
    start = offset(coords[0][0], coords[0][1], angle_start, extra_m)
    end = offset(coords[-1][0], coords[-1][1], angle_end, extra_m)
    return LineString([start, *coords, end])


def line_parts(geometry: LineString | MultiLineString) -> list[LineString]:
    if isinstance(geometry, MultiLineString):
        return list(geometry.geoms)
    return [geometry]


def pick_geometry_near_anchor(
    geometry: LineString | MultiLineString, anchor: list[float]
) -> LineString:
    point = Point(anchor)
    if isinstance(geometry, LineString):
        return geometry
    best: LineString | None = None
    best_dist = float("inf")
    for part in geometry.geoms:
        dist = part.distance(point)
        if dist < best_dist:
            best_dist = dist
            best = part
    return best or LineString()


def pick_segment_for_corner(
    geometry: LineString | MultiLineString, anchor: list[float], corner_key: str
) -> LineString:
    hint_lng, hint_lat = CORNER_HINTS[corner_key]
    target = Point(anchor[0] + hint_lng * 0.003, anchor[1] + hint_lat * 0.003)
    parts = line_parts(geometry)
    return min(parts, key=lambda part: part.distance(target))


def interior_side_for_role(role: str) -> str:
    return {"west": "east", "east": "west", "north": "south", "south": "north"}[role]


def tangent_and_normal(line: LineString, anchor: list[float]) -> tuple[tuple[float, float], tuple[float, float]]:
    on_line = nearest_points(line, Point(anchor))[0]
    pos = line.project(on_line)
    step = min(0.0004, line.length / 4 or 0.0001)
    p1 = line.interpolate(max(0.0, pos - step))
    p2 = line.interpolate(min(line.length, pos + step))
    tx, ty = p2.x - p1.x, p2.y - p1.y
    length = math.hypot(tx, ty) or 1.0
    tx, ty = tx / length, ty / length
    nx, ny = -ty, tx
    return (tx, ty), (nx, ny)


def half_plane_clip(
    polygon: Polygon,
    line: LineString,
    anchor: list[float],
    interior_side: str,
) -> Polygon:
    anchor_point = Point(anchor)
    on_line = nearest_points(line, anchor_point)[0]
    if interior_side in {"east", "west"}:
        boundary = on_line.x
        keep = (
            (lambda x, y: x >= boundary)
            if interior_side == "east"
            else (lambda x, y: x <= boundary)
        )
    else:
        boundary = on_line.y
        keep = (
            (lambda x, y: y <= boundary)
            if interior_side == "south"
            else (lambda x, y: y >= boundary)
        )

    coords = list(polygon.exterior.coords)
    clipped: list[tuple[float, float]] = []
    for lng, lat in coords[:-1]:
        if keep(lng, lat):
            clipped.append((lng, lat))
    if len(clipped) < 3:
        return polygon
    return Polygon(clipped)


def polygon_from_half_planes(
    roads: dict[str, LineString | MultiLineString],
    anchor: list[float],
    road_meta: dict[str, Any] | None = None,
) -> Polygon | None:
    pad = 0.006
    bounds = (
        anchor[0] - pad,
        anchor[1] - pad,
        anchor[0] + pad,
        anchor[1] + pad,
    )
    polygon = Polygon.from_bounds(*bounds)
    for role, geometry in roads.items():
        line = pick_geometry_near_anchor(geometry, anchor)
        polygon = half_plane_clip(polygon, line, anchor, interior_side_for_role(role))
        if polygon.is_empty:
            return None
    if polygon.geom_type == "MultiPolygon":
        polygon = max(polygon.geoms, key=lambda geom: geom.area)
    return polygon if not polygon.is_empty else None


def corner_point(
    roads: dict[str, LineString | MultiLineString],
    role_a: str,
    role_b: str,
    anchor: list[float],
    corner_key: str,
) -> list[float] | None:
    segment_a = pick_segment_for_corner(roads[role_a], anchor, corner_key)
    segment_b = pick_segment_for_corner(roads[role_b], anchor, corner_key)
    line_a = extend_line(segment_a)
    line_b = extend_line(segment_b)
    intersection = line_a.intersection(line_b)
    if intersection.is_empty:
        return None
    if intersection.geom_type == "Point":
        return [intersection.x, intersection.y]
    if intersection.geom_type == "MultiPoint":
        points = list(intersection.geoms)
    elif intersection.geom_type == "LineString":
        points = [Point(intersection.interpolate(0.5, normalized=True))]
    else:
        return None
    anchor_point = Point(anchor)
    best = min(points, key=lambda point: point.distance(anchor_point))
    return [best.x, best.y]


def bbox_around_point(lng: float, lat: float, margin: float = 0.012) -> str:
    """Overpass bbox: south,west,north,east."""
    return f"{lat - margin},{lng - margin},{lat + margin},{lng + margin}"


def polygon_from_corners(corners: dict[str, list[float]]) -> list[list[float]] | None:
    required = ("sw", "se", "ne", "nw")
    if not all(key in corners for key in required):
        return None
    return [corners["sw"], corners["se"], corners["ne"], corners["nw"], corners["sw"]]


def _anchor_candidates(
    client: httpx.Client,
    project_name: str,
    location_text: str,
    anchor: list[float] | None,
) -> list[list[float]]:
    candidates: list[list[float]] = []
    for point in (
        anchor,
        resolve_anchor(client, project_name, location_text),
        district_anchor_fallback(location_text),
        XIAN_CITY_CENTER,
    ):
        if point and in_xian_bounds(point[0], point[1]):
            if not any(
                abs(point[0] - seen[0]) < 1e-5 and abs(point[1] - seen[1]) < 1e-5
                for seen in candidates
            ):
                candidates.append(point)
    return candidates


def _polygon_from_road_bounds_at_anchor(
    client: httpx.Client,
    bounds: list[tuple[str, str, str]],
    anchor_point: list[float],
    *,
    overpass_urls: list[str],
    road_fetch_delay: float,
    bbox_margin: float,
) -> dict[str, Any] | None:
    # Query roads across metro Xi'an; segment picking happens near the anchor later.
    search_bbox = XIAN_METRO_BBOX
    roads_geom: dict[str, LineString | MultiLineString] = {}
    road_meta: dict[str, Any] = {}
    ways_fetched: dict[str, int] = {}

    for road_name, _direction, role in bounds:
        cleaned = clean_road_name(road_name)
        ways = fetch_road_ways(client, cleaned, search_bbox, overpass_urls)
        ways_fetched[cleaned] = len(ways)
        geometry = ways_to_geometry(ways)
        if geometry is None:
            geometry = positioned_synthetic_line(anchor_point, role, roads_geom, road_meta)
            road_meta[role] = {
                "road": cleaned,
                "role": role,
                "way_count": 0,
                "segment_count": 1,
                "length_m": 0.0,
                "synthetic": True,
            }
        else:
            parts = line_parts(geometry)
            road_meta[role] = {
                "road": cleaned,
                "role": role,
                "way_count": len(ways),
                "segment_count": len(parts),
                "length_m": round(sum(part.length for part in parts) * 111_000, 1),
                "synthetic": False,
            }
        roads_geom[role] = geometry
        if road_fetch_delay > 0:
            time.sleep(road_fetch_delay)

    anchor_point = refine_anchor_from_roads(roads_geom, road_meta, anchor_point)
    fill_missing_roles(bounds, anchor_point, roads_geom, road_meta)

    if len(roads_geom) < 2:
        return None

    corners: dict[str, list[float]] = {}
    for corner_key, role_a, role_b in CORNER_ROLES:
        if role_a not in roads_geom or role_b not in roads_geom:
            continue
        point = corner_point(roads_geom, role_a, role_b, anchor_point, corner_key)
        if point:
            corners[corner_key] = point

    polygon_ring = polygon_from_corners(corners)
    method = "osm_road_corners"
    if polygon_ring is None:
        half_plane = polygon_from_half_planes(roads_geom, anchor_point, road_meta)
        if half_plane is not None:
            polygon_ring = list(half_plane.exterior.coords)
            method = "osm_road_half_planes"

    if polygon_ring is None:
        return None

    centroid = polygon_centroid(polygon_ring)
    if not in_xian_bounds(centroid[0], centroid[1]):
        return None

    real_roads = sum(1 for meta in road_meta.values() if not meta.get("synthetic"))
    if real_roads == 0:
        return None

    return {
        "method": method,
        "anchor": anchor_point,
        "bbox": search_bbox,
        "roads": road_meta,
        "corners": corners,
        "polygon": polygon_ring,
        "ways_fetched": ways_fetched,
        "real_road_count": real_roads,
    }


def polygon_from_road_bounds_osm(
    client: httpx.Client,
    location_text: str,
    project_name: str = "",
    anchor: list[float] | None = None,
    *,
    overpass_urls: list[str] | None = None,
    road_fetch_delay: float = 1.0,
    bbox_margin: float = 0.012,
) -> dict[str, Any] | None:
    bounds = parse_road_bounds(location_text)
    if len(bounds) < 2:
        return None

    urls = overpass_urls or DEFAULT_OVERPASS_URLS
    for anchor_point in _anchor_candidates(client, project_name, location_text, anchor):
        for margin in (bbox_margin, 0.02, 0.035):
            result = _polygon_from_road_bounds_at_anchor(
                client,
                bounds,
                anchor_point,
                overpass_urls=urls,
                road_fetch_delay=road_fetch_delay,
                bbox_margin=margin,
            )
            if result:
                return result
    return None


def geocode_fallback_osm(
    client: httpx.Client, project_name: str, location_text: str
) -> dict[str, Any] | None:
    anchor = resolve_anchor(client, project_name, location_text)
    if not in_xian_bounds(anchor[0], anchor[1]):
        anchor = district_anchor_fallback(location_text)
    return {
        "method": "osm_geocode",
        "anchor": anchor,
        "polygon": buffer_polygon(anchor),
        "center": anchor,
    }
