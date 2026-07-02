# Xi'an House GIS

Local GIS dashboard for Xi'an presale/current-sale housing data.

## Quick start

```bash
cp .env.example .env
# Optional: set AMAP_WEB_KEY for Amap fallback (BOUNDARY_PROVIDER=auto)

docker compose up --build
```

Open:

- Frontend: http://localhost:5173 (default basemap: OpenStreetMap; toggle to Gaode in the map control)
- API docs: http://localhost:8000/docs

On first startup the API imports seed data from `spike_results/` if the database is empty.
Community boundaries are resolved via OSM by default (`BOUNDARY_PROVIDER=osm`).

## Development

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://xian:xian@localhost:5432/xian_house
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Crawl trigger

```bash
curl -X POST "http://localhost:8000/api/crawl/trigger?source=presale"
```

`CRAWL_MAX_PAGES` in `.env` limits pages per run (default `2`).

## Data sources

- Presale: https://zjj.xa.gov.cn/ygsf/index.aspx
- Current sale: https://zjj.xa.gov.cn/xsgs/index.aspx
- Filing price: https://zjj.xa.gov.cn/ygsf/jggs/index.aspx
- Road boundaries: OpenStreetMap via Overpass API (WGS84)
- Optional fallback / Gaode basemap: Amap Web API (GCJ-02, converted to WGS84 for storage)

## Spike scripts

Legacy feasibility scripts remain in `scripts/spike/`.

```bash
bash scripts/run_spikes.sh
```
