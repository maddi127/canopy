import * as turf from '@turf/turf';
import { supabase } from '../lib/supabase';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

// ── Style targets ───────────────────────────────────────────────────────────────
// TOTAL distinct species across the whole garden (all layers combined), by style.
// Naturalistic styles read better with more variety; clean styles with less.
export type DbStyle = 'modern' | 'traditional' | 'desert' | 'whimsical';

// Explicit per-layer species targets by style (user-tuned 2026-07: foundation shrubs are where
// visual VARIETY lives — the old 15/20/35/30% weight-split gave foundation only ~4 species; the
// user expects ~7. Visual-interest layers are capped hard by the 1-per-500sqft rule regardless,
// so allocating them fewer species matches placement reality.) Order: [tree, large_shrub, shrub, groundcover].
export const LAYER_SPECIES_TARGET: Record<DbStyle, [number, number, number, number]> = {
  modern:      [1, 1, 4, 1], // restrained: few species repeated in disciplined runs; ONE groundcover as a clean monoculture plane
  desert:      [1, 2, 5, 3], // sparse, sculptural
  traditional: [2, 2, 7, 4], // tidy, balanced — foundation carries the variety
  whimsical:   [2, 3, 8, 5], // layered, cottage-y abundance
};
// min/max bound how far the user can trim or grow the palette; `target` = sum of the layer targets.
export const STYLE_TOTAL_SPECIES: Record<DbStyle, { min: number; target: number; max: number }> = {
  modern:      { min: 5,  target: 7,  max: 9 },
  desert:      { min: 6,  target: 11, max: 14 },
  traditional: { min: 8,  target: 15, max: 18 },
  whimsical:   { min: 11, target: 18, max: 22 },
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
// A tree must suit the SPACE, not just fit geometrically: cap mature height to the yard's linear reach
// (~√area) × this factor. ~1.1 → a 500 sf yard (~22 ft across) tops out near a small tree; big lots
// allow full-size canopy. Tunable — raise to allow taller trees per unit area, lower to keep them smaller.
export const TREE_HEIGHT_PER_SQRT_AREA = 1.1;

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
  image_url?: string | null; // real photo (Conservation Garden Park); shown as the toolbar thumbnail
}

// Canonical parser for the DB's `sun_requirement` vocabulary → sun-map categories.
// The DB stores comma-joined phrases from EXACTLY this set: 'full sun', 'part sun',
// 'full shade' (e.g. 'full sun, part sun'). An earlier version of this parser switched on
// a legacy underscore vocabulary (full_sun/part_shade/...) that no DB row uses — every
// plant silently fell to the ['full','part'] default and shade tolerance was invisible.
// Legacy forms are still accepted for safety. Unknown/empty → permissive ['full','part'].
export type SunCat = 'full' | 'part' | 'shade';
export function plantSunCats(raw: string | undefined): SunCat[] {
  const s = (raw || '').toLowerCase();
  if (s.trim() === 'adaptable') return ['full', 'part', 'shade'];
  const cats: SunCat[] = [];
  if (s.includes('full sun') || s.includes('full_sun')) cats.push('full');
  if (s.includes('part sun') || s.includes('part shade') || s.includes('part_sun') || s.includes('part_shade')) cats.push('part');
  if (s.includes('full shade') || s.includes('full_shade')) cats.push('shade');
  return cats.length ? cats : ['full', 'part'];
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
// Collapse duplicate species (the DB sometimes holds two rows for the same plant — e.g. one with a
// photo, one without), keyed by common (else botanical) name. Keeps ranking order by holding each
// species at its FIRST position, but upgrades to a later duplicate that carries an image so the row
// shows a real photo instead of the placeholder. Without this the same plant appears twice in a layer.
function dedupeByName<T extends { common_name?: string; botanical_name?: string; image_url?: string | null }>(cands: T[]): T[] {
  const at = new Map<string, number>();
  const out: T[] = [];
  for (const c of cands) {
    const key = (c.common_name || c.botanical_name || '').trim().toLowerCase();
    if (!key) { out.push(c); continue; }
    const idx = at.get(key);
    if (idx === undefined) { at.set(key, out.length); out.push(c); }
    else if (!out[idx].image_url && c.image_url) out[idx] = c; // prefer the variant that has a photo
  }
  return out;
}
function zoneOk(row: PlantRow, zone?: number): boolean {
  return zone == null || (Number(row.min_zone) <= zone && zone <= Number(row.max_zone));
}
function sizeOk(layer: Layer, row: PlantRow): boolean {
  const h = Number(row.height_in);
  if (layer === 'large_shrub') return h >= LARGE_SHRUB_MIN_IN;
  // Foundation tier floor at 13" (the use-tier boundary) — anything shorter is groundcover-scale,
  // which matters now that ornamental grasses (some ankle-high) are in the shrub pool.
  if (layer === 'shrub') return h >= 13 && h < LARGE_SHRUB_MIN_IN;
  return true;
}

// Tree size class, read from the curated `use` token (backfilled by backfill_tree_use_class.sql), with a
// height fallback for any row that predates the backfill. x-small = accent/patio scale (no meaningful
// shade — behaves like a focal); small/medium/large are progressively bigger canopies. Cutoffs (in inches)
// mirror the backfill exactly so the derived fallback and the stored token never disagree.
export type TreeSizeClass = 'x-small' | 'small' | 'medium' | 'large';
export function treeSizeClass(row: { use?: string; height_in?: number }): TreeSizeClass {
  const u = (row.use || '').toLowerCase();
  if (u.includes('x-small tree')) return 'x-small'; // check before 'small tree' (it's a substring)
  if (u.includes('small tree'))   return 'small';
  if (u.includes('medium tree'))  return 'medium';
  if (u.includes('large tree'))   return 'large';
  const h = Number(row.height_in);
  return h < 180 ? 'x-small' : h < 300 ? 'small' : h < 540 ? 'medium' : 'large';
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

// ── Shared plantable-rule builder ─────────────────────────────────────────────────
// The ONE definition of "is this feet position plantable?" — planting beds are always
// plantable; everything else is boundary minus features/lawn/unplanted-beds/walkway
// corridors/structures. placePlan (default placement) and plantCapacity (pocket measuring)
// both build from this, so they can NEVER disagree about where a plant may land. Also
// returns the derived obstacle rings / paths so placePlan can reuse them for canopy clearance.
interface PlantableCtx {
  isPlantable: (x: number, y: number) => boolean;
  plantedBeds: [number, number][][];
  exFeatures: [number, number][][];
  exBeds: [number, number][][];
  paths: any[];
  distToPath: (x: number, y: number, p: any) => number;
}
// Footprint ring of a zone/bed: prefer the baked ring, else DERIVE one from the stored shape
// ({shape, xFt, yFt, wFt, hFt, verts?, rot?}). Critical: auto-layout zones (incl. the carved
// LAWN) are saved shape-only — without this derivation they were invisible to the plantable
// test and plants landed on lawn. Organic ≈ ellipse (same approximation as draftPlan.bakeRing).
function ringOf(s: any): [number, number][] | null {
  if (s.ring && s.ring.length >= 3) return s.ring;
  if (s.verts && s.verts.length >= 3) return [...s.verts, s.verts[0]];
  const { xFt, yFt, wFt, hFt } = s;
  if (typeof xFt !== 'number' || typeof yFt !== 'number' || !(wFt > 0) || !(hFt > 0)) return null;
  const cx = xFt + wFt / 2, cy = yFt + hFt / 2, rx = wFt / 2, ry = hFt / 2;
  let ring: [number, number][];
  if (s.shape === 'circle' || s.shape === 'organic') {
    const N = 32; ring = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; ring.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
  } else {
    ring = [[xFt, yFt], [xFt + wFt, yFt], [xFt + wFt, yFt + hFt], [xFt, yFt + hFt]];
  }
  if (s.rot) { const c = Math.cos(s.rot), si = Math.sin(s.rot); ring = ring.map(([x, y]) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * si, cy + dx * si + dy * c] as [number, number]; }); }
  ring.push(ring[0]);
  return ring;
}

