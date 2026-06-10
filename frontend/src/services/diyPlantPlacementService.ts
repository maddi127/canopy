/**
 * DIY Plant Placement Service — Trees & Large Shrubs MVP
 *
 * Places only trees and large shrubs (sizeBucket = 'solo_specimen' | 'large').
 * Medium/small filler placement is deferred to a future phase.
 */

import * as turf from '@turf/turf';
import type { PlantRecord, DesignStyle } from '../types/plantTypes';
import type { SunCell, SunClass } from './sunModelingService';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';
import { getPlantDatabase } from './plantDatabaseAdapter';

// ── Input / output types ───────────────────────────────────────────────────────

export interface DiyZone {
  id: string;
  toolId: string;
  label: string;
  color: string;
  vertices: [number, number][];
  existing?: boolean;
  planted?: boolean;
}

export interface PlacementInputs {
  boundaryVerts: [number, number][];
  zones: DiyZone[];
  confirmedFeatures: ConfirmedFeature[];
  sunCells: SunCell[];
  style: DesignStyle;
  hardinessZone: number;
  houseFootprint?: [number, number][];
  yardSide: 'front' | 'back';
}

export type BedRole =
  | 'foundation'
  | 'perimeter'
  | 'hardscape_edge'
  | 'tree_underplant'
  | 'island'
  | 'mixed';

export interface BedAnalysis {
  zoneId: string;
  role: BedRole;
  areaSqFt: number;
  sunClass: SunClass;
  vertices: [number, number][];
  isGroundcoverFill: boolean;
  side: 'front' | 'back';
}

export interface YardAnalysis {
  yardAreaSf: number;
  fullSunAreaSf: number;
  userDrawnTreesCount: number;
  targetLargeShrubs: number;
  styleCapUsed: number;
}

export interface LargeShrub {
  id: string;
  plantId: number;
  lngLat: [number, number];
  bedId: string;
  matureWidthFt: number;
  side: 'front' | 'back';
}

export interface TreeAssignment {
  zoneId: string;
  plantId: number;
  centerLngLat: [number, number];
  source: 'confirmed_keep' | 'new_zone';
}

export interface PurchaseEntry {
  plantId: number;
  commonName: string;
  botanicalName: string;
  count: number;
  bedsUsed: string[];
}

