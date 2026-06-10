import { useState, useRef, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Marker, Polygon, Polyline, OverlayView } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import { detectSiteFeatures } from '../services/geminiService';
import { computeSunModel, type SunModelResult } from '../services/sunModelingService';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

const MATERIAL_COLORS: Record<string, string> = {
  'Mulch': '#8B5E3C', 'Bark': '#7A5230', 'Rocks / Gravel': '#8A8A82',
  'River Rock': '#9A9A8A', 'Pine Straw': '#B8905A',
  'Concrete': '#A8A898', 'Pavers': '#C4956A', 'Gravel': '#B0A890',
  'Stepping Stones': '#8A7A6A', 'Flagstone': '#9A8870', 'Decomposed Granite': '#C4A882',
  'Deck / Wood': '#9B7D3A', 'Wood / Composite': '#9B7D3A', 'IPE': '#5A4A2A',
  'Grass': '#5A9E62', 'Rubber': '#4A4A4A',
  'Soil / Mulch': '#6B4A2A', 'Straw': '#C8A860',
};

const FEATURE_COLOR = '#C77C5B';

const SURFACE_TYPES = ['Concrete', 'Pavers', 'Gravel', 'Asphalt', 'Wood / Deck', 'Flagstone', 'Other'];

const FILL_OPTIONS = [
  { id: 'grass',       label: 'Grass',       sub: 'lawn / turf',   color: '#5A9E62', plantable: false },
  { id: 'rocks',       label: 'Rocks',       sub: 'low water',     color: '#B0A890', plantable: true  },
  { id: 'mulch',       label: 'Mulch',       sub: 'natural beds',  color: '#8B5E3C', plantable: true  },
  { id: 'groundcover', label: 'Groundcover', sub: 'ecological',    color: '#4A7C59', plantable: true  },
] as const;


const PLACEABLE_FEATURES: Record<string, { label: string; icon: string; color: string; defaultShape: ShapeType }> = {
  seating:          { label: 'Seating area',    icon: '🪑', color: '#C77C5B', defaultShape: 'rectangle' },
  dining:           { label: 'Dining area',      icon: '🍽', color: '#C77C5B', defaultShape: 'rectangle' },
  cooking:          { label: 'Grill area',       icon: '🔥', color: '#B05A3A', defaultShape: 'rectangle' },
  fire_pit:         { label: 'Fire pit',         icon: '🪵', color: '#B05A3A', defaultShape: 'circle'    },
  play_area:        { label: 'Play area',        icon: '⚽', color: '#D4A044', defaultShape: 'rectangle' },
  vegetable_garden: { label: 'Veg. garden',      icon: '🥕', color: '#4A7C59', defaultShape: 'rectangle' },
  water_feature:    { label: 'Water feature',    icon: '💧', color: '#4A8FB5', defaultShape: 'circle'    },
  pool:             { label: 'Pool',             icon: '🏊', color: '#3A7FA0', defaultShape: 'custom'    },
  hot_tub:          { label: 'Hot tub',          icon: '♨',  color: '#3A7FA0', defaultShape: 'circle'    },
  planting_bed:     { label: 'Planting bed',     icon: '🌿', color: '#4A7C59', defaultShape: 'rectangle' },
  shed:             { label: 'Shed',             icon: '🏚', color: '#8B6A3E', defaultShape: 'rectangle' },
};


function toPath(coords: number[][]): google.maps.LatLngLiteral[] {
  return coords.map(c => ({ lat: c[1], lng: c[0] }));
}

function resolveToolColor(featureId: string, material?: string): string {
  if (material && MATERIAL_COLORS[material]) return MATERIAL_COLORS[material];
  if (featureId === 'tree')          return '#2F6B4F';
  if (featureId === 'planting_bed')  return '#4A7C59';
  if (featureId === 'water_feature') return '#4A8FB5';
  if (featureId === 'pool')          return '#3A7FA0';
  if (featureId === 'patio')         return '#C77C5B';
  if (featureId === 'shed')          return '#8B6A3E';
  return FEATURE_COLOR;
}

type DrawMode        = 'shape' | 'brush';
type ShapeType       = 'rectangle' | 'square' | 'circle' | 'custom';
type StepId          = 'boundary' | 'identify' | 'add_existing' | 'new_features';
type AddMode         = 'tree' | 'hardscape' | 'structure' | null;
type IdentifySubStep = 'features' | 'street_side';
type ETreeStep = 'placing' | 'sizing';
type EPolyStep = 'drawing' | 'attributes';

type TreeSize = 'xs' | 's' | 'm' | 'l';
const TREE_SIZES: { id: TreeSize; label: string; diameterFt: number }[] = [
  { id: 'xs', label: 'XS', diameterFt: 5  },
  { id: 's',  label: 'S',  diameterFt: 10 },
  { id: 'm',  label: 'M',  diameterFt: 20 },
  { id: 'l',  label: 'L',  diameterFt: 40 },
];
const TREE_SIZE_RADIUS_KM: Record<TreeSize, number> = {
  xs: (8  / 2) * 0.3048 / 1000,
  s:  (15 / 2) * 0.3048 / 1000,
  m:  (25 / 2) * 0.3048 / 1000,
  l:  (40 / 2) * 0.3048 / 1000,
};

const STEP_TITLE: Record<StepId, string> = {
  boundary:     'Draw area',
  identify:     'Confirm existing',
  add_existing: 'Add existing',
  new_features: 'New features',
};

interface FeatureZone {
  id: string;
  toolId: string;
  label: string;
  color: string;
  vertices: [number, number][];
  existing?: boolean; // true = existing, false = new; undefined = not applicable
  planted?: boolean;  // true = user wants plants placed here (fill zones only)
}

function extractLargestRing(geom: turf.Polygon | turf.MultiPolygon): [number, number][] | null {
  if (geom.type === 'Polygon') {
    const ring = geom.coordinates[0] as [number, number][];
    return ring.length > 1 ? ring.slice(0, -1) : null;
  }
  let maxArea = 0, best: [number, number][] | null = null;
  for (const poly of geom.coordinates) {
    try {
      const a = turf.area(turf.polygon([poly[0]]));
      if (a > maxArea) { maxArea = a; best = poly[0] as [number, number][]; }
    } catch {}
  }
  return best ? best.slice(0, -1) : null;
}

// Helper: dashed polyline options for Google Maps
function dashedLine(color: string, weight = 2): google.maps.PolylineOptions {
  return {
    strokeOpacity: 0, strokeWeight: weight,
    icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: weight, strokeColor: color }, offset: '0', repeat: '10px' }],
    clickable: false,
  };
}

function computeShapeVerts(
  anchorPx: [number, number],
  currentPx: [number, number],
  type: ShapeType,
  unproject: (pt: [number, number]) => { lng: number; lat: number },
): [number, number][] {
  let pts: [number, number][];
  if (type === 'circle') {
    const [cx, cy] = anchorPx;
    const r = Math.sqrt((currentPx[0] - cx) ** 2 + (currentPx[1] - cy) ** 2);
    if (r < 2) return [];
    pts = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * 2 * Math.PI;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
    });
  } else {
    let [x2, y2] = currentPx;
    if (type === 'square') {
      const dx = currentPx[0] - anchorPx[0], dy = currentPx[1] - anchorPx[1];
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x2 = anchorPx[0] + s * (Math.sign(dx) || 1);
      y2 = anchorPx[1] + s * (Math.sign(dy) || 1);
    }
    pts = [anchorPx, [x2, anchorPx[1]], [x2, y2], [anchorPx[0], y2]];
  }
  return pts.map(pt => { const ll = unproject(pt); return [ll.lng, ll.lat]; });
}