function buildPlantableCtx(
  boundaryFt: [number, number][],
  houses: [number, number][][],
  plan: { zones?: any[]; beds?: any[]; paths?: any[] },
): PlantableCtx {
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
  return { isPlantable, plantedBeds, exFeatures, exBeds, paths, distToPath };
}

// Plantable-ground stats derived from the SAME `isPlantable` rule placePlan uses, so the editor and the
// "plan is ready" preview measure the yard identically (this was a source of the two showing different
// plans — they computed plantable area and sun-region shares different ways). Samples a grid over the
// boundary bbox: `plantableFt` = plantable cells × cell area; `sunShares` = sun-category fractions across
// the PLANTABLE cells only (null when no sun map). Deterministic.
export interface PlantableStats { plantableFt: number; sunShares: Record<SunCat, number> | null; }
export function plantableStats(opts: {
  boundary: [number, number][];                 // lng/lat polygon
  existing: ConfirmedFeature[];
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] };
  sunAt?: (x: number, y: number) => SunCat;     // feet → sun category (omit → sunShares null)
}): PlantableStats {
  const cs = opts.boundary.length >= 3 ? buildCS(opts.boundary) : null;
  if (!cs) return { plantableFt: 0, sunShares: null };
  const boundaryFt = opts.boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][];
  const houses: [number, number][][] = [];
  for (const f of opts.existing) {
    if (!f.keep || (f.vertices?.length ?? 0) < 3) continue;
    if (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure')
      houses.push(f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][]);
  }
  const { isPlantable } = buildPlantableCtx(boundaryFt, houses, opts.plan || {});
  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = Math.max(1, Math.max(maxX - minX, maxY - minY) / 80);
  const cell = step * step;
  const cnt: Record<SunCat, number> = { full: 0, part: 0, shade: 0 };
  let plantableFt = 0, tot = 0;
  for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) {
    if (!isPlantable(x, y)) continue;
    plantableFt += cell; tot++;
    if (opts.sunAt) cnt[opts.sunAt(x, y)]++;
  }
  const sunShares = opts.sunAt && tot ? { full: cnt.full / tot, part: cnt.part / tot, shade: cnt.shade / tot } : null;
  return { plantableFt, sunShares };
}

// ── Plant capacity (pocket measuring) ───────────────────────────────────────────────
// Per sun region (plus 'any' = union of all plantable ground), a DESCENDING list of the
// RADII (ft) of the open "pockets" a plant could be centred in. Used to gate species
// selection: a structural species whose mature footprint provably can't fit any pocket is
// never picked (the placement warning it would cause is made unrepresentable). Deterministic,
// pure, no randomness. Region membership is by the sun category at each cell's centre;
// pocket radius stays sun-agnostic (a full-sun plant may overhang part-sun ground — matching
// placePlan, which only sun-tests the centre).
export type PlantCapacity = Record<'full' | 'part' | 'shade' | 'any', number[]>;
export const CAPACITY_TOL_FT = 0.5; // same-drift overlap allowance (mirrors placePlan's SAME_DRIFT_OVERLAP intent)
// House foundation gap: a plant's mature CANOPY EDGE must stay this many feet off the house wall
// — so nothing touches the siding (canopy clearance, not just the stem). Small clear band.
export const HOUSE_SETBACK_FT = 1;

