#!/usr/bin/env python3
"""Spike-3c: build parcel polygon from OSM road linestrings (Overpass API)."""

from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from shapely.geometry import LineString, MultiLineString, Point, Polygon, mapping
from shapely.ops import linemerge, nearest_points, unary_union

from common import RESULTS_DIR, save_result

LOCATION_TEXT = "西安市雁塔区延兴门西路以东、新安路以西、西影路以南、延兴门一路以北"
DISTRICT_BBOX = "34.226,108.995,34.235,109.012"  # south,west,north,east (WGS84)
ANCHOR_WGS84 = [108.997238, 34.227301]  # 保利天瑞 (reference)

ROAD_ROLES: list[tuple[str, str, str]] = [
    ("延兴门西路", "以东", "west"),
    ("新安路", "以西", "east"),
    ("西影路", "以南", "north"),
    ("延兴门一路", "以北", "south"),
]

CORNER_PAIRS = [
    ("sw", "west", "south"),
    ("se", "east", "south"),
    ("ne", "east", "north"),
    ("nw", "west", "north"),
]

# Shift from anchor toward each corner when picking a road segment from a MultiLineString.
CORNER_HINTS: dict[str, tuple[int, int]] = {
    "sw": (-1, -1),
    "se": (1, -1),
    "ne": (1, 1),
    "nw": (-1, 1),
}

OVERPASS_URLS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def overpass_query(query: str, client: httpx.Client) -> dict[str, Any]:
    headers = {"User-Agent": "xi-an-house-spike/1.0 (boundary research)"}
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        try:
            response = client.post(url, data={"data": query}, headers=headers, timeout=90.0)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"Overpass query failed: {last_error}")


def fetch_road_ways(client: httpx.Client, road_name: str) -> list[dict[str, Any]]:
    query = f'[out:json][timeout:25];way["name"="{road_name}"]({DISTRICT_BBOX});out geom;'
    payload = overpass_query(query, client)
    return [element for element in payload.get("elements", []) if element.get("type") == "way"]


def ways_to_geometry(ways: list[dict[str, Any]]) -> LineString | MultiLineString | None:
    lines: list[LineString] = []
    for way in ways:
        coords = [(node["lon"], node["lat"]) for node in way.get("geometry", [])]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    if not lines:
        return None
    merged = linemerge(unary_union(lines))
    if merged.is_empty:
        return None
    return merged


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


def line_parts(geometry: LineString | MultiLineString) -> list[LineString]:
    if isinstance(geometry, MultiLineString):
        return list(geometry.geoms)
    return [geometry]


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
    _, normal = tangent_and_normal(line, anchor)
    anchor_point = Point(anchor)
    on_line = nearest_points(line, anchor_point)[0]
    sign = 1.0 if interior_side in {"east", "north"} else -1.0
    if interior_side in {"east", "west"}:
        axis = "lng"
        boundary = on_line.x
        keep = (
            (lambda x, y: x >= boundary)
            if (interior_side == "east")
            else (lambda x, y: x <= boundary)
        )
    else:
        boundary = on_line.y
        keep = (
            (lambda x, y: y <= boundary)
            if (interior_side == "south")
            else (lambda x, y: y >= boundary)
        )

    coords = list(polygon.exterior.coords)
    clipped: list[tuple[float, float]] = []
    for index, (lng, lat) in enumerate(coords[:-1]):
        if keep(lng, lat):
            clipped.append((lng, lat))
    if len(clipped) < 3:
        return polygon
    return Polygon(clipped)


