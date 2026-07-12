// ── Standing (elevation-view) symbol library ─────────────────────────────────
// The side-view counterpart of the aerial plan's plant symbology (see
// planPainter.ts). Same sketch kit, same ink, so the two views read as one
// artist's hand: colour wash + pencil-hatch overlay + wobbled ink outline, with
// hand-drawn incompleteness (moderate wash alpha, gappy hatch, wobbled edges).
//
// Reference: classic garden-elevation watercolour vignettes — scallop-cloud trees
// on trunks, mounded hatched shrubs, flicked grasses, flower clusters on stems.
//
// CONTRACT (called by the scene painter, verbatim):
//   drawStandingPlant(ctx, { x, baseY, wPx, hPx, seed, foliage, bloom, kind, evergreen })
//   drawFurnitureGlyph(ctx, { x, baseY, wPx, hPx, seed, kind })
// (x, baseY) is the symbol's base centre ON its ground line; the symbol grows UP
// (decreasing y). wPx/hPx are the projected mature width/height — the symbol fits
// inside that box (proportions are the product's core promise; ≤~6% organic
// overshoot only). `seed` drives ALL variation deterministically — zero
// Math.random, so identical args → identical pixels.

import { sketchStroke, sketchEllipse, hatchPattern, sketchRng, tintHex } from './sketch';

type Pt = [number, number];

// ── Contract types ───────────────────────────────────────────────────────────
export interface StandingPlant {
  x: number; baseY: number; wPx: number; hPx: number; seed: number;
  foliage: string; bloom: string | null;
  kind: 'tree' | 'conifer' | 'shrub' | 'grass' | 'perennial' | 'groundcover';
  evergreen?: boolean;
}

export interface FurnitureGlyph {
  x: number; baseY: number; wPx: number; hPx: number; seed: number;
  kind: 'seating' | 'dining' | 'fire' | 'cooking' | 'garden' | 'play';
}

