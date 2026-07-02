#!/usr/bin/env python3
"""Spike-2: current-sale project list -> detail page -> room status sample."""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from common import (
    BASE_XSGS,
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

SAMPLE_PROJECT_NAME = "源利国际城一期"


def parse_current_sale_projects(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    projects: list[dict[str, str]] = []

    for row in soup.select("tr"):
        link = row.select_one("a[href*='Detail.aspx?xsbh=']")
        if not link:
            continue

        href = link.get("href", "")
        match = re.search(r"xsbh=([A-F0-9]{32})", href, flags=re.I)
        if not match:
            continue

        cells = [strip_tags(cell) for cell in row.select("td")]
        cells = [cell for cell in cells if cell]
        if len(cells) < 4:
            continue

        published_at = cells[0] if re.search(r"\d{4}/\d{2}/\d{2}", cells[0]) else ""
        name = strip_tags(link)
        location = ""
        developer = ""
        buildings = ""

        for cell in cells[1:]:
            if cell == name:
                continue
            if "幢" in cell and not buildings:
                buildings = cell
            elif "公司" in cell or "置业" in cell or "开发" in cell:
                developer = cell
            elif "西安" in cell or "区" in cell:
                location = cell

        projects.append(
            {
                "published_at": published_at,
                "name": name,
                "location": location,
                "developer": developer,
                "buildings": buildings,
                "xsbh": match.group(1),
                "detail_url": f"{BASE_XSGS}/Detail.aspx?xsbh={match.group(1)}&qdm={QDM}",
            }
        )

    return projects


def pick_sample_project(projects: list[dict[str, str]], preferred_name: str) -> dict[str, str]:
    for project in projects:
        if preferred_name in project["name"]:
            return project
    if not projects:
        raise RuntimeError("no current-sale projects parsed from page 1")
    return projects[0]


def main() -> int:
    payload: dict[str, object] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": "xsgs_current_sale",
        "sample_project_name": SAMPLE_PROJECT_NAME,
    }

    with ZjjClient() as client:
        list_html = client.get_html(f"{BASE_XSGS}/index.aspx?page=1")
        payload["last_page"] = last_page_number(list_html)
        projects = parse_current_sale_projects(list_html)
        payload["projects_on_page_1"] = len(projects)
        sample = pick_sample_project(projects, SAMPLE_PROJECT_NAME)
        payload["sample_project"] = sample

        detail_html = client.get_html(sample["detail_url"], referer=f"{BASE_XSGS}/index.aspx")
        lzids = extract_lzids(detail_html)
        payload["building_ids"] = lzids
        if not lzids:
            raise RuntimeError(f"no building ids found for project {sample['name']}")

        building_url = (
            f"{BASE_XSGS.replace('/xsgs', '/ygsf')}/Lpb.aspx"
            f"?yszid={sample['xsbh']}&lzid={lzids[0]}&qdm={QDM}"
        )
        # Current-sale detail pages embed the same building table markup.
        building_html = detail_html
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
            payload["sample_room"] = fetch_room_detail(
                client,
                room_ids[0],
                referer=sample["detail_url"],
            )

    output = save_result("spike_2_current_sale.json", payload)
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
        print(f"Spike-2 failed: {exc}")
        raise SystemExit(1)
