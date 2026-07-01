import * as turf from '@turf/turf';
import { supabase } from '../lib/supabase';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

// ── Style targets ───────────────────────────────────────────────────────────────
// TOTAL distinct species across the whole garden (all layers combined), by style.
// Naturalistic styles read better with more variety; clean styles with less.
export type DbStyle = 'modern' | 'traditional' | 'desert' | 'whimsical';

// min/max bound how far the user can trim or grow the palette; `target` is what we seed.
export const STYLE_TOTAL_SPECIES: Record<DbStyle, { min: number; target: number; max: number }> = {
  modern:      { min: 6,  target: 10, max: 13 }, // cleaner, more repetitive palette
  desert:      { min: 6,  target: 10, max: 13 }, // sparse, sculptural
  traditional: { min: 8,  target: 11, max: 14 }, // tidy, balanced
  whimsical:   { min: 11, target: 15, max: 19 }, // layered, cottage-y abundance
};

export function mapStyle(prefsStyle: string): DbStyle {
  switch (prefsStyle) {
    case 'modern_structured': return 'modern';
    case 'desert_minimal':    return 'desert';
    case 'natural_wild':      return 'whimsical';
    case 'traditional':       return 'traditional';
    default:                  return 'traditional';
  }
}

// Trees target a share of CANOPY COVERAGE of the yard at maturity (not a fixed count),
// so larger trees mean fewer trees and the yard isn't packed. Tunable.
export const TREE_CANOPY_COVERAGE_GOAL = 0.30;       // ~30% shaded at maturity
export const SHADE_CANOPY_COVERAGE_GOAL = 0.50;      // when "shade" is a priority

// ── Space budget ─────────────────────────────────────────────────────────────────
// Plants compete for a shared, shrinking pool of planting area, consumed top-down
// (trees → large shrubs → small shrubs → groundcover). These are tunable proxies.
export const PLANT_PACKING_EFFICIENCY = 0.6; // usable fraction of bed area (spacing/access between plants)
// Typical individuals planted per species, by layer (a single species reads as a drift).
export const LAYER_QTY_PER_SPECIES: Record<string, number> = { large_shrub: 3, small_shrub: 5, groundcover: 15 };
// Stand-in mature widths (ft) for the placeholder non-tree layers (real widths come from the DB later).
export const TYPICAL_WIDTH_FT: Record<string, number> = { large_shrub: 8, small_shrub: 3, groundcover: 1.5 };
// Mature canopy footprint (sq ft) of one plant.
export function canopyFootprintFt(matureWidthFt: number): number { const r = matureWidthFt / 2; return Math.PI * r * r; }

export interface PlantRow {
  id: number;
  botanical_name: string; // scientific (latin) name
  common_name: string;    // common name — surfaced to users
  type: string;
  use: string;
  is_evergreen: boolean | string;
  height_in: number;
  width_in: number;
  min_zone: number;
  max_zone: number;
  sun_requirement: string;
  water_need: string;
  style: string;          // comma-separated tokens
  under_planting?: boolean | string; // can be planted under canopies → may overhang the boundary
}

// Under-planting species (groundcover, shade-tolerant fillers) may overhang the property
// line; everything else must sit fully inside the boundary.
export function isUnderPlanting(row: { under_planting?: boolean | string }): boolean {
  const v = row.under_planting;
  return v === true || v === 'true' || v === 'TRUE' || v === 't' || v === 1 as any;
}

export interface TreeCandidate extends PlantRow {
  matureWidthFt: number;
  matureHeightFt: number;
  sizeLabel: string;
}
export type SpeciesCandidate = TreeCandidate; // same shape for every layer

// ── Layers ───────────────────────────────────────────────────────────────────────
// Plant flow is walked through by size. Shrub tiers are derived from mature height
// (no stored category): large ≥ 6 ft, mid (medium + small) < 6 ft.
export type Layer = 'tree' | 'large_shrub' | 'shrub' | 'groundcover';
const LARGE_SHRUB_MIN_IN = 72; // 6 ft

export interface LayerSelection {
  layer: Layer;
  dbStyle: DbStyle;
  zone?: number;
  candidates: SpeciesCandidate[];
  styleMatched: number;
  zoneMatched: number;
}

function toCandidate(row: PlantRow): SpeciesCandidate {
  const matureWidthFt = Number(row.width_in) / 12;
  const matureHeightFt = Number(row.height_in) / 12;
  return { ...row, matureWidthFt, matureHeightFt, sizeLabel: `${Math.round(matureHeightFt)} ft H · ${Math.round(matureWidthFt)} ft W` };
}
function zoneOk(row: PlantRow, zone?: number): boolean {
  return zone == null || (Number(row.min_zone) <= zone && zone <= Number(row.max_zone));
}
function sizeOk(layer: Layer, row: PlantRow): boolean {
  const h = Number(row.height_in);
  if (layer === 'large_shrub') return h >= LARGE_SHRUB_MIN_IN;
  if (layer === 'shrub') return h < LARGE_SHRUB_MIN_IN;
  return true;
}

