import { useState, useRef, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Marker, Polygon, Polyline, OverlayView } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import { detectSiteFeatures } from '../services/geminiService';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

const SURFACE_TYPES = ['Concrete', 'Pavers', 'Gravel', 'Asphalt', 'Wood / Deck', 'Flagstone', 'Other'];

const STYLE_LABELS: Record<string, string> = {
  natural_wild:      'Whimsical / wildflower cottage',
  modern_structured: 'Modern / minimalist structured',
  desert_minimal:    'Desert / xeriscape drought-tolerant',
  traditional:       'Traditional / classic formal',
};

const PRIORITY_LABELS: Record<string, string> = {
  low_maintenance: 'low maintenance',
  curb_appeal:     'strong curb appeal',
  pollinator:      'pollinator-friendly',
  kid_pet:         'kid and pet safe',
};

const DESIRED_LABELS: Record<string, string> = {
  walkway: 'walkway to the door',
  seating: 'seating area',
  dining:  'outdoor dining area',
  cooking: 'outdoor cooking area',
  water:   'water feature',
  garden:  'vegetable garden',
  storage: 'storage shed',
  trees:   'shade trees',
};

const FEATURE_COLOR: Record<string, string> = {
  house:     '#C4935A',
  tree:      '#2F6B4F',
  hardscape: '#B5A48B',
  structure: '#9A8B78',
};

function getFeatureDimsFt(verts: [number, number][]): { w: number; h: number } | null {
  if (verts.length < 3) return null;
  try {
    const bb  = turf.bbox(turf.polygon([[...verts, verts[0]]]));
    const mid = (bb[1] + bb[3]) / 2;
    const w   = Math.round(turf.distance([bb[0], mid], [bb[2], mid], { units: 'feet' }));
    const h   = Math.round(turf.distance([(bb[0]+bb[2])/2, bb[1]], [(bb[0]+bb[2])/2, bb[3]], { units: 'feet' }));
    return { w, h };
  } catch { return null; }
}

function toPath(coords: number[][]): google.maps.LatLngLiteral[] {
  return coords.map(c => ({ lat: c[1], lng: c[0] }));
}

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
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avgLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(avgLat * Math.PI / 180);
  const FT = 3.28084;
  const widthFt  = (maxLng - minLng) * mPerDegLng * FT;
  const heightFt = (maxLat - minLat) * mPerDegLat * FT;
  const toXY = (lng: number, lat: number): [number, number] => [
    (lng - minLng) * mPerDegLng * FT,
    (maxLat - lat) * mPerDegLat * FT,
  ];
  return { widthFt, heightFt, toXY };
}

type StepId    = 'boundary' | 'identify' | 'add_existing' | 'door';
type AddMode   = 'tree' | 'hardscape' | 'structure' | 'house' | 'paving' | 'garden_bed' | 'utility' | null;
type ETreeStep = 'placing' | 'sizing';
type EPolyStep = 'drawing' | 'attributes';

const STEP_TITLE: Record<StepId, string> = {
  boundary:     'Draw area',
  identify:     'Confirm existing',
  add_existing: 'Add existing',
  door:         'Mark your door',
};

