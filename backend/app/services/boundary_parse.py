from __future__ import annotations

import re
from typing import Any

ROAD_BOUNDARY_PATTERN = re.compile(
    r"((?:[^，,、]+?(?:路|街|大道|巷)))(?P<direction>以东|以西|以南|以北)"
)
DISTRICT_PREFIX_PATTERN = re.compile(r"(西安市[^，,、]+?[市区县])")

FUNCTIONAL_DISTRICT_PREFIXES = (
    "高新区",
    "经开区",
    "浐灞生态区",
    "曲江新区",
    "国际港务区",
    "航天基地",
    "西咸新区",
)

ROLE_BOUNDARY_AXIS = {
    "west": "vertical",
    "east": "vertical",
    "north": "horizontal",
    "south": "horizontal",
}

DIRECTION_TO_ROLE = {
    "以东": "west",
    "以西": "east",
    "以南": "north",
    "以北": "south",
}

CORNER_ROLES = (
    ("sw", "west", "south"),
    ("se", "east", "south"),
    ("ne", "east", "north"),
    ("nw", "west", "north"),
)


def parse_district_prefix(location_text: str) -> str:
    match = DISTRICT_PREFIX_PATTERN.search(location_text)
    return match.group(1) if match else "西安市"


def clean_road_name(road: str) -> str:
    name = road.strip()
    name = re.sub(r"^西安市", "", name)
    for prefix in FUNCTIONAL_DISTRICT_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix) :]
    name = re.sub(r"^[^路街大道巷]+?[市区县]", "", name)
    return name.strip()


def boundary_line_through_point(
    point: list[float], role: str, extend_m: float = 3_000
) -> list[list[float]]:
    lng, lat = point
    lng_delta = extend_m / 85_000
    lat_delta = extend_m / 111_000
    if ROLE_BOUNDARY_AXIS[role] == "vertical":
        return [[lng, lat - lat_delta], [lng, lat + lat_delta]]
    return [[lng - lng_delta, lat], [lng + lng_delta, lat]]


def parse_road_bounds(location_text: str) -> list[tuple[str, str, str]]:
    bounds: list[tuple[str, str, str]] = []
    for match in ROAD_BOUNDARY_PATTERN.finditer(location_text):
        direction = match.group("direction")
        role = DIRECTION_TO_ROLE.get(direction)
        if role:
            bounds.append((clean_road_name(match.group(1)), direction, role))
    return bounds


def has_road_bounds(location_text: str) -> bool:
    return any(token in location_text for token in ("以东", "以西", "以南", "以北"))


def polygon_centroid(polygon: list[list[float]]) -> list[float]:
    ring = polygon[:-1] if polygon and polygon[0] == polygon[-1] else polygon
    lngs = [point[0] for point in ring]
    lats = [point[1] for point in ring]
    return [sum(lngs) / len(lngs), sum(lats) / len(lats)]


def buffer_polygon(center: list[float], delta: float = 0.002) -> list[list[float]]:
    lng, lat = center
    return [
        [lng - delta, lat - delta],
        [lng + delta, lat - delta],
        [lng + delta, lat + delta],
        [lng - delta, lat + delta],
        [lng - delta, lat - delta],
    ]