export interface TreeSelection {
  dbStyle: DbStyle;
  projectAreaFt: number;
  zone?: number;           // USDA hardiness zone used for filtering (if known)
  targetTotal: number;     // trees we'd ideally have, total
  existingCounted: number; // existing trees whose canopy reaches into the yard
  targetToPlant: number;   // new trees to add (target − existing, floored at 0)
  candidates: TreeCandidate[];
  styleMatched: number;    // # trees matching style (before zone/fit)
  zoneMatched: number;     // # also within the hardiness zone
  fitCount: number;        // # that also fit at full mature size (candidates falls back to zoneMatched if 0)
}

// ── Local coordinate system (lat/lng ⇄ feet), matching the placement page ────────
interface CS { toXY: (lng: number, lat: number) => [number, number]; }
function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avg = (minLat + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return { toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT] };
}

// ── Planar geometry helpers (coords already in feet) ─────────────────────────────
function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
  return Math.abs(a / 2);
}
function centroid(r: [number, number][]): [number, number] {
  let x = 0, y = 0;
  for (const [px, py] of r) { x += px; y += py; }
  return [x / r.length, y / r.length];
}
function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function closeRing(r: [number, number][]): [number, number][] {
  if (r.length < 3) return r;
  const f = r[0], l = r[r.length - 1];
  return (f[0] === l[0] && f[1] === l[1]) ? r : [...r, f];
}
function pointInRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function distToPolygon(px: number, py: number, ring: [number, number][]): number {
  if (pointInRing(px, py, ring)) return 0;
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    min = Math.min(min, segDist(px, py, a[0], a[1], b[0], b[1]));
  }
  return min;
}
// Distance from a point to the nearest boundary edge (non-zero for interior points).
function minEdgeDist(px: number, py: number, ring: [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; min = Math.min(min, segDist(px, py, a[0], a[1], b[0], b[1])); }
  return min;
}

interface ExistingTree { cx: number; cy: number; r: number }

// Does a circle of radius R fit anywhere in the yard such that it's ≥R from the house
// (canopy won't reach the house) and clears every existing tree's canopy?
function fitsSomewhere(R: number, boundaryFt: [number, number][], houses: [number, number][][], trees: ExistingTree[]): boolean {
  if (boundaryFt.length < 3) return false;
  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(2, span / 60); // ~60 samples across the longer axis
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      if (!pointInRing(x, y, boundaryFt)) continue;
      let ok = true;
      for (const h of houses) { if (distToPolygon(x, y, h) < R) { ok = false; break; } }
      if (!ok) continue;
      for (const t of trees) { if (Math.hypot(x - t.cx, y - t.cy) < R + t.r) { ok = false; break; } }
      if (ok) return true;
    }
  }
  return false;
}

// `style` is multi-select (e.g. "traditional, whimsical", or a text[] array) — match by
// CONTAINS, not equality. The four style tokens aren't substrings of each other, so a plain
// substring check on the joined value is safe.
function styleMatches(rowStyle: unknown, target: DbStyle): boolean {
  const joined = Array.isArray(rowStyle) ? rowStyle.join(',') : String(rowStyle ?? '');
  return joined.toLowerCase().includes(target);
}

/**
 * Suggest tree species for the user's yard.
 *  - Target = 2 trees / 1000 sq ft of project area (rounded down), minus any existing
 *    trees whose canopy reaches into the boundary.
 *  - Candidates are style-matched DB trees that can physically fit: ≥ mature radius
 *    from the house, and clear of existing tree canopies at mature width.
 */
