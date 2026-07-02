#!/usr/bin/env python3
"""Spike-0: verify Xi'an housing bureau endpoints are reachable from this machine."""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import httpx

from common import RESULTS_DIR, USER_AGENT, save_result

TARGETS = [
    {
        "name": "presale_list",
        "url": "http://zjj.xa.gov.cn/ygsf/index.aspx?page=1",
        "expect": "商品房预售项目公示",
    },
    {
        "name": "current_sale_list",
        "url": "https://zjj.xa.gov.cn/xsgs/index.aspx?page=1",
        "expect": "商品房现售项目公示",
    },
    {
        "name": "price_list",
        "url": "https://zjj.xa.gov.cn/ygsf/jggs/index.aspx?page=1",
        "expect": "商品住房销售价格公示",
    },
    {
        "name": "mohurd_home",
        "url": "https://jzsc.mohurd.gov.cn/home",
        "expect": "建筑市场监管",
    },
]


def check_target(client: httpx.Client, target: dict[str, str]) -> dict[str, object]:
    result: dict[str, object] = {
        "name": target["name"],
        "url": target["url"],
        "ok": False,
    }
    try:
        response = client.get(target["url"], timeout=30.0)
        result["status_code"] = response.status_code
        body = response.text
        result["content_length"] = len(body)
        result["ok"] = response.status_code == 200 and target["expect"] in body
        if not result["ok"]:
            result["error"] = "expected marker not found in response body"
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)
    return result


def main() -> int:
    results = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "targets": [],
    }
    with httpx.Client(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=30.0,
    ) as client:
        for target in TARGETS:
            results["targets"].append(check_target(client, target))

    passed = sum(1 for item in results["targets"] if item["ok"])
    results["summary"] = {
        "passed": passed,
        "total": len(TARGETS),
        "all_ok": passed == len(TARGETS),
    }

    output = save_result("spike_0_ping.json", results)
    print(f"Wrote {output}")
    for item in results["targets"]:
        status = "OK" if item["ok"] else "FAIL"
        print(f"[{status}] {item['name']} -> {item.get('status_code', 'n/a')}")

    return 0 if results["summary"]["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
