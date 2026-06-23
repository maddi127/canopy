import * as turf from '@turf/turf';
import { PLANTS } from './plantDatabase';
import type { ZonePalette, PlantRole, StyleCap } from './paletteCurator';

export interface PlantInstance {
  id: string;
  plantId: string;
  position: [number, number]; // [lng, lat]
  rotation: number;
  scale: number;
  color: string;
}

// ── Poisson-disc sampling (Bridson's algorithm) ────────────────────────────
// Returns up to `count` points inside `polygon`, separated by at least minDistM.

function poissonDisc(
  polygon: any,
  minDistM: number,
  count: number,
  mPerLng: number,
  mPerLat: number,
): [number, number][] {
  const bbox = turf.bbox(polygon);
  const results: [number, number][] = [];
  const active:  [number, number][] = [];
  const K = 30; // candidates per active point

  // Seed point
  for (let attempt = 0; attempt < 400 && results.length === 0; attempt++) {
    const pt: [number, number] = [
      bbox[0] + Math.random() * (bbox[2] - bbox[0]),
      bbox[1] + Math.random() * (bbox[3] - bbox[1]),
    ];
    try {
      if (turf.booleanPointInPolygon(pt, polygon)) {
        results.push(pt);
        active.push(pt);
      }
    } catch {}
  }

  if (results.length === 0) return [];

  while (active.length > 0 && results.length < count) {
    const idx = Math.floor(Math.random() * active.length);
    const origin = active[idx];
    let found = false;

    for (let k = 0; k < K; k++) {
      const angle = Math.random() * 2 * Math.PI;
      // Annulus radius between minDist and 2*minDist (in meters), converted to degrees
      const rM = minDistM * (1 + Math.random());
      const cand: [number, number] = [
        origin[0] + (rM / mPerLng) * Math.cos(angle),
        origin[1] + (rM / mPerLat) * Math.sin(angle),
      ];

      if (cand[0] < bbox[0] || cand[0] > bbox[2] || cand[1] < bbox[1] || cand[1] > bbox[3]) continue;
      try { if (!turf.booleanPointInPolygon(cand, polygon)) continue; } catch { continue; }

      let tooClose = false;
      for (const r of results) {
        const dx = (r[0] - cand[0]) * mPerLng;
        const dy = (r[1] - cand[1]) * mPerLat;
        if (Math.sqrt(dx * dx + dy * dy) < minDistM) { tooClose = true; break; }
      }
      if (tooClose) continue;

      results.push(cand);
      active.push(cand);
      found = true;
      if (results.length >= count) break;
    }

    if (!found) active.splice(idx, 1);
  }

  return results;
}

// ── Band computation ───────────────────────────────────────────────────────
// Splits a polygon into three concentric bands:
//   foundation (inner 30%) — structural trees + large shrubs
//   filler (middle 40%) — foundation/perimeter shrubs
//   perimeter (outer 30%) — edging fillers

interface Bands {
  foundation: any;
  filler: any;
  perimeter: any;
}

function computeBands(polygon: any): Bands {
  const fallback: Bands = { foundation: polygon, filler: polygon, perimeter: polygon };
  try {
    const areaSqM  = turf.area(polygon);
    const eqRadius = Math.sqrt(areaSqM / Math.PI); // meters

    // midPolygon = zone shrunk to remove the outer 30%
    const midPolygon = turf.buffer(polygon, -(eqRadius * 0.30), { units: 'meters' });
    // innerPolygon = zone shrunk to the inner 30%
    const innerPolygon = midPolygon
      ? turf.buffer(midPolygon, -(eqRadius * 0.40), { units: 'meters' })
      : null;

    const perimeter = midPolygon
      ? (turf.difference(polygon, midPolygon) ?? polygon)
      : polygon;

    const filler = (midPolygon && innerPolygon)
      ? (turf.difference(midPolygon, innerPolygon) ?? midPolygon)
      : (midPolygon ?? polygon);

    const foundation = innerPolygon ?? midPolygon ?? polygon;

    return { foundation, filler, perimeter };
  } catch { return fallback; }
}

// ── Role → band mapping ────────────────────────────────────────────────────