export async function selectTrees(opts: {
  prefsStyle: string;
  boundary: [number, number][];     // lat/lng polygon (diyBoundaryFinal.boundary)
  existing: ConfirmedFeature[];     // diyBoundaryFinal.confirmedFeatures
  projectAreaFt?: number;           // optional override (else derived from boundary)
  zone?: number;                    // USDA hardiness zone number (e.g. 7)
  coverageGoal?: number;            // canopy coverage target (default 30%, 50% for shade)
}): Promise<TreeSelection> {
  const dbStyle = mapStyle(opts.prefsStyle);

  const cs = opts.boundary.length >= 3 ? buildCS(opts.boundary) : null;
  const boundaryFt = cs ? opts.boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][] : [];
  const projectAreaFt = opts.projectAreaFt && opts.projectAreaFt > 0 ? opts.projectAreaFt : ringArea(boundaryFt);

  // Existing structures + trees, in feet.
  const houses: [number, number][][] = [];
  const trees: ExistingTree[] = [];
  let existingCounted = 0;
  let existingCanopyFt = 0; // canopy area of existing trees that reach into the yard
  if (cs) {
    const bdyPoly = boundaryFt.length >= 3 ? turf.polygon([closeRing(boundaryFt)]) : null;
    for (const f of opts.existing) {
      if (!f.keep || f.vertices.length < 3) continue;
      const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
      if (f.type === 'house') { houses.push(ring); continue; }
      if (f.type === 'tree') {
        const r = Math.sqrt(ringArea(ring) / Math.PI);
        const [cx, cy] = centroid(ring);
        trees.push({ cx, cy, r });
        // Count it only if its canopy actually reaches into the project boundary.
        if (bdyPoly) {
          try {
            if (turf.intersect(turf.polygon([closeRing(ring)]), bdyPoly)) { existingCounted++; existingCanopyFt += Math.PI * r * r; }
          } catch { /* ignore degenerate */ }
        }
      }
    }
  }

  // Style-matched trees from the database.
  const { data, error } = await supabase
    .from('plant_database')
    .select('*')
    .in('type', ['deciduous tree', 'evergreen tree']);
  if (error) throw error;

  const rows = (data as PlantRow[] | null) ?? [];
  const styled = rows.filter(row => styleMatches(row.style, dbStyle));
  // Hardiness: keep trees whose zone range covers the site (skip if zone unknown).
  const zoned = styled.filter(row => opts.zone == null || (Number(row.min_zone) <= opts.zone && opts.zone <= Number(row.max_zone)));
  const mapped: TreeCandidate[] = zoned
    .filter(row => Number(row.width_in) > 0)
    .map(row => {
      const matureWidthFt = Number(row.width_in) / 12;
      const matureHeightFt = Number(row.height_in) / 12;
      return { ...row, matureWidthFt, matureHeightFt, sizeLabel: `${Math.round(matureHeightFt)} ft H · ${Math.round(matureWidthFt)} ft W` };
    });
  // Prefer trees that fit at full mature size (clear of house + existing canopies); but if
  // none fit (e.g. a tight yard vs. large species), still offer the style/zone matches —
  // exact placement is resolved later, and the space budget already flags tightness.
  const fitted = boundaryFt.length < 3 ? mapped : mapped.filter(c => fitsSomewhere(c.matureWidthFt / 2, boundaryFt, houses, trees));
  const candidates = fitted.length ? fitted : mapped;

  // Tree count derives from a canopy-coverage goal, using the typical mature canopy of the
  // viable species — so big trees mean fewer trees, and the yard keeps open space.
  const avgCanopy = candidates.length
    ? candidates.reduce((s, c) => s + canopyFootprintFt(c.matureWidthFt), 0) / candidates.length
    : canopyFootprintFt(25);
  const targetCanopyFt = (opts.coverageGoal ?? TREE_CANOPY_COVERAGE_GOAL) * projectAreaFt;
  const targetTotal = avgCanopy > 0 ? Math.round(targetCanopyFt / avgCanopy) : 0;
  const targetToPlant = Math.max(0, Math.round((targetCanopyFt - existingCanopyFt) / avgCanopy));

  return {
    dbStyle, projectAreaFt, zone: opts.zone, targetTotal, existingCounted, targetToPlant, candidates,
    styleMatched: styled.length, zoneMatched: zoned.length, fitCount: fitted.length,
  };
}

/**
 * Suggest species for a non-tree layer (large shrubs, mid/small shrubs, groundcover),
 * filtered by style + hardiness zone + size tier. Pure species selection — spatial fit
 * for the structural layers is handled by the page's area budget / placement step.
 */
export async function selectLayer(layer: Layer, opts: { prefsStyle: string; zone?: number }): Promise<LayerSelection> {
  const dbStyle = mapStyle(opts.prefsStyle);
  let q = supabase.from('plant_database').select('*');
  if (layer === 'groundcover') q = q.ilike('use', '%groundcover%');
  else q = q.eq('type', 'shrub');
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data as PlantRow[] | null) ?? [];
  const styled = rows.filter(r => styleMatches(r.style, dbStyle) && sizeOk(layer, r) && Number(r.width_in) > 0);
  const zoned = styled.filter(r => zoneOk(r, opts.zone));
  // Fall back to style matches if the zone filter empties the list (better than nothing).
  const candidates = (zoned.length ? zoned : styled).map(toCandidate);
  return { layer, dbStyle, zone: opts.zone, candidates, styleMatched: styled.length, zoneMatched: zoned.length };
}

