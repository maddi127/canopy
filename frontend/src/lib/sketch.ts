// ── Sketch kit ───────────────────────────────────────────────────────────────
// Shared hand-drawn primitives for the 2D plan canvases (IllustrativeSite base +
// DiyPlacementPage overlay, and later PlanSnapshot). Everything is DETERMINISTIC:
// seeded from geometry so repeated draws are pixel-identical (no shimmer during
// drags / animations — the codebase never uses Math.random). Patterns are cached
// on an offscreen canvas so per-frame fills stay cheap.

const INK = '#3a3630';

// Derive an rgb() shade of a #rrggbb color (f<1 darker, f>1 lighter), clamped.
// Used to build the two-tone ground textures (grass/mulch) and pebble ink from one base.
export function tintHex(hex: string, f: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// Seeded PRNG (same shape as the callers' local RNGs) → [0,1).
export function sketchRng(seed: number): () => number {
  let s = seed | 0; if (s === 0) s = 0x9e3779b9;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}

// Smooth 1-D value noise: interpolate (smoothstep) between seeded lattice values
// at integer positions → gentle, coherent wobble instead of jagged white noise.
function valueNoise1D(seed: number): (t: number) => number {
  const hash = (i: number) => {
    let h = (i | 0) ^ (seed | 0);
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return (((h ^ (h >>> 14)) >>> 0) / 0xffffffff) * 2 - 1;
  };
  return (t: number) => {
    const i = Math.floor(t), f = t - i;
    const u = f * f * (3 - 2 * f);
    return hash(i) * (1 - u) + hash(i + 1) * u;
  };
}

type Pt = [number, number];

// Resample a polyline to points spaced ~`step` px along its length. If `closed`,
// the closing segment (last→first) is included so the whole loop is even.
function resample(pts: Pt[], step: number, closed: boolean): Pt[] {
  const src = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  if (src.length < 2) return src.slice();
  const out: Pt[] = [src[0]];
  let carry = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const seg = Math.hypot(dx, dy);
    if (seg < 1e-6) continue;
    let d = step - carry;
    while (d < seg) { const t = d / seg; out.push([a[0] + dx * t, a[1] + dy * t]); d += step; }
    carry = seg - (d - step);
  }
  const last = src[src.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.35) out.push(last);
  return out;
}

export interface SketchStrokeOpts {
  seed: number;
  color?: string;
  width?: number;
  wobble?: number;    // px displacement amplitude (default ~1)
  passes?: number;    // overlapping ink passes (default 2)
  overshoot?: number; // px the ends extend past their endpoints (default 3; open paths only)
  alpha?: number;     // per-pass alpha (default 0.6)
  closed?: boolean;   // treat pts as a closed ring
}

// A wobbly ink stroke through px points with pressure (line-width) variation and
// drafting-corner overshoot. Drawn as short segments so width can vary along the path.
export function sketchStroke(ctx: CanvasRenderingContext2D, pts: Pt[], opts: SketchStrokeOpts): void {
  const { seed, color = INK, width = 1.4, wobble = 1, passes = 2, overshoot = 3, alpha = 0.6, closed = false } = opts;
  if (pts.length < 2) return;
  const rs = resample(pts, 6, closed);
  if (rs.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.globalAlpha = alpha;
  for (let p = 0; p < passes; p++) {
    const nx = valueNoise1D(seed + p * 101 + 17);
    const ny = valueNoise1D(seed + p * 211 + 91);
    const nw = valueNoise1D(seed + p * 331 + 53);
    const dp: Pt[] = rs.map((pt, i): Pt => [pt[0] + nx(i * 0.5) * wobble, pt[1] + ny(i * 0.5) * wobble]);
    if (!closed && overshoot > 0 && dp.length >= 2) {
      const ext = (a: Pt, b: Pt): Pt => { const dx = a[0] - b[0], dy = a[1] - b[1], L = Math.hypot(dx, dy) || 1; return [a[0] + dx / L * overshoot, a[1] + dy / L * overshoot]; };
      dp[0] = ext(dp[0], dp[1]);
      dp[dp.length - 1] = ext(dp[dp.length - 1], dp[dp.length - 2]);
    }
    for (let i = 0; i < dp.length - 1; i++) {
      ctx.lineWidth = width * (1 + nw(i * 0.5) * 0.3); // ±30% pressure
      ctx.beginPath(); ctx.moveTo(dp[i][0], dp[i][1]); ctx.lineTo(dp[i + 1][0], dp[i + 1][1]); ctx.stroke();
    }
  }
  ctx.restore();
}

// Closed-shape stroke: same ink treatment, wobbled outline, closed.
export function sketchRing(ctx: CanvasRenderingContext2D, ring: Pt[], opts: SketchStrokeOpts): void {
  sketchStroke(ctx, ring, { overshoot: 0, ...opts, closed: true });
}

// Ellipse as a wobbly closed ring.
export function sketchEllipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, opts: SketchStrokeOpts): void {
  const N = Math.max(10, Math.round((rx + ry) / 6));
  const ring: Pt[] = [];
  for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; ring.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
  sketchRing(ctx, ring, opts);
}

