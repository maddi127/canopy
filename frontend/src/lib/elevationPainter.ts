// ── Elevation painter ─────────────────────────────────────────────────────────
// A DRAWN, ground-level "garden elevation illustration" of the finished yard — the
// hand-drawn replacement for the old WebGL hero render. Same sketch kit as the 2D
// aerial plan (sketch.ts pen + planPainter fills), but projected onto a shallow
// STAGE so the viewer stands at the yard edge opposite the house and the planted beds
// and paths fan toward them, the house elevation as pale line-art at the back — the
// classic watercolour garden vignette floating on paper.
//
// paintElevation(ctx, wPx, hPx) reads localStorage itself (like the plan painters'
// consumers) and is PURE + DETERMINISTIC (no Math.random) so the same plan renders
// pixel-identically and caches cleanly.
import { sketchStroke, hatchPattern } from './sketch';
import { darkenHex, paintSketchFeaturePoly, paintSketchGroundFill } from './planPainter';
import { buildCS } from '../services/draftPlan';
import { drawStandingPlant, drawFurnitureGlyph, type StandingPlant, type FurnitureGlyph } from './elevationSymbols';
import { spriteFor, drawSprite } from './elevationSprites';

type Pt = [number, number];

// ── Palette / material lookups (mirrors the plan surfaces) ──────────────────────
const PAPER = '#f6f1e6';
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const VARIANT_COLOR: Record<string, string> = { natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B' };
const FEATURE_MATERIAL_COLOR: Record<string, string> = { pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48' };
// Light "stone wash" per path material (independent of the slate path.color) — copied
// from planPainter's private PATH_WASH so the elevation stones read as stone.
const PATH_WASH: Record<string, string> = {
  flagstone: '#b4aea3', pavers: '#bdb4a4', brick: '#a96b54', concrete: '#c9c5bc',
  gravel: '#b7afa0', mulch: '#8b6b4a', 'river-rock': '#aeb4ba',
};
const MATERIAL_FEATURES = new Set(['seating', 'dining', 'cooking', 'storage']);

const primaryColorOf = (pr: any): string => (pr?.variant ? VARIANT_COLOR[pr.variant] : (pr?.material ? MATERIAL_COLOR[pr.material] : null)) || '#8a7355';
const primaryKindOf = (pr: any): 'mulch' | 'pebble' | 'lawn' => pr?.material === 'rock' ? ((pr.variant === 'river' || pr.variant === 'pea') ? 'pebble' : 'pebble') : pr?.material === 'lawn' ? 'lawn' : 'mulch';
const zoneColorOf = (z: any): string => z.key === 'lawn' ? MATERIAL_COLOR.lawn : (z.material ? (FEATURE_MATERIAL_COLOR[z.material] || z.color) : z.color) || '#B7AC9A';
const zoneTexOf = (z: any): string | null => z.key === 'lawn' ? 'grass' : z.key === 'water' ? 'water' : z.key === 'garden' ? 'soil' : z.material ? z.material : MATERIAL_FEATURES.has(z.key) ? 'gravel' : null;

// A zone/bed shape → its feet ring (uses an explicit ring, else a rect/ellipse from
// its feet bbox — mirrors PlanSnapshot's ringForShape so both data shapes work).
function ringForShape(s: any): Pt[] {
  if (s.ring && s.ring.length >= 3) return s.ring as Pt[];
  const x = s.xFt ?? s.x ?? 0, y = s.yFt ?? s.y ?? 0, w = s.wFt ?? 0, h = s.hFt ?? 0;
  if (w <= 0 || h <= 0) return [];
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  if (s.shape === 'circle' || s.shape === 'organic') {
    const N = 40, r: Pt[] = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    return r;
  }
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

function centroid(r: Pt[]): Pt { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }

// ── Plant colour pipeline (small faithful copy of Plant3D.resolveColor) ─────────
const COLOR_HEX: Record<string, string> = {
  'green': '#7aa85e', 'dark green': '#527a48', 'deep green': '#527a48', 'medium green': '#7aa85e', 'light green': '#8cbb66', 'bright green': '#7fb552', 'emerald': '#4f9a63',
  'blue-green': '#5e8b7e', 'blue green': '#5e8b7e', 'gray-green': '#8a9a82', 'grey-green': '#8a9a82', 'silver': '#b7c0b0', 'silvery': '#b7c0b0', 'gray': '#9aa39a', 'grey': '#9aa39a',
  'gold': '#c9a227', 'golden': '#c9a227', 'yellow': '#cdb53b', 'chartreuse': '#9bbf3b', 'lime': '#9bbf3b',
  'purple': '#7a5a9e', 'violet': '#7a5a9e', 'lavender': '#9d8ec4', 'magenta': '#a85a8e',
  'blue': '#5b86a8', 'pink': '#d98aa6', 'rose': '#d98aa6', 'white': '#e8e6dd', 'cream': '#e3dcc4',
  'red': '#a8443a', 'crimson': '#a8443a', 'scarlet': '#a8443a', 'burgundy': '#6e3b3b', 'maroon': '#6e3b3b', 'deep red': '#6e3b3b',
  'orange': '#cf7b3a', 'coral': '#d98a5a', 'apricot': '#d8a36a', 'bronze': '#8a6a4a', 'copper': '#9a6a44', 'variegated': '#9bb37a',
};
function foliageColor(raw: string, evergreen: boolean): string {
  const k = (raw || '').toLowerCase().trim();
  if (COLOR_HEX[k]) return COLOR_HEX[k];
  for (const key in COLOR_HEX) if (k.includes(key)) return COLOR_HEX[key];
  return evergreen ? '#527a48' : '#7aa85e';
}
function isGreenHex(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return g >= r && g >= b;
}
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255), g = ch((pa >> 8) & 255, (pb >> 8) & 255), bl = ch(pa & 255, pb & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}
// foliage + bloom for a plant. p.color is usually a bloom HEX: a green-family hex tints
// the foliage; any other hue is the bloom over a lively/evergreen green.
function resolveColors(p: any): { foliage: string; bloom: string | null; evergreen: boolean } {
  const t = (p.type || '').toLowerCase();
  const evergreen = !!p.evergreen || t.includes('evergreen');
  const bloomHex = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? (p.color as string) : null;
  const baseGreen = evergreen ? '#527a48' : '#7aa85e';
  const foliage = bloomHex
    ? (isGreenHex(bloomHex) ? mixHex(bloomHex, baseGreen, 0.35) : baseGreen)
    : foliageColor(p.color, evergreen);
  const bloom = bloomHex && !isGreenHex(bloomHex) ? bloomHex : null;
  return { foliage, bloom, evergreen };
}

// Plant kind for the standing glyph (mirrors Plant3D's dispatch keywords).
const GRASS_RE = /grass|muhly|carex|festuca|sedge|fountain|miscanthus|pennisetum|stipa|panicum|liriope|calamagrostis/i;
const TREE_RE = /spruce|pine|fir|juniper|cedar|arborvitae|birch|aspen|crabapple|cherry|redbud|serviceberry|magnolia|columnar|fastigiate|poplar|willow|maple|oak|elm|linden|hackberry|honeylocust/i;
const CONIFER_RE = /spruce|pine|fir|juniper|cedar|arborvitae/i;
const GROUNDCOVER_RE = /creeping|carpet|\bmat\b|thyme|sedum|ice plant|phlox/i;
function plantKind(p: any, evergreen: boolean): StandingPlant['kind'] {
  const name = (p.name || '').toLowerCase(), t = (p.type || '').toLowerCase(), layer = (p.layer || '').toLowerCase();
  const isTree = t.includes('tree') || layer === 'tree' || TREE_RE.test(name);
  if (GRASS_RE.test(name)) return 'grass';
  if (isTree) return (CONIFER_RE.test(name) || evergreen) ? 'conifer' : 'tree';
  if (layer === 'groundcover' || GROUNDCOVER_RE.test(name)) return 'groundcover';
  if (layer === 'shrub' || layer === 'large_shrub' || t.includes('shrub')) return 'shrub';
  return 'perennial';
}

// Furniture kind from a gathering zone's key/label (mirrors Furnishings3D.ZoneProxy).
function furnitureKind(zone: any): FurnitureGlyph['kind'] | null {
  const key = `${zone.key ?? ''} ${zone.label ?? ''}`.toLowerCase();
  if (/cook|bbq|grill|kitchen/.test(key)) return 'cooking';
  if (/fire/.test(key)) return 'fire';
  if (/seat|patio|lounge|gather/.test(key)) return 'seating';
  if (/dining|dine|eat/.test(key)) return 'dining';
  if (/veg|garden bed|garden|raised/.test(key)) return 'garden';
  if (/play/.test(key)) return 'play';
  return null;
}

// Deterministic integer seed from a feet position (the codebase's Math.imul hash pattern).
function seedXY(x: number, y: number): number {
  const s = (Math.imul(Math.round(x * 131.7) | 0, 0x9e3779b1) ^ Math.imul(Math.round(y * 97.3) | 0, 0x85ebca77)) >>> 0;
  return s || 1;
}

// ── Stage projection ────────────────────────────────────────────────────────────
// The viewer stands on the side OPPOSITE the house. u = unit house-ward vector (from
// the boundary centroid toward the house centroid). For a feet point p:
//   depth d  = (p·u − sMin)/(sMax − sMin)  in 0(front, away from house)..1(back/house)
//   lateral l = p·uPerp
//   s(d)      = 1 − ATTEN·d               (gentle scale attenuation)
//   screenX  = wPx/2 + (l − lMid)·ftPx·s(d)
//   groundY(d) = stageBottom − d·stageRise   (raised-eye cheat so depth rows layer)
// heights draw upward from groundY(d), scaled by hs(d) = ftPx·s(d).
const ATTEN = 0.28;
const STAGE_RISE_FRAC = 0.34;
const STAGE_BOTTOM_FRAC = 0.88;
const LATERAL_FILL = 0.86;   // boundary lateral extent fills this fraction of wPx at d=0.5

interface Stage {
  project(x: number, y: number): { sx: number; gy: number; s: number; hs: number; d: number };
  ftPx: number;
}
function buildStage(boundaryFt: Pt[], houseCentroid: Pt | null, wPx: number, hPx: number, houseTopFt: number): Stage {
  const bc = centroid(boundaryFt);
  // House-ward unit vector (fallback +y when no house).
  let ux = 0, uy = 1;
  if (houseCentroid) { const dx = houseCentroid[0] - bc[0], dy = houseCentroid[1] - bc[1]; const L = Math.hypot(dx, dy) || 1; ux = dx / L; uy = dy / L; }
  const px = -uy, py = ux; // uPerp
  const dot = (x: number, y: number) => (x - bc[0]) * ux + (y - bc[1]) * uy;
  const lat = (x: number, y: number) => (x - bc[0]) * px + (y - bc[1]) * py;
  let sMin = Infinity, sMax = -Infinity, lMin = Infinity, lMax = -Infinity;
  for (const [x, y] of boundaryFt) {
    const dv = dot(x, y), lv = lat(x, y);
    if (dv < sMin) sMin = dv; if (dv > sMax) sMax = dv;
    if (lv < lMin) lMin = lv; if (lv > lMax) lMax = lv;
  }
  const depthRange = (sMax - sMin) || 1;
  const lMid = (lMin + lMax) / 2, lSpan = (lMax - lMin) || 1;
  const stageBottom = hPx * STAGE_BOTTOM_FRAC;
  const stageRise = hPx * STAGE_RISE_FRAC;
  const sAt = (d: number) => 1 - ATTEN * Math.max(0, Math.min(1, d));
  const gyAt = (d: number) => stageBottom - Math.max(-0.15, Math.min(1.25, d)) * stageRise;
  // ftPx: fill LATERAL_FILL of wPx at d=0.5, then cap so the house top stays in frame.
  let ftPx = (LATERAL_FILL * wPx) / (lSpan * sAt(0.5));
  if (houseCentroid && houseTopFt > 0) {
    const dHouse = (dot(houseCentroid[0], houseCentroid[1]) - sMin) / depthRange;
    const availTop = gyAt(dHouse) - 0.06 * hPx;      // room above the house base line
    const ftPxVert = availTop / (houseTopFt * sAt(dHouse));
    if (ftPxVert > 0) ftPx = Math.min(ftPx, ftPxVert);
  }
  return {
    ftPx,
    project(x: number, y: number) {
      const d = (dot(x, y) - sMin) / depthRange;
      const s = sAt(d);
      return { sx: wPx / 2 + (lat(x, y) - lMid) * ftPx * s, gy: gyAt(d), s, hs: ftPx * s, d };
    },
  };
}

// Project a feet ring to screen, subdividing long edges so the depth foreshortening
// (the vertical squash toward the back) reads as a gentle curve, not a straight line.
function projectRing(ring: Pt[], stage: Stage): Pt[] {
  const out: Pt[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const segFt = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.min(16, Math.round(segFt / 2)));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const p = stage.project(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      out.push([p.sx, p.gy]);
    }
  }
  return out;
}

// ── Path corridor, stone-by-stone THROUGH the projection ────────────────────────
// Adapts paintPathBody's cell walk: step the centreline in FEET, and for each cell
// project its four feet corners onto the stage (so stones shrink with s(d) and follow
// the depth curve). Reuses the plan's per-material wash + inked-cell look.
function paintPathElevation(ctx: CanvasRenderingContext2D, ptsFt: Pt[], widthFt: number, stage: Stage, opts: { material?: string | null; kind?: string | null; color?: string | null; id?: string | null }) {
  if (ptsFt.length < 2) return;
  const isCreek = opts.kind === 'creek';
  const material = isCreek ? 'river-rock' : (opts.material || 'gravel');
  const wash = PATH_WASH[material] || (opts.color && opts.color.length >= 7 ? opts.color.slice(0, 7) : '#bcb6aa');
  const ink = darkenHex(wash, 0.5);
  let seed = 0x811c9dc5; const idStr = `${opts.id || ''}|${material}`;
  for (let i = 0; i < idStr.length; i++) { seed ^= idStr.charCodeAt(i); seed = Math.imul(seed, 0x01000193); }
  seed = (seed >>> 0) || 1;

  // Even-arc sampler over the feet centreline → point + unit normal at arc length s.
  const cum = [0];
  for (let i = 1; i < ptsFt.length; i++) cum.push(cum[i - 1] + Math.hypot(ptsFt[i][0] - ptsFt[i - 1][0], ptsFt[i][1] - ptsFt[i - 1][1]));
  const total = cum[cum.length - 1] || 0;
  const at = (s: number) => {
    s = Math.max(0, Math.min(total, s));
    let hi = 1; while (hi < cum.length && cum[hi] < s) hi++;
    const i1 = Math.min(hi, ptsFt.length - 1), i0 = Math.max(0, i1 - 1);
    const seg = (cum[i1] - cum[i0]) || 1, t = (s - cum[i0]) / seg;
    const cxp = ptsFt[i0][0] + (ptsFt[i1][0] - ptsFt[i0][0]) * t, cyp = ptsFt[i0][1] + (ptsFt[i1][1] - ptsFt[i0][1]) * t;
    let dx = ptsFt[i1][0] - ptsFt[i0][0], dy = ptsFt[i1][1] - ptsFt[i0][1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    return { x: cxp, y: cyp, nx: -dy, ny: dx };
  };
  const half = widthFt / 2;
  const ptFt = (s: number, u: number): Pt => { const a = at(s); return [a.x + a.nx * u, a.y + a.ny * u]; };
  const proj = (p: Pt): Pt => { const q = stage.project(p[0], p[1]); return [q.sx, q.gy]; };

  const rng = (n: number) => { let x = (seed ^ Math.imul(n | 1, 0x9e3779b1)) >>> 0; return () => { x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 0xffffffff; }; };

  const cell = (poly: Pt[], tone: number, cellSeed: number, inkW: number) => {
    const scr = poly.map(proj);
    ctx.beginPath(); scr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.globalAlpha = 0.9; ctx.fillStyle = darkenHex(wash, tone); ctx.fill(); ctx.globalAlpha = 1;
    sketchStroke(ctx, scr, { seed: cellSeed, color: ink, width: inkW, wobble: 0.5, passes: 1, overshoot: 0, alpha: 0.5, closed: true });
  };
  const stone = (cFt: Pt, radFt: number, sd: number) => {
    const c = stage.project(cFt[0], cFt[1]);
    const rad = radFt * c.hs; if (rad < 1.2) return;
    const r = rng(sd); r(); const ry = rad * (0.6 + r() * 0.4);
    ctx.save(); ctx.beginPath(); ctx.ellipse(c.sx, c.gy, rad, ry, r() * Math.PI, 0, Math.PI * 2);
    ctx.globalAlpha = 0.55; ctx.fillStyle = darkenHex(wash, 0.9 + (r() * 2 - 1) * 0.12); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
  };

  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (isCreek || material === 'gravel') {
    const rr = rng(5); let s = 0;
    while (s < total) {
      const step = Math.max(0.6, (0.8 + rr() * 0.8));
      const ncols = 1 + Math.floor(rr() * 3);
      for (let k = 0; k < ncols; k++) {
        const radFt = (0.28 + rr() * 0.5);
        stone(ptFt(s + (rr() * 2 - 1) * step * 0.3, (rr() * 2 - 1) * half * 0.82), radFt, seed + Math.round(s * 7) * 3 + k);
      }
      s += step;
    }
  } else {
    // Paved cell walk: flagstone (irregular), pavers/brick (running bond), concrete (slab joints).
    const cfg = material === 'flagstone' ? { rowFt: 2, cellFt: 2, bond: false, irregular: true, jit: 0.24, tone: 0.1, inkW: 1.2 }
      : material === 'brick' ? { rowFt: 0.9, cellFt: 0.9, bond: true, irregular: false, jit: 0.05, tone: 0.08, inkW: 0.8 }
      : material === 'concrete' ? { rowFt: 5, cellFt: 6, bond: false, irregular: false, jit: 0, tone: 0.05, inkW: 1 }
      : { rowFt: 2, cellFt: 2, bond: true, irregular: false, jit: 0.06, tone: 0.06, inkW: 1 }; // pavers
    const rr = rng(1); let s = 0, row = 0;
    while (s < total) {
      const rowLen = cfg.irregular ? cfg.rowFt * (0.75 + rr() * 0.55) : cfg.rowFt;
      const sA = s, sB = Math.min(s + rowLen, total);
      const ncols = cfg.irregular ? 1 + Math.floor(rr() * 3) : Math.max(1, Math.round(widthFt / cfg.cellFt));
      const cw = widthFt / ncols;
      const off = cfg.bond && row % 2 ? cw / 2 : 0;
      for (let u = -half - off; u < half - 1e-3; u += cw) {
        const u0 = Math.max(-half, u), u1 = Math.min(half, u + cw);
        if (u1 - u0 < cw * 0.3) continue;
        const cellSeed = seed + row * 131 + Math.round((u0 + half) * 7) + 1;
        const cr = rng(cellSeed);
        const jS = (sB - sA) * cfg.jit, jU = (u1 - u0) * cfg.jit, iS = (sB - sA) * 0.06, iU = (u1 - u0) * 0.06;
        const poly: Pt[] = [
          ptFt(sA + iS + (cr() * 2 - 1) * jS, u0 + iU + (cr() * 2 - 1) * jU),
          ptFt(sA + iS + (cr() * 2 - 1) * jS, u1 - iU + (cr() * 2 - 1) * jU),
          ptFt(sB - iS + (cr() * 2 - 1) * jS, u1 - iU + (cr() * 2 - 1) * jU),
          ptFt(sB - iS + (cr() * 2 - 1) * jS, u0 + iU + (cr() * 2 - 1) * jU),
        ];
        cell(poly, 1 + (cr() * 2 - 1) * cfg.tone, cellSeed + 3, cfg.inkW);
      }
      s += rowLen; row++;
    }
  }
  ctx.restore();
}

// ── House elevation glyph — pale line-art front facade at its depth ─────────────
function paintHouse(ctx: CanvasRenderingContext2D, houseFt: Pt[], doorFt: Pt | null, stage: Stage, stories: number) {
  const hc = centroid(houseFt);
  const proj = stage.project(hc[0], hc[1]);
  // Lateral extent of the house ring on the stage → facade width.
  let lMin = Infinity, lMax = -Infinity;
  for (const [x, y] of houseFt) { const p = stage.project(x, y); if (p.sx < lMin) lMin = p.sx; if (p.sx > lMax) lMax = p.sx; }
  const width = Math.max(40, lMax - lMin);
  const cxs = (lMin + lMax) / 2;
  const wallH = Math.max(1, stories) * 10 * proj.hs;   // stories × 10 ft, projected
  const base = proj.gy;
  const top = base - wallH;
  const roofH = Math.min(wallH * 0.6, width * 0.32);
  const x0 = cxs - width / 2, x1 = cxs + width / 2;
  const seed = seedXY(hc[0], hc[1]);

  ctx.save();
  // Faint hatched near-paper fill.
  ctx.beginPath(); ctx.rect(x0, top, width, wallH);
  ctx.fillStyle = '#f3f1ea'; ctx.globalAlpha = 0.92; ctx.fill();
  const hp = ctx.createPattern(hatchPattern('#cfc9ba', 'pencil', seed), 'repeat');
  if (hp) { ctx.globalAlpha = 0.16; ctx.fillStyle = hp; ctx.fill(); }
  ctx.globalAlpha = 1;
  // Roof triangle.
  ctx.beginPath(); ctx.moveTo(x0 - width * 0.03, top); ctx.lineTo(cxs, top - roofH); ctx.lineTo(x1 + width * 0.03, top); ctx.closePath();
  ctx.fillStyle = '#ece7db'; ctx.globalAlpha = 0.95; ctx.fill(); ctx.globalAlpha = 1;
  const rInk = '#7c766a';
  sketchStroke(ctx, [[x0 - width * 0.03, top], [cxs, top - roofH], [x1 + width * 0.03, top]], { seed: seed + 3, color: rInk, width: 1.6, wobble: 1.1, passes: 2, alpha: 0.55, overshoot: 2 });
  // Facade outline.
  sketchStroke(ctx, [[x0, base], [x0, top], [x1, top], [x1, base]], { seed: seed + 7, color: rInk, width: 1.6, wobble: 1, passes: 2, alpha: 0.55, overshoot: 2 });
  sketchStroke(ctx, [[x0, base], [x1, base]], { seed: seed + 11, color: rInk, width: 1.4, wobble: 0.8, passes: 1, alpha: 0.5, overshoot: 2 });

  // Door — at the door-point's lateral position (else centred), a rectangle to the ground.
  const doorW = Math.min(width * 0.16, wallH * 0.5), doorH = wallH * 0.6;
  let doorX = cxs;
  if (doorFt) { const dp = stage.project(doorFt[0], doorFt[1]); doorX = Math.max(x0 + doorW, Math.min(x1 - doorW, dp.sx)); }
  sketchStroke(ctx, [[doorX - doorW / 2, base], [doorX - doorW / 2, base - doorH], [doorX + doorW / 2, base - doorH], [doorX + doorW / 2, base]], { seed: seed + 17, color: rInk, width: 1.4, wobble: 0.7, passes: 1, alpha: 0.5, overshoot: 0, closed: false });

  // 2–4 seeded windows, avoiding the door column.
  let rs = seed >>> 0; const rand = () => { rs = Math.imul(rs ^ (rs >>> 15), rs | 1); rs ^= rs + Math.imul(rs ^ (rs >>> 7), rs | 61); return ((rs ^ (rs >>> 14)) >>> 0) / 0xffffffff; };
  const nWin = 2 + Math.floor(rand() * 3);
  const winW = Math.min(width * 0.13, wallH * 0.42), winH = winW * 1.15;
  const winY = top + wallH * 0.28;
  for (let i = 0; i < nWin; i++) {
    const t = (i + 0.5) / nWin;
    const wx = x0 + width * (0.1 + t * 0.8);
    if (Math.abs(wx - doorX) < doorW) continue;
    sketchStroke(ctx, [[wx - winW / 2, winY], [wx - winW / 2, winY + winH], [wx + winW / 2, winY + winH], [wx + winW / 2, winY], [wx - winW / 2, winY]], { seed: seed + 31 + i * 13, color: rInk, width: 1.2, wobble: 0.6, passes: 1, alpha: 0.45, overshoot: 0, closed: true });
    sketchStroke(ctx, [[wx, winY], [wx, winY + winH]], { seed: seed + 41 + i * 7, color: rInk, width: 1, wobble: 0.4, passes: 1, alpha: 0.4, overshoot: 0 });
  }
  ctx.restore();
}

// ── Public entry ────────────────────────────────────────────────────────────────
export function paintElevation(ctx: CanvasRenderingContext2D, wPx: number, hPx: number): void {
  // (a) paper + soft vignette.
  ctx.save();
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, wPx, hPx);
  const vg = ctx.createRadialGradient(wPx / 2, hPx * 0.52, Math.min(wPx, hPx) * 0.25, wPx / 2, hPx * 0.52, Math.max(wPx, hPx) * 0.7);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(60,54,44,0.12)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, wPx, hPx);
  ctx.restore();

  const read = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const plan = read('diyPlacementPlan') || {};
  const bf = read('diyBoundaryFinal') || {};
  const houseAttrs = read('diyHouseAttributes') || {};
  let plants: any[] = []; try { plants = JSON.parse(localStorage.getItem('diyPlantInstances') || '[]') || []; } catch { plants = []; }
  const stories = Math.max(1, houseAttrs?.stories || 1);

  // Feet coordinate system: buildCS(boundary lng/lat) → the SAME feet space the plan,
  // plants, and confirmed features all live in (see Yard3D / PlanSnapshot).
  const bLngLat: Pt[] = Array.isArray(bf.boundary) ? bf.boundary : [];
  if (bLngLat.length < 3) return; // just paper — nothing to draw
  const cs = buildCS(bLngLat);
  const boundaryFt: Pt[] = Array.isArray(plan.boundary) && plan.boundary.length >= 3
    ? plan.boundary
    : bLngLat.map(v => cs.toXY(v[0], v[1]));

  const feats: any[] = bf.confirmedFeatures || [];
  const houseRings: Pt[][] = feats.filter(f => f.keep && f.type === 'house' && (f.vertices?.length ?? 0) >= 3)
    .map(f => f.vertices.map((v: Pt) => cs.toXY(v[0], v[1])) as Pt[]);
  // Largest house ring drives the elevation + the house-ward vector.
  let houseFt: Pt[] | null = null, houseArea = 0;
  for (const r of houseRings) { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } a = Math.abs(a / 2); if (a > houseArea) { houseArea = a; houseFt = r; } }
  const houseCentroid = houseFt ? centroid(houseFt) : null;
  let doorFt: Pt | null = null;
  const dp = read('diyDoorPoint');
  if (dp) { const ll: Pt | null = Array.isArray(dp) ? (dp as Pt) : (typeof dp.lng === 'number' ? [dp.lng, dp.lat] : null); if (ll) doorFt = cs.toXY(ll[0], ll[1]); }

  const stage = buildStage(boundaryFt, houseCentroid, wPx, hPx, stories * 10);

  // (b) GROUND — primary open ground over the whole boundary, then lawn, beds, feature pads.
  const primaryColor = primaryColorOf(plan.primary);
  const primaryKind = primaryKindOf(plan.primary);
  const boundaryScr = projectRing(boundaryFt, stage);
  ctx.save();
  ctx.beginPath(); boundaryScr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
  ctx.clip();
  if (primaryKind === 'lawn') {
    paintSketchFeaturePoly(ctx, [boundaryScr], { fill: MATERIAL_COLOR.lawn, stroke: MATERIAL_COLOR.lawn, lineWidth: 1, tex: 'grass', active: false, ink: darkenHex(MATERIAL_COLOR.lawn, 0.62) });
  } else {
    paintSketchGroundFill(ctx, [boundaryScr], { color: primaryColor, kind: primaryKind === 'pebble' ? 'pebble' : 'mulch' });
  }
  ctx.restore();
  // A soft ground shadow along the front lip so the stage reads as sitting on paper.
  sketchStroke(ctx, boundaryScr, { seed: 5, color: 'rgba(70,62,48,0.4)', width: 1.6, wobble: 1.4, passes: 2, alpha: 0.5, overshoot: 0, closed: true });

  const zones: any[] = plan.zones || [];
  const beds: any[] = plan.beds || [];
  const drawZonePad = (z: any) => {
    const r = ringForShape(z); if (r.length < 3) return;
    const scr = projectRing(r, stage);
    const water = /water|pool|pond|spa/i.test(`${z.key || ''} ${z.label || ''}`);
    if (water) {
      ctx.save(); ctx.beginPath(); scr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.globalAlpha = 0.72; ctx.fillStyle = '#5fa8c8'; ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
      sketchStroke(ctx, scr, { seed: seedXY(r[0][0], r[0][1]), color: '#3f7d97', width: 1.4, wobble: 1.2, passes: 2, alpha: 0.55, closed: true });
      return;
    }
    const zc = zoneColorOf(z);
    const lawnInk = z.key === 'lawn' ? darkenHex((zc.slice(0, 7) || '#8daa6a'), 0.62) : null;
    paintSketchFeaturePoly(ctx, [scr], { fill: zc, stroke: zc, lineWidth: 1.5, tex: zoneTexOf(z), active: false, ink: lawnInk });
  };

  ctx.save();
  ctx.beginPath(); boundaryScr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
  for (const z of zones) if (z.key === 'lawn') drawZonePad(z);
  for (const b of beds) {
    const r = ringForShape(b); if (r.length < 3) continue;
    const color = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material] || '#8B6B4A';
    const tex = b.material === 'lawn' ? 'grass' : b.material === 'rock' ? 'rock' : 'mulch';
    paintSketchFeaturePoly(ctx, [projectRing(r, stage)], { fill: color, stroke: color, lineWidth: 1, tex, active: false, ink: null });
  }
  for (const z of zones) if (z.key !== 'lawn') drawZonePad(z);

  // (c) PATHS — stone-by-stone corridors through the projection.
  for (const p of (plan.paths || [])) {
    const pts: Pt[] = p.pts || []; if (pts.length < 2) continue;
    paintPathElevation(ctx, pts, Math.max(1.5, p.widthFt || 3), stage, { material: p.material, kind: p.kind, color: p.color, id: p.id });
  }
  ctx.restore();

  // (c2) EXISTING kept hardscape (walkways / sidewalks / driveways / patios) — pale pencil-hatched
  // pads, matching the aerial's treatment. Deliberately NOT clipped to the boundary (like the house):
  // a sidewalk strip that runs past the project edge should read continuous, not chopped.
  for (const f of feats) {
    if (!f.keep || f.type !== 'hardscape' || (f.vertices?.length ?? 0) < 3) continue;
    const r = f.vertices.map((v: Pt) => cs.toXY(v[0], v[1])) as Pt[];
    const scr = projectRing(r, stage);
    paintSketchFeaturePoly(ctx, [scr], { fill: '#d9d5c9', stroke: '#d9d5c9', lineWidth: 1.2, tex: null, active: false, ink: null });
    sketchStroke(ctx, scr, { seed: seedXY(r[0][0], r[0][1]), color: 'rgba(70,64,52,0.55)', width: 1.3, wobble: 1.2, passes: 2, alpha: 0.5, closed: true });
  }

  // (d) HOUSE elevation at its depth.
  if (houseFt) paintHouse(ctx, houseFt, doorFt, stage, stories);

  // (e) STANDING ITEMS back-to-front by depth — plants + gathering-zone furniture.
  type Item = { d: number; draw: () => void };
  const items: Item[] = [];
  for (const p of plants) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') continue;
    const pr = stage.project(p.x, p.y);
    const { foliage, bloom, evergreen } = resolveColors(p);
    const kind = plantKind(p, evergreen);
    const wPxP = Math.max(6, (p.widthFt || 2) * pr.hs);
    const hPxP = Math.max(8, (p.heightFt || 2) * pr.hs);
    const glyph: StandingPlant = { x: pr.sx, baseY: pr.gy, wPx: wPxP, hPx: hPxP, seed: seedXY(p.x, p.y), foliage, bloom, kind, evergreen };
    // A real botanical illustration for this species (e.g. fernbush) replaces the procedural symbol.
    const sprite = spriteFor(p.name);
    items.push({ d: pr.d, draw: () => {
      ctx.save(); ctx.globalAlpha = 0.09; ctx.fillStyle = '#2f4a2a';
      ctx.beginPath(); ctx.ellipse(pr.sx + wPxP * 0.06, pr.gy, wPxP * 0.5, wPxP * 0.16, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      if (sprite) drawSprite(ctx, sprite, pr.sx, pr.gy, wPxP, hPxP);
      else drawStandingPlant(ctx, glyph);
    } });
  }
  // Existing kept trees — standing tree glyphs sized from the confirmed canopy ring.
  for (const f of feats) {
    if (!f.keep || f.type !== 'tree' || (f.vertices?.length ?? 0) < 3) continue;
    const r = f.vertices.map((v: Pt) => cs.toXY(v[0], v[1])) as Pt[];
    const c = centroid(r);
    let area = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; area += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
    const canopyR = Math.max(3, Math.sqrt(Math.abs(area / 2) / Math.PI));
    const pr = stage.project(c[0], c[1]);
    const wPxT = Math.max(10, canopyR * 2 * pr.hs);
    const hPxT = Math.max(12, Math.max(14, canopyR * 2.2) * pr.hs); // height unknown → ~2.2× canopy radius
    const glyph: StandingPlant = { x: pr.sx, baseY: pr.gy, wPx: wPxT, hPx: hPxT, seed: seedXY(c[0], c[1]), foliage: '#78976b', bloom: null, kind: 'tree', evergreen: false };
    items.push({ d: pr.d, draw: () => {
      ctx.save(); ctx.globalAlpha = 0.09; ctx.fillStyle = '#2f4a2a';
      ctx.beginPath(); ctx.ellipse(pr.sx + wPxT * 0.06, pr.gy, wPxT * 0.5, wPxT * 0.16, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      drawStandingPlant(ctx, glyph);
    } });
  }
  // Existing kept structures (shed, gazebo, …) — a simple pale box elevation at their depth.
  for (const f of feats) {
    if (!f.keep || f.type !== 'structure' || (f.vertices?.length ?? 0) < 3) continue;
    const r = f.vertices.map((v: Pt) => cs.toXY(v[0], v[1])) as Pt[];
    const c = centroid(r);
    const pr = stage.project(c[0], c[1]);
    let lMin = Infinity, lMax = -Infinity;
    for (const [x, y] of r) { const q = stage.project(x, y); if (q.sx < lMin) lMin = q.sx; if (q.sx > lMax) lMax = q.sx; }
    const wPxS = Math.max(20, lMax - lMin);
    const hPxS = Math.max(16, 8 * pr.hs); // ~8 ft eaves
    const seed = seedXY(c[0], c[1]);
    items.push({ d: pr.d, draw: () => {
      ctx.save(); ctx.globalAlpha = 0.09; ctx.fillStyle = '#2f4a2a';
      ctx.beginPath(); ctx.ellipse(pr.sx, pr.gy, wPxS * 0.55, wPxS * 0.14, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      const x0 = pr.sx - wPxS / 2, y0 = pr.gy - hPxS;
      ctx.save(); ctx.fillStyle = '#efede6';
      ctx.fillRect(x0, y0, wPxS, hPxS);
      // Shallow roof cap so it reads as a building, not a slab.
      ctx.beginPath(); ctx.moveTo(x0 - wPxS * 0.05, y0); ctx.lineTo(pr.sx, y0 - hPxS * 0.38); ctx.lineTo(x0 + wPxS * 1.05, y0); ctx.closePath();
      ctx.fillStyle = '#dcd9d0'; ctx.fill(); ctx.restore();
      const box: Pt[] = [[x0, y0], [x0 + wPxS, y0], [x0 + wPxS, pr.gy], [x0, pr.gy]];
      sketchStroke(ctx, box, { seed, color: 'rgba(70,64,52,0.6)', width: 1.3, wobble: 1.1, passes: 2, alpha: 0.55, closed: true });
      sketchStroke(ctx, [[x0 - wPxS * 0.05, y0], [pr.sx, y0 - hPxS * 0.38], [x0 + wPxS * 1.05, y0]], { seed: seed + 7, color: 'rgba(70,64,52,0.6)', width: 1.3, wobble: 1.1, passes: 2, alpha: 0.55, closed: false });
    } });
  }
  for (const z of zones) {
    const fk = furnitureKind(z); if (!fk) continue;
    const r = ringForShape(z); if (r.length < 3) continue;
    const c = centroid(r);
    const pr = stage.project(c[0], c[1]);
    // Footprint size from the zone's lateral & depth extents (feet), projected.
    let lMin = Infinity, lMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (const [x, y] of r) { const q = stage.project(x, y); if (q.sx < lMin) lMin = q.sx; if (q.sx > lMax) lMax = q.sx; if (q.gy < dMin) dMin = q.gy; if (q.gy > dMax) dMax = q.gy; }
    const wPxF = Math.max(24, (lMax - lMin) * 0.62);
    const hPxF = Math.max(18, wPxF * 0.5);
    const glyph: FurnitureGlyph = { x: pr.sx, baseY: pr.gy, wPx: wPxF, hPx: hPxF, seed: seedXY(c[0], c[1]), kind: fk };
    items.push({ d: pr.d, draw: () => {
      ctx.save(); ctx.globalAlpha = 0.09; ctx.fillStyle = '#2f4a2a';
      ctx.beginPath(); ctx.ellipse(pr.sx + wPxF * 0.06, pr.gy, wPxF * 0.55, wPxF * 0.18, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      drawFurnitureGlyph(ctx, glyph);
    } });
  }
  items.sort((a, b) => b.d - a.d); // back (large d) first
  for (const it of items) it.draw();
}
