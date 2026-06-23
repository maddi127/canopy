import * as turf from '@turf/turf';
import type { DesignTemplate } from '../data/designTemplates';
import type { ActivityCandidate, BedRegion } from './candidateDerivationService';
import type { ResolvedElement } from './templateSelectionService';
import type {
  Coords, Ring, CanopySize,
  S1Activity, S1Tree, S1Object, S1Zone, S1Path, S1Bed,
  S1Warning, S1RelaxationEntry, S1ShadeHint,
  RelaxationTier, S1Plan, S1ExecutionInputs,
} from '../types/stage1Plan';

// ── Config ─────────────────────────────────────────────────────────────────────

const EXEC_CONFIG = {
  treeGridStrideFt:     8,
  canopyLargeFt:        12.5,  // radius
  canopyMedFt:          7.5,
  canopySmallFt:        4.0,
  canopyPropLineClearFt: 3,
  canopyStructClearFt:  5,
  primaryPathWidthFt:   4,
  minBedAreaSqFt:       10,
} as const;

const CANOPY_RADIUS: Record<CanopySize, number> = {
  large:  EXEC_CONFIG.canopyLargeFt,
  medium: EXEC_CONFIG.canopyMedFt,
  small:  EXEC_CONFIG.canopySmallFt,
};

const FT_TO_KM      = 0.3048 / 1000;
const M_PER_DEG_LAT = 111320;

// ── Geometry helpers ───────────────────────────────────────────────────────────

function ftToLng(ft: number, lat: number): number {
  return (ft * 0.3048) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
}
function ftToLat(ft: number): number {
  return (ft * 0.3048) / M_PER_DEG_LAT;
}

function distM(a: Coords, b: Coords): number {
  try { return turf.distance(turf.point(a), turf.point(b), { units: 'meters' }); } catch { return 0; }
}

function centroidOf(verts: Coords[]): Coords {
  if (!verts.length) return [0, 0];
  return [
    verts.reduce((s, v) => s + v[0], 0) / verts.length,
    verts.reduce((s, v) => s + v[1], 0) / verts.length,
  ];
}

function areaSqFt(verts: Coords[]): number {
  if (verts.length < 3) return 0;
  try { return turf.area(turf.polygon([[...verts, verts[0]]])) * 10.7639; } catch { return 0; }
}

function rectVerts(center: Coords, wFt: number, hFt: number): Ring {
  const dLng = ftToLng(wFt / 2, center[1]);
  const dLat = ftToLat(hFt / 2);
  return [
    [center[0] - dLng, center[1] - dLat],
    [center[0] + dLng, center[1] - dLat],
    [center[0] + dLng, center[1] + dLat],
    [center[0] - dLng, center[1] + dLat],
  ];
}

// Ray-casting point-in-polygon
function pip(pt: Coords, ring: Coords[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type GF = turf.Feature<turf.Polygon | turf.MultiPolygon>;

function toPoly(verts: Coords[]): GF | null {
  if (verts.length < 3) return null;
  try { return turf.polygon([[...verts, verts[0]]]) as GF; } catch { return null; }
}

function extractRings(f: GF | null): Coords[][] {
  if (!f) return [];
  const g = f.geometry;
  if (g.type === 'Polygon') {
    const r = g.coordinates[0] as Coords[];
    return r.length >= 4 ? [r.slice(0, -1)] : [];
  }
  if (g.type === 'MultiPolygon') {
    return (g.coordinates as any[])
      .map((p: any) => (p[0] as Coords[]).slice(0, -1))
      .filter((r: Coords[]) => r.length >= 3);
  }
  return [];
}

// ── Working state ──────────────────────────────────────────────────────────────

interface WorkingState {
  activities:          S1Activity[];
  trees:               S1Tree[];
  objects:             S1Object[];
  zones:               S1Zone[];
  paths:               S1Path[];
  candidatesRemaining: Record<string, ActivityCandidate[]>;
  usedCandidateIds:    Set<string>;
  primaryActivityCenter: Coords | null;
  centralAxisLine:     [Coords, Coords] | null;
  warnings:            S1Warning[];
  relaxationLog:       S1RelaxationEntry[];
  shadeHints:          S1ShadeHint[];
  counters: {
    act:  number;
    tree: number;
    obj:  number;
    zone: number;
    path: number;
    bed:  number;
  };
}

function initState(candidates: Record<string, ActivityCandidate[]>): WorkingState {
  return {
    activities:            [],
    trees:                 [],
    objects:               [],
    zones:                 [],
    paths:                 [],
    candidatesRemaining:   { ...Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, [...v]])) },
    usedCandidateIds:      new Set(),
    primaryActivityCenter: null,
    centralAxisLine:       null,
    warnings:              [],
    relaxationLog:         [],
    shadeHints:            [],
    counters:              { act: 0, tree: 0, obj: 0, zone: 0, path: 0, bed: 0 },
  };
}

