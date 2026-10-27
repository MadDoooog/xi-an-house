/* ============================================================
   Render a preview of the block-asymmetry map over real imagery.

   Output is one PNG: the mosaic, tinted per block by cast-shadow
   asymmetry, with the numeric value in every block, a shadow-direction
   arrow and a colour legend. Timings per stage go to stdout.

   node scripts/spike/shadow_render.mjs \
     --in /tmp/probe/x/mosaic.png --mpp 0.494 --block 200 --out /tmp/probe/x
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.mjs";
import { calibrateSunAzimuth } from "./shadow_detect.mjs";

const t0 = performance.now();
const marks = [];
const mark = (label) => {
  marks.push({ label, ms: +(performance.now() - t0).toFixed(1) });
};

/* ---------------- tiny 3x5 font ---------------- */

const FONT = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["000", "000", "000", "000", "010"],
  " ": ["000", "000", "000", "000", "000"],
};

function fillRect(buf, W, H, x0, y0, w, h, rgb, alpha) {
  const [r, g, b] = rgb;
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x += 1) {
      const o = (y * W + x) * 4;
      buf[o] = Math.round(buf[o] * (1 - alpha) + r * alpha);
      buf[o + 1] = Math.round(buf[o + 1] * (1 - alpha) + g * alpha);
      buf[o + 2] = Math.round(buf[o + 2] * (1 - alpha) + b * alpha);
    }
  }
}

function drawText(buf, W, H, text, x0, y0, scale, rgb = [255, 255, 255]) {
  let x = x0;
  const advance = 4 * scale;
  // dark halo first so digits stay readable over bright roofs
  for (const [dx, dy] of [[0, 0]]) {
    for (const ch of text) {
      const glyph = FONT[ch] || FONT[" "];
      for (let gy = 0; gy < 5; gy += 1) {
        for (let gx = 0; gx < 3; gx += 1) {
          if (glyph[gy][gx] !== "1") continue;
          fillRect(buf, W, H, x + gx * scale + dx - 1, y0 + gy * scale + dy - 1, scale + 2, scale + 2, [0, 0, 0], 0.55);
        }
      }
      x += advance;
    }
  }
  x = x0;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[" "];
    for (let gy = 0; gy < 5; gy += 1) {
      for (let gx = 0; gx < 3; gx += 1) {
        if (glyph[gy][gx] !== "1") continue;
        fillRect(buf, W, H, x + gx * scale, y0 + gy * scale, scale, scale, rgb, 0.95);
      }
    }
    x += advance;
  }
}

/* ---------------- downscale ---------------- */

