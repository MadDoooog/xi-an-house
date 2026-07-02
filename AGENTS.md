# AGENTS.md — Xi'an House GIS

Guide for coding agents working in this repository.

## Project summary

Local GIS dashboard for Xi'an housing bureau (ZJJ) presale and current-sale projects. The stack is:

- **Backend**: FastAPI + SQLAlchemy + PostGIS (GeoAlchemy2)
- **Frontend**: React + Vite + MapLibre GL
- **Infra**: Docker Compose (`db`, `api`, `frontend`)

Primary user-facing goal: show community polygons on a map with price/sales metadata, sourced from crawled ZJJ listings and resolved boundaries.

## Architecture

```
ZJJ crawl (presale / current_sale)
        ↓
pipeline.crawl_list_pages / import_spike_seed
        ↓
resolve_boundary()  ← OSM default; optional Amap fallback
        ↓
PostGIS (Community.geom, center) — stored as WGS84 (EPSG:4326 label)
        ↓
GET /api/communities/geojson
        ↓
MapView (MapLibre) — OSM basemap default; Gaode optional toggle
```

## Directory layout

| Path | Purpose |
|------|---------|
| `backend/app/api/` | FastAPI routes |
| `backend/app/crawlers/zjj_client.py` | ZJJ HTML parsers and HTTP client |
| `backend/app/services/boundary.py` | Boundary orchestration (`resolve_boundary`) |
| `backend/app/services/osm_boundary.py` | OSM Overpass road-linestring polygons |
| `backend/app/services/boundary_parse.py` | Shared location-text parsing (四至路名) |
| `backend/app/services/amap_client.py` | Amap Web API client (optional fallback) |
| `backend/app/services/geo.py` | Haversine, line intersection, GCJ-02 ↔ WGS84 |
| `backend/app/services/pipeline.py` | Crawl, seed import, GeoJSON export, re-resolve |
| `frontend/src/components/MapView.tsx` | Map, basemap toggle, community layers |
| `frontend/src/geo.ts` | WGS84 → GCJ-02 transform for Gaode basemap |
| `scripts/spike/` | Feasibility spikes; some logic ported into backend |
| `spike_results/` | Local seed JSON/GeoJSON (gitignored; mounted in Docker) |

## Boundary resolution (critical)

Default provider: **`BOUNDARY_PROVIDER=osm`**.

### Location text patterns

Road-bounded parcels use Chinese cardinal phrases:

- `延兴门西路以东` → west boundary
- `新安路以西` → east boundary
- `西影路以南` → north boundary
- `延兴门一路以北` → south boundary

Parsed by `boundary_parse.parse_road_bounds()`.

### OSM path (`osm_boundary.py`)

1. Geocode anchor within Xi'an (`Nominatim` + `viewbox`, district fallback).
2. Fetch named ways from Overpass across metro Xi'an bbox.
3. Pick road segments per corner; extend lines; intersect → `osm_road_corners`.
4. Missing OSM roads: synthetic boundary lines positioned relative to found roads.
5. Refine anchor from real road geometry before corner math.

`boundary_source` values: `osm_road_corners`, `osm_road_half_planes`, `osm_geocode`.

### Amap path (optional)

Used when `BOUNDARY_PROVIDER=auto` and `AMAP_WEB_KEY` is set. Results are converted GCJ-02 → WGS84 before storage.

### Do not

- Store GCJ-02 without conversion when using OSM as source of truth.
- Use `osm_geocode` (fixed ~340×440 m buffer) when four road bounds are parseable — fix OSM lookup instead.
- Query Overpass with a tiny bbox around district center only; roads may be kilometers away.

## Coordinate systems

- **Database / API GeoJSON**: WGS84
- **OSM tiles**: WGS84 (no transform)
- **Gaode basemap**: GCJ-02 — frontend transforms polygon coordinates in `geo.ts` at display time only

## API endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | Health check |
| GET | `/api/communities/geojson` | Map layer data |
| GET | `/api/communities/{id}` | Detail panel |
| GET | `/api/stats/summary` | Sidebar stats |
| POST | `/api/crawl/trigger?source=presale\|current_sale&max_records=N` | Crawl + boundary resolve |
| POST | `/api/communities/re-resolve-boundaries` | Re-run boundary on all communities |
| GET | `/api/crawl/jobs` | Recent crawl jobs |

## Environment variables

See `.env.example`. Key settings:

- `BOUNDARY_PROVIDER` — `osm` (default), `amap`, or `auto`
- `OVERPASS_URLS` — optional comma-separated Overpass mirrors
- `OSM_ROAD_FETCH_DELAY_SECONDS` — rate limit between road fetches
- `AMAP_WEB_KEY` — optional; required only for Amap fallback
- `CRAWL_MAX_PAGES`, `CRAWL_DELAY_SECONDS` — crawler limits

## Development

```bash
cp .env.example .env
docker compose up --build
# Frontend: http://localhost:5173
# API docs: http://localhost:8000/docs
```

Re-resolve boundaries after changing OSM logic:

```bash
curl -X POST http://localhost:8000/api/communities/re-resolve-boundaries
```

Crawl N presale records:

```bash
curl -X POST "http://localhost:8000/api/crawl/trigger?source=presale&max_records=10"
```

Spike scripts (local venv):

```bash
bash scripts/run_spikes.sh
```

## Browser verification

This project has a web UI. After observable changes, verify once via **Browser DevTools MCP** (not Cursor built-in browser):

1. Open `http://localhost:5173`
2. Confirm polygons render in Xi'an extent on OSM basemap
3. Toggle Gaode basemap and confirm alignment

## Code conventions

- **English** for committed artifacts: code, comments, docstrings, `AGENTS.md`, commit messages.
- **Chinese** only in chat-local explanations to the user.
- Match existing patterns: small focused diffs, reuse `boundary_parse` / `pipeline` abstractions.
- Do not commit `.env`, `spike_results/`, `node_modules/`, or `frontend/dist/`.

## Known limitations (v0.0.1)

- List-page `location_text` parsing is brittle (e.g. `西安银行` for some projects).
- Landmark-style bounds (`东起…西至…`) are not supported; fall back to geocode buffer.
- Some ZJJ road names are absent from OSM (e.g. 雁鸣三路, 花间路) — synthetic edges used.
- Duplicate community names with different permit IDs are stored as separate rows.
- Filing price enrichment and sold-out classification are partial.

## Versioning

Tag releases as `v0.0.x` for early milestones. `v0.0.1` — initial OSM-boundary GIS scaffold with crawl, map UI, and Docker Compose.
