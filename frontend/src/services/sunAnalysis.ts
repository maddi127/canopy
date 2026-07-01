// Simplified sun-exposure model for the yard. Sun sits to the south (northern hemisphere), so
// obstacles cast shade to their north. We sample three times of day (low morning, high noon, low
// afternoon) and, per grid cell, march a ray toward the sun; if a tall-enough obstacle blocks it,
// that time is shaded. Score = weighted fraction of the day in sun (0 = deep shade, 1 = full sun).
//
// Coordinates are in FEET from buildCS (x = east, y increases toward the south), matching the rest
// of the DIY flow, so the map lines up with everything drawn on the plan.

export type SunObstacle = { ring: [number, number][]; height: number };
export type SunMap = { minX: number; minY: number; step: number; cols: number; rows: number; score: number[] };

const SAMPLES = [
  { dx: 0.6, dy: 0.8, tan: Math.tan(28 * Math.PI / 180), w: 0.28 },  // morning, low, from the SE
  { dx: 0,   dy: 1,   tan: Math.tan(62 * Math.PI / 180), w: 0.44 },  // midday, high, due south
  { dx: -0.6, dy: 0.8, tan: Math.tan(28 * Math.PI / 180), w: 0.28 }, // afternoon, low, from the SW
];

function ptInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function computeSunMap(boundaryFt: [number, number][], obstacles: SunObstacle[]): SunMap | null {
  if (boundaryFt.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of boundaryFt) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const w = maxX - minX, h = maxY - minY;
  const step = Math.max(2, Math.min(6, Math.max(w, h) / 40));
  const cols = Math.ceil(w / step) + 1, rows = Math.ceil(h / step) + 1;
  const score = new Array(cols * rows).fill(-1);
  const maxH = Math.max(1, ...obstacles.map(o => o.height));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + c * step, y = minY + r * step;
      if (!ptInRing(x, y, boundaryFt)) continue;
      let sun = 0;
      for (const s of SAMPLES) {
        const reach = maxH / s.tan;
        let blocked = false;
        for (let d = step; d <= reach && !blocked; d += step) {
          const px = x + s.dx * d, py = y + s.dy * d, needed = d * s.tan;
          for (const o of obstacles) { if (o.height >= needed && ptInRing(px, py, o.ring)) { blocked = true; break; } }
        }
        if (!blocked) sun += s.w;
      }
      score[r * cols + c] = sun;
    }
  }
  return { minX, minY, step, cols, rows, score };
}

// Same buildCS as the rest of the DIY flow, so the sun map lines up with everything drawn.
function toXY(verts: [number, number][]) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), avg = (Math.min(...lats) + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT];
}

// Build the sun map for a site straight from the saved boundary + confirmed features.
export function sunMapForSite(boundary: [number, number][], features: any[]): SunMap | null {
  if (!boundary || boundary.length < 3) return null;
  const cs = toXY(boundary);
  const boundaryFt = boundary.map(v => cs(v[0], v[1])) as [number, number][];
  const obstacles: SunObstacle[] = [];
  for (const f of features || []) {
    if (!f?.keep || !f.vertices || f.vertices.length < 3) continue;
    let height = 0;
    if (f.type === 'house') height = 16;
    else if (f.type === 'tree') height = f.attributes?.heightM ? f.attributes.heightM * 3.28 : 20;
    else if (f.type === 'structure') height = 8;
    else continue; // hardscape is flat — casts no shade
    obstacles.push({ ring: f.vertices.map((v: [number, number]) => cs(v[0], v[1])), height });
  }
  return computeSunMap(boundaryFt, obstacles);
}

// Sun score (0..1) at a feet point; ~0.6 (mostly sunny) outside the computed grid.
export function sampleSun(map: SunMap | null, x: number, y: number): number {
  if (!map) return 0.6;
  const c = Math.round((x - map.minX) / map.step), r = Math.round((y - map.minY) / map.step);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return 0.6;
  const v = map.score[r * map.cols + c];
  return v < 0 ? 0.6 : v;
}