/**
 * Greedily place foundation plants into the open yard — each spread out, ≥ its radius
 * from the house, and clear of existing canopies / each other. `fixed` positions (e.g.
 * ones the user dragged) are preserved. Returns a position per plant id (in feet).
 */
export function placeFoundation(opts: {
  boundary: [number, number][];
  existing: ConfirmedFeature[];
  plants: { id: string; r: number; under?: boolean }[]; // under = under-planting (may overhang boundary)
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] }; // the placement plan (ft rings) for plantable-area test
  fixed?: Record<string, { x: number; y: number }>;
}): Record<string, { x: number; y: number }> {
  const { plants, fixed = {} } = opts;
  const out: Record<string, { x: number; y: number }> = {};
  const cs = opts.boundary.length >= 3 ? buildCS(opts.boundary) : null;
  if (!cs) { for (const p of plants) out[p.id] = fixed[p.id] || { x: 0, y: 0 }; return out; }
  const boundaryFt = opts.boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][];
  const houses: [number, number][][] = [];
  const trees: { cx: number; cy: number; r: number }[] = [];
  for (const f of opts.existing) {
    if (!f.keep || f.vertices.length < 3) continue;
    const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
    if (f.type === 'house' || f.type === 'hardscape') houses.push(ring);
    else if (f.type === 'tree') { const [cx, cy] = centroid(ring); trees.push({ cx, cy, r: Math.sqrt(ringArea(ring) / Math.PI) }); }
  }

  // Plantable area = planting beds + open ground cover (boundary minus features, lawn,
  // non-planted beds, walkways and structures). Default placement must land here.
  const plan = opts.plan || {};
  const ringOf = (s: any): [number, number][] | null => (s.ring && s.ring.length >= 3) ? s.ring : null;
  const plantedBeds = (plan.beds || []).filter((b: any) => b.material !== 'lawn' && b.type === 'planted').map(ringOf).filter(Boolean) as [number, number][][];
  const exFeatures = (plan.zones || []).map(ringOf).filter(Boolean) as [number, number][][]; // features + lawn
  const exBeds = (plan.beds || []).filter((b: any) => !(b.material !== 'lawn' && b.type === 'planted')).map(ringOf).filter(Boolean) as [number, number][][]; // unplanted / lawn beds
  const paths = (plan.paths || []).filter((p: any) => (p.pts || []).length >= 2);
  const distToPath = (x: number, y: number, p: any): number => { let m = Infinity; const pts = p.pts; for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])); return m; };
  const isPlantable = (x: number, y: number): boolean => {
    if (!pointInRing(x, y, boundaryFt)) return false;
    for (const r of plantedBeds) if (pointInRing(x, y, r)) return true; // planting bed → always plantable
    for (const o of houses) if (pointInRing(x, y, o)) return false;
    for (const p of paths) if (distToPath(x, y, p) <= (p.widthFt || 3) / 2) return false;
    for (const r of exFeatures) if (pointInRing(x, y, r)) return false; // features + lawn
    for (const r of exBeds) if (pointInRing(x, y, r)) return false;     // unplanted beds
    return true; // open ground cover
  };

  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = Math.max(2, Math.max(maxX - minX, maxY - minY) / 44);
  const placed: { x: number; y: number; r: number }[] = [];
  for (const p of plants) if (fixed[p.id]) { out[p.id] = fixed[p.id]; placed.push({ ...fixed[p.id], r: p.r }); }
  for (const p of plants) {
    if (out[p.id]) continue;
    let best: { x: number; y: number } | null = null, bestScore = -Infinity;
    const score = (x: number, y: number, hard: boolean): number | null => {
      if (!isPlantable(x, y)) return null; // NEVER place outside plantable areas
      let clear = Infinity;
      // Non-under-planting species must sit fully inside the boundary (canopy can't overhang).
      if (!p.under) { const e = minEdgeDist(x, y, boundaryFt); if (hard && e < p.r) return null; clear = Math.min(clear, e - p.r); }
      for (const h of houses) { const d = distToPolygon(x, y, h); if (hard && d < p.r) return null; clear = Math.min(clear, d - p.r); }
      for (const t of trees) { const d = Math.hypot(x - t.cx, y - t.cy) - (p.r + t.r); if (hard && d < 0) return null; clear = Math.min(clear, d); }
      for (const q of placed) { const d = Math.hypot(x - q.x, y - q.y) - (p.r + q.r); if (hard && d < 0) return null; clear = Math.min(clear, d); }
      return clear;
    };
    for (const hard of [true, false]) {
      for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) {
        const sc = score(x, y, hard);
        if (sc != null && sc > bestScore) { bestScore = sc; best = { x, y }; }
      }
      if (best) break;
      bestScore = -Infinity;
    }
    // Last resort: any plantable spot (ignore spacing) before falling back to centre.
    if (!best) { outer: for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) if (isPlantable(x, y)) { best = { x, y }; break outer; } }
    if (!best) best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    out[p.id] = best; placed.push({ ...best, r: p.r });
  }
  return out;
}