export default function DiyBoundaryPage() {
  const navigate = useNavigate();
  const mapRef   = useRef<google.maps.Map | null>(null);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const sc = useMemo<any>(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const center: [number, number] = [sc.lng ?? -104.99, sc.lat ?? 39.74];

  const visibleSteps: StepId[] = ['boundary', 'identify', 'add_existing', 'door'];

  // ── Boundary ─────────────────────────────────────────────────────────────────
  const isDblClickRef = useRef(false);
  const detectGenRef  = useRef(0);
  const [detecting,  setDetecting]  = useState(false);
  const [drawing,    setDrawing]    = useState(false);
  const [vertices,   setVertices]   = useState<[number, number][]>(() => {
    try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.ring ?? []; } catch { return []; }
  });
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [mousePos,   setMousePos]   = useState<[number, number] | null>(null);

  const boundaryDone = vertices.length >= 3 && !drawing;

  const areaSqFt = useMemo(() => {
    if (vertices.length < 3) return 0;
    try { return Math.round(turf.area(turf.polygon([[...vertices, vertices[0]]])) * 10.7639); } catch { return 0; }
  }, [vertices]);

  const perimeterFt = useMemo(() => {
    if (vertices.length < 3) return 0;
    try { return Math.round(turf.length(turf.lineString([...vertices, vertices[0]]), { units: 'feet' })); } catch { return 0; }
  }, [vertices]);

  // ── Accordion step ───────────────────────────────────────────────────────────
  const [openStep, setOpenStep] = useState<StepId | null>(() => {
    try {
      const bd = JSON.parse(localStorage.getItem('diyBoundary') || 'null');
      if ((bd?.ring?.length ?? 0) >= 3) return null;
    } catch {}
    return 'boundary';
  });

  // ── Confirmed features ───────────────────────────────────────────────────────
  const [features, setFeatures] = useState<ConfirmedFeature[]>(() => {
    try {
      const saved = localStorage.getItem('diyConfirmedFeatures');
      if (saved) return JSON.parse(saved);
      const raw = localStorage.getItem('diyDetectedFeatures');
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });
  useEffect(() => { localStorage.setItem('diyConfirmedFeatures', JSON.stringify(features)); }, [features]);

  const reviewQueue  = useMemo(() => features.filter(f => f.source === 'detected'), [features]);
  const [queueIdx, setQueueIdx] = useState(() => {
    const saved = parseInt(localStorage.getItem('diyQueueIdx') ?? '0', 10);
    return isNaN(saved) ? 0 : saved;
  });
  useEffect(() => { localStorage.setItem('diyQueueIdx', String(queueIdx)); }, [queueIdx]);
  const currentReview = reviewQueue[queueIdx] ?? null;
  const identifyDone  = reviewQueue.length === 0 || queueIdx >= reviewQueue.length;

  useEffect(() => {
    if (openStep !== 'identify' || !currentReview || !mapRef.current) return;
    try {
      const bb = turf.bbox(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]]));
      const featureBounds = new google.maps.LatLngBounds({ lat: bb[1], lng: bb[0] }, { lat: bb[3], lng: bb[2] });
      const mapBounds = mapRef.current.getBounds();
      if (mapBounds && mapBounds.contains(featureBounds.getNorthEast()) && mapBounds.contains(featureBounds.getSouthWest())) return;
      mapRef.current.fitBounds(featureBounds, 140);
    } catch {}
  }, [queueIdx, openStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const [doorPoint, setDoorPoint] = useState<[number, number] | null>(() => {
    try { return JSON.parse(localStorage.getItem('diyDoorPoint') || 'null'); } catch { return null; }
  });
  useEffect(() => {
    if (doorPoint) localStorage.setItem('diyDoorPoint', JSON.stringify(doorPoint));
    else localStorage.removeItem('diyDoorPoint');
  }, [doorPoint]);

  const advanceFromFeatures = useCallback(() => { setOpenStep('add_existing'); }, []);

  const resolveFeature = useCallback((id: string, decision: 'keep' | 'remove' | 'not_real') => {
    setFeatures(prev =>
      decision === 'not_real'
        ? prev.filter(f => f.id !== id)
        : prev.map(f => f.id === id ? { ...f, keep: decision === 'keep' } : f),
    );
    setQueueIdx(i => {
      const next = i + 1;
      if (next >= reviewQueue.length) { advanceFromFeatures(); return next; }
      return next;
    });
  }, [reviewQueue.length, advanceFromFeatures]);

  // ── Add-existing ─────────────────────────────────────────────────────────────
  const [addMode,         setAddMode]         = useState<AddMode>(null);
  const [eTreeStep,       setETreeStep]       = useState<ETreeStep>('placing');
  const [eTreeCenter,     setETreeCenter]     = useState<[number, number] | null>(null);
  const [eTreeRadiusKm,   setETreeRadiusKm]   = useState(0);
  const [ePolyStep,       setEPolyStep]       = useState<EPolyStep>('drawing');
  const [ePolyVerts,      setEPolyVerts]      = useState<[number, number][]>([]);
  const [eSurface,        setESurface]        = useState('');
  const [eStructureLabel, setEStructureLabel] = useState('');
  const editCenterRef = useRef<{ origCenter: [number, number]; origVerts: [number, number][] } | null>(null);
  const origVertsRef  = useRef<[number, number][]>([]);

  const resetAddDrawing = useCallback(() => {
    setETreeStep('placing'); setETreeCenter(null); setETreeRadiusKm(0);
    setEPolyStep('drawing'); setEPolyVerts([]); setESurface(''); setEStructureLabel('');
  }, []);
  const cancelAdd = useCallback(() => { resetAddDrawing(); setAddMode(null); }, [resetAddDrawing]);
  const startAdd  = useCallback((m: AddMode) => { resetAddDrawing(); setAddMode(m); }, [resetAddDrawing]);

  const confirmAddTree = useCallback((radiusKm?: number) => {
    const r = radiusKm ?? eTreeRadiusKm;
    if (!eTreeCenter || r < 0.0005) return;
    const ring = (turf.circle(eTreeCenter, r, { steps: 48, units: 'kilometers' })
      .geometry.coordinates[0] as [number, number][]).slice(0, -1);
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'tree' as const, keep: true, source: 'added' as const,
      vertices: ring, label: 'Tree', attributes: {},
    }]);
    cancelAdd();
  }, [eTreeCenter, eTreeRadiusKm, cancelAdd]);

  const confirmAddHardscape = useCallback(() => {
    if (ePolyVerts.length < 3 || !eSurface) return;
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'hardscape' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: `Hardscape — ${eSurface}`, attributes: { surfaceType: eSurface },
    }]);
    cancelAdd();
  }, [ePolyVerts, eSurface, cancelAdd]);

  const confirmAddStructure = useCallback(() => {
    if (ePolyVerts.length < 3) return;
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'structure' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: eStructureLabel.trim() || 'Structure', attributes: {},
    }]);
    cancelAdd();
  }, [ePolyVerts, eStructureLabel, cancelAdd]);

  const SIMPLE_POLY_CONFIG: Record<string, { type: ConfirmedFeature['type']; label: string }> = {
    house:      { type: 'house',     label: 'House'      },
    paving:     { type: 'hardscape', label: 'Paving'     },
    garden_bed: { type: 'hardscape', label: 'Garden bed' },
    utility:    { type: 'structure', label: 'Utility'    },
  };

  const confirmAddSimplePoly = useCallback(() => {
    if (ePolyVerts.length < 3 || !addMode || !(addMode in SIMPLE_POLY_CONFIG)) return;
    const cfg = SIMPLE_POLY_CONFIG[addMode];
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: cfg.type, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: cfg.label, attributes: {},
    }]);
    cancelAdd();
  }, [ePolyVerts, addMode, cancelAdd]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Identify drag handles ────────────────────────────────────────────────────
  const activeTreeInfo = useMemo(() => {
    if (openStep !== 'identify' || !currentReview || currentReview.type !== 'tree') return null;
    const verts = currentReview.vertices;
    if (verts.length < 3) return null;
    try {
      const center = turf.centroid(turf.polygon([[...verts, verts[0]]])).geometry.coordinates as [number, number];
      const radius = turf.distance(turf.point(center), turf.point(verts[0]), { units: 'kilometers' });
      const edgeVert = verts.reduce((best, v) => v[0] > best[0] ? v : best, verts[0]);
      return { center, radius, edgeVert };
    } catch { return null; }
  }, [openStep, currentReview]);

  const activeFeatureCenter = useMemo(() => {
    if (openStep !== 'identify' || !currentReview || currentReview.vertices.length < 3) return null;
    if (activeTreeInfo) return activeTreeInfo.center;
    try {
      return turf.centroid(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]]))
        .geometry.coordinates as [number, number];
    } catch { return null; }
  }, [openStep, currentReview, activeTreeInfo]);

  const updateCurrentFeature = useCallback((updater: (f: ConfirmedFeature) => ConfirmedFeature) => {
    if (!currentReview) return;
    setFeatures(prev => prev.map(f => f.id === currentReview.id ? updater(f) : f));
  }, [currentReview]);

  const handleCenterDrag = useCallback((e: google.maps.MapMouseEvent) => {
    const drag = editCenterRef.current;
    if (!drag || !e.latLng) return;
    const dLng = e.latLng.lng() - drag.origCenter[0];
    const dLat = e.latLng.lat() - drag.origCenter[1];
    updateCurrentFeature(f => ({ ...f, vertices: drag.origVerts.map(v => [v[0] + dLng, v[1] + dLat] as [number, number]) }));
  }, [updateCurrentFeature]);

  const handleEdgeDrag = useCallback((e: google.maps.MapMouseEvent) => {
    if (!activeTreeInfo || !e.latLng) return;
    const newRadius = turf.distance(turf.point(activeTreeInfo.center), turf.point([e.latLng.lng(), e.latLng.lat()]), { units: 'kilometers' });
    if (newRadius < 0.001) return;
    try {
      const ring = (turf.circle(activeTreeInfo.center, newRadius, { steps: 32, units: 'kilometers' })
        .geometry.coordinates[0] as [number, number][]).slice(0, -1);
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

  // ── Confirmed-feature GeoJSON ────────────────────────────────────────────────
  const pendingIds = useMemo(
    () => new Set(reviewQueue.slice(queueIdx + 1).map(f => f.id)),
    [reviewQueue, queueIdx],
  );
  const activeConfirmedId = currentReview?.id ?? null;

  const cfKeepGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features
      .filter(f => f.keep && f.vertices.length >= 3 && f.id !== activeConfirmedId && !pendingIds.has(f.id))
      .map(f => ({ type: 'Feature' as const, properties: { featureType: f.type, id: f.id }, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [features, activeConfirmedId, pendingIds]);

  const cfPendingGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: reviewQueue.slice(queueIdx + 1).filter(f => f.vertices.length >= 3)
      .map(f => ({ type: 'Feature' as const, properties: { id: f.id }, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [reviewQueue, queueIdx]);

  const cfActiveGeoJSON = useMemo(() => {
    if (!currentReview || currentReview.vertices.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...currentReview.vertices, currentReview.vertices[0]]] } };
  }, [currentReview]);

  const eTreePreviewCoords = useMemo<[number, number][] | null>(() => {
    if (addMode !== 'tree' || openStep !== 'add_existing') return null;
    let rKm = 0;
    if (eTreeStep === 'sizing' && eTreeCenter && mousePos)
      rKm = turf.distance(turf.point(eTreeCenter), turf.point(mousePos), { units: 'kilometers' });
    if (rKm < 0.0005 || !eTreeCenter) return null;
    try { return turf.circle(eTreeCenter, rKm, { steps: 48, units: 'kilometers' }).geometry.coordinates[0] as [number, number][]; } catch { return null; }
  }, [addMode, openStep, eTreeStep, eTreeCenter, mousePos, eTreeRadiusKm]);

  const isPolyAddMode = addMode !== null && addMode !== 'tree';

  const ePolyFillCoords = useMemo<[number, number][] | null>(() =>
    isPolyAddMode && ePolyVerts.length >= 3 ? ePolyVerts : null,
  [isPolyAddMode, ePolyVerts]);

  const ePolyLineCoords = useMemo<[number, number][] | null>(() =>
    isPolyAddMode && ePolyStep === 'drawing' && ePolyVerts.length > 0 && mousePos
      ? [...ePolyVerts, mousePos] : null,
  [isPolyAddMode, ePolyStep, ePolyVerts, mousePos]);

  const showConfirmedFeatures = features.length > 0 && openStep !== 'boundary';

  const goToPlacement = useCallback(() => {
    if (vertices.length < 3) return;
    localStorage.setItem('diyBoundaryFinal', JSON.stringify({
      boundary:          vertices,
      confirmedFeatures: features.filter(f => f.keep),
      doorPoint,
    }));
    navigate('/diy/placement');
  }, [vertices, features, doorPoint, navigate]);

  // ── Map handlers ─────────────────────────────────────────────────────────────
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (draggingIdx !== null || !e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    setTimeout(() => {
      if (isDblClickRef.current) return;
      if (drawing) { setVertices(v => [...v, [lng, lat]]); return; }
      if (openStep === 'door') { setDoorPoint([lng, lat]); return; }
      if (openStep === 'add_existing') {
        if (addMode === 'tree') {
          if (eTreeStep === 'placing')                        { setETreeCenter([lng, lat]); setETreeStep('sizing'); }
          else if (eTreeStep === 'sizing' && eTreeCenter) {
            const r = turf.distance(turf.point(eTreeCenter), turf.point([lng, lat]), { units: 'kilometers' });
            if (r >= 0.0005) confirmAddTree(r);
          }
        } else if (isPolyAddMode && ePolyStep === 'drawing') {
          setEPolyVerts(v => [...v, [lng, lat]]);
        }
      }
    }, 0);
  }, [drawing, draggingIdx, openStep, addMode, isPolyAddMode, eTreeStep, eTreeCenter, ePolyStep, confirmAddTree]);

  const handleBoundaryDone = useCallback(() => {
    if (!drawing || vertices.length < 3) return;
    setDrawing(false);
    const snap = vertices;
    const bd = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...bd, ring: snap }));
    const gen = ++detectGenRef.current;
    setDetecting(true);
    setFeatures([]); setQueueIdx(0); localStorage.setItem('diyQueueIdx', '0');
    detectSiteFeatures(snap)
      .then(detected => {
        if (detectGenRef.current !== gen) return;
        const allFeats: ConfirmedFeature[] = detected.map(f => ({
          id:         `detected_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type:       f.type,
          keep:       true,
          source:     'detected' as const,
          vertices:   f.vertices,
          confidence: f.confidence,
          label:      f.label,
          attributes: {},
        }));
        const boundaryPoly = turf.polygon([[...snap, snap[0]]]);
        const boundaryRing = turf.lineString([...snap, snap[0]]);
        const newFeats = allFeats.filter(f => {
          if (f.vertices.length < 3) return false;
          try {
            const featPoly = turf.polygon([[...f.vertices, f.vertices[0]]]);
            if (f.type === 'tree') {
              if (turf.booleanIntersects(boundaryPoly, featPoly)) return true;
              const center = turf.centroid(featPoly).geometry.coordinates as [number, number];
              const nearest = turf.nearestPointOnLine(boundaryRing, turf.point(center));
              return turf.distance(turf.point(center), nearest, { units: 'feet' }) <= 10;
            }
            return turf.booleanIntersects(boundaryPoly, featPoly);
          } catch { return true; }
        });
        localStorage.setItem('diyDetectedFeatures', JSON.stringify(newFeats));
        setFeatures(newFeats);
        setQueueIdx(0);
      })
      .catch(() => {})
      .finally(() => { setDetecting(false); if (detectGenRef.current === gen) setOpenStep('identify'); });
  }, [drawing, vertices]);

  const handleDblClick = useCallback((e: google.maps.MapMouseEvent) => {
    isDblClickRef.current = true;
    setTimeout(() => { isDblClickRef.current = false; }, 0);
    e.stop?.();
    if (openStep === 'add_existing' && isPolyAddMode && ePolyStep === 'drawing' && ePolyVerts.length >= 3) {
      if (addMode === 'hardscape' || addMode === 'structure') {
        setEPolyStep('attributes');
      } else {
        confirmAddSimplePoly();
      }
    }
  }, [openStep, isPolyAddMode, addMode, ePolyStep, ePolyVerts, confirmAddSimplePoly]);

  const handleMouseMove = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    if (drawing || (openStep === 'add_existing' && addMode !== null))
      setMousePos([e.latLng.lng(), e.latLng.lat()]);
  }, [drawing, openStep, addMode]);

  const resetBoundary = () => {
    detectGenRef.current += 1;
    setDetecting(false);
    setVertices([]); setDrawing(true); setMousePos(null);
    setOpenStep('boundary');
    setFeatures([]); setQueueIdx(0); cancelAdd();
    localStorage.setItem('diyBoundary', JSON.stringify({ ring: [] }));
    localStorage.setItem('diyConfirmedFeatures', '[]');
    localStorage.setItem('diyDetectedFeatures', '[]');
    localStorage.setItem('diyQueueIdx', '0');
    localStorage.removeItem('diyIdentifyDone');
    localStorage.removeItem('diyLayout');
    localStorage.removeItem('diyDoorPoint');
    setDoorPoint(null);
  };

  const mapCursor = (drawing || openStep === 'door' || (openStep === 'add_existing' && addMode !== null)) ? 'crosshair' : undefined;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#E7E1D5', overflow: 'hidden' }}>

      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0">
        <Logo />
        <button onClick={() => navigate('/')}
          style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
          Save & exit ↗
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden pr-10 gap-5" style={{ paddingBottom: '1.25rem' }}>

        {/* ── Left panel ── */}
        <div className="flex flex-col flex-shrink-0" style={{ width: '33%', background: '#EFE9DA', overflow: 'hidden', borderRight: '1px solid rgba(42,42,38,0.1)' }}>

          {/* Scrollable section */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            {/* Heading */}
            <div style={{ padding: '1.5rem 1.25rem 0' }}>
              <h1 style={{ fontFamily: IS, fontSize: '2.4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Build your plan.</h1>
              <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#6A6A60', marginTop: '0.35rem' }}>
                Map your area step by step — boundary first, then confirm what's there.
              </p>
            </div>

            {/* Accordion */}
            <div style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
              {visibleSteps.map((stepId, idx) => {
                const stepNum      = idx + 1;
                const isBoundary   = stepId === 'boundary';
                const isIdentify   = stepId === 'identify';
                const isAddExist   = stepId === 'add_existing';
                const isDoor       = stepId === 'door';
                const isOpen       = openStep === stepId;
                const isLocked     = (!boundaryDone && !isBoundary) || (isDoor && !boundaryDone);
                const addedExisting = features.filter(f => f.source === 'added');
                const isDone =
                  isBoundary  ? boundaryDone :
                  isIdentify  ? identifyDone :
                  isDoor      ? doorPoint !== null :
                  /* add */     false;

                return (
                  <div key={stepId}>
                    {idx > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}

                    {/* Step header */}
                    <button
                      className="w-full flex items-center gap-3 px-5 py-3.5 transition-all hover:opacity-80"
                      style={{ background: 'none', border: 'none', cursor: isLocked ? 'default' : 'pointer', opacity: isLocked ? 0.4 : 1 }}
                      onClick={() => { if (!isLocked) setOpenStep(isOpen ? null : stepId); }}>
                      {/* Circle indicator */}
                      <div style={{
                        width: 26, height: 26, borderRadius: '50%',
                        background: isOpen ? '#2A2A26' : isDone ? '#2F6B4F' : 'rgba(42,42,38,0.1)',
                        color: (isOpen || isDone) ? 'white' : '#9A9A92',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: IT, fontSize: '0.73rem', fontWeight: 600, flexShrink: 0,
                      }}>
                        {isDone && !isOpen ? '✓' : stepNum}
                      </div>
                      <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>
                        {STEP_TITLE[stepId]}
                      </span>
                      {isBoundary && boundaryDone && !isOpen && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>— {areaSqFt.toLocaleString()} sq ft</span>
                      )}
                      {isIdentify && reviewQueue.length > 0 && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>
                          — {Math.min(queueIdx, reviewQueue.length)} of {reviewQueue.length}
                        </span>
                      )}
                      {isAddExist && addedExisting.length > 0 && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>— {addedExisting.length} added</span>
                      )}
                      {isDoor && doorPoint && !isOpen && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>— marked</span>
                      )}
                      {!isLocked && (
                        <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6' }}>{isOpen ? '▾' : '▸'}</span>
                      )}
                    </button>

                    {/* Boundary step */}
                    {isBoundary && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        {boundaryDone ? (
                          <div className="flex flex-col gap-3 pt-3">
                            {/* Stats card */}
                            <div className="rounded-xl p-3 flex gap-6" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              <div className="flex flex-col gap-0.5">
                                <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Area</span>
                                <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{areaSqFt.toLocaleString()}</span>
                                <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#9A9A92' }}>sq ft</span>
                              </div>
                              {perimeterFt > 0 && (
                                <div className="flex flex-col gap-0.5">
                                  <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Perimeter</span>
                                  <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{perimeterFt.toLocaleString()}</span>
                                  <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#9A9A92' }}>ft</span>
                                </div>
                              )}
                            </div>
                            <button onClick={resetBoundary}
                              style={{ fontFamily: IT, fontSize: '0.76rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                              Re-draw boundary
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between pt-3">
                            <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', lineHeight: 1.5 }}>
                              {drawing
                                ? vertices.length < 3 ? `${3 - vertices.length} more points needed` : 'Click "Done" to close'
                                : vertices.length === 0 ? 'Click corners on the map' : 'Drag corners to adjust'}
                            </span>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {!drawing && vertices.length === 0 && (
                                <button onClick={() => { setDrawing(true); setOpenStep('boundary'); }}
                                  className="px-4 py-2 rounded-full hover:opacity-80 transition-all"
                                  style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                  Start drawing
                                </button>
                              )}
                              {drawing && (
                                <button onClick={() => setDrawing(false)}
                                  className="px-4 py-2 rounded-full hover:opacity-70 transition-all"
                                  style={{ border: '1.5px solid rgba(26,26,22,0.2)', fontFamily: IT, fontSize: '0.8rem', color: '#7A7A73', background: 'none', cursor: 'pointer' }}>
                                  Cancel
                                </button>
                              )}
                              {vertices.length > 0 && !drawing && (
                                <button onClick={resetBoundary}
                                  className="px-4 py-2 rounded-full hover:opacity-70 transition-all"
                                  style={{ border: '1.5px solid rgba(26,26,22,0.15)', fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92', background: 'none', cursor: 'pointer' }}>
                                  Re-draw
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Identify step */}
                    {isIdentify && isOpen && boundaryDone && (
                      <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        {reviewQueue.length === 0 ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>No features detected automatically.</p>
                            <button onClick={advanceFromFeatures}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Continue →
                            </button>
                          </div>
                        ) : identifyDone ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>
                              All {reviewQueue.length} feature{reviewQueue.length !== 1 ? 's' : ''} reviewed.
                            </p>
                            <button onClick={advanceFromFeatures}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Continue →
                            </button>
                          </div>
                        ) : currentReview ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                              We auto-detected {reviewQueue.length} thing{reviewQueue.length !== 1 ? 's' : ''}. Confirm or dismiss each.
                            </p>
                            {/* Feature card */}
                            <div className="flex items-center gap-3 rounded-2xl p-3" style={{ background: 'white' }}>
                              <div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, background: FEATURE_COLOR[currentReview.type] ?? '#9A9A92' }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontFamily: IT, fontSize: '0.88rem', color: '#2A2A26', fontWeight: 600 }}>
                                  {currentReview.label || (currentReview.type.charAt(0).toUpperCase() + currentReview.type.slice(1))}
                                </div>
                                {(() => {
                                  const dims = getFeatureDimsFt(currentReview.vertices);
                                  return dims ? (
                                    <div style={{ fontFamily: IT, fontSize: '0.73rem', color: '#9A9A92' }}>{dims.w} × {dims.h} ft</div>
                                  ) : null;
                                })()}
                              </div>
                              <div className="flex gap-1.5">
                                <button onClick={() => resolveFeature(currentReview.id, 'keep')}
                                  className="flex items-center justify-center rounded-xl hover:opacity-80 transition-all"
                                  style={{ width: 40, height: 40, background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', cursor: 'pointer', color: '#2F6B4F', fontSize: '1rem', fontWeight: 700 }}>
                                  ✓
                                </button>
                                <button onClick={() => resolveFeature(currentReview.id, currentReview.type === 'house' ? 'not_real' : 'remove')}
                                  className="flex items-center justify-center rounded-xl hover:opacity-80 transition-all"
                                  style={{ width: 40, height: 40, background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', cursor: 'pointer', color: '#9A9A92', fontSize: '0.9rem' }}>
                                  ✕
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}

                    {/* Door step */}
                    {isDoor && isOpen && boundaryDone && (
                      <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <p className="pt-3" style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                          Click on the map to mark where your main door opens into the yard. We'll route paths from here.
                        </p>
                        {doorPoint ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              <span style={{ fontSize: '0.9rem' }}>🚪</span>
                              <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26', flex: 1 }}>Door marked</span>
                              <button onClick={() => setDoorPoint(null)}
                                style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                            </div>
                            <span style={{ fontFamily: IT, fontSize: '0.71rem', color: '#9A9A92' }}>Click again on the map to reposition.</span>
                          </div>
                        ) : (
                          <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92' }}>Click anywhere on the map to place the door.</span>
                        )}
                      </div>
                    )}

                    {/* Add-existing step */}
                    {isAddExist && isOpen && boundaryDone && (
                      <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        {addMode === null ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                              Missed something? Pick a type, then tap the map to drop it.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {([
                                { mode: 'tree'       as const, label: 'Tree',        color: '#5C8A5C' },
                                { mode: 'structure'  as const, label: 'Structure',   color: '#9A8B78' },
                                { mode: 'house'      as const, label: 'House',       color: '#C4935A' },
                                { mode: 'paving'     as const, label: 'Paving',      color: '#B5A48B' },
                                { mode: 'garden_bed' as const, label: 'Garden bed',  color: '#C4A06A' },
                                { mode: 'utility'    as const, label: 'Utility',     color: '#6B93A8' },
                              ]).map(({ mode, label, color }) => (
                                <button key={mode} onClick={() => startAdd(mode)}
                                  className="flex items-center gap-2 px-3 py-2 rounded-xl hover:opacity-80 transition-all"
                                  style={{ background: 'rgba(255,255,255,0.7)', border: '1.5px solid rgba(42,42,38,0.12)', cursor: 'pointer' }}>
                                  <div style={{ width: 14, height: 14, borderRadius: 3, background: color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 500 }}>{label}</span>
                                </button>
                              ))}
                            </div>
                            {addedExisting.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Added</span>
                                {addedExisting.map(f => (
                                  <div key={f.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                    <div style={{ width: 8, height: 8, borderRadius: 2, background: f.type === 'tree' ? '#2F6B4F' : '#C77C5B', flexShrink: 0 }} />
                                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                                    <button onClick={() => setFeatures(prev => prev.filter(x => x.id !== f.id))}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : addMode === 'hardscape' && ePolyStep === 'attributes' ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <div className="flex items-center justify-between">
                              <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>Surface type</span>
                              <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {SURFACE_TYPES.map(s => (
                                <button key={s} onClick={() => setESurface(s)}
                                  className="px-3 py-1.5 rounded-full transition-all hover:opacity-90"
                                  style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: eSurface === s ? '#2A2A26' : 'rgba(42,42,38,0.07)', color: eSurface === s ? '#efe9db' : '#2A2A26', border: eSurface === s ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                  {s}
                                </button>
                              ))}
                            </div>
                            <button onClick={confirmAddHardscape} disabled={!eSurface}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all disabled:opacity-30"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: eSurface ? 'pointer' : 'default' }}>
                              Confirm hardscape →
                            </button>
                          </div>
                        ) : addMode === 'structure' && ePolyStep === 'attributes' ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <div className="flex items-center justify-between">
                              <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>What is it?</span>
                              <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
                            </div>
                            <input autoFocus type="text" placeholder="Shed, fence, garage…" value={eStructureLabel}
                              onChange={e => setEStructureLabel(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') confirmAddStructure(); }}
                              className="rounded-xl px-3 py-2"
                              style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', outline: 'none' }} />
                            <button onClick={confirmAddStructure}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Confirm structure →
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-3 pt-3">
                            <div className="flex items-center justify-between">
                              <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', lineHeight: 1.5 }}>
                                {addMode === 'tree'
                                  ? eTreeStep === 'placing' ? 'Click the map to place the tree center.'
                                    : 'Click again to set the canopy size.'
                                  : ePolyVerts.length === 0 ? 'Click to start the outline.'
                                  : ePolyVerts.length < 3 ? `${3 - ePolyVerts.length} more point${3 - ePolyVerts.length !== 1 ? 's' : ''} needed.`
                                  : 'Double-click to close.'}
                              </span>
                              <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>✕</button>
                            </div>
                            {isPolyAddMode && ePolyVerts.length > 0 && (
                              <button onClick={() => setEPolyVerts(v => v.slice(0, -1))}
                                style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
                                Undo last point
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer: back + continue */}
          <div className="flex items-center gap-3" style={{ borderTop: '1px solid rgba(42,42,38,0.1)', padding: '1rem 1.25rem', flexShrink: 0 }}>
            <button onClick={() => navigate('/diy/preferences', { state: { step: 5 } })}
              style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: '0.4rem 0', whiteSpace: 'nowrap' }}>
              ← back
            </button>
            <button onClick={goToPlacement} disabled={vertices.length < 3}
              className="flex-1 rounded-full hover:opacity-90 transition-all disabled:opacity-40"
              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: vertices.length >= 3 ? 'pointer' : 'default', padding: '12px 0' }}>
              Continue to design →
            </button>
          </div>
        </div>

        {/* ── Right: map ── */}
        <div className="flex-1 overflow-hidden flex items-center">
          <div className="w-full rounded-2xl overflow-hidden relative" style={{ cursor: mapCursor, height: '82%', boxShadow: '0 12px 48px rgba(0,0,0,0.22)' }}>
            {isLoaded ? (
              <GoogleMap
                mapContainerStyle={{ width: '100%', height: '100%' }}
                center={{ lat: center[1], lng: center[0] }}
                zoom={20}
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
                onDblClick={handleDblClick}
                onMouseMove={handleMouseMove}
                onLoad={map => { mapRef.current = map; }}
              >
                {/* Boundary polygon */}
                {vertices.length >= 3 && (
                  <Polygon
                    paths={[...vertices, vertices[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ fillColor: '#2F6B4F', fillOpacity: 0.12, strokeColor: '#FFFFFF', strokeWeight: 2, strokeOpacity: 1, clickable: false }}
                  />
                )}

                {/* Boundary draw preview */}
                {drawing && mousePos && vertices.length > 0 && (
                  <Polyline
                    path={[...vertices, mousePos].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine('#FFFFFF'), clickable: false }}
                  />
                )}

                {/* Confirmed existing-site features */}
                {showConfirmedFeatures && (<>
                  {/* Reviewed & kept — solid outline only */}
                  {cfKeepGeoJSON.features.map((f) => {
                    const color = FEATURE_COLOR[f.properties.featureType] ?? '#2F6B4F';
                    return (
                      <Polyline key={`cfk-${f.properties.id}`} path={toPath(f.geometry.coordinates[0])}
                        options={{ strokeColor: color, strokeWeight: 2.5, strokeOpacity: 1, clickable: false }} />
                    );
                  })}
                  {/* Pending (not yet reviewed) */}
                  {openStep === 'identify' && cfPendingGeoJSON.features.map((f) => (
                    <Fragment key={`cfp-${f.properties.id}`}>
                      <Polygon paths={toPath(f.geometry.coordinates[0])}
                        options={{ fillColor: '#FFFFFF', fillOpacity: 0.08, strokeOpacity: 0, clickable: false }} />
                      <Polyline path={toPath(f.geometry.coordinates[0])} options={dashedLine('#FFFFFF', 2)} />
                    </Fragment>
                  ))}
                  {/* Active review — yellow highlight */}
                  {cfActiveGeoJSON && openStep === 'identify' && (
                    <Fragment key={`cfa-${currentReview?.id ?? 'none'}`}>
                      <Polygon paths={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                        options={{ fillColor: '#F5C518', fillOpacity: 0.38, strokeOpacity: 0, clickable: false }} />
                      <Polyline path={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                        options={{ strokeColor: '#F5C518', strokeWeight: 7, strokeOpacity: 0.35, clickable: false }} />
                      <Polyline path={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                        options={{ strokeColor: '#FFFFFF', strokeWeight: 2.5, clickable: false }} />
                    </Fragment>
                  )}
                  {/* Edit handles */}
                  {openStep === 'identify' && currentReview && activeFeatureCenter && (<>
                    <Marker position={{ lat: activeFeatureCenter[1], lng: activeFeatureCenter[0] }} draggable
                      icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: 'white', fillOpacity: 1, strokeColor: '#F5C518', strokeWeight: 2.5 }}
                      onDragStart={(e: google.maps.MapMouseEvent) => { editCenterRef.current = { origCenter: [e.latLng!.lng(), e.latLng!.lat()], origVerts: [...currentReview.vertices] }; }}
                      onDrag={handleCenterDrag}
                      onDragEnd={() => { editCenterRef.current = null; }}
                    />
                    {activeTreeInfo && (
                      <Marker position={{ lat: activeTreeInfo.edgeVert[1], lng: activeTreeInfo.edgeVert[0] }} draggable
                        icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#F5C518', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 }}
                        onDrag={handleEdgeDrag} onDragEnd={() => {}}
                      />
                    )}
                    {(currentReview.type === 'house' || currentReview.type === 'hardscape' || currentReview.type === 'structure') &&
                      currentReview.vertices.map((v, i) => (
                        <Marker key={`evh-${currentReview.id}-${i}`} position={{ lat: v[1], lng: v[0] }} draggable
                          icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: 'white', fillOpacity: 1, strokeColor: '#F5C518', strokeWeight: 2 }}
                          onDragStart={() => { origVertsRef.current = [...currentReview.vertices]; }}
                          onDrag={(e: google.maps.MapMouseEvent) => handleVertexDrag(e, i)}
                          onDragEnd={() => { origVertsRef.current = []; }}
                        />
                      ))
                    }
                  </>)}
                  {/* Add-existing previews */}
                  {openStep === 'add_existing' && (<>
                    {eTreePreviewCoords && (<>
                      <Polygon paths={eTreePreviewCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                        options={{ fillColor: '#2F6B4F', fillOpacity: 0.2, strokeOpacity: 0, clickable: false }} />
                      <Polyline path={eTreePreviewCoords.map(v => ({ lat: v[1], lng: v[0] }))} options={dashedLine('#2F6B4F', 2)} />
                    </>)}
                    {eTreeCenter && addMode === 'tree' && (
                      <Marker position={{ lat: eTreeCenter[1], lng: eTreeCenter[0] }}
                        icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#2F6B4F', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 }}
                      />
                    )}
                    {ePolyFillCoords && (
                      <Polygon paths={ePolyFillCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                        options={{ fillColor: '#C77C5B', fillOpacity: 0.18, strokeColor: '#C77C5B', strokeWeight: 2, clickable: false }} />
                    )}
                    {ePolyLineCoords && (
                      <Polyline path={ePolyLineCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                        options={{ strokeColor: '#C77C5B', strokeWeight: 2, strokeOpacity: 0.8, clickable: false }} />
                    )}
                    {ePolyVerts.map((v, i) => (
                      <OverlayView key={`epv-${i}`} position={{ lat: v[1], lng: v[0] }} mapPaneName={OverlayView.OVERLAY_LAYER}
                        getPixelPositionOffset={() => ({ x: -4, y: -4 })}>
                        <div style={{ width: 8, height: 8, background: '#C77C5B', borderRadius: '50%', border: '2px solid white' }} />
                      </OverlayView>
                    ))}
                  </>)}
                </>)}

                {/* Door marker */}
                {doorPoint && (
                  <Marker
                    position={{ lat: doorPoint[1], lng: doorPoint[0] }}
                    draggable
                    icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#F5C518', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2.5 }}
                    onDrag={e => { if (e.latLng) setDoorPoint([e.latLng.lng(), e.latLng.lat()]); }}
                    onDragEnd={() => {}}
                  />
                )}

                {/* Boundary vertex drag handles — only editable on the draw step */}
                {openStep === 'boundary' && vertices.map((v, i) => (
                  <Marker key={`v-${i}`}
                    position={{ lat: v[1], lng: v[0] }}
                    draggable
                    icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: 'white', fillOpacity: 1, strokeColor: '#2F6B4F', strokeWeight: 2.5 }}
                    onDragStart={() => setDraggingIdx(i)}
                    onDrag={e => { if (e.latLng) setVertices(prev => prev.map((p, idx) => idx === i ? [e.latLng!.lng(), e.latLng!.lat()] : p)); }}
                    onDragEnd={() => setDraggingIdx(null)}
                  />
                ))}
              </GoogleMap>
            ) : (
              <div style={{ width: '100%', height: '100%', background: '#2A2A26' }} />
            )}

            {/* Done button */}
            {drawing && vertices.length >= 3 && (
              <button
                onClick={handleBoundaryDone}
                className="absolute flex items-center gap-2 px-5 py-2.5 rounded-full hover:opacity-90 transition-all"
                style={{ bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}>
                Done ✓
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Detecting overlay */}
      {detecting && (
        <div className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 500, background: 'rgba(20,20,18,0.4)', backdropFilter: 'blur(5px)' }}>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div className="flex flex-col items-center gap-3 rounded-2xl px-10 py-8"
            style={{ background: '#F4EAD2', boxShadow: '0 20px 60px rgba(0,0,0,0.22)' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', border: '2.5px solid rgba(42,42,38,0.1)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite' }} />
            <p style={{ fontFamily: IT, fontSize: '0.92rem', color: '#2A2A26', fontWeight: 500, margin: 0 }}>Analyzing your site…</p>
            <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', margin: 0 }}>Detecting trees, hardscape &amp; structures</p>
          </div>
        </div>
      )}

    </div>
  );
}