// Collect all committed rings for overlap checks
function committedRings(state: WorkingState): Ring[] {
  return [
    ...state.activities.map(a => a.geometry),
    ...state.objects.map(o => o.geometry),
    ...state.zones.map(z => z.geometry),
  ];
}

function overlapsWith(ring: Ring, state: WorkingState): boolean {
  const poly = toPoly(ring);
  if (!poly) return false;
  for (const cr of committedRings(state)) {
    const cp = toPoly(cr);
    if (!cp) continue;
    try {
      if (turf.booleanIntersects(poly as any, cp as any)) return true;
    } catch {}
  }
  return false;
}

// ── Intent transforms ──────────────────────────────────────────────────────────

function applyIntentTransform(
  templateId: string,
  role: string,
  candidates: ActivityCandidate[],
  inputs: S1ExecutionInputs,
): ActivityCandidate[] {
  const key = `${templateId}:${role}`;

  // prefer_central — sort by distance to boundary centroid ascending
  if (key === 'modern_courtyard:primary_activity' || key === 'desert_courtyard:primary_activity') {
    const center = centroidOf(inputs.boundaryVerts);
    return [...candidates].sort((a, b) => distM(a.center, center) - distM(b.center, center));
  }

  // prefer_far_from_house — sort by distance to doorPoint descending
  if (key === 'whimsical_hidden_path:primary_activity' && inputs.doorPoint) {
    const door = inputs.doorPoint;
    return [...candidates].sort((a, b) => distM(b.center, door) - distM(a.center, door));
  }

  // identity: return sorted by score descending (already sorted, but keep tiebreak stable)
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id < b.id) return -1; if (a.id > b.id) return 1;
    if (a.center[0] !== b.center[0]) return a.center[0] - b.center[0];
    return a.center[1] - b.center[1];
  });
}

// ── Relaxation helpers ─────────────────────────────────────────────────────────

function logRelaxation(state: WorkingState, elementId: string, tier: RelaxationTier, reason: string) {
  if (tier > 0) state.relaxationLog.push({ elementId, tierUsed: tier, reason });
}

function warnSkip(state: WorkingState, elementId: string, message: string) {
  state.warnings.push({ type: 'element_skipped', message, relatedElementId: elementId });
}

// ── Activity candidates: derive type list for a role ──────────────────────────

function activityTypesForRule(
  rule: ResolvedElement,
  inputs: S1ExecutionInputs,
): string[] {
  if (rule.condition) {
    const match = rule.condition.match(/user_picked:\s*(.+)/i);
    if (match) {
      return match[1].split(/\s+OR\s+/i)
        .map(s => s.trim())
        .filter(id => inputs.selectedFeatures.includes(id));
    }
  }
  // primary_activity: seating > dining > cooking
  return ['seating', 'dining', 'cooking'].filter(id => inputs.selectedFeatures.includes(id));
}

// ── Phase A resolvers ─────────────────────────────────────────────────────────