/**
 * General plant placement. Expands no further — the caller passes ready instances grouped
 * into drifts (a "drift" = same-species cluster). Places top-down (trees → large shrubs →
 * shrubs → groundcover): structural layers spread out, clear of the house/existing canopies
 * and each other and fully inside the boundary; understory layers cluster as drifts and may
 * tuck under the canopy. Everything stays in plantable areas. Dragged positions are kept.
 */
// Front-of-bed grading: "front" is the direction from the house toward the yard centre.
// Returns a unit direction + the projection range across the yard depth (null if no house or
// the house and yard share a centre). Shared by placePlan and the map's front-edge overlay.
export const FRONT_NO_TALL = 0.7; // tall plants forbidden in the front ~30% (by depth)
export function computeFrontGeom(boundaryFt: [number, number][], houses: [number, number][][]): { dir: [number, number]; min: number; range: number } | null {
  if (boundaryFt.length < 3 || !houses.length) return null;
  let hx = 0, hy = 0;
  for (const h of houses) { const c = centroid(h); hx += c[0]; hy += c[1]; }
  hx /= houses.length; hy /= houses.length;
  // Front edge = the boundary edge whose midpoint is farthest from the house. The front
  // direction points from the yard centre toward that edge (more stable than house→centre).
  let frontMid: [number, number] | null = null, bestD = -1;
  for (let i = 0; i < boundaryFt.length; i++) {
    const a = boundaryFt[i], b = boundaryFt[(i + 1) % boundaryFt.length];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const d = Math.hypot(mx - hx, my - hy);
    if (d > bestD) { bestD = d; frontMid = [mx, my]; }
  }
  if (!frontMid) return null;
  const yc = centroid(boundaryFt);
  const dx = frontMid[0] - yc[0], dy = frontMid[1] - yc[1], len = Math.hypot(dx, dy);
  if (len <= 2) return null;
  const dir: [number, number] = [dx / len, dy / len];
  const projs = boundaryFt.map(p => p[0] * dir[0] + p[1] * dir[1]);
  const min = Math.min(...projs);
  return { dir, min, range: (Math.max(...projs) - min) || 1 };
}