function downscale(rgba, w, h, f) {
  const w2 = Math.floor(w / f);
  const h2 = Math.floor(h / f);
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y += 1) {
    for (let x = 0; x < w2; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy += 1) {
        const row = ((y * f + dy) * w + x * f) * 4;
        for (let dx = 0; dx < f; dx += 1) {
          r += rgba[row + dx * 4];
          g += rgba[row + dx * 4 + 1];
          b += rgba[row + dx * 4 + 2];
        }
      }
      const n = f * f;
      const o = (y * w2 + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { rgba: out, w: w2, h: h2 };
}

/* ---------------- colour scale ---------------- */

const LO = -0.3;
const HI = 0.4;

function colorFor(a) {
  if (a <= 0) {
    const t = Math.min(1, -a / -LO);
    return [
      Math.round(110 * (1 - t) + 60 * t),
      Math.round(120 * (1 - t) + 100 * t),
      Math.round(130 * (1 - t) + 235 * t),
    ];
  }
  const t = Math.min(1, a / HI);
  if (t < 0.5) {
    const u = t / 0.5;
    return [Math.round(110 + (250 - 110) * u), Math.round(120 + (170 - 120) * u), Math.round(130 + (60 - 130) * u)];
  }
  const u = (t - 0.5) / 0.5;
  return [Math.round(250 + (215 - 250) * u), Math.round(170 + (30 - 170) * u), Math.round(60 + (30 - 60) * u)];
}

/* ---------------- main ---------------- */

function parseArgs(argv) {
  const out = { in: null, mpp: 0.494, block: 200, out: null, max: 1400 };
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
  mark("decode png");

  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
  }
  mark(`luminance ${W}x${H}`);

  const cal = calibrateSunAzimuth(lum, W, H, args.mpp, { blockM: args.block });
  mark(`calibrate azimuth (36 candidates x ${cal.blocks.length} blocks)`);

  const blockPx = cal.blocks[0].sizePx;
  const cw = Math.min(W, cal.cols * blockPx);
  const ch = Math.min(H, cal.rows * blockPx);
  const cropped = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y += 1) {
    cropped.set(rgba.subarray(y * W * 4, y * W * 4 + cw * 4), y * cw * 4);
  }
  const f = Math.max(1, Math.ceil(Math.max(cw, ch) / args.max));
  const small = downscale(cropped, cw, ch, f);
  mark(`downscale /${f} -> ${small.w}x${small.h}`);

  const buf = small.rgba;
  const SW = small.w;
  const SH = small.h;
  const blockPxSmall = cal.blocks[0].sizePx / f;

  // block fills + borders
  for (const b of cal.blocks) {
    const x = Math.round(b.x / f);
    const y = Math.round(b.y / f);
    const w = Math.round(blockPxSmall);
    const h = Math.round(blockPxSmall);
    fillRect(buf, SW, SH, x, y, w, h, colorFor(b.asymmetry), 0.34);
    fillRect(buf, SW, SH, x, y, w, 1, [255, 255, 255], 0.35);
    fillRect(buf, SW, SH, x, y + h - 1, w, 1, [255, 255, 255], 0.35);
    fillRect(buf, SW, SH, x, y, 1, h, [255, 255, 255], 0.35);
    fillRect(buf, SW, SH, x + w - 1, y, 1, h, [255, 255, 255], 0.35);
  }
  mark("block fills");

  // per-block values
  const scale = Math.max(2, Math.round(blockPxSmall / 55));
  for (const b of cal.blocks) {
    const text = (b.asymmetry >= 0 ? "+" : "") + b.asymmetry.toFixed(2);
    const tw = text.length * 4 * scale;
    drawText(
      buf,
      SW,
      SH,
      text,
      Math.round(b.x / f) + Math.round((blockPxSmall - tw) / 2),
      Math.round(b.y / f) + Math.round(blockPxSmall / 2) - Math.round(2.5 * scale),
      scale,
    );
  }
  mark("value labels");

  // shadow-direction arrow, top-left
  const shadowAz = cal.shadowAzimuthDeg;
  const rad = (shadowAz * Math.PI) / 180;
  const ax = 90;
  const ay = 90;
  const len = 70;
  const tipX = ax + Math.sin(rad) * len;
  const tipY = ay - Math.cos(rad) * len;
  for (let t = 0; t <= 1; t += 0.002) {
    const x = Math.round(ax + (tipX - ax) * t);
    const y = Math.round(ay + (tipY - ay) * t);
    fillRect(buf, SW, SH, x - 2, y - 2, 5, 5, [0, 0, 0], 0.5);
    fillRect(buf, SW, SH, x - 1, y - 1, 3, 3, [255, 255, 255], 0.95);
  }
  for (let s = -1; s <= 1; s += 1) {
    const a2 = rad + Math.PI * 0.82 + s * 0.42;
    for (let t = 0; t <= 1; t += 0.01) {
      const x = Math.round(tipX + Math.sin(a2) * 22 * t);
      const y = Math.round(tipY - Math.cos(a2) * 22 * t);
      fillRect(buf, SW, SH, x - 1, y - 1, 3, 3, [255, 255, 255], 0.95);
    }
  }
  drawText(buf, SW, SH, `${String(cal.azimuthDeg).padStart(3, "0")}`, 12, 12, 3);
  mark("sun arrow");

  // legend bar, bottom-left
  const legendW = 320;
  const legendH = 14;
  const lx = 12;
  const ly = SH - legendH - 14;
  for (let i = 0; i < legendW; i += 1) {
    const a = LO + (HI - LO) * (i / legendW);
    fillRect(buf, SW, SH, lx + i, ly, 1, legendH, colorFor(a), 0.95);
  }
  // zero tick
  const zeroX = Math.round(lx + legendW * ((0 - LO) / (HI - LO)));
  fillRect(buf, SW, SH, zeroX, ly - 4, 1, legendH + 8, [20, 20, 20], 0.9);
  mark("legend");

  const outDir = args.out || args.in.replace(/\/[^/]+$/, "");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "preview.png");
  writeFileSync(outPath, encodePng(SW, SH, buf));
  mark("encode png");

  const ranked = [...cal.blocks].sort((a, b) => b.asymmetry - a.asymmetry);
  console.log(`mosaic ${W}x${H} @ ${args.mpp} m/px = ${Math.round(W * args.mpp)} x ${Math.round(H * args.mpp)} m`);
  console.log(`sun azimuth ${cal.azimuthDeg} deg  shadow toward ${cal.shadowAzimuthDeg} deg  ` +
    `(sd ${cal.sd}, mean ${cal.meanAsym})`);
  console.log(`blocks ${cal.cols}x${cal.rows} of ${args.block} m  range ${ranked[ranked.length - 1].asymmetry} .. ${ranked[0].asymmetry}`);
  console.log('hottest: ' + ranked.slice(0, 3).map((b) => `(${b.bx},${b.by})=${b.asymmetry}`).join('  '));
  console.log('coldest: ' + ranked.slice(-3).map((b) => `(${b.bx},${b.by})=${b.asymmetry}`).join('  '));
  console.log(`preview -> ${outPath}  (${SW}x${SH})`);
  console.log('timings:');
  let prev = 0;
  for (const m of marks) {
    console.log(`  ${String((m.ms - prev).toFixed(1)).padStart(8)} ms  ${m.label}`);
    prev = m.ms;
  }
  console.log(`  ${String(marks[marks.length - 1].ms.toFixed(1)).padStart(8)} ms  TOTAL`);
}

main();
