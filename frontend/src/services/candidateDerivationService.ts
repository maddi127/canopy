import * as turf from '@turf/turf';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';
import type { SunCell, SunClass } from './sunModelingService';

// ── Tunable config (all numeric values should live here, not scattered in code) ──
export const CANDIDATE_CONFIG = {
  // Bed band widths (ft)
  foundationBedFt:     4,
  perimeterBedFt:      3,
  hardscapeEdgeFt:     2,
  treeUnderplantBufFt: 1,    // outward buffer beyond the confirmed drip-line
  structSetbackFt:     1.5,  // no-plant zone from structure wall/eave
  minBedAreaSqFt:      15,
  minBedWidthFt:       2,    // auto-shrink floor before emitting a warning

  // Activity placement
  activityStrideFt:    3,    // footprint-slide sampling stride
  dedupeRadiusFt:      5,    // collapse candidates closer than this to the higher scorer
  maxCandidates:       5,    // top N kept per activity type
  sightlineRays:       8,    // rays cast for sightline quality
  sightlineObstacleFt: 15,   // ray length for obstacle detection

  // Scoring weights (must sum to 1.0)
  weights: {
    doorProximity:    0.30,
    sunComfortFit:    0.25,
    sightlineQuality: 0.20,
    privacy:          0.15,
    backyardBonus:    0.10,
  },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActivitySunPref = 'prefer_shade' | 'prefer_sun' | 'any';

export interface ActivitySpec {
  id:             string;
  label:          string;
  footprintFt:    { w: number; h: number };
  clearanceFt:    number;
  sunPref:        ActivitySunPref;
  invertScoring?: boolean;  // true for utility objects (storage shed)
}

export interface BedRegion {
  id:               string;
  source:           'foundation' | 'perimeter' | 'hardscape_edge' | 'tree_underplant';
  vertices:         [number, number][];
  areaSqFt:         number;
  dominantSunClass: SunClass;
  anchorFeatureId?: string;  // tree id for underplant beds
}

export interface ScoreBreakdown {
  doorProximity:    number;  // 0–1
  sunComfortFit:    number;  // 0–1
  sightlineQuality: number;  // 0–1
  privacy:          number;  // 0–1
  backyardBonus:    number;  // 0–1
  total:            number;  // weighted sum
}

export interface ActivityCandidate {
  id:               string;
  activityType:     string;
  center:           [number, number];
  footprintVertices: [number, number][];
  areaSqFt:         number;
  score:            number;
  scoreBreakdown:   ScoreBreakdown;
}

export interface PlantableArea {
  vertices: [number, number][];  // largest contiguous ring
  totalSqFt: number;             // sum across all rings (incl. disconnected patches)
}

export interface CandidateDerivationResult {
  beds:          BedRegion[];
  activities:    Record<string, ActivityCandidate[]>;
  plantableArea: PlantableArea;
  warnings:      string[];
}

export interface CandidateDerivationInputs {
  boundaryVerts:      [number, number][];
  features:           ConfirmedFeature[];
  sunCells:           SunCell[];
  requestedFeatures:  string[];              // user's space_usage ids
  yardType:           'front' | 'back';
  doorPoint?:         [number, number] | null;  // lng/lat of back door
  frontEdgeMidpoint?: [number, number] | null;  // midpoint of street-facing boundary edge
}

// ── Activity specs — concrete geometry for placement ──────────────────────────
// Bridges featureTable.ts entries (which describe intent) to the geometry the
// placement engine needs (footprint dims + clearance + sun preference).
// 'lawn' and 'trees' have no activity candidates; they use residual / anchor logic.

export const ACTIVITY_SPECS: Record<string, ActivitySpec> = {
  seating:  { id: 'seating',  label: 'Seating area',     footprintFt: { w: 8,  h: 8  }, clearanceFt: 2, sunPref: 'prefer_shade' },
  dining:   { id: 'dining',   label: 'Dining area',      footprintFt: { w: 16, h: 14 }, clearanceFt: 2, sunPref: 'prefer_shade' },
  cooking:  { id: 'cooking',  label: 'Cooking area',     footprintFt: { w: 5,  h: 8  }, clearanceFt: 3, sunPref: 'any'          },
  water:    { id: 'water',    label: 'Water feature',    footprintFt: { w: 9,  h: 9  }, clearanceFt: 2, sunPref: 'any'          },
  storage:  { id: 'storage',  label: 'Storage shed',     footprintFt: { w: 10, h: 8  }, clearanceFt: 1, sunPref: 'prefer_shade', invertScoring: true },
  garden:   { id: 'garden',   label: 'Vegetable garden', footprintFt: { w: 10, h: 4  }, clearanceFt: 2, sunPref: 'prefer_sun'   },
};

const SKIP_CANDIDATE_GEN = new Set(['lawn', 'trees']);

// ── Geo constants & helpers ───────────────────────────────────────────────────

const FT_TO_KM      = 0.3048 / 1000;
const M_PER_DEG_LAT = 111320;

type GF = turf.Feature<turf.Polygon | turf.MultiPolygon>;

function toPoly(verts: [number, number][]): GF | null {
  if (verts.length < 3) return null;
  try { return turf.polygon([[...verts, verts[0]]]) as GF; } catch { return null; }
}

function buf(f: GF, distKm: number): GF | null {
  try { return turf.buffer(f as any, distKm, { units: 'kilometers', steps: 16 }) as GF | null; } catch { return null; }
}

function safeDiff(a: GF, b: GF): GF | null {
  try { return turf.difference(a as any, b as any) as GF | null; } catch { return null; }
}

function safeIntersect(a: GF, b: GF): GF | null {
  try { return turf.intersect(a as any, b as any) as GF | null; } catch { return null; }
}

function unionAll(polys: GF[]): GF | null {
  if (!polys.length) return null;
  let acc: GF = polys[0];
  for (let i = 1; i < polys.length; i++) {
    try { const u = turf.union(acc as any, polys[i] as any); if (u) acc = u as GF; } catch {}
  }
  return acc;
}

function extractRings(f: GF | null): [number, number][][] {
  if (!f) return [];
  const g = f.geometry;
  if (g.type === 'Polygon') {
    const r = g.coordinates[0] as [number, number][];
    return r.length >= 4 ? [r.slice(0, -1)] : [];
  }
  if (g.type === 'MultiPolygon') {
    return (g.coordinates as any[])
      .map((p: any) => (p[0] as [number, number][]).slice(0, -1))
      .filter((r: [number, number][]) => r.length >= 3);
  }
  return [];
}

function areaSqFt(verts: [number, number][]): number {
  if (verts.length < 3) return 0;
  try { return turf.area(turf.polygon([[...verts, verts[0]]])) * 10.7639; } catch { return 0; }
}

function areaSqFtGF(f: GF): number {
  try { return turf.area(f as any) * 10.7639; } catch { return 0; }
}

// Ray-casting point-in-polygon
function pip(pt: [number, number], ring: [number, number][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ftToLng(ft: number, lat: number): number {
  return (ft * 0.3048) / (M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
}
function ftToLat(ft: number): number { return (ft * 0.3048) / M_PER_DEG_LAT; }

function centroidOf(verts: [number, number][]): [number, number] {
  return [
    verts.reduce((s, v) => s + v[0], 0) / verts.length,
    verts.reduce((s, v) => s + v[1], 0) / verts.length,
  ];
}

function distM(a: [number, number], b: [number, number]): number {
  try { return turf.distance(turf.point(a), turf.point(b), { units: 'meters' }); } catch { return 0; }
}

// Rectangle vertices (open ring, CCW) for a center + dims in ft
function rectVerts(center: [number, number], wFt: number, hFt: number): [number, number][] {
  const dLng = ftToLng(wFt / 2, center[1]);
  const dLat = ftToLat(hFt / 2);
  return [
    [center[0] - dLng, center[1] - dLat],
    [center[0] + dLng, center[1] - dLat],
    [center[0] + dLng, center[1] + dLat],
    [center[0] - dLng, center[1] + dLat],
  ];
}

// 9-point containment check: corners + edge midpoints + center all inside viable rings
function rectFitsInViable(
  center: [number, number],
  wFt: number,
  hFt: number,
  viableRings: [number, number][][],
): boolean {
  const dLng = ftToLng(wFt / 2, center[1]);
  const dLat = ftToLat(hFt / 2);
  const pts: [number, number][] = [
    center,
    [center[0] - dLng, center[1] - dLat],
    [center[0] + dLng, center[1] - dLat],
    [center[0] + dLng, center[1] + dLat],
    [center[0] - dLng, center[1] + dLat],
    [center[0],        center[1] - dLat],
    [center[0],        center[1] + dLat],
    [center[0] - dLng, center[1]       ],
    [center[0] + dLng, center[1]       ],
  ];
  return pts.every(pt => viableRings.some(ring => pip(pt, ring)));
}

// Average sun hours for cells whose center falls inside a rectangle
function avgSunAtRect(
  center: [number, number],
  wFt: number,
  hFt: number,
  cells: SunCell[],
): number | null {
  const ring = rectVerts(center, wFt, hFt);
  let total = 0, count = 0;
  for (const c of cells) {
    if (pip([c.lng, c.lat], ring)) { total += c.hoursPerDay; count++; }
  }
  return count > 0 ? total / count : null;
}

function classifyHours(h: number): SunClass {
  if (h >= 6) return 'full_sun';
  if (h >= 4) return 'part_sun';
  if (h >= 2) return 'part_shade';
  return 'full_shade';
}

// Min distance (meters) from a point to any edge of the boundary polygon
function minDistToBoundaryM(center: [number, number], boundaryVerts: [number, number][]): number {
  const n = boundaryVerts.length;
  let minDist = Infinity;
  for (let i = 0; i < n; i++) {
    const a = boundaryVerts[i];
    const b = boundaryVerts[(i + 1) % n];
    try {
      const nearest = turf.nearestPointOnLine(
        turf.lineString([a, b]),
        turf.point(center),
        { units: 'meters' },
      );
      const d = (nearest.properties as any)?.dist ?? distM(center, a);
      if (d < minDist) minDist = d;
    } catch {
      minDist = Math.min(minDist, distM(center, a));
    }
  }
  return minDist === Infinity ? 0 : minDist;
}

// ── Scoring functions ─────────────────────────────────────────────────────────

function scoreSunComfort(spec: ActivitySpec, avgHours: number | null): number {
  if (avgHours === null) return 0.5;
  const cls = classifyHours(avgHours);
  // Storage shed inverts: prefers shade corners
  if (spec.invertScoring) {
    return { full_shade: 1.0, part_shade: 0.8, part_sun: 0.5, full_sun: 0.2 }[cls];
  }
  switch (spec.sunPref) {
    case 'prefer_shade':
      return { full_shade: 0.85, part_shade: 1.0, part_sun: 0.75, full_sun: 0.40 }[cls];
    case 'prefer_sun':
      return { full_shade: 0.0,  part_shade: 0.30, part_sun: 0.70, full_sun: 1.0 }[cls];
    default:
      return 0.5;
  }
}

function scoreDoorProximity(
  center: [number, number],
  doorPoint: [number, number] | null | undefined,
  maxDistM: number,
  invert: boolean,
): number {
  if (!doorPoint) return 0.5;
  const raw = 1 - Math.min(distM(center, doorPoint) / maxDistM, 1);
  return invert ? 1 - raw : raw;
}

// Cast 8 rays from center; score = fraction unobstructed by structure polygons within obstDist
function scoreSightline(
  center: [number, number],
  structurePolys: GF[],
  invert: boolean,
): number {
  const rays = CANDIDATE_CONFIG.sightlineRays;
  const obstFt = CANDIDATE_CONFIG.sightlineObstacleFt;
  let free = 0;
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * 2 * Math.PI;
    const end: [number, number] = [
      center[0] + ftToLng(obstFt * Math.sin(angle), center[1]),
      center[1] + ftToLat(obstFt * Math.cos(angle)),
    ];
    let blocked = false;
    try {
      const ray = turf.lineString([center, end]);
      for (const sp of structurePolys) {
        if (turf.booleanCrosses(ray as any, sp as any)) { blocked = true; break; }
      }
    } catch {}
    if (!blocked) free++;
  }
  // Floor at 0.3 — even a fully enclosed spot has some openness
  const score = 0.3 + (free / rays) * 0.7;
  // Shed inverts: hidden corners are preferred
  return invert ? Math.max(0, 1 - score + 0.3) : score;
}

function scorePrivacy(
  center: [number, number],
  boundaryVerts: [number, number][],
  frontEdgeMidpoint: [number, number] | null | undefined,
): number {
  const distToBoundary = minDistToBoundaryM(center, boundaryVerts);
  // 8m (≈26 ft) from boundary = full privacy score
  let score = Math.min(distToBoundary / 8, 1);
  // Penalize being close to the front edge
  if (frontEdgeMidpoint) {
    const frontDistM = distM(center, frontEdgeMidpoint);
    const boundaryDiag = distM(boundaryVerts[0], boundaryVerts[Math.floor(boundaryVerts.length / 2)]);
    const frontPenalty = Math.max(0, 1 - frontDistM / Math.max(boundaryDiag, 1)) * 0.4;
    score = Math.max(0, score - frontPenalty);
  }
  return score;
}

function scoreBackyardBonus(
  center: [number, number],
  frontEdgeMidpoint: [number, number] | null | undefined,
  bboxDiagM: number,
  invert: boolean,
): number {
  if (!frontEdgeMidpoint) return 0.5;
  const d = distM(center, frontEdgeMidpoint);
  const score = Math.min(d / Math.max(bboxDiagM / 2, 1), 1);
  return invert ? 1 - score : score;
}

function computeScore(
  center: [number, number],
  spec: ActivitySpec,
  sunCells: SunCell[],
  structurePolys: GF[],
  boundaryVerts: [number, number][],
  doorPoint: [number, number] | null | undefined,
  frontEdgeMidpoint: [number, number] | null | undefined,
  maxDistM: number,
  bboxDiagM: number,
): ScoreBreakdown {
  const inv = spec.invertScoring ?? false;
  const avgH = avgSunAtRect(center, spec.footprintFt.w, spec.footprintFt.h, sunCells);
  const doorProximity    = scoreDoorProximity(center, doorPoint, maxDistM, inv);
  const sunComfortFit    = scoreSunComfort(spec, avgH);
  const sightlineQuality = scoreSightline(center, structurePolys, inv);
  const privacy          = scorePrivacy(center, boundaryVerts, frontEdgeMidpoint);
  const backyardBonus    = scoreBackyardBonus(center, frontEdgeMidpoint, bboxDiagM, inv);
  const w = CANDIDATE_CONFIG.weights;
  const total =
    doorProximity    * w.doorProximity    +
    sunComfortFit    * w.sunComfortFit    +
    sightlineQuality * w.sightlineQuality +
    privacy          * w.privacy          +
    backyardBonus    * w.backyardBonus;
  return { doorProximity, sunComfortFit, sightlineQuality, privacy, backyardBonus, total };
}

// ── Bed candidate generation ──────────────────────────────────────────────────
// §2: four sources — foundation, perimeter, hardscape_edge, tree_underplant

function deriveBedCandidates(
  boundaryPoly: GF,
  features: ConfirmedFeature[],
  sunCells: SunCell[],
  yardType: 'front' | 'back',
  warnings: string[],
): BedRegion[] {
  const cfg = CANDIDATE_CONFIG;
  const trees      = features.filter(f => f.type === 'tree');
  const structures = features.filter(f => f.type === 'structure');
  const hardscapes = features.filter(f => f.type === 'hardscape');

  const structPolys = structures.map(f => toPoly(f.vertices)).filter(Boolean) as GF[];
  const treePolys   = trees.map(f => toPoly(f.vertices)).filter(Boolean) as GF[];
  const hsPolys     = hardscapes.map(f => toPoly(f.vertices)).filter(Boolean) as GF[];

  // No-go for beds = structure setbacks only (trees are valid planting zones)
  const bedNoGo = unionAll(
    structPolys.map(p => buf(p, cfg.structSetbackFt * FT_TO_KM)).filter(Boolean) as GF[]
  );

  const clipAndCut = (src: GF | null): GF | null => {
    if (!src) return null;
    const clipped = safeIntersect(src, boundaryPoly);
    if (!clipped) return null;
    return bedNoGo ? (safeDiff(clipped, bedNoGo) ?? clipped) : clipped;
  };

  const results: BedRegion[] = [];
  let n = 0;

  const addRings = (src: GF | null, source: BedRegion['source'], anchorId?: string) => {
    for (const verts of extractRings(src)) {
      const sqFt = areaSqFt(verts);
      if (sqFt < cfg.minBedAreaSqFt) continue;
      const ctr = centroidOf(verts);
      const approxDim = Math.sqrt(sqFt);
      const avgH = avgSunAtRect(ctr, approxDim, approxDim, sunCells);
      const dominantSunClass: SunClass = avgH !== null ? classifyHours(avgH) : 'part_shade';
      results.push({
        id: `bed_${source}_${++n}`,
        source,
        vertices: verts,
        areaSqFt: sqFt,
        dominantSunClass,
        anchorFeatureId: anchorId,
      });
    }
  };

  // 1. Foundation bands — outward offset from each structure wall, skip the setback zone
  for (const sp of structPolys) {
    const outer = buf(sp, (cfg.structSetbackFt + cfg.foundationBedFt) * FT_TO_KM);
    const inner = buf(sp, cfg.structSetbackFt * FT_TO_KM);
    if (!outer || !inner) continue;
    addRings(clipAndCut(safeDiff(outer, inner)), 'foundation');
  }

  // 2. Perimeter band — inward from property line; suppressed in front yard
  if (yardType !== 'front') {
    let width = cfg.perimeterBedFt;
    let placed = false;
    while (width >= cfg.minBedWidthFt && !placed) {
      const inner = buf(boundaryPoly, -width * FT_TO_KM);
      if (inner) {
        const band = clipAndCut(safeDiff(boundaryPoly, inner));
        if (band && areaSqFtGF(band) >= cfg.minBedAreaSqFt) {
          addRings(band, 'perimeter');
          placed = true;
        }
      }
      width -= 0.5;
    }
    if (!placed) warnings.push('Yard too small for perimeter beds at minimum width.');
  }

  // 3. Hardscape edge strips — outward offset from kept hardscape edges
  for (const hp of hsPolys) {
    const outer = buf(hp, cfg.hardscapeEdgeFt * FT_TO_KM);
    if (!outer) continue;
    addRings(clipAndCut(safeDiff(outer, hp)), 'hardscape_edge');
  }

  // 4. Tree underplant — drip-line polygon + outward buffer
  for (let i = 0; i < trees.length; i++) {
    const tp = treePolys[i];
    const outer = buf(tp, cfg.treeUnderplantBufFt * FT_TO_KM);
    if (!outer) continue;
    // Don't cut by bedNoGo — tree zones aren't structure setbacks
    const clipped = safeIntersect(outer, boundaryPoly);
    for (const verts of extractRings(clipped)) {
      const sqFt = areaSqFt(verts);
      if (sqFt < cfg.minBedAreaSqFt) continue;
      const ctr = centroidOf(verts);
      const avgH = avgSunAtRect(ctr, Math.sqrt(sqFt), Math.sqrt(sqFt), sunCells);
      const dominantSunClass: SunClass = avgH !== null ? classifyHours(avgH) : 'full_shade';
      results.push({
        id: `bed_tree_${++n}`,
        source: 'tree_underplant',
        vertices: verts,
        areaSqFt: sqFt,
        dominantSunClass,
        anchorFeatureId: trees[i].id,
      });
    }
  }

  return results;
}

// ── Activity candidate generation ─────────────────────────────────────────────
// §3: slide footprint across viable area, score each valid position, keep top N

function deriveActivityCandidates(
  spec: ActivitySpec,
  viableArea: GF,
  boundaryVerts: [number, number][],
  structurePolys: GF[],
  sunCells: SunCell[],
  doorPoint: [number, number] | null | undefined,
  frontEdgeMidpoint: [number, number] | null | undefined,
  warnings: string[],
): ActivityCandidate[] {
  const cfg = CANDIDATE_CONFIG;
  const viableRings = extractRings(viableArea);
  if (!viableRings.length) {
    warnings.push(`No viable area for ${spec.label}.`);
    return [];
  }

  const bbox = turf.bbox(viableArea);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const refLat = (minLat + maxLat) / 2;

  const bboxWM = (maxLng - minLng) * M_PER_DEG_LAT * Math.cos(refLat * Math.PI / 180);
  const bboxHM = (maxLat - minLat) * M_PER_DEG_LAT;
  const bboxDiagM = Math.sqrt(bboxWM * bboxWM + bboxHM * bboxHM);

  // Total footprint with clearance on all sides
  const totalW = spec.footprintFt.w + spec.clearanceFt * 2;
  const totalH = spec.footprintFt.h + spec.clearanceFt * 2;

  const strideLng = ftToLng(cfg.activityStrideFt, refLat);
  const strideLat = ftToLat(cfg.activityStrideFt);
  const dedupeM   = cfg.dedupeRadiusFt * 0.3048;

  const raw: ActivityCandidate[] = [];
  let n = 0;

  for (let lat = minLat; lat <= maxLat; lat += strideLat) {
    for (let lng = minLng; lng <= maxLng; lng += strideLng) {
      const center: [number, number] = [lng, lat];
      // Fast inner check before the heavier 9-point containment test
      if (!viableRings.some(ring => pip(center, ring))) continue;
      if (!rectFitsInViable(center, totalW, totalH, viableRings)) continue;

      const breakdown = computeScore(
        center, spec, sunCells, structurePolys,
        boundaryVerts, doorPoint, frontEdgeMidpoint,
        bboxDiagM, bboxDiagM,
      );
      raw.push({
        id: `cand_${spec.id}_${++n}`,
        activityType: spec.id,
        center,
        footprintVertices: rectVerts(center, spec.footprintFt.w, spec.footprintFt.h),
        areaSqFt: spec.footprintFt.w * spec.footprintFt.h,
        score: breakdown.total,
        scoreBreakdown: breakdown,
      });
    }
  }

  if (!raw.length) {
    warnings.push(`No valid placement found for ${spec.label}.`);
    return [];
  }

  // Sort descending, then de-duplicate: keep first (highest-scoring) within dedupeRadius
  raw.sort((a, b) => b.score - a.score);
  const kept: ActivityCandidate[] = [];
  for (const c of raw) {
    if (kept.some(k => distM(c.center, k.center) < dedupeM)) continue;
    kept.push(c);
    if (kept.length >= cfg.maxCandidates) break;
  }

  return kept;
}

// ── Plantable area ────────────────────────────────────────────────────────────
// §4: boundary − no-go − existing hardscape − existing structures

function derivePlantableArea(
  boundaryPoly: GF,
  features: ConfirmedFeature[],
): PlantableArea {
  const cfg = CANDIDATE_CONFIG;
  const blockers: GF[] = features.flatMap(f => {
    const poly = toPoly(f.vertices);
    if (!poly) return [];
    if (f.type === 'structure') {
      // Structures + their setback
      const setback = buf(poly, cfg.structSetbackFt * FT_TO_KM);
      return setback ? [poly, setback] : [poly];
    }
    return [poly]; // trees (drip-lines) + hardscapes
  });

  const noGo = unionAll(blockers);
  let plantable: GF = boundaryPoly;
  if (noGo) {
    const diff = safeDiff(plantable, noGo);
    if (diff) plantable = diff;
  }

  const rings = extractRings(plantable).sort((a, b) => areaSqFt(b) - areaSqFt(a));
  return {
    vertices: rings[0] ?? [],
    totalSqFt: rings.reduce((s, r) => s + areaSqFt(r), 0),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function deriveCandidates(inputs: CandidateDerivationInputs): CandidateDerivationResult {
  const { boundaryVerts, features, sunCells, requestedFeatures, yardType, doorPoint, frontEdgeMidpoint } = inputs;

  const boundaryPoly = toPoly(boundaryVerts);
  if (!boundaryPoly) {
    return { beds: [], activities: {}, plantableArea: { vertices: [], totalSqFt: 0 }, warnings: ['Invalid boundary polygon.'] };
  }

  const warnings: string[] = [];
  const kept = features.filter(f => f.keep && f.vertices.length >= 3);

  // Viable area for activity placement: boundary − trees − structures (+ setbacks) − hardscape
  const activityBlockers: GF[] = [
    ...kept.filter(f => f.type === 'tree').map(f => toPoly(f.vertices)).filter(Boolean) as GF[],
    ...kept.filter(f => f.type === 'hardscape').map(f => toPoly(f.vertices)).filter(Boolean) as GF[],
    ...kept.filter(f => f.type === 'structure').flatMap(f => {
      const poly = toPoly(f.vertices);
      if (!poly) return [];
      const setback = buf(poly, CANDIDATE_CONFIG.structSetbackFt * FT_TO_KM);
      return setback ? [poly, setback] : [poly];
    }),
  ];
  const activityNoGo = unionAll(activityBlockers);
  let viableArea: GF = boundaryPoly;
  if (activityNoGo) {
    const diff = safeDiff(viableArea, activityNoGo);
    if (diff) viableArea = diff;
  }

  // Structure polys for sightline scoring
  const structurePolys = kept
    .filter(f => f.type === 'structure')
    .map(f => toPoly(f.vertices))
    .filter(Boolean) as GF[];

  // Bed candidates
  const beds = deriveBedCandidates(boundaryPoly, kept, sunCells, yardType, warnings);

  // Activity candidates — one ranked list per requested feature type
  const activities: Record<string, ActivityCandidate[]> = {};
  for (const featureId of requestedFeatures) {
    if (SKIP_CANDIDATE_GEN.has(featureId)) continue;
    const spec = ACTIVITY_SPECS[featureId];
    if (!spec) continue;
    activities[featureId] = deriveActivityCandidates(
      spec, viableArea, boundaryVerts, structurePolys,
      sunCells, doorPoint, frontEdgeMidpoint, warnings,
    );
  }

  // Total potentially-plantable area
  const plantableArea = derivePlantableArea(boundaryPoly, kept);

  return { beds, activities, plantableArea, warnings };
}