function resolveActivityRule(
  rule: ResolvedElement,
  state: WorkingState,
  template: DesignTemplate,
  inputs: S1ExecutionInputs,
): void {
  const types = activityTypesForRule(rule, inputs);
  const ACTIVITY_SPECS_FT: Record<string, { w: number; h: number; minW: number; minH: number }> = {
    seating:  { w: 8,  h: 8,  minW: 6,  minH: 6  },
    dining:   { w: 16, h: 14, minW: 12, minH: 10 },
    cooking:  { w: 5,  h: 8,  minW: 4,  minH: 6  },
    water:    { w: 9,  h: 9,  minW: 3,  minH: 3  },
    storage:  { w: 10, h: 8,  minW: 6,  minH: 4  },
    garden:   { w: 10, h: 4,  minW: 6,  minH: 3  },
  };

  for (const actType of types) {
    // Skip if already committed a primary of this type
    const already = state.activities.find(a => a.type === actType);
    if (already && rule.role !== 'secondary_activity') continue;

    const pool = state.candidatesRemaining[actType] ?? [];
    if (!pool.length) continue;

    const transformed = applyIntentTransform(template.id, rule.role, pool, inputs);
    const spec = ACTIVITY_SPECS_FT[actType] ?? { w: 8, h: 8, minW: 6, minH: 6 };

    const tries: Array<{ candidates: ActivityCandidate[]; wFt: number; hFt: number; tier: RelaxationTier }> = [
      { candidates: transformed.slice(0, 1),  wFt: spec.w,    hFt: spec.h,    tier: 0 },
      { candidates: transformed.slice(1, 4),  wFt: spec.w,    hFt: spec.h,    tier: 1 },
      { candidates: transformed.slice(0, 1),  wFt: spec.minW, hFt: spec.minH, tier: 2 },
      { candidates: transformed.slice(1, 4),  wFt: spec.minW, hFt: spec.minH, tier: 3 },
    ];

    let committed = false;
    for (const attempt of tries) {
      for (const cand of attempt.candidates) {
        if (state.usedCandidateIds.has(cand.id)) continue;
        const geom = rectVerts(cand.center, attempt.wFt, attempt.hFt);
        if (overlapsWith(geom, state)) continue;

        const id = `act_${++state.counters.act}`;
        const activity: S1Activity = {
          id,
          type:     actType,
          role:     rule.role,
          geometry: geom,
          areaSqFt: attempt.wFt * attempt.hFt,
        };
        state.activities.push(activity);
        state.usedCandidateIds.add(cand.id);
        if (!state.primaryActivityCenter) state.primaryActivityCenter = cand.center;
        logRelaxation(state, id, attempt.tier, `placed at tier ${attempt.tier}`);
        committed = true;
        break;
      }
      if (committed) break;
    }

    if (!committed) {
      const tempId = `act_${state.counters.act + 1}`;
      warnSkip(state, tempId, `Couldn't fit your ${actType} — no valid placement found.`);
      logRelaxation(state, tempId, 4, 'all relaxations exhausted');
    }
    break; // only commit one type per call
  }
}

