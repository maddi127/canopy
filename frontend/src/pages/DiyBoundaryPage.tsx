import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Marker, Polygon, Polyline, OverlayView } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import BackButton from '../components/BackButton';
import AddressInput from '../features/onboarding/AddressInput';
import AppStepper from '../components/AppStepper';
import IllustrativeSite from '../components/IllustrativeSite';
import GrowingFlower from '../components/GrowingFlower';
import { detectSiteFeatures } from '../services/geminiService';
import { analyzeStreetView, STREET_VIEW_ENABLED } from '../services/streetViewService';
import { detectSiteZones, type SiteZones } from '../services/siteZones';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';
import { IS, IT, PAGE_BG } from '../lib/theme';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';

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
    toXY: (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
    toLngLat: (x: number, y: number): [number, number] => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
  };
}

// Point-to-polygon distance (feet); 0 if inside.
function ptToRingDist(px: number, py: number, ring: [number, number][]): number {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  if (inside) return 0;
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)));
  }
  return min;
}
function ringAreaFt(r: [number, number][]): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }

// Keep any feature the plan should design around — every type (house, tree, hardscape, structure) is
// kept at its FULL footprint when it intersects the boundary buffered by 10 ft, and dropped only when
// it's entirely elsewhere. We no longer clip hardscape/structures to the boundary interior: a patio or
// driveway right off the house sits just outside a front-lawn boundary but must still be respected, so
// it's kept whole rather than trimmed away. Matches detectSiteFeatures' filter so the two agree.
function clipFeaturesToBoundary(feats: ConfirmedFeature[], ring: [number, number][]): ConfirmedFeature[] {
  if (ring.length < 3) return feats;
  let zone: ReturnType<typeof turf.polygon>;
  try {
    const boundaryPoly = turf.polygon([[...ring, ring[0]]]);
    zone = (turf.buffer(boundaryPoly, 10, { units: 'feet' }) ?? boundaryPoly) as ReturnType<typeof turf.polygon>;
  } catch { return feats; }
  return feats.filter(f => {
    if (f.vertices.length < 3) return false;
    try { return turf.booleanIntersects(turf.polygon([[...f.vertices, f.vertices[0]]]), zone); }
    catch { return true; }
  });
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

// Step heading — yard-side aware ("front"/"back" from the selected yard type; omitted if unknown).
const stepInstruction = (step: StepId, side: string): string => {
  const s = side === 'front' || side === 'back' ? `${side} ` : '';               // "front "/"back " — for "back door"
  const yardWord = side === 'back' ? 'backyard' : side === 'front' ? 'front yard' : 'yard'; // "backyard" is one word
  switch (step) {
    case 'boundary':     return `Outline your ${yardWord} below`;
    case 'door':         return `Mark your primary ${s}door on the map`;
    case 'identify':     return `Confirm the existing features in your ${yardWord}`;
    case 'add_existing': return 'Add existing features';
  }
};

const STEP_SUBTITLE: Record<StepId, string> = {
  boundary:     "Double-click or hit “Done drawing” to finish",
  door:         "If you have multiple doors to your yard, mark the one you use most",
  identify:     "We'll design your plan around these",
  add_existing: 'Add anything we missed',
};

// The in-page IllustrativeSite "reveal" animation is kept dormant for now (see the {reveal && …}
// block + goToPlacement) — flip this to true to re-activate it instead of the loading overlay.
const USE_REVEAL_ANIMATION = false;
const BUILD_MESSAGES = ["We're building your plan…", 'Placing your features…', 'Choosing the right plants for you…'];

// A hand-drawn white pencil outline of the boundary, rendered as a Google Maps OverlayView in the
// overlay pane. Because it lives in a map pane, the map translates it natively on pan and calls
// draw() on zoom — so we just reproject the ring each draw() and it stays glued (no fixed-pixel lag).
// `animate` plays a one-time draw-on the first time it paints; afterwards it holds fully drawn.
function createPencilOverlay(map: google.maps.Map, verts: [number, number][], animate: boolean): google.maps.OverlayView {
  const NS = 'http://www.w3.org/2000/svg';
  const ov = new google.maps.OverlayView() as google.maps.OverlayView & { _svg?: SVGSVGElement; _halo?: SVGPathElement; _line?: SVGPathElement; _animated?: boolean };
  ov.onAdd = function () {
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';
    const defs = document.createElementNS(NS, 'defs');
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', 'pencilTraceOv'); filter.setAttribute('x', '-6%'); filter.setAttribute('y', '-6%'); filter.setAttribute('width', '112%'); filter.setAttribute('height', '112%');
    const turb = document.createElementNS(NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise'); turb.setAttribute('baseFrequency', '0.012'); turb.setAttribute('numOctaves', '2'); turb.setAttribute('seed', '7'); turb.setAttribute('result', 'n');
    const disp = document.createElementNS(NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic'); disp.setAttribute('in2', 'n'); disp.setAttribute('scale', '3.5');
    filter.appendChild(turb); filter.appendChild(disp); defs.appendChild(filter); svg.appendChild(defs);
    const mkPath = (stroke: string, w: number) => {
      const p = document.createElementNS(NS, 'path') as SVGPathElement;
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', stroke); p.setAttribute('stroke-width', String(w));
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('filter', 'url(#pencilTraceOv)');
      return p;
    };
    const halo = mkPath('rgba(42,42,38,0.45)', 7);
    const line = mkPath('#FFFFFF', 3.5);
    svg.appendChild(halo); svg.appendChild(line);
    this.getPanes()!.overlayLayer.appendChild(svg);
    ov._svg = svg; ov._halo = halo; ov._line = line;
  };
  ov.draw = function () {
    const proj = this.getProjection(); const svg = ov._svg, halo = ov._halo, line = ov._line;
    if (!proj || !svg || !halo || !line) return;
    const pts = verts.map(v => { const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(v[1], v[0])); return p ? [p.x, p.y] as [number, number] : null; });
    if (pts.some(p => !p || !isFinite(p[0]) || !isFinite(p[1]))) return;
    const xs = (pts as [number, number][]).map(p => p[0]), ys = (pts as [number, number][]).map(p => p[1]);
    const pad = 14;
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad, maxX = Math.max(...xs) + pad, maxY = Math.max(...ys) + pad;
    svg.style.left = `${minX}px`; svg.style.top = `${minY}px`;
    svg.setAttribute('width', String(maxX - minX)); svg.setAttribute('height', String(maxY - minY));
    const P = pts as [number, number][];
    const d = `M ${(P[0][0] - minX).toFixed(1)} ${(P[0][1] - minY).toFixed(1)} ` + P.slice(1).map(p => `L ${(p[0] - minX).toFixed(1)} ${(p[1] - minY).toFixed(1)}`).join(' ') + ' Z';
    halo.setAttribute('d', d); line.setAttribute('d', d);
    if (animate && !ov._animated) {
      ov._animated = true;
      let len = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      len = Math.ceil(len);
      [halo, line].forEach(p => {
        p.style.strokeDasharray = String(len); p.style.strokeDashoffset = String(len); p.style.transition = 'none';
        void p.getBoundingClientRect();
        p.style.transition = 'stroke-dashoffset 2.2s ease-out'; p.style.strokeDashoffset = '0';
      });
      // Once drawn, drop the dash so later reprojections (zoom) never re-clip the line.
      window.setTimeout(() => { [halo, line].forEach(p => { p.style.transition = 'none'; p.style.strokeDasharray = 'none'; p.style.strokeDashoffset = '0'; }); }, 2350);
    }
  };
  ov.onRemove = function () {
    if (ov._svg && ov._svg.parentNode) ov._svg.parentNode.removeChild(ov._svg);
    ov._svg = ov._halo = ov._line = undefined;
  };
  ov.setMap(map);
  return ov;
}

export default function DiyBoundaryPage() {
  const navigate = useNavigate();
  const mapRef   = useRef<google.maps.Map | null>(null);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const sc = useMemo<any>(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  // The site address can arrive on THIS page (entered above the map) rather than on the homepage, so
  // it's state, not a one-time snapshot. `hasAddress` gates the map/drawing; until it's set we show an
  // address input. Selecting one recenters the map (via mapEpoch remount) to that lot.
  const [siteAddr, setSiteAddr] = useState<{ lat: number; lng: number } | null>(() =>
    (typeof sc.lat === 'number' && typeof sc.lng === 'number') ? { lat: sc.lat, lng: sc.lng } : null);
  const hasAddress = siteAddr !== null;
  const center: [number, number] = [siteAddr?.lng ?? -104.99, siteAddr?.lat ?? 39.74];
  // Stable reference for GoogleMap's controlled `center` — a fresh {lat,lng} literal each render makes
  // the map re-apply setCenter on every re-render (e.g. every mousemove in draw mode), yanking the
  // view back to the address as you pan. Memoized on the primitives, it's applied once at mount.
  const mapCenter = useMemo(() => ({ lat: center[1], lng: center[0] }), [center[0], center[1]]);

  // Main entry ('door') informs auto-layout feature placement. Optional — it doesn't gate Continue.
  const visibleSteps: StepId[] = ['boundary', 'door', 'identify'];

  // ── Boundary ─────────────────────────────────────────────────────────────────
  const isDblClickRef = useRef(false);
  const detectGenRef  = useRef(0);
  const [detecting,  setDetecting]  = useState(false);
  const [drawing,    setDrawing]    = useState(false);
  const [vertices,   setVertices]   = useState<[number, number][]>(() => {
    try {
      const ring = JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.ring;
      if (Array.isArray(ring) && ring.length >= 3) return ring;
      // Fall back to the authoritative bundle (written by goToPlacement AND when a saved design loads,
      // which does NOT write the diyBoundary key) — so re-entering never loses the drawn boundary.
      const fin = JSON.parse(localStorage.getItem('diyBoundaryFinal') || 'null')?.boundary;
      if (Array.isArray(fin) && fin.length >= 3) return fin;
    } catch { /* ignore */ }
    return [];
  });
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [mousePos,   setMousePos]   = useState<[number, number] | null>(null);
  // Drag-edit scratch for the active existing feature: center-move captures the pre-drag geometry;
  // vertex-reshape captures the pre-drag ring (so a drag translates/edits from a stable origin).
  const editCenterRef = useRef<{ origCenter: [number, number]; origVerts: [number, number][] } | null>(null);
  const origVertsRef  = useRef<[number, number][]>([]);

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

  // "Building your plan" loading overlay (replaces the reveal animation): blur the screen + cycle
  // through the build messages while the plan is prepared, then navigate to plan-ready.
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState(0);
  useEffect(() => {
    if (!building) { setBuildMsg(0); return; }
    const t = setInterval(() => setBuildMsg(m => Math.min(m + 1, BUILD_MESSAGES.length - 1)), 1300);
    return () => clearInterval(t);
  }, [building]);
  // Pencil re-trace of the boundary once drawing finishes — a hand-drawn white outline that draws on,
  // then STAYS (replacing the green polygon). Rendered as a custom OverlayView in the map's overlay
  // pane so the map moves/scales it natively (no fixed-pixel recompute lag on pan/zoom). `traceOn`
  // gates it; the live instance lives in pencilOverlayRef.
  const [traceOn, setTraceOn] = useState(() => {
    // A restored, already-closed boundary shows the hand-drawn trace immediately — so the outline persists
    // (in the hand-drawn style) across the boundary/door/identify sub-steps and across re-entry, not just
    // right after it's first closed. Same source order as the vertices restore above.
    try {
      const ring = JSON.parse(localStorage.getItem('diyBoundary') || 'null')?.ring;
      if (Array.isArray(ring) && ring.length >= 3) return true;
      const fin = JSON.parse(localStorage.getItem('diyBoundaryFinal') || 'null')?.boundary;
      if (Array.isArray(fin) && fin.length >= 3) return true;
    } catch { /* ignore */ }
    return false;
  });
  const pencilOverlayRef = useRef<google.maps.OverlayView | null>(null);
  // Street View analysis kicked off when the plan reveal begins, so it runs CONCURRENTLY with the
  // reveal animation; we await it (with a hard timeout) just before navigating to /diy/plan-ready.
  const svPromiseRef = useRef<Promise<unknown> | null>(null);
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

  // Step-transition beat: on each advance between the boundary sub-steps, briefly take over the map with
  // a step card so the change is unmistakable — user testing showed the (unchanging) map hid the fact
  // that the step changed, even with the title change + boundary animation.
  const [transStep, setTransStep] = useState<StepId | null>(null);
  const transTimer = useRef<number | null>(null);
  const prevStepForTransRef = useRef<StepId | null>(null);
  useEffect(() => {
    const prev = prevStepForTransRef.current;
    prevStepForTransRef.current = openStep;
    if (prev === null || prev === openStep) return;                 // skip initial mount / no-op
    if (openStep !== 'boundary' && openStep !== 'door' && openStep !== 'identify') return;
    setTransStep(openStep);
    if (transTimer.current) window.clearTimeout(transTimer.current);
    transTimer.current = window.setTimeout(() => setTransStep(null), 750);
  }, [openStep]);
  useEffect(() => () => { if (transTimer.current) window.clearTimeout(transTimer.current); }, []);
  // Bumped on Re-draw to remount the map and clear any stale overlays.
  const [mapEpoch, setMapEpoch] = useState(0);
  // The live map instance, set in onLoad — used to manage feature overlays imperatively.
  const [mapObj, setMapObj] = useState<google.maps.Map | null>(null);

  // Mount/unmount the pencil boundary overlay. It anchors to lat/lng in the overlay pane, so it stays
  // glued as the map pans and reprojects as it zooms — the draw() the map calls does the tracking.
  useEffect(() => {
    if (pencilOverlayRef.current) { pencilOverlayRef.current.setMap(null); pencilOverlayRef.current = null; }
    if (!mapObj || !traceOn || vertices.length < 3) return;
    pencilOverlayRef.current = createPencilOverlay(mapObj, vertices, true);
    return () => { if (pencilOverlayRef.current) { pencilOverlayRef.current.setMap(null); pencilOverlayRef.current = null; } };
  }, [mapObj, traceOn, vertices]);

  // ── Confirmed features ───────────────────────────────────────────────────────
  const [features, setFeatures] = useState<ConfirmedFeature[]>(() => {
    try {
      // Prefer the confirmed list if the key EXISTS (even if empty — the user may have removed all),
      // then the authoritative bundle (covers a loaded design), then the raw detections.
      const saved = localStorage.getItem('diyConfirmedFeatures');
      if (saved !== null) { const p = JSON.parse(saved); if (Array.isArray(p)) return p; }
      const fin = JSON.parse(localStorage.getItem('diyBoundaryFinal') || 'null')?.confirmedFeatures;
      if (Array.isArray(fin)) return fin;
      const raw = localStorage.getItem('diyDetectedFeatures');
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; }
    } catch {}
    return [];
  });
  useEffect(() => { localStorage.setItem('diyConfirmedFeatures', JSON.stringify(features)); }, [features]);

  const liveFeatures = useMemo(() => features.filter(f => f.keep !== false), [features]);

  // Special site zones (foundation band) derived from the kept features.
  const siteZones = useMemo<SiteZones>(() => detectSiteZones(vertices, liveFeatures), [vertices, liveFeatures]);

  // Feet coordinate system for the boundary — used to size the detected features listed on the card.
  const boundaryCS = useMemo(() => (vertices.length >= 3 ? buildCS(vertices) : null), [vertices]);

  // One-line size/detail for a feature row in the identify list.
  const featureDetail = (f: ConfirmedFeature): string => {
    const cs = boundaryCS;
    if (!cs) return '';
    const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
    const area = ringAreaFt(ring);
    const sq = `${Math.round(area).toLocaleString()} sq ft`;
    if (f.type === 'house')     return `${sq} footprint`;
    if (f.type === 'tree')      return `~${Math.round(2 * Math.sqrt(area / Math.PI))} ft canopy`;
    if (f.type === 'hardscape') return `${sq}, ${(f as any).material ?? (f.attributes as any)?.surfaceType ?? 'concrete'}`;
    return sq;
  };

  // ── Feature review cursor ────────────────────────────────────────────────────
  // "{N} found" pill is a stable count of DETECTED features (not affected by removes).

  // The card shows ONE feature at a time (the active one). No on-map drag editing anymore.
  const [activeId, setActiveId] = useState<string | null>(null);
  const currentReview = useMemo(() => features.find(f => f.id === activeId) ?? null, [features, activeId]);

  // Keep the cursor on the first live feature when nothing's active (or the active one was removed).
  useEffect(() => {
    if (!activeId || !liveFeatures.some(f => f.id === activeId)) {
      setActiveId(liveFeatures[0]?.id ?? null);
    }
  }, [activeId, liveFeatures]);

  // A detected feature is "reviewed" once confirmed (in reviewedSet) OR removed (keep === false).
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const reviewedSet = useMemo(() => new Set(reviewedIds), [reviewedIds]);
  const allReviewed = useMemo(() => {
    // EVERY live feature — auto-detected AND user-added — must be reviewed, so added features are
    // surfaced for reconfirm/delete too (removed ones drop out of liveFeatures and don't block).
    return liveFeatures.length === 0 || liveFeatures.every(f => reviewedSet.has(f.id));
  }, [liveFeatures, reviewedSet]);

  // Confirm the active feature and advance to the next live one.
  const confirmFeature = useCallback((id: string) => {
    setReviewedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
    const live = features.filter(f => f.keep !== false);
    const idx = live.findIndex(f => f.id === id);
    if (idx >= 0 && idx < live.length - 1) setActiveId(live[idx + 1].id);
  }, [features]);

  // Step back from the "all reviewed" state: un-confirm the most recent feature and make it active.
  const reopenReview = useCallback(() => {
    if (reviewedIds.length === 0) return;
    const last = reviewedIds[reviewedIds.length - 1];
    setReviewedIds(prev => prev.slice(0, -1));
    setActiveId(last);
  }, [reviewedIds]);

  // A feature the user ADDS this session is auto-marked reviewed (they just defined it — don't re-prompt).
  // Features present at MOUNT are seeded here WITHOUT being marked, so a re-entry (reviewedIds resets to
  // []) surfaces every added feature again for reconfirm/delete. Seed is the initial `features` set.
  const seenAddedRef = useRef<Set<string>>(new Set(features.filter(f => f.source === 'added').map(f => f.id)));
  useEffect(() => {
    const fresh = features.filter(f => f.source === 'added' && !seenAddedRef.current.has(f.id)).map(f => f.id);
    if (!fresh.length) return;
    fresh.forEach(id => seenAddedRef.current.add(id));
    setReviewedIds(prev => [...prev, ...fresh.filter(id => !prev.includes(id))]);
  }, [features]);

  const [doorPoint, setDoorPoint] = useState<[number, number] | null>(() => {
    try {
      const dp = JSON.parse(localStorage.getItem('diyDoorPoint') || 'null');
      if (Array.isArray(dp)) return dp as [number, number];
      const fin = JSON.parse(localStorage.getItem('diyBoundaryFinal') || 'null')?.doorPoint;
      if (Array.isArray(fin)) return fin as [number, number];
    } catch { /* ignore */ }
    return null;
  });
  useEffect(() => {
    if (doorPoint) localStorage.setItem('diyDoorPoint', JSON.stringify(doorPoint));
    else localStorage.removeItem('diyDoorPoint');
  }, [doorPoint]);
  // After marking the entry, the dot pulses at its pixel spot for a beat, then we advance to review.
  const [doorPulse, setDoorPulse] = useState<{ x: number; y: number } | null>(null);
  const doorTimer = useRef<number | null>(null);

  // Use the marked entry to name walkways: an elongated hardscape that reaches the door is the
  // "Front walkway". Runs once the door is placed (which now precedes the identify step).
  useEffect(() => {
    if (!doorPoint || vertices.length < 3) return;
    const cs = buildCS(vertices);
    const [dx, dy] = cs.toXY(doorPoint[0], doorPoint[1]);
    let changed = false;
    const next = features.map(f => {
      if (f.type !== 'hardscape' || f.vertices.length < 3 || f.label === 'Front walkway') return f;
      const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
      const area = ringAreaFt(ring); if (area < 15) return f;
      let maxD = 0; for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) { const d = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]); if (d > maxD) maxD = d; }
      const width = area / (maxD || 1), aspect = maxD / (width || 1);
      if (aspect >= 2.5 && ptToRingDist(dx, dy, ring) <= 7) { changed = true; return { ...f, label: 'Front walkway' }; } // elongated + reaches the door
      return f;
    });
    if (changed) setFeatures(next);
  }, [doorPoint, vertices, features]);

  // Boundary step advances once the area is drawn. (The identify step additionally requires every
  // detected feature to be reviewed before Continue — see `ready` in the bottom nav.)
  const canContinue = boundaryDone;

  // 'remove' sets keep:false (drops out of the list); 'not_real' deletes it entirely.
  const resolveFeature = useCallback((id: string, decision: 'keep' | 'remove' | 'not_real') => {
    setFeatures(prev =>
      decision === 'not_real'
        ? prev.filter(f => f.id !== id)
        : prev.map(f => f.id === id ? { ...f, keep: decision === 'keep' } : f),
    );
  }, []);

  // ── Add-existing ─────────────────────────────────────────────────────────────
  const [addMode,         setAddMode]         = useState<AddMode>(null);
  const [addPickerOpen,   setAddPickerOpen]   = useState(false);
  const [addLabel,        setAddLabel]        = useState('');   // optional name typed before drawing a new feature
  const [eTreeStep,       setETreeStep]       = useState<ETreeStep>('placing');
  const [eTreeCenter,     setETreeCenter]     = useState<[number, number] | null>(null);
  const [eTreeRadiusKm,   setETreeRadiusKm]   = useState(0);
  const [ePolyStep,       setEPolyStep]       = useState<EPolyStep>('drawing');
  const [ePolyVerts,      setEPolyVerts]      = useState<[number, number][]>([]);
  const [eSurface,        setESurface]        = useState('');
  const [eStructureLabel, setEStructureLabel] = useState('');

  const resetAddDrawing = useCallback(() => {
    setETreeStep('placing'); setETreeCenter(null); setETreeRadiusKm(0);
    setEPolyStep('drawing'); setEPolyVerts([]); setESurface(''); setEStructureLabel('');
  }, []);
  const cancelAdd = useCallback(() => { resetAddDrawing(); setAddMode(null); setAddPickerOpen(false); setAddLabel(''); }, [resetAddDrawing]);
  const startAdd  = useCallback((m: AddMode) => { resetAddDrawing(); setAddMode(m); }, [resetAddDrawing]);

  const confirmAddTree = useCallback((radiusKm?: number) => {
    const r = radiusKm ?? eTreeRadiusKm;
    if (!eTreeCenter || r < 0.0005) return;
    const ring = (turf.circle(eTreeCenter, r, { steps: 48, units: 'kilometers' })
      .geometry.coordinates[0] as [number, number][]).slice(0, -1);
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'tree' as const, keep: true, source: 'added' as const,
      vertices: ring, label: addLabel.trim() || 'Tree', attributes: {},
    }]);
    cancelAdd();
  }, [eTreeCenter, eTreeRadiusKm, addLabel, cancelAdd]);

  const confirmAddHardscape = useCallback(() => {
    if (ePolyVerts.length < 3 || !eSurface) return;
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'hardscape' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: addLabel.trim() || `Hardscape — ${eSurface}`, attributes: { surfaceType: eSurface },
    }]);
    cancelAdd();
  }, [ePolyVerts, eSurface, addLabel, cancelAdd]);

  const confirmAddStructure = useCallback(() => {
    if (ePolyVerts.length < 3) return;
    const id = `feat_${Date.now()}`;
    setFeatures(prev => [...prev, {
      id, type: 'structure' as const, keep: true, source: 'added' as const,
      vertices: ePolyVerts, label: addLabel.trim() || eStructureLabel.trim() || 'Other', attributes: {},
    }]);
    cancelAdd();
  }, [ePolyVerts, eStructureLabel, addLabel, cancelAdd]);

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
      vertices: ePolyVerts, label: addLabel.trim() || cfg.label, attributes: {},
    }]);
    cancelAdd();
  }, [ePolyVerts, addMode, addLabel, cancelAdd]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Confirmed-feature GeoJSON ────────────────────────────────────────────────
  // Once every feature is reviewed the card shows no active one, so nothing reads as active.
  const activeConfirmedId = allReviewed ? null : (currentReview?.id ?? null);

  // Live (kept) features render in the normal kept style; the active one is drawn separately.
  const cfKeepGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: features
      .filter(f => f.keep && f.vertices.length >= 3 && f.id !== activeConfirmedId)
      .map(f => ({ type: 'Feature' as const, properties: { featureType: f.type, id: f.id }, geometry: { type: 'Polygon' as const, coordinates: [[...f.vertices, f.vertices[0]]] } })),
  }), [features, activeConfirmedId]);

  const cfActiveGeoJSON = useMemo(() => {
    if (allReviewed || !currentReview || currentReview.keep === false || currentReview.vertices.length < 3) return null;
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...currentReview.vertices, currentReview.vertices[0]]] } };
  }, [currentReview, allReviewed]);

  // ── Drag-editing the active existing feature ─────────────────────────────────
  // The feature being reviewed gets on-map handles: a center dot to MOVE the whole shape, plus
  // either an edge dot to RESIZE a tree's canopy or per-vertex dots to RESHAPE a polygon.
  const activeFeatureCenter = useMemo<[number, number] | null>(() => {
    if (allReviewed || !currentReview || currentReview.keep === false || currentReview.vertices.length < 3) return null;
    try { return turf.centroid(turf.polygon([[...currentReview.vertices, currentReview.vertices[0]]])).geometry.coordinates as [number, number]; }
    catch { return null; }
  }, [currentReview, allReviewed]);

  // For trees (a 48-point circle), the resize handle sits on the vertex farthest from center.
  const activeTreeInfo = useMemo(() => {
    if (!activeFeatureCenter || currentReview?.type !== 'tree' || currentReview.vertices.length < 3) return null;
    const c = activeFeatureCenter;
    let edgeVert = currentReview.vertices[0], best = -1;
    for (const v of currentReview.vertices) { const d = (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2; if (d > best) { best = d; edgeVert = v; } }
    return { center: c, edgeVert };
  }, [activeFeatureCenter, currentReview]);

  const setActiveVertices = useCallback((verts: [number, number][]) => {
    if (!currentReview) return;
    setFeatures(prev => prev.map(f => f.id === currentReview.id ? { ...f, vertices: verts } : f));
  }, [currentReview]);

  // Move: translate the pre-drag ring by the center handle's delta.
  const handleCenterDrag = useCallback((e: google.maps.MapMouseEvent) => {
    const ec = editCenterRef.current; if (!ec || !e.latLng) return;
    const dLng = e.latLng.lng() - ec.origCenter[0], dLat = e.latLng.lat() - ec.origCenter[1];
    setActiveVertices(ec.origVerts.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]));
  }, [setActiveVertices]);

  // Resize a tree: new radius = center→handle distance; regenerate the circle (matches confirmAddTree).
  const handleEdgeDrag = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng || !activeTreeInfo) return;
    const rKm = turf.distance(turf.point(activeTreeInfo.center), turf.point([e.latLng.lng(), e.latLng.lat()]), { units: 'kilometers' });
    if (rKm < 0.0005) return;
    const ring = (turf.circle(activeTreeInfo.center, rKm, { steps: 48, units: 'kilometers' }).geometry.coordinates[0] as [number, number][]).slice(0, -1);
    setActiveVertices(ring);
  }, [activeTreeInfo, setActiveVertices]);

  // Reshape a polygon: move the single dragged vertex, off the pre-drag ring.
  const handleVertexDrag = useCallback((e: google.maps.MapMouseEvent, i: number) => {
    if (!e.latLng) return;
    const base = origVertsRef.current.length ? origVertsRef.current : (currentReview?.vertices ?? []);
    setActiveVertices(base.map((p, idx) => idx === i ? [e.latLng!.lng(), e.latLng!.lat()] as [number, number] : p));
  }, [setActiveVertices, currentReview]);

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

  // Existing-feature outlines only show on the identify step (where you review them) — not while
  // drawing the boundary or marking the door.
  const showConfirmedFeatures = features.length > 0 && openStep === 'identify';

  // ── Imperative feature outlines ──────────────────────────────────────────────
  // @react-google-maps doesn't reliably update or remove <Polygon>/<Polyline>
  // overlays, leaving moved/deleted features ghosted at their old spot. We draw
  // the feature outlines directly on the map and clean them up on every change.
  useEffect(() => {
    if (!mapObj || !showConfirmedFeatures) return;
    const overlays: (google.maps.Polyline | google.maps.Polygon)[] = [];
    // Kept features — solid coloured outline.
    cfKeepGeoJSON.features.forEach((f) => {
      const color = FEATURE_COLOR[f.properties.featureType] ?? '#2F6B4F';
      overlays.push(new google.maps.Polyline({ map: mapObj, path: toPath(f.geometry.coordinates[0]), strokeColor: color, strokeWeight: 2.5, strokeOpacity: 1, clickable: false }));
    });
    // Active feature — yellow highlight so you can see which one the card is on.
    if (openStep === 'identify' && cfActiveGeoJSON) {
      const path = toPath(cfActiveGeoJSON.geometry.coordinates[0]);
      overlays.push(new google.maps.Polygon({ map: mapObj, paths: path, fillColor: '#F5C518', fillOpacity: 0.38, strokeOpacity: 0, clickable: false }));
      overlays.push(new google.maps.Polyline({ map: mapObj, path, strokeColor: '#F5C518', strokeWeight: 7, strokeOpacity: 0.35, clickable: false }));
      overlays.push(new google.maps.Polyline({ map: mapObj, path, strokeColor: '#FFFFFF', strokeWeight: 2.5, clickable: false }));
    }
    return () => { overlays.forEach((o) => o.setMap(null)); };
  }, [mapObj, cfKeepGeoJSON, cfActiveGeoJSON, openStep, showConfirmedFeatures]);

  const goToPlacement = useCallback(() => {
    if (vertices.length < 3) return;
    localStorage.setItem('diyBoundaryFinal', JSON.stringify({
      boundary:          vertices,
      confirmedFeatures: features.filter(f => f.keep),
      doorPoint,
    }));
    // Persist detected site zones (foundation band) for the layout/plant engines.
    try { localStorage.setItem('diySiteZones', JSON.stringify({ foundation: siteZones.foundation })); } catch { /* ignore */ }
    // Front yards only: fire off the Street View pass now (boundary + house features are final and
    // just written to diyBoundaryFinal, which the service reads) so it runs alongside the reveal
    // animation. The service self-gates and never throws; we await it before navigating (below).
    if (STREET_VIEW_ENABLED && svPromiseRef.current === null && sc.yard_type === 'front') {
      svPromiseRef.current = analyzeStreetView().catch(() => null);
    }
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
    if (USE_REVEAL_ANIMATION) {
      setReveal({ w, h, start });
      revealTimers.current.push(window.setTimeout(() => setMapFade(true), 2500)); // fade map once drawn over
    } else {
      // Blur + loading overlay instead of the reveal: hold for a minimum so the messages play, and
      // never longer than the Street View pass needs (capped at 8s), then go to plan-ready.
      setBuilding(true);
      const minDelay = new Promise(r => window.setTimeout(r, 3600));
      const svWait = svPromiseRef.current
        ? Promise.race([svPromiseRef.current, new Promise(r => window.setTimeout(r, 8000))])
        : Promise.resolve();
      Promise.all([minDelay, svWait]).then(() => navigate('/diy/plan-ready'));
    }
  }, [vertices, features, doorPoint]);

  // ── Map handlers ─────────────────────────────────────────────────────────────
  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (draggingIdx !== null || !e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    if (drawing) { setVertices(v => [...v, [lng, lat]]); return; }
    if (openStep === 'door') {
      setDoorPoint([lng, lat]);
      // Pulse the dot where they placed it for a beat, then advance to the feature review.
      let px: { x: number; y: number } | null = null;
      try { const p = projOverlayRef.current?.getProjection?.()?.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng)); if (p) px = { x: p.x, y: p.y }; } catch { /* ignore */ }
      setDoorPulse(px);
      // Hold on the door step until the marker + both ping rings have fully played (the 2nd ring starts
      // at 0.45s and finishes ~1.65s), then fade to the existing-features step — so the fade never cuts
      // the animation off mid-pulse.
      if (doorTimer.current) window.clearTimeout(doorTimer.current);
      doorTimer.current = window.setTimeout(() => { setDoorPulse(null); setOpenStep(prev => (prev === 'door' ? 'identify' : prev)); }, 1850);
      return;
    }
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
    // A double-click fires two click events first, leaving 1–2 near-duplicate vertices at the close
    // point — collapse consecutive vertices closer than ~2 ft before finishing.
    const snap = verticesRef.current.filter((v, i, arr) => {
      if (i === 0) return true;
      const p = arr[i - 1];
      try { return turf.distance(turf.point(p), turf.point(v), { units: 'feet' }) > 2; } catch { return true; }
    });
    if (snap.length < 3) { setDrawing(true); return; } // degenerate after dedupe — keep drawing
    setVertices(snap);
    const bd = (() => { try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null') ?? {}; } catch { return {}; } })();
    localStorage.setItem('diyBoundary', JSON.stringify({ ...bd, ring: snap }));
    const gen = ++detectGenRef.current;
    setDetecting(true);
    setFeatures([]); setReviewedIds([]); setActiveId(null);
    // Pencil re-trace the boundary (the overlay draws on, then STAYS in place of the green polygon).
    // Closing does NOT advance — the bottom-right button flips to "Continue" so the user advances
    // explicitly (and can review/redraw first). Detection runs in the background meanwhile.
    setTraceOn(true);
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
        const newFeats = clipFeaturesToBoundary(allFeats, snap);
        localStorage.setItem('diyDetectedFeatures', JSON.stringify(newFeats));
        setFeatures(newFeats);
      })
      .catch(() => {})
      .finally(() => { if (detectGenRef.current === gen) setDetecting(false); });
  }, []);
  handleBoundaryDoneRef.current = handleBoundaryDone;
  dblHandlerRef.current = (e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    const lng = e.latLng.lng(), lat = e.latLng.lat();
    // Close the project boundary — same interaction as finishing an added feature below (the
    // native dblclick listener + latest-closure ref is what makes this reliable).
    if (drawingRef.current && verticesRef.current.length >= 3) {
      handleBoundaryDoneRef.current?.();
      return;
    }
    // Finish an added feature polygon.
    if (openStep === 'identify' && isPolyAddMode && ePolyStep === 'drawing' && ePolyVerts.length >= 3) {
      if (addMode === 'other') setEPolyStep('attributes');
      else confirmAddSimplePoly();
      return;
    }
    // Insert a vertex when double-clicking on an edge of the active feature being edited (polygons
    // only — trees resize via their edge handle). Work in screen pixels so the hit tolerance is
    // zoom-independent, and snap the new point onto the segment it was dropped on.
    if (openStep === 'identify' && addMode === null && currentReview && currentReview.type !== 'tree'
        && currentReview.keep !== false && currentReview.vertices.length >= 3) {
      const proj = projOverlayRef.current?.getProjection?.();
      if (!proj) return;
      const toPx = (v: [number, number]): [number, number] | null => {
        const p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(v[1], v[0]));
        return p ? [p.x, p.y] : null;
      };
      const cp = toPx([lng, lat]);
      const vpx = currentReview.vertices.map(toPx);
      if (!cp || vpx.some(p => !p)) return;
      const V = vpx as [number, number][];
      const n = V.length;
      let bestI = -1, bestD = Infinity, bestPt: [number, number] | null = null;
      for (let i = 0; i < n; i++) {
        const a = V[i], b = V[(i + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((cp[0] - a[0]) * dx + (cp[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const px = a[0] + t * dx, py = a[1] + t * dy;
        const d = Math.hypot(cp[0] - px, cp[1] - py);
        if (d < bestD) { bestD = d; bestI = i; bestPt = [px, py]; }
      }
      if (bestI >= 0 && bestPt && bestD <= 12) {
        const ll = proj.fromContainerPixelToLatLng(new google.maps.Point(bestPt[0], bestPt[1]));
        if (ll) {
          const next = [...currentReview.vertices];
          next.splice(bestI + 1, 0, [ll.lng(), ll.lat()]);
          setActiveVertices(next);
        }
      }
      return;
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
    setTraceOn(false);
    setFeatures([]); setReviewedIds([]); setActiveId(null); cancelAdd();
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

  // Address entered above the map (for anyone who skipped it on the homepage): store it, recenter the
  // map to that lot (mapEpoch remount), and begin outlining.
  const handleAddressSelect = useCallback((address: string, lat: number, lng: number) => {
    try {
      const s = JSON.parse(localStorage.getItem('siteContext') || '{}');
      localStorage.setItem('siteContext', JSON.stringify({ ...s, address, lat, lng }));
    } catch { localStorage.setItem('siteContext', JSON.stringify({ address, lat, lng })); }
    localStorage.setItem('initialAddress', JSON.stringify({ address, lat, lng }));
    setSiteAddr({ lat, lng });
    setMapEpoch(e => e + 1);   // remount the map so it zooms to the new lot
    setDrawing(true);
  }, []);

  // No below-map "Start drawing" button anymore — auto-begin drawing once an address is set and the
  // user is on the boundary step with nothing drawn yet. Clicking the map adds corners; the on-map
  // "Done" button (top-center, shown while drawing) closes the shape.
  useEffect(() => {
    if (hasAddress && openStep === 'boundary' && vertices.length === 0 && !boundaryDone && !drawing) setDrawing(true);
  }, [hasAddress, openStep, vertices.length, boundaryDone, drawing]);

  // ── Render ───────────────────────────────────────────────────────────────────
  // Site setup is 3 steps; the plan page after it is a free-form editor (not numbered steps).
  const bProg = (() => {
    const i = Math.max(0, visibleSteps.indexOf(openStep ?? 'boundary'));
    return { num: i + 1, total: visibleSteps.length, pct: ((i + 1) / visibleSteps.length) * 100 };
  })();
  // Before an address is set (someone who skipped it on the homepage), the boundary step first asks
  // for the address above the map instead of the "outline your boundary" prompt.
  const needAddress = openStep === 'boundary' && !hasAddress;
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: PAGE_BG, overflow: 'hidden', paddingBottom: '4rem' }}>

      {/* Top bar — Logo left, stepper upper-right */}
      <div className="flex items-start justify-between px-10 flex-shrink-0" style={{ paddingTop: '2rem' }}>
        <Logo />
        {/* Continues the 6-step journey after preferences (yard·style·features = steps 1–3). */}
        <AppStepper step={3 + bProg.num} total={6} />
      </div>

      {/* Step instruction */}
      <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, fontWeight: 400, marginTop: '1.33rem', marginBottom: '1.6rem', paddingLeft: '2.5rem' }}>
        {needAddress ? 'Enter your home address to start designing' : stepInstruction(openStep ?? 'boundary', yardType)}
      </h1>

      {/* ── Subtitle (or address input) + map — centered column, fills remaining height ── */}
      <div className="flex-1 flex flex-col" style={{ minHeight: 0, width: '66.67%', margin: '0 auto' }}>
        <div style={{ margin: '0 0 0.7rem', flexShrink: 0 }}>
          {needAddress ? (
            <div className="hero-address-wrapper" style={{ display: 'flex', alignItems: 'center', backgroundColor: 'white', borderRadius: '100px', padding: '6px 18px', boxShadow: '0 4px 24px rgba(26,26,22,0.12)', maxWidth: '460px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: '8px' }}>
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="#9a9485" />
              </svg>
              <div style={{ flex: 1, minWidth: 0 }}><AddressInput onAddressSelect={handleAddressSelect} placeholder=" " /></div>
            </div>
          ) : (
            <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#6A6A60', margin: 0 }}>
              {STEP_SUBTITLE[openStep ?? 'boundary']}
            </p>
          )}
        </div>
        <div style={{ flex: 9, minHeight: 0, width: '100%', borderRadius: 20, overflow: 'hidden', position: 'relative' }}>
        <style>{`@keyframes doorMark { 0% { transform: translate(-50%,-50%) scale(0); } 60% { transform: translate(-50%,-50%) scale(1.18); } 100% { transform: translate(-50%,-50%) scale(1); } }`}</style>
        {/* Step-transition beat — briefly dims/blurs the map (~750ms) on each advance so the step change
            is unmistakable, then clears to reveal the map already in the new mode. No card, just the wipe. */}
        {transStep && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 60,
            background: 'rgba(20,18,12,0.34)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
            pointerEvents: 'none', animation: 'bStepScrim 750ms ease both' }}>
            <style>{`@keyframes bStepScrim { 0%{opacity:0} 18%{opacity:1} 74%{opacity:1} 100%{opacity:0} }`}</style>
          </div>
        )}
        <div ref={mapBoxRef} className="w-full h-full overflow-hidden relative" style={{ cursor: mapCursor }}>
          {/* The pencil boundary is rendered as a map overlay (see createPencilOverlay), so it stays
              anchored on pan/zoom — nothing to draw here. */}
          {/* Door placement pulse — expanding rings where the entry was just marked, for a beat. */}
          {doorPulse && (
            <div className="absolute" style={{ inset: 0, zIndex: 11, pointerEvents: 'none' }}>
              <style>{`@keyframes doorPing { 0% { transform: scale(0.35); opacity: 0.75; } 100% { transform: scale(2.6); opacity: 0; } }`}</style>
              {/* Play the two rings ONCE (forwards → stay faded out at the end) so the animation has a
                  defined finish; the advance below waits for it before fading to the next step. */}
              <span style={{ position: 'absolute', left: doorPulse.x - 24, top: doorPulse.y - 24, width: 48, height: 48, borderRadius: '50%', border: '2.5px solid #FFFFFF', boxShadow: '0 0 0 1.5px rgba(42,42,38,0.35)', boxSizing: 'border-box', animation: 'doorPing 1.2s ease-out forwards' }} />
              <span style={{ position: 'absolute', left: doorPulse.x - 24, top: doorPulse.y - 24, width: 48, height: 48, borderRadius: '50%', border: '2.5px solid #FFFFFF', boxSizing: 'border-box', animation: 'doorPing 1.2s ease-out 0.45s forwards' }} />
            </div>
          )}
          {/* Undo + Clear — top-left overlay while outlining the project area (replaces the old Redraw;
              Clear = start over, same as Redraw). Undo removes the last placed point. */}
          {openStep === 'boundary' && vertices.length > 0 && (
            <div className="absolute flex gap-2" style={{ top: 14, left: 14, zIndex: 10 }}>
              {drawing && (
                <button onClick={() => setVertices(v => v.slice(0, -1))}
                  className="px-4 py-2 rounded-full hover:opacity-90 transition-all"
                  style={{ border: 'none', background: 'white', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#2A2A26', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }}>
                  Undo
                </button>
              )}
              <button onClick={resetBoundary}
                className="px-4 py-2 rounded-full hover:opacity-90 transition-all"
                style={{ border: 'none', background: 'white', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#2A2A26', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }}>
                Clear
              </button>
            </div>
          )}
          {/* Reveal: illustrated plan draws over the live map, then the map fades out beneath it. */}
          {reveal && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: mapFade ? '#EFE9DA' : 'transparent', transition: 'background 1s ease' }}>
              <IllustrativeSite width={reveal.w} height={reveal.h} animate startTransform={reveal.start} finishOrientation={{ yardType }} onComplete={async () => {
                // Give the concurrent Street View pass a chance to land, but never block on it:
                // a null result (gated out / no coverage / failure) or an >8s stall proceeds anyway.
                const p = svPromiseRef.current;
                if (p) await Promise.race([p, new Promise(r => setTimeout(r, 8000))]);
                navigate('/diy/plan-ready');
              }} />
            </div>
          )}
          {isLoaded ? (
            <GoogleMap
              key={mapEpoch}
              mapContainerStyle={{ width: '100%', height: '100%' }}
              center={mapCenter}
              zoom={hasAddress ? 22 : 4}
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
              {/* Green boundary polygon — hidden once the pencil trace has taken over. */}
              {vertices.length >= 3 && !traceOn && (
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
                {/* Feature outlines (kept) are drawn imperatively — see effect above */}
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
                  <div style={{ transform: 'translate(-50%, -50%)', width: 20, height: 20, borderRadius: '50%', background: '#F5C518', border: '2.5px solid white', boxShadow: '0 1px 5px rgba(0,0,0,0.35)', animation: 'doorMark 0.38s cubic-bezier(0.34,1.56,0.64,1)' }} />
                </OverlayView>
              )}

              {/* Boundary vertex drag handles — only editable on the draw step. While actively
                  drawing they're INERT (clickable would swallow the 2nd click of a double-click,
                  since a marker spawns right under the cursor — the map would never see dblclick).
                  Once the ring is closed they become draggable edit handles. */}
              {openStep === 'boundary' && vertices.map((v, i) => (
                <Marker key={`v-${i}`}
                  position={{ lat: v[1], lng: v[0] }}
                  clickable={!drawing}
                  draggable={!drawing}
                  icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: 'white', fillOpacity: 1, strokeColor: '#2F6B4F', strokeWeight: 2.5 }}
                  onDragStart={() => setDraggingIdx(i)}
                  onDrag={e => { if (e.latLng) setVertices(prev => prev.map((p, idx) => idx === i ? [e.latLng!.lng(), e.latLng!.lat()] : p)); }}
                  onDragEnd={() => setDraggingIdx(null)}
                />
              ))}

              {/* Active existing-feature edit handles (identify step): the yellow center dot MOVES the
                  whole feature; a tree also gets an edge dot to RESIZE its canopy, while a polygon
                  gets a white dot per vertex to RESHAPE it. */}
              {openStep === 'identify' && currentReview && currentReview.keep !== false && activeFeatureCenter && (<>
                <Marker position={{ lat: activeFeatureCenter[1], lng: activeFeatureCenter[0] }} draggable
                  icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#F5C518', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2.5 }}
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
                  ))}
              </>)}
            </GoogleMap>
          ) : (
            <div style={{ width: '100%', height: '100%', background: '#2A2A26' }} />
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

          {/* Area / Perimeter — upper-right overlay, shown once the boundary is closed (all steps) */}
          {boundaryDone && (
            <div className="absolute flex gap-5 rounded-2xl"
              style={{ top: 14, right: 14, zIndex: 10, background: 'white', padding: '10px 16px', boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}>
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
          )}

          {/* Existing-features review — white overlay pinned to the map's bottom, identify step only */}
          {openStep === 'identify' && boundaryDone && (
            <div className="absolute"
              style={{ top: 14, left: 14, width: 307, maxWidth: 'calc(100% - 28px)', zIndex: 10, background: 'white', borderRadius: 16, padding: '14px 16px', boxShadow: '0 8px 30px rgba(0,0,0,0.18)', maxHeight: 'calc(100% - 28px)', overflowY: 'auto' }}>


              {addPickerOpen || addMode !== null ? (
                <div className="flex flex-col gap-3">
                  {addMode === null ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', fontWeight: 500 }}>What type of feature?</span>
                        <button onClick={() => { setAddPickerOpen(false); setAddLabel(''); }}
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
              ) : !allReviewed ? (
                /* STATE A — one feature at a time (the active one). */
                currentReview ? (
                  (() => {
                    const reviewIdx = liveFeatures.findIndex(f => f.id === currentReview.id);
                    return (
                  <div className="flex flex-col gap-2.5">
                    {/* Top: small back · segmented progress · position count */}
                    <div className="flex items-center gap-2.5">
                      <button onClick={() => (reviewedIds.length > 0 ? reopenReview() : setOpenStep('door'))} title="Back"
                        className="flex items-center justify-center rounded-full transition-all hover:opacity-80"
                        style={{ flexShrink: 0, width: 30, height: 30, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', color: '#2A2A26', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>
                        ←
                      </button>
                      <div className="flex items-center gap-1" style={{ flex: 1, minWidth: 0 }}>
                        {liveFeatures.map((f, i) => (
                          <div key={f.id} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= reviewIdx ? '#2F6B4F' : '#D9D4CA' }} />
                        ))}
                      </div>
                      <span style={{ flexShrink: 0, fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#6A6A60' }}>{reviewIdx + 1}/{liveFeatures.length}</span>
                    </div>
                    {/* Feature: dot · name + footprint · remove (✕) · confirm (✓) — compact */}
                    <div className="flex items-center gap-3" style={{ padding: '2px 0' }}>
                      <div style={{ flexShrink: 0, width: 14, height: 14, borderRadius: 4, background: FEATURE_COLOR[currentReview.type] ?? '#9A9A92' }} />
                      <div className="flex flex-col" style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontFamily: IT, fontSize: '0.95rem', fontWeight: 600, color: '#2A2A26', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toSentenceCase(currentReview.label || currentReview.type)}</span>
                        <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92' }}>{featureDetail(currentReview)}</span>
                      </div>
                      <button onClick={() => { const live = liveFeatures; const idx = live.findIndex(f => f.id === currentReview.id); if (idx >= 0 && idx < live.length - 1) setActiveId(live[idx + 1].id); resolveFeature(currentReview.id, 'remove'); }} title="Remove"
                        className="flex items-center justify-center rounded-full transition-all hover:opacity-90"
                        style={{ flexShrink: 0, width: 30, height: 30, background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1 }}>
                        ✕
                      </button>
                      <button onClick={() => confirmFeature(currentReview.id)} title="Confirm"
                        className="flex items-center justify-center rounded-full transition-all hover:opacity-90"
                        style={{ flexShrink: 0, width: 30, height: 30, background: '#2F6B4F', color: 'white', border: 'none', cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1 }}>
                        ✓
                      </button>
                    </div>
                  </div>
                    );
                  })()
                ) : null
              ) : (
                /* STATE B — all reviewed → add another feature. Pick a type first; only "Other" asks
                   for a name (in its attributes step), so there's no upfront label field here. */
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <button onClick={() => (reviewedIds.length > 0 ? reopenReview() : setOpenStep('door'))} title="Back"
                      className="flex items-center justify-center rounded-full transition-all hover:opacity-80"
                      style={{ flexShrink: 0, width: 30, height: 30, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', color: '#2A2A26', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>
                      ←
                    </button>
                    <span style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#9A9A92' }}>{liveFeatures.length} of {liveFeatures.length}</span>
                  </div>
                  <span style={{ fontFamily: IT, fontSize: '0.72rem', letterSpacing: '0.08em', color: '#9A9A92', fontWeight: 600, textTransform: 'uppercase' }}>Any other features?</span>
                  <button onClick={() => setAddPickerOpen(true)} title="Add feature"
                    className="flex items-center justify-center gap-2 transition-all hover:opacity-90"
                    style={{ width: '100%', background: '#2A2A26', color: 'white', border: 'none', borderRadius: 12, cursor: 'pointer', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, padding: '11px 14px' }}>
                    <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>+</span> Add a feature
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
        </div>
        {/* Shave ~10% off the map height (9:1 against this spacer) so it doesn't dominate the page. */}
        <div aria-hidden style={{ flex: 1, minHeight: 0 }} />
      </div>

      {/* ── Back / Continue — fixed bottom corners, matching the preferences flow ── */}
      {(() => {
        const order = visibleSteps;                                   // boundary → door → identify
        const i = Math.max(0, order.indexOf(openStep ?? 'boundary'));
        const last = i >= order.length - 1;                           // 'door' = last boundary step
        // The identify step can't be left until every detected feature is reviewed (confirmed or removed).
        const ready = openStep === 'boundary' ? boundaryDone : openStep === 'identify' ? allReviewed : openStep === 'door' ? doorPoint !== null : true;
        const busy = reveal !== null;                                  // reveal animation in progress
        // Boundary step is a two-state button: while drawing it's "Done drawing" (disabled until the
        // outline has 3+ points) and clicking it CLOSES the shape; once closed (or restored on re-entry)
        // it flips to "Continue" which advances. Clear resets to the disabled "Done drawing" state.
        const isBoundary = openStep === 'boundary';
        const canAct = isBoundary ? (boundaryDone || (drawing && vertices.length >= 3)) : ready;
        const boundaryLabel = boundaryDone ? 'Continue →' : 'Done drawing';
        return (
          <>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <BackButton disabled={busy} onClick={() => i > 0 ? setOpenStep(order[i - 1]) : navigate('/diy/preferences', { state: { step: 3 } })}
              className="fixed bottom-8 left-10" />
            <button onClick={() => {
                if (busy) return;
                if (isBoundary) { if (boundaryDone) setOpenStep(order[i + 1]); else handleBoundaryDone(); return; }
                if (last) goToPlacement(); else if (ready) setOpenStep(order[i + 1]);
              }} disabled={!canAct || busy}
              title={openStep === 'identify' && !allReviewed ? 'Review each existing feature to continue' : undefined}
              className="fixed bottom-8 right-10 flex items-center justify-center gap-2 px-7 py-3.5 rounded-full transition-all hover:opacity-90 disabled:opacity-60"
              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: (canAct && !busy) ? 'pointer' : 'default' }}>
              {busy ? (
                <>
                  <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', animation: 'spin 0.8s linear infinite' }} />
                  Preparing your plan…
                </>
              ) : isBoundary ? boundaryLabel : 'Continue →'}
            </button>
          </>
        );
      })()}

      {/* Building overlay — blurs the screen with a spinner + cycling messages while the plan is
          prepared (shown instead of the reveal animation), then navigates to plan-ready. */}
      {building && (
        <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ zIndex: 500, background: 'rgba(244,240,230,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <GrowingFlower size={148} />
          <p style={{ fontFamily: IT, fontSize: '1rem', color: '#2A2A26', fontWeight: 500, margin: '2px 0 0', transition: 'opacity 0.3s' }}>{BUILD_MESSAGES[buildMsg]}</p>
        </div>
      )}

      {/* Detecting overlay — detection runs in the background right after the boundary is drawn, but
          the spinner only surfaces once the main entry is marked (and only if it's still running). */}
      {detecting && doorPoint !== null && (
        <div className="fixed inset-0 flex flex-col items-center justify-center"
          style={{ zIndex: 500, background: 'rgba(244,240,230,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <GrowingFlower size={148} />
          <p style={{ fontFamily: IT, fontSize: '1rem', color: '#2A2A26', fontWeight: 500, margin: '2px 0 0' }}>Analyzing your site…</p>
          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: '5px 0 0' }}>Detecting trees, hardscape &amp; structures</p>
        </div>
      )}

      {/* Address-input pill styling (mirrors the homepage/address page) */}
      <style>{`
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder {
          box-shadow: none !important; border: none !important; border-radius: 0 !important;
          background: transparent !important; min-height: unset !important; width: 100% !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input {
          font-family: 'Inter Tight', sans-serif !important; font-size: 0.9rem !important;
          color: #2A2A26 !important; padding: 0 4px !important; height: 40px !important;
          line-height: 40px !important; background: transparent !important; min-width: 0 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input::placeholder { color: #a0a090 !important; }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-search { display: none !important; }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--button { background: transparent !important; padding: 0 8px !important; }
        .hero-address-wrapper .canopy-geocoder .suggestions {
          border-radius: 14px !important; box-shadow: 0 8px 28px rgba(26,26,22,0.14) !important;
          border: 1px solid rgba(26,26,22,0.08) !important; overflow: hidden; z-index: 100;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a {
          font-family: 'Inter Tight', sans-serif !important; font-size: 0.86rem !important; color: #2A2A26 !important; padding: 11px 16px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > .active > a,
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a:hover { background-color: #F4F0E6 !important; color: #2A2A26 !important; }
      `}</style>

    </div>
  );
}
