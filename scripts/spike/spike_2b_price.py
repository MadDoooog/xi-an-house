#!/usr/bin/env python3
"""Spike-2b: filing price project list -> building list -> room prices."""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from statistics import mean

from bs4 import BeautifulSoup

from common import BASE_JGGS, ZjjClient, last_page_number, save_result, strip_tags

SAMPLE_PROJECT_NAME = "天瑞瑞璟"


def parse_price_projects(html: str) -> list[dict[str, str | int]]:
    soup = BeautifulSoup(html, "lxml")
    projects: list[dict[str, str | int]] = []

    for link in soup.select("a[onclick*='goherf']"):
        onclick = link.get("onclick", "")
        match = re.search(r"goherf\('([A-F0-9]{32})','(\d+)'\)", onclick, flags=re.I)
        if not match:
            continue

        row = link.find_parent("tr")
        if not row:
            continue

        cells = [strip_tags(cell) for cell in row.select("td")]
        cells = [cell for cell in cells if cell]
        name = strip_tags(link)

        projects.append(
            {
                "name": name,
                "gsbh": match.group(1),
                "type": int(match.group(2)),
                "district": cells[1] if len(cells) > 1 else "",
                "location": cells[2] if len(cells) > 2 else "",
                "developer": cells[3] if len(cells) > 3 else "",
                "building_count": cells[4] if len(cells) > 4 else "",
                "published_at": cells[5] if len(cells) > 5 else "",
                "detail_url": f"{BASE_JGGS}/Lzdetail.aspx?gsbh={match.group(1)}",
            }
        )

    return projects


def parse_buildings(html: str) -> list[dict[str, str | int]]:
    soup = BeautifulSoup(html, "lxml")
    buildings: list[dict[str, str | int]] = []

    for link in soup.select("a[onclick*='goherf']"):
        onclick = link.get("onclick", "")
        match = re.search(
            r"goherf\('([A-F0-9]{32})','(\d+)','([^']+)'\)",
            onclick,
            flags=re.I,
        )
        if not match:
            continue

        row = link.find_parent("tr")
        cells = [strip_tags(cell) for cell in row.select("td")] if row else []
        buildings.append(
            {
                "lzbh": match.group(1),
                "type": int(match.group(2)),
                "building_no": match.group(3),
                "floors": cells[1] if len(cells) > 1 else "",
                "avg_price": cells[2] if len(cells) > 2 else "",
                "decoration": cells[3] if len(cells) > 3 else "",
                "detail_url": (
                    f"{BASE_JGGS}/Fwdetail.aspx?lzbh={match.group(1)}"
                    f"&lzh={match.group(3)}"
                ),
            }
        )

    return buildings


def parse_rooms(html: str) -> list[dict[str, str | float]]:
    soup = BeautifulSoup(html, "lxml")
    rooms: list[dict[str, str | float]] = []

    for row in soup.select("tr"):
        cells = [strip_tags(cell) for cell in row.select("td")]
        if len(cells) < 5:
            continue
        if cells[0] == "房号":
            continue
        if not re.search(r"\d", cells[0]):
            continue

        try:
            rooms.append(
                {
                    "room_no": cells[0],
                    "area": float(cells[1]),
                    "unit_price": float(cells[2]),
                    "total_price": float(cells[3]),
                    "decoration": cells[4],
                }
            )
        except ValueError:
            continue

    return rooms


def pick_sample_project(projects: list[dict[str, str | int]], preferred_name: str) -> dict[str, str | int]:
    for project in projects:
        if preferred_name in str(project["name"]):
            return project
    for project in projects:
        if int(project["type"]) != 0:
            return project
    if not projects:
        raise RuntimeError("no filing-price projects parsed from page 1")
    return projects[0]


def main() -> int:
    payload: dict[str, object] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": "jggs_filing_price",
        "sample_project_name": SAMPLE_PROJECT_NAME,
    }

    with ZjjClient() as client:
        list_html = client.get_html(f"{BASE_JGGS}/index.aspx?page=1")
        payload["last_page"] = last_page_number(list_html)
        projects = parse_price_projects(list_html)
        payload["projects_on_page_1"] = len(projects)
        sample = pick_sample_project(projects, SAMPLE_PROJECT_NAME)
        payload["sample_project"] = sample

        if int(sample["type"]) == 0:
            raise RuntimeError(f"sample project {sample['name']} has no published buildings")

        building_html = client.get_html(
            str(sample["detail_url"]),
            referer=f"{BASE_JGGS}/index.aspx",
        )
        buildings = [item for item in parse_buildings(building_html) if int(item["type"]) == 1]
        payload["buildings"] = buildings
        if not buildings:
            raise RuntimeError(f"no priced buildings found for project {sample['name']}")

        first_building = buildings[0]
        room_html = client.get_html(
            str(first_building["detail_url"]),
            referer=str(sample["detail_url"]),
        )
        rooms = parse_rooms(room_html)
        payload["rooms_on_first_building"] = len(rooms)
        payload["sample_rooms"] = rooms[:5]
        unit_prices = [float(room["unit_price"]) for room in rooms if room.get("unit_price")]
        payload["avg_unit_price"] = round(mean(unit_prices), 2) if unit_prices else None

    output = save_result("spike_2b_price.json", payload)
    print(f"Wrote {output}")
    print(
        f"Project={sample['name']} rooms={payload['rooms_on_first_building']} "
        f"avg_unit_price={payload['avg_unit_price']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"Spike-2b failed: {exc}")
        raise SystemExit(1)
