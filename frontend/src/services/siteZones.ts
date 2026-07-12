// Site-zone detection: identifies special regions of the yard that carry their own design rules.
// Currently just the FOUNDATION band (against the house wall) — detected at site-build and used to
// keep dry creek beds / accent beds off the house. Geometry is planar-feet; turf runs on lng/lat
// for the house buffer.
import * as turf from '@turf/turf';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

export type Ring = [number, number][];

export interface SiteZones {
  foundation: { ft: Ring[] } | null; // band against the house
}

interface CS { toXY: (lng: number, lat: number) => [number, number]; }
function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), minLat = Math.min(...lats);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return { toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT] };
}

function ringArea(r: Ring): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function closeLL(r: [number, number][]): [number, number][] { const f = r[0], l = r[r.length - 1]; return (f[0] === l[0] && f[1] === l[1]) ? r : [...r, f]; }

export function detectSiteZones(boundary: [number, number][], existing: ConfirmedFeature[]): SiteZones {
  const zones: SiteZones = { foundation: null };
  if (!boundary || boundary.length < 3) return zones;
  const cs = buildCS(boundary);

  const houses = existing.filter(f => f.keep && f.type === 'house' && (f.vertices?.length ?? 0) >= 3);
  if (!houses.length) return zones;

  // ── Foundation band: house buffered out ~4.5 ft, minus the house, clipped to the yard. ──
  try {
    const houseLL = turf.polygon([closeLL(houses.reduce((a, f) => ringArea(f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring) > ringArea(a.vertices.map(v => cs.toXY(v[0], v[1])) as Ring) ? f : a).vertices)]);
    const buf = turf.buffer(houseLL, 4.5, { units: 'feet' });
    let band = buf ? turf.difference(buf, houseLL) : null;
    if (band) band = turf.intersect(band, turf.polygon([closeLL(boundary)])) as typeof band;
    if (band) {
      const polys = band.geometry.type === 'Polygon' ? [band.geometry.coordinates] : band.geometry.coordinates;
      const rings: Ring[] = [];
      for (const poly of polys) { const outer = poly[0]; if (outer && outer.length >= 4) rings.push(outer.map(([lng, lat]) => cs.toXY(lng, lat)) as Ring); }
      if (rings.length) zones.foundation = { ft: rings };
    }
  } catch { /* skip foundation */ }

  return zones;
}
