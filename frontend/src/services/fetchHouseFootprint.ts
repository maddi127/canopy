/**
 * House footprint detection
 *
 * Primary:  Google Geocoding API with extra_computations=BUILDING_AND_ENTRANCES
 * Fallback: Google Solar Building Insights API (returns bounding box → rect approx)
 */

const GMAPS_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY ?? '';

export type FootprintSource = 'geocoding_api' | 'solar_api' | 'user_manual' | 'user_edited';

export interface HouseFootprintResult {
  vertices: [number, number][];
  source: 'geocoding_api' | 'solar_api';
}

async function fromGeocoding(address: string): Promise<[number, number][] | null> {
  if (!address || !GMAPS_KEY) { console.log('[fetchHouseFootprint] Geocoding skipped: missing', { address: !!address, key: !!GMAPS_KEY }); return null; }
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('extra_computations', 'BUILDING_AND_ENTRANCES');
    url.searchParams.set('key', GMAPS_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) { console.log('[fetchHouseFootprint] Geocoding HTTP error:', res.status); return null; }
    const data = await res.json();
    console.log('[fetchHouseFootprint] Geocoding raw response status:', data.status, '| buildings:', data.results?.[0]?.buildings?.length ?? 'none');
    const polygon = data.results?.[0]?.buildings?.[0]?.building_outlines?.[0]?.display_polygon;
    console.log('[fetchHouseFootprint] Geocoding polygon:', polygon ? `${polygon.coordinates?.[0]?.length} coords` : 'null');
    if (!polygon?.coordinates?.[0] || polygon.coordinates[0].length < 3) return null;
    const ring = polygon.coordinates[0] as [number, number][];
    // Strip closing vertex if present
    const last = ring[ring.length - 1];
    const first = ring[0];
    const verts = (last[0] === first[0] && last[1] === first[1]) ? ring.slice(0, -1) : ring;
    console.log('[fetchHouseFootprint] Geocoding API → building with', verts.length, 'vertices');
    return verts;
  } catch (e) {
    console.warn('[fetchHouseFootprint] Geocoding API error:', e);
    return null;
  }
}

async function fromSolar(lat: number, lng: number): Promise<[number, number][] | null> {
  if (!lat || !lng || !GMAPS_KEY) { console.log('[fetchHouseFootprint] Solar skipped: missing', { lat, lng, key: !!GMAPS_KEY }); return null; }
  try {
    const url = new URL('https://solar.googleapis.com/v1/buildingInsights:findClosest');
    url.searchParams.set('location.latitude', String(lat));
    url.searchParams.set('location.longitude', String(lng));
    url.searchParams.set('requiredQuality', 'LOW');
    url.searchParams.set('key', GMAPS_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) { const errText = await res.text().catch(() => ''); console.log('[fetchHouseFootprint] Solar HTTP error:', res.status, errText.slice(0, 200)); return null; }
    const data = await res.json();
    console.log('[fetchHouseFootprint] Solar response keys:', Object.keys(data), '| bb:', data.boundingBox);
    const bb = data.boundingBox;
    if (!bb?.sw || !bb?.ne) return null;
    // Use bounding box as rectangular approximation — user will confirm/edit
    const { sw, ne } = bb;
    const verts: [number, number][] = [
      [sw.longitude, sw.latitude],
      [ne.longitude, sw.latitude],
      [ne.longitude, ne.latitude],
      [sw.longitude, ne.latitude],
    ];
    console.log('[fetchHouseFootprint] Solar API → bounding box rect');
    return verts;
  } catch (e) {
    console.warn('[fetchHouseFootprint] Solar API error:', e);
    return null;
  }
}

export async function fetchHouseFootprint(
  address: string,
  lat: number,
  lng: number,
): Promise<HouseFootprintResult | null> {
  const geocoding = await fromGeocoding(address);
  if (geocoding) return { vertices: geocoding, source: 'geocoding_api' };

  const solar = await fromSolar(lat, lng);
  if (solar) return { vertices: solar, source: 'solar_api' };

  console.log('[fetchHouseFootprint] Both APIs failed — manual draw required');
  return null;
}