// The plant-density slider (0.5 sparse … 1.5 lush) → the two knobs it drives. Shared by both
// plant pipelines so the editor and the draft flow feel identical.
//  - coverage: fraction of plantable ground the understory fill TARGETS. ~50% (airy, gaps around
//    plants) at the bottom → ~105% (full, a little canopy overlap) at the top.
//  - packing:  the min-spacing factor between DIFFERENT plantings (× canopy-sum). >1 = a gap
//    around each plant (sparse), <1 = canopies overlap slightly (lush). Feeds placePlan's opts.packing.
export function densityParams(slider: number): { coverage: number; packing: number } {
  const t = Math.max(0, Math.min(1, (slider - 0.5) / 1.0)); // 0.5→0 (sparse) … 1.5→1 (lush)
  // coverage is GEOMETRIC (sum of canopy areas / plantable). Drawn symbols overshoot their footprint,
  // so geometric ~0.30 already reads as a comfortably-planted-but-open bed; ~1.0 reads full-with-overlap.
  return { coverage: 0.30 + 0.70 * t, packing: 1.25 - 0.42 * t };
}
export function cloneCapacity(c: PlantCapacity): PlantCapacity {
  return { full: [...c.full], part: [...c.part], shade: [...c.shade], any: [...c.any] };
}
// Does rFt fit the largest available pocket in `list`? (screen only — no consume.)
export function pocketFits(list: number[], rFt: number): boolean {
  return list.length > 0 && list[0] + CAPACITY_TOL_FT >= rFt;
}
// Best-fit consume: remove the SMALLEST pocket that still accommodates rFt (list is descending,
// so the LAST fitting index is the smallest). Returns true when a pocket was consumed. Mutates.
export function consumePocket(list: number[], rFt: number): boolean {
  let idx = -1;
  for (let i = 0; i < list.length; i++) if (list[i] + CAPACITY_TOL_FT >= rFt) idx = i;
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}
export function plantCapacity(opts: {
  boundary: [number, number][];
  existing: ConfirmedFeature[];
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] };
  sunAt?: (x: number, y: number) => SunCat;
}): PlantCapacity {
  const empty: PlantCapacity = { full: [], part: [], shade: [], any: [] };
  const cs = opts.boundary.length >= 3 ? buildCS(opts.boundary) : null;
  if (!cs) return empty;
  const boundaryFt = opts.boundary.map(v => cs.toXY(v[0], v[1])) as [number, number][];
  const houses: [number, number][][] = [];
  for (const f of opts.existing) {
    if (!f.keep || f.vertices.length < 3) continue;
    const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
    if (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure') houses.push(ring);
  }
  const { isPlantable } = buildPlantableCtx(boundaryFt, houses, opts.plan || {});

  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  // ~2 ft sampling; step up on very large lots so the grid stays bounded (perf, still deterministic).
  const cellsAt = (st: number) => (Math.floor(spanX / st) + 1) * (Math.floor(spanY / st) + 1);
  let step = 2; while (cellsAt(step) > 4000 && step < 24) step += 1;
  const nx = Math.floor(spanX / step) + 1, ny = Math.floor(spanY / step) + 1;
  const cX = (ix: number) => minX + ix * step, cY = (iy: number) => minY + iy * step;

  // Plantable mask + coarse distance transform (feet): each plantable cell's distance to the
  // nearest NON-plantable cell (obstacle, feature, path or boundary exterior). Two-pass chamfer.
  const INF = 1e9, orth = step, diag = step * Math.SQRT2;
  const plant = new Uint8Array(nx * ny);
  const dist = new Float64Array(nx * ny);
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    const p = isPlantable(cX(ix), cY(iy)); plant[ix * ny + iy] = p ? 1 : 0; dist[ix * ny + iy] = p ? INF : 0;
  }
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const k = ix * ny + iy; if (dist[k] === 0) continue; let d = dist[k];
    if (ix > 0) d = Math.min(d, dist[(ix - 1) * ny + iy] + orth);
    if (iy > 0) d = Math.min(d, dist[ix * ny + iy - 1] + orth);
    if (ix > 0 && iy > 0) d = Math.min(d, dist[(ix - 1) * ny + iy - 1] + diag);
    if (ix < nx - 1 && iy > 0) d = Math.min(d, dist[(ix + 1) * ny + iy - 1] + diag);
    dist[k] = d;
  }
  for (let iy = ny - 1; iy >= 0; iy--) for (let ix = nx - 1; ix >= 0; ix--) {
    const k = ix * ny + iy; if (dist[k] === 0) continue; let d = dist[k];
    if (ix < nx - 1) d = Math.min(d, dist[(ix + 1) * ny + iy] + orth);
    if (iy < ny - 1) d = Math.min(d, dist[ix * ny + iy + 1] + orth);
    if (ix < nx - 1 && iy < ny - 1) d = Math.min(d, dist[(ix + 1) * ny + iy + 1] + diag);
    if (ix > 0 && iy < ny - 1) d = Math.min(d, dist[(ix - 1) * ny + iy + 1] + diag);
    dist[k] = d;
  }
  // Cap by the EXACT distance to the boundary edge. A structural plant must sit fully inside the
  // boundary (placePlan's hard containment rule), and a polygon that fills its own bounding box has
  // no exterior grid cells for the chamfer to key off — so the boundary is folded in analytically.
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    const k = ix * ny + iy; if (!plant[k]) continue;
    dist[k] = Math.min(dist[k], minEdgeDist(cX(ix), cY(iy), boundaryFt));
  }

  // Greedy peak extraction: repeatedly take the max-distance cell as a pocket (radius = its
  // distance), zero out cells within that radius, repeat (≤ 8 pockets, stop below 1 ft).
  const catOf = (ix: number, iy: number): SunCat | 'all' => opts.sunAt ? opts.sunAt(cX(ix), cY(iy)) : 'all';
  const extract = (accept: (c: SunCat | 'all') => boolean): number[] => {
    const cells: { x: number; y: number; d: number }[] = [];
    for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
      const k = ix * ny + iy; if (!plant[k] || dist[k] <= 0) continue;
      if (!accept(catOf(ix, iy))) continue;
      cells.push({ x: cX(ix), y: cY(iy), d: dist[k] });
    }
    const radii: number[] = [];
    for (let p = 0; p < 8; p++) {
      let best = -1, bd = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i].d > bd) { bd = cells[i].d; best = i; }
      if (best < 0 || bd < 1) break;
      const r = bd, bx = cells[best].x, by = cells[best].y;
      radii.push(r);
      for (const c of cells) if (Math.hypot(c.x - bx, c.y - by) < r) c.d = 0;
    }
    return radii;
  };
  // No sun map → sun is unconstrained, so every region == the full 'any' pocket set.
  return {
    full: extract(c => c === 'all' || c === 'full'),
    part: extract(c => c === 'all' || c === 'part'),
    shade: extract(c => c === 'all' || c === 'shade'),
    any: extract(() => true),
  };
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
  capacity?: PlantCapacity;         // open-pocket radii (from plantCapacity) — drops trees too big for any pocket
  yardType?: string;                // 'front' | 'back' — front yards exclude the large class (curb scale)
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
  const styled = rows.filter(row => styleMatches(row.style, dbStyle)); // style is a HARD filter
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
  let candidates = fitted.length ? fitted : mapped;
  // Capacity gate (optional, backward-compatible): drop trees whose mature radius can't fit the
  // largest open pocket anywhere in the yard, so a provably-unplaceable species is never suggested.
  // Falls back to the unfiltered list if the gate would empty it (exact placement is resolved later).
  if (opts.capacity) {
    const capFit = candidates.filter(c => pocketFits(opts.capacity!.any, c.matureWidthFt / 2));
    if (capFit.length) candidates = capFit;
  }
  candidates = dedupeByName(candidates); // one row per species (no photo/no-photo twins)

  // ── Scale to the yard ─────────────────────────────────────────────────────────
  // A tree must suit the SPACE, not just fit geometrically. Cap mature height to the yard's linear reach
  // (~√area): a 500 sf yard (~22 ft across) tops out around a small tree; big lots allow full canopy.
  // Front yards additionally exclude the large class (curb scale + overhead lines). If the cap would empty
  // the list (a yard too small for anything in-scope), fall back to the three smallest so the picker isn't
  // blank — the shade-coverage math below then recommends 0, leaving them as optional accent adds.
  const sizeCeilingFt = TREE_HEIGHT_PER_SQRT_AREA * Math.sqrt(Math.max(1, projectAreaFt));
  const suitsYard = (c: TreeCandidate) =>
    c.matureHeightFt <= sizeCeilingFt && (opts.yardType !== 'front' || treeSizeClass(c) !== 'large');
  const capped = candidates.filter(suitsYard);
  candidates = capped.length
    ? capped
    : [...candidates].sort((a, b) => a.matureHeightFt - b.matureHeightFt).slice(0, 3);
  // Order accents (x-small) LAST so the auto-selection's "first N" slice grabs real canopy trees, leaving
  // accents as optional adds/swaps beneath them (stable otherwise).
  candidates = [...candidates].sort((a, b) =>
    (treeSizeClass(a) === 'x-small' ? 1 : 0) - (treeSizeClass(b) === 'x-small' ? 1 : 0));

  // Tree count derives from a canopy-coverage goal, using the typical mature canopy of the viable
  // species — so big trees mean fewer trees, and the yard keeps open space. SHADE is provided by canopy
  // trees, not accents: size the goal (and the recommended count) from the shade-capable candidates only,
  // so a 6 ft ornamental never counts as shade or inflates the count. A yard that fits only accents gets
  // targetToPlant 0 (none recommended) with accents still available to add.
  const shadeCands = candidates.filter(c => treeSizeClass(c) !== 'x-small');
  const avgCanopy = shadeCands.length
    ? shadeCands.reduce((s, c) => s + canopyFootprintFt(c.matureWidthFt), 0) / shadeCands.length
    : 0;
  const targetCanopyFt = (opts.coverageGoal ?? TREE_CANOPY_COVERAGE_GOAL) * projectAreaFt;
  const targetTotal = avgCanopy > 0 ? Math.round(targetCanopyFt / avgCanopy) : 0;
  const targetToPlant = avgCanopy > 0 ? Math.max(0, Math.round((targetCanopyFt - existingCanopyFt) / avgCanopy)) : 0;

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
  // Ornamental grasses mass exactly like shrubs and are the signature modern/naturalistic
  // foundation plant — excluding them starved styles whose DB tagging leans grass-heavy.
  else q = q.in('type', ['shrub', 'ornamental grass']);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data as PlantRow[] | null) ?? [];
  const usable = rows.filter(r => sizeOk(layer, r) && Number(r.width_in) > 0);
  const styled = usable.filter(r => styleMatches(r.style, dbStyle)); // style is a HARD filter
  const zoned = styled.filter(r => zoneOk(r, opts.zone));
  // Fall back past the zone filter if it empties the list (better than nothing).
  let candidates = dedupeByName((zoned.length ? zoned : styled).map(toCandidate));
  // The large-shrub tier is the foundation/ANCHOR layer — presence matters, so lead with the BROADEST
  // species. A tall-but-skinny grass (e.g. 6 ft × 2 ft feather reed grass) makes a poor solo anchor; put
  // the wide woody shrubs first so they're picked before grasses. Other layers keep DB/relevance order.
  if (layer === 'large_shrub') candidates = [...candidates].sort((a, b) => b.matureWidthFt - a.matureWidthFt);
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

