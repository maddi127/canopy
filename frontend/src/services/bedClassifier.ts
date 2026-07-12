// Bed classifier: splits the plantable ground into distinct beds (the yard minus existing hardscape /
// structures) and classifies each by geometry — main, secondary, accent, parkstrip, foundation, island.
// Deterministic; consumed at site-build. Geometry is planar-feet; turf boolean ops are planar too.
import * as turf from '@turf/turf';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

export type Ring = [number, number][];
export type BedType = 'main' | 'secondary' | 'accent' | 'parkstrip' | 'foundation' | 'island';

export interface ClassifiedBed {
  id: string;
  type: BedType;
  areaSf: number;
  ringFt: Ring;
  ringLngLat: [number, number][];
}

interface CS { toXY: (lng: number, lat: number) => [number, number]; toLngLat: (x: number, y: number) => [number, number]; }
function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), minLat = Math.min(...lats), maxLng = Math.max(...lngs);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return {
    toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
    toLngLat: (x, y) => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
  };
}
function ringArea(r: Ring): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function centroid(r: Ring): [number, number] { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }
function closeR(r: Ring): Ring { const f = r[0], l = r[r.length - 1]; return (f[0] === l[0] && f[1] === l[1]) ? r : [...r, f]; }
function ringsOf(feat: any): Ring[] {
  if (!feat) return [];
  const g = feat.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((p: any) => p[0] as Ring).filter((r: Ring) => r && r.length >= 4);
}
function segPointDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Min distance between two rings' perimeters.
function ringsMinDist(A: Ring, B: Ring): number {
  let m = Infinity;
  for (const [px, py] of A) for (let i = 0; i < B.length; i++) { const b1 = B[i], b2 = B[(i + 1) % B.length]; m = Math.min(m, segPointDist(px, py, b1[0], b1[1], b2[0], b2[1])); }
  return m;
}
// Min distance from a ring's perimeter to a single segment.
function ringToSegDist(r: Ring, a: [number, number], b: [number, number]): number {
  let m = Infinity;
  for (const [px, py] of r) m = Math.min(m, segPointDist(px, py, a[0], a[1], b[0], b[1]));
  return m;
}
// Farthest-apart pair of a ring's vertices = its long axis.
function longAxis(r: Ring): [[number, number], [number, number]] {
  let maxD = 0, p1 = r[0], p2 = r[0];
  for (let a = 0; a < r.length; a++) for (let c = a + 1; c < r.length; c++) { const d = Math.hypot(r[a][0] - r[c][0], r[a][1] - r[c][1]); if (d > maxD) { maxD = d; p1 = r[a]; p2 = r[c]; } }
  return [p1, p2];
}
const dirAngle = (a: [number, number], b: [number, number]) => Math.atan2(b[1] - a[1], b[0] - a[0]);
// Angle between two lines (0..π/2), direction-agnostic.
function lineAngleDiff(t1: number, t2: number): number { let d = Math.abs(t1 - t2) % Math.PI; return Math.min(d, Math.PI - d); }

const AREA_MIN = 12;               // ignore paving slivers below this
const SKINNY_WIDTH_FT = 4;         // very thin → accent / border
const PARKSTRIP_MAX_WIDTH = 12;    // a street-side strip is narrow; the main front bed is wider
const GAP_CLOSE_FT = 2;            // grow hardscape this much so paths that nearly reach the house
                                   // (or boundary) still sever a bed — otherwise they read as one.

