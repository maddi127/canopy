// Composition planner. The aesthetic-massing pass that runs AFTER features + circulation and BEFORE
// plant placement: it reads the (still plant-less) plan, MEASURES how empty the ground is, and fills
// the deadest voids with accent beds, an optional dry creek, and focal-plant slots — each with a
// human-readable `reason`. Like circulationPlanner it is PURE and DETERMINISTIC: nodes, ordering,
// scoring and geometry are all functions of the input, so the same site is byte-identical every run
// (no Math.random / Date.now — any jitter is seeded from geometry). It never throws; degraded inputs
// simply yield fewer or no placements.
//
// Geometry is PLAN FEET (x = east, y = SOUTH-down) — the exact frame layoutGenerator works in.
//
// Beds emitted match the placement editor's PlacedBed schema exactly (id/label/type/material/variant/
// shape/xFt/yFt/wFt/hFt) plus an extra `reason` string (beds flow through the plan as `any`). The
// creek is a PlanPath with kind:'creek'. Focal slots are an explicit tier'd point list the plant
// engine consumes.

import type { PlanPath } from './layoutGenerator';
import type { SiteFacts, SiteAnchor, AnchorKind } from './siteFacts';
import { sampleSun, type SunMap } from './sunAnalysis';

type Pt = [number, number];

// ── Public contract (the integration agent + plant engine code against this — do not deviate) ──────
export interface FocalSlot { x: number; y: number; tier: 'tree' | 'large_shrub' | 'rosette'; reason: string }
export interface CompositionResult { beds: any[]; creek: PlanPath | null; focalSlots: FocalSlot[] }
export interface CompositionInput {
  boundaryFt: [number, number][];
  houseRing: [number, number][] | null;
  zones: any[];            // placed feature zones incl. lawn (xFt/yFt/wFt/hFt/shape/key/label)
  paths: any[];            // plan paths incl. circulation output (pts/widthFt/kind)
  existingBeds: any[];     // beds already in the plan — respect, don't duplicate
  facts: SiteFacts | null;
  sun?: SunMap | null;
  style: string; yardType: 'front' | 'back'; plantDensity?: number;  // 0.5–1.5, default 1
  primary?: { material: string | null; variant: string | null };    // plan's ground cover (for bed contrast)
}

// ── Geometry helpers ────────────────────────────────────────────────────────────────────────────
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
function centroid(r: Pt[]): Pt { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; }
function closeRing(r: Pt[]): Pt[] { const f = r[0], l = r[r.length - 1]; return (f && l && f[0] === l[0] && f[1] === l[1]) ? r : [...r, r[0]]; }
function pointInRing(px: number, py: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nearestOnSeg(p: Pt, a: Pt, b: Pt): { q: Pt; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const q: Pt = [a[0] + t * dx, a[1] + t * dy]; return { q, d: dist(p, q) };
}
function nearestOnPts(p: Pt, pts: Pt[]): { q: Pt; d: number } {
  if (!pts.length) return { q: p, d: Infinity };
  if (pts.length === 1) return { q: pts[0], d: dist(p, pts[0]) };
  let best = { q: pts[0], d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) { const r = nearestOnSeg(p, pts[i], pts[i + 1]); if (r.d < best.d) best = r; }
  return best;
}
function distToRingEdge(p: Pt, ring: Pt[]): number { let m = Infinity; for (let i = 0; i < ring.length; i++) { const r = nearestOnSeg(p, ring[i], ring[(i + 1) % ring.length]); if (r.d < m) m = r.d; } return m; }
// Min distance between two segments (0 when they cross).
function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  if (o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)) return 0;
  return Math.min(nearestOnSeg(a, c, d).d, nearestOnSeg(b, c, d).d, nearestOnSeg(c, a, b).d, nearestOnSeg(d, a, b).d);
}
// Gap between two closed rings: -1 if they overlap (a vertex of one is inside the other), else min edge gap.
function ringGap(A: Pt[], B: Pt[]): number {
  for (const p of A) if (pointInRing(p[0], p[1], B)) return -1;
  for (const p of B) if (pointInRing(p[0], p[1], A)) return -1;
  let m = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++)
    m = Math.min(m, segSegDist(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]));
  return m;
}
// Gap between a closed ring and an open polyline (path centerline). -1 if the ring straddles the line.
function ringPolylineGap(A: Pt[], line: Pt[]): number {
  if (line.length < 2) return Infinity;
  for (const p of A) if (nearestOnPts(p, line).d === 0) return -1;
  let m = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < line.length - 1; j++)
    m = Math.min(m, segSegDist(A[i], A[(i + 1) % A.length], line[j], line[j + 1]));
  // ring wholly on one side of a straddling line: catch the case where the centerline passes through the ring
  for (let j = 0; j < line.length - 1; j++) { const mid: Pt = [(line[j][0] + line[j + 1][0]) / 2, (line[j][1] + line[j + 1][1]) / 2]; if (pointInRing(mid[0], mid[1], A)) return -1; }
  return m;
}
function bboxOf(r: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of r) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}
const rectRing = (cx: number, cy: number, w: number, h: number): Pt[] => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
function zoneBoxRing(z: any): Pt[] { return [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]]; }
const unit = (a: Pt, b: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };

// ── Determinism ───────────────────────────────────────────────────────────────────────────────────
function fnv(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function seededRng(seed: number) { let s = seed | 0 || 1; return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; }; }

// ── Style profiles (dbStyle → normalized, like circulationPlanner) ─────────────────────────────────
type Style = 'modern' | 'traditional' | 'natural' | 'desert';
function normStyle(s: string): Style {
  const k = (s || '').toLowerCase();
  if (k.includes('modern')) return 'modern';
  if (k.includes('desert')) return 'desert';
  if (k.includes('wild') || k.includes('natural') || k.includes('whimsical')) return 'natural';
  return 'traditional';
}
const DEEP_TARGET: Record<Style, number> = { natural: 0.25, traditional: 0.30, desert: 0.40, modern: 0.45 };
const BED_CAP: Record<Style, number> = { natural: 4, desert: 4, modern: 3, traditional: 3 };
const CREEK_CAP: Record<Style, number> = { natural: 1, desert: 1, modern: 0, traditional: 0 };
const BED_SHAPE: Record<Style, 'rect' | 'circle' | 'organic'> = { natural: 'organic', desert: 'organic', modern: 'rect', traditional: 'circle' };
const LARGEST_VOID_TARGET = 400;   // sqft — biggest deep patch we tolerate before we stop caring

function anchorsOf(f: SiteFacts | null, k: AnchorKind): SiteAnchor[] { return f ? f.anchors.filter(a => a.kind === k) : []; }
function anchorGeoms(a: SiteAnchor): Pt[][] { const g: Pt[][] = []; if (a.line && a.line.length >= 2) g.push(a.line as Pt[]); if (a.ring && a.ring.length >= 2) g.push(closeRing(a.ring as Pt[])); if (a.point) g.push([a.point as Pt]); return g; }
function nearestAcrossAnchors(p: Pt, as: SiteAnchor[]): { q: Pt; d: number } { let best = { q: p, d: Infinity }; for (const a of as) for (const g of anchorGeoms(a)) { const r = nearestOnPts(p, g); if (r.d < best.d) best = r; } return best; }

interface Anchor { x: number; y: number; kind: string; reason: string; tight: boolean }

