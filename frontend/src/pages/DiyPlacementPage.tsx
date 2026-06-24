import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSaveAndExit } from '../hooks/useSaveAndExit';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import Logo from '../components/Logo';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";
const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const PAD = 56;

// ── Feature colors (existing site features on map) ────────────────────────────
const FEATURE_COLOR: Record<string, string> = {
  house:      '#C4935A',
  tree:       '#4A8C6A',
  hardscape:  '#B5A48B',
  structure:  '#9A8B78',
  paving:     '#A09080',
  garden_bed: '#7A9A5A',
  utility:    '#8A8A7A',
};

// ── Toolbar item definitions ───────────────────────────────────────────────────
interface ToolbarItem {
  key:      string;
  label:    string;
  color:    string;
  defaultW: number;
  defaultH: number;
  shape:    'rect' | 'circle';
}

const OPTIONAL_TOOLS: Record<string, ToolbarItem> = {
  walkway: { key: 'walkway', label: 'Walkway',            color: '#C4AD8C', defaultW: 4,  defaultH: 14, shape: 'rect'   },
  seating: { key: 'seating', label: 'Seating / lounge',   color: '#B5A07A', defaultW: 12, defaultH: 12, shape: 'rect'   },
  dining:  { key: 'dining',  label: 'Dining area',        color: '#C4A84A', defaultW: 12, defaultH: 12, shape: 'rect'   },
  cooking: { key: 'cooking', label: 'Fire pit / cooking', color: '#B87060', defaultW: 8,  defaultH: 8,  shape: 'rect'   },
  water:   { key: 'water',   label: 'Water feature',      color: '#6B93A8', defaultW: 6,  defaultH: 6,  shape: 'circle' },
  garden:  { key: 'garden',  label: 'Raised beds',        color: '#7A8B4A', defaultW: 10, defaultH: 5,  shape: 'rect'   },
  storage: { key: 'storage', label: 'Utility zone',       color: '#9A8B78', defaultW: 10, defaultH: 10, shape: 'rect'   },
  trees:   { key: 'trees',   label: 'Shade trees',        color: '#5C8A5C', defaultW: 10, defaultH: 10, shape: 'circle' },
};

// ── Feature hints (placement guidance) ────────────────────────────────────────
const FEAT_HINTS: Record<string, string> = {
  seating: 'Close to the house for easy access, or at the far end to create a destination you walk toward.',
  dining:  "Best close to the house and kitchen door — you'll be carrying food out here.",
  cooking: 'Works as its own destination at the far end, or tucked into a corner as an evening gathering spot. Needs 10ft clearance from structures.',
  water:   '', // set inline based on lawn amount
  garden:  "Put these where they'll get the most sun — usually the edge furthest from the house and any large trees.",
  storage: 'Tuck this into the least visible corner — usually behind a fence line or in the side yard.',
  walkway: 'A clear path from the entrance to the main areas — keep it accessible and direct.',
  trees:   'Consider placement for shade on the west and south sides for afternoon cooling.',
};

const FEAT_ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage', 'trees'];

// ── Accordion step types ───────────────────────────────────────────────────────
type StepId = 'features' | 'walkways' | 'materials' | 'lawn' | 'review';

const STEP_TITLE: Record<StepId, string> = {
  features:  'Place your features',
  walkways:  'Walkways',
  materials: 'Ground material',
  lawn:      'Lawn',
  review:    'Review your plan',
};

type GroundMaterial = 'mulch' | 'rock';
type BedType = 'planted' | 'unplanted';

interface PlacedBed {
  id:       string;
  label:    string;
  type:     BedType;
  material: GroundMaterial;
  shape:    'rect' | 'circle' | 'organic' | 'poly';
  xFt:      number;  // bounding-box origin (unused for poly)
  yFt:      number;
  wFt:      number;
  hFt:      number;
  verts?:   [number, number][]; // ft coords for poly shape
}

const MATERIAL_COLOR: Record<GroundMaterial, string> = {
  mulch: '#8B6B4A',
  rock:  '#9A9A8C',
};

// ── Path style ─────────────────────────────────────────────────────────────────
type PathStyle = 'straight' | 'winding';

interface PlacedPath {
  id:      string;
  label:   string;
  startId: string; // zone id or 'door' or 'manual'
  endId:   string;
  pts:     [number, number][]; // [xFt, yFt]
  style:   PathStyle;
  widthFt: number;
}

const PATH_COLOR = '#C4AD8C';

// ── Types ──────────────────────────────────────────────────────────────────────
type ZoneShape = 'rect' | 'circle' | 'organic';

interface PlacedZone {
  id:    string;
  key:   string;
  label: string;
  color: string;
  shape: ZoneShape;
  xFt:   number;
  yFt:   number;
  wFt:   number;
  hFt:   number;
}

interface CS {
  widthFt:  number;
  heightFt: number;
  toXY:     (lng: number, lat: number) => [number, number];
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function ptInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segXsect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? [ax + t * d1x, ay + t * d1y] : null;
}

function clipPathToBoundary(pts: [number, number][], poly: [number, number][]): [number, number][] {
  if (pts.length < 2 || poly.length < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const aIn = ptInPoly(ax, ay, poly), bIn = ptInPoly(bx, by, poly);
    const hits: [number, number, number][] = [];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      const ix = segXsect(ax, ay, bx, by, poly[k][0], poly[k][1], poly[j][0], poly[j][1]);
      if (ix) {
        const len = Math.hypot(bx - ax, by - ay);
        hits.push([ix[0], ix[1], len > 0 ? Math.hypot(ix[0] - ax, ix[1] - ay) / len : 0]);
      }
    }
    hits.sort((a, b) => a[2] - b[2]);
    const allPts: [number, number][] = [
      ...(aIn ? [[ax, ay] as [number, number]] : []),
      ...hits.map(([x, y]) => [x, y] as [number, number]),
      ...(bIn ? [[bx, by] as [number, number]] : []),
    ];
    // Walk pairs; keep only segments whose midpoint is inside
    for (let k = 0; k < allPts.length - 1; k++) {
      const [px, py] = allPts[k], [qx, qy] = allPts[k + 1];
      if (!ptInPoly((px + qx) / 2, (py + qy) / 2, poly)) continue;
      if (out.length === 0 || out[out.length - 1][0] !== px || out[out.length - 1][1] !== py)
        out.push([px, py]);
      out.push([qx, qy]);
    }
  }
  return out.length >= 2 ? out : pts;
}

function truncateAtObstacles(pts: [number, number][], obstacles: [number, number][][]): [number, number][] {
  if (pts.length < 2 || obstacles.length === 0) return pts;
  const result: [number, number][] = [];

  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    const blocked = obstacles.some(obs => ptInPoly(px, py, obs));

    if (blocked) {
      // Find the earliest intersection from the previous point into any obstacle
      if (result.length > 0) {
        const [rx, ry] = result[result.length - 1];
        let earliest: [number, number, number] | null = null;
        for (const obs of obstacles) {
          for (let j = 0, k = obs.length - 1; j < obs.length; k = j++) {
            const ix = segXsect(rx, ry, px, py, obs[k][0], obs[k][1], obs[j][0], obs[j][1]);
            if (ix) {
              const d = Math.hypot(ix[0] - rx, ix[1] - ry);
              if (!earliest || d < earliest[2]) earliest = [ix[0], ix[1], d];
            }
          }
        }
        if (earliest) result.push([earliest[0], earliest[1]]);
      }
      break;
    }
    result.push([px, py]);
  }

  return result.length >= 2 ? result : pts;
}

function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avg    = (minLat + maxLat) / 2;
  const mLat   = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180);
  const FT     = 3.28084;
  return {
    widthFt:  (maxLng - minLng) * mLng * FT,
    heightFt: (maxLat - minLat) * mLat * FT,
    toXY:     (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
  };
}

function rrPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);    ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);    ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);    ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}

function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}

