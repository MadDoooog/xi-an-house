#!/usr/bin/env python3
"""Spike-1: presale project list -> building table -> room status sample."""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from common import (
    BASE_YGSF,
    QDM,
    ZjjClient,
    extract_lzids,
    fetch_room_detail,
    last_page_number,
    parse_room_statuses,
    save_result,
    sold_ratio_from_statuses,
    strip_tags,
)

SAMPLE_PROJECT_NAME = "天瑞瑞璟小区"


def parse_presale_projects(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    projects: list[dict[str, str]] = []

    for row in soup.select("tr"):
        links = row.select("a[href*='Lpb.aspx?yszid=']")
        if not links:
            continue

        href = links[0].get("href", "")
        match = re.search(r"yszid=([A-F0-9]{32})", href, flags=re.I)
        if not match:
            continue

        cells = [strip_tags(cell) for cell in row.select("td")]
        cells = [cell for cell in cells if cell]
        if len(cells) < 4:
            continue

        permit_no = ""
        for cell in cells:
            if re.fullmatch(r"\d{7}", cell):
                permit_no = cell
                break

        name_candidates = [strip_tags(link) for link in links]
        name = next(
            (value for value in name_candidates if not re.fullmatch(r"\d{7}", value)),
            name_candidates[-1],
        )
        location = ""
        developer = ""
        buildings = ""
        published_at = ""

        for cell in cells:
            if cell == name or cell == permit_no:
                continue
            if "幢" in cell and not buildings:
                buildings = cell
            elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", cell):
                published_at = cell
            elif "公司" in cell or "置业" in cell or "开发" in cell:
                developer = cell
            elif "西安" in cell or "区" in cell:
                location = cell

        projects.append(
            {
                "permit_no": permit_no,
                "name": name,
                "location": location,
                "developer": developer,
                "buildings": buildings,
                "published_at": published_at,
                "yszid": match.group(1),
                "detail_url": f"{BASE_YGSF}/Lpb.aspx?yszid={match.group(1)}&qdm={QDM}",
            }
        )

    return projects


def pick_sample_project(projects: list[dict[str, str]], preferred_name: str) -> dict[str, str]:
    for project in projects:
        if preferred_name in project["name"]:
            return project
    if not projects:
        raise RuntimeError("no presale projects parsed from page 1")
    return projects[0]


def main() -> int:
    payload: dict[str, object] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": "ygsf_presale",
        "sample_project_name": SAMPLE_PROJECT_NAME,
    }

    with ZjjClient() as client:
        list_html = client.get_html(f"{BASE_YGSF}/index.aspx?page=1")
        payload["last_page"] = last_page_number(list_html)
        projects = parse_presale_projects(list_html)
        payload["projects_on_page_1"] = len(projects)
        sample = pick_sample_project(projects, SAMPLE_PROJECT_NAME)
        payload["sample_project"] = sample

        detail_html = client.get_html(sample["detail_url"], referer=f"{BASE_YGSF}/index.aspx")
        lzids = extract_lzids(detail_html)
        payload["building_ids"] = lzids
        if not lzids:
            raise RuntimeError(f"no building ids found for project {sample['name']}")

        building_url = (
            f"{BASE_YGSF}/Lpb.aspx?yszid={sample['yszid']}"
            f"&lzid={lzids[0]}&qdm={QDM}"
        )
        building_html = client.get_html(building_url, referer=sample["detail_url"])
        statuses = parse_room_statuses(building_html)
        payload["building_statuses"] = statuses
        payload["building_metrics"] = sold_ratio_from_statuses(statuses)

        room_ids = list(
            dict.fromkeys(
                re.findall(
                    r"class=['\"]ygsf_fwa\s+\w+\s*['\"]\s+data-id=['\"]([A-F0-9]{32})['\"]",
                    building_html,
                    flags=re.I,
                )
            )
        )
        payload["room_ids_found"] = len(room_ids)
        if room_ids:
            payload["sample_room"] = fetch_room_detail(client, room_ids[0], referer=building_url)

    output = save_result("spike_1_presale.json", payload)
    metrics = payload["building_metrics"]
    print(f"Wrote {output}")
    print(
        f"Project={sample['name']} units={metrics['total_units']} "
        f"sold_ratio={metrics['sold_ratio']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"Spike-1 failed: {exc}")
        raise SystemExit(1)