export interface DiyPlantPlan {
  yardAnalysis: YardAnalysis;
  beds: BedAnalysis[];
  largeShrubs: LargeShrub[];
  trees: TreeAssignment[];
  purchaseList: PurchaseEntry[];
  warnings: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FT_PER_DEG_LAT = 364_566;
const BOUNDARY_SETBACK_FT = 1.5;
const HOUSE_SETBACK_FT = 3;

const HARDSCAPE_TOOL_IDS = new Set([
  'seating', 'dining', 'cooking', 'play', 'fire_pit', 'hot_tub', 'pool', 'path',
  'shed', 'garage',
]);

// Style density caps per 1000 sq ft
const STYLE_CAP: Record<DesignStyle, { front: number; back: number }> = {
  modern:      { front: 1.5, back: 3.0 },
  desert:      { front: 2.5, back: 4.0 },
  traditional: { front: 3.0, back: 4.5 },
  whimsical:   { front: 3.5, back: 5.5 },
};

// Spacing multiplier by style
const SPACING_MULT: Record<DesignStyle, number> = {
  modern:      1.0,
  desert:      1.5,
  traditional: 1.0,
  whimsical:   0.9,
};

// ── Geometry helpers ───────────────────────────────────────────────────────────

function ftPerDegLng(latDeg: number): number {
  return FT_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

function pip(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function areaSqFt(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  try { return turf.area(turf.polygon([[...ring, ring[0]]])) * 10.7639; }
  catch { return 0; }
}

function ringCentroid(ring: [number, number][]): [number, number] {
  try {
    const c = turf.centroid(turf.polygon([[...ring, ring[0]]]));
    return c.geometry.coordinates as [number, number];
  } catch {
    return [
      ring.reduce((s, v) => s + v[0], 0) / ring.length,
      ring.reduce((s, v) => s + v[1], 0) / ring.length,
    ];
  }
}

function polygonsAdjacent(a: [number, number][], b: [number, number][], thresholdFt: number): boolean {
  const latRef = a[0]?.[1] ?? 39;
  const lngScale = ftPerDegLng(latRef);
  for (const va of a) {
    for (const vb of b) {
      const dx = (va[0] - vb[0]) * lngScale;
      const dy = (va[1] - vb[1]) * FT_PER_DEG_LAT;
      if (Math.hypot(dx, dy) < thresholdFt) return true;
    }
  }
  return false;
}

function aggregateSun(ring: [number, number][], cells: SunCell[]): SunClass {
  const counts: Record<SunClass, number> = { full_sun: 0, part_sun: 0, part_shade: 0, full_shade: 0 };
  let total = 0;
  for (const cell of cells) {
    if (pip(cell.lng, cell.lat, ring)) { counts[cell.sunClass]++; total++; }
  }
  if (total === 0) return 'full_sun';
  return (Object.keys(counts) as SunClass[]).reduce((best, k) => counts[k] > counts[best] ? k : best);
}

function sunCompatible(plant: PlantRecord, sun: SunClass): boolean {
  if (sun === 'part_shade') return plant.sunRequirement.includes('part_sun') || plant.sunRequirement.includes('full_shade');
  return plant.sunRequirement.includes(sun as 'full_sun' | 'part_sun' | 'full_shade');
}

// ── House setback helpers ──────────────────────────────────────────────────────

function ptToSegDistFt(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  latRef: number,
): number {
  const lngScale = ftPerDegLng(latRef);
  const px_ft = px * lngScale, py_ft = py * FT_PER_DEG_LAT;
  const ax_ft = ax * lngScale, ay_ft = ay * FT_PER_DEG_LAT;
  const bx_ft = bx * lngScale, by_ft = by * FT_PER_DEG_LAT;
  const abx = bx_ft - ax_ft, aby = by_ft - ay_ft;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-10) return Math.hypot(px_ft - ax_ft, py_ft - ay_ft);
  const t = Math.max(0, Math.min(1, ((px_ft - ax_ft) * abx + (py_ft - ay_ft) * aby) / len2));
  return Math.hypot(px_ft - (ax_ft + t * abx), py_ft - (ay_ft + t * aby));
}

function tooCloseToHouse(
  lng: number, lat: number,
  houseVerts: [number, number][],
): boolean {
  if (houseVerts.length < 3) return false;
  if (pip(lng, lat, houseVerts)) return true;
  for (let i = 0; i < houseVerts.length; i++) {
    const a = houseVerts[i];
    const b = houseVerts[(i + 1) % houseVerts.length];
    if (ptToSegDistFt(lng, lat, a[0], a[1], b[0], b[1], lat) < HOUSE_SETBACK_FT) return true;
  }
  return false;
}

// ── PRNG helpers ───────────────────────────────────────────────────────────────

function hashStr(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return h >>> 0;
}

function seededRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0xffff_ffff; };
}

function mortonCode(col: number, row: number): number {
  let result = 0;
  for (let i = 0; i < 16; i++) {
    result |= ((col >>> i) & 1) << (2 * i);
    result |= ((row >>> i) & 1) << (2 * i + 1);
  }
  return result >>> 0;
}

// ── Step 1: bed identification and analysis ────────────────────────────────────

function identifyBeds(zones: DiyZone[]): DiyZone[] {
  return zones.filter(z => z.toolId === 'planting_bed' || (z.toolId === 'fill' && z.planted === true));
}

