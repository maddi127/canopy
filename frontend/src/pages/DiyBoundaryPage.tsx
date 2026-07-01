import { useState, useRef, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSaveAndExit } from '../hooks/useSaveAndExit';
import { GoogleMap, useJsApiLoader, Marker, Polygon, Polyline, OverlayView } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import IllustrativeSite from '../components/IllustrativeSite';
import { designProgress, DESIGN_STEP_TITLE } from '../lib/designProgress';
import { detectSiteFeatures } from '../services/geminiService';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

// Feet coordinate system from a boundary ring — IDENTICAL to IllustrativeSite's buildCS, so an
// affine computed here lines the illustration up exactly with the satellite at the user's zoom.
function buildCS(verts: [number, number][]) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats);
  const minLat = Math.min(...lats), maxLng = Math.max(...lngs);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return {
    widthFt: (maxLng - minLng) * mLng * FT,
    heightFt: (maxLat - minLat) * mLat * FT,
    toLngLat: (x: number, y: number): [number, number] => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
  };
}

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

// Display feature names in sentence case (only the first letter capitalized) to match /placement.
function toSentenceCase(s: string): string {
  if (!s) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

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
type AddMode   = 'tree' | 'hardscape' | 'structure' | 'house' | 'paving' | 'garden_bed' | 'utility' | 'walkway' | 'other' | null;
type ETreeStep = 'placing' | 'sizing';
type EPolyStep = 'drawing' | 'attributes';

const STEP_TITLE: Record<StepId, string> = {
  boundary:     'Draw area',
  identify:     'Mark existing features',
  add_existing: 'Add existing',
  door:         'Mark main entry',
};

export default function DiyBoundaryPage() {
  const navigate = useNavigate();
  const saveAndExit = useSaveAndExit();
  const mapRef   = useRef<google.maps.Map | null>(null);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const sc = useMemo<any>(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const center: [number, number] = [sc.lng ?? -104.99, sc.lat ?? 39.74];

  // Main entry ('door') informs auto-layout feature placement. Optional — it doesn't gate Continue.
  const visibleSteps: StepId[] = ['boundary', 'identify', 'door'];

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

  // Live refs so map event listeners never act on a stale boundary.
  const verticesRef = useRef(vertices); verticesRef.current = vertices;
  const drawingRef  = useRef(drawing);  drawingRef.current  = drawing;
  // Latest-closure refs for the natively-attached map dblclick listener.
  const handleBoundaryDoneRef = useRef<(() => void) | null>(null);
  const dblHandlerRef = useRef<((e: google.maps.MapMouseEvent) => void) | null>(null);

  // Persist the boundary (points → lines) on every change, including edits.
  useEffect(() => {
    const bd = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...bd, ring: vertices }));
  }, [vertices]);

  const boundaryDone = vertices.length >= 3 && !drawing;

  const areaSqFt = useMemo(() => {
    if (vertices.length < 3) return 0;
    try { return Math.round(turf.area(turf.polygon([[...vertices, vertices[0]]])) * 10.7639); } catch { return 0; }
  }, [vertices]);

  const perimeterFt = useMemo(() => {
    if (vertices.length < 3) return 0;
    try { return Math.round(turf.length(turf.lineString([...vertices, vertices[0]]), { units: 'feet' })); } catch { return 0; }
  }, [vertices]);

  // Per-edge length labels (rounded feet), at each segment midpoint.
  const segmentLabels = useMemo(() => {
    if (vertices.length < 2) return [] as { mid: [number, number]; ft: number }[];
    const pts = boundaryDone ? [...vertices, vertices[0]] : vertices;
    const out: { mid: [number, number]; ft: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let ft = 0;
      try { ft = Math.round(turf.length(turf.lineString([a, b]), { units: 'feet' })); } catch {}
      if (ft > 0) out.push({ mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ft });
    }
    return out;
  }, [vertices, boundaryDone]);

  // Reveal transition: on Continue, the illustrated plan draws over the map, the map fades, and we
  // slide into placement — so boundary → placement feels like one continuous page.
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const projOverlayRef = useRef<google.maps.OverlayView | null>(null);
  type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
  const [reveal, setReveal] = useState<{ w: number; h: number; start?: Affine } | null>(null);
  const [mapFade, setMapFade] = useState(false);
  const revealTimers = useRef<number[]>([]);
  useEffect(() => () => revealTimers.current.forEach(clearTimeout), []);
  const yardType: string = useMemo(() => {
    try {
      const s = JSON.parse(localStorage.getItem('siteContext') || '{}');
      const p = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      return s.yard_type ?? p.yard_type ?? '';
    } catch { return ''; }
  }, []);

  // ── Step ───────────────────────────────────────────────────────────────────
  // Open at a specific step when navigated back to (e.g. from placement → main entry).
  const location = useLocation();
  const [openStep, setOpenStep] = useState<StepId | null>(() => {
    const s = (location.state as { step?: StepId } | null)?.step;
    return s === 'door' || s === 'identify' ? s : 'boundary';
  });
  // Bumped on Re-draw to remount the map and clear any stale overlays.
  const [mapEpoch, setMapEpoch] = useState(0);
  // The live map instance, set in onLoad — used to manage feature overlays imperatively.
  const [mapObj, setMapObj] = useState<google.maps.Map | null>(null);

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
  const [decidedIds, setDecidedIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('diyDecidedFeatures') || '[]'); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem('diyDecidedFeatures', JSON.stringify(decidedIds)); }, [decidedIds]);
  const decidedSet      = useMemo(() => new Set(decidedIds), [decidedIds]);
  const liveFeatures    = useMemo(() => features.filter(f => f.keep !== false), [features]);
  const deletedFeatures = useMemo(() => features.filter(f => f.keep === false), [features]);
  const reviewedCount   = reviewQueue.filter(f => decidedSet.has(f.id)).length;
  const identifyDone    = reviewQueue.every(f => decidedSet.has(f.id));

  // The active detected feature is the one editable on the map.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const currentReview = useMemo(() => features.find(f => f.id === activeId) ?? null, [features, activeId]);

  // Auto-advance the active feature to the next un-decided, non-deleted one.
  useEffect(() => {
    const stillValid = activeId && liveFeatures.some(f => f.id === activeId && !decidedSet.has(f.id));
    if (!stillValid) {
      const next = liveFeatures.find(f => !decidedSet.has(f.id));
      setActiveId(next ? next.id : null);
    }
  }, [activeId, liveFeatures, decidedSet]);


  const [doorPoint, setDoorPoint] = useState<[number, number] | null>(() => {
    try { return JSON.parse(localStorage.getItem('diyDoorPoint') || 'null'); } catch { return null; }
  });
  useEffect(() => {
    if (doorPoint) localStorage.setItem('diyDoorPoint', JSON.stringify(doorPoint));
    else localStorage.removeItem('diyDoorPoint');
  }, [doorPoint]);

  // Continue once the area is drawn and every feature is confirmed/deleted.
  // (Door marking is hidden for now, so it no longer gates Continue.)
  const canContinue = boundaryDone && identifyDone;

  const resolveFeature = useCallback((id: string, decision: 'keep' | 'remove' | 'not_real') => {
    setFeatures(prev =>
      decision === 'not_real'
        ? prev.filter(f => f.id !== id)
        : prev.map(f => f.id === id ? { ...f, keep: decision === 'keep' } : f),
    );
    if (decision === 'not_real') setDecidedIds(prev => prev.filter(x => x !== id));
    else setDecidedIds(prev => prev.includes(id) ? prev : [...prev, id]);
  }, []);

  // Bring an X'd-out feature back into the list as confirmed.
  const restoreFeature = useCallback((id: string) => {
    setFeatures(prev => prev.map(f => f.id === id ? { ...f, keep: true } : f));
    setDecidedIds(prev => prev.includes(id) ? prev : [...prev, id]);
  }, []);

  // Re-open a confirmed feature for editing.
  const reactivateFeature = useCallback((id: string) => {
    setDecidedIds(prev => prev.filter(x => x !== id));
    setActiveId(id);
  }, []);

  // ── Add-existing ─────────────────────────────────────────────────────────────
  const [addMode,         setAddMode]         = useState<AddMode>(null);
  const [addPickerOpen,   setAddPickerOpen]   = useState(false);
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
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'tree' as const, keep: true, source: 'added' as const,
      vertices: ring, label: 'Tree', attributes: {},
    }]);
    setDecidedIds(prev => [...prev, id]);
    cancelAdd();
  }, [eTreeCenter, eTreeRadiusKm, cancelAdd]);

  const confirmAddHardscape = useCallback(() => {
    if (ePolyVerts.length < 3 || !eSurface) return;
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'hardscape' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: `Hardscape — ${eSurface}`, attributes: { surfaceType: eSurface },
    }]);
    setDecidedIds(prev => [...prev, id]);
    cancelAdd();
  }, [ePolyVerts, eSurface, cancelAdd]);

  const confirmAddStructure = useCallback(() => {
    if (ePolyVerts.length < 3) return;
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'structure' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: eStructureLabel.trim() || 'Other', attributes: {},
    }]);
    setDecidedIds(prev => [...prev, id]);
    cancelAdd();
  }, [ePolyVerts, eStructureLabel, cancelAdd]);

  const SIMPLE_POLY_CONFIG: Record<string, { type: ConfirmedFeature['type']; label: string }> = {
    structure:  { type: 'structure', label: 'Structure' },
    walkway:    { type: 'hardscape', label: 'Walkway'   },
    house:      { type: 'house',     label: 'House'      },
    paving:     { type: 'hardscape', label: 'Paving'     },
    garden_bed: { type: 'hardscape', label: 'Garden bed' },
    utility:    { type: 'structure', label: 'Utility'    },
  };

  const confirmAddSimplePoly = useCallback(() => {
    if (ePolyVerts.length < 3 || !addMode || !(addMode in SIMPLE_POLY_CONFIG)) return;
    const cfg = SIMPLE_POLY_CONFIG[addMode];
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: cfg.type, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: cfg.label, attributes: {},
    }]);
    setDecidedIds(prev => [...prev, id]);
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
    () => new Set(reviewQueue.filter(f => !decidedSet.has(f.id)).map(f => f.id)),
    [reviewQueue, decidedSet],
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
    features: reviewQueue.filter(f => !decidedSet.has(f.id) && f.id !== activeId && f.keep !== false && f.vertices.length >= 3)
      .map(f => ({ type: 'Feature' as const, properties: { id: f.id }, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [reviewQueue, decidedSet, activeId]);

  const cfActiveGeoJSON = useMemo(() => {
    if (!currentReview || currentReview.keep === false || currentReview.vertices.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...currentReview.vertices, currentReview.vertices[0]]] } };
  }, [currentReview]);

  const eTreePreviewCoords = useMemo<[number, number][] | null>(() => {
    if (addMode !== 'tree' || openStep !== 'identify') return null;
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

  const showConfirmedFeatures = features.length > 0 && !drawing;

  // ── Imperative feature outlines ──────────────────────────────────────────────
  // @react-google-maps doesn't reliably update or remove <Polygon>/<Polyline>
  // overlays, leaving moved/deleted features ghosted at their old spot. We draw
  // the feature outlines directly on the map and clean them up on every change.
  useEffect(() => {
    if (!mapObj || !showConfirmedFeatures) return;
    const overlays: (google.maps.Polyline | google.maps.Polygon)[] = [];
    // Reviewed & kept — solid coloured outline.
    cfKeepGeoJSON.features.forEach((f) => {
      const color = FEATURE_COLOR[f.properties.featureType] ?? '#2F6B4F';
      overlays.push(new google.maps.Polyline({ map: mapObj, path: toPath(f.geometry.coordinates[0]), strokeColor: color, strokeWeight: 2.5, strokeOpacity: 1, clickable: false }));
    });
    if (openStep === 'identify') {
      // Pending (not yet reviewed) — faint fill + dashed outline.
      cfPendingGeoJSON.features.forEach((f) => {
        const path = toPath(f.geometry.coordinates[0]);
        overlays.push(new google.maps.Polygon({ map: mapObj, paths: path, fillColor: '#FFFFFF', fillOpacity: 0.08, strokeOpacity: 0, clickable: false }));
        overlays.push(new google.maps.Polyline({ map: mapObj, path, ...dashedLine('#FFFFFF', 2), clickable: false }));
      });
      // Active — yellow highlight.
      if (cfActiveGeoJSON) {
        const path = toPath(cfActiveGeoJSON.geometry.coordinates[0]);
        overlays.push(new google.maps.Polygon({ map: mapObj, paths: path, fillColor: '#F5C518', fillOpacity: 0.38, strokeOpacity: 0, clickable: false }));
        overlays.push(new google.maps.Polyline({ map: mapObj, path, strokeColor: '#F5C518', strokeWeight: 7, strokeOpacity: 0.35, clickable: false }));
        overlays.push(new google.maps.Polyline({ map: mapObj, path, strokeColor: '#FFFFFF', strokeWeight: 2.5, clickable: false }));
      }
    }
    return () => { overlays.forEach((o) => o.setMap(null)); };
  }, [mapObj, cfKeepGeoJSON, cfPendingGeoJSON, cfActiveGeoJSON, openStep, showConfirmedFeatures]);

  const goToPlacement = useCallback(() => {
    if (vertices.length < 3) return;
    localStorage.setItem('diyBoundaryFinal', JSON.stringify({
      boundary:          vertices,
      confirmedFeatures: features.filter(f => f.keep),
      doorPoint,
    }));
    // In-page reveal: draw the plan ALIGNED to the live satellite (to-scale at the user's zoom),
    // fade the map out, then zoom + rotate into placement.
    const box = mapBoxRef.current;
    const w = box?.clientWidth ?? 900, h = box?.clientHeight ?? 600;
    let start: Affine | undefined;
    const ov = projOverlayRef.current, proj = ov?.getProjection?.();
    if (proj && vertices.length >= 3) {
      const cs = buildCS(vertices);
      const toPt = (xFt: number, yFt: number) => { const [lng, lat] = cs.toLngLat(xFt, yFt); return proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng)); };
      const a0 = toPt(0, 0), bx = toPt(cs.widthFt, 0), by = toPt(0, cs.heightFt);
      if (a0 && bx && by) {
        const sx = Math.hypot(bx.x - a0.x, bx.y - a0.y) / Math.max(cs.widthFt, 1e-6);
        const sy = Math.hypot(by.x - a0.x, by.y - a0.y) / Math.max(cs.heightFt, 1e-6);
        const s = (sx + sy) / 2;
        start = { a: s, b: 0, c: 0, d: s, e: a0.x, f: a0.y };
      }
    }
    setReveal({ w, h, start });
    revealTimers.current.push(window.setTimeout(() => setMapFade(true), 2500)); // fade map once it's drawn over, before the zoom/rotate
  }, [vertices, features, doorPoint]);

  // ── Map handlers ─────────────────────────────────────────────────────────────
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (draggingIdx !== null || !e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    if (drawing) { setVertices(v => [...v, [lng, lat]]); return; }
    if (openStep === 'door') { setDoorPoint([lng, lat]); return; }
    if (openStep === 'identify') {
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
  }, [drawing, draggingIdx, openStep, addMode, isPolyAddMode, eTreeStep, eTreeCenter, ePolyStep, confirmAddTree]);

  const handleBoundaryDone = useCallback(() => {
    if (!drawingRef.current || verticesRef.current.length < 3) return;
    setDrawing(false);
    const snap = verticesRef.current;
    const bd = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...bd, ring: snap }));
    const gen = ++detectGenRef.current;
    setDetecting(true);
    setFeatures([]); setDecidedIds([]);
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
        const newFeats = allFeats.flatMap<ConfirmedFeature>(f => {
          if (f.vertices.length < 3) return [];
          try {
            const featPoly = turf.polygon([[...f.vertices, f.vertices[0]]]);
            // Trees (full canopy) and houses (full footprint) are not clipped; keep if inside or near the edge.
            if (f.type === 'tree' || f.type === 'house') {
              if (turf.booleanIntersects(boundaryPoly, featPoly)) return [f];
              const center = turf.centroid(featPoly).geometry.coordinates as [number, number];
              const nearest = turf.nearestPointOnLine(boundaryRing, turf.point(center));
              return turf.distance(turf.point(center), nearest, { units: 'feet' }) <= 10 ? [f] : [];
            }
            // Everything else: clip to only the portion inside the boundary.
            const clipped = turf.intersect(featPoly, boundaryPoly);
            if (!clipped) return [];
            const geom = clipped.geometry;
            const outerRings: number[][][] =
              geom.type === 'Polygon'      ? [geom.coordinates[0] as number[][]]
            : geom.type === 'MultiPolygon' ? (geom.coordinates as number[][][][]).map(p => p[0])
            : [];
            return outerRings
              .map(r => (r as [number, number][]).slice(0, -1))
              .filter(r => r.length >= 3)
              .map((r, i) => ({ ...f, id: i === 0 ? f.id : `${f.id}_${i}`, vertices: r }));
          } catch { return [f]; }
        });
        localStorage.setItem('diyDetectedFeatures', JSON.stringify(newFeats));
        setFeatures(newFeats);
        setDecidedIds([]);
      })
      .catch(() => {})
      .finally(() => { setDetecting(false); if (detectGenRef.current === gen) setOpenStep('identify'); });
  }, []);
  handleBoundaryDoneRef.current = handleBoundaryDone;
  dblHandlerRef.current = (e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    // Finish an added feature polygon.
    if (openStep === 'identify' && isPolyAddMode && ePolyStep === 'drawing' && ePolyVerts.length >= 3) {
      if (addMode === 'other') setEPolyStep('attributes');
      else confirmAddSimplePoly();
      return;
    }
    // Insert a movable vertex on the active feature's edge.
    if (openStep === 'identify' && addMode === null && currentReview && currentReview.type !== 'tree' && currentReview.vertices.length >= 3) {
      try {
        const ring = [...currentReview.vertices, currentReview.vertices[0]];
        const snapped = turf.nearestPointOnLine(turf.lineString(ring), turf.point([lng, lat]), { units: 'feet' });
        if ((snapped.properties.dist ?? 999) <= 20) {
          const insertAt = (snapped.properties.index ?? 0) + 1;
          const pt = snapped.geometry.coordinates as [number, number];
          updateCurrentFeature(f => {
            const verts = [...f.vertices];
            verts.splice(Math.min(insertAt, verts.length), 0, pt);
            return { ...f, vertices: verts };
          });
        }
      } catch {}
    }
  };

  const handleMouseMove = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    if (drawing || (openStep === 'identify' && addMode !== null))
      setMousePos([e.latLng.lng(), e.latLng.lat()]);
  }, [drawing, openStep, addMode]);

  const resetBoundary = () => {
    detectGenRef.current += 1;
    setDetecting(false);
    setVertices([]); setDrawing(true); setMousePos(null);
    setOpenStep('boundary');
    setFeatures([]); setDecidedIds([]); setActiveId(null); cancelAdd();
    setMapEpoch(e => e + 1);
    localStorage.setItem('diyBoundary', JSON.stringify({ ring: [] }));
    localStorage.setItem('diyConfirmedFeatures', '[]');
    localStorage.setItem('diyDetectedFeatures', '[]');
    localStorage.setItem('diyDecidedFeatures', '[]');
    localStorage.removeItem('diyIdentifyDone');
    localStorage.removeItem('diyLayout');
    localStorage.removeItem('diyDoorPoint');
    setDoorPoint(null);
  };

  const mapCursor = (drawing || openStep === 'door' || (openStep === 'identify' && addMode !== null)) ? 'crosshair' : undefined;

  // ── Render ───────────────────────────────────────────────────────────────────
  const bProg = designProgress(openStep);
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#F4F0E6', overflow: 'hidden' }}>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-full h-full overflow-hidden" style={{ background: '#F4F0E6' }}>

        {/* ── Left sidebar ── */}
        <div className="flex flex-col flex-shrink-0" style={{ width: '34%', minWidth: 380, maxWidth: 540, height: '100%', background: '#F4F0E6', overflow: 'hidden', borderRight: '1px solid rgba(42,42,38,0.1)' }}>

          <div className="flex-shrink-0" style={{ padding: '1.6rem 1.9rem 1.1rem' }}>
            <div className="flex items-center justify-between">
              <Logo />
              <button onClick={saveAndExit}
                style={{ fontFamily: IT, fontSize: '0.8rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
                Save &amp; exit ↗
              </button>
            </div>
            <div style={{ marginTop: '1.7rem' }}>
              <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Step {bProg.num} of {bProg.total}</span>
              <h1 style={{ fontFamily: IS, fontSize: '1.9rem', color: '#2A2A26', margin: '0.3rem 0 0', lineHeight: 1.05, fontWeight: 400, fontStyle: 'italic' }}>{DESIGN_STEP_TITLE[(openStep ?? 'boundary') as keyof typeof DESIGN_STEP_TITLE] ?? 'Define your project area'}</h1>
              <div style={{ height: 3, marginTop: '1rem', background: 'rgba(42,42,38,0.1)', borderRadius: 999 }}>
                <div style={{ height: '100%', borderRadius: 999, background: '#2F6B4F', transition: 'width 0.4s', width: `${bProg.pct}%` }} />
              </div>
            </div>
          </div>

          {/* Scrollable section */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

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

                // Linear flow: no accordion headers — only the current step's content shows, and the
                // sidebar header (Step X of N + title + global progress bar) tracks where we are.
                void stepNum; void isAddExist; void isDone; void isLocked;
                return (
                  <div key={stepId}>

                    {/* Boundary step */}
                    {isBoundary && isOpen && (
                      <div className="px-7 pb-2 pt-5 flex flex-col gap-4">
                        <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                          {boundaryDone
                            ? 'Trace the outline of your project area.'
                            : 'Trace the outline of your project area.'}
                        </p>
                        {boundaryDone ? (
                          <>
                            <div className="rounded-xl p-3 flex gap-6" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              <div className="flex flex-col gap-0.5">
                                <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Area</span>
                                <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{areaSqFt.toLocaleString()} <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92' }}>sq ft</span></span>
                              </div>
                              {perimeterFt > 0 && (
                                <div className="flex flex-col gap-0.5">
                                  <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Perimeter</span>
                                  <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{perimeterFt.toLocaleString()} <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92' }}>ft</span></span>
                                </div>
                              )}
                            </div>
                            <button onClick={resetBoundary}
                              className="self-start px-4 py-2 rounded-full hover:opacity-80 transition-all"
                              style={{ border: '1.5px solid rgba(42,42,38,0.2)', background: 'none', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#2A2A26', cursor: 'pointer' }}>
                              Re-draw
                            </button>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3">
                            <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92', lineHeight: 1.5 }}>
                              {drawing
                                ? vertices.length < 3 ? `${3 - vertices.length} more points needed` : 'Click “Done” to close'
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
                      <div className="px-7 pb-2 pt-5 flex flex-col gap-4">
                        {reviewQueue.length === 0 ? (
                          <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                            We didn't detect any existing features in your project area.
                          </p>
                        ) : currentReview ? (
                          <>
                            <div className="flex flex-col gap-2.5">
                              <div className="flex items-baseline gap-2">
                                <div style={{ width: 12, height: 12, borderRadius: 3, background: FEATURE_COLOR[currentReview.type] ?? '#9A9A92', flexShrink: 0, alignSelf: 'center' }} />
                                <h2 style={{ fontFamily: IS, fontSize: '1.8rem', color: '#2A2A26', margin: 0, fontWeight: 400, lineHeight: 1.05 }}>{toSentenceCase(currentReview.label || currentReview.type)}</h2>
                                <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontWeight: 500, flexShrink: 0 }}>{Math.min(reviewedCount + 1, reviewQueue.length)} of {reviewQueue.length}</span>
                              </div>
                              <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                                We detected {currentReview.type === 'tree' ? 'a tree' : currentReview.type === 'hardscape' ? 'a paved area' : currentReview.type === 'house' ? 'a building' : 'a structure'} here. Confirm it, edit it on the map, or remove it if it isn't there.
                              </p>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => resolveFeature(currentReview.id, 'keep')}
                                className="flex-1 py-2.5 rounded-full transition-all hover:opacity-90"
                                style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                Confirm
                              </button>
                              <button onClick={() => resolveFeature(currentReview.id, 'remove')}
                                className="flex-1 py-2.5 rounded-full transition-all hover:opacity-90"
                                style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
                                Remove
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                              All {reviewQueue.length} feature{reviewQueue.length !== 1 ? 's' : ''} reviewed. Tap one to revisit it.
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {reviewQueue.filter(f => f.keep !== false).map(f => (
                                <button key={f.id} onClick={() => reactivateFeature(f.id)}
                                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all hover:opacity-90"
                                  style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.14)' }}>
                                  <span style={{ width: 9, height: 9, borderRadius: 2, background: FEATURE_COLOR[f.type] ?? '#9A9A92' }} />
                                  {toSentenceCase(f.label || f.type)}
                                </button>
                              ))}
                            </div>
                          </>
                        )}

                        {deletedFeatures.length > 0 && (
                          <div className="flex flex-col gap-1.5">
                            <button onClick={() => setShowDeleted(s => !s)}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', fontWeight: 500 }}>
                              <span>{showDeleted ? '▾' : '▸'}</span>
                              Removed ({deletedFeatures.length})
                            </button>
                            {showDeleted && deletedFeatures.map(f => (
                              <div key={f.id} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.04)' }}>
                                <div style={{ width: 18, height: 18, borderRadius: 4, flexShrink: 0, opacity: 0.5, background: FEATURE_COLOR[f.type] ?? '#9A9A92' }} />
                                <span style={{ flex: 1, minWidth: 0, fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {toSentenceCase(f.label || f.type)}
                                </span>
                                <button onClick={() => restoreFeature(f.id)}
                                  style={{ flexShrink: 0, background: 'none', border: '1.5px solid rgba(42,42,38,0.2)', borderRadius: 100, padding: '3px 10px', cursor: 'pointer', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, color: '#2A2A26' }}>
                                  Restore
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Door step */}
                    {isDoor && isOpen && boundaryDone && (
                      <div className="flex flex-col gap-4 px-7 pb-2 pt-5">
                        <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                          Click on the map to mark the main entry from your house into the yard. If you have multiple doors, mark the one you use most.
                        </p>
                        {doorPoint && (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26', flex: 1 }}>Door marked</span>
                              <button onClick={() => setDoorPoint(null)}
                                style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                            </div>
                            <span style={{ fontFamily: IT, fontSize: '0.71rem', color: '#9A9A92' }}>Click again on the map to reposition.</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Add-more step (shown once detected features are marked) */}
                    {isIdentify && isOpen && boundaryDone && identifyDone && (
                      <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: reviewQueue.length > 0 ? '1px solid rgba(42,42,38,0.08)' : 'none' }}>
                        {addMode === null ? (
                          <div className="flex flex-col gap-3 pt-3">
                            {!addPickerOpen ? (
                              <button onClick={() => setAddPickerOpen(true)}
                                className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                                style={{ width: '100%', background: 'rgba(42,42,38,0.04)', border: '1.5px dashed rgba(42,42,38,0.18)', cursor: 'pointer' }}>
                                <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500 }}>Something missing? Add another feature</span>
                                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}>+</span>
                              </button>
                            ) : (
                              <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', fontWeight: 500 }}>What did we miss?</span>
                                  <button onClick={() => setAddPickerOpen(false)}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                </div>
                                <div className="flex flex-col gap-2">
                                  {([
                                    { mode: 'tree'      as const, label: 'Tree',      color: '#5C8A5C', shape: 'circle' as const },
                                    { mode: 'structure' as const, label: 'Structure', color: '#9A8B78', shape: 'rect'   as const },
                                    { mode: 'walkway'   as const, label: 'Walkway',   color: '#B5A48B', shape: 'rect'   as const },
                                    { mode: 'other'     as const, label: 'Other',     color: '#9A9A92', shape: 'rect'   as const },
                                  ]).map(({ mode, label, color, shape }) => (
                                    <button key={label} onClick={() => { startAdd(mode); setAddPickerOpen(false); }}
                                      className="flex items-center gap-3 rounded-2xl p-3 hover:opacity-90 transition-all"
                                      style={{ width: '100%', background: 'white', border: '1.5px solid transparent', cursor: 'pointer', textAlign: 'left' }}>
                                      <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: shape === 'circle' ? '50%' : 6, background: color }} />
                                      <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 600 }}>{label}</span>
                                    </button>
                                  ))}
                                </div>
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
                        ) : addMode === 'other' && ePolyStep === 'attributes' ? (
                          <div className="flex flex-col gap-3 pt-3">
                            <div className="flex items-center justify-between">
                              <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>What is it?</span>
                              <button onClick={cancelAdd} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ cancel</button>
                            </div>
                            <input autoFocus type="text" placeholder="Patio, pond, fence…" value={eStructureLabel}
                              onChange={e => setEStructureLabel(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') confirmAddStructure(); }}
                              className="rounded-xl px-3 py-2"
                              style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', outline: 'none' }} />
                            <button onClick={confirmAddStructure}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Add feature →
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-3 pt-3">
                            <button onClick={cancelAdd} style={{ alignSelf: 'flex-start', fontFamily: IT, fontSize: '0.75rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕ Cancel</button>
                            {isPolyAddMode && ePolyVerts.length > 0 && (
                              <button onClick={() => setEPolyVerts(v => v.slice(0, -1))}
                                style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
                                Undo last point
                              </button>
                            )}
                            {isPolyAddMode && ePolyVerts.length >= 3 && (
                              <button onClick={() => { if (addMode === 'other') setEPolyStep('attributes'); else confirmAddSimplePoly(); }}
                                className="rounded-full py-2.5 hover:opacity-90 transition-all"
                                style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                Finish shape →
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

          {/* Sidebar footer: back + continue */}
          {(() => {
            const order = visibleSteps;                                   // boundary → identify → door
            const i = Math.max(0, order.indexOf(openStep ?? 'boundary'));
            const last = i >= order.length - 1;                           // 'door' = last boundary step
            const ready = openStep === 'boundary' ? boundaryDone : openStep === 'identify' ? identifyDone : openStep === 'door' ? doorPoint !== null : true;
            const busy = reveal !== null;                                  // reveal animation in progress
            return (
              <div className="flex-shrink-0 flex items-center gap-2.5 justify-between" style={{ padding: '1rem 1.9rem 1.6rem', borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <button disabled={busy} onClick={() => i > 0 ? setOpenStep(order[i - 1]) : navigate('/diy/preferences', { state: { step: 5 } })}
                  className="rounded-full px-6 py-3 transition-all hover:opacity-90 disabled:opacity-40"
                  style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: busy ? 'default' : 'pointer' }}>
                  ← Back
                </button>
                <button onClick={() => { if (busy) return; if (last) goToPlacement(); else if (ready) setOpenStep(order[i + 1]); }} disabled={!ready || busy}
                  className="px-6 flex items-center justify-center gap-2 py-3 rounded-full transition-all hover:opacity-90 disabled:opacity-70"
                  style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: 'none', cursor: (ready && !busy) ? 'pointer' : 'default' }}>
                  {busy ? (
                    <>
                      <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', animation: 'spin 0.8s linear infinite' }} />
                      Preparing your plan…
                    </>
                  ) : 'Continue →'}
                </button>
              </div>
            );
          })()}

        </div>

        {/* ── Right: map ── */}
        <div className="flex-1 overflow-hidden">
          <div ref={mapBoxRef} className="w-full h-full overflow-hidden relative" style={{ cursor: mapCursor }}>
            {/* Reveal: illustrated plan draws over the live map, then the map fades out beneath it. */}
            {reveal && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: mapFade ? '#EFE9DA' : 'transparent', transition: 'background 1s ease' }}>
                <IllustrativeSite width={reveal.w} height={reveal.h} animate startTransform={reveal.start} finishOrientation={{ yardType }} onComplete={() => navigate('/diy/auto-layout')} />
              </div>
            )}
            {isLoaded ? (
              <GoogleMap
                key={mapEpoch}
                mapContainerStyle={{ width: '100%', height: '100%' }}
                center={{ lat: center[1], lng: center[0] }}
                zoom={22}
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
                onMouseMove={handleMouseMove}
                onLoad={map => {
                  mapRef.current = map; setMapObj(map);
                  const ov = new google.maps.OverlayView();
                  ov.onAdd = () => {}; ov.onRemove = () => {}; ov.draw = () => {};
                  ov.setMap(map); projOverlayRef.current = ov;
                  map.addListener('dblclick', (ev: google.maps.MapMouseEvent) => dblHandlerRef.current?.(ev));
                }}
                onUnmount={() => { setMapObj(null); projOverlayRef.current?.setMap(null); projOverlayRef.current = null; }}
              >
                {/* Boundary polygon */}
                {vertices.length >= 3 && (
                  <Polygon
                    paths={[...vertices, vertices[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ fillColor: '#2F6B4F', fillOpacity: 0.06, strokeColor: '#2F6B4F', strokeWeight: 2.5, strokeOpacity: 1, clickable: false }}
                  />
                )}

                {/* Segment footage labels */}
                {segmentLabels.map((s, i) => (
                  <OverlayView key={`seg-${i}`} position={{ lat: s.mid[1], lng: s.mid[0] }} mapPaneName={OverlayView.OVERLAY_LAYER}
                    getPixelPositionOffset={(w, h) => ({ x: -(w ?? 0) / 2, y: -(h ?? 0) / 2 })}>
                    <div style={{ color: '#FFFFFF', fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', textShadow: '1px 1px 0 #2F6B4F, -1px 1px 0 #2F6B4F, 1px -1px 0 #2F6B4F, -1px -1px 0 #2F6B4F, 0 0 2px #2F6B4F' }}>
                      {s.ft} ft
                    </div>
                  </OverlayView>
                ))}

                {/* Boundary draw preview */}
                {drawing && mousePos && vertices.length > 0 && (
                  <Polyline
                    path={[...vertices, mousePos].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine('#2F6B4F'), clickable: false }}
                  />
                )}

                {/* Confirmed existing-site features */}
                {showConfirmedFeatures && (<>
                  {/* Feature outlines (kept / pending / active) are drawn imperatively — see effect above */}
                  {/* Edit handles */}
                  {openStep === 'identify' && currentReview && currentReview.keep !== false && activeFeatureCenter && (<>
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
                    {currentReview.type !== 'tree' &&
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
                  {openStep === 'identify' && (<>
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

                {/* Main-entry marker — shown whenever one is marked, on every step (click the map on
                    the entry step to move it). Rendered as a DOM overlay so it always appears. */}
                {doorPoint && (
                  <OverlayView position={{ lat: doorPoint[1], lng: doorPoint[0] }} mapPaneName={OverlayView.OVERLAY_LAYER}
                    getPixelPositionOffset={() => ({ x: 0, y: 0 })}>
                    <div style={{ transform: 'translate(-50%, -50%)', width: 20, height: 20, borderRadius: '50%', background: '#F5C518', border: '2.5px solid white', boxShadow: '0 1px 5px rgba(0,0,0,0.35)' }} />
                  </OverlayView>
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

            {/* Done — closes the project area (shown while drawing with 3+ points) */}
            {drawing && vertices.length >= 3 && (
              <button onClick={handleBoundaryDone}
                className="absolute flex items-center gap-2 px-5 py-2.5 rounded-full hover:opacity-90 transition-all"
                style={{ top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}>
                Done
              </button>
            )}

            {/* Drawing instruction — shown at the top of the map while adding a feature */}
            {addMode !== null && ePolyStep !== 'attributes' && (
              <div className="absolute px-5 py-2.5 rounded-full"
                style={{ top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', maxWidth: 'calc(100% - 32px)', whiteSpace: 'nowrap', textAlign: 'center' }}>
                {addMode === 'tree'
                  ? eTreeStep === 'placing' ? 'Click the map to place the tree center.'
                    : 'Click again to set the canopy size.'
                  : ePolyVerts.length === 0 ? 'Click to start the outline.'
                  : ePolyVerts.length < 3 ? `${3 - ePolyVerts.length} more point${3 - ePolyVerts.length !== 1 ? 's' : ''} needed.`
                  : 'Add corners, then tap Finish.'}
              </div>
            )}

          </div>
        </div>

        </div>{/* card wrapper */}
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
