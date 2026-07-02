"""Shared helpers for Xi'an housing bureau spike scripts."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
RESULTS_DIR = ROOT / "spike_results"

BASE_YGSF = "http://zjj.xa.gov.cn/ygsf"
BASE_XSGS = "https://zjj.xa.gov.cn/xsgs"
BASE_JGGS = "https://zjj.xa.gov.cn/ygsf/jggs"
QDM = "MDA="

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def load_env() -> None:
    load_dotenv(ROOT / ".env")


def crawl_delay() -> float:
    load_env()
    return float(os.getenv("CRAWL_DELAY_SECONDS", "3"))


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
    def __init__(self, delay: float | None = None) -> None:
        self.delay = delay if delay is not None else crawl_delay()
        self.client = httpx.Client(
            headers=DEFAULT_HEADERS,
            timeout=60.0,
            follow_redirects=True,
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "ZjjClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def _sleep(self) -> None:
        if self.delay > 0:
            time.sleep(self.delay)

    def get_html(self, url: str, referer: str | None = None) -> str:
        headers = {"Referer": referer} if referer else None
        self._sleep()
        response = self.client.get(url, headers=headers)
        response.raise_for_status()
        return response.text

    def get_text(self, url: str, referer: str | None = None) -> str:
        headers = {"Referer": referer} if referer else None
        self._sleep()
        response = self.client.get(url, headers=headers)
        response.raise_for_status()
        return response.text.strip()


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def last_page_number(html: str) -> int | None:
    pages = [int(value) for value in re.findall(r"index\.aspx\?page=(\d+)", html)]
    return max(pages) if pages else None


def save_result(filename: str, payload: Any) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / filename
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def parse_room_statuses(html: str) -> dict[str, int]:
    counts: dict[str, int] = {"green": 0, "red": 0, "gray": 0, "other": 0}
    statuses_by_id: dict[str, str] = {}
    pattern = re.compile(
        r"class=['\"]ygsf_fwa\s+(\w+)\s*['\"][^>]*data-id=['\"]([A-F0-9]{32})['\"]",
        flags=re.I,
    )
    for match in pattern.finditer(html):
        status = match.group(1)
        statuses_by_id[match.group(2)] = status

    for status in statuses_by_id.values():
        key = status if status in counts else "other"
        counts[key] += 1
    return counts


def sold_ratio_from_statuses(statuses: dict[str, int]) -> dict[str, float | int]:
    available = statuses.get("green", 0)
    sold = statuses.get("red", 0)
    unsellable = statuses.get("gray", 0)
    total = available + sold + unsellable
    ratio = round(sold / total, 4) if total else 0.0
    return {
        "available_units": available,
        "sold_units": sold,
        "unsellable_units": unsellable,
        "total_units": total,
        "sold_ratio": ratio,
    }


def extract_lzids(html: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"lzid=([A-F0-9]{32})", html, flags=re.I)))


def fetch_room_detail(client: ZjjClient, fwbh: str, referer: str) -> dict[str, str]:
    url = f"{BASE_YGSF}/ashx/GetFwxx.ashx?fwbh={fwbh}&qdm={QDM}"
    raw = client.get_text(url, referer=referer)
    parts = [part.strip() for part in raw.split(",")]
    keys = [
        "room_no",
        "status_code",
        "status_extra",
        "usage",
        "extra",
        "building_area",
        "inner_area",
        "shared_area",
    ]
    data = {keys[index]: parts[index] if index < len(parts) else "" for index in range(len(keys))}
    data["raw"] = raw
    return data