// Tree resolver: grid-sample viable area, apply hard constraints
function resolveTreeRule(
  rule: ResolvedElement,
  state: WorkingState,
  _template: DesignTemplate,
  inputs: S1ExecutionInputs,
): void {
  const countStr = rule.count;
  let maxCount = 1;
  let minCount = 1;
  if (typeof countStr === 'number') {
    maxCount = minCount = countStr;
  } else if (typeof countStr === 'string') {
    const rangeMatch = countStr.match(/(\d+)\s*[-–]\s*(\d+)/);
    const orMatch    = countStr.match(/(\d+)\s+or\s+(\d+)/i);
    if (rangeMatch) { minCount = Number(rangeMatch[1]); maxCount = Number(rangeMatch[2]); }
    else if (orMatch) { maxCount = Number(orMatch[2]); minCount = Number(orMatch[1]); }
    else { maxCount = minCount = Number(countStr) || 1; }
  }

  const structures = inputs.features.filter(f => f.keep && f.type === 'structure');
  const structPolys = structures.map(f => toPoly(f.vertices as Coords[])).filter(Boolean) as GF[];
  const boundaryPoly = toPoly(inputs.boundaryVerts);

  // Candidate canopy sizes in relaxation order
  const sizeOrder: CanopySize[] = ['large', 'medium', 'small'];

  // Intent position: near primaryActivityCenter or centroid of boundary
  const idealBase: Coords = state.primaryActivityCenter
    ? state.primaryActivityCenter
    : centroidOf(inputs.boundaryVerts);

  const bbox = turf.bbox(turf.polygon([[...inputs.boundaryVerts, inputs.boundaryVerts[0]]]));
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const refLat = (minLat + maxLat) / 2;
  const strideLng = ftToLng(EXEC_CONFIG.treeGridStrideFt, refLat);
  const strideLat = ftToLat(EXEC_CONFIG.treeGridStrideFt);

  function isValidTreePosition(pos: Coords, radiusFt: number): boolean {
    if (!boundaryPoly) return false;
    // Must be inside boundary
    if (!pip(pos, inputs.boundaryVerts)) return false;

    const radiusKm = radiusFt * FT_TO_KM;
    const canopyCircle = turf.buffer(turf.point(pos), radiusKm, { units: 'kilometers' }) as GF;
    if (!canopyCircle) return false;

    // Clearance from structures
    const structClearKm = (radiusFt + EXEC_CONFIG.canopyStructClearFt) * FT_TO_KM;
    for (const sp of structPolys) {
      try {
        const expanded = turf.buffer(sp as any, structClearKm, { units: 'kilometers' }) as GF;
        if (expanded && turf.booleanIntersects(turf.point(pos) as any, expanded as any)) return false;
      } catch {}
    }

    // Clearance from property line
    const propClearKm = (radiusFt + EXEC_CONFIG.canopyPropLineClearFt) * FT_TO_KM;
    const shrunkBoundary = turf.buffer(boundaryPoly as any, -propClearKm, { units: 'kilometers' });
    if (!shrunkBoundary) return false;
    if (!turf.booleanIntersects(turf.point(pos) as any, shrunkBoundary as any)) return false;

    // Clearance from other committed trees
    for (const t of state.trees) {
      const minDist = (radiusFt + t.canopyRadiusFt) * 0.3048; // in meters
      if (distM(pos, t.position) < minDist) return false;
    }

    return true;
  }

  let placed = 0;

  for (let sizeIdx = 0; sizeIdx < sizeOrder.length && placed < maxCount; sizeIdx++) {
    const size = sizeOrder[sizeIdx];
    const radiusFt = CANOPY_RADIUS[size];

    // Gather all valid positions, sorted by distance to ideal
    const validPositions: Coords[] = [];
    for (let lat = minLat; lat <= maxLat; lat += strideLat) {
      for (let lng = minLng; lng <= maxLng; lng += strideLng) {
        const pos: Coords = [lng, lat];
        if (isValidTreePosition(pos, radiusFt)) validPositions.push(pos);
      }
    }

    // Sort by distance to ideal, tiebreak: lower lng, lower lat
    validPositions.sort((a, b) => {
      const dDiff = distM(a, idealBase) - distM(b, idealBase);
      if (dDiff !== 0) return dDiff;
      if (a[0] !== b[0]) return a[0] - b[0];
      return a[1] - b[1];
    });

    const tier: RelaxationTier = sizeIdx === 0 ? 0 : 2;

    for (const pos of validPositions) {
      if (placed >= maxCount) break;
      const id = `tree_${++state.counters.tree}`;
      const tree: S1Tree = {
        id,
        role:               rule.role,
        position:           pos,
        assumedCanopySize:  size,
        canopyRadiusFt:     radiusFt,
        idealSpeciesHints:  [],
      };
      state.trees.push(tree);
      logRelaxation(state, id, tier, `placed at tier ${tier} (${size} canopy)`);
      placed++;
    }

    if (placed >= minCount) break; // achieved minimum — stop relaxing size
  }

  if (placed === 0) {
    const tempId = `tree_${state.counters.tree + 1}`;
    warnSkip(state, tempId, `Couldn't place ${rule.role} — no valid position found.`);
    logRelaxation(state, tempId, 4, 'all tree relaxations exhausted');
  }
}