// Cloud / scallop outline: n outward arc bumps (radius jittered ±15%). Returns a
// Path2D so callers can fill THEN stroke (tree canopies, shrub masses).
export function scallopPath(cx: number, cy: number, r: number, opts: { seed: number; bumps?: number }): Path2D {
  const bumps = Math.max(6, opts.bumps ?? Math.round((2 * Math.PI * r) / 6));
  const rng = sketchRng(opts.seed);
  const pts: Pt[] = [];
  for (let i = 0; i < bumps; i++) {
    const a = (i / bumps) * Math.PI * 2;
    const rad = r * (0.85 + (rng() * 2 - 1) * 0.15);
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  const path = new Path2D();
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < bumps; i++) {
    const a = pts[i], b = pts[(i + 1) % bumps];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Control point pushed radially outward from the chord midpoint → arc bulges
    // away from the centre, giving the cloud/scallop lobe.
    const rl = Math.hypot(mx - cx, my - cy) || 1;
    const bulge = chord * 0.55;
    const cxp = mx + ((mx - cx) / rl) * bulge, cyp = my + ((my - cy) / rl) * bulge;
    path.quadraticCurveTo(cxp, cyp, b[0], b[1]);
  }
  path.closePath();
  return path;
}

// Points tracing a SCALLOPED arc from a0→a1 (radians, a1>a0) around (cx,cy) at radius r.
// Outward lobes (~`lobeArc` rad each) bulge to +`amp`·r; deterministic jitter from `seed`.
// Feed to sketchStroke (overshoot 0) to ink a connected plant-mass's exposed edge — the arcs
// that AREN'T buried inside a neighbour circle become little scallop bumps, like the reference.
export function scallopArcPoints(cx: number, cy: number, r: number, a0: number, a1: number, seed: number, opts: { lobeArc?: number; amp?: number } = {}): Pt[] {
  const span = a1 - a0;
  if (span <= 1e-3) return [];
  const lobeArc = opts.lobeArc ?? 0.5;
  const amp = opts.amp ?? 0.13;
  const rng = sketchRng(seed | 0);
  const lobes = Math.max(1, Math.round(span / lobeArc));
  const per = 5;
  const total = lobes * per;
  const pts: Pt[] = [];
  for (let i = 0; i <= total; i++) {
    const a = a0 + span * (i / total);
    const lp = (i % per) / per;                       // 0..1 within a lobe
    const bump = Math.sin(lp * Math.PI) * amp;        // 0 at valleys, peak mid-lobe → outward scallop
    const rad = r * (1 + bump + (rng() * 2 - 1) * 0.02);
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  return pts;
}

// ── Cached fill patterns ───────────────────────────────────────────────────────
const _patCache = new Map<string, HTMLCanvasElement>();
// Tile-safe slopes (finite slope = dy/dx, or 'v' for vertical) — each tiles a
// 64px square seamlessly, so no pattern transform is needed.
const SLOPES: (number | 'v')[] = [0, 'v', 1, -1, 0.5, -0.5, 2, -2];

// Offscreen tile for a directional pencil hatch ('pencil') or soft wash blotches
// ('wash'), in `color`. Transparent background so a base wash shows through the
// gaps. Cached by color+kind+angle bucket. Assign via ctx.createPattern(tile).
export function hatchPattern(color: string, kind: 'pencil' | 'wash' | 'grass' | 'mulch' | 'pebble', angleSeed: number): HTMLCanvasElement {
  const bucket = (angleSeed >>> 0) % SLOPES.length;
  const key = `${kind}|${color}|${bucket}`;
  const cached = _patCache.get(key);
  if (cached) return cached;
  const S = 64;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const c = cv.getContext('2d')!;
  const rng = sketchRng(angleSeed * 0x9e3779b1);
  c.lineCap = 'round';
  // Draw a small mark at (x,y) plus its 8 wrapped copies so it tiles seamlessly.
  const wrap = (x: number, y: number, fn: (x: number, y: number) => void) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(x + dx, y + dy);
  };
  if (kind === 'grass') {
    // Directional pencil flicks in two greens — the lawn/turf "drawn grass" texture. Transparent
    // ground shows through so a base wash reads underneath. Bold enough to change the medium.
    const dark = tintHex(color, 0.66), lite = tintHex(color, 1.14);
    c.lineJoin = 'round';
    for (let i = 0; i < 52; i++) {
      const x = rng() * S, y = rng() * S;
      const ang = -Math.PI / 2 + (rng() * 2 - 1) * 0.6;   // mostly upright, splayed
      const len = 2.5 + rng() * 3.5;
      const bend = (rng() * 2 - 1) * 1.3;
      const two = rng() < 0.5;
      wrap(x, y, (px, py) => {
        c.strokeStyle = two ? dark : lite; c.lineWidth = 1.3; c.globalAlpha = 0.5 + rng() * 0.2;
        const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
        const mx = (px + ex) / 2 - Math.sin(ang) * bend, my = (py + ey) / 2 + Math.cos(ang) * bend;
        c.beginPath(); c.moveTo(px, py); c.quadraticCurveTo(mx, my, ex, ey); c.stroke();
      });
    }
    _patCache.set(key, cv); return cv;
  }
  if (kind === 'mulch') {
    // Short curved dashes in two browns — bark-mulch flecks.
    const dark = tintHex(color, 0.72), lite = tintHex(color, 1.18);
    c.lineJoin = 'round';
    for (let i = 0; i < 34; i++) {
      const x = rng() * S, y = rng() * S;
      const ang = rng() * Math.PI * 2, len = 3 + rng() * 3.5, bend = (rng() * 2 - 1) * 1.6;
      const two = rng() < 0.5;
      wrap(x, y, (px, py) => {
        c.strokeStyle = two ? dark : lite; c.lineWidth = 1.6; c.globalAlpha = 0.42 + rng() * 0.22;
        const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
        const mx = (px + ex) / 2 - Math.sin(ang) * bend, my = (py + ey) / 2 + Math.cos(ang) * bend;
        c.beginPath(); c.moveTo(px, py); c.quadraticCurveTo(mx, my, ex, ey); c.stroke();
      });
    }
    _patCache.set(key, cv); return cv;
  }
  if (kind === 'pebble') {
    // Small outlined circles / ovals — gravel & river-rock, drawn stone-by-stone.
    const ink = tintHex(color, 0.55), fillc = tintHex(color, 1.08);
    for (let i = 0; i < 15; i++) {
      const x = rng() * S, y = rng() * S;
      const rx = 1.8 + rng() * 2.2, ry = rx * (0.7 + rng() * 0.4), rot = rng() * Math.PI;
      wrap(x, y, (px, py) => {
        c.beginPath(); c.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2);
        c.globalAlpha = 0.22; c.fillStyle = fillc; c.fill();
        c.globalAlpha = 0.5; c.strokeStyle = ink; c.lineWidth = 1.2; c.stroke();
      });
    }
    _patCache.set(key, cv); return cv;
  }
  if (kind === 'pencil') {
    const slope = SLOPES[bucket];
    const gap = 8;
    c.strokeStyle = color; c.lineWidth = 1.4;
    const line = (bx: number, by: number, ex: number, ey: number, wav: number, ph: number) => {
      c.globalAlpha = 0.35 + rng() * 0.25; // 35–60%
      c.beginPath();
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = bx + (ex - bx) * t, y = by + (ey - by) * t;
        const off = Math.sin(t * Math.PI * 2 + ph) * wav;
        // wobble perpendicular-ish (nudge y for near-horizontal, x for vertical)
        if (slope === 'v') { if (s === 0) c.moveTo(x + off, y); else c.lineTo(x + off, y); }
        else { if (s === 0) c.moveTo(x, y + off); else c.lineTo(x, y + off); }
      }
      c.stroke();
    };
    if (slope === 'v') {
      for (let x = 0; x <= S; x += gap) line(x, -1, x, S + 1, 0.6, rng() * 6);
    } else {
      const m = slope as number;
      for (let b = -2 * S; b <= 2 * S; b += gap) line(-1, m * -1 + b, S + 1, m * (S + 1) + b, 0.6, rng() * 6);
    }
  } else {
    // Wash: a few soft translucent blotches (wrapped across edges so it tiles).
    const blob = (x: number, y: number, r: number) => {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color); g.addColorStop(1, 'transparent');
      c.globalAlpha = 0.14 + rng() * 0.1; c.fillStyle = g;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    };
    for (let i = 0; i < 5; i++) {
      const x = rng() * S, y = rng() * S, r = S * (0.25 + rng() * 0.25);
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) if (Math.abs(x + dx - S / 2) < S && Math.abs(y + dy - S / 2) < S) blob(x + dx, y + dy, r);
    }
  }
  _patCache.set(key, cv);
  return cv;
}

