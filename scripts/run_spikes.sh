#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt

cd scripts/spike

python spike_0_ping.py
python spike_1_presale.py
python spike_2_current_sale.py
python spike_2b_price.py
python spike_3_boundary.py
python spike_3c_osm_boundary.py

echo "All spike scripts completed. See spike_results/ for outputs."
