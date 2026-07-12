// ── Plan painter ─────────────────────────────────────────────────────────────
// Higher-level colored-pencil drafting painters shared by the plan canvases:
//   • the editor (DiyPlacementPage / /diy/auto-layout)
//   • the read-only PlanSnapshot on /diy/plan-ready
//   • the read-only ReviewPlan on /diy/review
// Everything here is PURE (no React, no page imports) and parameterised by a
// feet→px `ftToPx` function OR by already-projected px rings, so any canvas with
// an affine can paint the same look. Determinism is seeded from geometry so the
// three surfaces render pixel-identically for the same plan (no shimmer). All
// amplitude / tuning numbers live HERE — the callers share them rather than copy.
import { sketchStroke, sketchEllipse, scallopPath, scallopArcPoints, hatchPattern, tintHex } from './sketch';

type Pt = [number, number];
export type FtToPx = (x: number, y: number) => Pt;

// Seeded PRNG — IDENTICAL to the editor's original `seededRng` (NOT sketch.ts's
// `sketchRng`, which zero-guards the seed). Kept bit-for-bit so extracted painting
// stays pixel-identical to the pre-refactor editor.
export function planRng(seed: number): () => number {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}

// Darken a #rrggbb toward graphite for a colored-pencil ink edge.
export function darkenHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// ── Material textures ──────────────────────────────────────────────────────────
// Procedural fills so each feature reads as its real surface. Rendered once into a
// tiling 128px canvas and reused as a repeating pattern. Texture key → base color:
const TEX_BASE: Record<string, string> = {
  grass: '#8aa663', mulch: '#6f4f37', soil: '#5d4a36', gravel: '#b3aa98', rock: '#9b9a8c',
  water: '#6f97ab', pavers: '#b7ac9a', concrete: '#c4c0b7', flagstone: '#a8a197', brick: '#9e5e48',
};

function paintMaterialTile(c: CanvasRenderingContext2D, S: number, tex: string, seed: number) {
  const rr = planRng(seed); const R = () => rr();
  c.fillStyle = TEX_BASE[tex] || '#c9c4b8'; c.fillRect(0, 0, S, S);
  const area = S * S;
  c.lineCap = 'round';
  const hatch = (slope: number, d: number, color: string, lw: number, jit: number) => {
    c.strokeStyle = color; c.lineWidth = lw;
    for (let b = -S; b <= 2 * S; b += d) {
      c.beginPath();
      c.moveTo(0, b + (R() * 2 - 1) * jit);
      c.lineTo(S, b + slope * S + (R() * 2 - 1) * jit);
      c.stroke();
    }
  };
  if (tex === 'grass') {
    hatch(1, 8, 'rgba(92,120,68,0.34)', 1.2, 1.3);
    hatch(-1, 15, 'rgba(78,104,56,0.2)', 1, 1.6);
    c.strokeStyle = 'rgba(70,96,50,0.4)'; c.lineWidth = 1;
    for (let i = 0; i < 55; i++) { const x = R() * S, y = R() * S; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (R() * 2 - 1) * 1.2, y - 2 - R() * 3); c.stroke(); }
  } else if (tex === 'mulch' || tex === 'soil') {
    const dark = tex === 'soil' ? 'rgba(66,50,34,0.44)' : 'rgba(74,52,34,0.44)';
    const lite = tex === 'soil' ? 'rgba(102,82,56,0.24)' : 'rgba(122,90,58,0.26)';
    hatch(1, 7, dark, 1.3, 1.5); hatch(-1, 13, lite, 1, 1.7);
  } else if (tex === 'gravel' || tex === 'rock') {
    const col = tex === 'rock' ? 'rgba(108,106,94,0.3)' : 'rgba(126,120,104,0.28)';
    hatch(1, 9, col, 1, 1.2); hatch(-1, 9, col, 1, 1.2);
    const n = tex === 'rock' ? 40 : 70;
    c.fillStyle = 'rgba(90,86,76,0.28)';
    for (let i = 0; i < n; i++) { const x = R() * S, y = R() * S, r = (tex === 'rock' ? 1.4 : 0.7) + R() * (tex === 'rock' ? 2 : 1.2); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
  } else if (tex === 'water') {
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1.2; c.lineCap = 'round';
    for (let row = 0; row < 14; row++) {
      const y = (row + 0.5) * (S / 14);
      c.beginPath(); for (let x = 0; x <= S; x += 3) { const yy = y + Math.sin(x * 0.39 + row) * 1.5; if (!x) c.moveTo(x, yy); else c.lineTo(x, yy); } c.stroke();
    }
  } else if (tex === 'pavers' || tex === 'brick') {
    const cw = tex === 'brick' ? 32 : 32, ch = tex === 'brick' ? 16 : 32;
    c.strokeStyle = 'rgba(60,50,38,0.3)'; c.lineWidth = 1; let row = 0;
    for (let y = 0; y <= S; y += ch) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(S, y); c.stroke();
      const off = tex === 'brick' && row % 2 ? cw / 2 : 0;
      for (let x = off; x <= S; x += cw) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + ch); c.stroke(); }
      row++;
    }
  } else if (tex === 'flagstone') {
    c.strokeStyle = 'rgba(70,64,52,0.32)'; c.lineWidth = 1.2; c.lineCap = 'round';
    const n = Math.floor(area / 800);
    for (let i = 0; i < n; i++) {
      let px = R() * S, py = R() * S; const segs = 3 + Math.floor(R() * 3);
      c.beginPath(); c.moveTo(px, py);
      for (let s = 0; s < segs; s++) { const a = R() * Math.PI * 2, l = 8 + R() * 14; px += Math.cos(a) * l; py += Math.sin(a) * l; c.lineTo(px, py); } c.stroke();
    }
  } else if (tex === 'concrete') {
    hatch(1, 14, 'rgba(96,92,84,0.16)', 1, 1);
  }
}