// `name`/`type` are optional species hints — only used to match architectural ("rosette")
// focal slots and to vary species across slots; placement is otherwise unaffected by them.
type PlaceInstance = { id: string; layer: Layer; r: number; under?: boolean; drift: string; tall?: boolean; sun?: string[]; name?: string; type?: string };
// A DESIGNATED position for a visual-interest plant, emitted by the composition planner
// (plan-feet coords, same space as plan.zones/beds). Tier picks which layer fills it.
export type FocalSlot = { x: number; y: number; tier: 'tree' | 'large_shrub' | 'rosette'; reason?: string };
export function placePlan(opts: {
  boundary: [number, number][];
  existing: ConfirmedFeature[];
  plan?: { zones?: any[]; beds?: any[]; paths?: any[] };
  instances: PlaceInstance[];
  fixed?: Record<string, { x: number; y: number }>;
  allowTallFront?: boolean; // when true (privacy screening requested), tall plants may go to the front edge
  sunAt?: (x: number, y: number) => string; // sun category ('full'|'part'|'shade') at a feet position
  focalSlots?: FocalSlot[]; // designated positions to fill FIRST with visual-interest plants
  packing?: number; // min-spacing factor vs different plantings (density slider); default 0.9
  massing?: 'drift' | 'row'; // 'row' (modern style): drift members line up along the nearest armature
}): Record<string, { x: number; y: number }> {
  const { instances, fixed = {}, allowTallFront = false, sunAt } = opts;
  const focalSlots = opts.focalSlots ?? [];
  // Instance ids pinned to a focal slot below — the normal distribution skips these.
  const consumed = new Set<string>();
  // Each drift is a single species → single sun tolerance; a plant only goes where sun matches.
  const driftSun = new Map<string, string[] | undefined>();
  for (const i of instances) if (!driftSun.has(i.drift)) driftSun.set(i.drift, i.sun);
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
  // Under a tree's canopy it's shaded from above regardless of the directional sun map (which is
  // side-lit at low sun) — so ONLY shade-tolerant plants may go there. A slot inside a tree canopy
  // requires the drift tolerate 'shade' (or 'part'); a full-sun-only plant is excluded.
  const underCanopy = (x: number, y: number): boolean => existTrees.some(t => Math.hypot(x - t.cx, y - t.cy) <= t.r);
  const sunOkAt = (x: number, y: number, drift: string): boolean => {
    const allowed = driftSun.get(drift);
    if (!allowed || allowed.length === 0) return true;
    if (underCanopy(x, y)) return allowed.includes('shade') || allowed.includes('part');
    if (!sunAt) return true;
    return allowed.includes(sunAt(x, y));
  };
  // Plantable test — the SAME shared builder plantCapacity uses, so the two can never disagree
  // about where a plant may land.
  const plan = opts.plan || {};
  const { isPlantable, exFeatures, exBeds, paths, distToPath } = buildPlantableCtx(boundaryFt, houses, plan);
  // Row massing (modern): drift members line up along the nearest ARMATURE edge — house wall,
  // walkway, feature edge, or boundary — echoing the yard's geometry instead of clustering
  // organically. armSegs is every armature segment; rowDirAt/armDistAt find the closest one.
  const rowMode = opts.massing === 'row';
  const armSegs: [number, number, number, number][] = [];
  if (rowMode) {
    const addRing = (r: [number, number][]) => { for (let i = 0; i < r.length - 1; i++) armSegs.push([r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]]); };
    addRing([...boundaryFt, boundaryFt[0]]);
    for (const h of houses) addRing([...h, h[0]]);
    for (const z of exFeatures) addRing(z[z.length - 1] === z[0] ? z : [...z, z[0]]);
    for (const p of paths) { const pts = p.pts as [number, number][]; for (let i = 0; i < pts.length - 1; i++) armSegs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]); }
  }
  const nearestArm = (x: number, y: number): { d: number; dir: [number, number] } => {
    let best = Infinity, dir: [number, number] = [1, 0];
    for (const [ax, ay, bx, by] of armSegs) {
      const d = segDist(x, y, ax, ay, bx, by);
      if (d < best) { best = d; const L = Math.hypot(bx - ax, by - ay) || 1; dir = [(bx - ax) / L, (by - ay) / L]; }
    }
    return { d: best, dir };
  };

  // A plant's whole CANOPY (radius r) must clear every non-plantable obstacle — house,
  // hardscape, structures, placed features, walkways, and unplanted beds — not just its centre.
  const obstaclePolys = [...houses, ...exFeatures, ...exBeds];
  const clearOfObstacles = (x: number, y: number, r: number): boolean => {
    for (const o of obstaclePolys) if (distToPolygon(x, y, o) < r) return false;
    for (const p of paths) if (distToPath(x, y, p) < r + (p.widthFt || 3) / 2) return false;
    // House foundation gap — the whole canopy (radius r) stays ≥ HOUSE_SETBACK_FT off the wall,
    // so nothing touches the siding.
    for (const h of houseOnly) if (distToPolygon(x, y, h) < r + HOUSE_SETBACK_FT) return false;
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
  const SAME_DRIFT_OVERLAP = 0.6;          // dense mass within one species' drift
  const DIFF_OVERLAP = opts.packing ?? 0.9; // spacing between DIFFERENT plantings — driven by density
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
  // `diffOverlap` is the packing distance factor against DIFFERENT plantings (default DIFF_OVERLAP,
  // ≈ touching). Only the structural retry sweep (Fix 2) passes a smaller value to widen the search;
  // every other rule here (plantable, sun, boundary containment, feature/obstacle clearance, no-tall
  // front) is HARD and never relaxed.
  const fits = (x: number, y: number, r: number, layer: Layer, drift: string, tall?: boolean, diffOverlap: number = DIFF_OVERLAP): boolean => {
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
      const f = p.drift === drift ? SAME_DRIFT_OVERLAP : diffOverlap;
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

  // ── Focal slots ────────────────────────────────────────────────────────────────
  // A composition planner may hand us DESIGNATED positions for the visual-interest plants.
  // Fill these FIRST by REUSING instances from the already-selected palette — so a filled
  // slot spends one unit of the existing visual-interest budget (it does not add plants on
  // top of the cap). Each slot pins its instance at (or near) the designated point; the rest
  // of the palette then distributes exactly as it would with no slots. Guarded so an empty
  // list is a complete no-op (behaviour bit-identical to before).
  if (focalSlots.length) {
    const norm = (s?: string) => (s || '').toLowerCase();
    // Architectural / spiky species for 'rosette' slots: by DB type or a family name.
    const isSpiky = (i: PlaceInstance): boolean =>
      /cactus|succulent/.test(norm(i.type)) ||
      /yucca|agave|century plant|sotol|nolina|hesperaloe|aloe|ocotillo|red hot poker/.test(norm(i.name));
    const inLayer = (l: Layer) => instances.filter(i => i.layer === l && !fixed[i.id]);
    const treePool = inLayer('tree');
    const largePool = inLayer('large_shrub');
    const spikyPool = [...treePool, ...largePool].filter(isSpiky);
    // rosette → spiky first, then gracefully fall back to tree, then large shrub.
    const poolsFor = (tier: FocalSlot['tier']): PlaceInstance[][] =>
      tier === 'tree' ? [treePool] : tier === 'large_shrub' ? [largePool] : [spikyPool, treePool, largePool];
    const usedNames = new Set<string>(); // variety: don't put the same species on every slot
    for (const slot of focalSlots) {
      // Best-matching, still-available instance for this tier (prefer an unused species).
      let pick: PlaceInstance | null = null;
      for (const pool of poolsFor(slot.tier)) {
        const avail = pool.filter(i => !consumed.has(i.id));
        if (!avail.length) continue;
        const fresh = avail.filter(i => !i.name || !usedNames.has(i.name));
        pick = (fresh.length ? fresh : avail)[0];
        break;
      }
      if (!pick) continue; // palette exhausted for this tier → leave the slot empty
      // Try the exact point, then a seeded ring of 6 offsets within ~3 ft; else skip.
      const rng = seededRng((Math.round(slot.x * 100) * 73856093) ^ (Math.round(slot.y * 100) * 19349663));
      const phase = rng() * Math.PI * 2;
      const cands: [number, number][] = [[slot.x, slot.y]];
      for (let a = 0; a < 6; a++) { const ang = phase + a * Math.PI / 3; cands.push([slot.x + Math.cos(ang) * 2.5, slot.y + Math.sin(ang) * 2.5]); }
      let pos: { x: number; y: number } | null = null;
      for (const [cx, cy] of cands) if (fits(cx, cy, pick.r, pick.layer, pick.drift, pick.tall)) { pos = { x: cx, y: cy }; break; }
      if (!pos) continue; // no legal spot near the slot → let it distribute normally instead
      out[pick.id] = pos;
      placed.push({ ...pos, r: pick.r, tier: tierOf(pick.layer), drift: pick.drift });
      consumed.add(pick.id);
      if (pick.name) usedNames.add(pick.name);
    }
  }

  // Seed 1–2 interior anchor points inside each PLANTED bed so understory drifts preferentially mass
  // there (consumed in the drift loop below), making beds read planted rather than bare. Deterministic:
  // positions are seeded from the bed id/geometry. `remaining` is a coverage budget (~65% of bed area)
  // so beds visibly fill (denser than the open ground) without starving the rest of the yard. With NO
  // planted beds this list stays empty and the drift loop runs bit-identically to the pre-bias code.
  const plantedBedObjs = (plan.beds || []).filter((b: any) => b.material !== 'lawn' && b.type === 'planted' && b.ring && b.ring.length >= 3);
  const bedAnchorList: { pts: { x: number; y: number }[]; remaining: number; used: number }[] = [];
  for (const b of plantedBedObjs) {
    const ring = b.ring as [number, number][];
    const bc = centroid(ring), area = ringArea(ring);
    const br = seededRng(hashId(String(b.id ?? `${Math.round(bc[0])},${Math.round(bc[1])}`)));
    const nAnch = area > 60 ? 2 : 1;
    const pts: { x: number; y: number }[] = [];
    for (let a = 0; a < 40 && pts.length < nAnch; a++) {
      const ang = br() * Math.PI * 2, rad = br() * Math.sqrt(Math.max(1, area)) / 3;
      const x = bc[0] + Math.cos(ang) * rad, y = bc[1] + Math.sin(ang) * rad;
      if (pointInRing(x, y, ring)) pts.push({ x, y });
    }
    if (!pts.length && pointInRing(bc[0], bc[1], ring)) pts.push({ x: bc[0], y: bc[1] });
    if (pts.length) bedAnchorList.push({ pts, remaining: area * 0.65, used: 0 });
  }

  // ── Creek bank planting ─────────────────────────────────────────────────────────
  // A real dry creek is never bare rock — its banks are massed with grasses arching over
  // the stone and drifts gathering at the bends. The composition planner is FORBIDDEN from
  // placing beds within 8 ft of a creek (two grey rock/gravel textures compete), so bank
  // planting is the plant engine's job. For each creek path we walk the centreline by arc
  // length and drop anchor points on ALTERNATING banks, offset just OUTSIDE the rock
  // (widthFt/2 + ~2.5 ft) along the local normal, spaced ~9 ft, with a seeded phase from the
  // path id so runs vary. Anchors are ordered so the sharpest BENDS get planted first (bends
  // read as the natural place a drift would gather). Bank plants sit outside the corridor;
  // their canopies lean over the rock visually, which is fine. Only anchors passing the
  // plantable test survive. Guarded on creek presence: with NO creek paths this list stays
  // empty, seededRng is never called here, and the drift loop below runs bit-identically to
  // the pre-creek code (same RNG stream).
  const BANK_SPACING_FT = 9;
  const BANK_CAP = 4;            // at most 4 bank drifts per creek
  const isGrassName = (n?: string) => /grass|muhly|carex|festuca|sedge|fountain|miscanthus/i.test(n || '');
  const creekBankAnchorList: { pts: { x: number; y: number }[]; budget: number; used: number }[] = [];
  for (const cp of paths) {
    if (cp.kind !== 'creek') continue;
    const cpts = cp.pts as [number, number][];
    if (!cpts || cpts.length < 2) continue;
    const w = cp.widthFt || 2;
    const off = w / 2 + 2.5; // sit just outside the rock, on the bank
    // Cumulative segment lengths.
    const segLen: number[] = []; let total = 0;
    for (let i = 0; i < cpts.length - 1; i++) { const d = Math.hypot(cpts[i + 1][0] - cpts[i][0], cpts[i + 1][1] - cpts[i][1]); segLen.push(d); total += d; }
    if (total < 1) continue;
    const phase = seededRng(hashId(String(cp.id ?? 'creek')))() * BANK_SPACING_FT; // seeded start offset
    const stations: { x: number; y: number; turn: number }[] = [];
    let side = 1; // alternate banks each station
    for (let s = phase; s <= total; s += BANK_SPACING_FT) {
      // Locate the segment containing arc length s.
      let acc = 0, si = 0;
      while (si < segLen.length - 1 && acc + segLen[si] < s) { acc += segLen[si]; si++; }
      const segFrac = segLen[si] > 0 ? (s - acc) / segLen[si] : 0;
      const ax = cpts[si][0], ay = cpts[si][1], bx = cpts[si + 1][0], by = cpts[si + 1][1];
      const px = ax + (bx - ax) * segFrac, py = ay + (by - ay) * segFrac;
      const tlen = segLen[si] || 1;
      const tx = (bx - ax) / tlen, ty = (by - ay) / tlen; // unit tangent
      const nx = -ty, ny = tx;                            // unit normal
      // Turn angle at the segment's start vertex (bend sharpness); straight runs → 0.
      let turn = 0;
      if (si > 0) {
        const d0x = ax - cpts[si - 1][0], d0y = ay - cpts[si - 1][1], l0 = Math.hypot(d0x, d0y) || 1;
        const dot = (d0x / l0) * tx + (d0y / l0) * ty;
        turn = Math.acos(Math.max(-1, Math.min(1, dot)));
      }
      const ox = px + nx * side * off, oy = py + ny * side * off;
      side = -side;
      if (isPlantable(ox, oy)) stations.push({ x: ox, y: oy, turn });
    }
    if (!stations.length) continue;
    // Bends first: sort by turn angle descending (stable comparator keeps arc order on ties).
    stations.sort((a, b) => b.turn - a.turn);
    const budget = Math.min(BANK_CAP, Math.max(1, Math.round(total / 10))); // ~1 drift / 10 ft
    creekBankAnchorList.push({ pts: stations.map(s => ({ x: s.x, y: s.y })), budget, used: 0 });
  }
  // Grass preference: if the palette carries grass-like understory species, reserve the bank
  // anchors for them (grasses along a creek read as intended); only fall back to any understory
  // species when the palette has no grasses at all.
  const bankHasGrass = creekBankAnchorList.length
    ? order.some(m => understory(m[0].layer) && isGrassName(m[0].name))
    : false;

  for (const members of order) {
    const free = members.filter(m => !fixed[m.id] && !consumed.has(m.id));
    if (!free.length) continue;
    const lead = free[0];
    const isU = understory(lead.layer);

    // Bed-interior bias: mass understory drifts INSIDE planted beds first, picking the least-full bed
    // with a sun-matching anchor, until its coverage budget runs out. Guarded on bedAnchorList.length
    // so a yard with no planted beds skips straight to the original sampling (bit-identical).
    let anchor: { x: number; y: number } | null = null;
    if (isU && bedAnchorList.length) {
      let bestBed = -1, bestRem = 0, bestPt: { x: number; y: number } | null = null;
      for (let bi = 0; bi < bedAnchorList.length; bi++) {
        const bedA = bedAnchorList[bi]; if (bedA.remaining <= 0) continue;
        const pt = bedA.pts[bedA.used % bedA.pts.length];
        if (!sunOkAt(pt.x, pt.y, lead.drift)) continue;
        if (bedA.remaining > bestRem) { bestRem = bedA.remaining; bestBed = bi; bestPt = pt; }
      }
      if (bestBed >= 0 && bestPt) {
        anchor = { x: bestPt.x, y: bestPt.y };
        bedAnchorList[bestBed].used++;
        bedAnchorList[bestBed].remaining -= Math.max(1, free.length) * Math.PI * lead.r * lead.r;
      }
    }

    // Creek-bank bias: after planted beds, route understory drifts to a creek bank anchor
    // (bends first). Grass-like species get first claim; when the palette has grasses, other
    // understory species leave the banks to them. Guarded on creekBankAnchorList.length so a
    // creek-less plan skips this entirely (bit-identical to the pre-creek sampling).
    if (isU && !anchor && creekBankAnchorList.length && (!bankHasGrass || isGrassName(lead.name))) {
      let bestCreek = -1, bestRem = 0, bestPt: { x: number; y: number } | null = null;
      for (let ci = 0; ci < creekBankAnchorList.length; ci++) {
        const cb = creekBankAnchorList[ci];
        const rem = Math.min(cb.budget, cb.pts.length) - cb.used;
        if (rem <= 0) continue;
        const pt = cb.pts[cb.used];
        if (!sunOkAt(pt.x, pt.y, lead.drift)) continue; // seat the drift where its sun matches
        if (rem > bestRem) { bestRem = rem; bestCreek = ci; bestPt = pt; }
      }
      if (bestCreek >= 0 && bestPt) { anchor = { x: bestPt.x, y: bestPt.y }; creekBankAnchorList[bestCreek].used++; }
    }

    // Anchor by seeded random sampling (blue-noise, not a grid): understory drifts spread
    // apart (farthest from existing anchors); structural maximises same-layer clearance.
    const aRng = seededRng(hashId(lead.drift + ':a'));
    if (!anchor) {
      let bestA = -Infinity;
      for (let t = 0; t < 220; t++) {
        const x = minX + aRng() * (maxX - minX), y = minY + aRng() * (maxY - minY);
        if (!isPlantable(x, y)) continue;
        if (!sunOkAt(x, y, lead.drift)) continue; // anchor the drift in matching sun
        let sc = isU
          ? (driftAnchors.length ? driftAnchors.reduce((m, a) => Math.min(m, Math.hypot(x - a.x, y - a.y)), Infinity) : aRng())
          : clearness(x, y, lead.r, lead.layer) + aRng() * 0.5; // tiny jitter breaks ties
        // Row mode: understory rows hug the geometry — penalise anchors far from an armature
        // (still spread apart via the base score, so rows distribute along/between edges).
        if (rowMode && isU && armSegs.length) sc -= nearestArm(x, y).d * 1.5;
        if (sc > bestA) { bestA = sc; anchor = { x, y }; }
      }
    }
    if (!anchor) for (let x = minX; x <= maxX && !anchor; x += step) for (let y = minY; y <= maxY && !anchor; y += step) if (isPlantable(x, y)) anchor = { x, y };
    if (!anchor) anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    driftAnchors.push(anchor);

    // Place members: lead near the anchor, the rest clustered around it (random offsets).
    // Row mode (modern): members take evenly-spaced slots on a straight line through the anchor,
    // parallel to the nearest armature — a crisp band/hedge rhythm instead of an organic clump.
    // Slots scan outward (0, +1, −1, +2, −2 …); fits() keeps occupied slots from double-filling.
    const rng = seededRng(hashId(lead.drift));
    const spread = lead.r * (1.6 + free.length * 0.35);
    const rowDir = rowMode && armSegs.length ? nearestArm(anchor.x, anchor.y).dir : null;
    free.forEach((m, idx) => {
      let pos: { x: number; y: number } | null = null;
      if (rowDir) {
        const stepFt = m.r * 2 * 0.85; // near-touching — reads as a continuous band
        for (let s = 0; s < free.length + 6 && !pos; s++) {
          const k = s % 2 === 0 ? s / 2 : -(s + 1) / 2;
          const x = anchor!.x + rowDir[0] * stepFt * k, y = anchor!.y + rowDir[1] * stepFt * k;
          if (fits(x, y, m.r, m.layer, m.drift, m.tall)) pos = { x, y };
        }
      }
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
      // FIX 2: a structural individual (tree / large shrub) has just ONE shot at a good spot —
      // unlike a massed drift with many members and many candidate positions. If every prior pass
      // failed, give it ONE extra finer, whole-yard sweep with the DIFFERENT-planting packing
      // distance relaxed (0.9 → 0.7). Feature/obstacle clearance, sun matching, boundary containment
      // and the no-tall front all stay HARD inside fits() — only the SEARCH widens, never "legal".
      if (!pos && structuralLayer(m.layer)) {
        const fine = Math.max(1, step / 3);
        for (let x = minX; x <= maxX && !pos; x += fine)
          for (let y = minY; y <= maxY && !pos; y += fine)
            if (fits(x, y, m.r, m.layer, m.drift, m.tall, Math.min(0.7, DIFF_OVERLAP))) pos = { x, y };
      }
      // No legal, non-stacked spot → leave it unplanted.
      if (!pos) return;
      out[m.id] = pos; placed.push({ ...pos, r: m.r, tier: tierOf(m.layer), drift: m.drift });
    });
  }
  return out;
}
