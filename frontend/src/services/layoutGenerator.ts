import * as turf from '@turf/turf';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';
import { sampleSun, type SunMap } from './sunAnalysis';
import { planCirculation } from './circulationPlanner';
import { getSiteFacts } from './siteFacts';
import { composePlan, type FocalSlot } from './compositionPlanner';

// Rule-based automatic layout generator. Produces the SAME plan schema the manual /placement
// editor consumes ({zones, beds, paths, primary}); the editor re-derives ring/boundary/areas
// on mount, so the result is fully editable there. v1: rule-based heuristic.

type Ring = [number, number][];
interface PlanZone { id: string; key: string; label: string; color: string; material?: string; shape: 'rect' | 'circle' | 'organic'; xFt: number; yFt: number; wFt: number; hFt: number; verts?: [number, number][]; }
export interface PlanPath { id: string; label: string; startId: string; endId: string; pts: [number, number][]; style: 'straight' | 'winding'; material: string; widthFt: number; kind?: 'walkway' | 'creek'; color?: string; reason?: string; }
export interface GeneratedPlan { zones: PlanZone[]; beds: any[]; paths: PlanPath[]; primary: { material: string | null; variant: string | null }; focalSlots: FocalSlot[]; }

// Feature catalogue (matches the placement toolbar). zone = placement preference.
const FEAT: Record<string, { label: string; color: string; w: number; h: number; shape: 'rect' | 'circle'; material?: string; zone: 'house' | 'focal' | 'open' | 'corner' }> = {
  seating: { label: 'Seating',            color: '#B5A07A', w: 9,  h: 9,  shape: 'rect',   material: 'pavers',   zone: 'house' }, // small lounge cluster (2–4 chairs), not a dining table
  dining:  { label: 'Dining area',        color: '#C4A84A', w: 12, h: 12, shape: 'rect',   material: 'pavers',   zone: 'house' },
  cooking: { label: 'Fire pit / cooking', color: '#B87060', w: 8,  h: 8,  shape: 'rect',   material: 'concrete', zone: 'house' },
  water:   { label: 'Water feature',      color: '#6B93A8', w: 7,  h: 7,  shape: 'circle',                       zone: 'focal' },
  garden:  { label: 'Vegetable garden',   color: '#7A8B4A', w: 12, h: 6,  shape: 'rect',                         zone: 'open'  },
  storage: { label: 'Utility zone',       color: '#9A8B78', w: 10, h: 10, shape: 'rect',   material: 'gravel',   zone: 'corner' },
};
const ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage'];
const SNAP_HOUSE = new Set(['seating', 'dining', 'cooking', 'storage']); // these hug the house; water/garden don't
const SNAP_BOUNDARY = new Set(['garden', 'storage']);                    // can reach the property line (like beds/lawn)

// Default shape per feature + style. Built structures (raised beds, sheds) stay rectangular.
// whimsical → soft (circles/ovals + organic); desert → organic soft areas, rect hardscape;
// traditional → rect with round water/fire; modern → crisp rectangles.
function shapeFor(key: string, dbStyle: string): 'rect' | 'circle' | 'organic' {
  if (key === 'seating') return 'circle';               // seating reads best as a round lounge cluster
  if (key === 'garden' || key === 'storage') return 'rect';
  if (dbStyle === 'whimsical') return (key === 'lawn' || key === 'water') ? 'organic' : 'circle';
  if (dbStyle === 'desert') return (key === 'lawn' || key === 'water') ? 'organic' : 'rect';
  if (dbStyle === 'traditional') return (key === 'water' || key === 'cooking') ? 'circle' : 'rect';
  return 'rect'; // modern
}
const toDbStyle = (s: string): string => (({ natural_wild: 'whimsical', modern_structured: 'modern', desert_minimal: 'desert', traditional: 'traditional' } as Record<string, string>)[s] || 'traditional');

// Hardscape material for built features. Default for now is gravel everywhere; add per-style
// overrides here later (e.g. modern: { seating: 'concrete' }, traditional: { dining: 'pavers' }).
const DEFAULT_FEATURE_MATERIAL: Record<string, string> = { seating: 'gravel', dining: 'gravel', cooking: 'gravel', storage: 'gravel' };
const STYLE_FEATURE_MATERIAL: Record<string, Record<string, string>> = { whimsical: {}, modern: {}, traditional: {}, desert: {} };
const featMaterial = (key: string, dbStyle: string): string | undefined =>
  STYLE_FEATURE_MATERIAL[dbStyle]?.[key] ?? DEFAULT_FEATURE_MATERIAL[key] ?? FEAT[key]?.material;

