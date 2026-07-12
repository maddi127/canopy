// Draft flow: proposes a project-area polygon from the AI-detected site features, so the user
// confirms with one tap instead of drawing from scratch. Deterministic geometry, no extra AI call.
//
// Strategy: orient on the detected house (largest footprint). The "front" direction points from the
// house centroid toward the sidewalk (elongated hardscape) if one was detected, else toward the
// side of the detection box with the most open space. The proposal is a house-aligned rectangle
// spanning the house width (+ side margins) and running from the house wall out past the sidewalk
// (or a fixed depth when no sidewalk exists). For back yards the direction flips.
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

type Ring = [number, number][];

interface CS {
  toXY: (lng: number, lat: number) => [number, number];
  toLngLat: (x: number, y: number) => [number, number];
}
function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), minLat = Math.min(...lats);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return {
    toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
    toLngLat: (x, y) => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
  };
}
function ringArea(r: Ring): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function centroid(r: Ring): [number, number] { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }

// A ~detection window around the geocoded address (bbox polygon in lng/lat), sized in feet.
export function detectionBox(lat: number, lng: number, halfFt = 70): [number, number][] {
  const mLat = 111320, mLng = 111320 * Math.cos(lat * Math.PI / 180), FT = 3.28084;
  const dLat = halfFt / (mLat * FT), dLng = halfFt / (mLng * FT);
  return [
    [lng - dLng, lat - dLat], [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat], [lng - dLng, lat + dLat],
  ];
}

export interface BoundaryProposal {
  boundary: [number, number][];       // proposed project area (lng/lat, open ring)
  doorPoint: [number, number] | null; // guessed main entry (lng/lat)
}

export function proposeBoundary(
  box: [number, number][],            // the detection bbox the features were found in
  features: ConfirmedFeature[],
  yardType: string,                   // 'front' | 'back'
): BoundaryProposal | null {
  const cs = buildCS(box);
  const boxFt = box.map(v => cs.toXY(v[0], v[1])) as Ring;
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (const [x, y] of boxFt) { bMinX = Math.min(bMinX, x); bMinY = Math.min(bMinY, y); bMaxX = Math.max(bMaxX, x); bMaxY = Math.max(bMaxY, y); }

  // Largest detected house anchors everything; without one we can't propose responsibly.
  const houses = features.filter(f => f.keep !== false && f.type === 'house' && (f.vertices?.length ?? 0) >= 3)
    .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring);
  if (!houses.length) return null;
  const house = houses.reduce((a, b) => ringArea(b) > ringArea(a) ? b : a);
  const hc = centroid(house);

  // House orientation: the longest wall sets the "along" axis; front dir is perpendicular to it.
  let wallAng = 0, longest = 0;
  for (let i = 0; i < house.length; i++) {
    const a = house[i], b = house[(i + 1) % house.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > longest) { longest = len; wallAng = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  const along: [number, number] = [Math.cos(wallAng), Math.sin(wallAng)];
  let front: [number, number] = [-along[1], along[0]];

  // Point "front" toward the sidewalk if one was detected, else toward the open side of the box.
  const sidewalks = features.filter(f => f.keep !== false && f.type === 'hardscape' && (f.vertices?.length ?? 0) >= 3)
    .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring)
    .filter(r => { const a = ringArea(r); if (a < 20) return false; let maxD = 0; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) maxD = Math.max(maxD, Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1])); const w = a / (maxD || 1); return maxD / (w || 1) >= 3 && w <= 10; });
  if (sidewalks.length) {
    const sc = centroid(sidewalks.reduce((a, b) => ringArea(b) > ringArea(a) ? b : a));
    const toWalk: [number, number] = [sc[0] - hc[0], sc[1] - hc[1]];
    if (toWalk[0] * front[0] + toWalk[1] * front[1] < 0) front = [-front[0], -front[1]];
  } else {
    // Open side: compare distance from house centroid to the box edge along ±front.
    const reach = (d: [number, number]) => Math.min(
      d[0] > 0 ? (bMaxX - hc[0]) / d[0] : d[0] < 0 ? (bMinX - hc[0]) / d[0] : Infinity,
      d[1] > 0 ? (bMaxY - hc[1]) / d[1] : d[1] < 0 ? (bMinY - hc[1]) / d[1] : Infinity,
    );
    if (reach([-front[0], -front[1]]) > reach(front)) front = [-front[0], -front[1]];
  }
  if (/back/i.test(yardType)) front = [-front[0], -front[1]];

  // House extent in the rotated frame (u = along wall, v = along front).
  const u = (p: [number, number]) => (p[0] - hc[0]) * along[0] + (p[1] - hc[1]) * along[1];
  const v = (p: [number, number]) => (p[0] - hc[0]) * front[0] + (p[1] - hc[1]) * front[1];
  let hUMin = Infinity, hUMax = -Infinity, hVMax = -Infinity;
  for (const p of house) { const pu = u(p), pv = v(p); hUMin = Math.min(hUMin, pu); hUMax = Math.max(hUMax, pu); hVMax = Math.max(hVMax, pv); }

  // Depth: to just past the sidewalk's far edge (parkstrip included), else a fixed 35 ft.
  let depth = 35;
  if (sidewalks.length) {
    let swVMax = -Infinity;
    for (const sw of sidewalks) for (const p of sw) swVMax = Math.max(swVMax, v(p));
    if (swVMax > hVMax) depth = (swVMax - hVMax) + 8; // through the walk + a parkstrip allowance
  }
  depth = Math.max(18, Math.min(depth, 70));
  const uMin = hUMin - 8, uMax = hUMax + 8;     // house width + side margins
  const vNear = hVMax - 1;                       // start at the house wall (tuck 1 ft under the eave)
  const vFar = hVMax + depth;

  const corner = (cu: number, cv: number): [number, number] => cs.toLngLat(
    hc[0] + along[0] * cu + front[0] * cv,
    hc[1] + along[1] * cu + front[1] * cv,
  );
  const boundary: [number, number][] = [corner(uMin, vNear), corner(uMax, vNear), corner(uMax, vFar), corner(uMin, vFar)];

  // Door guess: midpoint of the house's front-facing wall (center of the u-range at the wall line).
  const doorPoint = cs.toLngLat(
    hc[0] + along[0] * ((hUMin + hUMax) / 2) + front[0] * hVMax,
    hc[1] + along[1] * ((hUMin + hUMax) / 2) + front[1] * hVMax,
  ) as [number, number];

  return { boundary, doorPoint };
}