def polygon_from_half_planes(
    roads: dict[str, LineString | MultiLineString], anchor: list[float]
) -> Polygon | None:
    bounds = (
        anchor[0] - 0.02,
        anchor[1] - 0.02,
        anchor[0] + 0.02,
        anchor[1] + 0.02,
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
    if intersection.geom_type == "MultiPoint":
        points = list(intersection.geoms)
    anchor_point = Point(anchor)
    best = min(points, key=lambda point: point.distance(anchor_point))
    return [best.x, best.y]


def polygon_from_corners(corners: dict[str, list[float]]) -> list[list[float]] | None:
    required = ("sw", "se", "ne", "nw")
    if not all(key in corners for key in required):
        return None
    ring = [corners["sw"], corners["se"], corners["ne"], corners["nw"], corners["sw"]]
    return ring


def ring_to_geojson(polygon: list[list[float]]) -> dict[str, Any]:
    return {"type": "Polygon", "coordinates": [polygon]}


def main() -> int:
    ways_by_road: dict[str, list[dict[str, Any]]] = {}
    with httpx.Client(timeout=90.0) as client:
        for road_name, _direction, _role in ROAD_ROLES:
            ways_by_road[road_name] = fetch_road_ways(client, road_name)
            time.sleep(1)

    roads_geom: dict[str, LineString | MultiLineString] = {}
    road_meta: dict[str, Any] = {}
    for road_name, _direction, role in ROAD_ROLES:
        geometry = ways_to_geometry(ways_by_road.get(road_name, []))
        if geometry is None:
            continue
        roads_geom[role] = geometry
        parts = line_parts(geometry)
        road_meta[role] = {
            "road": road_name,
            "role": role,
            "way_count": len(ways_by_road.get(road_name, [])),
            "segment_count": len(parts),
            "length_m": round(sum(part.length for part in parts) * 111_000, 1),
        }

    corner_segments: dict[str, dict[str, LineString]] = {}
    corners: dict[str, list[float]] = {}
    for corner_key, role_a, role_b in CORNER_PAIRS:
        corner_segments[corner_key] = {
            role_a: pick_segment_for_corner(roads_geom[role_a], ANCHOR_WGS84, corner_key),
            role_b: pick_segment_for_corner(roads_geom[role_b], ANCHOR_WGS84, corner_key),
        }
        point = corner_point(roads_geom, role_a, role_b, ANCHOR_WGS84, corner_key)
        if point:
            corners[corner_key] = point

    polygon_ring = polygon_from_corners(corners)
    method = "road_corners"
    if polygon_ring is None:
        half_plane = polygon_from_half_planes(roads_geom, ANCHOR_WGS84)
        if half_plane is not None:
            polygon_ring = list(half_plane.exterior.coords)
            method = "road_half_planes"

    feature_collection: dict[str, Any] = {"type": "FeatureCollection", "features": []}
    if polygon_ring:
        feature_collection["features"].append(
            {
                "type": "Feature",
                "properties": {
                    "name": "天瑞瑞璟小区 (OSM)",
                    "location_text": LOCATION_TEXT,
                    "boundary_source": method,
                    "crs": "EPSG:4326 (WGS84)",
                },
                "geometry": ring_to_geojson(polygon_ring),
            }
        )

    for role, line in roads_geom.items():
        feature_collection["features"].append(
            {
                "type": "Feature",
                "properties": {"role": role, **road_meta[role], "kind": "road"},
                "geometry": mapping(line),
            }
        )

    for corner_key, segments in corner_segments.items():
        for role, segment in segments.items():
            extended = extend_line(segment)
            feature_collection["features"].append(
                {
                    "type": "Feature",
                    "properties": {
                        "role": role,
                        "corner": corner_key,
                        "kind": "road_extended",
                    },
                    "geometry": mapping(extended),
                }
            )

    payload = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "location_text": LOCATION_TEXT,
        "anchor_wgs84": ANCHOR_WGS84,
        "bbox": DISTRICT_BBOX,
        "method": method,
        "corners": corners,
        "road_meta": road_meta,
        "corner_segments": {
            corner: {role: list(segment.coords) for role, segment in segments.items()}
            for corner, segments in corner_segments.items()
        },
        "polygon": polygon_ring,
        "ways_fetched": {name: len(items) for name, items in ways_by_road.items()},
    }

    json_path = save_result("spike_3c_osm_boundary.json", payload)
    geojson_path = RESULTS_DIR / "osm_boundary_sample.geojson"
    geojson_path.write_text(json.dumps(feature_collection, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {json_path}")
    print(f"Wrote {geojson_path}")
    print(f"Method: {method}")
    if polygon_ring:
        lngs = [point[0] for point in polygon_ring[:-1]]
        lats = [point[1] for point in polygon_ring[:-1]]
        print(
            f"Polygon ~{(max(lngs)-min(lngs))*85000:.0f}m x "
            f"{(max(lats)-min(lats))*111000:.0f}m, corners={list(corners.keys())}"
        )
        for key, value in corners.items():
            print(f"  {key}: {value}")
    else:
        print("Polygon generation failed")
    return 0 if polygon_ring else 1


if __name__ == "__main__":
    raise SystemExit(main())
