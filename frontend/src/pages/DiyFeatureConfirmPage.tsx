import { useState, useRef, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon as GPolygon, Polyline as GPolyline, Marker as GMarker } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';

function toPath(coords: number[][]): google.maps.LatLngLiteral[] {
  return coords.map(c => ({ lat: c[1], lng: c[0] }));
}

function dashedLine(color: string, weight = 2): google.maps.PolylineOptions {
  return {
    strokeOpacity: 0, strokeWeight: weight, clickable: false,
    icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: weight, strokeColor: color }, offset: '0', repeat: '10px' }],
  };
}

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

type Phase    = 'review' | 'add';
type AddMode  = 'tree' | 'hardscape' | 'structure' | null;
type TreeStep = 'placing' | 'sizing' | 'attributes';
type PolyStep = 'drawing' | 'attributes';

export interface ConfirmedFeature {
  id: string;
  type: 'house' | 'tree' | 'hardscape' | 'structure';
  keep: boolean;
  source: 'detected' | 'added';
  vertices: [number, number][];
  confidence?: number;
  label: string;
  attributes: {
    isDeciduous?: boolean;
    heightM?: number;
    surfaceType?: string;
  };
}

const SURFACE_TYPES = [
  'Concrete', 'Pavers', 'Gravel', 'Asphalt', 'Wood / Deck', 'Flagstone', 'Other',
];

const TREE_HEIGHTS = [
  { label: 'S', sub: '<5m',   value: 4   },
  { label: 'M', sub: '5–10m', value: 7.5 },
  { label: 'L', sub: '>10m',  value: 14  },
];