function resolveObjectRule(
  rule: ResolvedElement,
  state: WorkingState,
  _template: DesignTemplate,
  _inputs: S1ExecutionInputs,
): void {
  const typeMap: Record<string, string> = {
    water_feature:      'water',
    storage_shed:       'storage',
    specimen_shrub:     'seating',  // use seating candidates as proxy for general placement
    focal_point:        'water',
    screening_planting: 'seating',
  };
  const objType = rule.role;
  const candType = typeMap[rule.role] ?? 'seating';

  const pool = (state.candidatesRemaining[candType] ?? []).filter(c => !state.usedCandidateIds.has(c.id));
  if (!pool.length) {
    const tempId = `obj_${state.counters.obj + 1}`;
    warnSkip(state, tempId, `Couldn't place ${rule.role} — no candidates available.`);
    return;
  }

  // For shed: use worst-scoring candidates (inverted)
  const sorted = rule.role === 'storage_shed'
    ? [...pool].sort((a, b) => a.score - b.score)
    : [...pool].sort((a, b) => b.score - a.score);

  const spec = { w: 5, h: 5, minW: 3, minH: 3 };

  const tries: Array<{ cands: ActivityCandidate[]; wFt: number; hFt: number; tier: RelaxationTier }> = [
    { cands: sorted.slice(0, 1), wFt: spec.w,    hFt: spec.h,    tier: 0 },
    { cands: sorted.slice(1, 4), wFt: spec.w,    hFt: spec.h,    tier: 1 },
    { cands: sorted.slice(0, 1), wFt: spec.minW, hFt: spec.minH, tier: 2 },
    { cands: sorted.slice(1, 4), wFt: spec.minW, hFt: spec.minH, tier: 3 },
  ];

  let committed = false;
  for (const attempt of tries) {
    for (const cand of attempt.cands) {
      const geom = rectVerts(cand.center, attempt.wFt, attempt.hFt);
      if (overlapsWith(geom, state)) continue;

      const id = `obj_${++state.counters.obj}`;
      state.objects.push({ id, type: objType, role: rule.role, geometry: geom, areaSqFt: attempt.wFt * attempt.hFt });
      state.usedCandidateIds.add(cand.id);
      logRelaxation(state, id, attempt.tier, `placed at tier ${attempt.tier}`);
      committed = true;
      break;
    }
    if (committed) break;
  }

  if (!committed) {
    const tempId = `obj_${state.counters.obj + 1}`;
    warnSkip(state, tempId, `Couldn't place ${rule.role} — no valid placement found.`);
    logRelaxation(state, tempId, 4, 'all object relaxations exhausted');
  }
}

function resolveVegZone(
  rule: ResolvedElement,
  state: WorkingState,
  _inputs: S1ExecutionInputs,
): void {
  // Use garden candidates if available, else best seating spot
  const pool = (state.candidatesRemaining['garden'] ?? state.candidatesRemaining['seating'] ?? [])
    .filter(c => !state.usedCandidateIds.has(c.id));

  if (!pool.length) {
    const tempId = `zone_${state.counters.zone + 1}`;
    warnSkip(state, tempId, 'Couldn\'t place vegetable garden zone — no candidates.');
    return;
  }

  // Best sun candidate
  const sorted = [...pool].sort((a, b) => {
    const sunDiff = (b.scoreBreakdown?.sunComfortFit ?? b.score) - (a.scoreBreakdown?.sunComfortFit ?? a.score);
    if (sunDiff !== 0) return sunDiff;
    return b.score - a.score;
  });

  const best = sorted[0];
  const geom = rectVerts(best.center, 20, 12); // 2-bed veg zone default
  const id = `zone_${++state.counters.zone}`;
  state.zones.push({ id, type: 'veg_zone', role: rule.role, geometry: geom, areaSqFt: 240 });
  state.usedCandidateIds.add(best.id);
}

