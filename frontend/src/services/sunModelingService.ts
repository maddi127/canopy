import { getPosition } from 'suncalc';
import * as turf from '@turf/turf';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

// ── Types ──────────────────────────────────────────────────────────────────────
export type SunClass = 'full_sun' | 'part_sun' | 'part_shade' | 'full_shade';

export interface SunCell {
  lng: number;
  lat: number;
  hoursPerDay: number;
  sunClass: SunClass;
}

export interface SunModelResult {
  cells: SunCell[];
  bounds: { sw: [number, number]; ne: [number, number] };
  heatmapDataUrl: string;
  gridCols: number;
  gridRows: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const SAMPLE_DAYS = [
  new Date(Date.UTC(2024, 4, 15)),
  new Date(Date.UTC(2024, 5, 15)),
  new Date(Date.UTC(2024, 6, 15)),
  new Date(Date.UTC(2024, 7, 15)),
  new Date(Date.UTC(2024, 8, 15)),
];

const TIME_STEP_MIN   = 30;
const MIN_ALT_RAD     = 0.052; // ~3° — below this the sun is too low to count
const MIN_ALT_SHADOW  = 0.087; // ~5° — cap shadow length to prevent extreme values
const MAX_CELLS_DIM   = 60;    // target max cells per dimension

// Viridis-inspired ramp: deep purple (0h) → teal (4h) → green (8h) → yellow (12h)
const RAMP: [number, number, number][] = [
  [ 58,  28, 114],
  [ 38, 130, 142],
  [ 62, 184,  84],
  [245, 203,  24],
];
function rampColor(hoursPerDay: number): [number, number, number, number] {
  const t = Math.min(Math.max(hoursPerDay / 12, 0), 1);
  const n = RAMP.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [Math.round(a[0] + f * (b[0] - a[0])), Math.round(a[1] + f * (b[1] - a[1])), Math.round(a[2] + f * (b[2] - a[2])), 160];
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function classifySun(h: number): SunClass {
  if (h >= 6) return 'full_sun';
  if (h >= 4) return 'part_sun';
  if (h >= 2) return 'part_shade';
  return 'full_shade';
}

function mToLng(meters: number, lat: number): number {
  return meters / (111320 * Math.cos(lat * Math.PI / 180));
}
function mToLat(meters: number): number {
  return meters / 111320;
}

// Ray-casting point-in-polygon (GeoJSON ring: closed or open, doesn't matter)
function pip(pt: [number, number], ring: [number, number][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Shade casters ──────────────────────────────────────────────────────────────
interface TreeCaster { kind: 'tree'; cLng: number; cLat: number; rM: number; hM: number; }
interface PolyCaster { kind: 'poly'; verts: [number, number][]; hM: number; }
type Caster = TreeCaster | PolyCaster;

function buildCasters(features: ConfirmedFeature[]): Caster[] {
  const out: Caster[] = [];
  for (const f of features) {
    if (!f.keep || f.vertices.length < 3) continue;
    try {
      if (f.type === 'tree') {
        const c = turf.centroid(
          turf.polygon([[...f.vertices, f.vertices[0]]]),
        ).geometry.coordinates as [number, number];
        const rM = turf.distance(turf.point(c), turf.point(f.vertices[0]), { units: 'meters' });
        const hM = f.attributes.heightM ?? Math.max(3, rM * 2);
        out.push({ kind: 'tree', cLng: c[0], cLat: c[1], rM, hM });
      } else if (f.type === 'structure') {
        out.push({ kind: 'poly', verts: f.vertices, hM: f.attributes.heightM ?? 4 });
      }
      // hardscapes are flat — no meaningful shadow
    } catch {}
  }
  return out;
}

// Shadow direction from suncalc's south-based azimuth (0=S, π/2=W, -π/2=E, π=N):
//   shadow_east  = sin(az) * L
//   shadow_north = cos(az) * L
// where L = heightM / tan(altitude)
function inShadow(
  ptLng: number,
  ptLat: number,
  casters: Caster[],
  az: number,
  alt: number,
): boolean {
  const tanAlt = Math.tan(Math.max(alt, MIN_ALT_SHADOW));
  for (const c of casters) {
    if (c.kind === 'tree') {
      const L    = c.hM / tanAlt;
      const sLng = c.cLng + mToLng(Math.sin(az) * L, c.cLat);
      const sLat = c.cLat + mToLat(Math.cos(az) * L);
      const dE   = (ptLng - sLng) * 111320 * Math.cos(ptLat * Math.PI / 180);
      const dN   = (ptLat - sLat) * 111320;
      if (dE * dE + dN * dN <= c.rM * c.rM) return true;
    } else {
      const L = c.hM / tanAlt;
      const shadow: [number, number][] = c.verts.map(([vlng, vlat]) => [
        vlng + mToLng(Math.sin(az) * L, vlat),
        vlat + mToLat(Math.cos(az) * L),
      ]);
      if (pip([ptLng, ptLat], shadow)) return true;
    }
  }
  return false;
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function computeSunModel(
  boundaryVerts: [number, number][],
  features: ConfirmedFeature[],
): Promise<SunModelResult> {
  if (boundaryVerts.length < 3) throw new Error('boundary too small');

  const bbox = turf.bbox(turf.polygon([[...boundaryVerts, boundaryVerts[0]]]));
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const refLat = (minLat + maxLat) / 2;
  const refLng = (minLng + maxLng) / 2;

  const bwM = (maxLng - minLng) * 111320 * Math.cos(refLat * Math.PI / 180);
  const bhM = (maxLat - minLat) * 111320;
  const spacingM = Math.max(0.8, Math.max(bwM, bhM) / MAX_CELLS_DIM);

  const stepLat = mToLat(spacingM);
  const stepLng = mToLng(spacingM, refLat);
  const cols = Math.ceil((maxLng - minLng) / stepLng) + 1;
  const rows = Math.ceil((maxLat - minLat) / stepLat) + 1;

  const boundaryRing = [...boundaryVerts, boundaryVerts[0]];
  const casters = buildCasters(features);
  const sunMins = new Float32Array(rows * cols);

  // Precompute containment (only computed once, not per time step)
  const inside = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const ptLat = minLat + r * stepLat;
    for (let col = 0; col < cols; col++) {
      if (pip([minLng + col * stepLng, ptLat], boundaryRing)) {
        inside[r * cols + col] = 1;
      }
    }
  }

  for (const day of SAMPLE_DAYS) {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += TIME_STEP_MIN) {
        const dt = new Date(day.getTime());
        dt.setUTCHours(h, m, 0, 0);
        const { azimuth, altitude } = getPosition(dt, refLat, refLng);
        if (altitude < MIN_ALT_RAD) continue;

        for (let r = 0; r < rows; r++) {
          const ptLat = minLat + r * stepLat;
          for (let col = 0; col < cols; col++) {
            const idx = r * cols + col;
            if (!inside[idx]) continue;
            if (!inShadow(minLng + col * stepLng, ptLat, casters, azimuth, altitude)) {
              sunMins[idx] += TIME_STEP_MIN;
            }
          }
        }
      }
    }
  }

  const cells: SunCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const idx = r * cols + col;
      if (!inside[idx]) continue;
      const lng = minLng + col * stepLng;
      const lat = minLat + r * stepLat;
      const hoursPerDay = sunMins[idx] / SAMPLE_DAYS.length / 60;
      cells.push({ lng, lat, hoursPerDay, sunClass: classifySun(hoursPerDay) });
    }
  }

  // Draw canvas (canvas Y = 0 is top = maxLat, so flip row)
  const canvas = document.createElement('canvas');
  canvas.width  = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(cols, rows);

  for (const cell of cells) {
    const col = Math.round((cell.lng - minLng) / stepLng);
    const row = Math.round((cell.lat - minLat) / stepLat);
    const px  = (rows - 1 - row) * cols + col;
    const [rv, gv, bv, av] = rampColor(cell.hoursPerDay);
    img.data[px * 4]     = rv;
    img.data[px * 4 + 1] = gv;
    img.data[px * 4 + 2] = bv;
    img.data[px * 4 + 3] = av;
  }
  ctx.putImageData(img, 0, 0);

  return {
    cells,
    bounds: { sw: [minLng, minLat], ne: [maxLng, maxLat] },
    heatmapDataUrl: canvas.toDataURL('image/png'),
    gridCols: cols,
    gridRows: rows,
  };
}
