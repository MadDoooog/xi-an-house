"""HTTP client and parsers for Xi'an housing bureau sites."""

from __future__ import annotations

import re
import time
from typing import Any

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag

BASE_YGSF = "http://zjj.xa.gov.cn/ygsf"
BASE_XSGS = "https://zjj.xa.gov.cn/xsgs"
BASE_JGGS = "https://zjj.xa.gov.cn/ygsf/jggs"
QDM = "MDA="

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def strip_tags(node: Tag | NavigableString | None) -> str:
    if node is None:
        return ""
    if isinstance(node, NavigableString):
        return clean_text(str(node))
    return clean_text(node.get_text(" ", strip=True))


class ZjjClient:
    def __init__(self, delay: float = 3.0) -> None:
        self.delay = delay
        self.client = httpx.Client(
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
            timeout=60.0,
            follow_redirects=True,
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "ZjjClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def get_html(self, url: str, referer: str | None = None) -> str:
        if self.delay > 0:
            time.sleep(self.delay)
        headers = {"Referer": referer} if referer else None
        response = self.client.get(url, headers=headers)
        response.raise_for_status()
        return response.text

    def get_text(self, url: str, referer: str | None = None) -> str:
        if self.delay > 0:
            time.sleep(self.delay)
        headers = {"Referer": referer} if referer else None
        response = self.client.get(url, headers=headers)
        response.raise_for_status()
        return response.text.strip()


def last_page_number(html: str) -> int:
    pages = [int(value) for value in re.findall(r"index\.aspx\?page=(\d+)", html)]
    return max(pages) if pages else 1


def parse_room_statuses(html: str) -> dict[str, int]:
    counts: dict[str, int] = {"green": 0, "red": 0, "gray": 0, "other": 0}
    statuses_by_id: dict[str, str] = {}
    pattern = re.compile(
        r"class=['\"]ygsf_fwa\s+(\w+)\s*['\"][^>]*data-id=['\"]([A-F0-9]{32})['\"]",
        flags=re.I,
    )
    for match in pattern.finditer(html):
        statuses_by_id[match.group(2)] = match.group(1)
    for status in statuses_by_id.values():
        key = status if status in counts else "other"
        counts[key] += 1
    return counts


def sold_metrics(statuses: dict[str, int]) -> dict[str, float | int]:
    available = statuses.get("green", 0)
    sold = statuses.get("red", 0)
    unsellable = statuses.get("gray", 0)
    total = available + sold + unsellable
    return {
        "available_units": available,
        "sold_units": sold,
        "unsellable_units": unsellable,
        "total_units": total,
        "sold_ratio": round(sold / total, 4) if total else 0.0,
    }


def extract_lzids(html: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"lzid=([A-F0-9]{32})", html, flags=re.I)))


def parse_presale_projects(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    projects: list[dict[str, Any]] = []
    for row in soup.select("tr"):
        links = row.select("a[href*='Lpb.aspx?yszid=']")
        if not links:
            continue
        match = re.search(r"yszid=([A-F0-9]{32})", links[0].get("href", ""), flags=re.I)
        if not match:
            continue
        cells = [strip_tags(cell) for cell in row.select("td")]
        cells = [cell for cell in cells if cell]
        permit_no = next((cell for cell in cells if re.fullmatch(r"\d{7}", cell)), "")
        name_candidates = [strip_tags(link) for link in links]
        name = next(
            (value for value in name_candidates if not re.fullmatch(r"\d{7}", value)),
            name_candidates[-1],
        )
        location = developer = buildings = published_at = ""
        for cell in cells:
            if cell in {name, permit_no}:
                continue
            if "幢" in cell and not buildings:
                buildings = cell
            elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", cell):
                published_at = cell
            elif "公司" in cell or "置业" in cell or "开发" in cell:
                developer = cell
            elif "西安" in cell or "区" in cell:
                location = cell
        district = ""
        district_match = re.search(r"西安市([^市区县]+[市区县])", location)
        if district_match:
            district = district_match.group(1)
        projects.append(
            {
                "external_id": match.group(1),
                "permit_no": permit_no,
                "name": name,
                "location_text": location,
                "district": district,
                "developer": developer,
                "buildings": buildings,
                "published_at": published_at,
                "sale_type": "presale",
                "detail_url": f"{BASE_YGSF}/Lpb.aspx?yszid={match.group(1)}&qdm={QDM}",
            }
        )
    return projects


def parse_current_sale_projects(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    projects: list[dict[str, Any]] = []
    for row in soup.select("tr"):
        link = row.select_one("a[href*='Detail.aspx?xsbh=']")
        if not link:
            continue
        match = re.search(r"xsbh=([A-F0-9]{32})", link.get("href", ""), flags=re.I)
        if not match:
            continue
        cells = [strip_tags(cell) for cell in row.select("td")]
        cells = [cell for cell in cells if cell]
        published_at = cells[0] if cells and re.search(r"\d{4}/\d{2}/\d{2}", cells[0]) else ""
        name = strip_tags(link)
        location = developer = buildings = ""
        for cell in cells[1:]:
            if cell == name:
                continue
            if "幢" in cell and not buildings:
                buildings = cell
            elif "公司" in cell or "置业" in cell or "开发" in cell:
                developer = cell
            elif "西安" in cell or "区" in cell:
                location = cell
        district_match = re.search(r"西安市([^市区县]+[市区县])", location)
        projects.append(
            {
                "external_id": match.group(1),
                "name": name,
                "location_text": location,
                "district": district_match.group(1) if district_match else "",
                "developer": developer,
                "buildings": buildings,
                "published_at": published_at,
                "sale_type": "current_sale",
                "detail_url": f"{BASE_XSGS}/Detail.aspx?xsbh={match.group(1)}&qdm={QDM}",
            }
        )
    return projects


def enrich_project_metrics(client: ZjjClient, project: dict[str, Any]) -> dict[str, Any]:
    detail_html = client.get_html(project["detail_url"], referer=project["detail_url"])
    if project["sale_type"] == "presale":
        lzids = extract_lzids(detail_html)
        if not lzids:
            return {**project, **sold_metrics(parse_room_statuses(detail_html))}
        building_url = (
            f"{BASE_YGSF}/Lpb.aspx?yszid={project['external_id']}"
            f"&lzid={lzids[0]}&qdm={QDM}"
        )
        building_html = client.get_html(building_url, referer=project["detail_url"])
        return {**project, **sold_metrics(parse_room_statuses(building_html))}
    return {**project, **sold_metrics(parse_room_statuses(detail_html))}