function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function organicPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, id: string) {
  const rng = seededRng(hashId(id));
  const N   = 9;
  const pts: [number, number][] = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const j = 0.78 + rng() * 0.44;
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j];
  });
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i];
    const p2 = pts[(i + 1) % N],     p3 = pts[(i + 2) % N];
    if (i === 0) ctx.moveTo(p1[0], p1[1]);
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
  ctx.closePath();
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function DiyPlacementPage() {
  const navigate = useNavigate();
  const saveAndExit = useSaveAndExit();

  // ── Data ────────────────────────────────────────────────────────────────────
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const prefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences')  || '{}'); } catch { return {}; } }, []);

  const boundary: [number, number][] = useMemo(() => saved.boundary          ?? [], [saved]);
  const existing: ConfirmedFeature[] = useMemo(() => saved.confirmedFeatures ?? [], [saved]);
  const featKeys: string[]           = useMemo(() => prefs.space_usage        ?? [], [prefs]);

  const lawnTarget: number = prefs.lawnTarget ?? 0;
  const lawnAmount: 'none' | 'some' | 'lot' = lawnTarget === 0 ? 'none' : lawnTarget >= 0.5 ? 'lot' : 'some';

  const cs = useMemo<CS | null>(() => boundary.length >= 3 ? buildCS(boundary) : null, [boundary]);
  const boundaryFt  = useMemo<[number, number][]>(() => cs ? boundary.map(v => cs.toXY(v[0], v[1])) : [], [cs, boundary]);
  const obstacleFt  = useMemo<[number, number][][]>(() => {
    if (!cs) return [];
    return existing
      .filter(f => f.keep && f.vertices.length >= 3 && (f.type === 'house' || f.type === 'hardscape'))
      .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][]);
  }, [cs, existing]);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const mapCenter = useMemo(() => {
    if (boundary.length === 0) return { lat: 39.74, lng: -104.99 };
    return {
      lat: boundary.reduce((s, v) => s + v[1], 0) / boundary.length,
      lng: boundary.reduce((s, v) => s + v[0], 0) / boundary.length,
    };
  }, [boundary]);

  // Feature items to show in the features step (in order, filtered to user's selections)
  const featItems = useMemo(() =>
    FEAT_ORDER
      .filter(k => featKeys.includes(k))
      .map(k => OPTIONAL_TOOLS[k])
      .filter(Boolean) as ToolbarItem[],
    [featKeys],
  );

  // ── Path state (declared early — used by draw + handlers below) ─────────────
  const doorPoint: [number, number] | null = useMemo(() => saved.doorPoint ?? null, [saved]);
  const defaultPathStyle: PathStyle = useMemo(() => {
    const s = prefs.style ?? '';
    return (s === 'natural_wild' || s === 'traditional') ? 'winding' : 'straight';
  }, [prefs]);
  const [paths,           setPaths]           = useState<PlacedPath[]>([]);
  const [globalPathStyle, setGlobalPathStyle] = useState<PathStyle>(defaultPathStyle);
  const [pathDrawMode,    setPathDrawMode]    = useState<'idle' | 'picking-start' | 'picking-end'>('idle');
  const pathDrawStart = useRef<[number, number] | null>(null);
  const [pathConnectStart, setPathConnectStart] = useState<{ id: string; label: string; pt: [number, number] } | null>(null);

  // ── Materials state ───────────────────────────────────────────────────────────
  const [defaultMaterial, setDefaultMaterial] = useState<GroundMaterial>('mulch');
  const [placedBeds,      setPlacedBeds]      = useState<PlacedBed[]>([]);
  const [addingBed,       setAddingBed]       = useState<{ step: 'type' | 'material' | 'draw'; type?: BedType; material?: GroundMaterial } | null>(null);

  const generatePathPts = useCallback((
    startFt: [number, number],
    endFt:   [number, number],
    style:   PathStyle,
    seed:    number,
  ): [number, number][] => {
    if (style === 'straight') return [startFt, endFt];
    const rng  = seededRng(seed);
    const dx   = endFt[0] - startFt[0], dy = endFt[1] - startFt[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return [startFt, endFt];
    const px = -dy / dist, py = dx / dist;
    const pts: [number, number][] = [startFt];
    for (let i = 1; i <= 3; i++) {
      const t      = i / 4;
      const offset = (rng() - 0.5) * dist * 0.35;
      pts.push([startFt[0] + dx * t + px * offset, startFt[1] + dy * t + py * offset]);
    }
    pts.push(endFt);
    return pts;
  }, []);

  const buildPath = useCallback((
    startFt: [number, number],
    endFt:   [number, number],
    style:   PathStyle,
    seed:    number,
  ): [number, number][] =>
    truncateAtObstacles(
      clipPathToBoundary(generatePathPts(startFt, endFt, style, seed), boundaryFtRef.current),
      obstacleFtRef.current,
    ),
  [generatePathPts]);

  // ── Canvas / scale ──────────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const [cssSize, setCssSize] = useState({ w: 900, h: 600 });

  const scale = useMemo(() => {
    if (!cs) return 5;
    return Math.min((cssSize.w - PAD * 2) / cs.widthFt, (cssSize.h - PAD * 2) / cs.heightFt);
  }, [cs, cssSize]);

  const ftToPx = useCallback((xFt: number, yFt: number): [number, number] => {
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * scale) / 2;
    const oy = (cssSize.h - cs.heightFt * scale) / 2;
    return [ox + xFt * scale, oy + yFt * scale];
  }, [cs, scale, cssSize]);

  const pxToFt = useCallback((cx: number, cy: number): [number, number] => {
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * scale) / 2;
    const oy = (cssSize.h - cs.heightFt * scale) / 2;
    return [(cx - ox) / scale, (cy - oy) / scale];
  }, [cs, scale, cssSize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setCssSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Zones + selection ───────────────────────────────────────────────────────
  const [placedZones,    setPlacedZones]    = useState<PlacedZone[]>([]);
  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedBedId,  setSelectedBedId]  = useState<string | null>(null);

  const zonesRef    = useRef<PlacedZone[]>([]);
  const selRef      = useRef<string | null>(null);
  const ghostRef    = useRef<{ item: ToolbarItem; cx: number; cy: number } | null>(null);
  const scaleRef    = useRef(scale);
  const ftToPxRef   = useRef(ftToPx);
  const pxToFtRef   = useRef(pxToFt);
  const existingRef = useRef<ConfirmedFeature[]>([]);
  const pathsRef       = useRef<PlacedPath[]>([]);
  const bedsRef        = useRef<PlacedBed[]>([]);
  const selBedRef      = useRef<string | null>(null);
  const addingBedRef      = useRef<{ step: 'type' | 'material' | 'draw'; type?: BedType; material?: GroundMaterial } | null>(null);
  const bedDrawVertsRef   = useRef<[number, number][]>([]);
  const bedDrawCursorRef  = useRef<[number, number] | null>(null);
  const isDblClickRef     = useRef(false);
  const boundaryFtRef  = useRef<[number, number][]>([]);
  const obstacleFtRef  = useRef<[number, number][][]>([]);
  const doorPointRef   = useRef<[number, number] | null>(null);
  const csRef          = useRef<CS | null>(null);

  useEffect(() => { zonesRef.current    = placedZones; }, [placedZones]);
  useEffect(() => { selRef.current      = selectedId;  }, [selectedId]);
  useEffect(() => { scaleRef.current    = scale;       }, [scale]);
  useEffect(() => { ftToPxRef.current   = ftToPx;      }, [ftToPx]);
  useEffect(() => { pxToFtRef.current   = pxToFt;      }, [pxToFt]);
  useEffect(() => { existingRef.current = existing;    }, [existing]);
  const selectedPathIdRef = useRef<string | null>(null);
  useEffect(() => { pathsRef.current         = paths;          }, [paths]);
  useEffect(() => { selectedPathIdRef.current = selectedPathId; }, [selectedPathId]);
  useEffect(() => { boundaryFtRef.current  = boundaryFt;  }, [boundaryFt]);
  useEffect(() => { obstacleFtRef.current  = obstacleFt;  }, [obstacleFt]);
  useEffect(() => { doorPointRef.current   = doorPoint;   }, [doorPoint]);
  useEffect(() => { csRef.current          = cs;          }, [cs]);
  useEffect(() => { bedsRef.current        = placedBeds;    }, [placedBeds]);
  useEffect(() => { selBedRef.current      = selectedBedId;  }, [selectedBedId]);
  useEffect(() => { addingBedRef.current   = addingBed;      }, [addingBed]);

  // ── Draw ────────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cs) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx  = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h } = cssSize;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const zones    = zonesRef.current;
    const selId    = selRef.current;
    const curPaths = pathsRef.current;

    const appendZonePath = (zone: PlacedZone) => {
      const [px, py] = ftToPxRef.current(zone.xFt, zone.yFt);
      const pw = zone.wFt * scaleRef.current, ph = zone.hFt * scaleRef.current;
      if (zone.shape === 'circle') {
        ctx.ellipse(px + pw / 2, py + ph / 2, pw / 2, ph / 2, 0, 0, Math.PI * 2);
      } else if (zone.shape === 'organic') {
        organicPath(ctx, px + pw / 2, py + ph / 2, pw / 2, ph / 2, zone.id);
      } else {
        rrPath(ctx, px, py, pw, ph, 7);
      }
    };

    // Draw paths beneath zones
    for (const path of curPaths) {
      if (path.pts.length < 2) continue;
      const pxPts    = path.pts.map(([xFt, yFt]) => ftToPxRef.current(xFt, yFt));
      const isSelPth = path.id === selectedPathIdRef.current;
      ctx.save();
      ctx.strokeStyle = isSelPth ? '#8C6B44' : PATH_COLOR;
      ctx.lineWidth   = Math.max(isSelPth ? 5 : 2, path.widthFt * scaleRef.current);
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.globalAlpha = isSelPth ? 1 : 0.85;
      ctx.beginPath();
      ctx.moveTo(pxPts[0][0], pxPts[0][1]);
      if (path.style === 'straight' || pxPts.length <= 2) {
        for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i][0], pxPts[i][1]);
      } else {
        // Catmull-Rom through pts
        for (let i = 0; i < pxPts.length - 1; i++) {
          const p0 = pxPts[Math.max(i - 1, 0)];
          const p1 = pxPts[i], p2 = pxPts[i + 1];
          const p3 = pxPts[Math.min(i + 2, pxPts.length - 1)];
          ctx.bezierCurveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1],
          );
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // Draw beds beneath zones
    for (const bed of bedsRef.current) {
      const isSel  = bed.id === selBedRef.current;
      const color  = MATERIAL_COLOR[bed.material];
      ctx.save();
      ctx.beginPath();

      if (bed.shape === 'poly' && bed.verts && bed.verts.length >= 3) {
        const pxV = bed.verts.map(v => ftToPxRef.current(v[0], v[1]));
        ctx.moveTo(pxV[0][0], pxV[0][1]);
        for (let i = 1; i < pxV.length; i++) ctx.lineTo(pxV[i][0], pxV[i][1]);
        ctx.closePath();
        ctx.fillStyle   = color + (isSel ? 'CC' : '77');
        ctx.strokeStyle = color;
        ctx.lineWidth   = isSel ? 2 : 1;
        if (isSel) ctx.setLineDash([5, 4]);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        // centroid label
        const cx = pxV.reduce((s, p) => s + p[0], 0) / pxV.length;
        const cy = pxV.reduce((s, p) => s + p[1], 0) / pxV.length;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = `500 10px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(bed.label.toUpperCase(), cx, cy);
      } else {
        const [px, py] = ftToPxRef.current(bed.xFt, bed.yFt);
        const pw = bed.wFt * scaleRef.current, ph = bed.hFt * scaleRef.current;
        if (bed.shape === 'circle') {
          ctx.ellipse(px + pw / 2, py + ph / 2, pw / 2, ph / 2, 0, 0, Math.PI * 2);
        } else if (bed.shape === 'organic') {
          organicPath(ctx, px + pw / 2, py + ph / 2, pw / 2, ph / 2, bed.id);
        } else {
          rrPath(ctx, px, py, pw, ph, 5);
        }
        ctx.fillStyle   = color + (isSel ? 'CC' : '77');
        ctx.strokeStyle = color;
        ctx.lineWidth   = isSel ? 2 : 1;
        if (isSel) ctx.setLineDash([5, 4]);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        if (pw > 36 && ph > 18) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = `500 ${Math.max(8, Math.min(11, pw / 10))}px ${IT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(bed.label.toUpperCase(), px + pw / 2, py + ph / 2);
        }
        if (isSel) {
          ctx.fillStyle = 'white'; ctx.strokeStyle = color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.rect(px + pw - 7, py + ph - 7, 14, 14);
          ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
    }

    for (const zone of zones) {
      const [px, py] = ftToPxRef.current(zone.xFt, zone.yFt);
      const pw = zone.wFt * scaleRef.current, ph = zone.hFt * scaleRef.current;
      const isSel = zone.id === selId;

      ctx.save();
      ctx.beginPath();
      appendZonePath(zone);
      ctx.strokeStyle = isSel ? zone.color : zone.color + 'BB';
      ctx.lineWidth   = isSel ? 2 : 1.5;
      if (isSel) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (pw > 40 && ph > 22) {
        const fs = Math.max(8, Math.min(12, pw / 9));
        ctx.fillStyle    = zone.color + 'CC';
        ctx.font         = `500 ${fs}px ${IT}`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(zone.label.toUpperCase(), px + pw / 2, py + ph / 2);
      }
      ctx.restore();

      if (isSel) {
        ctx.save();
        ctx.fillStyle   = 'white';
        ctx.strokeStyle = zone.color;
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.rect(px + pw - 7, py + ph - 7, 14, 14);
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }

    const ghost = ghostRef.current;
    if (ghost) {
      const pw = ghost.item.defaultW * scaleRef.current;
      const ph = ghost.item.defaultH * scaleRef.current;
      ctx.save(); ctx.globalAlpha = 0.6;
      ctx.beginPath();
      if (ghost.item.shape === 'circle') {
        ctx.ellipse(ghost.cx, ghost.cy, pw / 2, ph / 2, 0, 0, Math.PI * 2);
      } else {
        rrPath(ctx, ghost.cx - pw / 2, ghost.cy - ph / 2, pw, ph, 7);
      }
      ctx.strokeStyle = ghost.item.color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Bed polygon draw preview
    const drawVerts = bedDrawVertsRef.current;
    const drawCursor = bedDrawCursorRef.current;
    if (drawVerts.length > 0 && addingBedRef.current?.step === 'draw') {
      const mat   = addingBedRef.current.material ?? 'mulch';
      const color = MATERIAL_COLOR[mat];
      const pxV   = drawVerts.map(v => ftToPxRef.current(v[0], v[1]));
      const curPx = drawCursor ? ftToPxRef.current(drawCursor[0], drawCursor[1]) : null;

      ctx.save();
      // Filled polygon preview (3+ pts)
      if (pxV.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(pxV[0][0], pxV[0][1]);
        for (let i = 1; i < pxV.length; i++) ctx.lineTo(pxV[i][0], pxV[i][1]);
        ctx.closePath();
        ctx.fillStyle = color + '44';
        ctx.fill();
      }
      // Outline + rubber-band to cursor
      ctx.beginPath();
      ctx.moveTo(pxV[0][0], pxV[0][1]);
      for (let i = 1; i < pxV.length; i++) ctx.lineTo(pxV[i][0], pxV[i][1]);
      if (curPx) {
        ctx.lineTo(curPx[0], curPx[1]);
        ctx.lineTo(pxV[0][0], pxV[0][1]); // ghost close
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.stroke(); ctx.setLineDash([]);
      // Vertex dots
      for (const [vx, vy] of pxV) {
        ctx.beginPath(); ctx.arc(vx, vy, 4, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      // Highlight first vertex (close-polygon target)
      if (pxV.length >= 3) {
        ctx.beginPath(); ctx.arc(pxV[0][0], pxV[0][1], 6, 0, Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }
  }, [cs, cssSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(cssSize.w * dpr);
    canvas.height = Math.floor(cssSize.h * dpr);
    canvas.style.width  = cssSize.w + 'px';
    canvas.style.height = cssSize.h + 'px';
    draw();
  }, [cssSize, draw]);

  useEffect(() => { draw(); }, [draw, placedZones, selectedId, paths, selectedPathId, placedBeds, selectedBedId]);

  // ── Drag ref ─────────────────────────────────────────────────────────────────
  const dragRef = useRef<{
    kind:    'move' | 'resize';
    zoneId:  string;
    startMx: number; startMy: number;
    origX:   number; origY:   number;
    origW:   number; origH:   number;
  } | null>(null);

  const bedDragRef = useRef<{
    kind:      'move' | 'resize';
    bedId:     string;
    startMx:   number; startMy: number;
    origX:     number; origY:   number;
    origW:     number; origH:   number;
    origVerts?: [number, number][];
  } | null>(null);

  // ── Hit test ─────────────────────────────────────────────────────────────────
  const hitTest = useCallback((mx: number, my: number) => {
    const zones = zonesRef.current;
    const sel   = selRef.current;
    for (let i = zones.length - 1; i >= 0; i--) {
      const z        = zones[i];
      const [px, py] = ftToPxRef.current(z.xFt, z.yFt);
      const pw = z.wFt * scaleRef.current, ph = z.hFt * scaleRef.current;
      if (z.id === sel) {
        if (mx >= px + pw - 13 && mx <= px + pw + 5 && my >= py + ph - 13 && my <= py + ph + 5)
          return { zone: z, part: 'resize' as const };
      }
      if (mx >= px && mx <= px + pw && my >= py && my <= py + ph)
        return { zone: z, part: 'move' as const };
    }
    return null;
  }, []);

  const hitTestBed = useCallback((mx: number, my: number) => {
    const beds = bedsRef.current;
    const sel  = selBedRef.current;
    for (let i = beds.length - 1; i >= 0; i--) {
      const b = beds[i];

      if (b.shape === 'poly' && b.verts && b.verts.length >= 3) {
        const [xFt, yFt] = pxToFtRef.current(mx, my);
        if (ptInPoly(xFt, yFt, b.verts)) return { bed: b, part: 'move' as const };
        continue;
      }

      const [px, py] = ftToPxRef.current(b.xFt, b.yFt);
      const pw = b.wFt * scaleRef.current, ph = b.hFt * scaleRef.current;
      if (b.id === sel) {
        if (mx >= px + pw - 13 && mx <= px + pw + 5 && my >= py + ph - 13 && my <= py + ph + 5)
          return { bed: b, part: 'resize' as const };
      }
      if (mx >= px && mx <= px + pw && my >= py && my <= py + ph)
        return { bed: b, part: 'move' as const };
    }
    return null;
  }, []);

  const getPos = (e: React.MouseEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my] = getPos(e);

    if (addingBedRef.current?.step === 'draw') return; // handled by onClick / onDoubleClick

    if (pathDrawMode === 'picking-start') {
      pathDrawStart.current = pxToFt(mx, my);
      setPathDrawMode('picking-end');
      return;
    }
    if (pathDrawMode === 'picking-end' && pathDrawStart.current) {
      const endFt = pxToFt(mx, my);
      const seed  = Date.now() % 9999;
      const newPath: PlacedPath = {
        id:      `path_manual_${Date.now()}`,
        label:   'Custom walkway',
        startId: 'manual',
        endId:   'manual',
        pts:     buildPath(pathDrawStart.current, endFt, globalPathStyle, seed),
        style:   globalPathStyle,
        widthFt: 3,
      };
      setPaths(prev => [...prev, newPath]);
      pathDrawStart.current = null;
      setPathDrawMode('idle');
      return;
    }

    const hit = hitTest(mx, my);
    if (!hit) {
      const bedHit = hitTestBed(mx, my);
      if (bedHit) {
        selBedRef.current = bedHit.bed.id; setSelectedBedId(bedHit.bed.id);
        selRef.current = null; setSelectedId(null);
        bedDragRef.current = {
          kind: bedHit.part, bedId: bedHit.bed.id,
          startMx: mx, startMy: my,
          origX: bedHit.bed.xFt, origY: bedHit.bed.yFt,
          origW: bedHit.bed.wFt, origH: bedHit.bed.hFt,
          origVerts: bedHit.bed.verts ? [...bedHit.bed.verts] : undefined,
        };
      } else {
        selRef.current = null; setSelectedId(null);
        selBedRef.current = null; setSelectedBedId(null);
      }
      return;
    }
    selRef.current = hit.zone.id;
    setSelectedId(hit.zone.id);
    selBedRef.current = null; setSelectedBedId(null);
    dragRef.current = {
      kind: hit.part, zoneId: hit.zone.id,
      startMx: mx, startMy: my,
      origX: hit.zone.xFt, origY: hit.zone.yFt,
      origW: hit.zone.wFt, origH: hit.zone.hFt,
    };
  }, [hitTest, hitTestBed, pathDrawMode, pxToFt, buildPath, globalPathStyle]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my]  = getPos(e);

    // Live bed draw preview
    if (addingBedRef.current?.step === 'draw') {
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      bedDrawCursorRef.current = pxToFtRef.current(mx, my);
      draw();
      return;
    }

    const drag      = dragRef.current;
    const bedDrag   = bedDragRef.current;
    if (!drag && !bedDrag) {
      if (canvasRef.current) {
        if (pathDrawMode !== 'idle') {
          canvasRef.current.style.cursor = 'crosshair';
        } else {
          const hit = hitTest(mx, my);
          if (hit) {
            canvasRef.current.style.cursor = hit.part === 'resize' ? 'se-resize' : 'move';
          } else {
            const bedHit = hitTestBed(mx, my);
            canvasRef.current.style.cursor = bedHit
              ? bedHit.part === 'resize' ? 'se-resize' : 'move'
              : 'default';
          }
        }
      }
      return;
    }
    if (bedDrag) {
      const dxFt = (mx - bedDrag.startMx) / scaleRef.current;
      const dyFt = (my - bedDrag.startMy) / scaleRef.current;
      bedsRef.current = bedsRef.current.map(b => {
        if (b.id !== bedDrag.bedId) return b;
        if (bedDrag.kind === 'move') {
          if (b.shape === 'poly' && bedDrag.origVerts) {
            return { ...b, verts: bedDrag.origVerts.map(v => [v[0] + dxFt, v[1] + dyFt] as [number, number]) };
          }
          return { ...b, xFt: bedDrag.origX + dxFt, yFt: bedDrag.origY + dyFt };
        }
        return { ...b, wFt: Math.max(3, bedDrag.origW + dxFt), hFt: Math.max(3, bedDrag.origH + dyFt) };
      });
      draw();
      return;
    }
    if (!drag) return;
    const dxFt = (mx - drag.startMx) / scaleRef.current;
    const dyFt = (my - drag.startMy) / scaleRef.current;
    zonesRef.current = zonesRef.current.map(z => {
      if (z.id !== drag.zoneId) return z;
      if (drag.kind === 'move') return { ...z, xFt: drag.origX + dxFt, yFt: drag.origY + dyFt };
      return { ...z, wFt: Math.max(3, drag.origW + dxFt), hFt: Math.max(3, drag.origH + dyFt) };
    });
    draw();
  }, [hitTest, hitTestBed, draw]);

  const handleMouseUp = useCallback(() => {
    if (addingBedRef.current?.step === 'draw') return; // finalised via onDoubleClick
    if (bedDragRef.current) {
      setPlacedBeds([...bedsRef.current]);
      bedDragRef.current = null;
      return;
    }
    if (!dragRef.current) return;
    const movedId = dragRef.current.zoneId;
    const zones   = zonesRef.current;
    setPlacedZones([...zones]);
    dragRef.current = null;

    const getNodePt = (id: string): [number, number] | null => {
      if (id === 'door') {
        const dp = doorPointRef.current, csNow = csRef.current;
        return (dp && csNow) ? csNow.toXY(dp[0], dp[1]) : null;
      }
      const z = zones.find(z => z.id === id);
      return z ? [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2] : null;
    };

    setPaths(prev => prev.map(p => {
      if (p.startId !== movedId && p.endId !== movedId) return p;
      const startPt = getNodePt(p.startId), endPt = getNodePt(p.endId);
      if (!startPt || !endPt) return p;
      const seed = p.id.split('').reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
      return { ...p, pts: truncateAtObstacles(clipPathToBoundary(generatePathPts(startPt, endPt, p.style, seed), boundaryFtRef.current), obstacleFtRef.current) };
    }));
  }, [generatePathPts]);

  // ── Drag from sidebar ────────────────────────────────────────────────────────
  const draggingItem = useRef<ToolbarItem | null>(null);

  const handleToolDragStart = (item: ToolbarItem) => (e: React.DragEvent) => {
    draggingItem.current = item;
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
  };

  const handleCanvasDragOver = useCallback((e: React.DragEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!draggingItem.current) return;
    const r = canvasRef.current!.getBoundingClientRect();
    ghostRef.current = { item: draggingItem.current, cx: e.clientX - r.left, cy: e.clientY - r.top };
    draw();
  }, [draw]);

  const handleCanvasDrop = useCallback((e: React.DragEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const item = draggingItem.current;
    if (!item) return;
    const r  = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const [xFt, yFt] = pxToFt(cx - item.defaultW * scaleRef.current / 2, cy - item.defaultH * scaleRef.current / 2);
    const newZone: PlacedZone = {
      id: `z_${Date.now()}`, key: item.key, label: item.label,
      color: item.color, shape: item.shape,
      xFt, yFt, wFt: item.defaultW, hFt: item.defaultH,
    };
    const updated = [...zonesRef.current, newZone];
    zonesRef.current     = updated;
    selRef.current       = newZone.id;
    ghostRef.current     = null;
    draggingItem.current = null;
    setPlacedZones(updated);
    setSelectedId(newZone.id);
    selBedRef.current = null; setSelectedBedId(null);
    draw();
  }, [pxToFt, draw]);

  const handleCanvasDragLeave = useCallback(() => {
    ghostRef.current = null;
    draw();
  }, [draw]);

  // ── Bed polygon drawing ──────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (addingBedRef.current?.step !== 'draw') return;
    const pos = getPos(e);
    setTimeout(() => {
      if (isDblClickRef.current) return; // swallowed by double-click
      bedDrawVertsRef.current = [...bedDrawVertsRef.current, pxToFtRef.current(pos[0], pos[1])];
      draw();
    }, 0);
  }, [draw]);

  const handleCanvasDblClick = useCallback((_e: React.MouseEvent<HTMLCanvasElement>) => {
    if (addingBedRef.current?.step !== 'draw') return;
    isDblClickRef.current = true;
    setTimeout(() => { isDblClickRef.current = false; }, 300);

    const verts = bedDrawVertsRef.current;
    if (verts.length < 3) return; // not enough points yet

    const { type = 'planted', material = 'mulch' } = addingBedRef.current!;
    const newBed: PlacedBed = {
      id:    `bed_${Date.now()}`,
      label: type === 'planted' ? 'Planted bed' : 'Unplanted area',
      type, material, shape: 'poly',
      xFt: 0, yFt: 0, wFt: 0, hFt: 0,
      verts: [...verts],
    };
    const updated = [...bedsRef.current, newBed];
    bedsRef.current          = updated;
    selBedRef.current        = newBed.id;
    bedDrawVertsRef.current  = [];
    bedDrawCursorRef.current = null;
    setPlacedBeds(updated);
    setSelectedBedId(newBed.id);
    selRef.current = null; setSelectedId(null);
    setAddingBed(null);
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const map  = mapRef.current;
      if (!map) return;
      const zoom = map.getZoom() ?? 20;
      map.setZoom(e.deltaY < 0 ? zoom + 1 : zoom - 1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // ── Accordion state ──────────────────────────────────────────────────────────
  const [openStep,  setOpenStep]  = useState<StepId | null>('features');
  const [doneSteps, setDoneSteps] = useState<Set<StepId>>(new Set());

  // Visible steps
  const visibleSteps = useMemo<StepId[]>(() => [
    'features',
    'walkways',
    'materials',
    ...(lawnAmount !== 'none' ? ['lawn' as StepId] : []),
    'review',
  ], [lawnAmount]);

  const getNextStep = useCallback((from: StepId): StepId | null => {
    const idx = visibleSteps.indexOf(from);
    return idx >= 0 && idx + 1 < visibleSteps.length ? visibleSteps[idx + 1] : null;
  }, [visibleSteps]);

  const advanceToNext = useCallback((from: StepId) => {
    setDoneSteps(prev => new Set([...prev, from]));
    setOpenStep(getNextStep(from));
  }, [getNextStep]);

  const isDoneStep = (id: StepId) => doneSteps.has(id);

  // ── Stats
  const boundaryAreaFt = useMemo(() => {
    if (!cs || boundary.length < 3) return 0;
    const pts = boundary.map(v => cs.toXY(v[0], v[1]));
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return Math.round(Math.abs(area / 2));
  }, [cs, boundary]);

  const zoneAreaFt = Math.round(placedZones.reduce((s, z) => s + z.wFt * z.hFt, 0));
  const lawnAreaFt = Math.max(0, boundaryAreaFt - zoneAreaFt);
  const lawnPct    = boundaryAreaFt > 0 ? Math.round(lawnAreaFt / boundaryAreaFt * 100) : 0;

  const waterHint = lawnAmount === 'none'
    ? "Since you're not planning much lawn, position this as a focal point — something you walk toward or see from the house."
    : lawnAmount === 'lot'
    ? 'A focal point at the far end works especially well with more lawn — gives the open space a visual anchor.'
    : "Place where it'll be visible from your main seating area — either as a backdrop behind it, or at the far end as a focal point.";

  // Selection panel
  const selectedZone = placedZones.find(z => z.id === selectedId) ?? null;
  const areaSqFt     = selectedZone ? Math.round(selectedZone.wFt * selectedZone.hFt) : 0;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col pt-8" style={{ backgroundColor: '#E7E1D5', overflow: 'hidden' }}>

      {/* Header */}
      <div className="flex items-start justify-between px-10 mb-6 flex-shrink-0">
        <Logo />
        <button onClick={saveAndExit}
          style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
          Save & exit ↗
        </button>
      </div>

      <div className="flex-shrink-0" style={{ paddingLeft: '8rem', marginTop: '2rem', marginBottom: '3.5rem' }}>
        <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Design your yard.</h1>
      </div>

      <div className="flex flex-1 overflow-hidden pr-32 gap-5 items-start" style={{ paddingBottom: '1.25rem', paddingLeft: '8rem' }}>

        {/* ── Left sidebar ── */}
        <div className="flex flex-col flex-shrink-0" style={{ width: '33%', height: '81%', background: '#EFE9DA', overflow: 'hidden', borderRadius: '1rem', boxShadow: '0 12px 48px rgba(0,0,0,0.12)' }}>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            {/* Toolbar title */}
            <div style={{ padding: '1.25rem 1.25rem 0' }}>
              <h2 style={{ fontFamily: IS, fontSize: '1.5rem', color: '#2A2A26', lineHeight: 1.1, margin: 0, fontWeight: 400 }}>Place your features</h2>
              <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', marginTop: '0.35rem' }}>
                Drag each feature onto the map, then fine-tune its size and spot.
              </p>
            </div>

            {/* Accordion */}
            <div style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
              {visibleSteps.map((stepId, idx) => {
                const isOpen = openStep === stepId;
                const isDone = isDoneStep(stepId);

                // Status text shown in collapsed header
                const statusText = (() => {
                  if (stepId === 'features') {
                    const placed = featItems.filter(t => placedZones.some(z => z.key === t.key)).length;
                    return featItems.length > 0 && placed > 0 ? `— ${placed} of ${featItems.length} placed` : null;
                  }
                  if (stepId === 'walkways') {
                    const zones = placedZones.filter(z => z.key === 'walkway').length;
                    const conns = paths.length;
                    const total = zones + conns;
                    return total > 0 ? `— ${total} placed` : null;
                  }
                  if (stepId === 'materials') return `— ${defaultMaterial}${placedBeds.length > 0 ? `, ${placedBeds.length} bed${placedBeds.length !== 1 ? 's' : ''}` : ''}`;
                  if (stepId === 'lawn') return boundaryAreaFt > 0 ? `— ${lawnPct}%` : null;
                  return null;
                })();

                return (
                  <div key={stepId}>
                    {idx > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}

                    {/* Step header */}
                    <button
                      className="w-full flex items-center gap-3 px-5 py-3.5 transition-all hover:opacity-80"
                      style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                      onClick={() => setOpenStep(isOpen ? null : stepId)}>
                      <div style={{
                        width: 26, height: 26, borderRadius: '50%',
                        background: isOpen ? '#2A2A26' : isDone ? '#2F6B4F' : 'rgba(42,42,38,0.1)',
                        color: (isOpen || isDone) ? 'white' : '#9A9A92',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: IT, fontSize: '0.73rem', fontWeight: 600, flexShrink: 0,
                      }}>
                        {isDone && !isOpen ? '✓' : idx + 1}
                      </div>
                      <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>
                        {STEP_TITLE[stepId]}
                      </span>
                      {!isOpen && statusText && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>{statusText}</span>
                      )}
                      <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6' }}>{isOpen ? '▾' : '▸'}</span>
                    </button>

                    {/* ── Features step ── */}
                    {stepId === 'features' && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        {featItems.length === 0 ? (
                          <p className="pt-3" style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>
                            No features selected in preferences.
                          </p>
                        ) : (
                          <div className="flex flex-col gap-2 pt-3">
                            {featItems.map(item => {
                              const placed = placedZones.filter(z => z.key === item.key).length;
                              const hint   = item.key === 'water' ? waterHint : (FEAT_HINTS[item.key] ?? '');
                              return (
                                <div key={item.key} draggable onDragStart={handleToolDragStart(item)}
                                  className="flex items-start gap-3 rounded-2xl p-3 hover:opacity-90 transition-all"
                                  style={{ background: 'white', cursor: 'grab', userSelect: 'none', border: placed > 0 ? `1.5px solid ${item.color}55` : '1.5px solid transparent' }}>
                                  <div style={{
                                    width: 28, height: 28, flexShrink: 0, marginTop: 2,
                                    borderRadius: item.shape === 'circle' ? '50%' : 6,
                                    background: item.color,
                                  }} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                                      <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 600 }}>{item.label}</span>
                                      {placed > 0 && (
                                        <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#2F6B4F', fontWeight: 700 }}>
                                          ✓{placed > 1 ? ` ×${placed}` : ''}
                                        </span>
                                      )}
                                    </div>
                                    {hint && (
                                      <span style={{ fontFamily: IT, fontSize: '0.73rem', color: '#9A9A92', lineHeight: 1.5 }}>{hint}</span>
                                    )}
                                  </div>
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#C8C8C0', flexShrink: 0, paddingTop: 4 }}>⠿</span>
                                </div>
                              );
                            })}
                            <button onClick={() => advanceToNext('features')}
                              className="mt-1 rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Continue →
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Walkways step ── */}
                    {stepId === 'walkways' && isOpen && (() => {
                      return (
                        <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                          <div className="flex flex-col gap-3 pt-3">

                            {/* Style toggle */}
                            <div>
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>
                                Walkway style
                              </span>
                              <div className="flex gap-2">
                                {(['straight', 'winding'] as const).map(s => (
                                  <button key={s}
                                    onClick={() => {
                                      setGlobalPathStyle(s);
                                      const zones = zonesRef.current;
                                      const csNow = csRef.current;
                                      const dp    = doorPointRef.current;
                                      const bft   = boundaryFtRef.current;
                                      const getNodePt = (id: string): [number, number] | null => {
                                        if (id === 'door') return (dp && csNow) ? csNow.toXY(dp[0], dp[1]) : null;
                                        if (id === 'manual') return null;
                                        const z = zones.find(z => z.id === id);
                                        return z ? [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2] : null;
                                      };
                                      setPaths(prev => prev.map(p => {
                                        const startPt = getNodePt(p.startId), endPt = getNodePt(p.endId);
                                        if (!startPt || !endPt) return { ...p, style: s };
                                        const seed = p.id.split('').reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
                                        return { ...p, style: s, pts: truncateAtObstacles(clipPathToBoundary(generatePathPts(startPt, endPt, s, seed), bft), obstacleFtRef.current) };
                                      }));
                                    }}
                                    className="flex-1 rounded-xl py-2 transition-all hover:opacity-80"
                                    style={{
                                      fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                                      background: globalPathStyle === s ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                      color:      globalPathStyle === s ? '#efe9db' : '#2A2A26',
                                      border:     globalPathStyle === s ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                                    }}>
                                    {s.charAt(0).toUpperCase() + s.slice(1)}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Connect features */}
                            {(() => {
                              const connectNodes = [
                                ...(doorPoint && cs ? [{ id: 'door', label: 'Main door', color: '#F5C518', pt: cs.toXY(doorPoint[0], doorPoint[1]) as [number, number] }] : []),
                                ...placedZones.map(z => ({ id: z.id, label: z.label, color: z.color, pt: [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2] as [number, number] })),
                              ];
                              if (connectNodes.length < 2) return null;

                              const handleNodeClick = (node: { id: string; label: string; pt: [number, number] }) => {
                                if (!pathConnectStart) {
                                  setPathConnectStart(node);
                                  return;
                                }
                                if (pathConnectStart.id === node.id) {
                                  setPathConnectStart(null);
                                  return;
                                }
                                const seed = [...pathConnectStart.id, ...node.id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
                                const newPath: PlacedPath = {
                                  id:      `path_${pathConnectStart.id}_${node.id}`,
                                  label:   `${pathConnectStart.label} → ${node.label}`,
                                  startId: pathConnectStart.id,
                                  endId:   node.id,
                                  pts:     buildPath(pathConnectStart.pt, node.pt, globalPathStyle, seed),
                                  style:   globalPathStyle,
                                  widthFt: 3,
                                };
                                setPaths(prev => [...prev.filter(p => p.id !== newPath.id), newPath]);
                                setPathConnectStart(null);
                              };

                              return (
                                <div>
                                  <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'block', marginBottom: '0.5rem' }}>
                                    {pathConnectStart ? `Connect from ${pathConnectStart.label} to…` : "Are there any features you’d like to connect?"}
                                  </span>
                                  <div className="flex flex-wrap gap-1.5">
                                    {connectNodes.map(node => {
                                      const isStart = pathConnectStart?.id === node.id;
                                      return (
                                        <button key={node.id} onClick={() => handleNodeClick(node)}
                                          className="flex items-center gap-1.5 rounded-full transition-all hover:opacity-80"
                                          style={{
                                            padding: '5px 10px',
                                            background: isStart ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                            border: isStart ? 'none' : '1.5px solid rgba(42,42,38,0.12)',
                                            cursor: 'pointer',
                                          }}>
                                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: isStart ? 'white' : node.color, flexShrink: 0 }} />
                                          <span style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, color: isStart ? '#efe9db' : '#2A2A26' }}>
                                            {node.label}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                  {pathConnectStart && (
                                    <button onClick={() => setPathConnectStart(null)}
                                      style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: '0.35rem 0 0', display: 'block' }}>
                                      Cancel
                                    </button>
                                  )}
                                </div>
                              );
                            })()}

                            {/* Draw custom */}
                            {pathDrawMode === 'idle' ? (
                              <button onClick={() => setPathDrawMode('picking-start')}
                                className="rounded-xl py-2 hover:opacity-80 transition-all"
                                style={{ background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', cursor: 'pointer' }}>
                                + Draw custom walkway
                              </button>
                            ) : (
                              <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: 'rgba(196,173,140,0.18)', border: '1.5px solid rgba(196,173,140,0.5)' }}>
                                <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>
                                  {pathDrawMode === 'picking-start' ? 'Click the map — start point' : 'Click again — end point'}
                                </span>
                                <button onClick={() => { setPathDrawMode('idle'); pathDrawStart.current = null; }}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                              </div>
                            )}

                            {/* Walkway list */}
                            {paths.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Walkways</span>
                                {paths.map(p => {
                                  const isEditing = selectedPathId === p.id;
                                  const canRecalc = p.startId !== 'manual' && p.endId !== 'manual';
                                  if (isEditing) {
                                    return (
                                      <div key={p.id} className="flex flex-col gap-2 rounded-xl p-3"
                                        style={{ background: 'white', border: `1.5px solid ${PATH_COLOR}66` }}>
                                        <div className="flex items-center gap-2">
                                          <div style={{ width: 20, height: 3, borderRadius: 2, background: '#8C6B44', flexShrink: 0 }} />
                                          <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                                          <button onClick={() => setSelectedPathId(null)}
                                            style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>Done</button>
                                        </div>
                                        <div className="flex gap-1.5">
                                          {(['straight', 'winding'] as const).map(s => (
                                            <button key={s}
                                              onClick={() => {
                                                if (p.startId === 'manual') {
                                                  setPaths(prev => prev.map(x => x.id === p.id ? { ...x, style: s } : x));
                                                  return;
                                                }
                                                const zones = zonesRef.current;
                                                const csNow = csRef.current;
                                                const dp = doorPointRef.current;
                                                const getNodePt = (id: string): [number,number] | null => {
                                                  if (id === 'door') return (dp && csNow) ? csNow.toXY(dp[0], dp[1]) : null;
                                                  const z = zones.find(z => z.id === id);
                                                  return z ? [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2] : null;
                                                };
                                                const startPt = getNodePt(p.startId), endPt = getNodePt(p.endId);
                                                const seed = p.id.split('').reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
                                                setPaths(prev => prev.map(x => x.id === p.id
                                                  ? { ...x, style: s, pts: startPt && endPt ? truncateAtObstacles(clipPathToBoundary(generatePathPts(startPt, endPt, s, seed), boundaryFtRef.current), obstacleFtRef.current) : x.pts }
                                                  : x));
                                              }}
                                              className="flex-1 rounded-lg py-1.5 transition-all hover:opacity-80"
                                              style={{
                                                fontFamily: IT, fontSize: '0.73rem', fontWeight: 500, cursor: 'pointer',
                                                background: p.style === s ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                                color:      p.style === s ? '#efe9db' : '#2A2A26',
                                                border:     p.style === s ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                                              }}>
                                              {s.charAt(0).toUpperCase() + s.slice(1)}
                                            </button>
                                          ))}
                                        </div>
                                        {canRecalc && (
                                          <button onClick={() => {
                                            const zones = zonesRef.current;
                                            const csNow = csRef.current;
                                            const dp = doorPointRef.current;
                                            const getNodePt = (id: string): [number,number] | null => {
                                              if (id === 'door') return (dp && csNow) ? csNow.toXY(dp[0], dp[1]) : null;
                                              const z = zones.find(z => z.id === id);
                                              return z ? [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2] : null;
                                            };
                                            const startPt = getNodePt(p.startId), endPt = getNodePt(p.endId);
                                            if (!startPt || !endPt) return;
                                            const seed = (Date.now() % 99991);
                                            setPaths(prev => prev.map(x => x.id === p.id
                                              ? { ...x, pts: truncateAtObstacles(clipPathToBoundary(generatePathPts(startPt, endPt, p.style, seed), boundaryFtRef.current), obstacleFtRef.current) }
                                              : x));
                                          }}
                                          style={{ fontFamily: IT, fontSize: '0.73rem', color: '#2F6B4F', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', textAlign: 'left' as const }}>
                                            Recalculate route
                                          </button>
                                        )}
                                        <button onClick={() => { setPaths(prev => prev.filter(x => x.id !== p.id)); setSelectedPathId(null); }}
                                          style={{ fontFamily: IT, fontSize: '0.73rem', color: '#C05A3A', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', textAlign: 'left' as const }}>
                                          Remove walkway
                                        </button>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div key={p.id}
                                      onClick={() => setSelectedPathId(p.id)}
                                      className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
                                      style={{ background: 'rgba(42,42,38,0.06)', cursor: 'pointer' }}>
                                      <div style={{ width: 20, height: 3, borderRadius: 2, background: PATH_COLOR, flexShrink: 0 }} />
                                      <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                                      <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6' }}>{p.style}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            <button onClick={() => advanceToNext('walkways')}
                              className="mt-1 rounded-full py-2.5 hover:opacity-90 transition-all"
                              style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                              Continue →
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Materials step ── */}
                    {stepId === 'materials' && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <div className="flex flex-col gap-4 pt-3">

                          {/* Primary material */}
                          <div>
                            <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'block', marginBottom: '0.5rem' }}>
                              Primary planting bed material
                            </span>
                            <div className="flex gap-2">
                              {(['mulch', 'rock'] as const).map(m => (
                                <button key={m} onClick={() => setDefaultMaterial(m)}
                                  className="flex-1 flex items-center gap-2 rounded-xl py-2.5 px-3 transition-all hover:opacity-80"
                                  style={{
                                    fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer',
                                    background: defaultMaterial === m ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                    color:      defaultMaterial === m ? '#efe9db' : '#2A2A26',
                                    border:     defaultMaterial === m ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                                  }}>
                                  <div style={{ width: 12, height: 12, borderRadius: 3, background: MATERIAL_COLOR[m], flexShrink: 0, opacity: defaultMaterial === m ? 0.8 : 1 }} />
                                  {m.charAt(0).toUpperCase() + m.slice(1)}
                                  {m === 'mulch' && <span style={{ fontSize: '0.63rem', opacity: 0.6, marginLeft: 2 }}>default</span>}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Add beds */}
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                                Additional beds
                              </span>
                              {addingBed === null && (
                                <button
                                  onClick={() => setAddingBed({ step: 'type' })}
                                  style={{ fontFamily: IT, fontSize: '1.1rem', lineHeight: 1, color: '#2A2A26', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}>
                                  +
                                </button>
                              )}
                            </div>

                            {addingBed !== null && (
                              <div className="flex flex-col gap-2.5 rounded-xl p-3" style={{ background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                <div className="flex items-center justify-between">
                                  <span style={{ fontFamily: IT, fontSize: '0.75rem', fontWeight: 600, color: '#2A2A26' }}>
                                    {addingBed.step === 'type'     ? 'Type of bed'    :
                                     addingBed.step === 'material' ? 'Material'        :
                                                                     'Draw on the map'}
                                  </span>
                                  <button
                                    onClick={() => { setAddingBed(null); bedDrawVertsRef.current = []; bedDrawCursorRef.current = null; draw(); }}
                                    style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                    ✕
                                  </button>
                                </div>

                                {addingBed.step === 'type' && (
                                  <div className="flex gap-2">
                                    {([
                                      { type: 'planted'   as const, label: 'Planted bed'    },
                                      { type: 'unplanted' as const, label: 'Unplanted area' },
                                    ]).map(({ type, label }) => (
                                      <button key={type}
                                        onClick={() => setAddingBed({ step: 'material', type })}
                                        className="flex-1 rounded-xl py-2 transition-all hover:opacity-80"
                                        style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {addingBed.step === 'material' && (
                                  <div className="flex gap-2">
                                    {(['mulch', 'rock'] as const).map(m => (
                                      <button key={m}
                                        onClick={() => setAddingBed({ ...addingBed, step: 'draw', material: m })}
                                        className="flex-1 flex items-center gap-2 rounded-xl py-2 px-3 transition-all hover:opacity-80"
                                        style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                        <div style={{ width: 10, height: 10, borderRadius: 2, background: MATERIAL_COLOR[m], flexShrink: 0 }} />
                                        {m.charAt(0).toUpperCase() + m.slice(1)}
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {addingBed.step === 'draw' && (
                                  <div>
                                    <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#6A6A60', margin: '0 0 0.5rem', lineHeight: 1.55 }}>
                                      Click to place points. Double-click to close the shape.
                                    </p>
                                    <div className="flex items-center gap-2 mb-1">
                                      <div style={{ width: 10, height: 10, borderRadius: 2, background: MATERIAL_COLOR[addingBed.material ?? 'mulch'], flexShrink: 0 }} />
                                      <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>
                                        {(addingBed.material ?? 'mulch').charAt(0).toUpperCase() + (addingBed.material ?? 'mulch').slice(1)} · {addingBed.type === 'planted' ? 'planted' : 'unplanted'}
                                      </span>
                                    </div>
                                    {bedDrawVertsRef.current.length > 0 && (
                                      <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6' }}>
                                        {bedDrawVertsRef.current.length} point{bedDrawVertsRef.current.length !== 1 ? 's' : ''} placed
                                        {bedDrawVertsRef.current.length >= 3 ? ' — double-click to close' : ''}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Bed list */}
                          {placedBeds.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Placed beds</span>
                              {placedBeds.map(b => (
                                <div key={b.id}
                                  onClick={() => { selBedRef.current = b.id; setSelectedBedId(b.id); selRef.current = null; setSelectedId(null); }}
                                  className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
                                  style={{ background: selectedBedId === b.id ? 'white' : 'rgba(42,42,38,0.06)', cursor: 'pointer', border: selectedBedId === b.id ? `1.5px solid ${MATERIAL_COLOR[b.material]}55` : '1.5px solid transparent' }}>
                                  <div style={{ width: 12, height: 12, borderRadius: b.shape === 'circle' ? '50%' : 3, background: MATERIAL_COLOR[b.material], flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{b.label}</span>
                                  <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6' }}>{b.material}</span>
                                  <button onClick={(e) => { e.stopPropagation(); setPlacedBeds(prev => prev.filter(x => x.id !== b.id)); if (selectedBedId === b.id) { selBedRef.current = null; setSelectedBedId(null); } }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}

                          <button onClick={() => advanceToNext('materials')}
                            className="rounded-full py-2.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Continue →
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Lawn ── */}
                    {stepId === 'lawn' && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <div className="pt-3 flex flex-col gap-3">
                          <div className="rounded-xl p-3 flex gap-6" style={{ background: 'rgba(42,42,38,0.06)' }}>
                            <div className="flex flex-col gap-0.5">
                              <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Open lawn</span>
                              <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{lawnPct}%</span>
                              <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#9A9A92' }}>{lawnAreaFt.toLocaleString()} sq ft</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Features</span>
                              <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{100 - lawnPct}%</span>
                              <span style={{ fontFamily: IT, fontSize: '0.66rem', color: '#9A9A92' }}>{zoneAreaFt.toLocaleString()} sq ft</span>
                            </div>
                          </div>
                          {lawnAmount === 'lot' && lawnPct < 40 && (
                            <div style={{ borderRadius: 10, padding: '0.65rem 0.85rem', background: '#FEF3C7', border: '1px solid #F59E0B' }}>
                              <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#92400E', margin: 0, lineHeight: 1.5 }}>
                                Your features are using more space than expected — lawn is about {lawnPct}% of the yard. Remove or resize features on the map to make more room.
                              </p>
                            </div>
                          )}
                          {lawnAmount === 'some' && (
                            <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A92', margin: 0, lineHeight: 1.5 }}>
                              {lawnPct >= 20
                                ? 'That looks like a comfortable amount of open space.'
                                : "If you'd like more open space, remove or resize features on the map."}
                            </p>
                          )}
                          <button onClick={() => advanceToNext('lawn')}
                            className="rounded-full py-2.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Continue →
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Review ── */}
                    {stepId === 'review' && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <div className="pt-3 flex flex-col gap-3">
                          <div className="rounded-xl p-3 flex gap-6" style={{ background: 'rgba(42,42,38,0.06)' }}>
                            {[
                              { label: 'Lawn',     val: `${lawnPct}%`             },
                              { label: 'Features', val: `${100 - lawnPct}%`       },
                              { label: 'Zones',    val: `${placedZones.length}`   },
                            ].map(s => (
                              <div key={s.label} className="flex flex-col gap-0.5">
                                <span style={{ fontFamily: IT, fontSize: '0.63rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.label}</span>
                                <span style={{ fontFamily: IS, fontSize: '1.35rem', color: '#2A2A26', lineHeight: 1.1 }}>{s.val}</span>
                              </div>
                            ))}
                          </div>
                          {placedZones.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Placed zones</span>
                              {placedZones.map(z => (
                                <div key={z.id}
                                  onClick={() => { selRef.current = z.id; setSelectedId(z.id); }}
                                  className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
                                  style={{ background: selectedId === z.id ? 'white' : 'rgba(42,42,38,0.05)', cursor: 'pointer', border: selectedId === z.id ? `1.5px solid ${z.color}55` : '1.5px solid transparent' }}>
                                  <div style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.label}</span>
                                  <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>{Math.round(z.wFt * z.hFt)} sq ft</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {placedZones.length === 0 && (
                            <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>No zones placed yet. Go back to step 1 to add features.</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        {/* ── Right: canvas over satellite map ── */}
        <div className="flex-1 overflow-hidden" style={{ height: '81%' }}>
          <div className="w-full h-full rounded-2xl overflow-hidden relative"
            ref={containerRef}
            style={{ boxShadow: '0 12px 48px rgba(0,0,0,0.22)', background: '#1a1a1a' }}>

            {isLoaded && (
              <GoogleMap
                mapContainerStyle={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                center={mapCenter}
                zoom={20}
                options={{
                  mapTypeId: 'satellite',
                  disableDefaultUI: true,
                  gestureHandling: 'none',
                  clickableIcons: false,
                  draggable: false,
                  disableDoubleClickZoom: true,
                  scrollwheel: true,
                  zoomControl: false,
                }}
                onLoad={map => { mapRef.current = map; }}
              >
                {boundary.length >= 3 && (
                  <Polygon
                    paths={[...boundary, boundary[0]].map(v => ({ lat: v[1], lng: v[0] }))}
                    options={{ fillColor: '#2F6B4F', fillOpacity: 0.12, strokeColor: '#FFFFFF', strokeWeight: 2, strokeOpacity: 1, clickable: false }}
                  />
                )}
                {existing.filter(f => f.keep && f.vertices.length >= 3).map((feat, i) => {
                  const color = FEATURE_COLOR[feat.type] ?? '#9A9A92';
                  return (
                    <Polygon
                      key={`feat-${i}`}
                      paths={feat.vertices.map(v => ({ lat: v[1], lng: v[0] }))}
                      options={{ fillColor: color, fillOpacity: 0.45, strokeColor: color, strokeWeight: 2, strokeOpacity: 1, clickable: false }}
                    />
                  );
                })}
              </GoogleMap>
            )}

            <canvas
              ref={canvasRef}
              style={{ display: 'block', position: 'absolute', inset: 0, touchAction: 'none', background: 'transparent' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onClick={handleCanvasClick}
              onDoubleClick={handleCanvasDblClick}
              onDragOver={handleCanvasDragOver}
              onDrop={handleCanvasDrop}
              onDragLeave={handleCanvasDragLeave}
            />

            {/* Bed selection panel */}
            {!selectedZone && selectedBedId && (() => {
              const bed = placedBeds.find(b => b.id === selectedBedId);
              if (!bed) return null;
              const bedShapes: { key: 'rect' | 'circle' | 'organic'; label: string }[] = [
                { key: 'rect',    label: 'Rectangle' },
                { key: 'circle',  label: 'Circle'    },
                { key: 'organic', label: 'Organic'   },
              ];
              const updateBed = (patch: Partial<PlacedBed>) => {
                const updated = bedsRef.current.map(b => b.id === selectedBedId ? { ...b, ...patch } : b);
                bedsRef.current = updated;
                setPlacedBeds(updated);
              };
              return (
                <div className="absolute z-20 flex flex-col rounded-3xl p-5"
                  style={{ top: 12, right: 12, background: 'white', boxShadow: '0 4px 24px rgba(0,0,0,0.10)', width: 270, gap: 0 }}>
                  <div className="flex items-center gap-2 mb-3">
                    <div style={{ width: 16, height: 16, borderRadius: 4, background: MATERIAL_COLOR[bed.material], flexShrink: 0 }} />
                    <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#7A7A70', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700 }}>
                      {bed.type === 'planted' ? 'Planted bed' : 'Unplanted area'}
                    </span>
                  </div>
                  <h3 style={{ fontFamily: IS, fontSize: '1.55rem', color: '#2A2A26', margin: '0 0 12px', fontWeight: 400, lineHeight: 1 }}>
                    {bed.label}
                  </h3>
                  <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)', marginBottom: 16 }} />
                  {bed.shape !== 'poly' && (
                    <>
                      <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 10, display: 'block' }}>
                        Shape
                      </span>
                      <div className="flex gap-2 mb-4">
                        {bedShapes.map(s => {
                          const active = bed.shape === s.key;
                          return (
                            <button key={s.key} onClick={() => updateBed({ shape: s.key })}
                              className="flex-1 flex flex-col items-center justify-center gap-2 rounded-2xl py-3 hover:opacity-80 transition-all"
                              style={{
                                border:     active ? `2px solid ${MATERIAL_COLOR[bed.material]}` : '1.5px solid rgba(42,42,38,0.12)',
                                background: active ? MATERIAL_COLOR[bed.material] + '18' : 'transparent',
                                cursor:     'pointer',
                              }}>
                              <div style={{
                                width:        s.key === 'circle' ? 26 : 28,
                                height:       s.key === 'circle' ? 26 : 22,
                                borderRadius: s.key === 'circle' ? '50%' : s.key === 'organic' ? '62% 38% 55% 45% / 55% 48% 52% 45%' : 4,
                                background:   MATERIAL_COLOR[bed.material],
                              }} />
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#2A2A26', fontWeight: 500 }}>{s.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 10, display: 'block' }}>
                    Material
                  </span>
                  <div className="flex gap-2 mb-4">
                    {(['mulch', 'rock'] as const).map(m => (
                      <button key={m} onClick={() => updateBed({ material: m })}
                        className="flex-1 flex items-center gap-2 rounded-xl py-2 px-3 transition-all hover:opacity-80"
                        style={{
                          fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer',
                          background: bed.material === m ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                          color:      bed.material === m ? '#efe9db' : '#2A2A26',
                          border:     bed.material === m ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                        }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: bed.material === m ? 'white' : MATERIAL_COLOR[m], flexShrink: 0 }} />
                        {m.charAt(0).toUpperCase() + m.slice(1)}
                      </button>
                    ))}
                  </div>
                  {bed.shape === 'poly' && bed.verts ? (() => {
                    let area = 0;
                    for (let i = 0; i < bed.verts.length; i++) {
                      const j = (i + 1) % bed.verts.length;
                      area += bed.verts[i][0] * bed.verts[j][1] - bed.verts[j][0] * bed.verts[i][1];
                    }
                    return (
                      <div className="flex items-center justify-between mb-3">
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60' }}>Area</span>
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 700 }}>{Math.round(Math.abs(area / 2))} sq ft</span>
                      </div>
                    );
                  })() : (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60' }}>Dimensions</span>
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 700 }}>
                          {Math.round(bed.wFt)} × {Math.round(bed.hFt)} ft
                        </span>
                      </div>
                      <div className="flex items-center justify-between mb-3">
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60' }}>Area</span>
                        <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 700 }}>{Math.round(bed.wFt * bed.hFt)} sq ft</span>
                      </div>
                    </>
                  )}
                  <p style={{ fontFamily: IT, fontSize: '0.73rem', color: '#9A9A92', margin: '0 0 14px', lineHeight: 1.55 }}>
                    {bed.shape === 'poly' ? 'Drag to reposition.' : 'Drag to reposition. Drag the corner handle to resize.'}
                  </p>
                  <button
                    onClick={() => {
                      const updated = bedsRef.current.filter(b => b.id !== selectedBedId);
                      bedsRef.current   = updated;
                      selBedRef.current = null;
                      setPlacedBeds(updated);
                      setSelectedBedId(null);
                    }}
                    className="w-full py-2.5 rounded-xl hover:opacity-90 transition-all"
                    style={{ background: '#F8EDE8', color: '#C05A3A', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                    Remove from plan
                  </button>
                </div>
              );
            })()}

            {/* Zone selection panel */}
            {selectedZone && (() => {
              const shapes: { key: ZoneShape; label: string; icon: React.ReactNode }[] = [
                { key: 'rect',    label: 'Rectangle', icon: <div style={{ width: 28, height: 22, borderRadius: 4, background: selectedZone.color }} /> },
                { key: 'circle',  label: 'Circle',    icon: <div style={{ width: 26, height: 26, borderRadius: '50%', background: selectedZone.color }} /> },
                { key: 'organic', label: 'Organic',   icon: <div style={{ width: 28, height: 28, borderRadius: '62% 38% 55% 45% / 55% 48% 52% 45%', background: selectedZone.color }} /> },
              ];
              const setShape = (s: ZoneShape) => {
                const updated = zonesRef.current.map(z => z.id === selectedZone.id ? { ...z, shape: s } : z);
                zonesRef.current = updated;
                setPlacedZones(updated);
              };
              return (
                <div className="absolute z-20 flex flex-col rounded-3xl p-5"
                  style={{ top: 12, right: 12, background: 'white', boxShadow: '0 4px 24px rgba(0,0,0,0.10)', width: 270, gap: 0 }}>
                  <div className="flex items-center gap-2 mb-3">
                    <div style={{ width: 16, height: 16, borderRadius: 4, background: selectedZone.color, flexShrink: 0 }} />
                    <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#7A7A70', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700 }}>
                      {selectedZone.label}
                    </span>
                  </div>
                  <h3 style={{ fontFamily: IS, fontSize: '1.55rem', color: '#2A2A26', margin: '0 0 12px', fontWeight: 400, lineHeight: 1 }}>
                    {selectedZone.label}
                  </h3>
                  <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)', marginBottom: 16 }} />
                  <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 10, display: 'block' }}>
                    Shape
                  </span>
                  <div className="flex gap-2 mb-4">
                    {shapes.map(s => {
                      const active = selectedZone.shape === s.key;
                      return (
                        <button key={s.key} onClick={() => setShape(s.key)}
                          className="flex-1 flex flex-col items-center justify-center gap-2 rounded-2xl py-3 hover:opacity-80 transition-all"
                          style={{
                            border:     active ? `2px solid ${selectedZone.color}` : '1.5px solid rgba(42,42,38,0.12)',
                            background: active ? selectedZone.color + '12' : 'transparent',
                            cursor:     'pointer',
                          }}>
                          {s.icon}
                          <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#2A2A26', fontWeight: 500 }}>{s.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60' }}>Dimensions</span>
                    <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 700 }}>
                      {Math.round(selectedZone.wFt)} × {Math.round(selectedZone.hFt)} ft
                    </span>
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60' }}>Area</span>
                    <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 700 }}>{areaSqFt} sq ft</span>
                  </div>
                  <p style={{ fontFamily: IT, fontSize: '0.73rem', color: '#9A9A92', margin: '0 0 14px', lineHeight: 1.55 }}>
                    Drag inside to reposition. We'll set sun &amp; plants next.
                  </p>
                  <button
                    onClick={() => {
                      const updated = zonesRef.current.filter(z => z.id !== selectedId);
                      zonesRef.current = updated;
                      selRef.current   = null;
                      setPlacedZones(updated);
                      setSelectedId(null);
                    }}
                    className="w-full py-2.5 rounded-xl hover:opacity-90 transition-all"
                    style={{ background: '#F8EDE8', color: '#C05A3A', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                    Remove from plan
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Fixed nav — matches the preferences page placement */}
      <button onClick={() => navigate('/diy/boundary')}
        className="fixed bottom-8 left-10 transition-all hover:opacity-70"
        style={{ color: '#7A7A73', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>
      <button onClick={() => navigate('/diy/plan')}
        className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
        style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
        Continue to plants →
      </button>
    </div>
  );
}
