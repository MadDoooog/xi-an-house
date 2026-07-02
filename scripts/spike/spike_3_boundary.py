#!/usr/bin/env python3
"""Spike-3: resolve project location text into GeoJSON polygons."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from common import ROOT, RESULTS_DIR, USER_AGENT, load_env, save_result

sys.path.insert(0, str(ROOT / "backend"))
from app.services.boundary import resolve_boundary  # noqa: E402


def load_spike_samples() -> list[dict[str, str]]:
    samples: list[dict[str, str]] = []
    mapping = {
        "spike_1_presale.json": "presale",
        "spike_2_current_sale.json": "current_sale",
    }
    for filename, sale_type in mapping.items():
        path = RESULTS_DIR / filename
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        project = data.get("sample_project", {})
        if project.get("name") and project.get("location"):
            samples.append(
                {
                    "name": project["name"],
                    "location": project["location"],
                    "developer": project.get("developer", ""),
                    "sale_type": sale_type,
                }
            )

    canonical = [
        {
            "name": "陆港新家园(二期)项目",
            "location": "西安市国际港务区港兴四路以南，奥体大道以西，鼎盛路以东",
            "developer": "西安国际陆港文信置业有限公司",
            "sale_type": "current_sale",
        }
    ]
    existing_names = {item["name"] for item in samples}
    for item in canonical:
        if item["name"] not in existing_names:
            samples.append(item)

    if not samples:
        return [
            {
                "name": "天瑞瑞璟小区",
                "location": "西安市雁塔区延兴门西路以东、新安路以西、西影路以南、延兴门一路以北",
                "developer": "西安中宝瑞置业有限公司",
                "sale_type": "presale",
            },
            {
                "name": "源利国际城一期（处遗项目）",
                "location": "西安市未央区永信路991号",
                "developer": "西安源鑫置业有限公司",
                "sale_type": "current_sale",
            },
            *canonical,
        ]
    return samples


def to_feature_collection(results: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for item in results:
        if not item.get("polygon"):
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "name": item["name"],
                    "sale_type": item["sale_type"],
                    "boundary_source": item["boundary_source"],
                    "confidence": item["confidence"],
                    "location_text": item["location_text"],
                },
                "geometry": {"type": "Polygon", "coordinates": [item["polygon"]]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    load_env()
    key = os.getenv("AMAP_WEB_KEY", "")
    provider = os.getenv("BOUNDARY_PROVIDER", "osm")
    if provider == "amap" and not key:
        print("AMAP_WEB_KEY is missing in .env (required when BOUNDARY_PROVIDER=amap)")
        return 1

    samples = load_spike_samples()
    results: list[dict[str, Any]] = []
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30.0) as client:
        for sample in samples:
            boundary = resolve_boundary(
                client,
                sample["name"],
                sample["location"],
                amap_key=key,
                boundary_provider=provider,
            )
            results.append(
                {
                    "name": sample["name"],
                    "location_text": sample["location"],
                    "sale_type": sample["sale_type"],
                    **boundary,
                }
            )

    payload = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "samples": results,
        "summary": {
            "total": len(results),
            "with_polygon": sum(1 for item in results if item.get("polygon")),
            "sources": sorted(
                {item.get("boundary_source") for item in results if item.get("boundary_source")}
            ),
        },
    }

    json_path = save_result("spike_3_boundary.json", payload)
    geojson_path = RESULTS_DIR / "boundary_sample.geojson"
    geojson_path.write_text(
        json.dumps(to_feature_collection(results), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Wrote {json_path}")
    print(f"Wrote {geojson_path}")
    print(
        f"Resolved {payload['summary']['with_polygon']}/{payload['summary']['total']} polygons "
        f"via {', '.join(payload['summary']['sources']) or 'none'}"
    )
    for item in results:
        center = item.get("center")
        print(
            f"- {item['name']}: source={item.get('boundary_source')} "
            f"confidence={item.get('confidence')} center={center}"
        )
    return 0 if payload["summary"]["with_polygon"] >= 2 else 1


if __name__ == "__main__":
    raise SystemExit(main())
