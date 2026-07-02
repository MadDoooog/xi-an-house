from __future__ import annotations

from typing import Any


def classify_project(project: dict[str, Any], filing_price: float | None = None) -> dict[str, Any]:
    sold_ratio = float(project.get("sold_ratio") or 0.0)
    available_units = int(project.get("available_units") or 0)
    total_units = int(project.get("total_units") or 0)

    if available_units > 0:
        category = "new_home"
        status = "presale_active"
    elif sold_ratio >= 0.99 and total_units > 0:
        category = "sold_out"
        status = "sold_out_pending_delivery"
    else:
        category = "unknown"
        status = "unknown"

    display_price = filing_price
    return {
        "category": category,
        "status": status,
        "display_price": display_price,
    }