// ── Graph paper ────────────────────────────────────────────────────────────────
export interface GraphGridOpts {
  origin?: Pt;        // px position of feet (0,0)
  angle?: number;     // radians the feet x-axis is rotated by on screen
  minorFt?: number;   // faint line spacing (default 5)
  majorFt?: number;   // heavier line spacing (default 25)
  ink?: string;       // line color (default sketch ink)
  minorAlpha?: number;
  majorAlpha?: number;
}

// Faint drafting graph grid drawn in FEET space (so it follows the yard's feet
// transform — rotated with the plan, heavier every `majorFt`). Lines are mapped
// through the same origin/scale/angle the callers use for feet→px.
export function graphGrid(ctx: CanvasRenderingContext2D, w: number, h: number, pxPerFt: number, opts: GraphGridOpts = {}): void {
  const { origin = [0, 0], angle = 0, minorFt = 5, majorFt = 25, ink = INK, minorAlpha = 0.06, majorAlpha = 0.1 } = opts;
  if (pxPerFt <= 0) return;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const [ox, oy] = origin;
  const toPx = (fx: number, fy: number): Pt => [ox + (fx * cos - fy * sin) * pxPerFt, oy + (fx * sin + fy * cos) * pxPerFt];
  // Inverse: px → feet, to find the feet bbox covering the canvas.
  const toFt = (px: number, py: number): Pt => { const dx = (px - ox) / pxPerFt, dy = (py - oy) / pxPerFt; return [dx * cos + dy * sin, -dx * sin + dy * cos]; };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]] as Pt[]) {
    const [fx, fy] = toFt(px, py);
    if (fx < minX) minX = fx; if (fx > maxX) maxX = fx; if (fy < minY) minY = fy; if (fy > maxY) maxY = fy;
  }
  ctx.save();
  ctx.lineWidth = 1; ctx.strokeStyle = ink;
  const line = (a: Pt, b: Pt, major: boolean) => {
    ctx.globalAlpha = major ? majorAlpha : minorAlpha;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  };
  const x0 = Math.floor(minX / minorFt) * minorFt, x1 = Math.ceil(maxX / minorFt) * minorFt;
  const y0 = Math.floor(minY / minorFt) * minorFt, y1 = Math.ceil(maxY / minorFt) * minorFt;
  const isMajor = (v: number) => Math.abs(v % majorFt) < 1e-3 || Math.abs(Math.abs(v % majorFt) - majorFt) < 1e-3;
  for (let fx = x0; fx <= x1; fx += minorFt) line(toPx(fx, y0), toPx(fx, y1), isMajor(fx));
  for (let fy = y0; fy <= y1; fy += minorFt) line(toPx(x0, fy), toPx(x1, fy), isMajor(fy));
  ctx.restore();
}