function resolveCentralAxis(
  rule: ResolvedElement,
  state: WorkingState,
  inputs: S1ExecutionInputs,
): void {
  const origin: Coords = inputs.doorPoint ?? centroidOf(inputs.boundaryVerts);
  const centroid = centroidOf(inputs.boundaryVerts);
  // Extend the axis vector to the far boundary
  const dx = centroid[0] - origin[0];
  const dy = centroid[1] - origin[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const far: Coords = [origin[0] + (dx / len) * 0.01, origin[1] + (dy / len) * 0.01];
  state.centralAxisLine = [origin, far];

  // Store as a zone (polyline as degenerate ring)
  const id = `zone_${++state.counters.zone}`;
  state.zones.push({ id, type: 'central_axis', role: rule.role, geometry: [origin, far] });
}

// ── Phase A — element iteration ────────────────────────────────────────────────

const ACTIVITY_ROLES = new Set(['primary_activity', 'secondary_activity']);
const TREE_ROLES     = new Set(['anchor_tree', 'framing_tree', 'specimen_plant']);
const OBJECT_ROLES   = new Set(['water_feature', 'storage_shed', 'specimen_shrub', 'focal_point', 'screening_planting']);
const SKIP_ROLES     = new Set(['foundation_bed', 'perimeter_bed', 'ground_field']);

function runPhaseA(
  elements: ResolvedElement[],
  state: WorkingState,
  template: DesignTemplate,
  inputs: S1ExecutionInputs,
): void {
  for (const rule of elements) {
    if (!rule.active) continue;

    if (SKIP_ROLES.has(rule.role)) continue;

    if (rule.role === 'shade_structure_hint') {
      const refId = state.activities[0]?.id ?? `obj_${state.counters.obj}`;
      state.shadeHints.push({
        message: 'A ramada, pergola, or shade sail is strongly recommended over the primary activity area.',
        relatedElementId: refId,
      });
      continue;
    }

    if (rule.role === 'central_axis') {
      resolveCentralAxis(rule, state, inputs);
      continue;
    }

    if (rule.role === 'veg_zone') {
      resolveVegZone(rule, state, inputs);
      continue;
    }

    if (rule.role === 'path_artery') {
      // Treated as early Phase B — route a winding path from door to a far point
      if (inputs.doorPoint) {
        const dest = state.primaryActivityCenter ?? centroidOf(inputs.boundaryVerts);
        const id = `path_${++state.counters.path}`;
        state.paths.push({
          id,
          geometry: [inputs.doorPoint, dest],
          widthFt:  2,
          surface:  template.hardscape_style.surface_default,
          connects: ['door', id],
        });
      }
      continue;
    }

    if (ACTIVITY_ROLES.has(rule.role)) {
      resolveActivityRule(rule, state, template, inputs);
      continue;
    }

    if (TREE_ROLES.has(rule.role)) {
      resolveTreeRule(rule, state, template, inputs);
      continue;
    }

    if (OBJECT_ROLES.has(rule.role)) {
      resolveObjectRule(rule, state, template, inputs);
      continue;
    }
  }
}

// ── Phase B — path routing ─────────────────────────────────────────────────────

function runPhaseB(
  state: WorkingState,
  template: DesignTemplate,
  inputs: S1ExecutionInputs,
): void {
  if (!inputs.doorPoint) return;

  const door = inputs.doorPoint;
  const destinations: Array<{ id: string; center: Coords }> = [
    ...state.activities.filter(a => a.role === 'primary_activity').map(a => ({
      id: a.id, center: centroidOf(a.geometry),
    })),
    ...state.zones.filter(z => z.type === 'veg_zone').map(z => ({
      id: z.id, center: centroidOf(z.geometry),
    })),
  ];

  for (const dest of destinations) {
    // Skip if already connected by a path_artery
    const already = state.paths.some(p => p.connects.includes(dest.id));
    if (already) continue;

    const id = `path_${++state.counters.path}`;
    state.paths.push({
      id,
      geometry: [door, dest.center],
      widthFt:  EXEC_CONFIG.primaryPathWidthFt,
      surface:  template.hardscape_style.surface_default,
      connects: ['door', dest.id],
    });
  }
}

// ── Phase C — bed finalization ─────────────────────────────────────────────────

function runPhaseC(
  state: WorkingState,
  template: DesignTemplate,
  candidateBeds: BedRegion[],
  inputs: S1ExecutionInputs,
): S1Bed[] {
  const beds: S1Bed[] = [];
  const minArea = EXEC_CONFIG.minBedAreaSqFt;

  // Build the union of all committed footprints to subtract
  const blockerPolys: GF[] = committedRings(state)
    .map(r => toPoly(r))
    .filter(Boolean) as GF[];

  function subtractCommitted(src: GF): GF | null {
    let result: GF = src;
    for (const bp of blockerPolys) {
      try {
        const diff = turf.difference(result as any, bp as any);
        if (diff) result = diff as GF;
      } catch {}
    }
    return result;
  }

  // Determine which bed sources are active per template bed_pattern
  const bp = template.bed_pattern;

  const frontSuppressed = (bp.perimeter ?? '').includes('non_front') ||
    (bp.perimeter ?? '').includes('narrow_non_front');

  for (const bedRegion of candidateBeds) {
    // Source filtering
    let sourceOk = false;
    if (bedRegion.source === 'foundation' && bp.foundation && bp.foundation !== 'none') sourceOk = true;
    if (bedRegion.source === 'perimeter' && bp.perimeter && bp.perimeter !== 'none') sourceOk = true;
    if (bedRegion.source === 'hardscape_edge') sourceOk = true;
    if (bedRegion.source === 'tree_underplant') sourceOk = true;
    if (!sourceOk) continue;

    // Front suppression for perimeter beds
    if (bedRegion.source === 'perimeter' && frontSuppressed && inputs.frontEdgeMidpoint) {
      const ctr = centroidOf(bedRegion.vertices as Coords[]);
      const frontDist = distM(ctr, inputs.frontEdgeMidpoint as Coords);
      const centroid = centroidOf(inputs.boundaryVerts);
      const centDist  = distM(ctr, centroid);
      if (frontDist < centDist) continue; // centroid is closer to front — skip
    }

    const srcPoly = toPoly(bedRegion.vertices as Coords[]);
    if (!srcPoly) continue;

    const trimmed = subtractCommitted(srcPoly);
    if (!trimmed) continue;

    for (const verts of extractRings(trimmed)) {
      const sqFt = areaSqFt(verts);
      if (sqFt < minArea) {
        state.warnings.push({ type: 'bed_dropped', message: `Bed dropped: area ${sqFt.toFixed(1)} sf < ${minArea} sf minimum.` });
        continue;
      }
      const id = `bed_${++state.counters.bed}`;
      beds.push({
        id,
        source:   bedRegion.source,
        geometry: verts,
        areaSqFt: sqFt,
        sunClass: bedRegion.dominantSunClass,
      });
    }
  }

  return beds;
}

// ── Main export ────────────────────────────────────────────────────────────────

export function executeStage1(inputs: S1ExecutionInputs): S1Plan {
  const { templateInstance, candidates, selectedFeatures } = inputs;
  const { template, elements } = templateInstance;

  const state = initState(candidates.activities);

  // Phase A
  runPhaseA(elements, state, template, inputs);

  // Check required features
  for (const req of template.features.required) {
    const placed =
      state.activities.some(a => a.type === req) ||
      state.objects.some(o => o.type === req) ||
      state.zones.some(z => z.type === req);
    if (!placed) {
      state.warnings.push({
        type:    'required_missing',
        message: `Required feature '${req}' could not be placed. Consider widening your feature set or choosing a different style.`,
      });
    }
  }

  // Phase B
  runPhaseB(state, template, inputs);

  // Phase C
  const beds = runPhaseC(state, template, candidates.beds, inputs);

  // Ground fill
  const groundFill = selectedFeatures.includes('open_lawn') ? 'lawn' : template.default_ground_fill;

  // Deterministic plan ID (hash-like: template + feature count + yard area)
  const planId = `s1_${template.id}_${selectedFeatures.length}_${Math.round(inputs.yardAreaSqFt)}`;

  return {
    id:                  planId,
    createdAt:           new Date().toISOString(),
    version:             1,

    templateId:          template.id,
    templateVersion:     template.version,

    userInputs: {
      style:    inputs.stylePreference,
      features: selectedFeatures,
      yardType: inputs.yardType,
    },

    activities:          state.activities,
    trees:               state.trees,
    objects:             state.objects,
    zones:               state.zones,
    paths:               state.paths,
    beds,

    groundFill,
    plantingSignature:   template.planting_signature,
    hardscapeStyle:      template.hardscape_style,

    warnings:            state.warnings,
    relaxationLog:       state.relaxationLog,
    shadeStructureHints: state.shadeHints,
  };
}