// ── The main entry point ────────────────────────────────────────────────────────────────────────
export function composePlan(input: CompositionInput): CompositionResult {
  const empty: CompositionResult = { beds: [], creek: null, focalSlots: [] };
  try {
    const boundary = input.boundaryFt;
    if (!Array.isArray(boundary) || boundary.length < 3) return empty;
    const style = normStyle(input.style);
    const density = Math.max(0.5, Math.min(1.5, input.plantDensity ?? 1));
    const band = Math.max(5, Math.min(10, 7 * density));
    const yardC = centroid(boundary);
    const bb = bboxOf(boundary);
    const seed = fnv(`${boundary.length}|${boundary.map(p => `${Math.round(p[0])},${Math.round(p[1])}`).join(';')}|${style}`);
    const rng = seededRng(seed);

    const zones = (input.zones || []).filter(z => z && typeof z.xFt === 'number' && z.wFt > 0 && z.hFt > 0);
    const paths = (input.paths || []).filter(p => Array.isArray(p?.pts) && p.pts.length >= 2);
    const existingBeds = (input.existingBeds || []).filter(b => b && typeof b.xFt === 'number');
    const houseRing = (input.houseRing && input.houseRing.length >= 3) ? closeRing(input.houseRing as Pt[]) : null;

    // ── CREEK REPULSION ────────────────────────────────────────────────────────────────────────────
    // Beds must stay well clear of any creek corridor — the composer's OWN creek (pushed below once
    // built) AND any existing creek path handed in via input.paths. Rationale: bank planting is the
    // plant engine's job, and a bed sitting beside a rock-lined dry creek reads as two competing gray
    // textures. So we REPEL beds from creeks (hard reject within CREEK_REPEL ft), never treat the
    // creek as a planting affinity.
    const CREEK_REPEL = 8;
    const creekCorridors: Pt[][] = [];
    for (const p of (input.paths || [])) if (p && p.kind === 'creek' && Array.isArray(p.pts) && p.pts.length >= 2) creekCorridors.push(p.pts as Pt[]);

    // Obstacle rings from facts — established trees, existing aerial beds, AND all marked hardscape
    // (user-marked walkways/sidewalks/driveways are FEATURES, not plan paths — without their rings
    // here they were invisible to the plantable grid and bed clearance, and a bed once landed
    // squarely on a marked walkway). They also become armature lines, so beds may snap BESIDE them.
    const factRings: Pt[][] = [];
    const hardscapeRings: Pt[][] = [];   // marked walkway/sidewalk/driveway rings — armature lines beds may flank
    const OBSTACLE_KINDS = ['existing_tree', 'existing_bed', 'existing_walkway', 'sidewalk', 'driveway'] as const;
    const HARDSCAPE_KINDS = new Set<string>(['existing_walkway', 'sidewalk', 'driveway']);
    for (const kind of OBSTACLE_KINDS)
      for (const a of anchorsOf(input.facts, kind)) if (a.ring && a.ring.length >= 3) { const r = closeRing(a.ring as Pt[]); factRings.push(r); if (HARDSCAPE_KINDS.has(kind)) hardscapeRings.push(r); }

    const zoneRings = zones.map(zoneBoxRing);
    const existingBedRings = existingBeds.map(b => rectRing(b.xFt + b.wFt / 2, b.yFt + b.hFt / 2, b.wFt, b.hFt));
    const pathClear = (p: any): number => (typeof p.widthFt === 'number' ? p.widthFt / 2 : 1.5);

    // Armature segments (edges every deep cell is measured against): zones, existing beds, paths(+width),
    // boundary, house, fact obstacles. Paths carry their half-width so the "band" reads from the walk edge.
    const armSegs: { a: Pt; b: Pt; extra: number }[] = [];
    const pushRing = (r: Pt[], extra = 0) => { for (let i = 0; i < r.length; i++) armSegs.push({ a: r[i], b: r[(i + 1) % r.length], extra }); };
    for (const r of zoneRings) pushRing(r);
    for (const r of existingBedRings) pushRing(r);
    for (const r of factRings) pushRing(r);
    pushRing(boundary);
    if (houseRing) pushRing(houseRing);
    for (const p of paths) for (let i = 0; i < p.pts.length - 1; i++) armSegs.push({ a: p.pts[i], b: p.pts[i + 1], extra: pathClear(p) });
    const distToArmature = (p: Pt): number => { let m = Infinity; for (const s of armSegs) { const d = nearestOnSeg(p, s.a, s.b).d - s.extra; if (d < m) m = d; } return m; };

    // ── DEEP-FIELD GRID ──────────────────────────────────────────────────────────────────────────
    const step = 2.5, cellArea = step * step;
    const cols = Math.max(1, Math.ceil((bb.maxX - bb.minX) / step) + 1);
    const rows = Math.max(1, Math.ceil((bb.maxY - bb.minY) / step) + 1);
    const idx = (c: number, r: number) => r * cols + c;
    // state: -1 not plantable, 0 plantable-shallow, 1 plantable-deep. `consumed` mirrors deep cells eaten by placements.
    const state = new Int8Array(cols * rows).fill(-1);
    const cellPt = (c: number, r: number): Pt => [bb.minX + c * step, bb.minY + r * step];
    const isPlantable = (p: Pt): boolean => {
      if (!pointInRing(p[0], p[1], boundary)) return false;
      for (const r of zoneRings) if (pointInRing(p[0], p[1], r)) return false;
      for (const r of existingBedRings) if (pointInRing(p[0], p[1], r)) return false;
      for (const r of factRings) if (pointInRing(p[0], p[1], r)) return false;
      if (houseRing && pointInRing(p[0], p[1], houseRing)) return false;
      for (const pa of paths) if (nearestOnPts(p, pa.pts).d < pathClear(pa)) return false;
      return true;
    };
    let plantable = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const p = cellPt(c, r);
      if (!isPlantable(p)) continue;
      plantable++;
      state[idx(c, r)] = distToArmature(p) > band ? 1 : 0;
    }
    const consumed = new Uint8Array(cols * rows);
    const deepCount = (): number => { let n = 0; for (let i = 0; i < state.length; i++) if (state[i] === 1 && !consumed[i]) n++; return n; };
    const deepRatio = (): number => plantable ? deepCount() / plantable : 0;
    // Largest 4-connected deep patch, in sqft, with its centroid — flood fill over un-consumed deep cells.
    const largestVoid = (): { area: number; center: Pt; cells: number; cellSet: Set<number> } => {
      const seen = new Uint8Array(cols * rows); let best = { area: 0, center: yardC as Pt, cells: 0, cellSet: new Set<number>() };
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (state[idx(c, r)] !== 1 || consumed[idx(c, r)] || seen[idx(c, r)]) continue;
        const stack = [[c, r]]; seen[idx(c, r)] = 1; let sx = 0, sy = 0, n = 0; const cellsIdx: number[] = [];
        while (stack.length) {
          const [cc, rr] = stack.pop()!; const p = cellPt(cc, rr); sx += p[0]; sy += p[1]; n++; cellsIdx.push(idx(cc, rr));
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nc = cc + dc, nr = rr + dr;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            if (state[idx(nc, nr)] === 1 && !consumed[idx(nc, nr)] && !seen[idx(nc, nr)]) { seen[idx(nc, nr)] = 1; stack.push([nc, nr]); }
          }
        }
        if (n > best.cells) best = { area: n * cellArea, center: [sx / n, sy / n], cells: n, cellSet: new Set(cellsIdx) };
      }
      return best;
    };
    // Count / consume deep cells under a rectangle (bed footprint approximation).
    const deepUnderRect = (cx: number, cy: number, w: number, h: number): number => {
      let n = 0; const c0 = Math.max(0, Math.floor((cx - w / 2 - bb.minX) / step)), c1 = Math.min(cols - 1, Math.ceil((cx + w / 2 - bb.minX) / step));
      const r0 = Math.max(0, Math.floor((cy - h / 2 - bb.minY) / step)), r1 = Math.min(rows - 1, Math.ceil((cy + h / 2 - bb.minY) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (state[idx(c, r)] === 1 && !consumed[idx(c, r)]) n++;
      return n;
    };
    const consumeRect = (cx: number, cy: number, w: number, h: number): void => {
      const c0 = Math.max(0, Math.floor((cx - w / 2 - bb.minX) / step)), c1 = Math.min(cols - 1, Math.ceil((cx + w / 2 - bb.minX) / step));
      const r0 = Math.max(0, Math.floor((cy - h / 2 - bb.minY) / step)), r1 = Math.min(rows - 1, Math.ceil((cy + h / 2 - bb.minY) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) consumed[idx(c, r)] = 1;
    };
    const deepUnderPolyline = (pts: Pt[], clear: number): void => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (state[idx(c, r)] === 1 && !consumed[idx(c, r)] && nearestOnPts(cellPt(c, r), pts).d <= clear) consumed[idx(c, r)] = 1;
    };
    const deepNear = (p: Pt, radius: number): number => {
      let n = 0; const c0 = Math.max(0, Math.floor((p[0] - radius - bb.minX) / step)), c1 = Math.min(cols - 1, Math.ceil((p[0] + radius - bb.minX) / step));
      const r0 = Math.max(0, Math.floor((p[1] - radius - bb.minY) / step)), r1 = Math.min(rows - 1, Math.ceil((p[1] + radius - bb.minY) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (state[idx(c, r)] === 1 && !consumed[idx(c, r)] && dist(cellPt(c, r), p) <= radius) n++;
      return n;
    };
    // Deep cells within `radius` of p that belong to a SPECIFIC void patch (its flood-filled cell set).
    // Used to keep an armature-snapped bed tangent to a line that actually BOUNDS the target void.
    const voidDeepNear = (p: Pt, radius: number, cellSet: Set<number>): number => {
      let n = 0; const c0 = Math.max(0, Math.floor((p[0] - radius - bb.minX) / step)), c1 = Math.min(cols - 1, Math.ceil((p[0] + radius - bb.minX) / step));
      const r0 = Math.max(0, Math.floor((p[1] - radius - bb.minY) / step)), r1 = Math.min(rows - 1, Math.ceil((p[1] + radius - bb.minY) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = idx(c, r); if (state[i] === 1 && !consumed[i] && cellSet.has(i) && dist(cellPt(c, r), p) <= radius) n++; }
      return n;
    };

    // ── STREET POINT (creek terminus + entry-approach direction) ──────────────────────────────────
    // Where the yard meets the street: nearest point on a sidewalk/driveway anchor, else the boundary
    // edge nearest the door (front) / farthest from the house (back).
    const door: Pt | null = anchorsOf(input.facts, 'door')[0]?.point as Pt ?? null;
    const streetPoint = (): Pt => {
      const sw = anchorsOf(input.facts, 'sidewalk'), dv = anchorsOf(input.facts, 'driveway');
      if (sw.length) { const r = nearestAcrossAnchors(yardC, sw); if (r.d < Infinity) return r.q; }
      if (dv.length) { const r = nearestAcrossAnchors(yardC, dv); if (r.d < Infinity) return r.q; }
      // boundary edge midpoints; nearest to door (front) or farthest from house (back)
      let best: Pt = boundary[0], score = input.yardType === 'back' ? -Infinity : Infinity;
      const ref: Pt = input.yardType === 'back' ? (houseRing ? centroid(houseRing) : yardC) : (door ?? yardC);
      for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i], b = boundary[(i + 1) % boundary.length], mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = dist(mid, ref);
        if (input.yardType === 'back' ? d > score : d < score) { score = d; best = mid; }
      }
      return best;
    };

    // ── ANCHORS ───────────────────────────────────────────────────────────────────────────────────
    const rawAnchors: Anchor[] = [];
    const add = (x: number, y: number, kind: string, reason: string, tight = false) => { if (pointInRing(x, y, boundary)) rawAnchors.push({ x, y, kind, reason, tight }); };
    // walkway terminuses + junctions
    for (const p of paths) {
      const a = p.pts[0] as Pt, b = p.pts[p.pts.length - 1] as Pt;
      add(a[0], a[1], 'terminus', "A specimen to anchor the path's end", true);
      add(b[0], b[1], 'terminus', "A specimen to anchor the path's end", true);
    }
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      const A = paths[i].pts as Pt[], B = paths[j].pts as Pt[];
      for (let m = 0; m < A.length - 1; m++) for (let n = 0; n < B.length - 1; n++)
        if (segSegDist(A[m], A[m + 1], B[n], B[n + 1]) === 0) { const q = nearestOnSeg(A[m], B[n], B[n + 1]).q; add(q[0], q[1], 'junction', 'Marks where the paths meet', true); }
    }
    // entry approach — door offset toward the street
    if (door && input.yardType === 'front') { const d = unit(door, streetPoint()); add(door[0] + d[0] * 7, door[1] + d[1] * 7, 'entry', 'Frames the approach to the front door'); }
    // lawn corners
    for (const z of zones) if (z.key === 'lawn') for (const cor of zoneBoxRing(z)) { const inset: Pt = [cor[0] + Math.sign(yardC[0] - cor[0]) * 2, cor[1] + Math.sign(yardC[1] - cor[1]) * 2]; add(inset[0], inset[1], 'lawn_corner', 'Softens the corner of the lawn'); }
    // mailbox
    const mb = anchorsOf(input.facts, 'mailbox')[0]?.point as Pt | undefined; if (mb) add(mb[0], mb[1], 'mailbox', 'A little planting around the mailbox');
    // prominent boundary corners (interior angle < 120°, facing open ground)
    for (let i = 0; i < boundary.length; i++) {
      const prev = boundary[(i - 1 + boundary.length) % boundary.length], cur = boundary[i], next = boundary[(i + 1) % boundary.length];
      const u1 = unit(cur, prev), u2 = unit(cur, next), cos = u1[0] * u2[0] + u1[1] * u2[1];
      if (cos < 0.5) continue;                                   // angle < 120° → interior corner cos>0.5? bisector points inward
      const bis = unit(cur, [cur[0] + (u1[0] + u2[0]), cur[1] + (u1[1] + u2[1])]);
      const inP: Pt = [cur[0] + bis[0] * (band + 1), cur[1] + bis[1] * (band + 1)];
      if (isPlantable(inP)) add(inP[0], inP[1], 'corner', 'Breaks up the open ground in the corner');
    }
    // seating-zone outlook — a point out in front of a seating/gathering zone
    for (const z of zones) if (z.key === 'seating' || z.key === 'dining' || z.key === 'fire' || z.key === 'cooking') {
      const c: Pt = [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2], d = unit(c, yardC), off = Math.max(z.wFt, z.hFt) / 2 + 8;
      add(c[0] + d[0] * off, c[1] + d[1] * off, 'outlook', 'Gives the seating area something to look at');
    }
    // dedupe within 6ft (deterministic first-wins)
    const anchors: Anchor[] = [];
    for (const a of rawAnchors) if (!anchors.some(b => Math.hypot(a.x - b.x, a.y - b.y) < 6)) anchors.push(a);
    // an anchor already served by a zone / existing bed (within 8ft) is not ours to fill
    const preServed = (a: Anchor): boolean => {
      for (const r of zoneRings) if (distToRingEdge([a.x, a.y], r) < 8 || pointInRing(a.x, a.y, r)) return true;
      for (const r of existingBedRings) if (distToRingEdge([a.x, a.y], r) < 8 || pointInRing(a.x, a.y, r)) return true;
      return false;
    };
    const openAnchors = anchors.filter(a => !preServed(a));
    const served = new Set<Anchor>();

    // ── BED VALIDITY (hard clearance: ≥2ft off zones/paths/house/beds, inside boundary) ──────────────
    const CLEAR = 2;
    const LAWN_CLEAR = 0.5;   // beds may ABUT the lawn edge (tangency), so relax the lawn-specific gap
    // Armature lines a void-island bed can be SNAPPED tangent to (rather than floating at a bare void
    // centroid): the boundary + lawn edge (bed may touch them), and feature-zone / walkway edges (bed
    // keeps the mandated 2ft). Each line carries the clearance its own EDGE demands from the bed.
    // `edge` is the physical offset from the stored segment to the element's real EDGE (a walkway
    // segment is its centerline, so edge = half-width; rings ARE their edge, so 0) — tangency is
    // always judged against the edge, not the stored segment.
    type ArmLine = { a: Pt; b: Pt; clear: number; edge: number; kind: string; reason: string };
    const armatureLines: ArmLine[] = [];
    for (let i = 0; i < boundary.length; i++) armatureLines.push({ a: boundary[i], b: boundary[(i + 1) % boundary.length], clear: 0, edge: 0, kind: 'boundary', reason: 'Anchors the open ground against the property edge' });
    for (const z of zones) {
      const r = zoneBoxRing(z), lawn = z.key === 'lawn';
      const reason = lawn ? 'A border bed skirting the edge of the lawn' : `Tucks against the ${z.label || z.key || 'feature'}`;
      for (let i = 0; i < r.length; i++) armatureLines.push({ a: r[i], b: r[(i + 1) % r.length], clear: lawn ? LAWN_CLEAR : CLEAR, edge: 0, kind: lawn ? 'lawn' : 'feature', reason });
    }
    for (const pa of paths) { const cl = pathClear(pa) + CLEAR; for (let i = 0; i < pa.pts.length - 1; i++) armatureLines.push({ a: pa.pts[i] as Pt, b: pa.pts[i + 1] as Pt, clear: cl, edge: pathClear(pa), kind: 'walkway', reason: 'A ribbon of planting running alongside the walkway' }); }
    for (const r of hardscapeRings) for (let i = 0; i < r.length; i++) armatureLines.push({ a: r[i], b: r[(i + 1) % r.length], clear: CLEAR, edge: 0, kind: 'hardscape', reason: 'A bed running along the existing hardscape' });

    const placed: { ring: Pt[]; cx: number; cy: number; w: number; h: number }[] = [];
    const bedValid = (cx: number, cy: number, w: number, h: number): boolean => {
      const ring = rectRing(cx, cy, w, h);
      for (const p of ring) if (!pointInRing(p[0], p[1], boundary)) return false;
      // per-zone clearance: lawn edges may be abutted (~0.5ft); everything else keeps 2ft.
      for (let i = 0; i < zoneRings.length; i++) { const cl = zones[i].key === 'lawn' ? LAWN_CLEAR : CLEAR; const g = ringGap(ring, zoneRings[i]); if (g < 0 || g < cl) return false; }
      for (const r of existingBedRings) { const g = ringGap(ring, r); if (g < 0 || g < CLEAR) return false; }
      for (const r of factRings) { const g = ringGap(ring, r); if (g < 0 || g < CLEAR) return false; }
      if (houseRing) { const g = ringGap(ring, houseRing); if (g < 0 || g < CLEAR) return false; }
      for (const pl of placed) { const g = ringGap(ring, pl.ring); if (g < 0 || g < CLEAR) return false; }
      for (const pa of paths) { const g = ringPolylineGap(ring, pa.pts as Pt[]); if (g < 0 || g < pathClear(pa) + CLEAR) return false; }
      // Creek repulsion: reject any bed whose footprint comes within CREEK_REPEL ft of a creek corridor.
      for (const cl of creekCorridors) { const g = ringPolylineGap(ring, cl); if (g < CREEK_REPEL) return false; }
      return true;
    };
    // Nudge a candidate to a nearby valid spot (small deterministic ring search) — else null.
    const settle = (cx: number, cy: number, w: number, h: number): Pt | null => {
      if (bedValid(cx, cy, w, h)) return [cx, cy];
      for (const r of [2, 4, 6, 8]) for (let k = 0; k < 8; k++) { const t = k / 8 * Math.PI * 2; const nx = cx + Math.cos(t) * r, ny = cy + Math.sin(t) * r; if (bedValid(nx, ny, w, h)) return [nx, ny]; }
      return null;
    };

    // ── ARMATURE TANGENCY (the bed policy) ─────────────────────────────────────────────────────────
    // POLICY: every regular bed FLANKS the armature — its footprint sits within ARM_TANGENT of a
    // physical armature edge (boundary, lawn/feature/hardscape edge, walkway edge). Tangent
    // construction lands at line.clear + 0.4 ≤ 2.4ft, so 2.6 is the tangent band plus slack. The ONLY
    // bed allowed to float free of every line is the island-focal exception (see the placement loop).
    const ARM_TANGENT = 2.6;
    const armEdgeDist = (cx: number, cy: number, w: number, h: number): number => {
      const ring = rectRing(cx, cy, w, h); let m = Infinity;
      for (const L of armatureLines) {
        let d = Infinity;
        for (let i = 0; i < ring.length; i++) d = Math.min(d, segSegDist(ring[i], ring[(i + 1) % ring.length], L.a, L.b));
        d -= L.edge;
        if (d < m) m = d;
      }
      return m;
    };
    const isTangent = (cx: number, cy: number, w: number, h: number): boolean => armEdgeDist(cx, cy, w, h) <= ARM_TANGENT;
    // Re-snap a settled-but-floating candidate tangent to the nearest armature line (deterministic:
    // lines ranked by distance then index; the candidate's own side of the line is tried first).
    // Returns the tangent centre, or null when no nearby line admits a valid tangent placement.
    const snapToArmature = (cx: number, cy: number, w: number, h: number): Pt | null => {
      const ranked = armatureLines.map((L, i) => ({ L, i, n: nearestOnSeg([cx, cy], L.a, L.b) })).sort((p, q) => p.n.d - q.n.d || p.i - q.i);
      for (const { L, n } of ranked.slice(0, 8)) {
        const u = unit(L.a, L.b), nrm: Pt = [-u[1], u[0]];
        const side = Math.sign((cx - n.q[0]) * nrm[0] + (cy - n.q[1]) * nrm[1]) || 1;
        for (const sgn of [side, -side] as const) {
          const nn: Pt = [nrm[0] * sgn, nrm[1] * sgn];
          const halfExt = Math.abs(nn[0]) * w / 2 + Math.abs(nn[1]) * h / 2;
          const off = L.clear + halfExt + 0.4;
          const px = n.q[0] + nn[0] * off, py = n.q[1] + nn[1] * off;
          if (!pointInRing(px, py, boundary)) continue;
          if (Math.hypot(px - cx, py - cy) > 10) continue;   // don't teleport a candidate across the yard
          if (bedValid(px, py, w, h) && isTangent(px, py, w, h)) return [px, py];
        }
      }
      return null;
    };

    // Bed size from a void's cell count: 40–120 sqft, scaled, clamped to a sane aspect.
    const sizeFor = (cells: number): { w: number; h: number } => {
      const area = Math.max(40, Math.min(120, cells * cellArea * 0.6));
      const w = Math.max(6, Math.min(14, Math.sqrt(area * 1.6))), h = Math.max(5, Math.min(12, area / w));
      return { w: Math.round(w), h: Math.round(h) };
    };
    // Island-focal bed size: generous ground around the specimen it hosts — ~60–100 sqft.
    const islandSizeFor = (cells: number): { w: number; h: number } => {
      const area = Math.max(60, Math.min(100, cells * cellArea * 0.6));
      const w = Math.max(8, Math.min(12, Math.round(Math.sqrt(area * 1.3))));
      return { w, h: Math.max(7, Math.min(11, Math.round(area / w))) };
    };

    // ── CANDIDATE GENERATION (regenerated each iteration against the current void field) ──────────────
    type Cand = { cx: number; cy: number; w: number; h: number; kind: string; reason: string; anchor: Anchor | null; base: number };
    const bedCandidates = (): Cand[] => {
      const cs: Cand[] = [];
      // ── VOID-ISLAND beds, ANCHORED TO THE ARMATURE ──────────────────────────────────────────────
      // Instead of dropping a bed at the bare void centroid (which reads as a shape floating in space),
      // snap candidates TANGENT to any armature line that bounds the largest void — the boundary, a
      // lawn/feature edge, or a walkway — offsetting the bed into the void by its half-extent (plus the
      // line's required clearance) so its edge just touches the line while its body reaches the open
      // ground. Stations are seeded along each qualifying segment; both orientations are offered so the
      // scorer can pick the one that eats the most void.
      const lv = largestVoid();
      if (lv.cells > 2) {
        const s = sizeFor(lv.cells);
        for (const line of armatureLines) {
          const segLen = dist(line.a, line.b);
          if (segLen < 2) continue;
          const nStations = segLen > 24 ? 3 : 2;                       // 2–3 seeded stations per segment
          const u = unit(line.a, line.b), nrm: Pt = [-u[1], u[0]];
          for (let k = 0; k < nStations; k++) {
            const t = (k + 1) / (nStations + 1);
            const q: Pt = [line.a[0] + (line.b[0] - line.a[0]) * t, line.a[1] + (line.b[1] - line.a[1]) * t];
            for (const orient of [0, 1] as const) {                    // long axis perpendicular vs along the line
              const w = orient === 0 ? s.w : s.h, h = orient === 0 ? s.h : s.w;
              for (const sgn of [1, -1] as const) {
                const nn: Pt = [nrm[0] * sgn, nrm[1] * sgn];
                const halfExt = Math.abs(nn[0]) * w / 2 + Math.abs(nn[1]) * h / 2;   // rect support along nn
                const off = line.clear + halfExt + 0.4;                 // bed edge lands ~tangent to the line
                const cx = q[0] + nn[0] * off, cy = q[1] + nn[1] * off;
                if (!pointInRing(cx, cy, boundary)) continue;
                if (voidDeepNear([cx, cy], Math.max(w, h) / 2, lv.cellSet) < 2) continue; // must actually sit ON this void
                cs.push({ cx, cy, w, h, kind: 'void_arm', reason: line.reason, anchor: null, base: 3 });
              }
            }
          }
        }
        // ── ISLAND-FOCAL EXCEPTION — the ONLY island form. The bare-centroid 'void' fallback is GONE:
        // a bed may float free of the armature only as an island bed built around a focal specimen
        // (bed + FocalSlot emitted atomically in the placement loop). Its base score is −100, so ANY
        // placeable armature-snapped candidate outranks it — it can win only when NO armature line
        // bounds this void, or every snapped/anchored candidate proved invalid.
        const iz = islandSizeFor(lv.cells);
        cs.push({ cx: lv.center[0], cy: lv.center[1], w: iz.w, h: iz.h, kind: 'island_focal', reason: style === 'desert' ? 'An island bed anchored by a sculptural desert specimen' : 'An island bed anchored by a specimen tree', anchor: null, base: -100 });
      }
      // anchor-served beds
      for (const a of openAnchors) {
        if (served.has(a)) continue;
        // tight terminus/junction anchors are handled as focal slots, not beds
        if (a.tight && deepNear([a.x, a.y], 9) < 6) continue;
        const s = sizeFor(Math.max(6, deepNear([a.x, a.y], 8)));
        let reason = a.reason;
        if (a.kind === 'lawn_corner') reason = 'A crescent that softens the lawn corner';
        if (a.kind === 'mailbox') reason = 'A little bed to dress up the mailbox';
        if (a.kind === 'outlook') reason = 'A bed to give the seating area a focal point';
        if (a.kind === 'corner') reason = 'Breaks up the open ground in the corner';
        cs.push({ cx: a.x, cy: a.y, w: s.w, h: s.h, kind: 'anchor', reason, anchor: a, base: 2 });
      }
      // walkway flank ribbon (modern / traditional) — a rectangle alongside the longest path segment
      if ((style === 'modern' || style === 'traditional') && paths.length) {
        let best: { seg: [Pt, Pt]; len: number } | null = null;
        for (const p of paths) for (let i = 0; i < p.pts.length - 1; i++) { const a = p.pts[i] as Pt, b = p.pts[i + 1] as Pt, L = dist(a, b); if (!best || L > best.len) best = { seg: [a, b], len: L }; }
        if (best && best.len > 8) {
          const [a, b] = best.seg, mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u = unit(a, b), nrm: Pt = [-u[1], u[0]];
          const along = Math.min(best.len * 0.7, 12), across = 5;                // long axis runs ALONG the path
          const vertical = Math.abs(u[1]) >= Math.abs(u[0]);
          const bw = vertical ? across : along, bh = vertical ? along : across;  // map to the axis-aligned bbox
          for (const sgn of [1, -1] as const) {
            const off = pathClear({ widthFt: 3 }) + CLEAR + across / 2 + 0.5;
            const cx = mid[0] + nrm[0] * sgn * off, cy = mid[1] + nrm[1] * sgn * off;
            cs.push({ cx, cy, w: Math.round(bw), h: Math.round(bh), kind: 'ribbon', reason: 'A ribbon of planting flanking the walkway', anchor: null, base: 2.5 });
          }
        }
      }
      // entry pair (traditional) — two symmetric beds flanking the door approach
      if (style === 'traditional' && door && input.yardType === 'front') {
        const d = unit(door, streetPoint()), nrm: Pt = [-d[1], d[0]], base: Pt = [door[0] + d[0] * 6, door[1] + d[1] * 6];
        for (const sgn of [1, -1] as const) cs.push({ cx: base[0] + nrm[0] * sgn * 5, cy: base[1] + nrm[1] * sgn * 5, w: 7, h: 5, kind: 'entry', reason: 'Flanks the front walkway in a matched pair', anchor: null, base: 2.2 });
      }
      return cs;
    };

    // ── SCORING ───────────────────────────────────────────────────────────────────────────────────
    const scoreCand = (c: Cand): number => {
      const deep = deepUnderRect(c.cx, c.cy, c.w, c.h);
      let s = c.base + Math.min(deep, 20) * 0.5;                        // capped so one huge void can't starve the signature beds
      if (c.anchor) s += 4;                                             // serving an anchor is valuable
      // style affinity — the walkway ribbon is the signature move for modern/traditional, so it leads
      if (c.kind === 'ribbon' && (style === 'modern' || style === 'traditional')) s += 7;
      if (c.kind === 'void_arm') s += 3;                                // armature-snapped beds lead the void fill
      if (c.kind === 'void_arm' && (style === 'natural' || style === 'desert')) s += 2;
      if (c.kind === 'entry' && style === 'traditional') s += 2;
      // spread — reward distance from the nearest placed / existing bed
      let near = Infinity;
      for (const pl of placed) near = Math.min(near, Math.hypot(c.cx - pl.cx, c.cy - pl.cy));
      for (const b of existingBeds) near = Math.min(near, Math.hypot(c.cx - (b.xFt + b.wFt / 2), c.cy - (b.yFt + b.hFt / 2)));
      if (near < Infinity) s += Math.min(near, 24) * 0.08;
      // sun — a mild penalty for burying a bed in deep shade
      if (input.sun) { const sun = sampleSun(input.sun, c.cx, c.cy); if (sun < 0.35) s -= (0.35 - sun) * 4; }
      return s;
    };

    // ── PLACEMENT LOOP ────────────────────────────────────────────────────────────────────────────
    const beds: any[] = [];
    const focalSlots: FocalSlot[] = [];
    const bedShape = BED_SHAPE[style];

    // ── CONTRAST CHECK (per-candidate material) ─────────────────────────────────────────────────────
    // The default is to contrast with the plan's primary ground cover. On TOP of that we validate what
    // the bed directly sits in / abuts: a rock (or gravel) context forces the bed to MULCH — two gray
    // rock textures side by side don't read as a bed. A mulch context prefers a rock bed (contrast),
    // but a mulch-on-mulch bed is allowed too because the bed reads PLANTED (the plant engine masses
    // shrubs/perennials inside it). A bed abutting the lawn contrasts by definition (green vs bed).
    const primaryMat = String(input.primary?.material || '').toLowerCase();
    const isRockLike = (m: string) => m === 'rock' || m === 'gravel' || m === 'river' || m === 'river-rock' || m === 'stone' || m === 'dg' || m === 'decomposed_granite' || m === 'decomposed granite';
    const isMulchLike = (m: string) => m === 'mulch' || m === 'bark' || m === 'wood' || m === 'woodchip' || m === 'woodchips';
    const zoneMat = (z: any) => String(z.material || z.surface || z.fill || '').toLowerCase();
    const bedMatFor = (cx: number, cy: number, w: number, h: number): { material: string; variant: string } => {
      const ring = rectRing(cx, cy, w, h);
      const contact: string[] = [];
      if (primaryMat) contact.push(primaryMat);                       // the ground the bed sits in
      for (const z of zones) { if (z.key === 'lawn') continue; const g = ringGap(ring, zoneBoxRing(z)); if (g >= 0 && g <= CLEAR + 1) { const m = zoneMat(z); if (m) contact.push(m); } }
      const touchesRock = contact.some(isRockLike), touchesMulch = contact.some(isMulchLike);
      let material: string;
      if (touchesRock && !touchesMulch) material = 'mulch';           // rock/gravel context → mulch contrasts
      else if (touchesMulch && !touchesRock) material = 'rock';       // mulch context → prefer a rock bed
      else if (touchesRock && touchesMulch) material = 'mulch';       // mixed → mulch (still reads planted)
      else material = isRockLike(primaryMat) ? 'mulch' : 'rock';      // default: contrast the primary
      return { material, variant: material === 'rock' ? 'river' : 'natural' };
    };

    // ── SAME-VOID ASYMMETRY bookkeeping ─────────────────────────────────────────────────────────────
    // patchOf labels every deep cell with a stable connected-void id (computed once, AFTER the creek
    // eats its corridor). A second bed landing in the SAME void patch must be a satellite; a third is
    // never allowed. Populated just below, after the creek runs.
    const patchOf = new Int32Array(cols * rows).fill(-1);
    const voidBedCount = new Map<number, number>();
    const islandPatches = new Set<number>();   // voids served by an island-focal bed: no satellites, no growth, no second island
    const voidFirst = new Map<number, { cx: number; cy: number; w: number; h: number; area: number; bedIdx: number; placedIdx: number }>();
    const patchUnderRect = (cx: number, cy: number, w: number, h: number): number => {
      const counts = new Map<number, number>();
      const c0 = Math.max(0, Math.floor((cx - w / 2 - bb.minX) / step)), c1 = Math.min(cols - 1, Math.ceil((cx + w / 2 - bb.minX) / step));
      const r0 = Math.max(0, Math.floor((cy - h / 2 - bb.minY) / step)), r1 = Math.min(rows - 1, Math.ceil((cy + h / 2 - bb.minY) / step));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const p = patchOf[idx(c, r)]; if (p >= 0) counts.set(p, (counts.get(p) || 0) + 1); }
      let best = -1, bestN = 0; for (const [p, n] of counts) if (n > bestN || (n === bestN && p < best)) { bestN = n; best = p; } return best;
    };

    let bedN = 0;
    const emitBed = (cx: number, cy: number, w: number, h: number, reason: string, patch = -1, origin = ''): void => {
      const ring = rectRing(cx, cy, w, h); const placedIdx = placed.length; placed.push({ ring, cx, cy, w, h }); consumeRect(cx, cy, w, h);
      const mat = bedMatFor(cx, cy, w, h); const bedIdx = beds.length;
      beds.push({ id: `comp_bed_${bedN++}`, label: 'Accent bed', type: 'planted', material: mat.material, variant: mat.variant, shape: bedShape, xFt: cx - w / 2, yFt: cy - h / 2, wFt: w, hFt: h, reason, origin });
      if (patch >= 0) { voidBedCount.set(patch, (voidBedCount.get(patch) || 0) + 1); if (!voidFirst.has(patch)) voidFirst.set(patch, { cx, cy, w, h, area: w * h, bedIdx, placedIdx }); }
    };

    // A SATELLITE for the second bed in a void: ≤ half the first bed's area, offset from it at a seeded
    // NON-CARDINAL angle so the pair reads as an intentional asymmetric grouping, not a mirrored twin.
    const satelliteOf = (first: { cx: number; cy: number; w: number; h: number; area: number }, patch: number): { cx: number; cy: number; w: number; h: number } | null => {
      const satArea = Math.min(first.area / 2, 60);
      let sw = Math.max(5, Math.min(10, Math.round(Math.sqrt(satArea * 1.4))));
      let sh = Math.max(4, Math.min(9, Math.floor(satArea / sw)));
      if (sw * sh > first.area / 2 + 1e-9) sh = Math.max(4, Math.floor(first.area / 2 / sw));
      const rr = seededRng(fnv(`sat|${patch}|${Math.round(first.cx)}|${Math.round(first.cy)}`));
      const nonCardinal = [30, 60, 120, 150, 210, 240, 300, 330].map(d => d * Math.PI / 180);
      const startk = Math.floor(rr() * nonCardinal.length);
      const base = Math.max(first.w, first.h) / 2 + Math.max(sw, sh) / 2 + 2.5;
      for (const off of [base, base + 2, base + 4]) for (let k = 0; k < nonCardinal.length; k++) {
        const ang = nonCardinal[(startk + k) % nonCardinal.length];
        const cx = first.cx + Math.cos(ang) * off, cy = first.cy + Math.sin(ang) * off;
        const pos = settle(cx, cy, sw, sh);
        if (pos) return { cx: pos[0], cy: pos[1], w: sw, h: sh };
      }
      return null;
    };

    // Prefer GROWING the first bed in a void over adding a satellite when the deficit is small. Grows
    // the existing bed toward the 120sqft cap, re-validating with the bed itself excluded from the
    // self-collision test. Returns true if it grew (so no new bed is emitted this iteration).
    const growFirstBed = (patch: number): boolean => {
      const f = voidFirst.get(patch); if (!f || f.area >= 115) return false;
      const scale = Math.sqrt(Math.min(120, f.area * 1.5) / f.area);
      const nw = Math.min(14, Math.round(f.w * scale)), nh = Math.min(12, Math.round(f.h * scale));
      if (nw <= f.w && nh <= f.h) return false;
      const saved = placed[f.placedIdx]; placed.splice(f.placedIdx, 1);
      const pos = settle(f.cx, f.cy, nw, nh); placed.splice(f.placedIdx, 0, saved);
      if (!pos) return false;
      const nx = pos[0], ny = pos[1];
      if (!isTangent(nx, ny, nw, nh)) return false;   // growth may not float the bed off its armature line
      placed[f.placedIdx] = { ring: rectRing(nx, ny, nw, nh), cx: nx, cy: ny, w: nw, h: nh };
      consumeRect(nx, ny, nw, nh);
      const mat = bedMatFor(nx, ny, nw, nh); const b = beds[f.bedIdx];
      b.xFt = nx - nw / 2; b.yFt = ny - nh / 2; b.wFt = nw; b.hFt = nh; b.material = mat.material; b.variant = mat.variant;
      f.cx = nx; f.cy = ny; f.w = nw; f.h = nh; f.area = nw * nh;
      return true;
    };

    // ── CREEK (natural / desert only) — placed first, as the signature void-filler ─────────────────
    let creek: PlanPath | null = null;
    if (CREEK_CAP[style] >= 1) creek = buildCreek();
    if (creek) { deepUnderPolyline(creek.pts as Pt[], (creek.widthFt || 1) / 2 + 2); creekCorridors.push(creek.pts as Pt[]); }

    // Label the void patches NOW (post-creek) so same-void detection is stable across the loop.
    { let pid = 0; const seen = new Uint8Array(cols * rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = idx(c, r); if (state[i] !== 1 || consumed[i] || seen[i]) continue; const id = pid++; const stack = [[c, r]]; seen[i] = 1;
        while (stack.length) { const [cc, rr] = stack.pop()!; patchOf[idx(cc, rr)] = id;
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nc = cc + dc, nr = rr + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue; const j = idx(nc, nr); if (state[j] === 1 && !consumed[j] && !seen[j]) { seen[j] = 1; stack.push([nc, nr]); } } }
      } }

    const bedCap = BED_CAP[style];
    const deficitSmall = (): boolean => largestVoid().area <= LARGEST_VOID_TARGET;
    const stopSatisfied = (): boolean => deepRatio() <= DEEP_TARGET[style] && largestVoid().area <= LARGEST_VOID_TARGET && openAnchors.every(a => served.has(a));
    for (let iter = 0; iter < bedCap; iter++) {
      if (stopSatisfied()) break;
      const cands = bedCandidates().map(c => ({ c, s: scoreCand(c) }));
      // resolve each to a valid position, keep the best-scoring placeable one (deterministic tiebreak)
      cands.sort((p, q) => q.s - p.s || p.c.cx - q.c.cx || p.c.cy - q.c.cy || p.c.kind.localeCompare(q.c.kind));
      let done = false;
      for (const { c } of cands) {
        const island = c.kind === 'island_focal';
        const pos = settle(c.cx, c.cy, c.w, c.h);
        if (!pos) continue;
        let cx = pos[0], cy = pos[1], cw = c.w, ch = c.h;
        // BED POLICY: every regular bed FLANKS the armature. A settled candidate that drifted off
        // tangency is re-snapped to the nearest armature line — or rejected outright. Only the
        // island-focal exception may float free of every line.
        if (!island && !isTangent(cx, cy, cw, ch)) {
          const sp = snapToArmature(cx, cy, cw, ch);
          if (!sp) continue;
          cx = sp[0]; cy = sp[1];
        }
        // Same-void asymmetry: which void patch does this footprint sit in, and how many beds already?
        const patch = patchUnderRect(cx, cy, cw, ch);
        const pc = patch >= 0 ? (voidBedCount.get(patch) || 0) : 0;
        if (island && pc >= 1) continue;                                // at most ONE island per void — never beside another bed
        if (pc >= 2) continue;                                          // never a THIRD bed in one void patch
        if (pc === 1) {
          if (islandPatches.has(patch)) continue;                       // island-focal beds never get satellites (or growth)
          const first = voidFirst.get(patch)!;
          if (deficitSmall() && growFirstBed(patch)) { done = true; break; } // prefer growing the first bed
          const sat = satelliteOf(first, patch);                        // else this is a satellite
          if (!sat) continue;
          if (!isTangent(sat.cx, sat.cy, sat.w, sat.h)) continue;       // satellites obey the flanking policy too
          cx = sat.cx; cy = sat.cy; cw = sat.w; ch = sat.h;
        }
        // require it to actually be doing work (consume deep cells) unless it serves an anchor
        if (!c.anchor && deepUnderRect(cx, cy, cw, ch) < 2) continue;
        emitBed(cx, cy, cw, ch, c.reason, patch, island ? 'island_focal' : (pc === 1 ? 'satellite' : c.kind));
        if (island) {
          if (patch >= 0) islandPatches.add(patch);
          // ATOMIC pair: the island bed exists to host its specimen — the slot lands dead-centre.
          focalSlots.push({ x: cx, y: cy, tier: style === 'desert' ? 'rosette' : 'tree', reason: 'The specimen anchoring the island bed (bed+slot combo)' });
        }
        if (c.anchor) served.add(c.anchor);
        // entry beds (traditional/natural) deliberately carry a focal slot inside them
        if (c.kind === 'entry' && (style === 'traditional' || style === 'natural')) focalSlots.push({ x: cx, y: cy, tier: 'large_shrub', reason: 'A specimen within the entry bed (bed+slot combo)' });
        done = true; break;
      }
      if (!done) break;
    }

    // ── FOCAL SLOTS — tight, still-unserved anchors with little deep field get a specimen slot ────────
    const focalCap = anchors.length;
    const terminusTier: FocalSlot['tier'] = 'tree';
    const otherTier: FocalSlot['tier'] = (style === 'modern' || style === 'desert') ? 'rosette' : 'large_shrub';
    for (const a of openAnchors) {
      if (focalSlots.length >= focalCap) break;
      if (served.has(a) || !a.tight) continue;
      // a free-standing slot must NOT sit within 6ft of a placed bed (that would double-serve visually)
      if (placed.some(pl => Math.hypot(a.x - pl.cx, a.y - pl.cy) < 6)) continue;
      const tier = a.kind === 'terminus' ? terminusTier : otherTier;
      focalSlots.push({ x: a.x, y: a.y, tier, reason: a.reason });
      served.add(a);
    }

    return { beds, creek, focalSlots };

    // ── creek builder (closure — needs the grid + helpers above) ─────────────────────────────────
    // The creek reads as if it could carry water only if BOTH ends attach to logical armature: it must
    // APPEAR from somewhere on the high (house) side and GO somewhere on the low (street) side. So rather
    // than centring a fixed-reach segment on the void (which left endpoints floating in open mulch), we
    // generate ranked ORIGIN + TERMINUS candidates, then pick the best-ranked pair whose meander threads
    // the void AND fits the length cap WITHOUT ever detaching an end. If no attached pair fits, we drop
    // the creek — a floating endpoint is worse than no creek.
    function buildCreek(): PlanPath | null {
      const lvInfo = largestVoid();
      const lv = lvInfo.center;
      if (lvInfo.cells < 2) return null;

      // flow = house → street (streetward); back = its reverse (toward the house / high side).
      const flow: Pt = houseRing ? unit(centroid(houseRing), yardC) : (input.yardType === 'back' ? unit(yardC, streetPoint()) : unit(streetPoint(), yardC));
      const back: Pt = [-flow[0], -flow[1]];
      const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
      const cap = Math.min(30, diag * 0.35);

      // ── local geometry helpers ──
      const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
      const houseSide = (p: Pt) => dot([p[0] - lv[0], p[1] - lv[1]], flow) < 0;   // p is on the high side of the void
      const streetSide = (p: Pt) => dot([p[0] - lv[0], p[1] - lv[1]], flow) > 0;  // p is on the street side of the void
      const raySegT = (o: Pt, d: Pt, a: Pt, b: Pt): number | null => {
        const ex = b[0] - a[0], ey = b[1] - a[1], den = d[0] * ey - d[1] * ex;
        if (Math.abs(den) < 1e-9) return null;
        const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;      // param along the ray
        const s = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;  // param along the segment
        return (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6) ? t : null;
      };
      const rayBoundaryHit = (o: Pt, d: Pt): Pt | null => {
        let bestT = Infinity;
        for (let i = 0; i < boundary.length; i++) { const t = raySegT(o, d, boundary[i], boundary[(i + 1) % boundary.length]); if (t !== null && t < bestT) bestT = t; }
        return bestT < Infinity ? [o[0] + d[0] * bestT, o[1] + d[1] * bestT] : null;
      };
      const nearestOnClosedRing = (p: Pt, ring: Pt[]): Pt => {
        let q: Pt = ring[0], bd = Infinity;
        for (let i = 0; i < ring.length; i++) { const r = nearestOnSeg(p, ring[i], ring[(i + 1) % ring.length]); if (r.d < bd) { bd = r.d; q = r.q; } }
        return q;
      };
      // The point on a polyline that sits on the void's HIGH side and is closest to the void — this lets a
      // feature/walkway that only skirts the void near its house-ward end still serve as an origin.
      const highSidePointOnLine = (line: Pt[]): Pt | null => {
        let best: Pt | null = null, bestD = Infinity;
        for (const s of sampleByArc(line, 2)) { if (!houseSide(s.p)) continue; const d = dist(s.p, lv); if (d < bestD) { bestD = d; best = s.p; } }
        return best;
      };

      // SkipSpec: the single element the crossing walk ignores inside an endpoint's ~3ft neighbourhood.
      type Skip = { house?: boolean; boundary?: boolean; zoneIdx?: number; pathIdx?: number };
      type End = { p: Pt; rank: number; kind: string; skip: Skip };

      // ── ORIGIN candidates (water appears FROM somewhere), best story first ──────────────────────────
      const origins: End[] = [];
      const pushOrigin = (p: Pt, rank: number, kind: string, skip: Skip) => {
        if (pointInRing(p[0], p[1], boundary) && houseSide(p)) origins.push({ p, rank, kind, skip });
      };
      // (a) a downspout — offset ~1.5ft off the house wall toward the yard: the best possible story.
      for (const a of anchorsOf(input.facts, 'downspout')) { const dp = a.point as Pt | undefined; if (dp) pushOrigin([dp[0] + flow[0] * 1.5, dp[1] + flow[1] * 1.5], 0, 'downspout', { house: true }); }
      // (b) the nearest point on the HOUSE ring facing the void, offset ~1.5ft off the wall.
      if (houseRing) { const q = nearestOnClosedRing(lv, houseRing), out = unit(centroid(houseRing), q); pushOrigin([q[0] + out[0] * 1.5, q[1] + out[1] * 1.5], 1, 'house_wall', { house: true }); }
      // (c) the edge of a hardscape feature or walkway on the HIGH side of the void, offset ~1ft off it.
      for (let zi = 0; zi < zones.length; zi++) { if (zones[zi].key === 'lawn') continue; const q = highSidePointOnLine(closeRing(zoneBoxRing(zones[zi]))); if (q) { const out = unit(q, lv); pushOrigin([q[0] + out[0], q[1] + out[1]], 2, 'feature', { zoneIdx: zi }); } }
      for (let pi = 0; pi < paths.length; pi++) { const q = highSidePointOnLine(paths[pi].pts as Pt[]); if (q) { const out = unit(q, lv); pushOrigin([q[0] + out[0], q[1] + out[1]], 2, 'walkway', { pathIdx: pi }); } }
      // (d) LAST RESORT — the property edge on the high side (keeps no-house / back yards attachable).
      { const hit = rayBoundaryHit(lv, back); if (hit) pushOrigin([hit[0] + flow[0] * 0.3, hit[1] + flow[1] * 0.3], 3, 'boundary', { boundary: true }); }

      // ── TERMINUS candidates (water goes TO somewhere), best story first ─────────────────────────────
      // NEVER terminate at the house — water aimed at the foundation reads wrong — so the house wall is
      // deliberately absent from this list.
      const termini: End[] = [];
      const pushTerm = (p: Pt, rank: number, kind: string, skip: Skip) => {
        if (pointInRing(p[0], p[1], boundary) && streetSide(p)) termini.push({ p, rank, kind, skip });
      };
      // (a) the boundary edge in the flow direction — touch it (endpoint ~0.3ft inside, i.e. ≤0.5ft).
      { const hit = rayBoundaryHit(lv, flow); if (hit) pushTerm([hit[0] + back[0] * 0.3, hit[1] + back[1] * 0.3], 0, 'boundary', { boundary: true }); }
      // (b) a sidewalk anchor's near edge — stop ~1ft short of it.
      for (const a of anchorsOf(input.facts, 'sidewalk')) for (const g of anchorGeoms(a)) { const r = nearestOnPts(lv, g); if (r.d === Infinity) continue; const toYard = unit(r.q, lv); pushTerm([r.q[0] + toYard[0], r.q[1] + toYard[1]], 1, 'sidewalk', { boundary: true }); }

      if (!origins.length || !termini.length) return null;

      // ── crossing walk (arc-sampled): the ~3ft neighbourhood at each end is exempt WRT the element that
      // end attaches to (a house-wall origin's first 3ft may touch the house; a boundary/sidewalk
      // terminus's last 3ft may touch the boundary). Everything else keeps the standing no-cross rules. ──
      const clears = paths.map(p => ({ pts: p.pts as Pt[], clear: pathClear(p) + 1 }));
      const zoneB = zones.map(z => ({ x0: z.xFt - 1, y0: z.yFt - 1, x1: z.xFt + z.wFt + 1, y1: z.yFt + z.hFt + 1 }));
      const crosses = (p: Pt, skip: Skip): boolean => {
        if (!pointInRing(p[0], p[1], boundary) && !skip.boundary) return true;
        if (houseRing && pointInRing(p[0], p[1], houseRing) && !skip.house) return true;
        for (let zi = 0; zi < zoneB.length; zi++) { if (skip.zoneIdx === zi) continue; const b = zoneB[zi]; if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1) return true; }
        for (let pi = 0; pi < clears.length; pi++) { if (skip.pathIdx === pi) continue; if (nearestOnPts(p, clears[pi].pts).d < clears[pi].clear) return true; }
        for (const r of existingBedRings) if (pointInRing(p[0], p[1], r)) return true;
        return false;
      };
      const EXEMPT = 3;                                     // ~3ft neighbourhood exempted at each end
      const sgn = rng() < 0.5 ? 1 : -1;                     // seeded bow direction (determinism)
      // origin → void waypoint → terminus, two gentle alternating bows at amplitude `amp`.
      const meanderOf = (o: Pt, t: Pt, amp: number): Pt[] => {
        const spine: Pt[] = [o, [(o[0] + lv[0]) / 2, (o[1] + lv[1]) / 2], lv, [(lv[0] + t[0]) / 2, (lv[1] + t[1]) / 2], t];
        const u = unit(o, t), nrm: Pt = [-u[1], u[0]];
        return spine.map((p, i) => (i % 2 === 1) ? [p[0] + nrm[0] * amp * sgn * (i === 1 ? 1 : -1), p[1] + nrm[1] * amp * sgn * (i === 1 ? 1 : -1)] as Pt : p);
      };
      // Try one (origin, terminus) pair. The cap SHRINKS THE MEANDER (fewer/smaller bows → straighter)
      // instead of trimming an end: we walk amplitude down until the arc fits the cap, then reject the
      // pair on any mid-run crossing (never trim to a floating end — the caller tries the next pair).
      const tryPair = (o: End, t: End): Pt[] | null => {
        const straight = dist(o.p, lv) + dist(lv, t.p);
        if (straight > cap || straight < 12) return null;  // even straight overruns the cap, or too short to read
        const ampMax = Math.min(3, 0.1 * dist(o.p, t.p));
        for (const amp of [ampMax, ampMax * 0.6, ampMax * 0.3, 0]) {
          const pts = meanderOf(o.p, t.p, amp), total = polyLen(pts);
          if (total > cap) continue;                       // this bow overruns → straighten further
          if (total < 12) return null;
          const samples = sampleByArc(pts, 2);
          let bad = false;
          for (const s of samples) { const skip: Skip = { ...(s.len <= EXEMPT ? o.skip : {}), ...(s.len >= total - EXEMPT ? t.skip : {}) }; if (crosses(s.p, skip)) { bad = true; break; } }
          if (!bad) return pts;                             // a gentler bow may clear a crossing, so keep reducing
        }
        return null;
      };

      // ── SELECTION — respect the priority ranking (origin rank, then terminus rank); among equal ranks
      // prefer the pair most aligned with the flow (straightest thread through the void) for a clean read. ──
      const align = (o: End, t: End) => { const u = unit(o.p, t.p); return u[0] * flow[0] + u[1] * flow[1]; };
      const pairs: { o: End; t: End }[] = [];
      for (const o of origins) for (const t of termini) if (dist(o.p, t.p) >= 12) pairs.push({ o, t });
      pairs.sort((A, B) =>
        A.o.rank - B.o.rank || A.t.rank - B.t.rank ||
        align(B.o, B.t) - align(A.o, A.t) ||
        A.o.p[0] - B.o.p[0] || A.o.p[1] - B.o.p[1] || A.t.p[0] - B.t.p[0] || A.t.p[1] - B.t.p[1]);

      for (const { o, t } of pairs) {
        const pts = tryPair(o, t);
        if (pts) return { id: 'comp_creek_0', label: 'Dry creek bed', startId: 'auto', endId: 'auto', pts, style: 'winding', material: 'river-rock', widthFt: 2, kind: 'creek', color: '#A3A69D', reason: style === 'desert' ? 'An arroyo to give the gravel some movement' : 'A dry creek to give the yard a sense of flow' };
      }
      return null;   // no attached pair fits the cap + ≥12ft minimum → drop the creek
    }
  } catch { return empty; }
}

// ── polyline utilities (module scope; pure) ──────────────────────────────────────────────────────
function polyLen(pts: Pt[]): number { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]); return s; }
function sampleByArc(pts: Pt[], stepFt: number): { p: Pt; len: number }[] {
  const out: { p: Pt; len: number }[] = []; if (pts.length < 2) return out;
  let acc = 0; out.push({ p: pts[0], len: 0 });
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], seg = dist(a, b), n = Math.max(1, Math.floor(seg / stepFt));
    for (let k = 1; k <= n; k++) { const t = k / n; out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], len: acc + seg * t }); }
    acc += seg;
  }
  return out;
}