export default function DiyBoundaryPage() {
  const navigate = useNavigate();
  const mapRef   = useRef<google.maps.Map | null>(null);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  // Convert map-container pixel coords to lng/lat (used by shape + brush overlays)
  const unproject = useCallback((pt: [number, number]): { lng: number; lat: number } => {
    const map = mapRef.current;
    if (!map) return { lng: 0, lat: 0 };
    const proj = map.getProjection();
    if (!proj) return { lng: 0, lat: 0 };
    const zoom  = map.getZoom() ?? 20;
    const scale = Math.pow(2, zoom);
    const center = map.getCenter();
    if (!center) return { lng: 0, lat: 0 };
    const div = map.getDiv();
    const cw  = proj.fromLatLngToPoint(center)!;
    const nwX = cw.x - div.offsetWidth  / (2 * scale);
    const nwY = cw.y - div.offsetHeight / (2 * scale);
    const ll  = proj.fromPointToLatLng(new google.maps.Point(nwX + pt[0] / scale, nwY + pt[1] / scale));
    return { lng: ll!.lng(), lat: ll!.lat() };
  }, []);

  const sc = useMemo<any>(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const center: [number, number] = [sc.lng ?? -104.99, sc.lat ?? 39.74];

  const visibleSteps: StepId[] = ['boundary', 'identify', 'add_existing', 'new_features'];

  // ── Boundary (step 1) ────────────────────────────────────────────────────────
  const isDblClickRef   = useRef(false);   // prevents double-click from adding two custom-polygon vertices
  const detectGenRef    = useRef(0);        // incremented on reset so stale detection callbacks are ignored
  const [detecting,   setDetecting]   = useState(false);
  const [drawing,     setDrawing]     = useState(false);
  const [vertices,    setVertices]    = useState<[number, number][]>(() => {
    try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.ring ?? []; } catch { return []; }
  });
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const draggingTreeRef = useRef<{ id: string; origCenter: [number, number]; origVerts: [number, number][] } | null>(null);
  const [mousePos,    setMousePos]    = useState<[number, number] | null>(null);

  const boundaryDone = vertices.length >= 3 && !drawing;

  const areaSqFt = useMemo(() => {
    if (vertices.length < 3) return 0;
    try { return Math.round(turf.area(turf.polygon([[...vertices, vertices[0]]])) * 10.7639); } catch { return 0; }
  }, [vertices]);

  // ── Accordion open step ──────────────────────────────────────────────────────
  const [openStep, setOpenStep] = useState<StepId | null>(() => {
    try {
      const bd = JSON.parse(localStorage.getItem('diyBoundary') || 'null');
      const hasRing   = (bd?.ring?.length ?? 0) >= 3;
      const identDone = localStorage.getItem('diyIdentifyDone') === '1';
      if (hasRing && identDone) return null;
      if (hasRing) return null;
    } catch {}
    return 'boundary';
  });

  // ── Confirmed existing-site features (steps 2–3) ────────────────────────────
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

  const reviewQueue = useMemo(() => features.filter(f => f.source === 'detected'), [features]);
  const [queueIdx, setQueueIdx] = useState(0);
  const currentReview = reviewQueue[queueIdx] ?? null;
  const identifyDone  = reviewQueue.length === 0 || queueIdx >= reviewQueue.length;

  // ── Identify sub-steps: feature review → street side (front yards only) ───────
  const [identifySubStep, setIdentifySubStep] = useState<IdentifySubStep>('features');
  const [streetEdgeIdx,   setStreetEdgeIdx]   = useState<number | null>(null);
  const [streetPickMode,  setStreetPickMode]  = useState(false);

  // Pan to active review feature only if it isn't already visible in the viewport
  useEffect(() => {
    if (openStep !== 'identify' || !currentReview || !mapRef.current) return;
    try {
      const bb = turf.bbox(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]]));
      const featureBounds = new google.maps.LatLngBounds(
        { lat: bb[1], lng: bb[0] }, { lat: bb[3], lng: bb[2] });
      const mapBounds = mapRef.current.getBounds();
      if (mapBounds && mapBounds.contains(featureBounds.getNorthEast()) && mapBounds.contains(featureBounds.getSouthWest())) return;
      mapRef.current.fitBounds(featureBounds, 140);
    } catch {}
  }, [queueIdx, openStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const advanceFromFeatures = useCallback(() => {
    if (sc.yard_type === 'front') { setIdentifySubStep('street_side'); }
    else { setOpenStep('add_existing'); }
  }, [sc.yard_type]);

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

  // ── Add-existing mode (step 3) ────────────────────────────────────────────
  const [addMode,          setAddMode]         = useState<AddMode>(null);
  const [eTreeStep,        setETreeStep]        = useState<ETreeStep>('placing');
  const [eTreeCenter,      setETreeCenter]      = useState<[number, number] | null>(null);
  const [eTreeRadiusKm,    setETreeRadiusKm]    = useState(0);
  const [ePolyStep,        setEPolyStep]        = useState<EPolyStep>('drawing');
  const [ePolyVerts,       setEPolyVerts]       = useState<[number, number][]>([]);
  const [eSurface,         setESurface]         = useState('');
  const [eStructureLabel,  setEStructureLabel]  = useState('');
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
      vertices: ePolyVerts, label: `Hardscape — ${eSurface}`,
      attributes: { surfaceType: eSurface },
    }]);
    cancelAdd();
  }, [ePolyVerts, eSurface, cancelAdd]);

  const confirmAddStructure = useCallback(() => {
    if (ePolyVerts.length < 3) return;
    setFeatures(prev => [...prev, {
      id: `feat_${Date.now()}`, type: 'structure' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: eStructureLabel.trim() || 'Structure',
      attributes: {},
    }]);
    cancelAdd();
  }, [ePolyVerts, eStructureLabel, cancelAdd]);

  // Edit-handle drag callbacks (identify step)
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

  // ── Street-side detection ─────────────────────────────────────────────────────

  useEffect(() => {
    if (identifySubStep !== 'street_side' || streetEdgeIdx !== null) return;
    const lat = sc.lat ?? 0, lng = sc.lng ?? 0;
    if (!lat || !lng || vertices.length < 3) return;
    // Find boundary edge closest to geocoded address point (proxy for street)
    function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    }
    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length];
      const d = ptSegDist(lng, lat, a[0], a[1], b[0], b[1]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    setStreetEdgeIdx(minIdx);
    setStreetPickMode(false);
  }, [identifySubStep, streetEdgeIdx, vertices, sc.lat, sc.lng]);

  const confirmStreetSide = useCallback(() => {
    if (streetEdgeIdx !== null) {
      localStorage.setItem('diyStreetSide', JSON.stringify({ edgeIdx: streetEdgeIdx }));
    }
    setOpenStep('add_existing');
  }, [streetEdgeIdx]);

  // ── Feature zones ────────────────────────────────────────────────────────────
  interface ActiveDrawTool { featureId: string; label: string; material?: string; color: string; }
  const [activeDrawTool, setActiveDrawTool] = useState<ActiveDrawTool | null>(null);
  const [, setPickerOpen]   = useState(false);
  const [, setPickerStep]   = useState<'existing_new' | 'feature' | 'label' | 'material'>('feature');
  const [hardscapeExisting, setHardscapeExisting] = useState<boolean | null>(null);
  const hardscapeExistingRef = useRef<boolean | null>(null);
  const [drawMode,         setDrawMode]          = useState<DrawMode>('shape');
  const [shapeType,        setShapeType]         = useState<ShapeType | null>('rectangle');
  const [newFeatSubStep,   setNewFeatSubStep]    = useState<'place' | 'paths' | 'fill'>('place');
  const [activePlaceId,    setActivePlaceId]     = useState<string | null>(null);
  const [fillMaterial,     setFillMaterial]      = useState('');
  const [fillPlanted,      setFillPlanted]       = useState<boolean | null>(null);
  const [featureZones,     setFeatureZones]     = useState<FeatureZone[]>(() => {
    try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.featureZones ?? []; } catch { return []; }
  });
  const [brushRadius,      setBrushRadius]       = useState(5);
  const [treeExisting,     setTreeExisting]     = useState<boolean | null>(null);
  const [treeSize,         setTreeSize]         = useState<TreeSize | null>(null);

  // Keep hardscapeExistingRef in sync for finishZone closure
  useEffect(() => { hardscapeExistingRef.current = hardscapeExisting; }, [hardscapeExisting]);

  // Auto-save featureZones
  useEffect(() => {
    const saved = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...saved, featureZones }));
  }, [featureZones]);

  // Reset tree sub-selections when tree tool changes
  useEffect(() => {
    if (activeDrawTool?.featureId !== 'tree') { setTreeExisting(null); setTreeSize(null); }
  }, [activeDrawTool?.featureId]);

  // Clear draw tool + picker when switching steps
  useEffect(() => {
    setActiveDrawTool(null); setPickerOpen(false);
    setHardscapeExisting(null); setPickerStep('feature');
    setActivePlaceId(null); setFillMaterial(''); setFillPlanted(null);
  }, [openStep]);

  // Reset planted choice when material changes
  useEffect(() => { setFillPlanted(null); }, [fillMaterial]);

  // When drawing finishes (activeDrawTool→null), collapse placement row and reset draw mode
  useEffect(() => {
    if (activeDrawTool === null) { setActivePlaceId(null); setDrawMode('shape'); }
  }, [activeDrawTool]); // eslint-disable-line react-hooks/exhaustive-deps

  // Features the user requested in preferences (filtered to placeable types)
  const requestedFeatures = useMemo(() => {
    try {
      const prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      const sel: string[] = prefs.selectedFeatures ?? [];
      return sel
        .filter(id => id in PLACEABLE_FEATURES)
        .map(id => ({ id, ...PLACEABLE_FEATURES[id] }));
    } catch { return []; }
  }, []);

  // Set of toolIds that have at least one drawn zone
  const placedToolIds = useMemo(() => new Set(featureZones.map(z => z.toolId)), [featureZones]);

  // Shape drag
  const [shapeDragging,     setShapeDragging]     = useState(false);
  const [shapePreviewVerts, setShapePreviewVerts] = useState<[number, number][]>([]);
  const shapeAnchorPx        = useRef<[number, number] | null>(null);
  const shapePreviewVertsRef = useRef<[number, number][]>([]);

  // Custom polygon
  const [customVerts, setCustomVerts] = useState<[number, number][]>([]);

  // Brush drag
  const [brushDragging,  setBrushDragging]  = useState(false);
  const [brushPathVerts, setBrushPathVerts] = useState<[number, number][]>([]);
  const brushPathRef     = useRef<[number, number][]>([]);
  const lastBrushScreen  = useRef<[number, number] | null>(null);
  const brushCursorRef   = useRef<HTMLDivElement>(null);
  const brushOverlayRef  = useRef<HTMLDivElement>(null);
  const lastCursorClient = useRef<[number, number] | null>(null);

  const drawingCustom = activeDrawTool !== null && openStep !== 'boundary' && drawMode === 'shape' && shapeType === 'custom';

  // Brush live polygon coords (for Google Maps rendering)
  const brushLiveCoords = useMemo<[number, number][] | null>(() => {
    if (brushPathVerts.length < 2) return null;
    try {
      const buffered = turf.buffer(turf.lineString(brushPathVerts), brushRadius * 0.0003048, { units: 'kilometers', steps: 8 });
      if (!buffered) return null;
      const geom = buffered.geometry;
      if (geom.type === 'Polygon')      return geom.coordinates[0] as [number, number][];
      if (geom.type === 'MultiPolygon') return geom.coordinates[0][0] as [number, number][];
      return null;
    } catch { return null; }
  }, [brushPathVerts, brushRadius]);

  const isTreePlacementReady = activeDrawTool?.featureId === 'tree' && treeExisting !== null && treeSize !== null;

  const treePlacementPreviewCoords = useMemo<[number, number][] | null>(() => {
    if (!isTreePlacementReady || !treeSize || !mousePos) return null;
    try {
      const c = turf.circle(mousePos, TREE_SIZE_RADIUS_KM[treeSize], { steps: 48, units: 'kilometers' });
      return c.geometry.coordinates[0] as [number, number][];
    } catch { return null; }
  }, [isTreePlacementReady, treeSize, mousePos]);

  // ── Brush cursor ─────────────────────────────────────────────────────────────
  const getBrushDiameterPx = useCallback((): number => {
    const map = mapRef.current;
    if (!map) return brushRadius * 2;
    const zoom = map.getZoom() ?? 20;
    const lat  = map.getCenter()?.lat() ?? 0;
    const metersPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return Math.max(4, (brushRadius * 0.3048 * 2) / metersPerPx);
  }, [brushRadius]);
  const showShapeOverlay = activeDrawTool !== null && activeDrawTool.featureId !== 'tree' && openStep !== 'boundary' && drawMode === 'shape' && shapeType !== null && shapeType !== 'custom';
  const showBrushOverlay = activeDrawTool !== null && activeDrawTool.featureId !== 'tree' && openStep !== 'boundary' && drawMode === 'brush';

  useEffect(() => {
    if (!showBrushOverlay || !brushCursorRef.current || !brushOverlayRef.current || !lastCursorClient.current) return;
    const [clientX, clientY] = lastCursorClient.current;
    const rect = brushOverlayRef.current.getBoundingClientRect();
    const d = getBrushDiameterPx();
    const el = brushCursorRef.current;
    el.style.width = `${d}px`; el.style.height = `${d}px`;
    el.style.transform = `translate(${clientX - rect.left - d / 2}px, ${clientY - rect.top - d / 2}px)`;
  }, [brushRadius]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateBrushCursor = useCallback((clientX: number, clientY: number, overlayEl: HTMLDivElement) => {
    if (!brushCursorRef.current) return;
    lastCursorClient.current = [clientX, clientY];
    const rect = overlayEl.getBoundingClientRect();
    const d = getBrushDiameterPx();
    const el = brushCursorRef.current;
    el.style.width = `${d}px`; el.style.height = `${d}px`;
    el.style.transform = `translate(${clientX - rect.left - d / 2}px, ${clientY - rect.top - d / 2}px)`;
    el.style.opacity = '1';
  }, [getBrushDiameterPx]);

  // ── finishZone ───────────────────────────────────────────────────────────────
  const openStepRef = useRef(openStep);
  useEffect(() => { openStepRef.current = openStep; }, [openStep]);

  const finishZone = useCallback((rawVerts: [number, number][]) => {
    if (!activeDrawTool || rawVerts.length < 3) return;
    const doCleanup = () => {
      setShapePreviewVerts([]); shapePreviewVertsRef.current = []; shapeAnchorPx.current = null;
      setBrushPathVerts([]);    brushPathRef.current = [];    lastBrushScreen.current = null;
      setShapeDragging(false);  setBrushDragging(false);
      setCustomVerts([]);
      setActiveDrawTool(null);
    };

    const ring = [...rawVerts];
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);

    let poly: turf.Feature<turf.Polygon | turf.MultiPolygon>;
    try { poly = turf.polygon([ring]); } catch { doCleanup(); return; }

    if (vertices.length >= 3) {
      try {
        const bPoly = turf.polygon([[...vertices, vertices[0]]]);
        const clipped = turf.intersect(poly as turf.Feature<turf.Polygon>, bPoly);
        if (!clipped) { doCleanup(); return; }
        poly = clipped as turf.Feature<turf.Polygon | turf.MultiPolygon>;
      } catch {}
    }

    const initialVerts = extractLargestRing(poly.geometry as turf.Polygon | turf.MultiPolygon);
    if (!initialVerts || initialVerts.length < 3) { doCleanup(); return; }

    const existingVal: boolean | undefined = undefined;

    setFeatureZones(prev => {
      let clipped: turf.Feature<turf.Polygon | turf.MultiPolygon>;
      try { clipped = turf.polygon([[...initialVerts, initialVerts[0]]]); } catch { return prev; }
      const isTree = activeDrawTool.featureId === 'tree';
      const isPlantingBed = activeDrawTool.featureId === 'planting_bed';
      // Subtract drawn featureZones (skip trees unless drawing a bed)
      for (const z of prev) {
        if (z.vertices.length < 3) continue;
        if (z.toolId === 'tree' && !isPlantingBed) continue;
        if (isTree) continue;
        try {
          const diff = turf.difference(clipped as any, turf.polygon([[...z.vertices, z.vertices[0]]]) as any);
          if (!diff) return prev;
          clipped = diff as turf.Feature<turf.Polygon | turf.MultiPolygon>;
        } catch {}
      }
      // Subtract confirmed existing-site features (hardscape, structures etc.) — skip trees
      if (!isTree) {
        for (const f of features) {
          if (!f.keep || f.type === 'tree' || f.vertices.length < 3) continue;
          try {
            const diff = turf.difference(clipped as any, turf.polygon([[...f.vertices, f.vertices[0]]]) as any);
            if (!diff) return prev;
            clipped = diff as turf.Feature<turf.Polygon | turf.MultiPolygon>;
          } catch {}
        }
      }
      const finalVerts = extractLargestRing(clipped.geometry as turf.Polygon | turf.MultiPolygon);
      if (!finalVerts || finalVerts.length < 3) return prev;
      return [...prev, {
        id: `zone_${Date.now()}`,
        toolId: activeDrawTool.featureId,
        label: activeDrawTool.label,
        color: activeDrawTool.color,
        vertices: finalVerts,
        existing: existingVal,
        planted: activeDrawTool.featureId === 'fill' ? (fillPlanted ?? false) : undefined,
      }];
    });
    doCleanup();
  }, [activeDrawTool, vertices, features, fillPlanted]);

  // ── Confirmed-feature GeoJSON (identify + add_existing steps) ───────────────
  const pendingIds = useMemo(
    () => new Set(reviewQueue.slice(queueIdx + 1).map(f => f.id)),
    [reviewQueue, queueIdx],
  );
  const activeConfirmedId = currentReview?.id ?? null;

  const cfKeepGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features.filter(f => f.keep && f.vertices.length >= 3 && f.id !== activeConfirmedId && !pendingIds.has(f.id))
      .map(f => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [features, activeConfirmedId, pendingIds]);

  const cfRemoveGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features.filter(f => !f.keep && f.vertices.length >= 3 && f.id !== activeConfirmedId && !pendingIds.has(f.id))
      .map(f => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [features, activeConfirmedId, pendingIds]);

  const cfPendingGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: reviewQueue.slice(queueIdx + 1).filter(f => f.vertices.length >= 3)
      .map(f => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [reviewQueue, queueIdx]);

  const cfActiveGeoJSON = useMemo(() => {
    if (!currentReview || currentReview.vertices.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...currentReview.vertices, currentReview.vertices[0]]] } };
  }, [currentReview]);

  // Add-existing previews
  const eTreePreviewCoords = useMemo<[number, number][] | null>(() => {
    if (addMode !== 'tree' || openStep !== 'add_existing') return null;
    let rKm = 0;
    if (eTreeStep === 'sizing' && eTreeCenter && mousePos)
      rKm = turf.distance(turf.point(eTreeCenter), turf.point(mousePos), { units: 'kilometers' });
    if (rKm < 0.0005 || !eTreeCenter) return null;
    try { return turf.circle(eTreeCenter, rKm, { steps: 48, units: 'kilometers' }).geometry.coordinates[0] as [number, number][]; } catch { return null; }
  }, [addMode, openStep, eTreeStep, eTreeCenter, mousePos, eTreeRadiusKm]);

  const ePolyFillCoords = useMemo<[number, number][] | null>(() =>
    (addMode === 'hardscape' || addMode === 'structure') && ePolyVerts.length >= 3 ? ePolyVerts : null,
  [addMode, ePolyVerts]);

  const ePolyLineCoords = useMemo<[number, number][] | null>(() =>
    (addMode === 'hardscape' || addMode === 'structure') && ePolyStep === 'drawing' && ePolyVerts.length > 0 && mousePos
      ? [...ePolyVerts, mousePos] : null,
  [addMode, ePolyStep, ePolyVerts, mousePos]);

  const showConfirmedFeatures = features.length > 0 && openStep !== 'boundary';

  // ── Map handlers ─────────────────────────────────────────────────────────────
  // Clicks are processed via setTimeout(0) so that onDblClick (which fires after
  // both onClick events synchronously) can set isDblClickRef before the macrotask runs.
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (draggingIdx !== null || !e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    setTimeout(() => {
      if (isDblClickRef.current) return; // absorbed by dblclick
      if (drawing) { setVertices(v => [...v, [lng, lat]]); return; }

      // Add-existing step: place tree / poly vertices
      if (openStep === 'add_existing') {
        if (addMode === 'tree') {
          if (eTreeStep === 'placing') { setETreeCenter([lng, lat]); setETreeStep('sizing'); }
          else if (eTreeStep === 'sizing' && eTreeCenter) {
            const r = turf.distance(turf.point(eTreeCenter), turf.point([lng, lat]), { units: 'kilometers' });
            if (r >= 0.0005) confirmAddTree(r);
          }
        } else if ((addMode === 'hardscape' || addMode === 'structure') && ePolyStep === 'drawing') {
          setEPolyVerts(v => [...v, [lng, lat]]);
        }
        return;
      }

      if (isTreePlacementReady && treeSize) {
        try {
          const circle = turf.circle([lng, lat], TREE_SIZE_RADIUS_KM[treeSize], { steps: 48, units: 'kilometers' });
          const ring = circle.geometry.coordinates[0] as [number, number][];
          const sz = TREE_SIZES.find(s => s.id === treeSize);
          setFeatureZones(prev => [...prev, {
            id: `zone_${Date.now()}`,
            toolId: 'tree',
            label: `Tree — ${sz?.label ?? treeSize.toUpperCase()} (${sz?.diameterFt}ft)`,
            color: resolveToolColor('tree'),
            vertices: ring.slice(0, -1),
            existing: treeExisting ?? true,
          }]);
          setActiveDrawTool(null);
        } catch {}
        return;
      }
      if (drawingCustom) setCustomVerts(v => [...v, [lng, lat]]);
    }, 0);
  }, [drawing, draggingIdx, drawingCustom, isTreePlacementReady, treeSize, treeExisting, openStep, addMode, eTreeStep, eTreeCenter, ePolyStep]);

  // Close the boundary polygon — called by the "Done" overlay button
  const handleBoundaryDone = useCallback(() => {
    if (!drawing || vertices.length < 3) return;
    setDrawing(false);
    const snapshotVerts = vertices;
    const bd = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...bd, ring: snapshotVerts }));
    const gen = ++detectGenRef.current;
    setDetecting(true);
    setFeatures([]); setQueueIdx(0);
    detectSiteFeatures(snapshotVerts)
      .then(detected => {
        if (detectGenRef.current !== gen) return;
        const newFeats: ConfirmedFeature[] = detected.map(f => ({
          id:         `detected_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type:       f.type,
          keep:       true,
          source:     'detected' as const,
          vertices:   f.vertices,
          confidence: f.confidence,
          label:      f.label,
          attributes: {},
        }));
        localStorage.setItem('diyDetectedFeatures', JSON.stringify(newFeats));
        setFeatures(newFeats);
        setQueueIdx(0);
      })
      .catch(() => {})
      .finally(() => { setDetecting(false); if (detectGenRef.current === gen) setOpenStep('identify'); });
  }, [drawing, vertices]);

  // Double-click: close custom zone polygon OR close add-existing poly
  const handleDblClick = useCallback((e: google.maps.MapMouseEvent) => {
    isDblClickRef.current = true;
    setTimeout(() => { isDblClickRef.current = false; }, 0);
    e.stop?.();
    if (drawingCustom && customVerts.length >= 3) { finishZone(customVerts); setCustomVerts([]); return; }
    if (openStep === 'add_existing' && (addMode === 'hardscape' || addMode === 'structure') && ePolyStep === 'drawing' && ePolyVerts.length >= 3) {
      setEPolyStep('attributes');
    }
  }, [openStep, drawingCustom, customVerts, finishZone, addMode, ePolyStep, ePolyVerts]);

  const handleMouseMove = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    if (drawing || drawingCustom || isTreePlacementReady || (openStep === 'add_existing' && addMode !== null))
      setMousePos([e.latLng.lng(), e.latLng.lat()]);
  }, [drawing, drawingCustom, isTreePlacementReady, openStep, addMode]);

  // Shape overlay
  const handleShapeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!shapeType) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    shapeAnchorPx.current = [e.clientX - rect.left, e.clientY - rect.top];
    setShapePreviewVerts([]); setShapeDragging(true);
  }, [shapeType]);

  const handleShapeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!shapeDragging || !shapeAnchorPx.current || !shapeType || !mapRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cur: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
    const verts = computeShapeVerts(shapeAnchorPx.current, cur, shapeType, pt => unproject(pt));
    shapePreviewVertsRef.current = verts;
    setShapePreviewVerts([...verts]);
  }, [shapeDragging, shapeType]);

  const handleShapeUp = useCallback(() => {
    if (!shapeDragging) return;
    finishZone(shapePreviewVertsRef.current);
  }, [shapeDragging, finishZone]);

  const handleBrushDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    updateBrushCursor(e.clientX, e.clientY, e.currentTarget);
    const rect = e.currentTarget.getBoundingClientRect();
    const pt = unproject([e.clientX - rect.left, e.clientY - rect.top]);
    brushPathRef.current = [[pt.lng, pt.lat]];
    lastBrushScreen.current = [e.clientX, e.clientY];
    setBrushDragging(true); setBrushPathVerts([[pt.lng, pt.lat]]);
  }, [updateBrushCursor]);

  const handleBrushMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (brushOverlayRef.current) updateBrushCursor(e.clientX, e.clientY, brushOverlayRef.current);
    if (!brushDragging) return;
    const last = lastBrushScreen.current;
    if (last) { const dx = e.clientX - last[0], dy = e.clientY - last[1]; if (dx * dx + dy * dy < 25) return; }
    lastBrushScreen.current = [e.clientX, e.clientY];
    const rect = e.currentTarget.getBoundingClientRect();
    const pt = unproject([e.clientX - rect.left, e.clientY - rect.top]);
    brushPathRef.current = [...brushPathRef.current, [pt.lng, pt.lat]];
    setBrushPathVerts([...brushPathRef.current]);
  }, [brushDragging, updateBrushCursor]);

  const handleBrushUp = useCallback(() => {
    if (!brushDragging) return;
    setBrushDragging(false);
    const pts = brushPathRef.current;
    if (pts.length < 2) { brushPathRef.current = []; setBrushPathVerts([]); return; }
    try {
      const buffered = turf.buffer(turf.lineString(pts), brushRadius * 0.0003048, { units: 'kilometers', steps: 16 });
      const geom = buffered?.geometry;
      const ring: [number, number][] =
        geom?.type === 'Polygon'      ? geom.coordinates[0] as [number, number][] :
        geom?.type === 'MultiPolygon' ? geom.coordinates[0][0] as [number, number][] : [];
      if (ring.length >= 3) finishZone(ring);
    } catch {}
    brushPathRef.current = []; setBrushPathVerts([]);
  }, [brushDragging, brushRadius, finishZone]);

  const handleBrushLeave = () => { if (brushCursorRef.current) brushCursorRef.current.style.opacity = '0'; };

  const resetBoundary = () => {
    detectGenRef.current += 1;
    setDetecting(false);
    setVertices([]); setDrawing(true); setMousePos(null);
    setActiveDrawTool(null); setPickerOpen(false);
    setOpenStep('boundary'); setFeatureZones([]);
    setFeatures([]); setQueueIdx(0); cancelAdd();
    setIdentifySubStep('features');
    setStreetEdgeIdx(null); setStreetPickMode(false);
    localStorage.setItem('diyConfirmedFeatures', '[]');
    localStorage.setItem('diyDetectedFeatures', '[]');
    localStorage.removeItem('diyIdentifyDone');
    localStorage.removeItem('diyStreetSide');
  };

  const handleContinue = () => {
    if (vertices.length < 3) return;
    localStorage.setItem('diyBoundary', JSON.stringify({ ring: vertices, areaSqFt, featureZones }));
    navigate('/diy/feature-confirm');
  };

  // ── Sun model ────────────────────────────────────────────────────────────────
  const [sunComputing, setSunComputing] = useState(false);
  const [sunModel,     setSunModel]     = useState<SunModelResult | null>(null);
  const [showSunMap,   setShowSunMap]   = useState(false);
  const [inReveal,     setInReveal]     = useState(false);
  const sunOverlayRef   = useRef<google.maps.GroundOverlay | null>(null);
  const sunTriggeredRef = useRef(false);

  const triggerSunAnalysis = useCallback(() => {
    if (sunTriggeredRef.current || vertices.length < 3) return;
    sunTriggeredRef.current = true;
    setSunComputing(true);
    computeSunModel(vertices, features)
      .then(result => {
        setSunModel(result);
        setShowSunMap(true);
        try {
          localStorage.setItem('diySunModel', JSON.stringify({ cells: result.cells, bounds: result.bounds }));
        } catch {}
      })
      .catch(() => {})
      .finally(() => setSunComputing(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidateSun = useCallback(() => {
    setSunModel(null);
    setSunComputing(false);
    setShowSunMap(false);
    setInReveal(false);
    sunTriggeredRef.current = false;
  }, []);

  // Create / destroy GroundOverlay when toggle or model changes
  useEffect(() => {
    if (sunOverlayRef.current) { sunOverlayRef.current.setMap(null); sunOverlayRef.current = null; }
    if (!showSunMap || !sunModel || !mapRef.current || !isLoaded) return;
    const bounds = new google.maps.LatLngBounds(
      { lat: sunModel.bounds.sw[1], lng: sunModel.bounds.sw[0] },
      { lat: sunModel.bounds.ne[1], lng: sunModel.bounds.ne[0] },
    );
    const overlay = new google.maps.GroundOverlay(sunModel.heatmapDataUrl, bounds, { opacity: 1.0, clickable: false });
    overlay.setMap(mapRef.current);
    sunOverlayRef.current = overlay;
    return () => { sunOverlayRef.current?.setMap(null); sunOverlayRef.current = null; };
  }, [showSunMap, sunModel, isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sun grid summary — must be after sunModel state is declared
  const sunSummary = useMemo(() => {
    if (!sunModel || sunModel.cells.length === 0) return null;
    const counts: Record<string, number> = { full_sun: 0, part_sun: 0, part_shade: 0, full_shade: 0 };
    for (const cell of sunModel.cells) counts[cell.sunClass] = (counts[cell.sunClass] ?? 0) + 1;
    const total = sunModel.cells.length;
    return [
      { id: 'full_sun',   label: 'Full sun',   sub: '≥ 6 hrs / day', color: '#FFC32D', pct: counts.full_sun   / total },
      { id: 'part_sun',   label: 'Part sun',   sub: '4–6 hrs / day', color: '#D4CF3A', pct: counts.part_sun   / total },
      { id: 'part_shade', label: 'Part shade', sub: '2–4 hrs / day', color: '#4CAD5A', pct: counts.part_shade / total },
      { id: 'full_shade', label: 'Full shade', sub: '< 2 hrs / day',  color: '#3A62D4', pct: counts.full_shade / total },
    ].filter(s => s.pct > 0);
  }, [sunModel]);

  const isStreetPickMode = openStep === 'identify' && identifySubStep === 'street_side' && streetPickMode;
  const mapCursor = (drawing || showShapeOverlay || showBrushOverlay || drawingCustom || isTreePlacementReady || isStreetPickMode) ? 'crosshair' : undefined;

  // ── Render ───────────────────────────────────────────────────────────────────
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

        {/* ── Left panel ── */}
        <div className="flex flex-col gap-4 overflow-y-auto flex-shrink-0" style={{ width: '33%' }}>

          <div>
            <h1 style={{ fontFamily: IS, fontSize: '2.4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Build your plan.</h1>
            <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#6A6A60', marginTop: '0.35rem' }}>
              Map your area step by step — boundary first, then features, then beds.
            </p>
          </div>

          {/* Accordion card */}
          <div className="rounded-2xl overflow-hidden flex-shrink-0" style={{ backgroundColor: '#F4EAD2' }}>

            {visibleSteps.map((stepId, idx) => {
              const stepNum = idx + 1;
              const isBoundary   = stepId === 'boundary';
              const isIdentify   = stepId === 'identify';
              const isAddExist   = stepId === 'add_existing';
              const isNewFeatures = stepId === 'new_features';
              const isOpen   = openStep === stepId;
              const isLocked = !boundaryDone && !isBoundary;
              const addedExisting = features.filter(f => f.source === 'added');
              const newFeatureZones = featureZones.filter(z =>
                ['planting_bed','water_feature','pool','patio','shed'].includes(z.toolId));
              const isDone =
                isBoundary    ? boundaryDone :
                isIdentify    ? identifyDone :
                isAddExist    ? localStorage.getItem('diyIdentifyDone') === '1' :
                /* new_feat */ inReveal;

              return (
                <div key={stepId}>
                  {idx > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}

                  {/* Step header */}
                  <button
                    className="w-full flex items-center gap-3 px-5 py-3.5 transition-all hover:opacity-80"
                    style={{ background: 'none', border: 'none', cursor: isLocked ? 'default' : 'pointer', opacity: isLocked ? 0.4 : 1 }}
                    onClick={() => { if (!isLocked) { if (inReveal) invalidateSun(); setOpenStep(isOpen ? null : stepId); } }}>
                    <span style={{ fontFamily: IS, fontSize: '0.85rem', color: isDone ? '#2F6B4F' : '#B0B0A6', width: 20, textAlign: 'center', flexShrink: 0 }}>
                      {isDone ? '✓' : stepNum}
                    </span>
                    <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>
                      {STEP_TITLE[stepId]}
                    </span>
                    {isBoundary && boundaryDone && (
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
                    {isNewFeatures && newFeatureZones.length > 0 && (
                      <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>— {newFeatureZones.length} drawn</span>
                    )}
                    {!isLocked && (
                      <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6' }}>{isOpen ? '▾' : '▸'}</span>
                    )}
                  </button>

                  {/* Boundary step content */}
                  {isBoundary && isOpen && (
                    <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                      <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', lineHeight: 1.5 }}>
                        {drawing
                          ? vertices.length < 3 ? `${3 - vertices.length} more points needed` : 'Click "Done" to close'
                          : vertices.length === 0 ? 'Click corners on the map' : 'Drag corners to adjust'}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {!drawing && vertices.length === 0 && (
                          <button onClick={() => { setDrawing(true); setActiveDrawTool(null); setPickerOpen(false); setOpenStep('boundary'); }}
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

                  {/* Identify step content */}
                  {isIdentify && isOpen && boundaryDone && (
                    <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>

                      {/* ── Sub-step 1: Feature review ── */}
                      {identifySubStep === 'features' && (
                        reviewQueue.length === 0 ? (
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
                            <div style={{ height: 3, background: 'rgba(42,42,38,0.1)', borderRadius: 999 }}>
                              <div style={{ height: '100%', borderRadius: 999, background: '#2F6B4F', transition: 'width 0.3s', width: `${(queueIdx / reviewQueue.length) * 100}%` }} />
                            </div>
                            <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>{queueIdx + 1} of {reviewQueue.length}</span>
                            <div className="rounded-2xl p-3 flex flex-col gap-1.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              {(currentReview.confidence ?? 1) < 0.7 && (
                                <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#C4935A', textTransform: 'uppercase', letterSpacing: '0.08em' }}>uncertain detection</span>
                              )}
                              <p style={{ fontFamily: IS, fontSize: '1.1rem', color: '#2A2A26', margin: 0, fontWeight: 400 }}>
                                {(currentReview.confidence ?? 1) < 0.7 ? `Is this a ${currentReview.type}?` : `${currentReview.type.charAt(0).toUpperCase() + currentReview.type.slice(1)} found`}
                              </p>
                              {currentReview.label && <span style={{ fontFamily: IT, fontSize: '0.76rem', color: '#7A7A73' }}>{currentReview.label}</span>}
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
                              style={{ fontFamily: IT, fontSize: '0.74rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'center' }}>
                              Not a real feature
                            </button>
                          </div>
                        ) : null
                      )}

                      {/* ── Sub-step 2: Street-side confirmation (front yard only) ── */}
                      {identifySubStep === 'street_side' && (
                        <div className="flex flex-col gap-3 pt-3">
                          {streetEdgeIdx === null ? (
                            <div className="flex items-center gap-2.5">
                              <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.1)', borderTopColor: '#2F6B4F', animation: 'spin 0.9s linear infinite', flexShrink: 0 }} />
                              <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92' }}>Detecting street-facing side…</span>
                            </div>
                          ) : streetPickMode ? (
                            <>
                              <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', margin: 0, fontWeight: 500 }}>Tap the edge that faces the street</p>
                              <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#9A9A92', margin: 0 }}>Click anywhere along the boundary edge that runs along your street.</p>
                              <button onClick={() => setStreetPickMode(false)}
                                style={{ fontFamily: IT, fontSize: '0.74rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'center' }}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <div className="rounded-xl p-3 flex flex-col gap-1" style={{ background: 'rgba(47,107,79,0.1)' }}>
                                <p style={{ fontFamily: IS, fontSize: '1.1rem', color: '#2A2A26', margin: 0, fontWeight: 400 }}>Street-facing side detected</p>
                                <span style={{ fontFamily: IT, fontSize: '0.76rem', color: '#7A7A73' }}>The highlighted edge faces the street. Look right?</span>
                              </div>
                              <button onClick={confirmStreetSide}
                                className="rounded-full py-2.5 hover:opacity-90 transition-all"
                                style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                Confirm
                              </button>
                              <button onClick={() => setStreetPickMode(true)}
                                style={{ fontFamily: IT, fontSize: '0.74rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'center' }}>
                                Doesn't look right — tap the right edge
                              </button>
                            </>
                          )}
                        </div>
                      )}

                    </div>
                  )}

                  {/* New-features step content */}
                  {isNewFeatures && isOpen && boundaryDone && (
                    <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>

                      {/* Sub-step nav pills */}
                      <div className="flex gap-1.5 pt-3">
                        {(['place', 'paths', 'fill'] as const).map((s, i) => (
                          <button key={s}
                            onClick={() => { if (s !== newFeatSubStep) { setActiveDrawTool(null); setActivePlaceId(null); setNewFeatSubStep(s); } }}
                            className="rounded-full px-3 py-1 transition-all hover:opacity-80"
                            style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 500, border: 'none', cursor: 'pointer',
                              background: s === newFeatSubStep ? '#2A2A26' : 'rgba(42,42,38,0.08)',
                              color: s === newFeatSubStep ? '#efe9db' : '#7A7A73' }}>
                            {i + 1}. {s === 'place' ? 'Features' : s === 'paths' ? 'Paths' : 'Fill'}
                          </button>
                        ))}
                      </div>

                      {/* ── Sub-step 1: Place requested features ── */}
                      {newFeatSubStep === 'place' && (
                        <div className="flex flex-col gap-3">
                          <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                            {requestedFeatures.length > 0
                              ? 'Place each feature on the map. Pick a shape, then drag to draw.'
                              : 'No specific features to place. Continue to add paths or choose your fill.'}
                          </p>

                          {requestedFeatures.length > 0 && (
                            <div className="flex flex-col gap-2">
                              {requestedFeatures.map(f => {
                                const isActive  = activePlaceId === f.id;
                                const isDrawing = isActive && activeDrawTool !== null;
                                const isPlaced  = placedToolIds.has(f.id);
                                return (
                                  <div key={f.id} className="rounded-xl overflow-hidden" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                    {/* Feature row */}
                                    <div className="flex items-center gap-2.5 px-3 py-2.5">
                                      <div style={{ width: 8, height: 8, borderRadius: 2, background: f.color, flexShrink: 0 }} />
                                      <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 500, flex: 1 }}>{f.label}</span>
                                      {isPlaced && !isActive && (
                                        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#2F6B4F' }}>✓ placed</span>
                                      )}
                                      {!isActive && (
                                        <button onClick={() => setActivePlaceId(f.id)}
                                          style={{ fontFamily: IT, fontSize: '0.72rem', color: isPlaced ? '#9A9A92' : '#4A7C59', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 4 }}>
                                          {isPlaced ? 'Re-draw' : 'Place ›'}
                                        </button>
                                      )}
                                      {isActive && (
                                        <button onClick={() => { setActiveDrawTool(null); setActivePlaceId(null); }}
                                          style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                          ✕
                                        </button>
                                      )}
                                    </div>
                                    {/* Shape picker */}
                                    {isActive && !isDrawing && (
                                      <div className="flex flex-col gap-2 px-3 pb-3" style={{ borderTop: '1px solid rgba(42,42,38,0.07)' }}>
                                        <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', paddingTop: '0.5rem', display: 'block' }}>Choose shape</span>
                                        <div className="flex gap-1.5">
                                          {(['rectangle', 'circle', 'custom'] as const).map(s => (
                                            <button key={s} onClick={() => {
                                              setShapeType(s);
                                              setActiveDrawTool({ featureId: f.id, label: f.label, color: f.color });
                                            }}
                                              className="flex-1 py-1.5 rounded-lg transition-all hover:opacity-90"
                                              style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                                                border: `1.5px solid ${f.defaultShape === s ? 'rgba(42,42,38,0.35)' : 'rgba(42,42,38,0.12)'}`,
                                                background: f.defaultShape === s ? 'rgba(42,42,38,0.10)' : 'rgba(42,42,38,0.03)',
                                                color: '#2A2A26' }}>
                                              {s === 'rectangle' ? '⬜ Rect' : s === 'circle' ? '⬤ Circle' : '✏ Custom'}
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {/* Drawing instruction */}
                                    {isDrawing && (
                                      <div className="px-3 pb-2.5" style={{ borderTop: '1px solid rgba(42,42,38,0.07)' }}>
                                        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', paddingTop: '0.4rem', display: 'block', lineHeight: 1.5 }}>
                                          {shapeType === 'custom'
                                            ? 'Click to add points — double-click to close.'
                                            : 'Drag on the map to place.'}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Placed zones list with remove */}
                          {featureZones.filter(z => requestedFeatures.some(f => f.id === z.toolId)).length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Placed</span>
                              {featureZones.filter(z => requestedFeatures.some(f => f.id === z.toolId)).map(z => (
                                <div key={z.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                  <div style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.label}</span>
                                  <button onClick={() => setFeatureZones(prev => prev.filter(x => x.id !== z.id))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}

                          <button onClick={() => { setActiveDrawTool(null); setActivePlaceId(null); setNewFeatSubStep('paths'); }}
                            className="rounded-full py-2.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Continue →
                          </button>
                        </div>
                      )}

                      {/* ── Sub-step 2: Connecting paths ── */}
                      {newFeatSubStep === 'paths' && (
                        <div className="flex flex-col gap-3">
                          <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                            Add walkways or paths connecting your features, if desired.
                          </p>

                          {activeDrawTool?.featureId === 'path' ? (
                            <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
                              <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92' }}>
                                {shapeType === 'custom' ? 'Click points — double-click to close.' : 'Drag to draw a path.'}
                              </span>
                              <button onClick={() => { setActiveDrawTool(null); setShapeType('rectangle'); }}
                                style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              {([
                                { s: 'rectangle' as const, icon: '⬜', label: 'Straight' },
                                { s: 'custom'    as const, icon: '✏', label: 'Freeform' },
                              ]).map(({ s, icon, label }) => (
                                <button key={s} onClick={() => { setShapeType(s); setActiveDrawTool({ featureId: 'path', label: 'Path', color: '#C4A882' }); }}
                                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                                  style={{ background: 'rgba(42,42,38,0.06)', border: 'none', cursor: 'pointer' }}>
                                  <span style={{ fontSize: '0.85rem' }}>{icon}</span>
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', fontWeight: 500 }}>{label} path</span>
                                </button>
                              ))}
                            </div>
                          )}

                          {featureZones.filter(z => z.toolId === 'path').length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Added</span>
                              {featureZones.filter(z => z.toolId === 'path').map((z, i) => (
                                <div key={z.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                  <div style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>Path {i + 1}</span>
                                  <button onClick={() => setFeatureZones(prev => prev.filter(x => x.id !== z.id))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}

                          <button onClick={() => { setActiveDrawTool(null); setShapeType('rectangle'); setNewFeatSubStep('fill'); }}
                            className="rounded-full py-2.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            {featureZones.filter(z => z.toolId === 'path').length === 0 ? 'Skip →' : 'Continue →'}
                          </button>
                        </div>
                      )}

                      {/* ── Sub-step 3: Fill ── */}
                      {newFeatSubStep === 'fill' && (() => {
                        const activeFill = FILL_OPTIONS.find(o => o.id === fillMaterial) ?? null;
                        const isFillDrawing = activeDrawTool?.featureId === 'fill';
                        // Draw tools are ready when: material chosen AND (not plantable OR planted choice made)
                        const readyToDraw = activeFill && !isFillDrawing &&
                          (!activeFill.plantable || fillPlanted !== null);
                        return (
                          <div className="flex flex-col gap-3">

                            {/* 1 — Material chips */}
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Material</span>
                              <div className="flex flex-wrap gap-1.5">
                                {FILL_OPTIONS.map(o => (
                                  <button key={o.id} onClick={() => { if (!isFillDrawing) setFillMaterial(o.id); }}
                                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all hover:opacity-90"
                                    style={{ fontFamily: IT, fontSize: '0.74rem', fontWeight: 500, cursor: isFillDrawing ? 'default' : 'pointer',
                                      background: fillMaterial === o.id ? o.color : 'rgba(42,42,38,0.07)',
                                      color: fillMaterial === o.id ? '#fff' : '#2A2A26',
                                      border: `1.5px solid ${fillMaterial === o.id ? o.color : 'rgba(42,42,38,0.12)'}`,
                                      opacity: isFillDrawing && fillMaterial !== o.id ? 0.45 : 1 }}>
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* 2 — Planted toggle (plantable materials only, before drawing starts) */}
                            {activeFill?.plantable && !isFillDrawing && (
                              <div className="flex flex-col gap-1.5">
                                <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Add plants here?</span>
                                <div className="flex gap-2">
                                  {([true, false] as const).map(val => (
                                    <button key={String(val)} onClick={() => setFillPlanted(val)}
                                      className="flex-1 rounded-xl py-2 transition-all hover:opacity-90"
                                      style={{
                                        fontFamily: IT, fontSize: '0.78rem', fontWeight: 500,
                                        border: `1.5px solid ${fillPlanted === val ? '#2A2A26' : 'rgba(42,42,38,0.12)'}`,
                                        background: fillPlanted === val ? '#2A2A26' : 'rgba(42,42,38,0.04)',
                                        color: fillPlanted === val ? '#efe9db' : '#6A6A60',
                                        cursor: 'pointer',
                                      }}>
                                      {val ? 'Yes — plant it' : 'No — just fill'}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* 3 — Draw tools (shown once material + planted choice are made) */}
                            {readyToDraw && (
                              <div className="flex flex-col gap-2">
                                <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Draw tool</span>
                                <div className="flex gap-2">
                                  <button onClick={() => {
                                    setDrawMode('brush');
                                    setActiveDrawTool({ featureId: 'fill', label: activeFill.label, color: activeFill.color });
                                  }}
                                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                                    style={{ background: 'rgba(42,42,38,0.06)', border: 'none', cursor: 'pointer' }}>
                                    <span style={{ fontSize: '1rem' }}>🖌</span>
                                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', fontWeight: 500 }}>Brush</span>
                                  </button>
                                  <button onClick={() => {
                                    setDrawMode('shape'); setShapeType('rectangle');
                                    setActiveDrawTool({ featureId: 'fill', label: activeFill.label, color: activeFill.color });
                                  }}
                                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                                    style={{ background: 'rgba(42,42,38,0.06)', border: 'none', cursor: 'pointer' }}>
                                    <span style={{ fontSize: '1rem' }}>⬜</span>
                                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', fontWeight: 500 }}>Polygon</span>
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* 3 — Active drawing state (brush: size + instruction; polygon: instruction) */}
                            {isFillDrawing && (
                              <div className="flex flex-col gap-2 rounded-xl px-3 py-2.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                <div className="flex items-center justify-between">
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92' }}>
                                    {drawMode === 'brush' ? 'Paint on the map.' : 'Drag to draw.'}
                                  </span>
                                  <button onClick={() => setActiveDrawTool(null)}
                                    style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                                </div>
                                {drawMode === 'brush' && (
                                  <div className="flex items-center gap-2.5">
                                    <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', flexShrink: 0 }}>Size</span>
                                    <input
                                      type="range" min={1} max={10} step={1} value={brushRadius}
                                      onChange={e => setBrushRadius(Number(e.target.value))}
                                      style={{ flex: 1, accentColor: '#2A2A26', cursor: 'pointer', height: 4 }}
                                    />
                                    <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', flexShrink: 0, width: 32, textAlign: 'right' }}>
                                      {brushRadius}ft
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Drawn zones list */}
                            {featureZones.filter(z => z.toolId === 'fill').length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Drawn</span>
                                {featureZones.filter(z => z.toolId === 'fill').map((z, i) => (
                                  <div key={z.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.06)' }}>
                                    <div style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flexShrink: 0 }} />
                                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{z.label} {i + 1}{z.planted ? ' · planted' : ''}</span>
                                    <button onClick={() => setFeatureZones(prev => prev.filter(x => x.id !== z.id))}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                  </div>
                                ))}
                              </div>
                            )}

                            <button onClick={() => { if (vertices.length < 3) return; triggerSunAnalysis(); setInReveal(true); }}
                              className="rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Done →
                            </button>
                          </div>
                        );
                      })()}

                    </div>
                  )}

                  {/* Add-existing step content */}
                  {isAddExist && isOpen && boundaryDone && (
                    <div className="flex flex-col gap-3 px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                      {addMode === null ? (
                        <div className="flex flex-col gap-3 pt-3">
                          <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                            Add any trees, hardscape, or structures we missed.
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
                          <button onClick={() => setOpenStep('new_features')}
                            className="rounded-full py-2.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Continue →
                          </button>
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
                          {(addMode === 'hardscape' || addMode === 'structure') && ePolyVerts.length > 0 && (
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

          {/* ── Sun grid analysis card ── */}
          {(sunComputing || sunSummary) && (
            <div className="rounded-2xl flex-shrink-0" style={{ backgroundColor: '#F4EAD2', overflow: 'hidden' }}>
              {sunComputing ? (
                <div className="flex items-center gap-2.5 px-5 py-4">
                  <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.1)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92' }}>Analyzing site…</span>
                </div>
              ) : sunSummary && sunModel && (
                <div className="flex flex-col gap-4 p-5">

                  {/* Header */}
                  <div className="flex items-baseline justify-between">
                    <span style={{ fontFamily: IS, fontSize: '1.2rem', color: '#2A2A26', fontWeight: 400 }}>Sun analysis</span>
                    <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A6' }}>{areaSqFt.toLocaleString()} sq ft</span>
                  </div>

                  {/* Heatmap thumbnail — pixelated so each cell stays crisp */}
                  <div className="rounded-xl overflow-hidden" style={{ aspectRatio: `${sunModel.gridCols} / ${sunModel.gridRows}`, width: '100%' }}>
                    <img
                      src={sunModel.heatmapDataUrl}
                      alt="Sun analysis grid"
                      style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }}
                    />
                  </div>

                  {/* Stacked bar */}
                  <div className="flex rounded-full overflow-hidden" style={{ height: 8 }}>
                    {sunSummary.map(s => (
                      <div key={s.id} style={{ flex: s.pct, background: s.color, minWidth: s.pct > 0.01 ? 2 : 0 }} />
                    ))}
                  </div>

                  {/* Per-class rows */}
                  <div className="flex flex-col gap-2">
                    {sunSummary.map(s => (
                      <div key={s.id} className="flex items-center gap-2.5">
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                        <div className="flex flex-col" style={{ flex: 1 }}>
                          <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', fontWeight: 500, lineHeight: 1.2 }}>{s.label}</span>
                          <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6', lineHeight: 1.2 }}>{s.sub}</span>
                        </div>
                        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', flexShrink: 0 }}>
                          {Math.round(s.pct * areaSqFt).toLocaleString()} sq ft
                        </span>
                        <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#C0C0B8', flexShrink: 0, width: 28, textAlign: 'right' }}>
                          {Math.round(s.pct * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Phase C: Continue CTA */}
                  {inReveal && (
                    <button onClick={() => {
                      localStorage.setItem('diyIdentifyDone', '1');
                      localStorage.setItem('diyBoundary', JSON.stringify({ ring: vertices, areaSqFt, featureZones }));
                      navigate('/diy/feature-confirm');
                    }}
                      className="rounded-full py-2.5 hover:opacity-90 transition-all"
                      style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                      Continue to plant plan →
                    </button>
                  )}

                </div>
              )}
            </div>
          )}

        </div>

        {/* ── Right: map ── */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full rounded-2xl overflow-hidden relative" style={{ cursor: mapCursor }}>
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
                  draggable: !(showShapeOverlay || showBrushOverlay),
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

                {/* Street edge highlight + pick targets */}
                {identifySubStep === 'street_side' && vertices.length >= 3 && vertices.map((_, i) => {
                  const a = vertices[i], b = vertices[(i + 1) % vertices.length];
                  const isSelected = i === streetEdgeIdx;
                  if (streetPickMode) {
                    return (
                      <Polyline key={`se-${i}`}
                        path={[{ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }]}
                        options={{ strokeColor: isSelected ? '#E8A030' : '#FFFFFF', strokeWeight: 12, strokeOpacity: isSelected ? 0.5 : 0.15, zIndex: 20, clickable: true }}
                        onClick={() => { setStreetEdgeIdx(i); setStreetPickMode(false); }}
                      />
                    );
                  }
                  if (isSelected) {
                    return (
                      <Polyline key={`se-${i}`}
                        path={[{ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }]}
                        options={{ strokeColor: '#E8A030', strokeWeight: 5, strokeOpacity: 1, zIndex: 10, clickable: false }}
                      />
                    );
                  }
                  return null;
                })}

                {/* Boundary draw preview (dashed line from last vertex to cursor) */}
                {drawing && mousePos && vertices.length > 0 && (
                  <Polyline
                    path={[...vertices, mousePos].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine('#FFFFFF'), clickable: false }}
                  />
                )}

                {/* Feature zones — fill + conditional stroke */}
                {featureZones.filter(z => z.vertices.length >= 3).map(z => {
                  const ring = [...z.vertices, z.vertices[0]].map(v => ({ lat: v[1], lng: v[0] }));
                  return (
                    <Polygon key={z.id} paths={ring} options={{
                      fillColor: z.color, fillOpacity: 0.3,
                      strokeColor: z.color, strokeWeight: 2,
                      strokeOpacity: z.existing !== false ? 1 : 0,
                      clickable: false,
                    }} />
                  );
                })}
                {featureZones.filter(z => z.vertices.length >= 3 && z.existing === false).map(z => (
                  <Polyline key={`d-${z.id}`}
                    path={[...z.vertices, z.vertices[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine(z.color), clickable: false }}
                  />
                ))}

                {/* Shape drag preview */}
                {shapePreviewVerts.length >= 3 && (
                  <>
                    <Polygon
                      paths={[...shapePreviewVerts, shapePreviewVerts[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ fillColor: activeDrawTool?.color ?? FEATURE_COLOR, fillOpacity: 0.22, strokeOpacity: 0, clickable: false }}
                    />
                    <Polyline
                      path={[...shapePreviewVerts, shapePreviewVerts[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ ...dashedLine(activeDrawTool?.color ?? FEATURE_COLOR), clickable: false }}
                    />
                  </>
                )}

                {/* Brush live preview */}
                {brushDragging && brushLiveCoords && brushLiveCoords.length >= 3 && (
                  <>
                    <Polygon
                      paths={brushLiveCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ fillColor: activeDrawTool?.color ?? FEATURE_COLOR, fillOpacity: 0.35, strokeColor: activeDrawTool?.color ?? FEATURE_COLOR, strokeWeight: 1.5, strokeOpacity: 1, clickable: false }}
                    />
                  </>
                )}

                {/* Custom polygon in-progress */}
                {drawingCustom && customVerts.length >= 3 && (
                  <Polygon
                    paths={[...customVerts, customVerts[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ fillColor: activeDrawTool?.color ?? FEATURE_COLOR, fillOpacity: 0.18, strokeColor: activeDrawTool?.color ?? FEATURE_COLOR, strokeWeight: 2, strokeOpacity: 1, clickable: false }}
                  />
                )}
                {drawingCustom && mousePos && customVerts.length > 0 && (
                  <Polyline
                    path={[...customVerts, mousePos].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ ...dashedLine(activeDrawTool?.color ?? FEATURE_COLOR), clickable: false }}
                  />
                )}
                {drawingCustom && customVerts.map((v, i) => (
                  <OverlayView key={`cv-${i}`} position={{ lat: v[1], lng: v[0] }} mapPaneName={OverlayView.OVERLAY_LAYER}
                    getPixelPositionOffset={() => ({ x: -4, y: -4 })}>
                    <div style={{ width: 8, height: 8, background: activeDrawTool?.color ?? FEATURE_COLOR, borderRadius: '50%', border: '2px solid white' }} />
                  </OverlayView>
                ))}

                {/* Tree placement preview */}
                {treePlacementPreviewCoords && (
                  <>
                    <Polygon
                      paths={treePlacementPreviewCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ fillColor: '#2F6B4F', fillOpacity: 0.2, strokeOpacity: 0, clickable: false }}
                    />
                    <Polyline
                      path={treePlacementPreviewCoords.map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ ...dashedLine('#2F6B4F'), clickable: false }}
                    />
                  </>
                )}

                {/* Boundary vertex drag handles */}
                {vertices.map((v, i) => (
                  <Marker key={`v-${i}`}
                    position={{ lat: v[1], lng: v[0] }}
                    draggable
                    icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: 'white', fillOpacity: 1, strokeColor: '#2F6B4F', strokeWeight: 2.5 }}
                    onDragStart={() => setDraggingIdx(i)}
                    onDrag={e => { if (e.latLng) setVertices(prev => prev.map((p, idx) => idx === i ? [e.latLng!.lng(), e.latLng!.lat()] : p)); }}
                    onDragEnd={() => setDraggingIdx(null)}
                  />
                ))}

                {/* ── Confirmed existing-site features ── */}
                {showConfirmedFeatures && (<>
                  {/* Reviewed & kept — solid green */}
                  {cfKeepGeoJSON.features.map((f, i) => (
                    <Polygon key={`cfk-${i}`} paths={toPath(f.geometry.coordinates[0])}
                      options={{ fillColor: '#2F6B4F', fillOpacity: 0.28, strokeColor: '#2F6B4F', strokeWeight: 2, clickable: false }} />
                  ))}
                  {/* Reviewed & removed — red dashed (identify step only) */}
                  {openStep === 'identify' && cfRemoveGeoJSON.features.map((f, i) => (
                    <Fragment key={`cfr-${i}`}>
                      <Polygon paths={toPath(f.geometry.coordinates[0])}
                        options={{ fillColor: '#D65C5C', fillOpacity: 0.18, strokeOpacity: 0, clickable: false }} />
                      <Polyline path={toPath(f.geometry.coordinates[0])} options={dashedLine('#D65C5C', 2)} />
                    </Fragment>
                  ))}
                  {/* Pending (not yet reviewed) — dotted white (identify step only) */}
                  {openStep === 'identify' && cfPendingGeoJSON.features.map((f, i) => (
                    <Fragment key={`cfp-${i}`}>
                      <Polygon paths={toPath(f.geometry.coordinates[0])}
                        options={{ fillColor: '#FFFFFF', fillOpacity: 0.08, strokeOpacity: 0, clickable: false }} />
                      <Polyline path={toPath(f.geometry.coordinates[0])} options={dashedLine('#FFFFFF', 2)} />
                    </Fragment>
                  ))}
                  {/* Active (under review) — yellow */}
                  {cfActiveGeoJSON && openStep === 'identify' && (<>
                    <Polygon paths={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                      options={{ fillColor: '#F5C518', fillOpacity: 0.38, strokeOpacity: 0, clickable: false }} />
                    <Polyline path={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                      options={{ strokeColor: '#F5C518', strokeWeight: 7, strokeOpacity: 0.35, clickable: false }} />
                    <Polyline path={toPath(cfActiveGeoJSON.geometry.coordinates[0])}
                      options={{ strokeColor: '#FFFFFF', strokeWeight: 2.5, clickable: false }} />
                  </>)}
                  {/* Edit handles — drag to reshape active review feature */}
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
                    {(currentReview.type === 'hardscape' || currentReview.type === 'structure') &&
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

                {/* Tree zone drag handles */}
                {featureZones.filter(z => z.toolId === 'tree' && z.vertices.length >= 3).map(z => {
                  try {
                    const c = turf.centroid(turf.polygon([[...z.vertices, z.vertices[0]]]));
                    const [lng, lat] = c.geometry.coordinates as [number, number];
                    return (
                      <Marker key={`tree-drag-${z.id}`}
                        position={{ lat, lng }}
                        draggable
                        icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: 'rgba(255,255,255,0.85)', fillOpacity: 0.85, strokeColor: '#2F6B4F', strokeWeight: 2 }}
                        onDragStart={() => { draggingTreeRef.current = { id: z.id, origCenter: [lng, lat], origVerts: [...z.vertices] }; }}
                        onDrag={e => {
                          const drag = draggingTreeRef.current;
                          if (!drag || drag.id !== z.id || !e.latLng) return;
                          const dLng = e.latLng.lng() - drag.origCenter[0];
                          const dLat = e.latLng.lat() - drag.origCenter[1];
                          setFeatureZones(prev => prev.map(fz =>
                            fz.id === z.id ? { ...fz, vertices: drag.origVerts.map(v => [v[0] + dLng, v[1] + dLat] as [number, number]) } : fz
                          ));
                        }}
                        onDragEnd={() => { draggingTreeRef.current = null; }}
                      />
                    );
                  } catch { return null; }
                })}
              </GoogleMap>
            ) : (
              <div style={{ width: '100%', height: '100%', background: '#2A2A26' }} />
            )}

            {/* Done button — closes the boundary polygon */}
            {drawing && vertices.length >= 3 && (
              <button
                onClick={handleBoundaryDone}
                className="absolute flex items-center gap-2 px-5 py-2.5 rounded-full hover:opacity-90 transition-all"
                style={{ bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}>
                Done ✓
              </button>
            )}

            {showShapeOverlay && (
              <div className="absolute inset-0" style={{ cursor: 'crosshair', touchAction: 'none' }}
                onPointerDown={handleShapeDown} onPointerMove={handleShapeMove} onPointerUp={handleShapeUp} />
            )}
            {showBrushOverlay && (
              <div ref={brushOverlayRef} className="absolute inset-0" style={{ cursor: 'none', touchAction: 'none' }}
                onPointerDown={handleBrushDown} onPointerMove={handleBrushMove} onPointerUp={handleBrushUp} onPointerLeave={handleBrushLeave}>
                <div ref={brushCursorRef} style={{ position: 'absolute', top: 0, left: 0, width: 40, height: 40, borderRadius: '50%', border: `2px solid ${activeDrawTool?.color ?? FEATURE_COLOR}`, background: `${activeDrawTool?.color ?? FEATURE_COLOR}28`, pointerEvents: 'none', opacity: 0, transition: 'width 0.1s, height 0.1s' }} />
              </div>
            )}

            {/* Sun map toggle */}
            {sunModel && !sunComputing && (
              <button
                onClick={() => setShowSunMap(v => !v)}
                className="absolute flex items-center gap-1.5 px-3 py-1.5 rounded-full hover:opacity-90 transition-all"
                style={{ top: 12, right: 12, zIndex: 10, background: showSunMap ? '#2F6B4F' : '#F4EAD2', color: showSunMap ? 'white' : '#2A2A26', fontFamily: IT, fontSize: '0.75rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.12)', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
                ☀ Sun map
              </button>
            )}
            {sunComputing && (
              <div className="absolute flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                style={{ top: 12, right: 12, zIndex: 10, background: '#F4EAD2', fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.1)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite', flexShrink: 0 }} />
                Computing sun…
              </div>
            )}

            {/* Sun map legend */}
            {showSunMap && sunModel && (
              <div className="absolute flex flex-col gap-1 px-3 py-2.5 rounded-xl"
                style={{ bottom: 52, right: 12, zIndex: 10, background: 'rgba(244,234,210,0.92)', backdropFilter: 'blur(4px)', boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }}>
                {([
                  ['full_sun',   '#FFC32D', '≥6 hrs  Full sun'],
                  ['part_sun',   '#D2D746', '4–6 hrs Part sun'],
                  ['part_shade', '#46A055', '2–4 hrs Part shade'],
                  ['full_shade', '#325AD2', '<2 hrs  Full shade'],
                ] as const).map(([, color, label]) => (
                  <div key={label} className="flex items-center gap-2">
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#2A2A26' }}>{label}</span>
                  </div>
                ))}
              </div>
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

      {/* Coverage warning */}
      <button onClick={() => navigate(-1)}
        className="fixed bottom-6 left-10 hover:opacity-70 transition-all"
        style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>
      <button onClick={handleContinue} disabled={vertices.length < 3 || drawing}
        className="fixed bottom-6 right-10 flex items-center gap-2 px-7 py-3.5 rounded-full transition-all hover:opacity-90 disabled:opacity-40"
        style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, border: 'none', cursor: vertices.length >= 3 && !drawing ? 'pointer' : 'default' }}>
        Continue →
      </button>
    </div>
  );
}