function analyzeBeds(
  beds: DiyZone[],
  zones: DiyZone[],
  confirmedFeatures: ConfirmedFeature[],
  boundaryVerts: [number, number][],
  sunCells: SunCell[],
  yardSide: 'front' | 'back',
): BedAnalysis[] {
  const ADJACENCY_FT = 8;
  const hardscapeZones = zones.filter(z => HARDSCAPE_TOOL_IDS.has(z.toolId));
  const treeZones      = zones.filter(z => z.toolId === 'tree');
  const confirmedTrees = confirmedFeatures.filter(f => f.type === 'tree' && f.keep);

  return beds.map(bed => {
    const area = areaSqFt(bed.vertices);
    const sun  = aggregateSun(bed.vertices, sunCells);

    let role: BedRole = 'island';

    const nearTree =
      treeZones.some(t => polygonsAdjacent(bed.vertices, t.vertices, ADJACENCY_FT)) ||
      confirmedTrees.some(t => (t.vertices?.length ?? 0) >= 3 && polygonsAdjacent(bed.vertices, t.vertices, ADJACENCY_FT));
    if (nearTree) role = 'tree_underplant';

    if (hardscapeZones.some(h => polygonsAdjacent(bed.vertices, h.vertices, ADJACENCY_FT)))
      role = 'hardscape_edge';

    if (boundaryVerts.length >= 3 && polygonsAdjacent(bed.vertices, boundaryVerts, 6))
      role = 'perimeter';

    if (role === 'perimeter' && area < 80) role = 'foundation';

    return { zoneId: bed.id, role, areaSqFt: area, sunClass: sun, vertices: bed.vertices, isGroundcoverFill: bed.toolId === 'fill', side: yardSide };
  });
}

// ── Step 2: cap computation ────────────────────────────────────────────────────

function computeTargets(
  beds: BedAnalysis[],
  zones: DiyZone[],
  confirmedFeatures: ConfirmedFeature[],
  style: DesignStyle,
  yardSide: 'front' | 'back',
): YardAnalysis {
  const areaSf      = beds.reduce((s, b) => s + b.areaSqFt, 0);
  const fullSunSf   = beds.filter(b => b.sunClass === 'full_sun').reduce((s, b) => s + b.areaSqFt, 0);

  const allTreeZones = [
    ...zones.filter(z => z.toolId === 'tree' && z.vertices.length >= 3),
    ...confirmedFeatures.filter(f => f.type === 'tree' && f.keep && (f.vertices?.length ?? 0) >= 3),
  ];
  const treesCount = allTreeZones.length;
  const capKey     = yardSide;

  let raw = STYLE_CAP[style][capKey] * (areaSf / 1000);
  if (areaSf < 500) raw = Math.max(raw, capKey === 'front' ? 1 : 2);
  raw -= treesCount;
  if (areaSf > 0 && fullSunSf / areaSf < 0.40) raw *= 0.80;
  const target = Math.max(0, Math.round(raw));

  return {
    yardAreaSf:           areaSf,
    fullSunAreaSf:        fullSunSf,
    userDrawnTreesCount:  treesCount,
    targetLargeShrubs:    target,
    styleCapUsed:         STYLE_CAP[style][capKey],
  };
}

// ── Step 3: species selection ─────────────────────────────────────────────────

function speciesCountTarget(total: number): number {
  if (total <= 2)  return 1;
  if (total <= 5)  return 2;
  if (total <= 10) return 3;
  if (total <= 16) return 4;
  return 5;
}