const _tileCache: Record<string, HTMLCanvasElement> = {};
function materialTile(tex: string): HTMLCanvasElement | null {
  if (!TEX_BASE[tex]) return null;
  if (_tileCache[tex]) return _tileCache[tex];
  const S = 128; const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const c = cv.getContext('2d'); if (!c) return null;
  paintMaterialTile(c, S, tex, 0x9e37 ^ tex.length);
  _tileCache[tex] = cv; return cv;
}

// Ground textures that get the bold hand-drawn sketch tiles (grass flicks / mulch flecks /
// pebbles) laid over a colour wash, instead of the faint procedural materialTile.
const SKETCH_GROUND_TEX: Record<string, 'grass' | 'mulch' | 'pebble'> = {
  grass: 'grass', mulch: 'mulch', soil: 'mulch', rock: 'pebble', gravel: 'pebble',
};

// Wobbly closed sub-path through px `pts` (drafting fill outline). Seeded jitter.
function roughSubPath(ctx: CanvasRenderingContext2D, pts: Pt[], jit: number, seed: number) {
  const rr = planRng(seed); const j = () => (rr() * 2 - 1) * jit; const n = pts.length;
  if (n < 2) return;
  const sx = pts[0][0] + j(), sy = pts[0][1] + j();
  ctx.moveTo(sx, sy);
  for (let i = 1; i <= n; i++) {
    const a = pts[(i - 1) % n], b = pts[i % n];
    const mx = (a[0] + b[0]) / 2 + j() * 1.4, my = (a[1] + b[1]) / 2 + j() * 1.4;
    const ex = i === n ? sx : b[0] + j(), ey = i === n ? sy : b[1] + j();
    ctx.quadraticCurveTo(mx, my, ex, ey);
  }
}

function ringsSeed(rings: Pt[][]): number {
  let sx = 0, sy = 0; for (const p of rings[0]) { sx += p[0]; sy += p[1]; }
  return (Math.round(Math.abs(sx) + Math.abs(sy)) | 0) + 1;
}

export interface SketchFeatureOpts {
  fill: string;                 // material/base colour (first 7 chars used as the wash base)
  stroke: string;               // active-selection outline colour
  lineWidth: number;
  tex?: string | null;          // material key (grass/mulch/rock/pavers…) → texture; null → pencil hatch
  active?: boolean;             // selected → accent ink + selection glow
  ink?: string | null;          // inkOverride (e.g. green lawn edge); ignored when active
}

// Paint ONE polygon (its px rings — outer + holes) in the colored-pencil drafting style:
// a colour wash, then a bold sketch texture tile / material tile / pencil hatch, then a
// pressure-varied wobbly ink outline. Mirrors the editor's drawFeature illustrative branch
// exactly (seed derived from the first ring, so callers need not thread a seed).
export function paintSketchFeaturePoly(ctx: CanvasRenderingContext2D, rings: Pt[][], opts: SketchFeatureOpts): void {
  if (!rings.length || rings[0].length < 2) return;
  const { fill, stroke, lineWidth, tex = null, active = false, ink: inkOverride = null } = opts;
  const seed = ringsSeed(rings);
  ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 1.1, seed + ri)); ctx.closePath();
  const base = fill.slice(0, 7);
  const sketchKind = tex ? SKETCH_GROUND_TEX[tex] : null;
  if (sketchKind) {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = base; ctx.fill('evenodd'); ctx.restore();
    const gp = ctx.createPattern(hatchPattern(base, sketchKind, seed), 'repeat');
    if (gp) { ctx.save(); ctx.globalAlpha = 0.68; ctx.fillStyle = gp; ctx.fill('evenodd'); ctx.restore(); }
  } else {
    const tile = tex ? materialTile(tex) : null;
    if (tile) {
      const pat = ctx.createPattern(tile, 'repeat');
      ctx.fillStyle = pat || fill; ctx.fill('evenodd');
    } else {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = base; ctx.fill('evenodd'); ctx.restore();
      const hp = ctx.createPattern(hatchPattern(base, 'pencil', seed), 'repeat');
      if (hp) { ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = hp; ctx.fill('evenodd'); ctx.restore(); }
    }
  }
  const ink = active ? stroke : (inkOverride ?? '#40392e');
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (active) {
    ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 1.1, seed + ri));
    ctx.shadowColor = 'rgba(47,107,79,0.85)'; ctx.shadowBlur = 13; ctx.strokeStyle = ink; ctx.lineWidth = lineWidth + 1; ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
  rings.forEach((pts, ri) => sketchStroke(ctx, pts, { seed: seed + ri + 9, color: ink, width: Math.max(lineWidth, 1.6), wobble: 1.7, passes: 2, alpha: 0.62, closed: true }));
}