// ── Colour helpers ───────────────────────────────────────────────────────────
const WOOD_INK = '#5a4632';
const CHARCOAL = '#2b2621';
const WOOD = '#8a7256';
const STONE = '#8a8378';
const TAN = '#c8b070';

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Linear blend a→b by t (0..1) → rgb() string. Used for flowering-tree canopy tint.
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${m(ar, br)},${m(ag, bg)},${m(ab, bb)})`;
}
// Darken a foliage colour toward graphite for a colored-pencil ink edge (mirrors
// planPainter's darkenHex(colour, 0.6) idiom, but tolerant of any #hex length).
const edgeOf = (hex: string) => tintHex(hex, 0.58);

// ── Geometry helpers ─────────────────────────────────────────────────────────
function pathFromPts(pts: Pt[]): Path2D {
  const p = new Path2D();
  if (!pts.length) return p;
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
  return p;
}
function bboxOf(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of pts) { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny };
}

// A cloud / scallop blob as a DENSE lobed outline (rx≠ry, seeded asymmetry). One
// point array serves both the fill polygon and the inked scallop edge, so the
// wobble amplitude is uniform (unlike ctx-scaling a circular scallopPath).
function cloudPts(cx: number, cy: number, rx: number, ry: number, seed: number, opts?: { bumps?: number; jitter?: number }): Pt[] {
  const bumps = opts?.bumps ?? Math.max(7, Math.round((rx + ry) / 7));
  const jitter = opts?.jitter ?? 0.14;
  const rng = sketchRng(seed);
  const anchors: Pt[] = [];
  for (let i = 0; i < bumps; i++) {
    const a = (i / bumps) * Math.PI * 2;
    const rf = 0.85 + (rng() * 2 - 1) * jitter;
    anchors.push([cx + Math.cos(a) * rx * rf, cy + Math.sin(a) * ry * rf]);
  }
  const out: Pt[] = [];
  const n = anchors.length, per = 4;
  for (let i = 0; i < n; i++) {
    const A = anchors[i], B = anchors[(i + 1) % n];
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const chord = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const rl = Math.hypot(mx - cx, my - cy) || 1;
    const bulge = chord * 0.5;                     // control pushed radially out → cloud lobe
    const cxp = mx + ((mx - cx) / rl) * bulge, cyp = my + ((my - cy) / rl) * bulge;
    for (let s = 0; s < per; s++) {
      const t = s / per, it = 1 - t;
      out.push([it * it * A[0] + 2 * it * t * cxp + t * t * B[0], it * it * A[1] + 2 * it * t * cyp + t * t * B[1]]);
    }
  }
  return out;
}

// A ground-hugging mound: a scalloped top arc (left ground corner → over → right
// ground corner) plus a flat base on the ground line. Returns {arc, full}: `arc`
// is the domed edge to ink (open), `full` closes the base for the fill.
function moundPts(cx: number, baseY: number, rx: number, ry: number, seed: number, opts?: { lobes?: number; amp?: number }): { arc: Pt[]; full: Pt[] } {
  const rng = sketchRng(seed);
  const lobes = opts?.lobes ?? Math.max(3, Math.round(rx / 9));
  const amp = opts?.amp ?? 0.12;
  const M = Math.max(16, lobes * 4);
  const arc: Pt[] = [];
  for (let i = 0; i <= M; i++) {
    const a = Math.PI * (i / M);                   // PI-arc, x sweeps −rx..+rx
    const bump = Math.sin((i / M) * Math.PI * lobes) * amp;
    const rr = 1 + bump + (rng() * 2 - 1) * 0.03;
    arc.push([cx - rx * Math.cos(a), baseY - ry * Math.sin(a) * rr]);
  }
  const full: Pt[] = [...arc, [cx + rx, baseY], [cx - rx, baseY]];
  return { arc, full };
}

// wash fill of a path at a hand-drawn alpha.
function washFill(ctx: CanvasRenderingContext2D, path: Path2D, color: string, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fill(path); ctx.restore();
}
// pencil-hatch overlay clipped to a path (gaps in the tile leave the wash showing).
function hatchFill(ctx: CanvasRenderingContext2D, path: Path2D, bb: { x: number; y: number; w: number; h: number }, color: string, seed: number, alpha: number) {
  const hp = ctx.createPattern(hatchPattern(color, 'pencil', seed), 'repeat');
  if (!hp) return;
  ctx.save(); ctx.clip(path); ctx.globalAlpha = alpha; ctx.fillStyle = hp; ctx.fillRect(bb.x - 2, bb.y - 2, bb.w + 4, bb.h + 4); ctx.restore();
}
// seeded bloom dot clusters (little rosettes) over a spread — flowering trees/shrubs.
function bloomClusters(ctx: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, spreadX: number, spreadY: number, clusters: number, dotR: number, color: string) {
  ctx.save();
  for (let c = 0; c < clusters; c++) {
    const bx = cx + (rng() * 2 - 1) * spreadX, by = cy + (rng() * 2 - 1) * spreadY;
    const petals = 4 + Math.floor(rng() * 3);
    ctx.globalAlpha = 0.85;
    for (let p = 0; p < petals; p++) {
      const a = (p / petals) * Math.PI * 2 + rng();
      const d = dotR * (0.7 + rng() * 0.5);
      ctx.fillStyle = p % 2 ? tintHex(color, 1.08) : color;
      ctx.beginPath(); ctx.arc(bx + Math.cos(a) * d, by + Math.sin(a) * d, dotR * (0.55 + rng() * 0.3), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 0.95; ctx.fillStyle = tintHex(color, 1.14);
    ctx.beginPath(); ctx.arc(bx, by, dotR * 0.55, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ══ PLANTS ═══════════════════════════════════════════════════════════════════
export function drawStandingPlant(ctx: CanvasRenderingContext2D, p: StandingPlant): void {
  const { x, baseY, wPx, hPx, seed, foliage, bloom, kind } = p;
  if (wPx <= 0 || hPx <= 0) return;
  const rng = sketchRng(seed);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (kind) {
    case 'tree': tree(ctx, x, baseY, wPx, hPx, seed, rng, foliage, bloom); break;
    case 'conifer': conifer(ctx, x, baseY, wPx, hPx, seed, rng, foliage); break;
    case 'shrub': shrub(ctx, x, baseY, wPx, hPx, seed, rng, foliage, bloom); break;
    case 'grass': grass(ctx, x, baseY, wPx, hPx, seed, rng, foliage, bloom); break;
    case 'perennial': perennial(ctx, x, baseY, wPx, hPx, seed, rng, foliage, bloom); break;
    case 'groundcover': groundcover(ctx, x, baseY, wPx, hPx, seed, rng, foliage, bloom); break;
  }
  ctx.restore();
}

// TREE — trunk (two converging strokes + wood wash, ~8% wPx wide, lower ~35% hPx)
// + a scallop-cloud canopy (upper ~70%, seeded asymmetry) with wash + hatch + inked
// edge + interior branch squiggles. Flowering → canopy wash mixed ~35% toward bloom
// + bloom dot clusters.
function tree(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string, bloom: string | null) {
  const trunkW = Math.max(2, wPx * 0.08);
  const trunkTop = baseY - hPx * 0.36;
  const lean = (rng() * 2 - 1) * wPx * 0.03;
  // wood wash slab
  const wood = new Path2D();
  wood.moveTo(x - trunkW / 2, baseY); wood.lineTo(x - trunkW * 0.32 + lean, trunkTop);
  wood.lineTo(x + trunkW * 0.32 + lean, trunkTop); wood.lineTo(x + trunkW / 2, baseY); wood.closePath();
  washFill(ctx, wood, WOOD, 0.5);
  // two slightly-converging inked strokes
  sketchStroke(ctx, [[x - trunkW / 2, baseY], [x - trunkW * 0.32 + lean, trunkTop]], { seed: seed + 1, color: WOOD_INK, width: 1.8, wobble: 1.1, passes: 2, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x + trunkW / 2, baseY], [x + trunkW * 0.32 + lean, trunkTop]], { seed: seed + 2, color: WOOD_INK, width: 1.8, wobble: 1.1, passes: 2, overshoot: 0, alpha: 0.6 });

  // canopy: upper ~70%, centred so its base overlaps the trunk top
  const rx = wPx * 0.47, ry = hPx * 0.36;
  const cx = x + (rng() * 2 - 1) * wPx * 0.05 + lean;   // seeded asymmetry
  const cy = baseY - hPx * 0.64;
  const pts = cloudPts(cx, cy, rx, ry, seed + 5, { jitter: 0.16 });
  const path = pathFromPts(pts), bb = bboxOf(pts);
  const flowering = bloom != null;
  const wash = flowering ? mixHex(foliage, bloom!, 0.35) : foliage;
  washFill(ctx, path, wash, 0.52);
  hatchFill(ctx, path, bb, foliage, seed + 5, 0.4);
  const ink = edgeOf(foliage);
  sketchStroke(ctx, pts, { seed: seed + 6, color: ink, width: 2.3, wobble: 1.6, passes: 2, overshoot: 0, alpha: 0.62, closed: true });
  // 2–3 interior branch squiggles rising from the trunk top into the canopy
  const nb = 2 + Math.round(rng());
  for (let i = 0; i < nb; i++) {
    const a = -Math.PI / 2 + (rng() * 2 - 1) * 1.0;
    const len = ry * (0.9 + rng() * 0.7);
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len * 0.9;
    const bend = (rng() * 2 - 1) * len * 0.2;
    const mx = (x + ex) / 2 - Math.sin(a) * bend, my = (trunkTop + ey) / 2 + Math.cos(a) * bend;
    sketchStroke(ctx, [[x + lean, trunkTop], [mx, my], [ex, ey]], { seed: seed + 20 + i * 7, color: WOOD_INK, width: 1.2, wobble: 0.9, passes: 1, overshoot: 0, alpha: 0.5 });
  }
  if (flowering) bloomClusters(ctx, rng, cx, cy, rx * 0.72, ry * 0.72, 5 + Math.floor(rng() * 4), Math.max(1.6, rx * 0.07), bloom!);
}

// CONIFER — 2–3 stacked scalloped triangles (soft, wobbled), darker evergreen
// tones, tiny trunk stub.
function conifer(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string) {
  const body = tintHex(foliage, 0.82);           // darker evergreen
  const ink = tintHex(foliage, 0.5);
  // trunk stub
  const stubW = Math.max(1.6, wPx * 0.06), stubH = hPx * 0.05;
  const stub = new Path2D(); stub.rect(x - stubW / 2, baseY - stubH, stubW, stubH);
  washFill(ctx, stub, WOOD, 0.55);
  sketchStroke(ctx, [[x - stubW / 2, baseY], [x - stubW / 2, baseY - stubH]], { seed: seed + 1, color: WOOD_INK, width: 1.4, wobble: 0.6, passes: 1, overshoot: 0, alpha: 0.55 });
  sketchStroke(ctx, [[x + stubW / 2, baseY], [x + stubW / 2, baseY - stubH]], { seed: seed + 2, color: WOOD_INK, width: 1.4, wobble: 0.6, passes: 1, overshoot: 0, alpha: 0.55 });

  const N = 3;
  const seg = hPx * 0.26;                          // vertical rise between tier bases
  const tierH = hPx * 0.44;                         // each tier tall enough to overlap the one above
  for (let i = N - 1; i >= 0; i--) {                // draw top-most last so lower tiers sit behind
    const baseYt = baseY - stubH - i * seg;
    const apexY = baseYt - tierH;
    const halfW = (wPx / 2) * (1 - i * 0.28) * 0.98;
    // soft triangle: apex → down right side → scalloped base → up left side
    const M = Math.max(5, Math.round(halfW / 5));
    const pts: Pt[] = [[x + (rng() * 2 - 1) * wPx * 0.02, apexY]];
    pts.push([x + halfW, baseYt]);
    for (let k = 1; k < M; k++) {                   // base with downward scallop lobes
      const t = 1 - k / M;
      const bump = Math.sin((k / M) * Math.PI * Math.max(2, Math.round(halfW / 7))) * tierH * 0.05;
      pts.push([x - halfW + 2 * halfW * t, baseYt + Math.abs(bump)]);
    }
    pts.push([x - halfW, baseYt]);
    const path = pathFromPts(pts), bb = bboxOf(pts);
    washFill(ctx, path, body, 0.55);
    hatchFill(ctx, path, bb, body, seed + 11 + i, 0.36);
    sketchStroke(ctx, pts, { seed: seed + 30 + i * 5, color: ink, width: 2.0, wobble: 1.5, passes: 2, overshoot: 0, alpha: 0.62, closed: true });
  }
}

// SHRUB — mounded scallop dome (wider>taller via wPx/hPx), wash + hatch + inked
// scallop edge. Bloom → dot clusters across the upper surface.
function shrub(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string, bloom: string | null) {
  const rx = wPx * 0.48, ry = hPx * 0.97;
  const { arc, full } = moundPts(x, baseY, rx, ry, seed + 3, { amp: 0.13 });
  const path = pathFromPts(full), bb = bboxOf(full);
  washFill(ctx, path, foliage, 0.52);
  hatchFill(ctx, path, bb, foliage, seed + 3, 0.4);
  sketchStroke(ctx, arc, { seed: seed + 4, color: edgeOf(foliage), width: 1.9, wobble: 1.6, passes: 2, overshoot: 0, alpha: 0.62 });
  // interior radial squiggles (mirrors the aerial shrub interior)
  const strokes = 2 + Math.round(rng());
  for (let i = 0; i < strokes; i++) {
    const a = -Math.PI / 2 + (rng() * 2 - 1) * 1.0;
    const r0 = ry * 0.2, r1 = ry * (0.55 + rng() * 0.3);
    sketchStroke(ctx, [[x + Math.cos(a) * r0 * 0.5, baseY - r0], [x + Math.cos(a) * r1, baseY - r1]], { seed: seed + 40 + i * 6, color: edgeOf(foliage), width: 1.3, wobble: 1, passes: 1, overshoot: 0, alpha: 0.5 });
  }
  if (bloom != null) bloomClusters(ctx, rng, x, baseY - ry * 0.62, rx * 0.7, ry * 0.42, 4 + Math.floor(rng() * 4), Math.max(1.4, rx * 0.08), bloom);
}

// GRASS — a fan of 7–11 flicked arcs rising & arching outward (seeded lean/length)
// + 2–3 taller seed-head strokes with tiny tip dots (tan or bloom colour).
function grass(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string, bloom: string | null) {
  const dark = tintHex(foliage, 0.72);
  const n = 7 + Math.floor(rng() * 5);
  const tuftW = wPx * 0.22;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0.5;
    const bx = x + (t - 0.5) * tuftW;
    const lean = (t - 0.5) * 1.25 + (rng() * 2 - 1) * 0.18;   // splay outward
    const ang = -Math.PI / 2 + lean;
    const len = hPx * (0.6 + rng() * 0.38);
    const ex = bx + Math.cos(ang) * len, ey = baseY + Math.sin(ang) * len;
    const bend = (rng() * 2 - 1) * len * 0.22;
    const mx = (bx + ex) / 2 - Math.sin(ang) * bend, my = (baseY + ey) / 2 + Math.cos(ang) * bend;
    // clamp tip inside the box (≤6% overshoot)
    const cx = Math.max(x - wPx * 0.53, Math.min(x + wPx * 0.53, ex));
    const cy = Math.max(baseY - hPx * 1.05, ey);
    sketchStroke(ctx, [[bx, baseY], [mx, my], [cx, cy]], { seed: seed + i * 13 + 3, color: i % 2 ? dark : foliage, width: 1.5, wobble: 1, passes: 1, overshoot: 0, alpha: 0.72 });
  }
  // taller seed heads with tip dots
  const heads = 2 + Math.floor(rng() * 2);
  const tipColor = bloom ?? TAN;
  for (let i = 0; i < heads; i++) {
    const bx = x + (rng() * 2 - 1) * tuftW * 0.5;
    const ang = -Math.PI / 2 + (rng() * 2 - 1) * 0.35;
    const len = hPx * (0.86 + rng() * 0.12);
    const ex = bx + Math.cos(ang) * len, ey = baseY + Math.sin(ang) * len;
    const bend = (rng() * 2 - 1) * len * 0.12;
    const mx = (bx + ex) / 2 - Math.sin(ang) * bend, my = (baseY + ey) / 2 + Math.cos(ang) * bend;
    sketchStroke(ctx, [[bx, baseY], [mx, my], [ex, ey]], { seed: seed + 60 + i * 9, color: dark, width: 1.6, wobble: 0.9, passes: 1, overshoot: 0, alpha: 0.75 });
    ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = tipColor;
    ctx.beginPath(); ctx.arc(ex, ey, Math.max(1.3, wPx * 0.04), 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

// PERENNIAL — small leafy base mound + 3–6 thin stems rising to bloom clusters
// (coneflower/rudbeckia look). Bloom colour drives the flowers; a soft gold when null.
function perennial(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string, bloom: string | null) {
  // base mound (lower ~32%)
  const rx = wPx * 0.42, ry = hPx * 0.3;
  const { arc, full } = moundPts(x, baseY, rx, ry, seed + 2, { amp: 0.14 });
  const path = pathFromPts(full), bb = bboxOf(full);
  washFill(ctx, path, foliage, 0.5);
  hatchFill(ctx, path, bb, foliage, seed + 2, 0.38);
  sketchStroke(ctx, arc, { seed: seed + 3, color: edgeOf(foliage), width: 1.7, wobble: 1.3, passes: 1, overshoot: 0, alpha: 0.6 });
  // stems to bloom clusters
  const flower = bloom ?? '#D5A23F';
  const nStems = 3 + Math.floor(rng() * 4);
  const stemInk = tintHex(foliage, 0.66);
  for (let i = 0; i < nStems; i++) {
    const t = nStems > 1 ? i / (nStems - 1) : 0.5;
    const bx = x + (t - 0.5) * rx * 1.1;
    const tipX = x + (t - 0.5) * wPx * 0.44 + (rng() * 2 - 1) * wPx * 0.04;
    const tipY = baseY - hPx * (0.72 + rng() * 0.24);
    const midX = (bx + tipX) / 2 + (rng() * 2 - 1) * wPx * 0.05;
    const midY = (baseY - ry * 0.6 + tipY) / 2;
    sketchStroke(ctx, [[bx, baseY - ry * 0.55], [midX, midY], [tipX, tipY]], { seed: seed + 50 + i * 11, color: stemInk, width: 1.2, wobble: 0.7, passes: 1, overshoot: 0, alpha: 0.6 });
    // daisy-ish rosette at the tip
    const petals = 6 + Math.floor(rng() * 3);
    const pr = Math.max(1.5, wPx * 0.06);
    ctx.save(); ctx.globalAlpha = 0.9;
    for (let q = 0; q < petals; q++) {
      const a = (q / petals) * Math.PI * 2 + rng() * 0.4;
      ctx.fillStyle = q % 2 ? tintHex(flower, 1.08) : flower;
      ctx.beginPath(); ctx.arc(tipX + Math.cos(a) * pr, tipY + Math.sin(a) * pr, pr * 0.62, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 0.95; ctx.fillStyle = tintHex(flower, 0.7);   // dark eye
    ctx.beginPath(); ctx.arc(tipX, tipY, pr * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// GROUNDCOVER — a LOW wide scalloped mat hugging the ground (small hPx), wash +
// stipple dots. Bloom → sprinkled tiny bloom dots.
function groundcover(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number, foliage: string, bloom: string | null) {
  const rx = wPx * 0.49, ry = hPx * 0.95;
  const { arc, full } = moundPts(x, baseY, rx, ry, seed + 1, { lobes: Math.max(4, Math.round(rx / 7)), amp: 0.2 });
  const path = pathFromPts(full), bb = bboxOf(full);
  washFill(ctx, path, foliage, 0.46);
  hatchFill(ctx, path, bb, foliage, seed + 1, 0.34);
  sketchStroke(ctx, arc, { seed: seed + 2, color: edgeOf(foliage), width: 1.7, wobble: 1.4, passes: 2, overshoot: 0, alpha: 0.6 });
  // stipple dots
  const stip = tintHex(foliage, 0.72);
  const dots = 6 + Math.floor(rng() * 6);
  ctx.save();
  for (let d = 0; d < dots; d++) {
    const px = x + (rng() * 2 - 1) * rx * 0.9;
    const py = baseY - rng() * ry * 0.85;
    ctx.globalAlpha = 0.7; ctx.fillStyle = stip;
    ctx.beginPath(); ctx.arc(px, py, Math.max(0.9, ry * 0.14), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  if (bloom != null) {
    ctx.save();
    const bd = 5 + Math.floor(rng() * 6);
    for (let d = 0; d < bd; d++) {
      const px = x + (rng() * 2 - 1) * rx * 0.85;
      const py = baseY - (0.25 + rng() * 0.65) * ry;
      ctx.globalAlpha = 0.88; ctx.fillStyle = d % 2 ? tintHex(bloom, 1.08) : bloom;
      ctx.beginPath(); ctx.arc(px, py, Math.max(1, ry * 0.13), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// ══ FURNITURE ═════════════════════════════════════════════════════════════════
// Simple, confident SIDE-VIEW line glyphs: pale-muted washes + ink, low detail —
// the supporting cast. Same ink amplitude as the plants.
export function drawFurnitureGlyph(ctx: CanvasRenderingContext2D, g: FurnitureGlyph): void {
  const { x, baseY, wPx, hPx, seed, kind } = g;
  if (wPx <= 0 || hPx <= 0) return;
  const rng = sketchRng(seed);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (kind) {
    case 'seating': seating(ctx, x, baseY, wPx, hPx, seed); break;
    case 'dining': dining(ctx, x, baseY, wPx, hPx, seed); break;
    case 'fire': fire(ctx, x, baseY, wPx, hPx, seed, rng); break;
    case 'cooking': cooking(ctx, x, baseY, wPx, hPx, seed, rng); break;
    case 'garden': garden(ctx, x, baseY, wPx, hPx, seed, rng); break;
    case 'play': play(ctx, x, baseY, wPx, hPx, seed); break;
  }
  ctx.restore();
}

// An adirondack-ish chair side profile: angled back, seat, armrest, two legs.
// `dir` = +1 faces right (seat opens to +x), −1 faces left.
function adirondack(ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number, h: number, dir: number, seed: number) {
  const seatH = h * 0.42, depth = w;
  const X = (u: number) => cx + dir * u;           // +u = forward (facing direction)
  const backBottom: Pt = [X(-depth * 0.42), baseY];
  const seatRear: Pt = [X(-depth * 0.18), baseY - seatH];
  const backTop: Pt = [X(-depth * 0.5), baseY - h];
  const seatFront: Pt = [X(depth * 0.48), baseY - seatH * 0.72];
  const frontLegB: Pt = [X(depth * 0.4), baseY];
  const armRear: Pt = [X(-depth * 0.28), baseY - h * 0.72];
  const armFront: Pt = [X(depth * 0.46), baseY - h * 0.55];
  // pale wood wash behind back + seat
  const slab = new Path2D();
  slab.moveTo(backTop[0], backTop[1]); slab.lineTo(seatRear[0], seatRear[1]);
  slab.lineTo(seatFront[0], seatFront[1]); slab.lineTo(armFront[0], armFront[1]); slab.closePath();
  washFill(ctx, slab, WOOD, 0.32);
  const S = (a: Pt, b: Pt, k: number, wdt = 1.7) => sketchStroke(ctx, [a, b], { seed: seed + k, color: CHARCOAL, width: wdt, wobble: 0.7, passes: 1, overshoot: 1, alpha: 0.62 });
  S(seatRear, backTop, 1);         // back slat
  S(seatRear, seatFront, 2);       // seat
  S(backBottom, seatRear, 3);      // back leg
  S(frontLegB, seatFront, 4);      // front leg
  S(armRear, armFront, 5);         // armrest
  S(armFront, frontLegB, 6, 1.4);  // arm support
}

// SEATING — two adirondack profiles facing each other.
function seating(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number) {
  const cw = wPx * 0.4;
  adirondack(ctx, x - wPx * 0.24, baseY, cw, hPx, +1, seed + 1);
  adirondack(ctx, x + wPx * 0.24, baseY, cw, hPx, -1, seed + 20);
}

// A simple straight-back chair side profile (for the dining set).
function sideChair(ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number, h: number, dir: number, seed: number) {
  const seatH = h * 0.5, depth = w;
  const X = (u: number) => cx + dir * u;
  const backBot: Pt = [X(-depth * 0.35), baseY];
  const seatRear: Pt = [X(-depth * 0.3), baseY - seatH];
  const backTop: Pt = [X(-depth * 0.32), baseY - h];
  const seatFront: Pt = [X(depth * 0.35), baseY - seatH];
  const frontLeg: Pt = [X(depth * 0.32), baseY];
  const S = (a: Pt, b: Pt, k: number) => sketchStroke(ctx, [a, b], { seed: seed + k, color: CHARCOAL, width: 1.6, wobble: 0.7, passes: 1, overshoot: 1, alpha: 0.62 });
  S(seatRear, backTop, 1); S(seatRear, seatFront, 2); S(backBot, seatRear, 3); S(frontLeg, seatFront, 4);
}

// DINING — table side-view (top slab + two legs) flanked by two chairs.
function dining(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number) {
  const topY = baseY - hPx * 0.5;
  const tw = wPx * 0.46;
  // table top slab
  const slab = new Path2D(); slab.rect(x - tw / 2, topY - hPx * 0.07, tw, hPx * 0.07);
  washFill(ctx, slab, WOOD, 0.36);
  sketchStroke(ctx, [[x - tw / 2, topY], [x + tw / 2, topY]], { seed: seed + 1, color: CHARCOAL, width: 1.9, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  sketchStroke(ctx, [[x - tw / 2, topY - hPx * 0.07], [x + tw / 2, topY - hPx * 0.07]], { seed: seed + 2, color: CHARCOAL, width: 1.4, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.5 });
  // legs
  sketchStroke(ctx, [[x - tw * 0.38, topY], [x - tw * 0.38, baseY]], { seed: seed + 3, color: CHARCOAL, width: 1.7, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x + tw * 0.38, topY], [x + tw * 0.38, baseY]], { seed: seed + 4, color: CHARCOAL, width: 1.7, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  // chairs at either end
  const ch = hPx * 0.72, cw = wPx * 0.22;
  sideChair(ctx, x - wPx * 0.4, baseY, cw, ch, +1, seed + 30);
  sideChair(ctx, x + wPx * 0.4, baseY, cw, ch, -1, seed + 50);
}

// FIRE — a low stone ring (3–4 stacked stone ovals) with 2 small flame strokes.
function fire(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number) {
  const rx = wPx * 0.46, ringY = baseY - hPx * 0.16;
  const stones = 4;
  for (let i = 0; i < stones; i++) {
    const t = i / (stones - 1);
    const sx = x - rx + 2 * rx * t;
    const sy = ringY + Math.sin(t * Math.PI) * hPx * 0.05;      // slight front-arc dip
    const srx = rx * (0.26 + rng() * 0.06), sry = hPx * (0.16 + rng() * 0.05);
    ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = STONE;
    ctx.beginPath(); ctx.ellipse(sx, sy, srx, sry, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    sketchEllipse(ctx, sx, sy, srx, sry, { seed: seed + i * 7 + 1, color: CHARCOAL, width: 1.5, wobble: 0.7, passes: 1, alpha: 0.6 });
  }
  // 2 flame strokes rising from the centre
  const fireC = '#c9663a';
  for (let i = 0; i < 2; i++) {
    const bx = x + (i === 0 ? -1 : 1) * wPx * 0.06;
    const tipY = ringY - hPx * (0.6 + rng() * 0.25);
    const midX = bx + (i === 0 ? 1 : -1) * wPx * 0.05;
    sketchStroke(ctx, [[bx, ringY - hPx * 0.05], [midX, (ringY + tipY) / 2], [x, tipY]], { seed: seed + 40 + i * 5, color: fireC, width: 2, wobble: 1, passes: 1, overshoot: 0, alpha: 0.7 });
  }
}

// COOKING — a kettle-grill silhouette on legs with a lid handle.
function cooking(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, _rng: () => number) {
  const r = Math.min(wPx * 0.36, hPx * 0.42);
  const cy = baseY - hPx * 0.5;                 // kettle centre
  // legs (3, splayed — two visible + centre)
  const legY = cy + r * 0.35;
  sketchStroke(ctx, [[x - r * 0.6, legY], [x - r * 0.85, baseY]], { seed: seed + 1, color: CHARCOAL, width: 1.7, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x + r * 0.6, legY], [x + r * 0.85, baseY]], { seed: seed + 2, color: CHARCOAL, width: 1.7, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x, legY], [x, baseY]], { seed: seed + 3, color: CHARCOAL, width: 1.5, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.5 });
  // kettle bowl (lower half) — wash + inked arc
  const bowl = new Path2D(); bowl.ellipse(x, cy, r, r * 0.85, 0, 0, Math.PI); bowl.closePath();
  washFill(ctx, bowl, '#5a5550', 0.4);
  const bowlPts: Pt[] = [];
  for (let k = 0; k <= 12; k++) { const a = Math.PI * (k / 12); bowlPts.push([x - r * Math.cos(a), cy + r * 0.85 * Math.sin(a)]); }
  sketchStroke(ctx, bowlPts, { seed: seed + 5, color: CHARCOAL, width: 1.9, wobble: 0.7, passes: 1, overshoot: 0, alpha: 0.62 });
  // lid (dome) + line + handle knob
  const lidPts: Pt[] = [];
  for (let k = 0; k <= 12; k++) { const a = Math.PI * (k / 12); lidPts.push([x - r * Math.cos(a), cy - r * 0.62 * Math.sin(a)]); }
  washFill(ctx, pathFromPts([[x - r, cy], ...lidPts, [x + r, cy]]), STONE, 0.34);
  sketchStroke(ctx, lidPts, { seed: seed + 6, color: CHARCOAL, width: 1.9, wobble: 0.7, passes: 1, overshoot: 0, alpha: 0.62 });
  sketchStroke(ctx, [[x - r, cy], [x + r, cy]], { seed: seed + 7, color: CHARCOAL, width: 1.5, wobble: 0.5, passes: 1, overshoot: 1, alpha: 0.55 });
  ctx.save(); ctx.globalAlpha = 0.7; ctx.fillStyle = CHARCOAL;
  ctx.beginPath(); ctx.arc(x, cy - r * 0.62, Math.max(1.4, r * 0.12), 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

// GARDEN — a raised-bed box with tomatoes staked in wire cages.
function garden(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number, rng: () => number) {
  const bw = wPx * 0.8, bh = hPx * 0.55;
  const boxTop = baseY - bh;
  const box = new Path2D(); box.rect(x - bw / 2, boxTop, bw, bh);
  washFill(ctx, box, WOOD, 0.4);
  sketchStroke(ctx, [[x - bw / 2, boxTop], [x + bw / 2, boxTop]], { seed: seed + 1, color: WOOD_INK, width: 1.9, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  sketchStroke(ctx, [[x - bw / 2, boxTop], [x - bw / 2, baseY]], { seed: seed + 2, color: WOOD_INK, width: 1.8, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x + bw / 2, boxTop], [x + bw / 2, baseY]], { seed: seed + 3, color: WOOD_INK, width: 1.8, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.6 });
  sketchStroke(ctx, [[x - bw / 2, baseY], [x + bw / 2, baseY]], { seed: seed + 4, color: WOOD_INK, width: 1.6, wobble: 0.5, passes: 1, overshoot: 1, alpha: 0.5 });
  // plank line
  sketchStroke(ctx, [[x - bw / 2, boxTop + bh * 0.5], [x + bw / 2, boxTop + bh * 0.5]], { seed: seed + 5, color: WOOD_INK, width: 1.2, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.4 });

  // Caged tomato plants rising from the bed.
  const nC = bw > hPx * 1.15 ? 3 : 2;
  const wire = '#8f887b';           // galvanised cage wire
  const leaf = '#5f7d47';           // tomato foliage
  const tomato = '#c14a3a';         // ripe fruit
  for (let i = 0; i < nC; i++) {
    const t = (i + 0.5) / nC;
    const cx = x - bw * 0.38 + bw * 0.76 * t;
    const cageH = hPx * (0.5 + rng() * 0.12);
    const topY = boxTop - cageH;
    const rTop = bw * 0.085, rBot = bw * 0.05;   // cages taper narrower at the base
    const cs = seed + 40 + i * 11;
    // Foliage bushing out through the cage (drawn behind the wire).
    washFill(ctx, pathFromPts(cloudPts(cx, topY + cageH * 0.42, rTop * 1.5, cageH * 0.42, cs + 1, { bumps: 7, jitter: 0.3 })), leaf, 0.5);
    washFill(ctx, pathFromPts(cloudPts(cx, topY + cageH * 0.28, rTop * 1.05, cageH * 0.3, cs + 2, { bumps: 6, jitter: 0.3 })), tintHex(leaf, 0.82), 0.45);
    // Three vertical stakes + three horizontal rings.
    for (const off of [-1, 0, 1]) {
      sketchStroke(ctx, [[cx + off * rTop, topY], [cx + off * rBot, boxTop]], { seed: cs + 10 + off, color: wire, width: 1.3, wobble: 0.4, passes: 1, overshoot: 0, alpha: 0.6 });
    }
    for (const f of [0, 0.42, 0.82]) {
      const yy = topY + cageH * f, rr = rTop + (rBot - rTop) * f;
      sketchEllipse(ctx, cx, yy, rr, rr * 0.32, { seed: cs + 20 + Math.round(yy), color: wire, width: 1.2, wobble: 0.5, passes: 1, alpha: 0.55 });
    }
    // A few ripe tomatoes with a highlight.
    const nTom = 2 + Math.floor(rng() * 2);
    for (let k = 0; k < nTom; k++) {
      const ty = topY + cageH * (0.32 + rng() * 0.5);
      const tx = cx + (rng() * 2 - 1) * rTop * 0.8;
      const tr = Math.max(1.7, bw * 0.026);
      ctx.save(); ctx.globalAlpha = 0.95;
      ctx.fillStyle = tomato; ctx.beginPath(); ctx.arc(tx, ty, tr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tintHex(tomato, 1.28); ctx.beginPath(); ctx.arc(tx - tr * 0.3, ty - tr * 0.3, tr * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}

// PLAY — an A-frame swing profile (two A legs, top bar, hanging seat).
function play(ctx: CanvasRenderingContext2D, x: number, baseY: number, wPx: number, hPx: number, seed: number) {
  const apexY = baseY - hPx * 0.94;
  const barY = baseY - hPx * 0.86;
  const spread = wPx * 0.42;
  // left A
  sketchStroke(ctx, [[x - spread, baseY], [x - wPx * 0.06, apexY]], { seed: seed + 1, color: CHARCOAL, width: 2, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  sketchStroke(ctx, [[x - spread * 0.55, baseY], [x - wPx * 0.02, apexY]], { seed: seed + 2, color: CHARCOAL, width: 2, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  // right A
  sketchStroke(ctx, [[x + spread, baseY], [x + wPx * 0.06, apexY]], { seed: seed + 3, color: CHARCOAL, width: 2, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  sketchStroke(ctx, [[x + spread * 0.55, baseY], [x + wPx * 0.02, apexY]], { seed: seed + 4, color: CHARCOAL, width: 2, wobble: 0.6, passes: 1, overshoot: 1, alpha: 0.62 });
  // top bar
  sketchStroke(ctx, [[x - wPx * 0.1, barY], [x + wPx * 0.1, barY]], { seed: seed + 5, color: CHARCOAL, width: 2, wobble: 0.4, passes: 1, overshoot: 2, alpha: 0.62 });
  // swing seat hung by two lines
  const seatY = baseY - hPx * 0.28, sw = wPx * 0.14;
  sketchStroke(ctx, [[x - sw, barY], [x - sw * 0.7, seatY]], { seed: seed + 6, color: CHARCOAL, width: 1.2, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.55 });
  sketchStroke(ctx, [[x + sw, barY], [x + sw * 0.7, seatY]], { seed: seed + 7, color: CHARCOAL, width: 1.2, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.55 });
  const seatSlab = new Path2D(); seatSlab.rect(x - sw * 0.85, seatY, sw * 1.7, hPx * 0.05);
  washFill(ctx, seatSlab, WOOD, 0.4);
  sketchStroke(ctx, [[x - sw * 0.85, seatY], [x + sw * 0.85, seatY]], { seed: seed + 8, color: CHARCOAL, width: 1.7, wobble: 0.4, passes: 1, overshoot: 1, alpha: 0.6 });
}