function selectLargeShrubSpecies(
  style: DesignStyle,
  hardinessZone: number,
  sunClasses: SunClass[],
  totalTarget: number,
  db: PlantRecord[],
  warnings: string[],
): PlantRecord[] {
  const nSpecies = speciesCountTarget(totalTarget);
  const candidates = db.filter(p =>
    (p.sizeBucket === 'solo_specimen' || p.sizeBucket === 'large') &&
    p.type !== 'deciduous_tree' && p.type !== 'evergreen_tree' &&
    p.minZone <= hardinessZone && p.maxZone >= hardinessZone &&
    sunClasses.some(sun => sunCompatible(p, sun)),
  );

  if (candidates.length === 0) {
    warnings.push('No large shrubs available for this zone and sun conditions.');
    return [];
  }

  const score = (p: PlantRecord) =>
    (p.styles.includes(style) ? 10 : 0) + (p.isAnchorCapable ? 5 : 0) + (sunClasses.some(s => sunCompatible(p, s)) ? 3 : 0);

  const rng = seededRng(hashStr(`shrubs_${style}_${hardinessZone}`));
  const ranked = [...candidates].sort((a, b) => {
    const d = score(b) - score(a);
    return Math.abs(d) > 1 ? d : rng() - 0.5;
  });

  if (ranked.length <= nSpecies) return ranked;

  const pool = ranked.slice(0, Math.min(ranked.length, nSpecies * 3)).sort((a, b) => a.matureWidthFt - b.matureWidthFt);
  const minW = pool[0].matureWidthFt, maxW = pool[pool.length - 1].matureWidthFt;
  if (maxW - minW < 0.5 || nSpecies <= 1) return ranked.slice(0, nSpecies);

  const chosen: PlantRecord[] = [];
  const used = new Set<number>();
  for (let q = 0; q < nSpecies; q++) {
    const targetW = minW + (maxW - minW) * (q / (nSpecies - 1));
    const best = pool.filter(p => !used.has(p.id))
      .reduce((a, b) => Math.abs(a.matureWidthFt - targetW) <= Math.abs(b.matureWidthFt - targetW) ? a : b);
    chosen.push(best);
    used.add(best.id);
  }
  return chosen;
}

// ── Step 4: placement ─────────────────────────────────────────────────────────

function candidatePoints(
  ring: [number, number][],
  spacingFt: number,
  houseFootprint?: [number, number][],
): [number, number][] {
  const latRef   = ringCentroid(ring)[1];
  const lngScale = ftPerDegLng(latRef);
  const dLng = spacingFt / lngScale;
  const dLat = spacingFt / FT_PER_DEG_LAT;
  const sbLng = BOUNDARY_SETBACK_FT / lngScale;
  const sbLat = BOUNDARY_SETBACK_FT / FT_PER_DEG_LAT;

  const lngs = ring.map(v => v[0]);
  const lats  = ring.map(v => v[1]);
  const minLng = Math.min(...lngs) + sbLng, maxLng = Math.max(...lngs) - sbLng;
  const minLat = Math.min(...lats) + sbLat, maxLat = Math.max(...lats) - sbLat;

  const raw: { pt: [number, number]; m: number }[] = [];
  let ri = 0;
  for (let lat = minLat + dLat / 2; lat < maxLat; lat += dLat) {
    let ci = 0;
    for (let lng = minLng + dLng / 2; lng < maxLng; lng += dLng) {
      if (pip(lng, lat, ring)) {
        if (!houseFootprint || !tooCloseToHouse(lng, lat, houseFootprint)) {
          raw.push({ pt: [lng, lat], m: mortonCode(ci, ri) });
        }
      }
      ci++;
    }
    ri++;
  }
  raw.sort((a, b) => a.m - b.m);
  return raw.map(e => e.pt);
}