// Primary open-ground fill: colour wash + the material's bold tile (bark mulch or drawn
// pebbles) over the given px rings (evenodd). Mirrors the editor's primary-ground branch
// (fixed seed 7, no outline).
export function paintSketchGroundFill(ctx: CanvasRenderingContext2D, rings: Pt[][], opts: { color: string; kind: 'mulch' | 'pebble' }): void {
  if (!rings.length) return;
  const gseed = 7;
  ctx.save();
  ctx.beginPath();
  for (const ring of rings) roughSubPath(ctx, ring, 1.1, gseed);
  ctx.closePath();
  ctx.globalAlpha = 0.5; ctx.fillStyle = opts.color; ctx.fill('evenodd');
  const gp = ctx.createPattern(hatchPattern(opts.color, opts.kind, gseed), 'repeat');
  if (gp) { ctx.globalAlpha = 0.6; ctx.fillStyle = gp; ctx.fill('evenodd'); }
  ctx.restore();
}

// Lawn "mower arcs": 2–3 gentle seeded sweeps across the turf at low alpha, clipped to the
// lawn's px rings. `cornerA`/`cornerB` are the two projected corners of the lawn's feet bbox
// (min & max) — matching the editor's use of the transformed bbox for band placement + seed.
export function paintLawnMowerArcs(ctx: CanvasRenderingContext2D, rings: Pt[][], cornerA: Pt, cornerB: Pt, ink: string): void {
  if (!rings.length) return;
  ctx.save();
  ctx.beginPath();
  for (const ring of rings) ring.forEach(([px, py], k) => { if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  ctx.clip('evenodd');
  const minX = Math.min(cornerA[0], cornerB[0]), maxX = Math.max(cornerA[0], cornerB[0]);
  const minY = Math.min(cornerA[1], cornerB[1]), maxY = Math.max(cornerA[1], cornerB[1]);
  const arc = planRng((Math.round(Math.abs(minX) + Math.abs(minY)) | 0) + 5);
  ctx.strokeStyle = ink; ctx.globalAlpha = 0.08; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  const bands = 2 + Math.floor(arc() * 2);
  for (let bi = 0; bi < bands; bi++) {
    const y = minY + (maxY - minY) * (0.28 + bi * 0.24 + (arc() * 2 - 1) * 0.04);
    const sag = (maxY - minY) * (0.05 + arc() * 0.05);
    ctx.beginPath(); ctx.moveTo(minX - 6, y);
    ctx.quadraticCurveTo((minX + maxX) / 2, y + sag, maxX + 6, y); ctx.stroke();
  }
  ctx.restore();
}

// Ink a walkway's two corridor edges with a wobbly line (centreline `cl` in px, offset ±w/2).
// Mirrors the editor's walkway edge inking (seed from the first centreline point).
export function paintPathEdges(ctx: CanvasRenderingContext2D, cl: Pt[], widthPx: number, seedFromPt?: Pt): void {
  if (cl.length < 2) return;
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[Math.max(i - 1, 0)], b = cl[Math.min(i + 1, cl.length - 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    left.push([cl[i][0] - dy * widthPx / 2, cl[i][1] + dx * widthPx / 2]);
    right.push([cl[i][0] + dy * widthPx / 2, cl[i][1] - dx * widthPx / 2]);
  }
  const sp = seedFromPt ?? cl[0];
  const eSeed = (Math.round(Math.abs(sp[0]) + Math.abs(sp[1])) | 0) + 1;
  ctx.save();
  ctx.globalAlpha = 1;
  sketchStroke(ctx, left, { seed: eSeed + 3, color: 'rgba(64,57,46,0.5)', width: 1, wobble: 0.8, passes: 1, overshoot: 0 });
  sketchStroke(ctx, right, { seed: eSeed + 8, color: 'rgba(64,57,46,0.5)', width: 1, wobble: 0.8, passes: 1, overshoot: 0 });
  ctx.restore();
}

// ── Path corridor material body ─────────────────────────────────────────────────
// Paint the MATERIAL inside a walkway / creek corridor the way a landscape drafter
// draws it: stone-by-stone flagstone, running-bond pavers/brick, washed concrete,
// hatched gravel, or a river-rock creek bed. Clipped to the corridor polygon derived
// from the SAME centreline offset paintPathEdges uses, so the drawn material sits
// exactly inside the inked edges. Deterministic (seeded from path.id + material +
// cell index → no shimmer). `cl` is the px centreline (already spline-sampled by the
// caller, matching what it hands paintPathEdges); `widthPx` the corridor width;
// `scale` px-per-foot (stone sizes are authored in FEET and scaled through it).
export interface PathBodyOpts { material?: string | null; kind?: string | null; color?: string | null; id?: string | null; }

// FNV-1a hash of the path id → a stable integer seed (path ids are strings, not geometry).
function hashStr(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) || 1; }

// Light "stone wash" base colour per material (independent of the slate path.color so
// stone reads as stone). Ink is a graphite darken of the wash.
const PATH_WASH: Record<string, string> = {
  flagstone: '#b4aea3', pavers: '#bdb4a4', brick: '#a96b54', concrete: '#c9c5bc',
  gravel: '#b7afa0', mulch: '#8b6b4a', 'river-rock': '#aeb4ba',
};

// Even-arc-length sampler over a px polyline: total length + at(s) → {point, unit normal}.
function arcSampler(cl: Pt[]) {
  const cum = [0];
  for (let i = 1; i < cl.length; i++) cum.push(cum[i - 1] + Math.hypot(cl[i][0] - cl[i - 1][0], cl[i][1] - cl[i - 1][1]));
  const total = cum[cum.length - 1] || 0;
  const at = (s: number) => {
    s = Math.max(0, Math.min(total, s));
    let hi = 1; while (hi < cum.length && cum[hi] < s) hi++;
    const i1 = Math.min(hi, cl.length - 1), i0 = Math.max(0, i1 - 1);
    const seg = (cum[i1] - cum[i0]) || 1, t = (s - cum[i0]) / seg;
    const px = cl[i0][0] + (cl[i1][0] - cl[i0][0]) * t, py = cl[i0][1] + (cl[i1][1] - cl[i0][1]) * t;
    let dx = cl[i1][0] - cl[i0][0], dy = cl[i1][1] - cl[i0][1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    return { px, py, nx: -dy, ny: dx };
  };
  return { total, at };
}

// Corridor polygon: offset the centreline ±widthPx/2 with the SAME per-vertex normal
// paintPathEdges uses (left forward, right reversed) → a closed ring for clipping.
function corridorRing(cl: Pt[], widthPx: number): Pt[] {
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[Math.max(i - 1, 0)], b = cl[Math.min(i + 1, cl.length - 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    left.push([cl[i][0] - dy * widthPx / 2, cl[i][1] + dx * widthPx / 2]);
    right.push([cl[i][0] + dy * widthPx / 2, cl[i][1] - dx * widthPx / 2]);
  }
  return [...left, ...right.reverse()];
}

export function paintPathBody(ctx: CanvasRenderingContext2D, cl: Pt[], widthPx: number, scale: number, opts: PathBodyOpts): void {
  if (cl.length < 2 || widthPx < 1 || scale <= 0) return;
  const isCreek = opts.kind === 'creek';
  const material = isCreek ? 'river-rock' : (opts.material || 'gravel');
  const wash = PATH_WASH[material] || (opts.color && opts.color.length >= 7 ? opts.color.slice(0, 7) : '#bcb6aa');
  const ink = darkenHex(wash, 0.5);
  const seed = hashStr(`${opts.id || ''}|${material}`);
  const ring = corridorRing(cl, widthPx);
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of ring) { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  const samp = arcSampler(cl);
  const halfW = widthPx / 2;
  const pt = (s: number, u: number): Pt => { const a = samp.at(s); return [a.px + a.nx * u, a.py + a.ny * u]; };
  const fillRect = (alpha: number, style: string | CanvasPattern) => { ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = style; ctx.fillRect(mnx, mny, mxx - mnx, mxy - mny); ctx.restore(); };
  const tilePat = (tex: string): CanvasPattern | null => { const t = materialTile(tex); return t ? ctx.createPattern(t, 'repeat') : null; };

  ctx.save();
  ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // A wobbly river/gravel stone: soft varied fill + inked wobbly outline.
  const stone = (c: Pt, rad: number, sd: number) => {
    const r = planRng(sd); const ry = rad * (0.6 + r() * 0.4);
    ctx.save(); ctx.beginPath(); ctx.ellipse(c[0], c[1], rad, ry, r() * Math.PI, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5; ctx.fillStyle = darkenHex(wash, 0.9 + (r() * 2 - 1) * 0.12); ctx.fill(); ctx.restore();
    sketchEllipse(ctx, c[0], c[1], rad, ry, { seed: sd + 2, color: ink, width: 1, wobble: 0.6, passes: 1, alpha: 0.5 });
  };

  // Paved-cell walker (flagstone irregular; pavers/brick regular running bond). Walks the
  // centreline by arc length: each step is a row of `ncols` cells across the width, every
  // corner mapped through pt(s,u) so cells follow the winding spline. Zoom guard: if the
  // smallest cell would be < 3px on screen, fall back to the simple tiled material fill.
  const walkCells = (cfg: { rowFt: number; cellFt: number; jit: number; bond: boolean; inset: number; tone: number; inkW: number; irregular: boolean }) => {
    if (Math.min(cfg.rowFt, cfg.cellFt) * scale < 3) { fillRect(0.55, wash); const p = tilePat(material); if (p) fillRect(0.85, p); return; }
    fillRect(0.5, wash);
    const rr = planRng(seed);
    const rowPx = cfg.rowFt * scale;
    let s = 0, row = 0;
    while (s < samp.total) {
      const rowLen = cfg.irregular ? rowPx * (0.75 + rr() * 0.55) : rowPx;
      const sA = s, sB = Math.min(s + rowLen, samp.total);
      const ncols = cfg.irregular ? 1 + Math.floor(rr() * 3) : Math.max(1, Math.round(widthPx / (cfg.cellFt * scale)));
      const cw = widthPx / ncols;
      const off = cfg.bond && row % 2 ? cw / 2 : 0;
      for (let u = -halfW - off; u < halfW - 1e-3; u += cw) {
        const u0 = Math.max(-halfW, u), u1 = Math.min(halfW, u + cw);
        if (u1 - u0 < cw * 0.3) continue;
        const cellSeed = seed + row * 131 + Math.round((u0 + halfW) * 7) + 1;
        const cr = planRng(cellSeed);
        const jS = (sB - sA) * cfg.jit, jU = (u1 - u0) * cfg.jit;
        const iS = (sB - sA) * cfg.inset * 0.5, iU = (u1 - u0) * cfg.inset * 0.5;
        const poly: Pt[] = [
          pt(sA + iS + (cr() * 2 - 1) * jS, u0 + iU + (cr() * 2 - 1) * jU),
          pt(sA + iS + (cr() * 2 - 1) * jS, u1 - iU + (cr() * 2 - 1) * jU),
          pt(sB - iS + (cr() * 2 - 1) * jS, u1 - iU + (cr() * 2 - 1) * jU),
          pt(sB - iS + (cr() * 2 - 1) * jS, u0 + iU + (cr() * 2 - 1) * jU),
        ];
        ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.globalAlpha = 0.9; ctx.fillStyle = darkenHex(wash, 1 + (cr() * 2 - 1) * cfg.tone); ctx.fill(); ctx.globalAlpha = 1;
        sketchStroke(ctx, poly, { seed: cellSeed + 3, color: ink, width: cfg.inkW, wobble: 0.55, passes: 1, overshoot: 0, alpha: 0.5, closed: true });
        // Pencil shade stroke along one consistent side (the far / u1 corner pair).
        sketchStroke(ctx, [poly[1], poly[2]], { seed: cellSeed + 7, color: ink, width: cfg.inkW * 1.4, wobble: 0.4, passes: 1, overshoot: 0, alpha: 0.22 });
      }
      s += rowLen; row++;
    }
  };

  if (isCreek) {
    fillRect(0.4, wash);
    const rr = planRng(seed + 5);
    let s = 0;
    while (s < samp.total) {
      const step = Math.max(4, (0.9 + rr() * 0.9) * scale);
      const ncols = 1 + Math.floor(rr() * 3);
      for (let k = 0; k < ncols; k++) {
        const rad = (0.32 + rr() * 0.55) * scale;
        if (rad < 1.5) continue;
        stone(pt(s + (rr() * 2 - 1) * step * 0.3, (rr() * 2 - 1) * halfW * 0.82), rad, seed + Math.round(s) * 3 + k);
      }
      s += step;
    }
    // Light meander squiggle down the middle.
    const mid: Pt[] = []; const wl = Math.max(scale * 2.5, 24);
    for (let ss = 0; ss <= samp.total; ss += Math.max(4, scale * 0.5)) mid.push(pt(ss, Math.sin(ss / wl) * halfW * 0.35));
    if (mid.length > 1) sketchStroke(ctx, mid, { seed: seed + 11, color: 'rgba(120,130,140,0.55)', width: 1.2, wobble: 0.8, passes: 1, overshoot: 0, alpha: 0.5 });
  } else if (material === 'flagstone') {
    walkCells({ rowFt: 2, cellFt: 2, jit: 0.26, bond: false, inset: 0.16, tone: 0.1, inkW: 1.2, irregular: true });
  } else if (material === 'pavers') {
    walkCells({ rowFt: 1, cellFt: 2, jit: 0.08, bond: true, inset: 0.07, tone: 0.06, inkW: 1, irregular: false });
  } else if (material === 'brick') {
    walkCells({ rowFt: 0.4, cellFt: 0.8, jit: 0.06, bond: true, inset: 0.05, tone: 0.08, inkW: 0.8, irregular: false });
  } else if (material === 'concrete') {
    fillRect(0.55, wash);
    const cj = Math.max(4 * scale, 8);
    for (let s = cj; s < samp.total; s += cj) sketchStroke(ctx, [pt(s, -halfW), pt(s, halfW)], { seed: seed + Math.round(s), color: 'rgba(96,92,84,0.4)', width: 1, wobble: 0.6, passes: 1, overshoot: 0, alpha: 0.4 });
    const rr = planRng(seed + 3);
    ctx.save(); ctx.fillStyle = darkenHex(wash, 0.94); ctx.globalAlpha = 0.12;
    for (let i = 0; i < 6; i++) { const c = pt(rr() * samp.total, (rr() * 2 - 1) * halfW * 0.7); ctx.beginPath(); ctx.arc(c[0], c[1], (0.5 + rr()) * scale, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  } else if (material === 'gravel') {
    fillRect(0.5, wash);
    const gp = ctx.createPattern(hatchPattern(wash, 'pebble', seed), 'repeat');
    if (gp) fillRect(0.6, gp);
    const rr = planRng(seed + 7); let s = 0;
    while (s < samp.total) { const rad = (0.22 + rr() * 0.32) * scale; if (rad >= 2) stone(pt(s, (rr() * 2 - 1) * halfW * 0.8), rad, seed + Math.round(s) * 2); s += Math.max(4, (0.8 + rr()) * scale); }
  } else {
    // mulch / unknown → wash + the material's soft tile (or a mulch hatch fallback).
    fillRect(0.5, wash);
    const p = tilePat(material);
    if (p) fillRect(0.7, p);
    else { const hp = ctx.createPattern(hatchPattern(wash, 'mulch', seed), 'repeat'); if (hp) fillRect(0.6, hp); }
  }
  ctx.restore();
}

// ── Plant clustering + symbology ─────────────────────────────────────────────
export type Layer = 'tree' | 'large_shrub' | 'shrub' | 'groundcover';
export type PlantMarker = { x: number; y: number; rFt: number; color: string; kind: Layer; name: string };
export type PlantCluster = { kind: Layer; name: string; members: PlantMarker[] };

// Cluster same-species plants whose mature circles overlap / nearly touch into connected masses —
// the signature drafting look. O(n²) within a species; feet space (transform-free). Pure.
export function buildPlantClusters(markers: PlantMarker[]): PlantCluster[] {
  const bySpecies = new Map<string, PlantMarker[]>();
  for (const m of markers) {
    const k = `${m.kind}|${m.name}`;
    (bySpecies.get(k) ?? bySpecies.set(k, []).get(k)!).push(m);
  }
  const out: PlantCluster[] = [];
  for (const group of bySpecies.values()) {
    const n = group.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = group[i], b = group[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < a.rFt + b.rFt + 1.5) parent[find(i)] = find(j);
    }
    const groups = new Map<number, PlantMarker[]>();
    for (let i = 0; i < n; i++) { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(group[i]); }
    for (const members of groups.values()) out.push({ kind: members[0].kind, name: members[0].name, members });
  }
  return out;
}

// Angular arcs of circle `i` (centre ci, radius ri) EXPOSED (not buried inside a cluster neighbour)
// — those get inked as scallops. Returns [] when i is fully engulfed. Rotation-invariant.
function exposedArcs(ci: Pt, ri: number, neighbors: { c: Pt; r: number }[]): [number, number][] {
  const covered: [number, number][] = [];
  for (const nb of neighbors) {
    const dx = nb.c[0] - ci[0], dy = nb.c[1] - ci[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) { if (nb.r >= ri) return []; continue; }
    if (d + ri <= nb.r) return [];
    if (d >= ri + nb.r) continue;
    if (d + nb.r <= ri) continue;
    const cosH = (ri * ri + d * d - nb.r * nb.r) / (2 * ri * d);
    const half = Math.acos(Math.max(-1, Math.min(1, cosH)));
    const mid = Math.atan2(dy, dx);
    covered.push([mid - half, mid + half]);
  }
  if (!covered.length) return [[0, Math.PI * 2]];
  const norm: [number, number][] = [];
  for (let [a, b] of covered) {
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    b = ((b % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (b < a) { norm.push([a, Math.PI * 2]); norm.push([0, b]); } else norm.push([a, b]);
  }
  norm.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const iv of norm) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of merged) { if (a - cursor > 0.06) gaps.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (Math.PI * 2 - cursor > 0.06) gaps.push([cursor, Math.PI * 2]);
  return gaps;
}

// Ornamental grasses render as a flicked fan, not a scallop circle.
const GRASS_RE = /grass|muhly|carex|festuca|sedge|fountain|miscanthus|pennisetum|stipa|panicum|switch|hair\s?grass|blue\s?oat|liriope|nassella|calamagrostis/i;
const isGrassName = (name: string) => GRASS_RE.test(name || '');

// Options for the read-only plan surfaces: highlight one species (see paintPlantClusters).
export interface PaintPlantClustersOpts {
  highlightName?: string | null; // when set, non-matching clusters dim; matching get a selection ring
}

// Paint the full colored-pencil plant symbology for a set of species clusters: per-species merged
// scallop mass (wash + pencil hatch over the union of the cluster's circles), inked scalloped edges
// (only the arcs not buried inside a neighbour), interior pencil texture, ornamental-grass fans, and
// groundcover stipple. `ftToPx` projects feet→px; `scale` is px-per-foot. Mirrors the editor's
// plan-view branch exactly. Caller sets up any clip / save-restore around this.
//
// `opts.highlightName` (used by the review page's click-to-highlight): when non-null, clusters whose
// species name !== highlightName are painted DIMMED (the whole group composited through globalAlpha
// 0.35 via an offscreen layer — so their internal per-fill alphas stay intact and dim uniformly),
// matching clusters paint at full strength on top, and each matching plant instance then gets a crisp
// selection ring (rFt+0.6ft, 2px dark ink over a soft paper halo) drawn AFTER the sketch so it reads
// over the hand-drawn edges. When highlightName is null/undefined this is byte-identical to before.
export function paintPlantClusters(ctx: CanvasRenderingContext2D, clusters: PlantCluster[], ftToPx: FtToPx, scale: number, opts?: PaintPlantClustersOpts): void {
  const highlightName = opts?.highlightName ?? null;
  const layerRank: Record<string, number> = { groundcover: 0, shrub: 1, large_shrub: 2, tree: 3 };
  const ordered = [...clusters].sort((a, b) => (layerRank[a.kind] ?? 0) - (layerRank[b.kind] ?? 0));

  // Ornamental grass: a small fan of 5–7 flicked strokes rising from the base (no circle).
  const grassFan = (c2: CanvasRenderingContext2D, px: number, py: number, r: number, color: string, seedN: number) => {
    const rr = planRng(seedN + 3), dark = darkenHex(color, 0.7), n = 5 + Math.floor(rr() * 3);
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0.5, bx = px + (t - 0.5) * r * 1.3;
      const ang = -Math.PI / 2 + (t - 0.5) * 1.15 + (rr() * 2 - 1) * 0.16, len = r * (1.0 + rr() * 0.7);
      const ex = bx + Math.cos(ang) * len, ey = py + Math.sin(ang) * len, bend = (rr() * 2 - 1) * len * 0.18;
      const mx = (bx + ex) / 2 - Math.sin(ang) * bend, my = (py + ey) / 2 + Math.cos(ang) * bend;
      sketchStroke(c2, [[bx, py], [mx, my], [ex, ey]], { seed: seedN + i * 17 + 2, color: i % 2 ? dark : color, width: 1.5, wobble: 1, passes: 1, overshoot: 0, alpha: 0.72 });
    }
  };
  // Interior pencil texture per plant (shrubs: radial strokes + stipple; trees: branch squiggles).
  const plantInterior = (c2: CanvasRenderingContext2D, px: number, py: number, r: number, kind: string, color: string, edgeInk: string, seedN: number) => {
    const rr = planRng(seedN + 17);
    c2.save(); c2.globalAlpha = 0.7; c2.fillStyle = edgeInk;
    c2.beginPath(); c2.arc(px, py, Math.max(1, r * 0.09), 0, Math.PI * 2); c2.fill(); c2.restore();
    if (kind === 'tree') {
      const nb = 2 + Math.round(rr());
      for (let i = 0; i < nb; i++) {
        const a = rr() * Math.PI * 2, len = r * (0.4 + rr() * 0.3), bend = (rr() * 2 - 1) * len * 0.2;
        const ex = px + Math.cos(a) * len, ey = py + Math.sin(a) * len;
        const mx = px + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, my = py + Math.sin(a) * len * 0.5 + Math.cos(a) * bend;
        sketchStroke(c2, [[px, py], [mx, my], [ex, ey]], { seed: seedN + i * 29 + 3, color: edgeInk, width: 1.1, wobble: 0.8, passes: 1, overshoot: 0, alpha: 0.5 });
      }
    } else {
      const strokes = kind === 'large_shrub' ? 3 : 2 + Math.round(rr());
      for (let i = 0; i < strokes; i++) {
        const a = rr() * Math.PI * 2, r0 = r * 0.15, r1 = r * (0.5 + rr() * 0.3);
        sketchStroke(c2, [[px + Math.cos(a) * r0, py + Math.sin(a) * r0], [px + Math.cos(a) * r1, py + Math.sin(a) * r1]], { seed: seedN + i * 13 + 5, color: edgeInk, width: 1.3, wobble: 1, passes: 1, overshoot: 0, alpha: 0.5 });
      }
      const stip = tintHex(color, 0.72), dots = kind === 'large_shrub' ? 5 : 4;
      c2.save(); c2.fillStyle = stip; c2.globalAlpha = 0.7;
      for (let d = 0; d < dots; d++) { const a = rr() * Math.PI * 2, dist = (0.2 + rr() * 0.5) * r; c2.beginPath(); c2.arc(px + Math.cos(a) * dist, py + Math.sin(a) * dist, Math.max(0.9, r * 0.08), 0, Math.PI * 2); c2.fill(); }
      c2.restore();
    }
  };

  // Instance circles of the highlighted species, collected during painting for the ring pass.
  const highlightCircles: { px: number; py: number; r: number }[] = [];

  // Paint ONE cluster onto `c2` — the exact original per-cluster body, parameterised by the target
  // ctx so it can render either to the visible canvas or to an offscreen dim layer. `collect` gathers
  // the projected circles for the highlight ring pass (only for the matching species).
  const paintCluster = (c2: CanvasRenderingContext2D, cl: PlantCluster, collect: boolean) => {
    const color = cl.members[0].color;
    const edgeInk = darkenHex(color, 0.6);
    const gc = cl.kind === 'groundcover';
    const minR = gc ? 3 : 5;
    const circles = cl.members.map(m => { const [px, py] = ftToPx(m.x, m.y); const seedN = (Math.abs(Math.round(m.x * 73 + m.y * 179)) | 0) + 1; return { px, py, r: Math.max(minR, m.rFt * scale), seedN }; });
    if (collect) for (const c of circles) highlightCircles.push({ px: c.px, py: c.py, r: c.r });

    // Ornamental grasses: flicked fans, no scallop mass.
    if (isGrassName(cl.name)) { for (const c of circles) grassFan(c2, c.px, c.py, c.r, color, c.seedN); return; }

    // 1) Merged scallop mass: wash over the UNION of all cluster circles, then a pencil hatch.
    const unionPath = new Path2D();
    for (const c of circles) unionPath.addPath(scallopPath(c.px, c.py, c.r, { seed: c.seedN }));
    c2.save(); c2.globalAlpha = gc ? 0.4 : 0.52; c2.fillStyle = gc ? '#B9CF9B' : color; c2.fill(unionPath); c2.restore();
    if (!gc) {
      const hp = c2.createPattern(hatchPattern(color, 'pencil', circles[0].seedN), 'repeat');
      if (hp) {
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const c of circles) { mnx = Math.min(mnx, c.px - c.r); mny = Math.min(mny, c.py - c.r); mxx = Math.max(mxx, c.px + c.r); mxy = Math.max(mxy, c.py + c.r); }
        c2.save(); c2.clip(unionPath); c2.globalAlpha = 0.42; c2.fillStyle = hp; c2.fillRect(mnx, mny, mxx - mnx, mxy - mny); c2.restore();
      }
    }
    // 2) Inked scalloped EDGE — only the arcs of each circle not buried inside a neighbour.
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const neigh = circles.filter((_, j) => j !== i).map(o => ({ c: [o.px, o.py] as Pt, r: o.r }));
      for (const [a0, a1] of exposedArcs([c.px, c.py], c.r, neigh)) {
        const pts = scallopArcPoints(c.px, c.py, c.r, a0, a1, c.seedN, { amp: gc ? 0.16 : 0.12 });
        if (pts.length > 1) sketchStroke(c2, pts, { seed: c.seedN + i, color: gc ? 'rgba(74,92,52,0.8)' : edgeInk, width: cl.kind === 'tree' ? 2.3 : 1.9, wobble: 1.6, passes: 2, alpha: 0.62, overshoot: 0 });
      }
    }
    // 3) Interior texture (groundcover → stipple in bloom colour; else radial strokes + stipple/branches).
    for (const c of circles) {
      if (gc) {
        const rr = planRng(c.seedN + 9), dots = 5 + Math.floor(rr() * 4);
        c2.save(); c2.fillStyle = color; c2.globalAlpha = 0.78;
        for (let d = 0; d < dots; d++) { const a = rr() * Math.PI * 2, dist = rr() * c.r * 0.75; c2.beginPath(); c2.arc(c.px + Math.cos(a) * dist, c.py + Math.sin(a) * dist, Math.max(0.9, c.r * 0.1), 0, Math.PI * 2); c2.fill(); }
        c2.restore();
      } else {
        plantInterior(c2, c.px, c.py, c.r, cl.kind, color, edgeInk, c.seedN);
      }
    }
  };

  // No highlight → original single pass, byte-identical to before.
  if (highlightName == null) {
    for (const cl of ordered) paintCluster(ctx, cl, false);
    return;
  }

  // Highlight mode: dim the non-matching species as ONE group (offscreen layer composited at 0.35 so
  // each cluster's internal alphas survive), then paint the matching species at full strength on top.
  const dimClusters = ordered.filter(cl => cl.name !== highlightName);
  const hiClusters = ordered.filter(cl => cl.name === highlightName);

  if (dimClusters.length) {
    const src = ctx.canvas;
    const off = document.createElement('canvas');
    off.width = src.width; off.height = src.height;
    const octx = off.getContext('2d');
    if (octx) {
      octx.setTransform(ctx.getTransform());
      for (const cl of dimClusters) paintCluster(octx, cl, false);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // draw the layer 1:1 in device px (existing clip still applies)
      ctx.globalAlpha = 0.35;
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    } else {
      for (const cl of dimClusters) paintCluster(ctx, cl, false); // no offscreen → paint normally
    }
  }
  for (const cl of hiClusters) paintCluster(ctx, cl, true);

  // Selection ring per matching instance — soft paper halo + crisp dark ink, over the sketch.
  if (highlightCircles.length) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const c of highlightCircles) {
      const rr = c.r + 0.6 * scale;
      ctx.beginPath(); ctx.arc(c.px, c.py, rr, 0, Math.PI * 2);
      ctx.globalAlpha = 0.5; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(247,243,234,0.9)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c.px, c.py, rr, 0, Math.PI * 2);
      ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = '#2A2A26'; ctx.stroke();
    }
    ctx.restore();
  }
}