function buildCS(verts: Ring) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats);
  const avg = (Math.min(...lats) + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT];
}
function ringArea(r: Ring) { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function centroid(r: Ring): [number, number] { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }
function closeRing(r: Ring): Ring { const f = r[0], l = r[r.length - 1]; return (f && l && f[0] === l[0] && f[1] === l[1]) ? r : [...r, r[0]]; }
function distToPolys(x: number, y: number, polys: Ring[]): number {
  let m = Infinity;
  for (const ring of polys) for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); m = Math.min(m, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy))); }
  return m === Infinity ? 0 : m;
}
// Min gap (ft) between two non-overlapping polygon outlines.
function polyGap(A: Ring, B: Ring): number {
  let m = Infinity;
  for (const p of A) m = Math.min(m, distToPolys(p[0], p[1], [B]));
  for (const p of B) m = Math.min(m, distToPolys(p[0], p[1], [A]));
  return m;
}
const GAP_MIN_FT = 2;   // matches the placement page's tight-gap warning — no slivers < 2 ft
const FLUSH_EPS = 0.3;  // ≤ this reads as "touching" (flush); a gap must be ≤FLUSH_EPS or ≥GAP_MIN
const SNAP_RANGE = 14;  // only snap to a target within this distance (else leave freestanding)
const gapOk = (g: number) => g <= FLUSH_EPS || g >= GAP_MIN_FT;
// Closest point on a polygon outline to (x,y), with its distance.
function nearestOnRing(x: number, y: number, ring: Ring): { q: [number, number]; d: number } {
  let best: { q: [number, number]; d: number } = { q: [x, y], d: Infinity };
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const qx = a[0] + t * dx, qy = a[1] + t * dy, d = Math.hypot(x - qx, y - qy); if (d < best.d) best = { q: [qx, qy], d }; }
  return best;
}
// True closest approach between two outlines: the min gap and the unit direction from A→B at
// that contact (snapping along this normal actually closes the gap, unlike a centre→point ray).
function closestApproach(A: Ring, B: Ring): { dist: number; dir: [number, number] } {
  let best = Infinity, aPt: [number, number] = [0, 0], bPt: [number, number] = [0, 0];
  for (const p of A) { const r = nearestOnRing(p[0], p[1], B); if (r.d < best) { best = r.d; aPt = [p[0], p[1]]; bPt = r.q; } }
  for (const p of B) { const r = nearestOnRing(p[0], p[1], A); if (r.d < best) { best = r.d; aPt = r.q; bPt = [p[0], p[1]]; } }
  const dx = bPt[0] - aPt[0], dy = bPt[1] - aPt[1], len = Math.hypot(dx, dy) || 1;
  return { dist: best, dir: [dx / len, dy / len] };
}

function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}
function hashId(id: string): number { let h = 0x811c9dc5; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function pointInRing(px: number, py: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
function ellipseRing(cx: number, cy: number, rx: number, ry: number, N = 40): Ring { const r: Ring = []; for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } r.push(r[0]); return r; }
// EXACT replica of DiyPlacementPage's organicRingFt so the generator collision-checks the same
// blob the editor renders (the blob reaches ~1.22× the half-extent, so bbox checks miss it).
function organicRingFt(cx: number, cy: number, rx: number, ry: number, id: string): Ring {
  const rng = seededRng(hashId(id)), N = 14, dentA = -Math.PI / 2;
  const pts: Ring = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const da = ((angle - dentA + Math.PI) % (Math.PI * 2)) - Math.PI;
    const dip = 0.5 * Math.exp(-(da * da) / (0.55 * 0.55));
    const j = (1 - dip) * (1 + (rng() * 2 - 1) * 0.06);
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j] as [number, number];
  });
  const ring: Ring = [], STEPS = 8;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < STEPS; s++) { const t = s / STEPS, u = 1 - t; ring.push([u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0], u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1]]); }
  }
  ring.push(ring[0]);
  return ring;
}

