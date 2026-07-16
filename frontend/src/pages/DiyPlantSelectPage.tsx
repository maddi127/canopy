import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import Logo from '../components/Logo';
import BackButton from '../components/BackButton';
import { runDiyPlantPlacement, type DiyPlantPlan, type BedRole } from '../services/diyPlantPlacementService';
import { fetchHardinessZone } from '../features/sun/hardinessZone';
import { getPlantDatabase } from '../services/plantDatabaseAdapter';
import type { DesignStyle } from '../types/plantTypes';
import type { SunCell } from '../services/sunModelingService';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

// ── Constants ──────────────────────────────────────────────────────────────────

import { IT, PAGE_BG } from '../lib/theme';

const GOOGLE_MAPS_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY ?? '';

const ROLE_LABELS: Record<BedRole, string> = {
  foundation:      'Foundation',
  perimeter:       'Perimeter',
  hardscape_edge:  'Hardscape edge',
  tree_underplant: 'Under tree',
  island:          'Island bed',
  mixed:           'Mixed',
};

const SUN_LABEL: Record<string, string> = {
  full_sun:   'Full sun',
  part_sun:   'Part sun',
  part_shade: 'Part shade',
  full_shade: 'Full shade',
};

const SPECIES_PALETTE = [
  '#F4C842', '#E87040', '#C84A6E', '#9B4EC4', '#4E7EE0',
  '#28B4A0', '#5AC84A', '#C8A028', '#E05890', '#40C8E0',
  '#8050D0', '#D07028',
];

const TREE_COLOR  = '#1A5C1A';
const SHRUB_ALPHA = { fill: 0.72, stroke: 0.85 };

const BED_ROLE_COLORS: Record<BedRole, string> = {
  foundation:      '#3A5C3A',
  perimeter:       '#5A7C4A',
  hardscape_edge:  '#7A9C6A',
  tree_underplant: '#2A4A2A',
  island:          '#4A6C3A',
  mixed:           '#6A8C5A',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function safeJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}

function toLatLng(v: [number, number]): google.maps.LatLngLiteral {
  return { lat: v[1], lng: v[0] };
}

function circlePath(lng: number, lat: number, radiusM: number, steps = 20): google.maps.LatLngLiteral[] {
  const latR = radiusM / 111320;
  const lngR = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return { lat: lat + latR * Math.sin(a), lng: lng + lngR * Math.cos(a) };
  });
}

function centroidOf(ring: [number, number][]): [number, number] {
  if (!ring.length) return [0, 0];
  return [
    ring.reduce((s, v) => s + v[0], 0) / ring.length,
    ring.reduce((s, v) => s + v[1], 0) / ring.length,
  ];
}

