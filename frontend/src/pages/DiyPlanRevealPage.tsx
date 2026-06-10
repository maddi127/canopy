import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon, Polyline, Circle } from '@react-google-maps/api';
import Logo from '../components/Logo';
import { deriveCandidates } from '../services/candidateDerivationService';
import { selectTemplate } from '../services/templateSelectionService';
import { executeStage1 } from '../services/stage1ExecutionService';
import type { S1Plan, S1Bed, S1Object } from '../types/stage1Plan';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';
import type { SunCell } from '../services/sunModelingService';

// ── Constants ─────────────────────────────────────────────────────────────────

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const IT = "'Inter Tight', sans-serif";

const GROUND_FILL: Record<string, { color: string; opacity: number }> = {
  lawn:                { color: '#5A9E62', opacity: 0.28 },
  gravel:              { color: '#B0A890', opacity: 0.28 },
  decomposed_granite:  { color: '#C4A882', opacity: 0.28 },
  mulch:               { color: '#8B5E3C', opacity: 0.25 },
  planted_groundcover: { color: '#5A9E62', opacity: 0.30 },
};

const BTN_PRIMARY = {
  background: '#2A2A26', color: '#efe9db', border: 'none', borderRadius: 999,
  padding: '10px 22px', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500,
  cursor: 'pointer' as const, whiteSpace: 'nowrap' as const,
};
const BTN_SECONDARY = {
  background: '#E8E0D0', color: '#2A2A26', border: 'none', borderRadius: 999,
  padding: '10px 16px', fontFamily: IT, fontSize: '0.88rem',
  cursor: 'pointer' as const, whiteSpace: 'nowrap' as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJSON<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toLatLng(c: [number, number]): google.maps.LatLngLiteral {
  return { lat: c[1], lng: c[0] };
}
function toPath(ring: [number, number][]): google.maps.LatLngLiteral[] {
  return ring.map(toLatLng);
}
function centroidOf(verts: [number, number][]): [number, number] {
  if (!verts.length) return [0, 0];
  return [
    verts.reduce((s, v) => s + v[0], 0) / verts.length,
    verts.reduce((s, v) => s + v[1], 0) / verts.length,
  ] as [number, number];
}

function bedColor(sig: string): string {
  if (sig === 'modern_minimal')    return '#8CA578';
  if (sig === 'whimsical_layered') return '#4E8A58';
  if (sig === 'desert_sparse')     return '#B99E70';
  if (sig === 'formal_repeated')   return '#3C6446';
  return '#6E9164';
}

function hardscapeColor(surface: string): string {
  const s = surface.toLowerCase();
  if (s.includes('paver'))                                                        return '#A5A094';
  if (s.includes('flagstone') || (s.includes('brick') && !s.includes('stained'))) return '#9B8C6C';
  if (s.includes('gravel') || s.includes('stepping'))                             return '#B0A488';
  if (s.includes('granite') || s.includes('decomposed'))                          return '#C4A870';
  if (s.includes('concrete'))                                                      return '#A8A898';
  if (s.includes('mixed'))                                                         return '#A8947A';
  return '#A0978A';
}

function objectFill(type: string): { color: string; opacity: number } {
  if (type === 'water_feature' || type === 'water')   return { color: '#4A8FB5', opacity: 0.75 };
  if (type === 'storage_shed'  || type === 'storage') return { color: '#8A7A6A', opacity: 0.75 };
  return { color: '#9A8870', opacity: 0.70 };
}

// ── Element meta ──────────────────────────────────────────────────────────────

type ElementKind = 'activity' | 'tree' | 'path' | 'bed' | 'object' | 'zone';
interface ElementInfo { kind: ElementKind; label: string; centroid: [number, number]; }

function getElementInfo(id: string, plan: S1Plan): ElementInfo | null {
  const a = plan.activities.find(x => x.id === id);
  if (a) {
    const m: Record<string, string> = { seating: 'Seating area', dining: 'Dining area', cooking: 'Cooking area' };
    return { kind: 'activity', label: m[a.type] ?? a.type.replace(/_/g, ' '), centroid: centroidOf(a.geometry) };
  }
  const t = plan.trees.find(x => x.id === id);
  if (t) {
    const m: Record<string, string> = { anchor_tree: 'Anchor tree', framing_tree: 'Framing tree', specimen_plant: 'Specimen plant' };
    return { kind: 'tree', label: m[t.role] ?? t.role.replace(/_/g, ' '), centroid: t.position };
  }
  const p = plan.paths.find(x => x.id === id);
  if (p) {
    const idx = Math.floor(p.geometry.length / 2);
    const mid = (p.geometry[idx] ?? p.geometry[0] ?? [0, 0]) as [number, number];
    return { kind: 'path', label: 'Path', centroid: mid };
  }
  const b = plan.beds.find(x => x.id === id);
  if (b) {
    const m: Record<S1Bed['source'], string> = {
      foundation: 'Foundation bed', perimeter: 'Perimeter bed',
      tree_underplant: 'Tree underplanting', veg: 'Vegetable garden', hardscape_edge: 'Bed',
    };
    return { kind: 'bed', label: m[b.source] ?? 'Bed', centroid: centroidOf(b.geometry) };
  }
  const o = plan.objects.find(x => x.id === id);
  if (o) {
    const label = o.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { kind: 'object', label, centroid: o.geometry.length > 0 ? centroidOf(o.geometry) : [0, 0] };
  }
  const z = plan.zones.find(x => x.id === id);
  if (z) {
    const label = z.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { kind: 'zone', label, centroid: centroidOf(z.geometry) };
  }
  return null;
}

function editActionsFor(kind: ElementKind): Array<{ label: string; stub: boolean }> {
  switch (kind) {
    case 'activity': return [
      { label: 'Remove', stub: false }, { label: 'Move', stub: true },
      { label: 'Resize', stub: true },  { label: 'Swap type', stub: true },
    ];
    case 'tree':   return [{ label: 'Remove', stub: false }, { label: 'Move', stub: true }, { label: 'Change size', stub: true }];
    case 'path':   return [{ label: 'Remove', stub: false }, { label: 'Re-route', stub: true }];
    case 'bed':    return [{ label: 'Remove', stub: false }];
    case 'object': return [{ label: 'Remove', stub: false }, { label: 'Move', stub: true }];
    case 'zone':   return [{ label: 'Remove', stub: false }];
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DiyPlanRevealPage() {
  const navigate   = useNavigate();
  const mapRef     = useRef<google.maps.Map | null>(null);
  const mountedRef = useRef(true);
  const tooltipSeenRef = useRef(false);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const alreadySeen = localStorage.getItem('diyPlanRevealSeen') === '1';

  const [loadPhase,   setLoadPhase]   = useState<'loading' | 'done' | 'error'>('loading');
  const [longDelay,   setLongDelay]   = useState(false);
  const [localPlan,   setLocalPlan]   = useState<S1Plan | null>(null);
  const [revealStage, setRevealStage] = useState<number>(alreadySeen ? 6 : 0);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [warningsOpen,   setWarningsOpen]   = useState(false);
  const [warningsViewed, setWarningsViewed] = useState(false);
  const [showTooltip,    setShowTooltip]    = useState(false);
  const [confirmFwd,     setConfirmFwd]     = useState(false);

  // Boundary verts
  const boundaryVerts = useMemo<[number, number][]>(() => {
    return safeJSON<{ ring?: [number, number][] }>(localStorage.getItem('diyBoundary'), {}).ring ?? [];
  }, []);

  const mapCenter = useMemo<google.maps.LatLngLiteral>(() => {
    if (!boundaryVerts.length) return { lat: 37.7749, lng: -122.4194 };
    const [lng, lat] = centroidOf(boundaryVerts);
    return { lat, lng };
  }, [boundaryVerts]);

  // Pipeline
  useEffect(() => {
    mountedRef.current = true;
    const delayTimer = setTimeout(() => { if (mountedRef.current) setLongDelay(true); }, 10000);

    (async () => {
      try {
        const bd      = safeJSON<{ ring?: [number, number][]; areaSqFt?: number }>(localStorage.getItem('diyBoundary'), {});
        const prefs   = safeJSON<{ style?: string; space_usage?: string[] }>(localStorage.getItem('userPreferences'), {});
        const sc      = safeJSON<{ yard_type?: string }>(localStorage.getItem('siteContext'), {});
        const sunData = safeJSON<{ cells?: SunCell[] }>(localStorage.getItem('diySunModel'), {});
        const features = safeJSON<ConfirmedFeature[]>(localStorage.getItem('diyConfirmedFeatures'), []);

        const boundaryVerts: [number, number][]  = bd.ring ?? [];
        const yardAreaSqFt: number               = bd.areaSqFt ?? 0;
        const selectedFeatures: string[]         = prefs.space_usage ?? [];
        const stylePreference: string | undefined = prefs.style || undefined;
        const yardType: 'front' | 'back'         = sc.yard_type === 'front' ? 'front' : 'back';
        const sunCells: SunCell[]                = sunData?.cells ?? [];

        console.group('[PlanReveal] Site inputs');
        console.log('boundary verts (%d pts):', boundaryVerts.length, boundaryVerts);
        console.log('yardAreaSqFt:', yardAreaSqFt, '  yardType:', yardType);
        console.log('selectedFeatures:', selectedFeatures, '  style:', stylePreference);
        console.log('sunCells:', sunCells.length);
        console.log('confirmedFeatures (%d):', features.length);
        features.forEach(f => {
          console.log(`  [${f.type}] id=${f.id} keep=${f.keep} verts:`, f.vertices);
        });
        console.groupEnd();

        const candidates = deriveCandidates({
          boundaryVerts, features, sunCells,
          requestedFeatures: selectedFeatures,
          yardType, doorPoint: null, frontEdgeMidpoint: null,
        });
        const templateInstance = selectTemplate({ stylePreference, selectedFeatures, yardAreaSqFt });
        const plan = executeStage1({
          boundaryVerts, features, sunCells, candidates, templateInstance,
          selectedFeatures, yardType, yardAreaSqFt,
          doorPoint: null, frontEdgeMidpoint: null,
        });

        clearTimeout(delayTimer);
        if (!mountedRef.current) return;
        setLocalPlan(plan);
        setLoadPhase('done');
      } catch {
        clearTimeout(delayTimer);
        if (mountedRef.current) setLoadPhase('error');
      }
    })();

    return () => { mountedRef.current = false; clearTimeout(delayTimer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reveal animation
  useEffect(() => {
    if (loadPhase !== 'done' || alreadySeen) return;
    const adv = (n: number) => setRevealStage(p => Math.max(p, n));
    const ts = [
      setTimeout(() => adv(1), 50),
      setTimeout(() => adv(2), 400),
      setTimeout(() => adv(3), 900),
      setTimeout(() => adv(4), 1300),
      setTimeout(() => adv(5), 1600),
      setTimeout(() => adv(6), 2000),
      setTimeout(() => localStorage.setItem('diyPlanRevealSeen', '1'), 2400),
    ];
    return () => ts.forEach(clearTimeout);
  }, [loadPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handlers
  const handleMapClick = useCallback(() => {
    if (revealStage < 6) {
      setRevealStage(6);
      localStorage.setItem('diyPlanRevealSeen', '1');
      return;
    }
    setSelectedId(null);
    setShowTooltip(false);
    setConfirmFwd(false);
  }, [revealStage]);

  const handleSelect = useCallback((id: string, kind: ElementKind) => {
    setSelectedId(id);
    setConfirmFwd(false);
    if (kind === 'tree' && !tooltipSeenRef.current) setShowTooltip(true);
  }, []);

  const handleRemove = useCallback((id: string) => {
    setLocalPlan(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        activities: prev.activities.filter(a => a.id !== id),
        trees:      prev.trees.filter(t => t.id !== id),
        paths:      prev.paths.filter(p => p.id !== id),
        beds:       prev.beds.filter(b => b.id !== id),
        objects:    prev.objects.filter(o => o.id !== id),
        zones:      prev.zones.filter(z => z.id !== id),
      };
    });
    setSelectedId(null);
  }, []);

  const handleForward = useCallback(() => {
    if (localPlan && localPlan.warnings.length > 0 && !warningsViewed && !confirmFwd) {
      setConfirmFwd(true);
      return;
    }
    navigate('/diy/plan');
  }, [localPlan, warningsViewed, confirmFwd, navigate]);

  const centerOnElement = useCallback((id: string) => {
    if (!localPlan || !mapRef.current) return;
    const info = getElementInfo(id, localPlan);
    if (!info) return;
    const [lng, lat] = info.centroid;
    mapRef.current.panTo({ lat, lng });
    setSelectedId(id);
    setWarningsOpen(false);
  }, [localPlan]);

  // Derived
  const selInfo = useMemo<ElementInfo | null>(
    () => (selectedId !== null && localPlan) ? getElementInfo(selectedId, localPlan) : null,
    [selectedId, localPlan],
  );

  // Opacity helper — dims non-selected elements when something is selected
  const fo = useCallback((base: number, id: string) =>
    selectedId !== null && id !== selectedId ? base * 0.5 : base,
  [selectedId]);

  // Stroke override for selected
  const selStroke = useCallback((id: string, defaultColor: string, defaultWeight: number) => ({
    strokeColor:   id === selectedId ? '#FFFFFF' : defaultColor,
    strokeWeight:  id === selectedId ? 2.5 : defaultWeight,
    strokeOpacity: id === selectedId ? 1.0 : 0.45,
  }), [selectedId]);

  // ── Error state ──────────────────────────────────────────────────────────────

  if (loadPhase === 'error') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#efe9db', gap: 16 }}>
        <p style={{ fontFamily: IT, fontSize: '1rem', color: '#2A2A26', margin: 0 }}>We couldn't generate a plan for this yard.</p>
        <button onClick={() => navigate('/diy/preferences')} style={BTN_PRIMARY}>Start over</button>
      </div>
    );
  }

  // Precompute derived colors so JSX stays clean
  const gf         = localPlan ? (GROUND_FILL[localPlan.groundFill] ?? GROUND_FILL.mulch) : GROUND_FILL.mulch;
  const activeBed  = localPlan ? bedColor(localPlan.plantingSignature) : '#6E9164';
  const activeHard = localPlan ? hardscapeColor(localPlan.hardscapeStyle.surface_default) : '#A0978A';

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>

      {/* ── Map canvas ── */}
      {isLoaded && (
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={mapCenter}
          zoom={20}
          options={{
            mapTypeId: 'satellite',
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: false,
            zoomControl: true,
            gestureHandling: 'greedy',
            clickableIcons: false,
          }}
          onLoad={m => { mapRef.current = m; }}
          onClick={() => handleMapClick()}
        >
          {/* Boundary outline — always visible */}
          {boundaryVerts.length >= 3 && (
            <Polygon
              paths={toPath(boundaryVerts)}
              options={{ fillOpacity: 0, strokeColor: '#C77C5B', strokeWeight: 2, strokeOpacity: 1, clickable: false }}
            />
          )}

          {/* Ground fill */}
          {localPlan && revealStage >= 1 && boundaryVerts.length >= 3 && (
            <Polygon
              paths={toPath(boundaryVerts)}
              options={{ fillColor: gf.color, fillOpacity: gf.opacity, strokeOpacity: 0, clickable: false }}
            />
          )}

          {/* Beds */}
          {localPlan && revealStage >= 2 && localPlan.beds.map(bed => (
            <Polygon
              key={bed.id}
              paths={toPath(bed.geometry)}
              options={{
                fillColor: activeBed,
                fillOpacity: fo(0.55, bed.id),
                ...selStroke(bed.id, 'transparent', 0),
                clickable: true,
              }}
              onClick={() => handleSelect(bed.id, 'bed')}
            />
          ))}

          {/* Hardscape pads (activities) */}
          {localPlan && revealStage >= 3 && localPlan.activities.map(act => (
            <Polygon
              key={act.id}
              paths={toPath(act.geometry)}
              options={{
                fillColor: activeHard,
                fillOpacity: fo(0.65, act.id),
                ...selStroke(act.id, '#888880', 1),
                clickable: true,
              }}
              onClick={() => handleSelect(act.id, 'activity')}
            />
          ))}

          {/* Paths */}
          {localPlan && revealStage >= 4 && localPlan.paths.map(path => (
            <Polyline
              key={path.id}
              path={path.geometry.map(c => toLatLng(c as [number, number]))}
              options={{
                strokeColor:   path.id === selectedId ? '#FFFFFF' : '#A5A094',
                strokeWeight:  Math.max(2, Math.round(path.widthFt * 0.5)),
                strokeOpacity: path.id === selectedId ? 1 : 0.70,
                clickable: true,
              }}
              onClick={() => handleSelect(path.id, 'path')}
            />
          ))}

          {/* Trees */}
          {localPlan && revealStage >= 5 && localPlan.trees.map(tree => (
            <Fragment key={tree.id}>
              <Circle
                center={toLatLng(tree.position)}
                radius={tree.canopyRadiusFt * 0.3048}
                options={{
                  fillColor:    '#3C7846',
                  fillOpacity:  fo(0.45, tree.id),
                  strokeColor:  tree.id === selectedId ? '#FFFFFF' : '#2A5A36',
                  strokeWeight: tree.id === selectedId ? 2.5 : 1,
                  strokeOpacity: tree.id === selectedId ? 1 : 0.6,
                  clickable: true,
                }}
                onClick={() => handleSelect(tree.id, 'tree')}
              />
              <Circle
                center={toLatLng(tree.position)}
                radius={0.8}
                options={{ fillColor: '#2A5A36', fillOpacity: 0.85, strokeOpacity: 0, clickable: false }}
              />
            </Fragment>
          ))}

          {/* Objects */}
          {localPlan && revealStage >= 6 && localPlan.objects.map((obj: S1Object) => {
            const fill = objectFill(obj.type);
            const center: [number, number] = obj.geometry.length > 0 ? centroidOf(obj.geometry) : [0, 0];
            if (obj.geometry.length >= 3) {
              return (
                <Polygon
                  key={obj.id}
                  paths={toPath(obj.geometry)}
                  options={{
                    fillColor: fill.color,
                    fillOpacity: fo(fill.opacity, obj.id),
                    ...selStroke(obj.id, '#666660', 1),
                    clickable: true,
                  }}
                  onClick={() => handleSelect(obj.id, 'object')}
                />
              );
            }
            return (
              <Circle
                key={obj.id}
                center={toLatLng(center)}
                radius={1.5}
                options={{
                  fillColor: fill.color,
                  fillOpacity: fo(fill.opacity, obj.id),
                  strokeColor:  obj.id === selectedId ? '#FFFFFF' : '#666660',
                  strokeWeight: obj.id === selectedId ? 2.5 : 1,
                  strokeOpacity: obj.id === selectedId ? 1 : 0.5,
                  clickable: true,
                }}
                onClick={() => handleSelect(obj.id, 'object')}
              />
            );
          })}
        </GoogleMap>
      )}

      {/* ── Top chrome ── */}
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
        <Logo />
      </div>

      {/* Warnings badge */}
      {localPlan && localPlan.warnings.length > 0 && (
        <button
          onClick={() => { setWarningsOpen(true); setWarningsViewed(true); }}
          style={{
            position: 'absolute', top: 16, right: 16, zIndex: 10,
            background: '#C77C5B', color: '#fff', border: 'none', borderRadius: 999,
            padding: '5px 12px', fontFamily: IT, fontSize: '0.78rem', cursor: 'pointer',
          }}
        >
          ⚠ {localPlan.warnings.length}
        </button>
      )}

      {/* ── Debug: template info ── */}
      {localPlan && (
        <div style={{
          position: 'absolute', top: 52, right: 16, zIndex: 10,
          background: 'rgba(42,42,38,0.82)', color: '#efe9db',
          borderRadius: 10, padding: '8px 12px',
          fontFamily: IT, fontSize: '0.72rem', lineHeight: 1.6,
          maxWidth: 220,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{localPlan.templateId}</div>
          <div>ground: {localPlan.groundFill}</div>
          <div>activities: {localPlan.activities.length} · trees: {localPlan.trees.length}</div>
          <div>beds: {localPlan.beds.length} · objects: {localPlan.objects.length}</div>
          <div>paths: {localPlan.paths.length} · zones: {localPlan.zones.length}</div>
          {localPlan.warnings.length > 0 && (
            <div style={{ marginTop: 4, color: '#E8A882' }}>
              {localPlan.warnings.map((w, i) => <div key={i}>⚠ {w.message}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Mature-tree tooltip */}
      {showTooltip && (
        <div style={{
          position: 'absolute', bottom: 90, left: '50%', transform: 'translateX(-50%)',
          background: '#fff', borderRadius: 12, padding: '12px 16px',
          width: 'min(280px, calc(100vw - 48px))',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 20,
          fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', textAlign: 'center',
        }}>
          Trees are shown at mature size (~10 years). They'll be much smaller when you plant them.
          <button
            onClick={() => { setShowTooltip(false); tooltipSeenRef.current = true; }}
            style={{ display: 'block', margin: '10px auto 0', ...BTN_PRIMARY, fontSize: '0.8rem', padding: '6px 18px' }}
          >Got it</button>
        </div>
      )}

      {/* ── Bottom chrome ── */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15 }}>

        {/* Loading bar */}
        {loadPhase === 'loading' && (
          <div style={{ background: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 -2px 12px rgba(0,0,0,0.10)' }}>
            <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26', flex: 1 }}>
              {longDelay ? 'Still working — your yard has an interesting shape' : 'Designing your plan…'}
            </span>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#C77C5B', display: 'inline-block', animation: 'pr-pulse 1.2s ease-in-out infinite' }} />
            <style>{`@keyframes pr-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}`}</style>
          </div>
        )}

        {/* Edit sheet */}
        {loadPhase === 'done' && selectedId !== null && selInfo !== null && (
          <div style={{ background: '#fff', borderRadius: '20px 20px 0 0', padding: '12px 16px 28px', boxShadow: '0 -4px 20px rgba(0,0,0,0.12)' }}>
            <div style={{ width: 36, height: 4, background: '#D8D0C4', borderRadius: 2, margin: '0 auto 12px' }} />
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontFamily: IT, fontSize: '1rem', fontWeight: 600, color: '#2A2A26', flex: 1 }}>{selInfo.label}</span>
              <button
                onClick={() => { setSelectedId(null); setShowTooltip(false); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontSize: '1.3rem', lineHeight: 1, padding: '0 4px' }}
              >×</button>
            </div>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
              {editActionsFor(selInfo.kind).map(action => {
                const capturedId = selectedId;
                return (
                  <div key={action.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                    <button
                      onClick={() => { if (!action.stub && capturedId) handleRemove(capturedId); }}
                      style={{
                        background: action.stub ? '#E8E0D0' : '#2A2A26',
                        color: action.stub ? '#6A6A62' : '#efe9db',
                        border: 'none', borderRadius: 999, padding: '8px 18px',
                        fontFamily: IT, fontSize: '0.85rem',
                        cursor: action.stub ? 'default' : 'pointer', whiteSpace: 'nowrap',
                      }}
                    >{action.label}</button>
                    {action.stub && (
                      <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0A898' }}>coming soon</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CTA bar */}
        {loadPhase === 'done' && selectedId === null && (
          <div style={{ background: '#fff', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 -2px 12px rgba(0,0,0,0.10)' }}>
            {confirmFwd ? (
              <>
                <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', flex: 1 }}>Review warnings first?</span>
                <button
                  onClick={() => { setWarningsOpen(true); setWarningsViewed(true); setConfirmFwd(false); }}
                  style={BTN_SECONDARY}
                >View</button>
                <button onClick={() => navigate('/diy/plan')} style={BTN_PRIMARY}>Continue anyway</button>
              </>
            ) : (
              <>
                <div style={{ flex: 1 }}>
                  {localPlan && localPlan.warnings.length > 0 && !warningsViewed && (
                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92' }}>
                      ⚠ {localPlan.warnings.length} item{localPlan.warnings.length > 1 ? 's' : ''} couldn't be placed{' '}
                      <span
                        onClick={() => { setWarningsOpen(true); setWarningsViewed(true); }}
                        style={{ color: '#C77C5B', cursor: 'pointer', textDecoration: 'underline' }}
                      >View</span>
                    </span>
                  )}
                </div>
                <button onClick={handleForward} style={BTN_PRIMARY}>Next: Add plants →</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Warnings sheet ── */}
      {warningsOpen && localPlan && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20,
          background: '#fff', borderRadius: '20px 20px 0 0', padding: '12px 16px 32px',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.15)', maxHeight: '60vh', overflowY: 'auto',
        }}>
          <div style={{ width: 36, height: 4, background: '#D8D0C4', borderRadius: 2, margin: '0 auto 12px' }} />
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: IT, fontSize: '1rem', fontWeight: 600, color: '#2A2A26', flex: 1 }}>Plan notes</span>
            <button
              onClick={() => setWarningsOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontSize: '1.3rem', padding: '0 4px' }}
            >×</button>
          </div>
          {localPlan.warnings.map((w, i) => (
            <div
              key={i}
              onClick={() => { if (w.relatedElementId) centerOnElement(w.relatedElementId); }}
              style={{ padding: '10px 0', borderBottom: '1px solid #F0EAE0', cursor: w.relatedElementId ? 'pointer' : 'default' }}
            >
              <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', margin: 0 }}>{w.message}</p>
              {w.relatedElementId && (
                <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#C77C5B' }}>Tap to locate →</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
