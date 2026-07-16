import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon, Polyline } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
import { IS, IT, PAGE_BG } from '../lib/theme';

const ZONE_COLORS: Record<string, string> = {
  planting_bed:  '#52B788',
  lawn:          '#6FBF73',
  seating_area:  '#F4A261',
  water_feature: '#5DA9E9',
  path:          '#CBA17E',
  utility:       '#9E9E9E',
  raised_bed:    '#795548',
  mulch_ring:    '#8D6E63',
  ground_cover:  '#A5D6A7',
};

function dashedLine(color: string, weight = 2): google.maps.PolylineOptions {
  return {
    strokeOpacity: 0, strokeWeight: weight,
    icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: weight, strokeColor: color }, offset: '0', repeat: '10px' }],
    clickable: false,
  };
}

function buildCoordSystem(verts: [number, number][]) {
  const lngs   = verts.map(v => v[0]);
  const lats   = verts.map(v => v[1]);
  const minLng = Math.min(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avgLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(avgLat * Math.PI / 180);
  const FT = 3.28084;
  const fromXY = (x: number, y: number): [number, number] => [
    minLng + x / (mPerDegLng * FT),
    maxLat - y / (mPerDegLat * FT),
  ];
  return { fromXY };
}

interface RawZone {
  id:       string;
  type:     string;
  label:    string;
  vertices: [number, number][];
  color?:   string;
}

interface Zone {
  id:     string;
  type:   string;
  label:  string;
  color:  string;
  lngLat: [number, number][];
}

function scalePolygon(lngLat: [number, number][], factor: number): [number, number][] {
  if (lngLat.length < 3) return lngLat;
  try {
    const poly   = turf.polygon([[...lngLat, lngLat[0]]]);
    const center = turf.centroid(poly).geometry.coordinates as [number, number];
    return lngLat.map(v => [
      center[0] + (v[0] - center[0]) * factor,
      center[1] + (v[1] - center[1]) * factor,
    ]);
  } catch { return lngLat; }
}

function translatePolygon(lngLat: [number, number][], toLng: number, toLat: number): [number, number][] {
  if (lngLat.length < 3) return lngLat;
  try {
    const poly   = turf.polygon([[...lngLat, lngLat[0]]]);
    const center = turf.centroid(poly).geometry.coordinates as [number, number];
    const dLng = toLng - center[0];
    const dLat = toLat - center[1];
    return lngLat.map(v => [v[0] + dLng, v[1] + dLat]);
  } catch { return lngLat; }
}

export default function DiyLayoutPage() {
  const navigate = useNavigate();
  const mapRef   = useRef<google.maps.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  // ── Load from localStorage ───────────────────────────────────────────────────
  const { boundary, confirmedFeatures, reasoning } = useMemo<{
    boundary:          [number, number][];
    confirmedFeatures: ConfirmedFeature[];
    reasoning:         string;
  }>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('diyLayout') || '{}');
      return {
        boundary:          raw.boundary          ?? [],
        confirmedFeatures: raw.confirmedFeatures ?? [],
        reasoning:         raw.reasoning         ?? '',
      };
    } catch { return { boundary: [], confirmedFeatures: [], reasoning: '' }; }
  }, []);

  const mapCenter = useMemo(() => {
    if (boundary.length >= 3) {
      try {
        const c = turf.centroid(turf.polygon([[...boundary, boundary[0]]])).geometry.coordinates;
        return { lat: c[1], lng: c[0] };
      } catch {}
    }
    try {
      const sc = JSON.parse(localStorage.getItem('siteContext') || '{}');
      if (sc.lat && sc.lng) return { lat: Number(sc.lat), lng: Number(sc.lng) };
    } catch {}
    return { lat: 39.74, lng: -104.99 };
  }, [boundary]);

  // ── Convert zones from XY feet → lngLat ─────────────────────────────────────
  const [zones, setZones] = useState<Zone[]>(() => {
    try {
      const raw  = JSON.parse(localStorage.getItem('diyLayout') || '{}');
      const verts: [number, number][] = raw.boundary ?? [];
      if (verts.length < 3) return [];
      const cs = buildCoordSystem(verts);
      return ((raw.zones ?? []) as RawZone[])
        .filter(z => Array.isArray(z.vertices) && z.vertices.length >= 3)
        .map(z => ({
          id:     z.id,
          type:   z.type,
          label:  z.label,
          color:  z.color ?? ZONE_COLORS[z.type] ?? '#888',
          lngLat: z.vertices.map(([x, y]) => cs.fromXY(x, y)),
        }));
    } catch { return []; }
  });

  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [moveMode,   setMoveMode]     = useState(false);

  const selectedZone = zones.find(z => z.id === selectedId) ?? null;

  const selectZone = useCallback((id: string) => {
    setSelectedId(id);
    setMoveMode(false);
    const z = zones.find(z => z.id === id);
    if (z && z.lngLat.length >= 3 && mapRef.current) {
      try {
        const bb = turf.bbox(turf.polygon([[...z.lngLat, z.lngLat[0]]]));
        mapRef.current.fitBounds(
          new google.maps.LatLngBounds({ lat: bb[1], lng: bb[0] }, { lat: bb[3], lng: bb[2] }),
          80,
        );
      } catch {}
    }
  }, [zones]);

  const scaleSelected = useCallback((factor: number) => {
    if (!selectedId) return;
    setZones(prev => prev.map(z =>
      z.id === selectedId ? { ...z, lngLat: scalePolygon(z.lngLat, factor) } : z,
    ));
  }, [selectedId]);

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!moveMode || !selectedId || !e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    setZones(prev => prev.map(z =>
      z.id === selectedId ? { ...z, lngLat: translatePolygon(z.lngLat, lng, lat) } : z,
    ));
    setMoveMode(false);
  }, [moveMode, selectedId]);

  // ── Data layer for zone polygons ─────────────────────────────────────────────
  const dataLayerRef  = useRef<google.maps.Data | null>(null);
  const selectZoneRef = useRef(selectZone);
  selectZoneRef.current = selectZone;

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    // Create layer once — never destroy inside this effect (Strict Mode safe)
    if (!dataLayerRef.current) {
      dataLayerRef.current = new google.maps.Data({ map: mapRef.current });
      dataLayerRef.current.addListener(
        'click',
        (e: google.maps.Data.MouseEvent) => selectZoneRef.current(e.feature.getProperty('id') as string),
      );
    }

    // Clear old features
    const old: google.maps.Data.Feature[] = [];
    dataLayerRef.current.forEach(f => old.push(f));
    old.forEach(f => dataLayerRef.current!.remove(f));

    console.log('[DiyLayout] drawing', zones.length, 'zones');

    zones.forEach(z => {
      dataLayerRef.current!.addGeoJson({
        type: 'Feature',
        geometry: {
          type:        'Polygon',
          coordinates: [[...z.lngLat.map(v => [v[0], v[1]]), [z.lngLat[0][0], z.lngLat[0][1]]]],
        },
        properties: { id: z.id, color: z.color, sel: z.id === selectedId },
      });
    });

    dataLayerRef.current.setStyle(feature => ({
      fillColor:     feature.getProperty('color') as string,
      fillOpacity:   feature.getProperty('sel') ? 0.65 : 0.5,
      strokeColor:   '#FFFFFF',
      strokeWeight:  feature.getProperty('sel') ? 3 : 2,
      strokeOpacity: 1,
      visible:       true,
      clickable:     true,
      zIndex:        feature.getProperty('sel') ? 2 : 1,
    }));

  }, [zones, selectedId, mapReady]);

  // Destroy Data layer only on actual unmount
  useEffect(() => {
    return () => { dataLayerRef.current?.setMap(null); dataLayerRef.current = null; };
  }, []);

  // ── Auto-fit map to zones on first load ──────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current || zones.length === 0) return;
    try {
      const allPts = zones.flatMap(z => z.lngLat);
      const lngs = allPts.map(v => v[0]), lats = allPts.map(v => v[1]);
      mapRef.current.fitBounds(new google.maps.LatLngBounds(
        { lat: Math.min(...lats), lng: Math.min(...lngs) },
        { lat: Math.max(...lats), lng: Math.max(...lngs) },
      ), 60);
    } catch {}
  }, [mapReady]); // only on first map-ready

  const areaSqFt = useMemo(() => {
    if (boundary.length < 3) return 0;
    try { return Math.round(turf.area(turf.polygon([[...boundary, boundary[0]]])) * 10.7639); } catch { return 0; }
  }, [boundary]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: PAGE_BG, overflow: 'hidden' }}>

      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0">
        <Logo />
      </div>

      <div className="flex flex-1 overflow-hidden px-10 pb-10 gap-5">

        {/* ── Left toolbar ── */}
        <div className="flex flex-col gap-4 overflow-y-auto flex-shrink-0" style={{ width: '33%' }}>

          <div>
            <h1 style={{ fontFamily: IS, fontSize: '2.2rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Your layout.</h1>
            {areaSqFt > 0 && (
              <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', marginTop: '0.3rem' }}>
                {areaSqFt.toLocaleString()} sq ft · {zones.length} zones
              </p>
            )}
          </div>

          {/* Reasoning */}
          {reasoning && (
            <div className="rounded-2xl p-4" style={{ backgroundColor: '#F4EAD2' }}>
              <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#6A6A60', margin: 0, lineHeight: 1.6 }}>{reasoning}</p>
            </div>
          )}

          {/* Zone list */}
          {zones.length > 0 && (
            <div className="rounded-2xl overflow-hidden flex-shrink-0" style={{ backgroundColor: '#F4EAD2' }}>
              {zones.map((z, idx) => {
                const isSelected = z.id === selectedId;
                return (
                  <div key={z.id}>
                    {idx > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }} />}
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 hover:opacity-80 transition-all"
                      style={{ background: isSelected ? 'rgba(42,42,38,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                      onClick={() => isSelected ? setSelectedId(null) : selectZone(z.id)}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: z.color, flexShrink: 0 }} />
                      <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 500, flex: 1 }}>{z.label}</span>
                      <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', flexShrink: 0 }}>{z.type.replace(/_/g, ' ')}</span>
                    </button>

                    {/* Selected zone controls */}
                    {isSelected && (
                      <div className="px-4 pb-3 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(42,42,38,0.06)' }}>
                        <div className="flex gap-2 pt-2">
                          <button onClick={() => scaleSelected(0.9)}
                            className="flex-1 py-2 rounded-xl hover:opacity-80 transition-all"
                            style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, background: 'rgba(42,42,38,0.08)', border: 'none', cursor: 'pointer', color: '#2A2A26' }}>
                            − Shrink 10%
                          </button>
                          <button onClick={() => scaleSelected(1.1)}
                            className="flex-1 py-2 rounded-xl hover:opacity-80 transition-all"
                            style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, background: 'rgba(42,42,38,0.08)', border: 'none', cursor: 'pointer', color: '#2A2A26' }}>
                            + Grow 10%
                          </button>
                        </div>
                        <button
                          onClick={() => setMoveMode(v => !v)}
                          className="py-2 rounded-xl hover:opacity-80 transition-all"
                          style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', border: 'none',
                            background: moveMode ? '#2A2A26' : 'rgba(42,42,38,0.08)',
                            color:      moveMode ? '#efe9db'  : '#2A2A26' }}>
                          {moveMode ? 'Click map to move here…' : '↖ Move'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {zones.length === 0 && (
            <div className="rounded-2xl p-5" style={{ backgroundColor: '#F4EAD2' }}>
              <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>No zones were generated. Go back and try again.</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => navigate('/diy/boundary')}
              className="flex-1 py-2.5 rounded-full hover:opacity-80 transition-all"
              style={{ fontFamily: IT, fontSize: '0.82rem', color: '#7A7A73', fontWeight: 500, background: 'rgba(42,42,38,0.07)', border: 'none', cursor: 'pointer' }}>
              ← Redo
            </button>
            <button onClick={() => navigate('/diy/plants')}
              className="flex-1 py-2.5 rounded-full hover:opacity-90 transition-all"
              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
              Continue →
            </button>
          </div>
        </div>

        {/* ── Right: map ── */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full rounded-2xl overflow-hidden relative" style={{ cursor: moveMode ? 'crosshair' : undefined }}>
            {isLoaded ? (
              <GoogleMap
                mapContainerStyle={{ width: '100%', height: '100%' }}
                center={mapCenter}
                zoom={19}
                options={{
                  mapTypeId: 'satellite',
                  disableDoubleClickZoom: true,
                  streetViewControl: false,
                  mapTypeControl: false,
                  fullscreenControl: false,
                  zoomControl: true,
                  gestureHandling: 'greedy',
                  clickableIcons: false,
                }}
                onClick={handleMapClick}
                onLoad={map => { mapRef.current = map; setMapReady(true); }}
              >
                {/* Boundary */}
                {boundary.length >= 3 && (
                  <Polygon
                    paths={[...boundary, boundary[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ fillColor: '#2F6B4F', fillOpacity: 0.06, strokeColor: '#FFFFFF', strokeWeight: 2, strokeOpacity: 0.8, clickable: false }}
                  />
                )}

                {/* Confirmed existing features */}
                {confirmedFeatures.filter(f => f.keep && f.vertices.length >= 3).map((f, i) => {
                  const color = f.type === 'house' ? '#C4935A' : '#2F6B4F';
                  return (
                    <Polyline key={`cf-${i}`}
                      path={[...f.vertices, f.vertices[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ strokeColor: color, strokeWeight: 2.5, strokeOpacity: 1, clickable: false }} />
                  );
                })}

                {/* Dashed outline for selected zone */}
                {selectedZone && (
                  <Polyline
                    path={[...selectedZone.lngLat, selectedZone.lngLat[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine('#FFFFFF', 2), clickable: false }}
                  />
                )}
              </GoogleMap>
            ) : (
              <div style={{ width: '100%', height: '100%', background: '#2A2A26' }} />
            )}

            {/* Move mode hint */}
            {moveMode && (
              <div className="absolute flex items-center gap-2 px-4 py-2.5 rounded-full"
                style={{ bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
                Click anywhere on the map to move "{selectedZone?.label}"
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