function placeLargeShrubs(
  beds: BedAnalysis[],
  species: PlantRecord[],
  targetCount: number,
  style: DesignStyle,
  side: 'front' | 'back',
  houseFootprint: [number, number][] | undefined,
  shrubCounter: { v: number },
  warnings: string[],
): LargeShrub[] {
  if (species.length === 0 || targetCount === 0) return [];

  const spacingMult = SPACING_MULT[style] ?? 1.0;
  const eligible    = beds.filter(b => b.role !== 'tree_underplant');

  if (eligible.length === 0) {
    if (targetCount > 0) warnings.push(`No plantable beds for large shrubs.`);
    return [];
  }

  const avgWidth  = species.reduce((s, p) => s + p.matureWidthFt, 0) / species.length;
  const spacingFt = Math.max(avgWidth, 2) * spacingMult;

  const allCandidates: { pt: [number, number]; bedId: string }[] = [];
  for (const bed of eligible) {
    const pts = candidatePoints(bed.vertices, spacingFt, houseFootprint);
    for (const pt of pts) allCandidates.push({ pt, bedId: bed.zoneId });
  }

  if (allCandidates.length === 0) {
    warnings.push(`No valid placement spots — beds may be too narrow.`);
    return [];
  }

  const result: LargeShrub[] = [];
  const placedPts: [number, number][] = [];
  const latRef    = eligible[0]?.vertices[0]?.[1] ?? 39;
  const lngScale  = ftPerDegLng(latRef);
  let speciesIdx  = 0;

  for (const { pt, bedId } of allCandidates) {
    if (result.length >= targetCount) break;
    const tooClose = placedPts.some(e => {
      const dx = (pt[0] - e[0]) * lngScale;
      const dy = (pt[1] - e[1]) * FT_PER_DEG_LAT;
      return Math.hypot(dx, dy) < spacingFt * 0.9;
    });
    if (tooClose) continue;

    const plant = species[speciesIdx % species.length];
    shrubCounter.v++;
    result.push({ id: `shrub_${shrubCounter.v}`, plantId: plant.id, lngLat: pt, bedId, matureWidthFt: plant.matureWidthFt, side });
    placedPts.push(pt);
    speciesIdx++;
  }

  if (result.length < targetCount) {
    warnings.push(`Placed ${result.length} of ${targetCount} target large shrubs — beds may be too small.`);
  }

  return result;
}

// ── Tree selection ────────────────────────────────────────────────────────────

function treeHeightBin(heightM: number): 'small' | 'medium' | 'large' {
  if (heightM < 5)  return 'small';
  if (heightM < 10) return 'medium';
  return 'large';
}

function treeMaxHeightFt(bin: 'small' | 'medium' | 'large'): number {
  return bin === 'small' ? 20 : bin === 'medium' ? 35 : Infinity;
}

function treeMinHeightFt(bin: 'small' | 'medium' | 'large'): number {
  return bin === 'small' ? 0 : bin === 'medium' ? 16 : 33;
}

function selectTreeSpecies(
  zones: DiyZone[],
  confirmedFeatures: ConfirmedFeature[],
  style: DesignStyle,
  hardinessZone: number,
  db: PlantRecord[],
): TreeAssignment[] {
  const trees = db.filter(p => p.type === 'deciduous_tree' || p.type === 'evergreen_tree');
  const assignments: TreeAssignment[] = [];

  for (const feat of confirmedFeatures) {
    if (feat.type !== 'tree' || !feat.keep || (feat.vertices?.length ?? 0) < 3) continue;
    const bin        = treeHeightBin(feat.attributes?.heightM ?? 7.5);
    const center     = ringCentroid(feat.vertices);
    const candidates = trees.filter(p =>
      p.matureHeightFt >= treeMinHeightFt(bin) && p.matureHeightFt < treeMaxHeightFt(bin) &&
      p.minZone <= hardinessZone && p.maxZone >= hardinessZone,
    );
    const chosen = candidates.find(p => p.styles.includes(style)) ?? candidates[0];
    if (chosen) assignments.push({ zoneId: feat.id, plantId: chosen.id, centerLngLat: center, source: 'confirmed_keep' });
  }

  for (const zone of zones) {
    if (zone.toolId !== 'tree' || zone.vertices.length < 3) continue;
    let bin: 'small' | 'medium' | 'large' = 'medium';
    const lbl = zone.label.toUpperCase();
    if (/\bS\b/.test(lbl) || /SMALL/.test(lbl)) bin = 'small';
    else if (/\bL\b/.test(lbl) || /LARGE/.test(lbl)) bin = 'large';
    const center     = ringCentroid(zone.vertices);
    const candidates = trees.filter(p =>
      p.matureHeightFt >= treeMinHeightFt(bin) && p.matureHeightFt < treeMaxHeightFt(bin) &&
      p.minZone <= hardinessZone && p.maxZone >= hardinessZone,
    );
    const rng  = seededRng(hashStr(`tree_${zone.id}`));
    const pool = candidates.filter(p => p.styles.includes(style));
    const src  = pool.length > 0 ? pool : candidates;
    const chosen = src[Math.floor(rng() * src.length)];
    if (chosen) assignments.push({ zoneId: zone.id, plantId: chosen.id, centerLngLat: center, source: 'new_zone' });
  }

  return assignments;
}