// Per-bed front grading. Splits the plantable area into connected regions (anything divided
// by a path/hardscape becomes its own bed), then within EACH region keeps the front 30% low
// (relative to that region's own depth toward the street) and treats a region too shallow to
// have a back (e.g. a parkstrip) as all-low. Returns a point tester + the no-tall cells (ft)
// for drawing. Shared by placePlan and the map overlay so they agree exactly.
const MIN_TALL_REGION_DEPTH_FT = 10; // a bed shallower than this (front-to-back) is all low plants
export function buildFrontZones(
  boundary: [number, number][],
  existing: ConfirmedFeature[],
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] },
): { noTall: (x: number, y: number) => boolean; cells: { x: number; y: number; w: number }[]; step: number; regionCount: number; regionDepths: number[] } | null {
  const cs = boundary.length >= 3 ? buildCS(boundary) : null;
  if (!cs) return null;
  const boundaryFt = boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][];
  const houses: [number, number][][] = [], houseOnly: [number, number][][] = [];
  for (const f of existing) {
    if (!f.keep || f.vertices.length < 3) continue;
    const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
    if (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure') houses.push(ring);
    if (f.type === 'house') houseOnly.push(ring);
  }
  const fg = computeFrontGeom(boundaryFt, houseOnly.length ? houseOnly : houses);
  if (!fg) return null;
  // Plantable test (mirrors placePlan).
  const p = plan || {};
  const ringOf = (s: any): [number, number][] | null => (s.ring && s.ring.length >= 3) ? s.ring : null;
  const plantedBeds = (p.beds || []).filter((b: any) => b.material !== 'lawn' && b.type === 'planted').map(ringOf).filter(Boolean) as [number, number][][];
  const exFeatures = (p.zones || []).map(ringOf).filter(Boolean) as [number, number][][];
  const exBeds = (p.beds || []).filter((b: any) => !(b.material !== 'lawn' && b.type === 'planted')).map(ringOf).filter(Boolean) as [number, number][][];
  const paths = (p.paths || []).filter((pp: any) => (pp.pts || []).length >= 2);
  const distToPath = (x: number, y: number, pp: any): number => { let m = Infinity; const pts = pp.pts; for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])); return m; };
  const isPlantable = (x: number, y: number): boolean => {
    if (!pointInRing(x, y, boundaryFt)) return false;
    for (const r of plantedBeds) if (pointInRing(x, y, r)) return true;
    for (const o of houses) if (pointInRing(x, y, o)) return false;
    for (const pp of paths) if (distToPath(x, y, pp) <= (pp.widthFt || 3) / 2) return false;
    for (const r of exFeatures) if (pointInRing(x, y, r)) return false;
    for (const r of exBeds) if (pointInRing(x, y, r)) return false;
    return true;
  };
  // Grid + flood-fill into connected plantable regions.
  const xs = boundaryFt.map(q => q[0]), ys = boundaryFt.map(q => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = Math.max(1.5, Math.max(maxX - minX, maxY - minY) / 60);
  const nx = Math.floor((maxX - minX) / step) + 1, ny = Math.floor((maxY - minY) / step) + 1;
  const cellCX = (ix: number) => minX + ix * step + step / 2, cellCY = (iy: number) => minY + iy * step + step / 2;
  const mask = new Uint8Array(nx * ny);
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) if (isPlantable(cellCX(ix), cellCY(iy))) mask[ix * ny + iy] = 1;
  const reg = new Int32Array(nx * ny).fill(-1);
  const regions: { min: number; max: number }[] = [];
  const proj = (x: number, y: number) => x * fg.dir[0] + y * fg.dir[1];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    if (!mask[ix * ny + iy] || reg[ix * ny + iy] >= 0) continue;
    const rid = regions.length; let mn = Infinity, mx = -Infinity;
    const stack = [[ix, iy]]; reg[ix * ny + iy] = rid;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      const pv = proj(cellCX(cx), cellCY(cy)); if (pv < mn) mn = pv; if (pv > mx) mx = pv;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = cx + dx, b = cy + dy;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        if (mask[a * ny + b] && reg[a * ny + b] < 0) { reg[a * ny + b] = rid; stack.push([a, b]); }
      }
    }
    regions.push({ min: mn, max: mx });
  }
  const noTall = (x: number, y: number): boolean => {
    const ix = Math.floor((x - minX) / step), iy = Math.floor((y - minY) / step);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return false;
    const rid = reg[ix * ny + iy]; if (rid < 0) return false;
    const rr = regions[rid], depth = rr.max - rr.min;
    if (depth < MIN_TALL_REGION_DEPTH_FT) return true;            // shallow bed → all low
    return (proj(x, y) - rr.min) / (depth || 1) > FRONT_NO_TALL;  // front 30% of this bed
  };
  const cells: { x: number; y: number; w: number }[] = [];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) if (mask[ix * ny + iy] && noTall(cellCX(ix), cellCY(iy))) cells.push({ x: minX + ix * step, y: minY + iy * step, w: step });
  return { noTall, cells, step, regionCount: regions.length, regionDepths: regions.map(r => Math.round(r.max - r.min)) };
}