function buildColorMap(plantIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  [...new Set(plantIds)].forEach((id, i) => map.set(id, SPECIES_PALETTE[i % SPECIES_PALETTE.length]));
  return map;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DiyPlantSelectPage() {
  const navigate = useNavigate();

  const [plan,    setPlan]    = useState<DiyPlantPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [tab,     setTab]     = useState<'shrubs' | 'beds' | 'list'>('shrubs');
  const [hoveredPlantId, setHoveredPlantId] = useState<number | null>(null);

  const [boundaryVerts, setBoundaryVerts] = useState<[number, number][]>([]);
  const mapRef  = useRef<google.maps.Map | null>(null);
  const [mapInst, setMapInst] = useState<google.maps.Map | null>(null);
  const shrubCirclesRef = useRef<google.maps.Polygon[]>([]);

  const initialCenter = useMemo<google.maps.LatLngLiteral>(() => {
    const ring: [number, number][] = safeJSON<any>('diyBoundary', {}).ring ?? [];
    if (ring.length >= 3) { const c = centroidOf(ring); return { lat: c[1], lng: c[0] }; }
    const sc = safeJSON<any>('siteContext', {});
    if (sc.lat && sc.lng) return { lat: Number(sc.lat), lng: Number(sc.lng) };
    return { lat: 39.74, lng: -104.99 };
  }, []);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  // ── Load and compute ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function compute() {
      try {
        const bd        = safeJSON<any>('diyBoundary', {});
        const prefs     = safeJSON<any>('userPreferences', {});
        const sc        = safeJSON<any>('siteContext', {});
        const sunRaw    = safeJSON<any>('diySunModel', { cells: [] });
        const features  = safeJSON<ConfirmedFeature[]>('diyConfirmedFeatures', []);

        const ring: [number, number][] = bd.ring ?? [];
        const zones = bd.featureZones ?? [];
        const sunCells: SunCell[] = sunRaw.cells ?? [];
        const yardSide: 'front' | 'back' = sc.yard_type === 'front' ? 'front' : 'back';

        const LEGACY_STYLE: Record<string, DesignStyle> = {
          natural_wild: 'whimsical', modern_structured: 'modern',
          desert_minimal: 'desert',  traditional: 'traditional',
        };
        const style: DesignStyle = LEGACY_STYLE[prefs.style] ?? (prefs.style as DesignStyle) ?? 'traditional';

        console.log('[DiyPlants] ring:', ring.length, 'zones:', zones.length, 'style:', style, 'sunCells:', sunCells.length, 'yardSide:', yardSide);

        if (ring.length >= 3) setBoundaryVerts(ring);

        let hardinessZone = 7;
        if (sc.lat && sc.lng) {
          const hz = await fetchHardinessZone(sc.lat, sc.lng);
          if (hz?.zone_number) hardinessZone = hz.zone_number;
        }

        if (cancelled) return;

        const result = runDiyPlantPlacement({ boundaryVerts: ring, zones, confirmedFeatures: features, sunCells, style, hardinessZone, yardSide });

        console.log('[DiyPlants] beds:', result.beds.length, 'largeShrubs:', result.largeShrubs.length, 'trees:', result.trees.length,
          'purchaseList:', result.purchaseList.map(e => `${e.commonName}×${e.count}`));

        if (!cancelled) { setPlan(result); setLoading(false); }
      } catch (e) {
        console.error('[DiyPlants] compute error:', e);
        if (!cancelled) { setError('Could not compute plant plan.'); setLoading(false); }
      }
    }
    compute();
    return () => { cancelled = true; };
  }, []);

  // ── Derived data ───────────────────────────────────────────────────────────────

  const db     = useMemo(() => getPlantDatabase(), []);
  const dbById = useMemo(() => new Map(db.map(p => [p.id, p])), [db]);

  const colorMap = useMemo(
    () => plan ? buildColorMap(plan.largeShrubs.map(s => s.plantId)) : new Map<number, string>(),
    [plan],
  );

  const uniqueShrubSpecies = useMemo(() => {
    if (!plan) return [];
    const seen = new Set<number>();
    return plan.largeShrubs
      .filter(s => { if (seen.has(s.plantId)) return false; seen.add(s.plantId); return true; })
      .map(s => dbById.get(s.plantId))
      .filter(Boolean) as ReturnType<typeof dbById.get>[];
  }, [plan, dbById]);

  const totalPlants = plan ? plan.purchaseList.reduce((s, e) => s + e.count, 0) : 0;

  // ── Imperative shrub circle rendering ─────────────────────────────────────────
  // Using useEffect + new google.maps.Polygon to avoid Strict Mode double-mount bug.

  useEffect(() => {
    if (!mapInst || !plan || plan.largeShrubs.length === 0) return;
    const circles = plan.largeShrubs.map(shrub => {
      const color   = colorMap.get(shrub.plantId) ?? '#6A9A5A';
      const radiusM = Math.max(0.4, (shrub.matureWidthFt / 2) * 0.3048);
      return new google.maps.Polygon({
        paths: circlePath(shrub.lngLat[0], shrub.lngLat[1], radiusM),
        map:          mapInst,
        fillColor:    color,
        fillOpacity:  SHRUB_ALPHA.fill,
        strokeColor:  color,
        strokeWeight: 1.2,
        strokeOpacity: SHRUB_ALPHA.stroke,
        clickable:    false,
        zIndex:       3,
      });
    });
    shrubCirclesRef.current = circles;
    return () => { circles.forEach(c => c.setMap(null)); shrubCirclesRef.current = []; };
  }, [mapInst, plan, colorMap]);

  // Hover highlight
  useEffect(() => {
    if (!plan) return;
    shrubCirclesRef.current.forEach((circle, i) => {
      const shrub = plan.largeShrubs[i];
      if (!shrub) return;
      const color = colorMap.get(shrub.plantId) ?? '#6A9A5A';
      const isHov = hoveredPlantId === shrub.plantId;
      circle.setOptions({
        fillOpacity:  isHov ? 0.92 : SHRUB_ALPHA.fill,
        strokeColor:  isHov ? '#FFFFFF' : color,
        strokeWeight: isHov ? 2.0 : 1.2,
        strokeOpacity: isHov ? 1.0 : SHRUB_ALPHA.stroke,
        zIndex:       isHov ? 10 : 3,
      });
    });
  }, [hoveredPlantId, plan, colorMap]);

  // ── Loading / error states ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ backgroundColor: PAGE_BG }}>
        <div style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60' }}>Building your plant plan…</div>
        <div style={{ marginTop: 16, width: 32, height: 32, borderRadius: '50%', border: '3px solid #2A2A26', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ backgroundColor: PAGE_BG }}>
        <div style={{ fontFamily: IT, fontSize: '0.9rem', color: '#9A4A3A' }}>{error ?? 'Something went wrong.'}</div>
        <button onClick={() => navigate('/diy/boundary')}
          style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
          ← Back
        </button>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: PAGE_BG }}>

      {/* LEFT PANEL */}
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <Logo />
            <button onClick={() => navigate('/diy/boundary')}
              style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer' }}>
              ← Edit site
            </button>
          </div>
          <div style={{ fontFamily: IT, fontSize: '1.6rem', fontWeight: 600, color: '#2A2A26', lineHeight: 1.1, marginBottom: 4 }}>
            Plant plan
          </div>
          <div style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92' }}>
            {uniqueShrubSpecies.length} {uniqueShrubSpecies.length === 1 ? 'species' : 'species'} · {plan.beds.length} {plan.beds.length === 1 ? 'bed' : 'beds'} · {totalPlants} plants
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 6, padding: '0 24px 14px', flexShrink: 0 }}>
          {(['shrubs', 'beds', 'list'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, border: 'none',
                cursor: 'pointer', borderRadius: 999, padding: '5px 12px',
                background: tab === t ? '#2A2A26' : 'rgba(42,42,38,0.08)',
                color:      tab === t ? '#efe9db'  : '#6A6A60',
              }}>
              {t === 'shrubs' ? 'Shrubs' : t === 'beds' ? 'Beds' : 'List'}
            </button>
          ))}
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 100px' }}>

          {/* ── Shrubs tab ── */}
          {tab === 'shrubs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {uniqueShrubSpecies.length === 0 && (
                <div style={{ fontFamily: IT, fontSize: '0.85rem', color: '#9A9A92', paddingTop: 8 }}>
                  No large shrubs placed. Add planting beds in the boundary step.
                </div>
              )}
              {uniqueShrubSpecies.map(plant => {
                if (!plant) return null;
                const color   = colorMap.get(plant.id) ?? '#6A9A5A';
                const count   = plan.largeShrubs.filter(s => s.plantId === plant.id).length;
                const isHovered = hoveredPlantId === plant.id;
                return (
                  <div key={plant.id}
                    onMouseEnter={() => setHoveredPlantId(plant.id)}
                    onMouseLeave={() => setHoveredPlantId(null)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderRadius: 14,
                      background: isHovered ? 'rgba(42,42,38,0.08)' : '#fff',
                      boxShadow: '0 1px 3px rgba(42,42,38,0.06)',
                      cursor: 'default', transition: 'background 0.12s',
                    }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: color, flexShrink: 0, opacity: 0.9 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: IT, fontSize: '0.83rem', fontWeight: 600, color: '#2A2A26', marginBottom: 1 }}>
                        {plant.commonName}
                      </div>
                      <div style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {plant.botanicalName}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                      <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92' }}>{plant.matureHeightFt}ft · ×{count}</span>
                      <span style={{ fontFamily: IT, fontSize: '0.64rem', color: '#B0B0A6' }}>
                        {plant.sunRequirement.slice(0, 1).map(s => SUN_LABEL[s] ?? s)}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Trees */}
              {plan.trees.length > 0 && (
                <>
                  <div style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 8, marginBottom: 4 }}>
                    Trees
                  </div>
                  {plan.trees.map(ta => {
                    const rec = dbById.get(ta.plantId);
                    if (!rec) return null;
                    return (
                      <div key={ta.zoneId} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 12px', borderRadius: 14,
                        background: '#fff', boxShadow: '0 1px 3px rgba(42,42,38,0.06)',
                      }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: TREE_COLOR, flexShrink: 0, opacity: 0.8 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: IT, fontSize: '0.83rem', fontWeight: 600, color: '#2A2A26', marginBottom: 1 }}>
                            {rec.commonName}
                          </div>
                          <div style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontStyle: 'italic' }}>
                            {rec.botanicalName}
                          </div>
                        </div>
                        <Chip label={ta.source === 'confirmed_keep' ? 'Existing' : 'New'} />
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ── Beds tab ── */}
          {tab === 'beds' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {plan.beds.length === 0 && (
                <div style={{ fontFamily: IT, fontSize: '0.85rem', color: '#9A9A92', paddingTop: 8 }}>
                  No planting beds found. Add a planting bed in the boundary step.
                </div>
              )}
              {plan.beds.map((bed, i) => {
                const bedShrubs  = plan.largeShrubs.filter(s => s.bedId === bed.zoneId);
                const speciesIds = [...new Set(bedShrubs.map(s => s.plantId))];
                return (
                  <div key={bed.zoneId} style={{ borderRadius: 14, background: '#fff', boxShadow: '0 1px 3px rgba(42,42,38,0.06)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px', borderBottom: '1px solid rgba(42,42,38,0.05)' }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: BED_ROLE_COLORS[bed.role], flexShrink: 0 }} />
                      <span style={{ fontFamily: IT, fontSize: '0.82rem', fontWeight: 600, color: '#2A2A26', flex: 1 }}>
                        Bed {i + 1}
                      </span>
                      <Chip label={ROLE_LABELS[bed.role]} accent />
                    </div>
                    <div style={{ padding: '8px 12px' }}>
                      <div style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', marginBottom: 8 }}>
                        {Math.round(bed.areaSqFt)} sq ft · {SUN_LABEL[bed.sunClass] ?? bed.sunClass} · {bed.side} · {bedShrubs.length} shrubs
                      </div>
                      {speciesIds.length === 0
                        ? <div style={{ fontFamily: IT, fontSize: '0.75rem', color: '#C0C0B6' }}>No shrubs placed</div>
                        : speciesIds.map(pid => {
                          const rec = dbById.get(pid);
                          const cnt = bedShrubs.filter(s => s.plantId === pid).length;
                          const clr = colorMap.get(pid) ?? '#6A9A5A';
                          if (!rec) return null;
                          return (
                            <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, background: clr, flexShrink: 0 }} />
                              <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#4A4A40', flex: 1 }}>{rec.commonName}</span>
                              <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>×{cnt}</span>
                            </div>
                          );
                        })
                      }
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Shopping list tab ── */}
          {tab === 'list' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ borderRadius: 14, background: '#fff', boxShadow: '0 1px 3px rgba(42,42,38,0.06)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', padding: '8px 12px', borderBottom: '1px solid rgba(42,42,38,0.05)' }}>
                  <span style={{ fontFamily: IT, fontSize: '0.64rem', color: '#B0B0A6', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>Plant</span>
                  <span style={{ fontFamily: IT, fontSize: '0.64rem', color: '#B0B0A6', letterSpacing: '0.1em', textTransform: 'uppercase', width: 36, textAlign: 'right' }}>Qty</span>
                </div>
                {plan.purchaseList.map((entry, i) => (
                  <div key={entry.plantId} style={{
                    display: 'flex', alignItems: 'center', padding: '9px 12px',
                    borderBottom: i < plan.purchaseList.length - 1 ? '1px solid rgba(42,42,38,0.04)' : 'none',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: colorMap.get(entry.plantId) ?? '#6A9A5A', marginRight: 8, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, color: '#2A2A26' }}>{entry.commonName}</div>
                      <div style={{ fontFamily: IT, fontSize: '0.67rem', color: '#9A9A92', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.botanicalName}</div>
                    </div>
                    <div style={{ fontFamily: IT, fontSize: '0.9rem', fontWeight: 600, color: '#2A2A26', width: 36, textAlign: 'right' }}>{entry.count}</div>
                  </div>
                ))}
                {plan.purchaseList.length === 0 && (
                  <div style={{ padding: '24px 12px', textAlign: 'center', fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92' }}>
                    Draw planting beds in the boundary step first.
                  </div>
                )}
              </div>
              {plan.purchaseList.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 14, background: 'rgba(42,42,38,0.07)' }}>
                  <span style={{ fontFamily: IT, fontSize: '0.82rem', fontWeight: 600, color: '#2A2A26' }}>Total</span>
                  <span style={{ fontFamily: IT, fontSize: '0.95rem', fontWeight: 700, color: '#2A2A26' }}>{totalPlants}</span>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer CTAs */}
        <div style={{
          padding: '14px 24px 20px', flexShrink: 0,
          borderTop: '1px solid rgba(42,42,38,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <BackButton onClick={() => navigate('/diy/boundary')} />
          <button onClick={() => navigate('/diy/plan-reveal')}
            style={{
              fontFamily: IT, fontSize: '0.85rem', fontWeight: 500,
              background: '#2A2A26', color: '#efe9db', border: 'none',
              borderRadius: 999, padding: '10px 22px', cursor: 'pointer',
            }}>
            See full plan →
          </button>
        </div>
      </div>

      {/* RIGHT PANEL — map */}
      <div style={{ flex: 1, position: 'relative' }}>
        {isLoaded ? (
          <GoogleMap
            mapContainerStyle={{ width: '100%', height: '100%' }}
            center={initialCenter}
            zoom={20}
            onLoad={(map) => { mapRef.current = map; setMapInst(map); }}
            options={{ mapTypeId: 'satellite', disableDefaultUI: true, gestureHandling: 'greedy', clickableIcons: false }}
          >
            {/* Boundary outline */}
            {boundaryVerts.length >= 3 && (
              <Polygon
                paths={[...boundaryVerts, boundaryVerts[0]].map(toLatLng)}
                options={{ fillColor: '#FFFFFF', fillOpacity: 0.04, strokeColor: '#FFFFFF', strokeWeight: 2, strokeOpacity: 0.7, clickable: false }}
              />
            )}

            {/* Bed zone fills */}
            {plan.beds.filter(bed => bed.vertices.length >= 3).map(bed => (
              <Polygon
                key={bed.zoneId}
                paths={[...bed.vertices, bed.vertices[0]].map(toLatLng)}
                options={{
                  fillColor: BED_ROLE_COLORS[bed.role], fillOpacity: 0.18,
                  strokeColor: BED_ROLE_COLORS[bed.role], strokeWeight: 1, strokeOpacity: 0.5,
                  clickable: false,
                }}
              />
            ))}

            {/* Shrub circles rendered imperatively via useEffect */}

            {/* Tree circles */}
            {plan.trees.map(ta => {
              const rec     = dbById.get(ta.plantId);
              const radiusM = rec ? Math.max(1.5, (rec.matureWidthFt / 2) * 0.3048) : 1.5;
              return (
                <Polygon
                  key={`tree_${ta.zoneId}`}
                  paths={circlePath(ta.centerLngLat[0], ta.centerLngLat[1], radiusM)}
                  options={{ fillColor: TREE_COLOR, fillOpacity: 0.55, strokeColor: '#FFFFFF', strokeWeight: 1, strokeOpacity: 0.6, clickable: false, zIndex: 5 }}
                />
              );
            })}
          </GoogleMap>
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#2A3A2A' }} />
        )}

        {/* Map legend */}
        {(uniqueShrubSpecies.length > 0 || plan.trees.length > 0) && (
          <div style={{
            position: 'absolute', bottom: 20, right: 20,
            background: 'rgba(20,20,16,0.82)', backdropFilter: 'blur(6px)',
            borderRadius: 14, padding: '10px 14px',
            maxWidth: 200, maxHeight: 280, overflowY: 'auto',
          }}>
            <div style={{ fontFamily: IT, fontSize: '0.62rem', color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
              Legend
            </div>
            {uniqueShrubSpecies.map(plant => {
              if (!plant) return null;
              return (
                <div key={plant.id}
                  onMouseEnter={() => setHoveredPlantId(plant.id)}
                  onMouseLeave={() => setHoveredPlantId(null)}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, cursor: 'default' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: colorMap.get(plant.id) ?? '#6A9A5A', flexShrink: 0 }} />
                  <span style={{ fontFamily: IT, fontSize: '0.72rem', color: hoveredPlantId === plant.id ? '#FFFFFF' : 'rgba(255,255,255,0.75)', lineHeight: 1.2 }}>
                    {plant.commonName}
                  </span>
                </div>
              );
            })}
            {plan.trees.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: TREE_COLOR, flexShrink: 0, border: '1px solid rgba(255,255,255,0.3)' }} />
                <span style={{ fontFamily: IT, fontSize: '0.72rem', color: 'rgba(255,255,255,0.75)' }}>Trees</span>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────

function Chip({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span style={{
      fontFamily: IT, fontSize: '0.65rem', fontWeight: 500,
      borderRadius: 999, padding: '2px 7px',
      background: accent ? 'rgba(74,124,89,0.14)' : 'rgba(42,42,38,0.07)',
      color:      accent ? '#2A6A3A'              : '#6A6A60',
    }}>
      {label}
    </span>
  );
}