// ── Purchase list ──────────────────────────────────────────────────────────────

function buildPurchaseList(
  largeShrubs: LargeShrub[],
  trees: TreeAssignment[],
  db: PlantRecord[],
): PurchaseEntry[] {
  const byId = new Map(db.map(p => [p.id, p]));
  const map  = new Map<number, PurchaseEntry>();

  const add = (plantId: number, bedId: string) => {
    const rec = byId.get(plantId);
    if (!rec) return;
    const e = map.get(plantId) ?? { plantId, commonName: rec.commonName, botanicalName: rec.botanicalName, count: 0, bedsUsed: [] };
    e.count++;
    if (!e.bedsUsed.includes(bedId)) e.bedsUsed.push(bedId);
    map.set(plantId, e);
  };

  for (const s of largeShrubs) add(s.plantId, s.bedId);
  for (const t of trees)       add(t.plantId, t.zoneId);

  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ── Main export ────────────────────────────────────────────────────────────────

export function runDiyPlantPlacement(inputs: PlacementInputs): DiyPlantPlan {
  const { boundaryVerts, zones, confirmedFeatures, sunCells, style, hardinessZone, houseFootprint, yardSide } = inputs;
  const db       = getPlantDatabase();
  const warnings: string[] = [];

  console.log('[runDiyPlantPlacement] style:', style, '| zone:', hardinessZone, '| side:', yardSide, '| db:', db.length);

  let bedZones = identifyBeds(zones);
  if (bedZones.length === 0 && boundaryVerts.length >= 3) {
    bedZones = [{ id: 'boundary_fallback', toolId: 'planting_bed', label: 'Planting area', color: '#4A7C59', vertices: boundaryVerts }];
  }

  const beds         = analyzeBeds(bedZones, zones, confirmedFeatures, boundaryVerts, sunCells, yardSide);
  const yardAnalysis = computeTargets(beds, zones, confirmedFeatures, style, yardSide);

  console.log('[yardAnalysis] area:', Math.round(yardAnalysis.yardAreaSf), 'sf | target:', yardAnalysis.targetLargeShrubs, '| house verts:', houseFootprint?.length ?? 0);

  const allSunClasses = [...new Set(beds.map(b => b.sunClass))];
  const species = selectLargeShrubSpecies(style, hardinessZone, allSunClasses, yardAnalysis.targetLargeShrubs, db, warnings);

  console.log('[species] selected:', species.map(p => `${p.commonName}(${p.sizeBucket})`));

  const shrubCounter = { v: 0 };
  const largeShrubs  = placeLargeShrubs(beds, species, yardAnalysis.targetLargeShrubs, style, yardSide, houseFootprint, shrubCounter, warnings);

  const trees        = selectTreeSpecies(zones, confirmedFeatures, style, hardinessZone, db);
  const purchaseList = buildPurchaseList(largeShrubs, trees, db);

  console.log('[runDiyPlantPlacement] beds:', beds.length, '| largeShrubs:', largeShrubs.length, '| trees:', trees.length);

  return { yardAnalysis, beds, largeShrubs, trees, purchaseList, warnings };
}