type PlaceInstance = { id: string; layer: Layer; r: number; under?: boolean; drift: string; tall?: boolean; sun?: string[] };
export function placePlan(opts: {
  boundary: [number, number][];
  existing: ConfirmedFeature[];
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] };
  instances: PlaceInstance[];
  fixed?: Record<string, { x: number; y: number }>;
  allowTallFront?: boolean; // when true (privacy screening requested), tall plants may go to the front edge
  sunAt?: (x: number, y: number) => string; // sun category ('full'|'part'|'shade') at a feet position
}): Record<string, { x: number; y: number }> {
  const { instances, fixed = {}, allowTallFront = false, sunAt } = opts;
  // Each drift is a single species → single sun tolerance; a plant only goes where sun matches.
  const driftSun = new Map<string, string[] | undefined>();
  for (const i of instances) if (!driftSun.has(i.drift)) driftSun.set(i.drift, i.sun);
  const sunOkAt = (x: number, y: number, drift: string): boolean => {
    if (!sunAt) return true;
    const allowed = driftSun.get(drift);
    return !allowed || allowed.length === 0 || allowed.includes(sunAt(x, y));
  };
  const out: Record<string, { x: number; y: number }> = {};
  const cs = opts.boundary.length >= 3 ? buildCS(opts.boundary) : null;
  if (!cs) { for (const i of instances) out[i.id] = fixed[i.id] || { x: 0, y: 0 }; return out; }
  const boundaryFt = opts.boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][];
  const houses: [number, number][][] = [];     // house + hardscape + structure (no planting; canopy clears them)
  const houseOnly: [number, number][][] = [];   // actual house (front-of-bed direction)
  const existTrees: { cx: number; cy: number; r: number }[] = [];
  for (const f of opts.existing) {
    if (!f.keep || f.vertices.length < 3) continue;
    const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
    if (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure') houses.push(ring);
    if (f.type === 'house') houseOnly.push(ring);
    if (f.type === 'tree') { const [cx, cy] = centroid(ring); existTrees.push({ cx, cy, r: Math.sqrt(ringArea(ring) / Math.PI) }); }
  }
  // Plantable test (same rule as placeFoundation).
  const plan = opts.plan || {};
  const ringOf = (s: any): [number, number][] | null => (s.ring && s.ring.length >= 3) ? s.ring : null;
  const plantedBeds = (plan.beds || []).filter((b: any) => b.material !== 'lawn' && b.type === 'planted').map(ringOf).filter(Boolean) as [number, number][][];
  const exFeatures = (plan.zones || []).map(ringOf).filter(Boolean) as [number, number][][];
  const exBeds = (plan.beds || []).filter((b: any) => !(b.material !== 'lawn' && b.type === 'planted')).map(ringOf).filter(Boolean) as [number, number][][];
  const paths = (plan.paths || []).filter((p: any) => (p.pts || []).length >= 2);
  const distToPath = (x: number, y: number, p: any): number => { let m = Infinity; const pts = p.pts; for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])); return m; };
  const isPlantable = (x: number, y: number): boolean => {
    if (!pointInRing(x, y, boundaryFt)) return false;
    for (const r of plantedBeds) if (pointInRing(x, y, r)) return true;
    for (const o of houses) if (pointInRing(x, y, o)) return false;
    for (const p of paths) if (distToPath(x, y, p) <= (p.widthFt || 3) / 2) return false;
    for (const r of exFeatures) if (pointInRing(x, y, r)) return false;
    for (const r of exBeds) if (pointInRing(x, y, r)) return false;
    return true;
  };
  // A plant's whole CANOPY (radius r) must clear every non-plantable obstacle — house,
  // hardscape, structures, placed features, walkways, and unplanted beds — not just its centre.
  const obstaclePolys = [...houses, ...exFeatures, ...exBeds];
  const clearOfObstacles = (x: number, y: number, r: number): boolean => {
    for (const o of obstaclePolys) if (distToPolygon(x, y, o) < r) return false;
    for (const p of paths) if (distToPath(x, y, p) < r + (p.widthFt || 3) / 2) return false;
    return true;
  };

  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = Math.max(2, Math.max(maxX - minX, maxY - minY) / 44);
  const rank: Record<Layer, number> = { tree: 0, large_shrub: 1, shrub: 2, groundcover: 3 };
  const understory = (l: Layer) => l === 'shrub' || l === 'groundcover';

  // Two tiers: OVERSTORY (trees — high canopy, you can plant beneath) and GROUND
  // (large shrubs + shrubs + groundcover — they share the ground plane and must NOT pile
  // on each other). Within a tier, plants of the SAME drift overlap densely (a massed
  // drift); plants from DIFFERENT plantings only just touch — so groundcover fills the
  // open ground around/in front of shrubs rather than double-planting underneath them.
  // Across tiers there's no constraint (ground plants may sit under a tree canopy).
  const SAME_DRIFT_OVERLAP = 0.6; // dense mass within one species' drift
  const DIFF_OVERLAP = 0.9;       // different plantings barely overlap (≈ touching)
  type Tier = 'over' | 'ground';
  const tierOf = (l: Layer): Tier => (l === 'tree' ? 'over' : 'ground');
  const placed: { x: number; y: number; r: number; tier: Tier; drift: string }[] = [];
  const driftAnchors: { x: number; y: number }[] = []; // to spread drifts apart

  // Honour fixed positions; existing trees occupy the overstory tier (each its own group).
  for (const i of instances) if (fixed[i.id]) { out[i.id] = fixed[i.id]; placed.push({ ...fixed[i.id], r: i.r, tier: tierOf(i.layer), drift: i.drift }); }
  existTrees.forEach((t, n) => placed.push({ x: t.cx, y: t.cy, r: t.r, tier: 'over', drift: `__exist_${n}` }));

  // Group into drifts, ordered top-down then biggest first.
  const groups = new Map<string, PlaceInstance[]>();
  for (const i of instances) { const g = groups.get(i.drift) || []; g.push(i); groups.set(i.drift, g); }
  const order = [...groups.values()].sort((a, b) => (rank[a[0].layer] - rank[b[0].layer]) || (b[0].r - a[0].r));

  // Front-of-bed grading per bed (keep tall plants off the front of each region) unless
  // privacy screening is requested.
  const frontZones = allowTallFront ? null : buildFrontZones(opts.boundary, opts.existing, opts.plan);

  const structuralLayer = (l: Layer) => l === 'tree' || l === 'large_shrub';
  // A legal spot: plantable, canopy fully inside, not piled on a same-tier neighbour from
  // another planting, (for big plants) clear of the house, and — if tall — not at the front edge.
  const fits = (x: number, y: number, r: number, layer: Layer, drift: string, tall?: boolean): boolean => {
    if (!isPlantable(x, y)) return false;
    if (!sunOkAt(x, y, drift)) return false; // only plant where the sun amount matches the species
    if (minEdgeDist(x, y, boundaryFt) < r) return false;
    if (!clearOfObstacles(x, y, r)) return false; // canopy must not overlap hardscape/structures/features/paths
    // Tall plants: the whole canopy (not just the centre) must stay out of the no-tall zone.
    if (tall && frontZones) {
      if (frontZones.noTall(x, y)) return false;
      for (let a = 0; a < 8; a++) { const ang = a * Math.PI / 4; if (frontZones.noTall(x + Math.cos(ang) * r, y + Math.sin(ang) * r)) return false; }
    }
    const tier = tierOf(layer);
    for (const p of placed) {
      if (p.tier !== tier) continue;
      const f = p.drift === drift ? SAME_DRIFT_OVERLAP : DIFF_OVERLAP;
      if (Math.hypot(x - p.x, y - p.y) < (r + p.r) * f) return false;
    }
    return true;
  };
  // Clearance from same-tier neighbours / house — used to pick good drift anchors.
  const clearness = (x: number, y: number, r: number, layer: Layer): number => {
    let c = minEdgeDist(x, y, boundaryFt) - r;
    const tier = tierOf(layer);
    for (const p of placed) if (p.tier === tier) c = Math.min(c, Math.hypot(x - p.x, y - p.y) - (r + p.r));
    if (structuralLayer(layer)) for (const h of houses) c = Math.min(c, distToPolygon(x, y, h) - r);
    return c;
  };

  for (const members of order) {
    const free = members.filter(m => !fixed[m.id]);
    if (!free.length) continue;
    const lead = free[0];
    const isU = understory(lead.layer);

    // Anchor by seeded random sampling (blue-noise, not a grid): understory drifts spread
    // apart (farthest from existing anchors); structural maximises same-layer clearance.
    const aRng = seededRng(hashId(lead.drift + ':a'));
    let anchor: { x: number; y: number } | null = null, bestA = -Infinity;
    for (let t = 0; t < 220; t++) {
      const x = minX + aRng() * (maxX - minX), y = minY + aRng() * (maxY - minY);
      if (!isPlantable(x, y)) continue;
      if (!sunOkAt(x, y, lead.drift)) continue; // anchor the drift in matching sun
      const sc = isU
        ? (driftAnchors.length ? driftAnchors.reduce((m, a) => Math.min(m, Math.hypot(x - a.x, y - a.y)), Infinity) : aRng())
        : clearness(x, y, lead.r, lead.layer) + aRng() * 0.5; // tiny jitter breaks ties
      if (sc > bestA) { bestA = sc; anchor = { x, y }; }
    }
    if (!anchor) for (let x = minX; x <= maxX && !anchor; x += step) for (let y = minY; y <= maxY && !anchor; y += step) if (isPlantable(x, y)) anchor = { x, y };
    if (!anchor) anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    driftAnchors.push(anchor);

    // Place members: lead near the anchor, the rest clustered around it (random offsets).
    const rng = seededRng(hashId(lead.drift));
    const spread = lead.r * (1.6 + free.length * 0.35);
    free.forEach((m, idx) => {
      let pos: { x: number; y: number } | null = null;
      for (let t = 0; t < 36 && !pos; t++) {
        const ang = rng() * Math.PI * 2;
        const dist = idx === 0 ? 0 : rng() * spread;
        const x = anchor!.x + Math.cos(ang) * dist, y = anchor!.y + Math.sin(ang) * dist;
        if (fits(x, y, m.r, m.layer, m.drift, m.tall)) pos = { x, y };
      }
      // Fall back to random darts across the yard (still no grid bias).
      for (let t = 0; t < 160 && !pos; t++) { const x = minX + rng() * (maxX - minX), y = minY + rng() * (maxY - minY); if (fits(x, y, m.r, m.layer, m.drift, m.tall)) pos = { x, y }; }
      // Last resort: pick a random fitting grid cell so we don't line plants up in rows.
      if (!pos) { const cells: { x: number; y: number }[] = []; for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) if (fits(x, y, m.r, m.layer, m.drift, m.tall)) cells.push({ x, y }); if (cells.length) pos = cells[Math.floor(rng() * cells.length)]; }
      // No legal, non-stacked spot → leave it unplanted.
      if (!pos) return;
      out[m.id] = pos; placed.push({ ...pos, r: m.r, tier: tierOf(m.layer), drift: m.drift });
    });
  }
  return out;
}