const ROLE_BAND: Record<PlantRole, keyof Bands> = {
  tree:             'foundation',
  large_shrub:      'foundation',
  foundation_shrub: 'filler',
  perimeter_shrub:  'perimeter',
  filler:           'perimeter',
};

const ROLE_ORDER: Record<PlantRole, number> = {
  tree: 0, large_shrub: 1, foundation_shrub: 2, perimeter_shrub: 3, filler: 4,
};

// ── Centroid placement for tree zones ─────────────────────────────────────

export function placeTreeZone(
  zonePolygon: any,
  plantId: string,
  colorForId: Map<string, string>,
): PlantInstance | null {
  try {
    const center = turf.centroid(zonePolygon);
    const pos = center.geometry.coordinates as [number, number];
    return {
      id: `${plantId}_tree_${Date.now()}`,
      plantId,
      position: pos,
      rotation: 0,
      scale: 1.0,
      color: colorForId.get(plantId) ?? '#2F6B4F',
    };
  } catch { return null; }
}

// ── Layered placement for planting beds ───────────────────────────────────

export function placePlantingBed(
  palette: ZonePalette,
  zonePolygon: any,
  caps: StyleCap,
  colorForId: Map<string, string>,
): PlantInstance[] {
  const bands = computeBands(zonePolygon);

  const bbox = turf.bbox(zonePolygon);
  const latC    = (bbox[1] + bbox[3]) / 2;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((latC * Math.PI) / 180);

  // Track occupied positions across all species so they don't overlap
  const occupied: { pos: [number, number]; radiusM: number }[] = [];
  const instances: PlantInstance[] = [];

  // Place largest plants first so smaller plants fill around them
  const sorted = [...palette.selections].sort((a, b) => {
    const pa = PLANTS.find(p => p.id === a.plantId);
    const pb = PLANTS.find(p => p.id === b.plantId);
    return (ROLE_ORDER[pa?.type ?? 'filler']) - (ROLE_ORDER[pb?.type ?? 'filler']);
  });

  for (const sel of sorted) {
    const plant = PLANTS.find(p => p.id === sel.plantId);
    if (!plant) continue;

    const radiusM  = Math.max(0.5, (plant.mature_width_ft / 2) * 0.3048);
    const spacingM = Math.max(radiusM * 2.2, plant.spacing_ft * 0.3048 * caps.spacingMultiplier);

    const bandKey = ROLE_BAND[plant.type] ?? 'filler';
    const band = bands[bandKey];
    if (!band) continue;

    // Generate more candidates than needed so we can skip blocked ones
    const candidates = poissonDisc(band, spacingM, sel.targetCount * 4, mPerLng, mPerLat);

    let placed = 0;
    for (const pos of candidates) {
      if (placed >= sel.targetCount) break;

      const blocked = occupied.some(o => {
        const dx = (o.pos[0] - pos[0]) * mPerLng;
        const dy = (o.pos[1] - pos[1]) * mPerLat;
        return Math.sqrt(dx * dx + dy * dy) < Math.max(spacingM, o.radiusM + radiusM + 0.05);
      });
      if (blocked) continue;

      occupied.push({ pos, radiusM });
      instances.push({
        id: `${sel.plantId}_${Date.now()}_${placed}`,
        plantId: sel.plantId,
        position: pos,
        rotation: 0,
        scale: 1.0,
        color: colorForId.get(sel.plantId) ?? '#9A9A92',
      });
      placed++;
    }
  }

  return instances;
}

// ── GeoJSON output ─────────────────────────────────────────────────────────

export function instancesToGeoJSON(instances: PlantInstance[]): any {
  const features = instances.flatMap(inst => {
    const plant = PLANTS.find(p => p.id === inst.plantId);
    if (!plant) return [];
    const radiusM = Math.max(0.5, (plant.mature_width_ft / 2) * 0.3048);
    try {
      const circle = turf.circle(inst.position, radiusM / 1000, { steps: 24 });
      (circle as any).properties = { color: inst.color, name: plant.common_name, id: plant.id };
      return [circle];
    } catch { return []; }
  });
  return turf.featureCollection(features as any[]);
}