export function classifyBeds(boundary: [number, number][], existing: ConfirmedFeature[]): ClassifiedBed[] {
  if (!boundary || boundary.length < 3) return [];
  const cs = buildCS(boundary);
  const bft = boundary.map(v => cs.toXY(v[0], v[1])) as Ring;

  // Plantable ground = boundary minus houses / hardscape / structures, in LNG/LAT so turf.buffer
  // (which is geodesic) can grow each obstacle a bit to close small gaps between a path and the house.
  let ground: any; try { ground = turf.polygon([closeR(boundary as Ring)]); } catch { return []; }
  const obstacles = existing.filter(f => f.keep && (f.type === 'house' || f.type === 'hardscape' || f.type === 'structure') && (f.vertices?.length ?? 0) >= 3);
  for (const f of obstacles) {
    try {
      let poly: any = turf.polygon([closeR(f.vertices as Ring)]);
      const buf = turf.buffer(poly, GAP_CLOSE_FT, { units: 'feet' }); if (buf) poly = buf;
      const d = turf.difference(ground, poly); if (d) ground = d;
    } catch { /* keep */ }
  }
  // Bed rings come back in lng/lat; convert to feet for area + classification.
  const bedRings = ringsOf(ground).map(rLL => ({ ll: rLL, ft: rLL.map(([lng, lat]) => cs.toXY(lng, lat)) as Ring }))
    .filter(b => ringArea(b.ft) >= AREA_MIN);
  if (!bedRings.length) return [];

  const houseRings = existing.filter(f => f.keep && f.type === 'house' && (f.vertices?.length ?? 0) >= 3).map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring);
  const edges = bft.map((a, i) => { const b = bft[(i + 1) % bft.length]; return { a, b, ang: dirAngle(a, b) }; });

  // Street frontages (Option B — inferred from sidewalks; a Roads-API source can replace this later):
  // a boundary edge fronts a street if a detected sidewalk runs roughly parallel to and near it.
  // Sidewalks trace roads, so this is our "parallel to a road" test for parkstrips.
  const sidewalks = existing
    .filter(f => f.keep && f.type === 'hardscape' && (f.vertices?.length ?? 0) >= 3)
    .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring)
    .filter(r => { const a = ringArea(r); if (a < 20) return false; const [p1, p2] = longAxis(r); const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]); const w = a / (len || 1); return len / (w || 1) >= 3 && w <= 10; });
  const frontageEdges = edges.filter(e =>
    sidewalks.some(sw => { const [s1, s2] = longAxis(sw); return lineAngleDiff(e.ang, dirAngle(s1, s2)) < 0.35 && ringToSegDist(sw, e.a, e.b) < 15; }),
  );

  type Tmp = ClassifiedBed & { _area: number };
  const beds: Tmp[] = bedRings.map((bd, i) => {
    const r = bd.ft, area = ringArea(r);
    const [la, lb] = longAxis(r); const maxD = Math.hypot(lb[0] - la[0], lb[1] - la[1]); const bedAng = dirAngle(la, lb);
    const width = area / (maxD || 1);
    const distHouse = houseRings.length ? Math.min(...houseRings.map(h => ringsMinDist(r, h))) : Infinity;
    // Parkstrip: a THIN bed running along (adjacent + parallel to) a street frontage.
    const onFrontage = frontageEdges.some(e => ringToSegDist(r, e.a, e.b) < 3 && lineAngleDiff(bedAng, e.ang) < 0.44);
    const touchesBoundary = edges.some(e => ringToSegDist(r, e.a, e.b) < 2);
    let type: BedType;
    if (onFrontage && width < PARKSTRIP_MAX_WIDTH) type = 'parkstrip';
    else if (distHouse < 2 && width < 10) type = 'foundation';
    else if (!touchesBoundary) type = 'island';
    else if (width < SKINNY_WIDTH_FT) type = 'accent';
    else type = 'secondary';
    return { id: `bed_${i}`, type, areaSf: Math.round(area), ringFt: r, ringLngLat: bd.ll as [number, number][], _area: area };
  });

  // The largest interior (non-parkstrip/foundation) bed is the "main" bed.
  const eligible = beds.filter(b => b.type !== 'parkstrip' && b.type !== 'foundation');
  const main = (eligible.length ? eligible : beds).reduce((a, b) => b._area > a._area ? b : a);
  main.type = 'main';
  // Small non-main interior beds read as accents; the rest are secondary.
  const maxArea = main._area || 1;
  for (const b of beds) { if (b === main || b.type === 'parkstrip' || b.type === 'foundation' || b.type === 'island') continue; b.type = b._area < maxArea * 0.15 ? 'accent' : 'secondary'; }

  return beds.map(({ _area, ...b }) => b);
}