export default function DiyFeatureConfirmPage() {
  const navigate = useNavigate();
  const mapRef   = useRef<google.maps.Map | null>(null);
  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  // ── Load context ──────────────────────────────────────────────────────────────
  const sc = useMemo<any>(() => {
    try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; }
  }, []);

  const boundaryVerts = useMemo<[number, number][]>(() => {
    try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.ring ?? []; } catch { return []; }
  }, []);

  const mapCenter: [number, number] = useMemo(() => {
    if (boundaryVerts.length >= 3) {
      try {
        const c = turf.centroid(turf.polygon([[...boundaryVerts, boundaryVerts[0]]]));
        return c.geometry.coordinates as [number, number];
      } catch {}
    }
    return [sc.lng ?? -104.99, sc.lat ?? 39.74];
  }, [boundaryVerts, sc]);

  // ── Features ──────────────────────────────────────────────────────────────────
  const detectedFeatures: ConfirmedFeature[] = useMemo(() => {
    try { const r = localStorage.getItem('diyDetectedFeatures'); return r ? JSON.parse(r) : []; }
    catch { return []; }
  }, []);

  const [features, setFeatures] = useState<ConfirmedFeature[]>(() => {
    try {
      const saved = localStorage.getItem('diyConfirmedFeatures');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [...detectedFeatures];
  });

  useEffect(() => {
    localStorage.setItem('diyConfirmedFeatures', JSON.stringify(features));
  }, [features]);

  // ── Phase ─────────────────────────────────────────────────────────────────────
  // House footprint is handled in DiyBoundaryPage — always start at review or add.
  const [phase, setPhase] = useState<Phase>(() => {
    const detected: ConfirmedFeature[] = (() => {
      try { return JSON.parse(localStorage.getItem('diyDetectedFeatures') ?? 'null') ?? []; } catch { return []; }
    })();
    return detected.length > 0 ? 'review' : 'add';
  });


  // ── Phase A (review detected features) ───────────────────────────────────────
  const reviewQueue = useMemo(() => features.filter(f => f.source === 'detected'), [features]);
  const [queueIdx, setQueueIdx] = useState(0);
  const currentReview = reviewQueue[queueIdx] ?? null;

  useEffect(() => {
    if (phase !== 'review' || !currentReview || !mapRef.current) return;
    try {
      const bb = turf.bbox(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]]));
      mapRef.current.fitBounds(
        new google.maps.LatLngBounds({ lat: bb[1], lng: bb[0] }, { lat: bb[3], lng: bb[2] }), 140,
      );
    } catch {}
  }, [queueIdx, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveFeature = useCallback((id: string, decision: 'keep' | 'remove' | 'not_real') => {
    setFeatures(prev =>
      decision === 'not_real'
        ? prev.filter(f => f.id !== id)
        : prev.map(f => f.id === id ? { ...f, keep: decision === 'keep' } : f),
    );
    setQueueIdx(i => {
      const next = i + 1;
      if (next >= reviewQueue.length) { setPhase('add'); return next; }
      return next;
    });
  }, [reviewQueue.length]);

  // ── Phase B (add features) ────────────────────────────────────────────────────
  const [addMode,        setAddMode]        = useState<AddMode>(null);
  const [mousePos,       setMousePos]       = useState<[number, number] | null>(null);
  const [treeStep,       setTreeStep]       = useState<TreeStep>('placing');
  const [treeCenter,     setTreeCenter]     = useState<[number, number] | null>(null);
  const [treeRadiusKm,   setTreeRadiusKm]   = useState<number>(0);
  const [treeDeciduous,  setTreeDeciduous]  = useState<boolean | null>(null);
  const [treeHeightM,    setTreeHeightM]    = useState<number | null>(null);
  const [polyStep,       setPolyStep]       = useState<PolyStep>('drawing');
  const [polyVerts,      setPolyVerts]      = useState<[number, number][]>([]);
  const [selectedSurface,setSelectedSurface]= useState('');
  const [structureLabel, setStructureLabel] = useState('');

  const resetDrawing = useCallback(() => {
    setTreeStep('placing'); setTreeCenter(null); setTreeRadiusKm(0);
    setTreeDeciduous(null); setTreeHeightM(null);
    setPolyStep('drawing'); setPolyVerts([]); setSelectedSurface(''); setStructureLabel('');
  }, []);
  const cancelAdd = useCallback(() => { resetDrawing(); setAddMode(null); }, [resetDrawing]);
  const startAdd  = useCallback((mode: AddMode) => { resetDrawing(); setAddMode(mode); }, [resetDrawing]);

  // ── Phase A editing ───────────────────────────────────────────────────────────
  const editCenterRef = useRef<{ origCenter: [number, number]; origVerts: [number, number][] } | null>(null);
  const origVertsRef  = useRef<[number, number][]>([]);

  const updateCurrentFeature = useCallback((updater: (f: ConfirmedFeature) => ConfirmedFeature) => {
    if (!currentReview) return;
    setFeatures(prev => prev.map(f => f.id === currentReview.id ? updater(f) : f));
  }, [currentReview]);

  const activeTreeInfo = useMemo(() => {
    if (phase !== 'review' || !currentReview || currentReview.type !== 'tree') return null;
    const verts = currentReview.vertices;
    if (verts.length < 3) return null;
    try {
      const center = turf.centroid(turf.polygon([[...verts, verts[0]]])).geometry.coordinates as [number, number];
      const radius = turf.distance(turf.point(center), turf.point(verts[0]), { units: 'kilometers' });
      const edgeVert = verts.reduce((best, v) => v[0] > best[0] ? v : best, verts[0]);
      return { center, radius, edgeVert };
    } catch { return null; }
  }, [phase, currentReview]);

  const activeFeatureCenter = useMemo(() => {
    if (phase !== 'review' || !currentReview || currentReview.vertices.length < 3) return null;
    if (activeTreeInfo) return activeTreeInfo.center;
    try {
      return turf.centroid(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]])).geometry.coordinates as [number, number];
    } catch { return null; }
  }, [phase, currentReview, activeTreeInfo]);

  const handleCenterDrag = useCallback((e: google.maps.MapMouseEvent) => {
    const drag = editCenterRef.current;
    if (!drag || !e.latLng) return;
    const dLng = e.latLng.lng() - drag.origCenter[0];
    const dLat = e.latLng.lat() - drag.origCenter[1];
    updateCurrentFeature(f => ({ ...f, vertices: drag.origVerts.map(v => [v[0] + dLng, v[1] + dLat] as [number, number]) }));
  }, [updateCurrentFeature]);

  const handleEdgeDrag = useCallback((e: google.maps.MapMouseEvent) => {
    if (!activeTreeInfo || !e.latLng) return;
    const { center } = activeTreeInfo;
    const newRadius = turf.distance(turf.point(center), turf.point([e.latLng.lng(), e.latLng.lat()]), { units: 'kilometers' });
    if (newRadius < 0.001) return;
    try {
      const ring = (turf.circle(center, newRadius, { steps: 32, units: 'kilometers' }).geometry.coordinates[0] as [number, number][]).slice(0, -1);
      updateCurrentFeature(f => ({ ...f, vertices: ring }));
    } catch {}
  }, [activeTreeInfo, updateCurrentFeature]);

  const handleVertexDrag = useCallback((e: google.maps.MapMouseEvent, idx: number) => {
    const orig = origVertsRef.current;
    if (!orig.length || !e.latLng) return;
    updateCurrentFeature(f => ({
      ...f,
      vertices: orig.map((v, i) => i === idx ? [e.latLng!.lng(), e.latLng!.lat()] as [number, number] : v),
    }));
  }, [updateCurrentFeature]);

  const confirmTree = useCallback(() => {
    if (!treeCenter || treeRadiusKm < 0.0005 || treeDeciduous === null) return;
    const ring = (turf.circle(treeCenter, treeRadiusKm, { steps: 48, units: 'kilometers' }).geometry.coordinates[0] as [number, number][]).slice(0, -1);
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'tree', keep: true, source: 'added',
      vertices: ring, label: 'Tree',
      attributes: { isDeciduous: treeDeciduous, heightM: treeHeightM ?? 7.5 },
    }]);
    cancelAdd();
  }, [treeCenter, treeRadiusKm, treeDeciduous, treeHeightM, cancelAdd]);

  const confirmHardscape = useCallback(() => {
    if (polyVerts.length < 3 || !selectedSurface) return;
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'hardscape', keep: true, source: 'added',
      vertices: polyVerts, label: `Hardscape — ${selectedSurface}`,
      attributes: { surfaceType: selectedSurface },
    }]);
    cancelAdd();
  }, [polyVerts, selectedSurface, cancelAdd]);

  const confirmStructure = useCallback(() => {
    if (polyVerts.length < 3) return;
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'structure', keep: true, source: 'added',
      vertices: polyVerts, label: structureLabel.trim() || 'Structure',
      attributes: {},
    }]);
    cancelAdd();
  }, [polyVerts, structureLabel, cancelAdd]);

  // ── GeoJSON memos ─────────────────────────────────────────────────────────────
  const boundaryGeoJSON = useMemo(() => {
    if (boundaryVerts.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...boundaryVerts, boundaryVerts[0]]] } };
  }, [boundaryVerts]);

  const pendingIds     = useMemo(() => new Set(reviewQueue.slice(queueIdx + 1).map(f => f.id)), [reviewQueue, queueIdx]);
  const activeId       = currentReview?.id ?? null;

  const keepGeoJSON    = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features.filter(f => f.keep && f.vertices.length >= 3 && f.id !== activeId && !pendingIds.has(f.id)).map(f => ({
      type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] },
    })),
  }), [features, activeId, pendingIds]);

  const removeGeoJSON  = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features.filter(f => !f.keep && f.vertices.length >= 3 && f.id !== activeId && !pendingIds.has(f.id)).map(f => ({
      type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] },
    })),
  }), [features, activeId, pendingIds]);

  const pendingGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: reviewQueue.slice(queueIdx + 1).filter(f => f.vertices.length >= 3).map(f => ({
      type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] },
    })),
  }), [reviewQueue, queueIdx]);

  const queueGeoJSON   = useMemo(() => {
    if (!currentReview || currentReview.vertices.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...currentReview.vertices, currentReview.vertices[0]]] } };
  }, [currentReview]);

  const treePreviewGeoJSON = useMemo(() => {
    if (addMode !== 'tree') return null;
    let radiusKm = 0;
    if (treeStep === 'sizing' && treeCenter && mousePos) radiusKm = turf.distance(turf.point(treeCenter), turf.point(mousePos), { units: 'kilometers' });
    else if (treeStep === 'attributes' && treeCenter && treeRadiusKm > 0) radiusKm = treeRadiusKm;
    if (radiusKm < 0.0005 || !treeCenter) return null;
    try { return turf.circle(treeCenter, radiusKm, { steps: 48, units: 'kilometers' }); } catch { return null; }
  }, [addMode, treeStep, treeCenter, mousePos, treeRadiusKm]);

  const polyLineGeoJSON = useMemo(() => {
    if ((addMode !== 'hardscape' && addMode !== 'structure') || polyStep !== 'drawing') return null;
    if (polyVerts.length === 0 || !mousePos) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [...polyVerts, mousePos] } };
  }, [addMode, polyStep, polyVerts, mousePos]);

  const polyFillGeoJSON = useMemo(() => {
    if ((addMode !== 'hardscape' && addMode !== 'structure') || polyVerts.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...polyVerts, polyVerts[0]]] } };
  }, [addMode, polyVerts]);

  // ── Map handlers ──────────────────────────────────────────────────────────────
  const isDblClickRef = useRef(false);

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (isDblClickRef.current) return;
    const pt: [number, number] = [e.latLng!.lng(), e.latLng!.lat()];

    if (phase !== 'add') return;
    if (addMode === 'tree') {
      if (treeStep === 'placing') { setTreeCenter(pt); setTreeStep('sizing'); }
      else if (treeStep === 'sizing' && treeCenter) {
        const r = turf.distance(turf.point(treeCenter), turf.point(pt), { units: 'kilometers' });
        if (r >= 0.0005) { setTreeRadiusKm(r); setTreeStep('attributes'); }
      }
    } else if ((addMode === 'hardscape' || addMode === 'structure') && polyStep === 'drawing') {
      setPolyVerts(v => [...v, pt]);
    }
  }, [phase, addMode, treeStep, treeCenter, polyStep]);

  const handleDblClick = useCallback((_e: google.maps.MapMouseEvent) => {
    isDblClickRef.current = true;
    setTimeout(() => { isDblClickRef.current = false; }, 0);
    if (phase !== 'add') return;
    if ((addMode === 'hardscape' || addMode === 'structure') && polyStep === 'drawing' && polyVerts.length >= 3) {
      setPolyStep('attributes');
    }
  }, [phase, addMode, polyStep, polyVerts]);

  const handleMouseMove = useCallback((e: google.maps.MapMouseEvent) => {
    if (e.latLng) setMousePos([e.latLng.lng(), e.latLng.lat()]);
  }, []);

  const mapCursor = (addMode !== null && treeStep !== 'attributes' && polyStep !== 'attributes') ? 'crosshair' : undefined;

  const handleDone = () => navigate('/diy/plants');


  // ── Phase A panel ─────────────────────────────────────────────────────────────
  const renderPhaseA = () => {
    if (!currentReview) {
      return (
        <div className="flex flex-col gap-3">
          <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#6A6A60', margin: 0 }}>
            All {reviewQueue.length} feature{reviewQueue.length !== 1 ? 's' : ''} reviewed.
          </p>
          <button onClick={() => setPhase('add')}
            className="rounded-full py-2.5 hover:opacity-90 transition-all"
            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            Continue →
          </button>
        </div>
      );
    }

    const isLow = (currentReview.confidence ?? 1) < 0.7;
    const typeLabel = currentReview.type === 'tree' ? 'tree' : currentReview.type === 'hardscape' ? 'hardscape area' : 'structure';

    return (
      <div className="flex flex-col gap-3">
        <div style={{ height: 3, background: 'rgba(42,42,38,0.1)', borderRadius: 999 }}>
          <div style={{ height: '100%', borderRadius: 999, background: '#2F6B4F', transition: 'width 0.3s',
            width: `${reviewQueue.length > 0 ? (queueIdx / reviewQueue.length) * 100 : 100}%` }} />
        </div>
        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>{queueIdx + 1} of {reviewQueue.length}</span>
        <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
          {isLow && <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#C4935A', textTransform: 'uppercase', letterSpacing: '0.08em' }}>uncertain detection</span>}
          <p style={{ fontFamily: IS, fontSize: '1.2rem', color: '#2A2A26', margin: 0, fontWeight: 400, lineHeight: 1.2 }}>
            {isLow ? `Is this a ${typeLabel}?` : `${currentReview.type.charAt(0).toUpperCase() + currentReview.type.slice(1)} found`}
          </p>
          {currentReview.label && <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#7A7A73' }}>{currentReview.label}</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => resolveFeature(currentReview.id, 'keep')}
            className="flex-1 py-2.5 rounded-full hover:opacity-90 transition-all"
            style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            Keep
          </button>
          <button onClick={() => resolveFeature(currentReview.id, 'remove')}
            className="flex-1 py-2.5 rounded-full hover:opacity-90 transition-all"
            style={{ background: '#D65C5C', color: 'white', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            Remove
          </button>
        </div>
        <button onClick={() => resolveFeature(currentReview.id, 'not_real')}
          style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'center' }}>
          Not a real feature
        </button>
        <button onClick={() => setPhase('add')}
          style={{ fontFamily: IT, fontSize: '0.72rem', color: '#C0C0B8', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'center' }}>
          Skip to add phase →
        </button>
      </div>
    );
  };

  // ── Phase B panel ─────────────────────────────────────────────────────────────
  const renderPhaseB = () => {
    if (addMode === 'tree' && treeStep === 'attributes') {
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>Tree details</span>
            <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
          </div>
          <div className="flex flex-col gap-1.5">
            <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>Deciduous or evergreen?</span>
            <div className="flex gap-2">
              {[{ v: true, l: 'Deciduous' }, { v: false, l: 'Evergreen' }].map(({ v, l }) => (
                <button key={l} onClick={() => setTreeDeciduous(v)} className="flex-1 py-2 rounded-full transition-all"
                  style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                    border: treeDeciduous === v ? 'none' : '1.5px solid rgba(42,42,38,0.12)',
                    background: treeDeciduous === v ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                    color: treeDeciduous === v ? '#efe9db' : '#2A2A26' }}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>Rough height (optional)</span>
            <div className="flex gap-2">
              {TREE_HEIGHTS.map(h => (
                <button key={h.label} onClick={() => setTreeHeightM(h.value)}
                  className="flex-1 flex flex-col items-center py-2 rounded-xl transition-all"
                  style={{ cursor: 'pointer', background: treeHeightM === h.value ? 'rgba(42,42,38,0.12)' : 'rgba(42,42,38,0.06)', border: `1.5px solid ${treeHeightM === h.value ? 'rgba(42,42,38,0.25)' : 'rgba(42,42,38,0.1)'}` }}>
                  <span style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 600, color: '#2A2A26' }}>{h.label}</span>
                  <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92' }}>{h.sub}</span>
                </button>
              ))}
            </div>
          </div>
          <button onClick={confirmTree} disabled={treeDeciduous === null}
            className="rounded-full py-2.5 hover:opacity-90 transition-all disabled:opacity-30"
            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: treeDeciduous !== null ? 'pointer' : 'default' }}>
            Confirm tree →
          </button>
        </div>
      );
    }

    if (addMode === 'hardscape' && polyStep === 'attributes') {
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>Surface type</span>
            <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SURFACE_TYPES.map(s => (
              <button key={s} onClick={() => setSelectedSurface(s)}
                className="px-3 py-1.5 rounded-full transition-all hover:opacity-90"
                style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer',
                  background: selectedSurface === s ? '#2A2A26' : 'rgba(42,42,38,0.07)',
                  color: selectedSurface === s ? '#efe9db' : '#2A2A26',
                  border: selectedSurface === s ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                {s}
              </button>
            ))}
          </div>
          <button onClick={confirmHardscape} disabled={!selectedSurface}
            className="rounded-full py-2.5 hover:opacity-90 transition-all disabled:opacity-30"
            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: selectedSurface ? 'pointer' : 'default' }}>
            Confirm hardscape →
          </button>
        </div>
      );
    }

    if (addMode === 'structure' && polyStep === 'attributes') {
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>What is it?</span>
            <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
          </div>
          <input autoFocus type="text" placeholder="Shed, fence, garage…" value={structureLabel}
            onChange={e => setStructureLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmStructure(); }}
            className="rounded-xl px-3 py-2"
            style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', outline: 'none' }} />
          <button onClick={confirmStructure}
            className="rounded-full py-2.5 hover:opacity-90 transition-all"
            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            Confirm structure →
          </button>
        </div>
      );
    }

    if (addMode !== null) {
      const hint =
        addMode === 'tree'
          ? treeStep === 'placing' ? 'Click the map to place the tree center.' : 'Click again to set the canopy size.'
          : polyVerts.length === 0 ? 'Click to start the outline.'
          : polyVerts.length < 3 ? `${3 - polyVerts.length} more point${3 - polyVerts.length !== 1 ? 's' : ''} needed.`
          : 'Double-click to close.';
      const modeLabel = addMode === 'tree' ? 'Adding tree' : addMode === 'hardscape' ? 'Adding hardscape' : 'Adding structure';
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>{modeLabel}</span>
            <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
          </div>
          <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', lineHeight: 1.5 }}>{hint}</span>
          {(addMode === 'hardscape' || addMode === 'structure') && polyVerts.length > 0 && (
            <button onClick={() => setPolyVerts(v => v.slice(0, -1))}
              style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
              Undo last point
            </button>
          )}
        </div>
      );
    }

    const addedFeatures = features.filter(f => f.source === 'added');
    return (
      <div className="flex flex-col gap-3">
        <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', margin: 0, lineHeight: 1.6 }}>
          {detectedFeatures.length === 0
            ? "Map any trees, hardscape, or structures that already exist. We'll use them to model sun and plan around them."
            : "Anything we missed? Add any trees, hardscape, or structures that weren't detected."}
        </p>
        <div className="flex flex-col gap-2">
          {([
            { mode: 'tree'      as const, icon: '🌳', label: 'Add tree',      sub: 'large trees & shrubs' },
            { mode: 'hardscape' as const, icon: '⬜', label: 'Add hardscape', sub: 'patio, driveway, walkway' },
            { mode: 'structure' as const, icon: '🏠', label: 'Add structure',  sub: 'shed, fence, garage' },
          ]).map(({ mode, icon, label, sub }) => (
            <button key={mode} onClick={() => startAdd(mode)}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
              style={{ background: 'rgba(42,42,38,0.06)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>{icon}</span>
              <div>
                <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 500, display: 'block' }}>{label}</span>
                <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92' }}>{sub}</span>
              </div>
            </button>
          ))}
        </div>
        {addedFeatures.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Added</span>
            {addedFeatures.map(f => (
              <div key={f.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: '#2F6B4F', flexShrink: 0 }} />
                <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                <button onClick={() => setFeatures(prev => prev.filter(x => x.id !== f.id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0, flexShrink: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#efe9db', overflow: 'hidden' }}>
      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0">
        <Logo />
        <button onClick={() => navigate('/')}
          style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
          Save & exit ↗
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden px-10 pb-16 gap-5">

        {/* Left panel */}
        <div className="flex flex-col gap-4 overflow-y-auto flex-shrink-0" style={{ width: '33%' }}>
          <div>
            <h1 style={{ fontFamily: IS, fontSize: '2.4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>
              {phase === 'review' ? 'Review what we found.' : "What's already there?"}
            </h1>
            <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#6A6A60', marginTop: '0.35rem' }}>
              {phase === 'review'
                ? 'Confirm each detected feature — keep it or mark it for removal.'
                : detectedFeatures.length > 0
                  ? 'Anything we missed? Add trees, hardscape, or structures.'
                  : 'Map existing features before we design around them.'}
            </p>
          </div>

          <div className="rounded-2xl flex-shrink-0 px-5 py-4" style={{ backgroundColor: '#F4EAD2' }}>
            {phase === 'review' ? renderPhaseA() : renderPhaseB()}
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full rounded-2xl overflow-hidden relative" style={{ cursor: mapCursor }}>
            {isLoaded && (
              <GoogleMap
                onLoad={map => { mapRef.current = map; }}
                center={{ lat: mapCenter[1], lng: mapCenter[0] }}
                zoom={20}
                mapContainerStyle={{ width: '100%', height: '100%' }}
                options={{ mapTypeId: 'satellite', disableDoubleClickZoom: true, mapTypeControl: false, fullscreenControl: false, streetViewControl: false }}
                onClick={handleMapClick}
                onDblClick={handleDblClick}
                onMouseMove={handleMouseMove}
              >
                {/* Boundary */}
                {boundaryGeoJSON && (
                  <>
                    <GPolygon paths={toPath(boundaryGeoJSON.geometry.coordinates[0])}
                      options={{ fillColor: '#2F6B4F', fillOpacity: 0.07, strokeOpacity: 0, clickable: false }} />
                    <GPolyline path={toPath(boundaryGeoJSON.geometry.coordinates[0])}
                      options={{ strokeColor: '#FFFFFF', strokeWeight: 2, clickable: false }} />
                  </>
                )}

                {/* Keep features */}
                {keepGeoJSON.features.map((f, i) => (
                  <GPolygon key={`keep-${i}`} paths={toPath(f.geometry.coordinates[0])}
                    options={{ fillColor: '#2F6B4F', fillOpacity: 0.28, strokeColor: '#2F6B4F', strokeWeight: 2, clickable: false }} />
                ))}

                {/* Remove features */}
                {removeGeoJSON.features.map((f, i) => (
                  <Fragment key={`remove-${i}`}>
                    <GPolygon paths={toPath(f.geometry.coordinates[0])}
                      options={{ fillColor: '#D65C5C', fillOpacity: 0.18, strokeOpacity: 0, clickable: false }} />
                    <GPolyline path={toPath(f.geometry.coordinates[0])} options={dashedLine('#D65C5C', 2)} />
                  </Fragment>
                ))}

                {/* Pending features */}
                {pendingGeoJSON.features.map((f, i) => (
                  <Fragment key={`pending-${i}`}>
                    <GPolygon paths={toPath(f.geometry.coordinates[0])}
                      options={{ fillColor: '#FFFFFF', fillOpacity: 0.08, strokeOpacity: 0, clickable: false }} />
                    <GPolyline path={toPath(f.geometry.coordinates[0])} options={dashedLine('#FFFFFF', 2)} />
                  </Fragment>
                ))}

                {/* Active queue feature */}
                {queueGeoJSON && phase === 'review' && (
                  <>
                    <GPolygon paths={toPath(queueGeoJSON.geometry.coordinates[0])}
                      options={{ fillColor: '#F5C518', fillOpacity: 0.38, strokeOpacity: 0, clickable: false }} />
                    <GPolyline path={toPath(queueGeoJSON.geometry.coordinates[0])}
                      options={{ strokeColor: '#F5C518', strokeWeight: 7, strokeOpacity: 0.35, clickable: false }} />
                    <GPolyline path={toPath(queueGeoJSON.geometry.coordinates[0])}
                      options={{ strokeColor: '#FFFFFF', strokeWeight: 2.5, clickable: false }} />
                  </>
                )}

                {/* Edit handles for active review feature */}
                {phase === 'review' && currentReview && activeFeatureCenter && (
                  <>
                    <GMarker position={{ lat: activeFeatureCenter[1], lng: activeFeatureCenter[0] }}
                      draggable
                      icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: 'white', fillOpacity: 1, strokeColor: '#F5C518', strokeWeight: 2.5 }}
                      onDragStart={(e: google.maps.MapMouseEvent) => { editCenterRef.current = { origCenter: [e.latLng!.lng(), e.latLng!.lat()], origVerts: [...currentReview.vertices] }; }}
                      onDrag={handleCenterDrag}
                      onDragEnd={() => { editCenterRef.current = null; }}
                    />
                    {activeTreeInfo && (
                      <GMarker position={{ lat: activeTreeInfo.edgeVert[1], lng: activeTreeInfo.edgeVert[0] }}
                        draggable
                        icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#F5C518', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 }}
                        onDrag={handleEdgeDrag}
                        onDragEnd={() => {}}
                      />
                    )}
                    {(currentReview.type === 'hardscape' || currentReview.type === 'structure') &&
                      currentReview.vertices.map((v, i) => (
                        <GMarker key={`ev-${currentReview.id}-${i}`}
                          position={{ lat: v[1], lng: v[0] }}
                          draggable
                          icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: 'white', fillOpacity: 1, strokeColor: '#F5C518', strokeWeight: 2 }}
                          onDragStart={() => { origVertsRef.current = [...currentReview.vertices]; }}
                          onDrag={(e: google.maps.MapMouseEvent) => handleVertexDrag(e, i)}
                          onDragEnd={() => { origVertsRef.current = []; }}
                        />
                      ))
                    }
                  </>
                )}

                {/* Tree add preview */}
                {treePreviewGeoJSON && (
                  <>
                    <GPolygon paths={toPath(treePreviewGeoJSON.geometry.coordinates[0])}
                      options={{ fillColor: '#2F6B4F', fillOpacity: 0.2, strokeOpacity: 0, clickable: false }} />
                    <GPolyline path={toPath(treePreviewGeoJSON.geometry.coordinates[0])} options={dashedLine('#2F6B4F', 2)} />
                  </>
                )}
                {treeCenter && addMode === 'tree' && (
                  <GMarker position={{ lat: treeCenter[1], lng: treeCenter[0] }}
                    icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#2F6B4F', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 }} />
                )}

                {/* Polygon add preview */}
                {polyFillGeoJSON && (
                  <GPolygon paths={toPath(polyFillGeoJSON.geometry.coordinates[0])}
                    options={{ fillColor: '#C77C5B', fillOpacity: 0.18, strokeColor: '#C77C5B', strokeWeight: 2, clickable: false }} />
                )}
                {polyLineGeoJSON && (
                  <GPolyline path={toPath(polyLineGeoJSON.geometry.coordinates as number[][])}
                    options={{ strokeColor: '#C77C5B', strokeWeight: 2, strokeOpacity: 0.8, clickable: false }} />
                )}
                {polyVerts.map((v, i) => (
                  <GMarker key={`pv-${i}`} position={{ lat: v[1], lng: v[0] }}
                    icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: '#C77C5B', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 }} />
                ))}
              </GoogleMap>
            )}
          </div>
        </div>
      </div>

      <button onClick={() => navigate(-1)}
        className="fixed bottom-6 left-10 hover:opacity-70 transition-all"
        style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>

      {phase === 'add' && addMode === null && (
        <button onClick={handleDone}
          className="fixed bottom-6 right-10 px-7 py-3.5 rounded-full hover:opacity-90 transition-all"
          style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          {features.filter(f => f.source === 'added').length === 0 ? 'Nothing to add →' : 'Done →'}
        </button>
      )}
    </div>
  );
}
