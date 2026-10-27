/* ============================================================
   Scan an already-downloaded mosaic.png (from shadow_probe.mjs)
   with the imagery-only pipeline:

     high-pass → sun vector → shadow evidence → components
              → per-block "how tall are the buildings here" score

   No OSM, no external anchors: everything comes from the pixels.

   node scripts/spike/shadow_scan.mjs --in /tmp/probe7/wanke/mosaic.png \
     --mpp 0.494 [--block 250] [--out /tmp/probe7/wanke/scan]
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodePng, encodePng } from "./png.mjs";
import {
  blockAsymmetry,
  calibrateSunAzimuth,
  filterBySunwardEdge,
  highPass,
  shadowComponents,
  shadowMaskClosing,
  sunVectorHighPass,
} from "./shadow_detect.mjs";

function parseArgs(argv) {
  const out = { in: null, mpp: 0.494, block: 250, out: null, blurM: 40, minAreaM2: 200, ratio: 0.5, refM: 30 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in out)) throw new Error(`unknown flag --${key}`);
    out[key] = key === "in" || key === "out" ? argv[i + 1] : Number(argv[i + 1]);
    i += 1;
  }
  if (!out.in) throw new Error("--in mosaic.png required");
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const { width: W, height: H, rgba } = decodePng(readFileSync(args.in));

  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
  }

  // 1. sun vector from high-passed directional contrast
  const blurPx = Math.max(4, Math.round(args.blurM / args.mpp));
  const hp = highPass(lum, W, H, blurPx);
  const sun = sunVectorHighPass(hp, W, H, args.mpp, { down: 4 });

  // 2. shadow mask: dark vs local sunlit reference
  const { mask, bg, rawRatio } = shadowMaskClosing(lum, W, H, args.mpp, {
    ratio: args.ratio,
    refM: args.refM,
  });

  // 3. keep only shadows that border sunlit ground on the sun side
  const edge = filterBySunwardEdge(mask, lum, bg, W, H, args.mpp, sun.azimuthDeg, {
    minAreaM2: args.minAreaM2,
  });

  // 4. per-block tally: kept shadow area is the "tall buildings here" proxy
  const blockPx = Math.max(32, Math.round(args.block / args.mpp));
  const blocks = [];
  for (let by = 0; by + blockPx <= H; by += blockPx) {
    for (let bx = 0; bx + blockPx <= W; bx += blockPx) {
      let count = 0;
      let area = 0;
      for (const c of edge.kept) {
        if (c.cx < bx || c.cx >= bx + blockPx || c.cy < by || c.cy >= by + blockPx) continue;
        count += 1;
        area += c.areaM2;
      }
      blocks.push({ bx, by, cx: bx + blockPx / 2, cy: by + blockPx / 2, count, area });
    }
  }
  blocks.sort((a, b) => b.area - a.area);

  let keptPx = 0;
  for (let i = 0; i < W * H; i += 1) keptPx += edge.keep[i];

  console.log(
    `image ${W}x${H} @ ${args.mpp} m/px = ${Math.round(W * args.mpp)}x${Math.round(H * args.mpp)} m`,
  );
  console.log('sun    ' + JSON.stringify(sun));
  console.log(
    `raw dark fraction ${(rawRatio * 100).toFixed(1)}%  components ${edge.total}  ` +
      `kept ${edge.kept.length} (${((keptPx / (W * H)) * 100).toFixed(1)}% of pixels)`,
  );
  const byArea = [...edge.kept].sort((a, b) => b.areaM2 - a.areaM2);
  console.log('largest kept shadows:');
  for (const c of byArea.slice(0, 8)) {
    console.log(
      `  area=${String(c.areaM2).padStart(6)} m2  litFrac=${c.litFrac}  at (${c.cx},${c.cy})`,
    );
  }
  console.log(`blocks (${args.block} m cells, ranked by kept shadow area):`);
  for (const b of blocks.slice(0, 6)) {
    console.log(`  block@(${b.bx},${b.by})  comps=${b.count}  area=${b.area} m2`);
  }

  const overlay = new Uint8Array(rgba);
  for (let i = 0; i < W * H; i += 1) {
    if (!edge.keep[i]) continue;
    const o = i * 4;
    overlay[o] = 255;
    overlay[o + 1] = Math.round(overlay[o + 1] * 0.35);
    overlay[o + 2] = Math.round(overlay[o + 2] * 0.35);
  }
  for (const c of byArea.slice(0, 40)) {
    for (let d = -5; d <= 5; d += 1) {
      for (const [x, y] of [
        [c.cx + d, c.cy],
        [c.cx, c.cy + d],
      ]) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = (y * W + x) * 4;
        overlay[o] = 0;
        overlay[o + 1] = 255;
        overlay[o + 2] = 80;
      }
    }
  }

  // 5. self-calibrated azimuth + threshold-free block asymmetry ranking
  const cal = calibrateSunAzimuth(lum, W, H, args.mpp, { blockM: args.block });
  console.log(
    `calibrated sun azimuth ${cal.azimuthDeg} deg (shadow toward ${cal.shadowAzimuthDeg} deg)  ` +
      `sd=${cal.sd}  meanAsym=${cal.meanAsym}`,
  );
  console.log('  azimuth ranking: ' + JSON.stringify(cal.ranking));
  const ba = { blocks: cal.blocks, cols: cal.cols, rows: cal.rows };
  const ranked = [...ba.blocks].sort((a, b) => b.asymmetry - a.asymmetry);
  console.log(`block asymmetry (${args.block} m cells, ${ba.cols}x${ba.rows}):`);
  const grid = [];
  for (let r = 0; r < ba.rows; r += 1) grid.push(new Array(ba.cols).fill('  .  '));
  for (const b of ba.blocks) grid[b.by][b.bx] = String(b.asymmetry.toFixed(2)).padStart(5).padEnd(6);
  for (const row of grid) console.log('  ' + row.join(''));
  console.log('  hottest blocks:');
  for (const b of ranked.slice(0, 5)) {
    console.log(`    (${b.bx},${b.by})  asym=${b.asymmetry}  sun=${b.sunEnergy}  anti=${b.antiEnergy}`);
  }
  console.log('  coldest blocks:');
  for (const b of ranked.slice(-3)) {
    console.log(`    (${b.bx},${b.by})  asym=${b.asymmetry}  sun=${b.sunEnergy}  anti=${b.antiEnergy}`);
  }

  // tint each block by asymmetry for eyeballing
  const hot = new Uint8Array(rgba);
  for (const b of ba.blocks) {
    const t = Math.max(0, Math.min(1, b.asymmetry));
    for (let y = b.y; y < Math.min(H, b.y + b.sizePx); y += 1) {
      for (let x = b.x; x < Math.min(W, b.x + b.sizePx); x += 1) {
        const o = (y * W + x) * 4;
        hot[o] = Math.round(hot[o] * (1 - 0.55 * t) + 255 * 0.55 * t);
        hot[o + 1] = Math.round(hot[o + 1] * (1 - 0.55 * t) + 90 * 0.55 * t);
        hot[o + 2] = Math.round(hot[o + 2] * (1 - 0.55 * t));
      }
    }
  }
  const outDir0 = args.out || join(dirname(args.in), 'scan');
  mkdirSync(outDir0, { recursive: true });
  writeFileSync(join(outDir0, `blocks-${basename(dirname(args.in))}.png`), encodePng(W, H, hot));

  const name = basename(dirname(args.in));
  const outDir = args.out || join(dirname(args.in), 'scan');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `scan-${name}.png`), encodePng(W, H, overlay));
  writeFileSync(
    join(outDir, `scan-${name}.json`),
    JSON.stringify(
      {
        input: args.in,
        mpp: args.mpp,
        sun,
        rawDarkFraction: rawRatio,
        keptFraction: keptPx / (W * H),
        components: edge.comps,
        kept: edge.kept,
        blocks,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${outDir}/scan-${name}.{png,json}`);
}

main();
