# Shadow probe — can we find large building shadows in satellite imagery?

Feasibility spike for the "road network + shadow patches → residential compound" idea.
Everything here is throwaway tooling (zero npm deps), not wired into `extension/`.

## What it does

```bash
# Amap satellite tiles (GCJ-02 aligned) — the imagery the extension already uses
node scripts/spike/shadow_probe.mjs --source amap --crs gcj02 \
  --lng 108.874458 --lat 34.206903 --radius 220 --zoom 18 --out /tmp/probe/site

# Bing imagery (different capture, often much sharper)
node scripts/spike/shadow_probe.mjs --source bing --crs wgs84 \
  --lng 108.940059 --lat 34.348312 --radius 250 --zoom 18 --out /tmp/probe/site
```

Outputs per run:

| file | meaning |
|------|---------|
| `mosaic.png` | stitched tiles |
| `mask-overlay.png` | red = patches from `extension/app/lib/imagery.js` `analyzeRgba` (the shipped detector) |
| `local-mask.png` | red = shadow patches from `shadow_detect.mjs` (local-contrast), cyan = local bright reference |
| `sun-evidence.png` | red = "x is dark, x + v is bright" at the estimated sun vector |
| `report.json` | all the numbers |

`shadow_detect.mjs` holds three experiments: `detect()` (local-contrast blob finder),
`sunVector()` (threshold-free directional contrast), `shadowEvidence()`.

## Findings (measured, 2026-10)

### 0. Correction from a hand annotation (supersedes §4/§5 below)

A user annotated one building + its shadow on the 锦业路 preview: the sun is ~170° (south,
slightly east), so shadows run ~352° (north, slightly west), shadow length ~200-250 m for a
97 × 39 m footprint. That exposed two bugs and one wrong idea:

* **PCA axis was 90° off compass bearing.** `axisDeg` was reported as the angle from the
  image x-axis, so the "aligned with the shadow axis" filter rejected correct bands and the
  azimuth sweep settled on 240° instead of ~352°.
* **Shadow length range capped at 90 m**, while towers of interest cast 100-300 m.
* **"Dark → bright asymmetry" was the wrong quantity.** A long shadow abuts its own (dark)
  building on the sun side, so the bright reference is not along the sun axis; the metric was
  responding to large building/plaza boundaries instead. On the annotated example the hottest
  block did not contain the annotated building at all.

With the corrected axis and the annotated azimuth, that building's block measures a **252 m**
shadow run — i.e. the length is recoverable. What is still unsolved is *discrimination*: on
this imagery (mosaic median luminance 51, tiles 27..105) large dark areas abut bright ones
everywhere, so per-block "longest run" saturates at the block size (13 of 25 blocks read
200 m+) and a shaded park scores like a tower.

### 1. Shadows are real and large enough

At z18 tiles are 126.4 m wide → **0.494 m/px**. Amap serves z18 as JPEG, z17 as PNG; both
fetch without a key.

### 2. Amap mosaics mix capture dates

Per-tile median luminance inside one 0.5–1 km mosaic: 曲江会展 33..101, 海珀兰轩 45..135,
曲江工地 61..178, 万科翡翠国宾 32..147, 锦业路 CBD 27..105. A 2–5× exposure spread.

### 3. Per-pixel shadow classification does not work on this imagery

| attempt | mask | verdict |
|---|---|---|
| shipped `analyzeRgba` (global Otsu + opening) | 27–110 patches everywhere | flags dark roofs / construction ground; **all-black mosaic scores 0.783** |
| local contrast vs 10 m max-filter | 13–42 % of pixels | still roofs, pitches, water |
| dark/local-reference ratio + sunward lit edge | raw 63–70 % dark, 2–3 components survive | collapses into one blob |
| block "dark→bright asymmetry" (threshold-free) | ranking | not a tallness detector (see §0) |
| directional dark runs + sunward bright strip | 5.7 k runs, saturated | length recoverable but per-block max saturates |

Root cause: within one 0.5 km² scene the luminance spread **between materials** is larger than
between sunlit and shaded versions of the same material, and neighbouring dark vegetation /
asphalt merges with the shadow.

### 4. What to build next

1. Stop ranking by per-block max. Use a bounded statistic: fraction of block area covered by
   runs ≥ 60 m, or a 60th percentile, so the block size cannot saturate it.
2. Disambiguate dark-vs-shadow with structure rather than brightness: the annotated pair was a
   *bright blob and a dark band of the same width (97 m vs 105 m), offset along the sun axis*.
   Width-matched pairing is the relation to implement.
3. Calibrate against ZJJ floor counts, not OSM and not eyeballing:
   `spike_results/spike_2b_price.json` already carries per-building `floors`
   (`{"building_no":"1","floors":"13"}`), so crawl N projects → max floors + geocoded centre →
   correlate with the imagery statistic. OSM has 140 footprints around 万科翡翠国宾 but **0**
   with `building:levels`, so it cannot be the truth source.
4. Keep the road network in the loop: it is what removes the road/asphalt confound, which is
   exactly the user's original framing.

### 5. Sun azimuth

* Whole-image directional contrast is unstable (60° and 130° on two mosaics of one district).
* The azimuth sweep scored by total detected band length is the self-consistent choice, but it
  inherits the 90° bug fixed above; re-validate before trusting it.
* `az` and `az+180` are tied by construction — the sign needs a prior (no midday sun in the
  north at 34.3° N) or ground truth.
* Capture date varies per area, so azimuth and shadow length must be re-fitted per mosaic.

## Suggested pipeline

1. Fetch the z18 mosaic, self-calibrate the shadow azimuth, resolve the sign.
2. Within road-enclosed blocks (OSM roads or the road names already parsed from ZJJ 四至),
   measure directional dark runs with a sunward bright partner of matching width.
3. Convert run length → height once the sun elevation is known from a calibrated reference,
   then rank blocks by the fraction of tall buildings.
4. Reverse-lookup the compound name inside hot blocks (Amap POI).

## Usage

```bash
# 1. download a mosaic
node scripts/spike/shadow_probe.mjs --source amap --crs gcj02 \
  --lng 108.880017 --lat 34.194737 --radius 500 --zoom 18 --out /tmp/probe/cbd

# 2. shadow runs, given a known azimuth (or omit --az to sweep)
node scripts/spike/shadow_runs.mjs --in /tmp/probe/cbd/mosaic.png --mpp 0.494 \
  --block 200 --out /tmp/probe/cbd --az 352

# 3. preview render with the block-asymmetry metric (superseded, kept for comparison)
node scripts/spike/shadow_render.mjs --in /tmp/probe/cbd/mosaic.png --mpp 0.494 --out /tmp/probe/cbd
```

## Caveats

* Bing imagery is much sharper, but its China tiles did not line up with a known landmark under
  either GCJ-02 or WGS84 — calibrate before relying on it.
* Capture date is unknown per tile; a mosaic can contain several dates.
* Commercial imagery terms/attribution still to be checked for anything shipped.