export function generateLayout(opts: { boundary: Ring; existing: ConfirmedFeature[]; prefs: any; seed?: number; door?: [number, number]; sun?: SunMap | null; yardType?: string }): GeneratedPlan | null {
  const { boundary, existing, prefs } = opts;
  const frontYard = (opts.yardType ?? prefs.yard_type) === 'front'; // front yards keep everything near the house
  const rng = seededRng(opts.seed ?? 1);
  if (!boundary || boundary.length < 3) return null;
  const cs = buildCS(boundary);
  const doorFt: [number, number] | null = opts.door ? cs(opts.door[0], opts.door[1]) : null;
  const boundaryFt = boundary.map(v => cs(v[0], v[1])) as Ring;
  const boundaryPoly = turf.polygon([closeRing(boundaryFt)]);
  const usableArea = ringArea(boundaryFt);

  const obstacles: Ring[] = [];            // everything features must avoid (no overlap, ≥2 ft gap)
  let houseRings: Ring[] = [];
  const hardscapeRings: Ring[] = [];       // existing paved surfaces (walkways/patios/driveways)
  const structureRings: Ring[] = [];       // sheds etc.
  for (const f of existing) {
    if (!f.keep || f.vertices.length < 3) continue;
    const ring = f.vertices.map(v => cs(v[0], v[1])) as Ring;
    // Existing TREES are obstacles too — don't build features on/under an established tree.
    if (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure' || f.type === 'tree') obstacles.push(ring);
    if (f.type === 'house') houseRings.push(ring);
    if (f.type === 'hardscape') hardscapeRings.push(ring);
    if (f.type === 'structure') structureRings.push(ring);
  }
  if (!houseRings.length) houseRings = hardscapeRings.slice(); // no house → use existing pavement for "near house"
  const obstaclePolys = obstacles.map(r => turf.polygon([closeRing(r)]));
  const houseCenter = houseRings.length ? centroid(houseRings.flat()) : centroid(boundaryFt);

  const xs = boundaryFt.map(p => p[0]), ys = boundaryFt.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const yardC = centroid(boundaryFt);
  const corners: [number, number][] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  const mult = Math.max(0.8, Math.min(1.8, Math.sqrt(usableArea / 1500)));

  const selected: string[] = Array.isArray(prefs?.space_usage) ? prefs.space_usage : [];
  const style = prefs?.style || '';
  const dbStyle = toDbStyle(style);
  const lawnTarget = typeof prefs?.lawnTarget === 'number' ? prefs.lawnTarget : 0.25;

  const placed: { ring: Ring; poly: any }[] = [];
  const zones: PlanZone[] = [];

  const rectRing = (cx: number, cy: number, w: number, h: number): Ring => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
  type RingAt = (cx: number, cy: number) => Ring;
  // A position→ring builder for the ACTUAL rendered shape, so collision matches what's drawn.
  const makeRingAt = (shape: string, w: number, h: number, id: string): RingAt => {
    if (shape === 'circle') return (cx, cy) => ellipseRing(cx, cy, w / 2, h / 2, 40);
    if (shape === 'organic') { const rel = organicRingFt(0, 0, w / 2, h / 2, id); return (cx, cy) => rel.map(p => [p[0] + cx, p[1] + cy] as [number, number]); }
    return (cx, cy) => rectRing(cx, cy, w, h);
  };
  const insideBoundary = (ring: Ring): boolean => { for (const p of ring) if (!pointInRing(p[0], p[1], boundaryFt)) return false; return true; };
  const fits = (ring: Ring): boolean => {
    if (!insideBoundary(ring)) return false;
    const rp = turf.polygon([closeRing(ring)]);
    // No overlap, and no sliver: each neighbour gap must be flush (≤FLUSH_EPS) or ≥GAP_MIN_FT.
    for (let i = 0; i < obstaclePolys.length; i++) { if (turf.booleanIntersects(rp, obstaclePolys[i])) return false; if (!gapOk(polyGap(ring, obstacles[i]))) return false; }
    for (const p of placed) { if (turf.booleanIntersects(rp, p.poly)) return false; if (!gapOk(polyGap(ring, p.ring))) return false; }
    return true;
  };
  // Slide a feature flush against its nearest sensible neighbour when one's close. Targets:
  // always hardscape/structures/other features; the house and/or property line per-feature
  // (water/garden don't snap to the house; only beds/lawn/garden/storage reach the line).
  // Trees are never snap targets. Validated against ALL obstacles (incl. house + trees).
  const snapFlush = (cx: number, cy: number, ringAt: RingAt, opts: { house?: boolean; boundary?: boolean } = {}): { cx: number; cy: number } => {
    const targets: Ring[] = [...hardscapeRings, ...structureRings, ...placed.map(p => p.ring), ...(opts.house ? houseRings : []), ...(opts.boundary ? [boundaryFt] : [])];
    const cur = ringAt(cx, cy);
    let gap = Infinity, dir: [number, number] = [1, 0];
    for (const t of targets) { const ca = closestApproach(cur, t); if (ca.dist < gap) { gap = ca.dist; dir = ca.dir; } }
    if (gap <= FLUSH_EPS || gap > SNAP_RANGE) return { cx, cy };
    const move = Math.max(0, gap - 0.1); // close along the true contact normal → flush, no sliver
    const nr = ringAt(cx + dir[0] * move, cy + dir[1] * move);
    if (!insideBoundary(nr)) return { cx, cy };
    const npoly = turf.polygon([closeRing(nr)]);
    for (let i = 0; i < obstaclePolys.length; i++) { if (turf.booleanIntersects(npoly, obstaclePolys[i])) return { cx, cy }; if (!gapOk(polyGap(nr, obstacles[i]))) return { cx, cy }; }
    for (const p of placed) { if (turf.booleanIntersects(npoly, p.poly)) return { cx, cy }; if (!gapOk(polyGap(nr, p.ring))) return { cx, cy }; }
    return { cx: cx + dir[0] * move, cy: cy + dir[1] * move };
  };
  const GRID = 30, sx = (maxX - minX) / GRID, sy = (maxY - minY) / GRID;
  // Collect fitting candidates (using the actual shape ring), pick (seeded) among the top few.
  const place = (ringAt: RingAt, score: (cx: number, cy: number) => number): { cx: number; cy: number } | null => {
    const cands: { cx: number; cy: number; s: number }[] = [];
    for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) {
      const cx = minX + i * sx, cy = minY + j * sy;
      if (fits(ringAt(cx, cy))) cands.push({ cx, cy, s: score(cx, cy) });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.s - a.s);
    const k = Math.max(1, Math.min(cands.length, Math.ceil(cands.length * 0.1), 24));
    return cands[Math.floor(rng() * k)];
  };

  const paths: PlanPath[] = [];
  let n = 0;
  for (const key of ORDER) {
    if (!selected.includes(key)) continue;
    const f = FEAT[key];
    const shape = shapeFor(key, dbStyle);
    let w = Math.max(4, Math.round(f.w * mult)), h = Math.max(4, Math.round(f.h * mult));
    if (dbStyle === 'whimsical' && shape === 'circle') { w = Math.round(w * 1.2); h = Math.round(h * 0.85); } // gentle oval
    const zoneId = `gen_${key}_${n++}`;
    const ringAt = makeRingAt(shape, w, h, zoneId);
    const seating = zones.find(z => z.key === 'seating');
    const seatC: [number, number] | null = seating ? [seating.xFt + seating.wFt / 2, seating.yFt + seating.hFt / 2] : null;
    // Seating: front yards always hug the house; backyards may sit near the house OR read as a
    // destination out in the yard (a sited retreat), decided once per run.
    const seatMode: 'house' | 'dest' = key === 'seating' ? (frontYard ? 'house' : (rng() < 0.5 ? 'house' : 'dest')) : 'house';
    const score = (cx: number, cy: number): number => {
      const dHouse = distToPolys(cx, cy, houseRings);
      const dBoundary = distToPolys(cx, cy, [boundaryFt]);
      // Sun bias: a veggie garden wants full sun; seating is nicer with some shade — but NOT in a
      // front yard, where seating should hug the house (a shady far corner shouldn't pull it out).
      let sun = 0;
      if (opts.sun) { const s = sampleSun(opts.sun, cx, cy); if (key === 'garden') sun = s * 60; else if (key === 'seating' && !frontYard) sun = (1 - s) * 45; }
      // The veggie garden reads best as its own area — reward sitting apart from other features,
      // except seating (a garden beside a seating area is fine / even nice).
      let sep = 0;
      if (key === 'garden' && zones.length) {
        let d = Infinity;
        for (const pz of zones) { if (pz.key === 'seating') continue; const px = pz.xFt + pz.wFt / 2, py = pz.yFt + pz.hFt / 2; d = Math.min(d, Math.hypot(cx - px, cy - py)); }
        if (d < Infinity) sep = Math.min(d, 28) * 1.4;
      }
      // Backyard seating as a destination: reward an open spot set out from the house.
      if (key === 'seating' && seatMode === 'dest') return dHouse * 0.7 - dBoundary * 0.1 + sun + sep;
      // House-adjacent features cluster near the marked main entry (fall back to the house).
      if (f.zone === 'house') return (doorFt ? -Math.hypot(cx - doorFt[0], cy - doorFt[1]) : -dHouse - dBoundary * 0.05) + sun + sep;
      if (f.zone === 'focal') return (seatC ? -Math.hypot(cx - seatC[0], cy - seatC[1]) : -Math.hypot(cx - yardC[0], cy - yardC[1])) + sun + sep;
      if (f.zone === 'open') return dHouse - dBoundary * 0.1 + sun + sep;            // open & a bit off the edge
      return dHouse - Math.min(...corners.map(c => Math.hypot(cx - c[0], cy - c[1]))) + sun + sep; // corner: far from house, near a corner
    };
    const spot = place(ringAt, score);
    if (!spot) continue;
    const snapped = snapFlush(spot.cx, spot.cy, ringAt, { house: SNAP_HOUSE.has(key), boundary: SNAP_BOUNDARY.has(key) });
    const cx = snapped.cx, cy = snapped.cy;
    const ring = ringAt(cx, cy);
    placed.push({ ring, poly: turf.polygon([closeRing(ring)]) });
    zones.push({ id: zoneId, key, label: f.label, color: f.color, material: featMaterial(key, dbStyle), shape, xFt: cx - w / 2, yFt: cy - h / 2, wFt: w, hFt: h });
    // (Walkways are not auto-placed — they'll be offered in the future "details" step.)
  }

  // Lawn — centred LEFT–RIGHT, then anchored FRONT–BACK one of three ways (chosen by seed,
  // leaning centred): against the house, against the front/property line, or floating with
  // borders all around.
  if (lawnTarget > 0) {
    let area = usableArea * lawnTarget, w = Math.max(8, Math.sqrt(area)), h = w;
    // Axes: frontDir = house→yard (front/back); crossDir = perpendicular (left/right).
    let frontDir: [number, number];
    if (houseRings.length) { const dx = yardC[0] - houseCenter[0], dy = yardC[1] - houseCenter[1], len = Math.hypot(dx, dy) || 1; frontDir = [dx / len, dy / len]; }
    else { frontDir = (maxX - minX) >= (maxY - minY) ? [0, 1] : [1, 0]; } // no house → depth is the shorter axis
    const crossDir: [number, number] = [-frontDir[1], frontDir[0]];
    const crossCenter = yardC[0] * crossDir[0] + yardC[1] * crossDir[1];
    const fproj = boundaryFt.map(p => p[0] * frontDir[0] + p[1] * frontDir[1]);
    const fMin = Math.min(...fproj), fMax = Math.max(...fproj), fMid = (fMin + fMax) / 2;
    const r = rng(); const mode = r < 0.5 ? 'centered' : r < 0.75 ? 'house' : 'front';
    const lawnScore = (cx: number, cy: number) => {
      const cross = cx * crossDir[0] + cy * crossDir[1], front = cx * frontDir[0] + cy * frontDir[1];
      let s = -Math.abs(cross - crossCenter) * 2; // primary: centre left–right
      if (mode === 'house') s += -(front - fMin); else if (mode === 'front') s += -(fMax - front); else s += -Math.abs(front - fMid);
      return s;
    };
    const lawnId = `gen_lawn_${n++}`, lawnShape = shapeFor('lawn', dbStyle);
    // The lawn may OVERLAP movable features (we don't bake the carve — every view clips/layers
    // features over the lawn, so dragging a feature OUT refills it). But it must sit BESIDE fixed
    // things — house, existing hardscape, WALKWAYS, trees — flush-or-≥2 ft, never straddling them
    // (a walkway should edge the lawn, not split it into slivers).
    const lawnFits = (ring: Ring): boolean => {
      if (!insideBoundary(ring)) return false;
      const rp = turf.polygon([closeRing(ring)]);
      for (let i = 0; i < obstaclePolys.length; i++) { if (turf.booleanIntersects(rp, obstaclePolys[i])) return false; if (!gapOk(polyGap(ring, obstacles[i]))) return false; }
      for (const p of placed) { if (turf.booleanIntersects(rp, p.poly)) continue; if (!gapOk(polyGap(ring, p.ring))) return false; }
      return true;
    };
    let spot: { cx: number; cy: number; w: number; h: number } | null = null;
    for (let tries = 0; tries < 7 && !spot; tries++) {
      const ringAt = makeRingAt(lawnShape, w, h, lawnId);
      let best: { cx: number; cy: number } | null = null, bestS = -Infinity;
      for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) { const cx = minX + i * sx, cy = minY + j * sy; if (lawnFits(ringAt(cx, cy))) { const s = lawnScore(cx, cy); if (s > bestS) { bestS = s; best = { cx, cy }; } } }
      if (best) spot = { ...best, w, h }; else { w *= 0.84; h *= 0.84; }
    }
    if (spot) zones.push({ id: lawnId, key: 'lawn', label: 'Lawn', color: '#8DAA6A', shape: lawnShape, xFt: spot.cx - spot.w / 2, yFt: spot.cy - spot.h / 2, wFt: Math.round(spot.w), hFt: Math.round(spot.h) });
  }

  // ── Circulation (walkways) ────────────────────────────────────────────────────────
  // Route ALL walkways deterministically from the site's desire-line graph. Facts come from the
  // site-facts model (aerial + Street View + user). This SUBSUMES the old hardcoded side-gate rule:
  // the planner's sidewalk↔side_gate edge replaces it, using the same anchor semantics. When facts
  // are absent we skip circulation entirely (parity with pre-facts behaviour, minus that old rule).
  // Wrapped so it can never break plan generation.
  try {
    const facts = getSiteFacts();
    if (facts) {
      let houseRing: Ring | null = null;
      if (houseRings.length) { houseRing = houseRings[0]; let bA = ringArea(houseRing); for (const r of houseRings) { const a = ringArea(r); if (a > bA) { bA = a; houseRing = r; } } }
      const circ = planCirculation({ boundaryFt, houseRing, zones, existingPaths: paths, facts, style: dbStyle, yardType: frontYard ? 'front' : 'back' });
      for (const p of circ) { if (!paths.some(ep => ep.label === p.label)) paths.push(p); }
    }
  } catch { /* facts/circulation unavailable — never break plan generation */ }

  // Primary ground cover defaults by style (editable in the details panel): desert reads as rock,
  // everything else as natural mulch. Computed BEFORE composition so the composer can pick a
  // contrasting bed material against the plan's ground cover.
  const primary: { material: string | null; variant: string | null } =
    dbStyle === 'desert' ? { material: 'rock', variant: 'pea' } : { material: 'mulch', variant: 'natural' };

  // ── Composition (aesthetic massing) ─────────────────────────────────────────────────
  // AFTER features + lawn + circulation, BEFORE plant placement: fill the deadest voids with accent
  // beds, an optional dry creek, and focal-plant slots. Merged idempotently (comp beds by id prefix
  // `comp_bed_`, the creek by id `comp_creek_0`). Wrapped so it can never break plan generation.
  const beds: any[] = [];
  let focalSlots: FocalSlot[] = [];
  try {
    const facts = getSiteFacts();
    let houseRing: Ring | null = null;
    if (houseRings.length) { houseRing = houseRings[0]; let bA = ringArea(houseRing); for (const r of houseRings) { const a = ringArea(r); if (a > bA) { bA = a; houseRing = r; } } }
    const comp = composePlan({
      boundaryFt, houseRing, zones, paths,
      existingBeds: beds,                                  // plan.beds before merge (always [] at this point)
      facts, sun: opts.sun ?? null, style: dbStyle, yardType: frontYard ? 'front' : 'back',
      plantDensity: typeof prefs?.plantDensity === 'number' ? prefs.plantDensity : undefined,
      primary,
    });
    // Accent beds are NOT auto-placed (user 2026-07: "they still feel strange — don't place any").
    // Users add planting beds themselves in the editor. The composer's creek + focal-plant slots
    // are still used. To re-enable auto accent beds, restore the merge below.
    // for (const b of comp.beds) if (b && !beds.some(eb => eb.id === b.id)) beds.push(b);       // idempotent: comp_bed_*
    if (comp.creek && !paths.some(p => p.id === comp.creek!.id)) paths.push(comp.creek);      // idempotent: comp_creek_0
    focalSlots = comp.focalSlots ?? [];
  } catch { /* composition unavailable — never break plan generation */ }

  return { zones, beds, paths, primary, focalSlots };
}
