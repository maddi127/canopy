import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSaveAndExit } from '../hooks/useSaveAndExit';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import * as turf from '@turf/turf';
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
  shape:    'rect' | 'circle' | 'organic';
}

const OPTIONAL_TOOLS: Record<string, ToolbarItem> = {
  walkway: { key: 'walkway', label: 'Walkway',            color: '#C4AD8C', defaultW: 4,  defaultH: 14, shape: 'rect'   },
  seating: { key: 'seating', label: 'Seating',            color: '#B5A07A', defaultW: 12, defaultH: 12, shape: 'rect'   },
  dining:  { key: 'dining',  label: 'Dining area',        color: '#C4A84A', defaultW: 12, defaultH: 12, shape: 'rect'   },
  cooking: { key: 'cooking', label: 'Fire pit / cooking', color: '#B87060', defaultW: 8,  defaultH: 8,  shape: 'rect'   },
  water:   { key: 'water',   label: 'Water feature',      color: '#6B93A8', defaultW: 6,  defaultH: 6,  shape: 'circle' },
  garden:  { key: 'garden',  label: 'Raised beds',        color: '#7A8B4A', defaultW: 10, defaultH: 5,  shape: 'rect'   },
  storage: { key: 'storage', label: 'Utility zone',       color: '#9A8B78', defaultW: 10, defaultH: 10, shape: 'rect'   },
  trees:   { key: 'trees',   label: 'Shade trees',        color: '#5C8A5C', defaultW: 10, defaultH: 10, shape: 'circle' },
};

// Default shape per design style: clean rectangles for Modern/Traditional, soft
// organic blobs for Whimsical/Desert. Trees stay round (canopy).
const STYLE_SHAPE: Record<string, 'rect' | 'circle' | 'organic'> = {
  modern_structured: 'rect',
  traditional:       'rect',
  natural_wild:      'organic',
  desert_minimal:    'organic',
};
function shapeForStyle(key: string, style: string): 'rect' | 'circle' | 'organic' {
  if (key === 'trees') return 'circle';
  return STYLE_SHAPE[style] ?? OPTIONAL_TOOLS[key]?.shape ?? 'rect';
}
// Default footprints run large; front yards get the smallest, back yards a bit bigger.
function sizeMultForYard(yardType: string): number {
  return yardType === 'front' ? 0.6 : yardType === 'back' ? 0.85 : 0.75;
}

// ── Feature hints (placement guidance) ────────────────────────────────────────
const FEAT_HINTS: Record<string, string> = {
  seating: 'Place close to the house for easy access, or at the far end if your yard to create a destination.',
  dining:  'Place this close to the house door to streamline serving and clean up.',
  cooking: 'This works as its own destination at the far end, or tucked into a corner as an evening gathering spot.',
  water:   '', // set inline based on lawn amount
  garden:  "Put these where plants will get the most sun - usually the open edge furthest from the house and out of any shade.",
  storage: 'Tuck this into the least visible corner of your yard.',
  lawn:    'Aim for a large, uninterrupted space for better usability and easier maintenance.',
};

const FEAT_ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage', 'trees'];

// ── Accordion step types ───────────────────────────────────────────────────────
type StepId = 'features' | 'walkways' | 'materials' | 'lawn' | 'review';

const STEP_TITLE: Record<StepId, string> = {
  features:  'Place your features',
  walkways:  'Walkways',
  materials: 'Planting beds',
  lawn:      'Lawn',
  review:    'Review your plan',
};

type GroundMaterial = 'mulch' | 'rock' | 'lawn';
type BedType = 'planted' | 'unplanted';
type GroundVariant = 'natural' | 'brown' | 'black' | 'river' | 'pea' | 'lava';

interface PlacedBed {
  id:       string;
  label:    string;
  type:     BedType;
  material: GroundMaterial;
  variant?: GroundVariant;
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
  lawn:  '#8DAA6A',
};

// Each material offers a few visual variants; the color stands in for that
// material on the plan (e.g. light brown for brown mulch).
const GROUND_VARIANTS: Record<'mulch' | 'rock', { id: GroundVariant; label: string; color: string }[]> = {
  mulch: [
    { id: 'natural', label: 'Natural', color: '#C7B083' },
    { id: 'brown',   label: 'Brown',   color: '#A6743F' },
    { id: 'black',   label: 'Black',   color: '#4A443C' },
  ],
  rock: [
    { id: 'river', label: 'River rocks', color: '#A3A69D' },
    { id: 'pea',   label: 'Pea gravel',  color: '#C3BBA6' },
    { id: 'lava',  label: 'Lava rock',   color: '#8A574B' },
  ],
};
const VARIANT_COLOR: Record<GroundVariant, string> = {
  natural: '#C7B083', brown: '#A6743F', black: '#4A443C',
  river:   '#A3A69D', pea:   '#C3BBA6', lava:  '#8A574B',
};
const VARIANT_LABEL: Record<GroundVariant, string> = {
  natural: 'Natural', brown: 'Brown', black: 'Black',
  river:   'River rocks', pea: 'Pea gravel', lava: 'Lava rock',
};
const variantsFor = (m: GroundMaterial) => (m === 'mulch' || m === 'rock') ? GROUND_VARIANTS[m] : [];

// Hardscape materials for built features (seating, dining, fire pit, utility).
type FeatureMaterial = 'pavers' | 'concrete' | 'flagstone' | 'mulch' | 'gravel' | 'brick';
const FEATURE_MATERIALS: { id: FeatureMaterial; label: string; color: string; price: string }[] = [
  { id: 'mulch',     label: 'Mulch',     color: '#8B6B4A', price: '$'  },
  { id: 'gravel',    label: 'Gravel',    color: '#B4AC9B', price: '$'  },
  { id: 'flagstone', label: 'Flagstone', color: '#A7A096', price: '$'  },
  { id: 'pavers',    label: 'Pavers',    color: '#B7AC9A', price: '$'  },
  { id: 'concrete',  label: 'Concrete',  color: '#C2BEB5', price: '$$' },
  { id: 'brick',     label: 'Brick',     color: '#9E5E48', price: '$$' },
];
const FEATURE_MATERIAL_COLOR: Record<FeatureMaterial, string> = {
  pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48',
};
// Features whose surface is a built/hardscape material the user can choose.
const MATERIAL_FEATURES = new Set(['seating', 'dining', 'cooking', 'storage']);

// ── Path style ─────────────────────────────────────────────────────────────────
type PathStyle = 'straight' | 'winding';
type PathMaterial = 'mulch' | 'gravel' | 'flagstone' | 'pavers' | 'concrete' | 'brick';

const PATH_MATERIALS: { id: PathMaterial; label: string; price: string }[] = [
  { id: 'mulch',     label: 'Mulch',     price: '$'   },
  { id: 'gravel',    label: 'Gravel',    price: '$'   },
  { id: 'flagstone', label: 'Flagstone', price: '$$'  },
  { id: 'pavers',    label: 'Pavers',    price: '$$'  },
  { id: 'concrete',  label: 'Concrete',  price: '$$$' },
  { id: 'brick',     label: 'Brick',     price: '$$$' },
];
// Flagstone/pavers read as a stepping path (~2 ft); loose or poured walkways want 3 ft.
function pathWidthForMaterial(m: PathMaterial): number {
  return (m === 'flagstone' || m === 'pavers') ? 2 : 3;
}

interface PlacedPath {
  id:        string;
  label:     string;
  startId:   string; // zone id or 'door' or 'manual'
  endId:     string;
  pts:       [number, number][]; // [xFt, yFt]
  style:     PathStyle;
  material:  PathMaterial;
  widthFt:   number;
}

const PATH_COLOR = '#6E7681'; // slate — distinct from the warm feature palette

// ── Types ──────────────────────────────────────────────────────────────────────
type ZoneShape = 'rect' | 'circle' | 'organic';

interface PlacedZone {
  id:    string;
  key:   string;
  label: string;
  color: string;
  material?: FeatureMaterial;  // chosen hardscape surface (built features only)
  shape: ZoneShape;
  xFt:   number;
  yFt:   number;
  wFt:   number;
  hFt:   number;
  verts?: [number, number][];  // editable polygon (organic shapes); overrides bbox when present
}

interface CS {
  widthFt:  number;
  heightFt: number;
  toXY:     (lng: number, lat: number) => [number, number];
  toLngLat: (x: number, y: number) => [number, number];
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
    toLngLat: (x, y) => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
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

// ── Feet-space polygons (for geometric clipping so nothing overlaps) ─────────────
type Ring = [number, number][];

function organicRingFt(cx: number, cy: number, rx: number, ry: number, id: string): Ring {
  const rng = seededRng(hashId(id));
  const N = 9;
  const pts: Ring = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const j = 0.78 + rng() * 0.44;
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j];
  });
  const ring: Ring = [];
  const STEPS = 8;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      ring.push([
        u*u*u*p1[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p2[0],
        u*u*u*p1[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p2[1],
      ]);
    }
  }
  ring.push(ring[0]);
  return ring;
}

// Ring for a rect/circle/organic/poly shape, in feet.
function shapeRingFt(shape: string, xFt: number, yFt: number, wFt: number, hFt: number, id: string, verts?: [number, number][]): Ring {
  if (verts && verts.length >= 3) {
    const r: Ring = verts.map(v => [v[0], v[1]]);
    r.push([verts[0][0], verts[0][1]]);
    return r;
  }
  const cx = xFt + wFt / 2, cy = yFt + hFt / 2, rx = wFt / 2, ry = hFt / 2;
  if (shape === 'circle') {
    const N = 44, r: Ring = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    r.push(r[0]);
    return r;
  }
  if (shape === 'organic') return organicRingFt(cx, cy, rx, ry, id);
  return [[xFt, yFt], [xFt + wFt, yFt], [xFt + wFt, yFt + hFt], [xFt, yFt + hFt], [xFt, yFt]];
}

// Polygon (turf Feature) for a walkway: its centre-line buffered to its width, in feet.
function pathPolyFt(pts: [number, number][], widthFt: number): turf.Feature<turf.Polygon | turf.MultiPolygon> | null {
  if (pts.length < 2) return null;
  const hw = Math.max(widthFt / 2, 0.75);
  let acc: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    let dx = bx - ax, dy = by - ay; const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * hw, ny = dx / len * hw;
    const rect = turf.polygon([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]]);
    try { acc = acc ? (turf.union(acc, rect) as typeof acc) : rect; } catch { acc = acc ?? rect; }
  }
  return acc;
}

function ringBbox(ring: Ring): [number, number, number, number] {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
  return [minx, miny, maxx, maxy];
}
function bboxesOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function bboxGapFt(a: [number, number, number, number], b: [number, number, number, number]): number {
  const dx = Math.max(a[0] - b[2], b[0] - a[2], 0);
  const dy = Math.max(a[1] - b[3], b[1] - a[3], 0);
  return Math.hypot(dx, dy);
}
function segPointDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Closest point on a segment (with distance) — used for walkway vertex/edge editing.
function segClosestPx(px: number, py: number, ax: number, ay: number, bx: number, by: number): { dist: number; cx: number; cy: number } {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), cx, cy };
}
// Minimum distance between two polygon boundaries (feet).
function ringsMinDist(A: Ring, B: Ring): number {
  let min = Infinity;
  for (const [px, py] of A) for (let i = 0; i < B.length - 1; i++) min = Math.min(min, segPointDist(px, py, B[i][0], B[i][1], B[i + 1][0], B[i + 1][1]));
  for (const [px, py] of B) for (let i = 0; i < A.length - 1; i++) min = Math.min(min, segPointDist(px, py, A[i][0], A[i][1], A[i + 1][0], A[i + 1][1]));
  return min;
}
function ringsOverlap(A: Ring, B: Ring): boolean {
  for (const [x, y] of A) if (ptInPoly(x, y, B)) return true;
  for (const [x, y] of B) if (ptInPoly(x, y, A)) return true;
  return false;
}
// Planar area (ft²) of a turf Polygon/MultiPolygon, subtracting holes.
function featureAreaFt(feat: turf.Feature<turf.Polygon | turf.MultiPolygon>): number {
  const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
  let total = 0;
  for (const poly of polys) {
    poly.forEach((ring, idx) => {
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      total += (idx === 0 ? 1 : -1) * Math.abs(a / 2); // outer ring adds, holes subtract
    });
  }
  return total;
}
// Outer rings of a turf Polygon/MultiPolygon (feet), for distance checks.
function featureRings(feat: turf.Feature<turf.Polygon | turf.MultiPolygon>): Ring[] {
  const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
  return polys.map(poly => poly[0] as Ring);
}
// Ensure a ring is closed (first === last) and valid for turf.polygon.
function closeRingPts(pts: Ring): Ring | null {
  if (!pts || pts.length < 3) return null;
  const f = pts[0], l = pts[pts.length - 1];
  const closed: Ring = (f[0] === l[0] && f[1] === l[1]) ? pts.slice() : [...pts, [f[0], f[1]]];
  return closed.length >= 4 ? closed : null;
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function DiyPlacementPage() {
  const navigate = useNavigate();
  const saveAndExit = useSaveAndExit();

  // ── Data ────────────────────────────────────────────────────────────────────
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const prefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences')  || '{}'); } catch { return {}; } }, []);
  const siteContext = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  // Previously-saved plan, so returning from the review screen restores the layout.
  const savedPlan = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } }, []);
  const yardType: string    = siteContext.yard_type ?? prefs.yard_type ?? '';
  const designStyle: string = prefs.style ?? '';

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

  const boundaryAreaFt = useMemo(() => {
    if (boundaryFt.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < boundaryFt.length; i++) {
      const j = (i + 1) % boundaryFt.length;
      area += boundaryFt[i][0] * boundaryFt[j][1] - boundaryFt[j][0] * boundaryFt[i][1];
    }
    return Math.round(Math.abs(area / 2));
  }, [boundaryFt]);

  // Area (ft²) of existing features that take up usable ground — everything except trees
  // (you can still plant/lawn under a tree canopy). Subtracted from the project area when
  // sizing the default lawn.
  const existingNonTreeAreaFt = useMemo(() => {
    if (!cs) return 0;
    let total = 0;
    for (const f of existing) {
      if (!f.keep || f.type === 'tree' || f.vertices.length < 3) continue;
      const pts = f.vertices.map(v => cs.toXY(v[0], v[1]));
      let a = 0;
      for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
      total += Math.abs(a / 2);
    }
    return total;
  }, [existing, cs]);

  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const mapCenter = useMemo(() => {
    if (boundary.length === 0) return { lat: 39.74, lng: -104.99 };
    return {
      lat: boundary.reduce((s, v) => s + v[1], 0) / boundary.length,
      lng: boundary.reduce((s, v) => s + v[0], 0) / boundary.length,
    };
  }, [boundary]);

  // Feature items to show in the features step (in order, filtered to user's selections).
  // Lawn is included as a feature when the user wanted some/lot of it; its default size
  // is the project area × the lawn target, shaped to the yard's proportions.
  const featItems = useMemo(() => {
    const mult = sizeMultForYard(yardType);
    const items = FEAT_ORDER
      .filter(k => featKeys.includes(k))
      .map(k => OPTIONAL_TOOLS[k])
      .filter(Boolean)
      .map(base => ({
        ...base,
        shape:    shapeForStyle(base.key, designStyle),
        defaultW: Math.max(3, Math.round(base.defaultW * mult)),
        defaultH: Math.max(3, Math.round(base.defaultH * mult)),
      })) as ToolbarItem[];
    if (lawnAmount !== 'none' && boundaryAreaFt > 0 && cs) {
      const ar   = cs.widthFt / cs.heightFt;
      // Lawn target × usable project area (total minus non-tree existing features).
      const area = lawnTarget * Math.max(0, boundaryAreaFt - existingNonTreeAreaFt);
      items.push({
        key: 'lawn', label: 'Lawn', color: '#8DAA6A', shape: shapeForStyle('lawn', designStyle),
        defaultW: Math.max(6, Math.round(Math.sqrt(area * ar))),
        defaultH: Math.max(6, Math.round(Math.sqrt(area / ar))),
      });
    }
    return items;
  }, [featKeys, lawnAmount, lawnTarget, boundaryAreaFt, existingNonTreeAreaFt, cs, yardType, designStyle]);

  // ── Path state (declared early — used by draw + handlers below) ─────────────
  const doorPoint: [number, number] | null = useMemo(() => saved.doorPoint ?? null, [saved]);
  const defaultPathStyle: PathStyle = useMemo(() => {
    const s = prefs.style ?? '';
    return (s === 'natural_wild' || s === 'traditional') ? 'winding' : 'straight';
  }, [prefs]);
  const [paths,           setPaths]           = useState<PlacedPath[]>(() => Array.isArray(savedPlan.paths) ? savedPlan.paths : []);
  const [globalPathStyle, setGlobalPathStyle] = useState<PathStyle>(defaultPathStyle);
  const [globalPathMaterial, setGlobalPathMaterial] = useState<PathMaterial>('gravel');
  const [pathDrawMode,    setPathDrawMode]    = useState<'idle' | 'choosing-style' | 'choosing-material' | 'picking-start' | 'picking-end'>('idle');
  const pathDrawStart = useRef<[number, number] | null>(null);
  const [pathConnectStart, setPathConnectStart] = useState<{ id: string; label: string; pt: [number, number] } | null>(null);

  // ── Materials state ───────────────────────────────────────────────────────────
  const [defaultMaterial, setDefaultMaterial] = useState<GroundMaterial | null>(() => savedPlan.primary?.material ?? null);
  const [defaultVariant,  setDefaultVariant]  = useState<GroundVariant | null>(() => savedPlan.primary?.variant ?? null);
  const [placedBeds,      setPlacedBeds]      = useState<PlacedBed[]>(() => Array.isArray(savedPlan.beds) ? savedPlan.beds : []);
  const [addingBed,       setAddingBed]       = useState<{ step: 'type' | 'material' | 'variant' | 'draw'; type?: BedType; material?: GroundMaterial; variant?: GroundVariant } | null>(null);
  const [recTip,          setRecTip]          = useState(false); // "Recommended" hover tooltip

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

  const fitScale = useMemo(() => {
    if (!cs) return 5;
    return Math.min((cssSize.w - PAD * 2) / cs.widthFt, (cssSize.h - PAD * 2) / cs.heightFt);
  }, [cs, cssSize]);

  // Affine (px-per-foot + pixel origin) read straight from the live map projection, so the
  // canvas renders exactly onto the satellite's pixels — no drift between map & canvas.
  const overlayRef = useRef<google.maps.OverlayView | null>(null);
  const [mapAffine, setMapAffine] = useState<{ scale: number; ox: number; oy: number } | null>(null);
  const recomputeAffine = useCallback(() => {
    const ov = overlayRef.current, c = csRef.current;
    if (!ov || !c) return;
    const proj = ov.getProjection?.();
    if (!proj) return;
    const toPt = (xFt: number, yFt: number) => {
      const [lng, lat] = c.toLngLat(xFt, yFt);
      return proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
    };
    const a = toPt(0, 0), bx = toPt(c.widthFt, 0), by = toPt(0, c.heightFt);
    if (!a || !bx || !by) return;
    const sx = Math.hypot(bx.x - a.x, bx.y - a.y) / Math.max(c.widthFt, 1e-6);
    const sy = Math.hypot(by.x - a.x, by.y - a.y) / Math.max(c.heightFt, 1e-6);
    const scale = (sx + sy) / 2;
    setMapAffine(prev =>
      prev && Math.abs(prev.scale - scale) < 0.002 && Math.abs(prev.ox - a.x) < 0.5 && Math.abs(prev.oy - a.y) < 0.5
        ? prev : { scale, ox: a.x, oy: a.y });
  }, []);

  const scale = mapAffine ? mapAffine.scale : fitScale;

  // Frame the satellite so the yard fills the view (alignment then comes from the projection).
  const mapView = useMemo(() => {
    if (boundary.length < 3 || !cs) return { center: mapCenter, zoom: 20 };
    const lngs = boundary.map(v => v[0]), lats = boundary.map(v => v[1]);
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const zoom = Math.log2(156543.03392 * Math.cos(centerLat * Math.PI / 180) * fitScale * 3.28084);
    return { center: { lat: centerLat, lng: centerLng }, zoom: Math.min(Math.max(zoom, 1), 22.9) };
  }, [boundary, cs, fitScale, mapCenter]);

  const ftToPx = useCallback((xFt: number, yFt: number): [number, number] => {
    if (mapAffine) return [mapAffine.ox + xFt * mapAffine.scale, mapAffine.oy + yFt * mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * fitScale) / 2;
    const oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [ox + xFt * fitScale, oy + yFt * fitScale];
  }, [mapAffine, cs, fitScale, cssSize]);

  const pxToFt = useCallback((cx: number, cy: number): [number, number] => {
    if (mapAffine) return [(cx - mapAffine.ox) / mapAffine.scale, (cy - mapAffine.oy) / mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * fitScale) / 2;
    const oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [(cx - ox) / fitScale, (cy - oy) / fitScale];
  }, [mapAffine, cs, fitScale, cssSize]);

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
  const [placedZones,    setPlacedZones]    = useState<PlacedZone[]>(() => Array.isArray(savedPlan.zones) ? savedPlan.zones : []);
  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  // The feature row the user has highlighted in the list — its hint shows atop the map.
  const [activeToolKey,  setActiveToolKey]  = useState<string | null>(null);
  // Features the user has skipped (the "✕") — counts as decided, like a delete on /boundary.
  const [skippedKeys,    setSkippedKeys]    = useState<Set<string>>(new Set());
  const [showDeleted,    setShowDeleted]    = useState(false);
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
  const addingBedRef      = useRef<{ step: 'type' | 'material' | 'variant' | 'draw'; type?: BedType; material?: GroundMaterial; variant?: GroundVariant } | null>(null);
  const bedDrawVertsRef   = useRef<[number, number][]>([]);
  const bedDrawCursorRef  = useRef<[number, number] | null>(null);
  const isDblClickRef     = useRef(false);
  const boundaryFtRef  = useRef<[number, number][]>([]);
  const obstacleFtRef  = useRef<[number, number][][]>([]);
  const doorPointRef   = useRef<[number, number] | null>(null);
  const csRef          = useRef<CS | null>(null);
  const defaultVariantRef = useRef<GroundVariant | null>(null);
  useEffect(() => { defaultVariantRef.current = defaultVariant; }, [defaultVariant]);

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

    // ── Clipped, non-overlapping shapes ───────────────────────────────────────
    // Filled areas (lawn → beds → features, bottom→top) are each clipped by the ones
    // above them AND by every walkway, so nothing overlaps. Walkways draw on top.
    type Renderable = {
      poly: turf.Feature<turf.Polygon | turf.MultiPolygon>;
      bbox: [number, number, number, number];
      fill: string; stroke: string; lineWidth: number;
      label: string | null; labelMinPx: number;
      center: [number, number]; handle: boolean;
    };
    const renderables: Renderable[] = [];

    const pushZone = (z: PlacedZone) => {
      if (!z.verts && (z.wFt <= 0 || z.hFt <= 0)) return;
      try {
        const poly = turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts)]);
        const isSel = z.id === selId;
        const zc = z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color;
        const bb = turf.bbox(poly) as [number, number, number, number];
        renderables.push({
          poly, bbox: bb,
          fill: zc + (isSel ? 'F2' : 'E6'), stroke: isSel ? '#FFFFFF' : zc, lineWidth: isSel ? 2.5 : 1.5,
          label: z.label, labelMinPx: 40, center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], handle: isSel && !z.verts,
        });
      } catch { /* skip degenerate */ }
    };
    const pushBed = (b: PlacedBed) => {
      try {
        const poly = turf.polygon([shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)]);
        const isSel = b.id === selBedRef.current;
        const color = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material];
        const c = turf.centroid(poly).geometry.coordinates as [number, number];
        renderables.push({
          poly, bbox: turf.bbox(poly) as [number, number, number, number],
          fill: color + (isSel ? 'CC' : '88'), stroke: color, lineWidth: isSel ? 2 : 1,
          label: b.label, labelMinPx: 36, center: c, handle: isSel && b.shape !== 'poly',
        });
      } catch { /* skip */ }
    };

    for (const z of zones)           if (z.key === 'lawn') pushZone(z);
    for (const b of bedsRef.current) pushBed(b);
    for (const z of zones)           if (z.key !== 'lawn') pushZone(z);

    // Walkway footprints — clip obstacles for every filled area (walkways draw on top).
    const pathObstacles = curPaths
      .map(p => pathPolyFt(p.pts, p.widthFt))
      .filter((p): p is turf.Feature<turf.Polygon | turf.MultiPolygon> => !!p)
      .map(poly => ({ poly, bbox: turf.bbox(poly) as [number, number, number, number] }));

    const drawFeature = (feat: turf.Feature<turf.Polygon | turf.MultiPolygon>, fill: string, stroke: string, lineWidth: number) => {
      const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
      for (const poly of polys) {
        ctx.beginPath();
        for (const ring of poly) {
          ring.forEach(([x, y], k) => {
            const [px, py] = ftToPxRef.current(x, y);
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.closePath();
        }
        ctx.fillStyle = fill; ctx.fill('evenodd');
        ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();
      }
    };

    // The project boundary + existing features (house, detected walkways/hardscape)
    // clip every placed shape, so features stay inside the yard and wrap around them.
    const bdyFt = boundaryFtRef.current;
    let clipBdy: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
    const bdyClosed = closeRingPts(bdyFt);
    if (bdyClosed) { try { clipBdy = turf.polygon([bdyClosed]); } catch { clipBdy = null; } }
    const clipObs = obstacleFtRef.current
      .map(v => { const r = closeRingPts(v); if (!r) return null; try { const poly = turf.polygon([r]); return { poly, bbox: turf.bbox(poly) as [number, number, number, number] }; } catch { return null; } })
      .filter((o): o is { poly: turf.Feature<turf.Polygon | turf.MultiPolygon>; bbox: [number, number, number, number] } => !!o);

    // ── Primary planting-bed fill ─────────────────────────────────────────────
    // The chosen ground material covers all the leftover (non-feature) area:
    // boundary minus existing structures, every placed feature/lawn/bed, and walkways.
    if (defaultVariantRef.current && clipBdy) {
      let ground: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = clipBdy;
      for (const ob of clipObs)        { if (!ground) break; try { ground = turf.difference(ground, ob.poly) as typeof ground; } catch { /* keep */ } }
      for (const r of renderables)     { if (!ground) break; try { ground = turf.difference(ground, r.poly)  as typeof ground; } catch { /* keep */ } }
      for (const ob of pathObstacles)  { if (!ground) break; try { ground = turf.difference(ground, ob.poly) as typeof ground; } catch { /* keep */ } }
      if (ground) drawFeature(ground, VARIANT_COLOR[defaultVariantRef.current] + 'D9', VARIANT_COLOR[defaultVariantRef.current], 1);
    }

    for (let i = 0; i < renderables.length; i++) {
      const r = renderables[i];
      let geom: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = r.poly;
      if (clipBdy) { try { geom = turf.intersect(geom, clipBdy) as typeof geom; } catch { /* keep */ } }
      for (const ob of clipObs) {
        if (!geom) break;
        if (!bboxesOverlap(r.bbox, ob.bbox)) continue;
        try { geom = turf.difference(geom, ob.poly) as typeof geom; } catch { /* keep */ }
      }
      for (let j = i + 1; j < renderables.length && geom; j++) {
        if (!bboxesOverlap(r.bbox, renderables[j].bbox)) continue;
        try { geom = turf.difference(geom, renderables[j].poly) as typeof geom; } catch { /* keep */ }
      }
      for (const ob of pathObstacles) {
        if (!geom) break;
        if (!bboxesOverlap(r.bbox, ob.bbox)) continue;
        try { geom = turf.difference(geom, ob.poly) as typeof geom; } catch { /* keep */ }
      }
      if (!geom) continue;

      ctx.save();
      drawFeature(geom, r.fill, r.stroke, r.lineWidth);
      ctx.restore();

      const [cpx, cpy] = ftToPxRef.current(r.center[0], r.center[1]);
      const pw = (r.bbox[2] - r.bbox[0]) * scaleRef.current;
      const ph = (r.bbox[3] - r.bbox[1]) * scaleRef.current;
      if (r.label && pw > r.labelMinPx && ph > 18) {
        ctx.save();
        const fs = Math.max(8, Math.min(12, pw / 9));
        ctx.fillStyle = '#FFFFFF'; ctx.font = `600 ${fs}px ${IT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3;
        ctx.fillText(r.label.toUpperCase(), cpx, cpy);
        ctx.restore();
      }

      if (r.handle) {
        const [hx, hy] = ftToPxRef.current(r.bbox[2], r.bbox[3]);
        ctx.save();
        ctx.fillStyle = 'white'; ctx.strokeStyle = r.stroke; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.rect(hx - 7, hy - 7, 14, 14);
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }

    // Walkways draw on top of the filled areas, filling the gaps they carved out.
    // They're clipped to the project boundary (so they can't run past the yard) but
    // not to other features — a walkway crosses freely over what it meets.
    const bdyClip = boundaryFtRef.current;
    for (const path of curPaths) {
      if (path.pts.length < 2) continue;
      const pxPts    = path.pts.map(([xFt, yFt]) => ftToPxRef.current(xFt, yFt));
      const isSelPth = path.id === selectedPathIdRef.current;
      ctx.save();
      if (bdyClip.length >= 3) {
        ctx.beginPath();
        bdyClip.forEach(([x, y], i) => { const [px, py] = ftToPxRef.current(x, y); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.closePath();
        ctx.clip();
      }
      ctx.strokeStyle = isSelPth ? '#3F454D' : PATH_COLOR;
      ctx.lineWidth   = Math.max(2, path.widthFt * scaleRef.current); // true width, to-scale
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.globalAlpha = isSelPth ? 1 : 0.9;
      ctx.beginPath();
      ctx.moveTo(pxPts[0][0], pxPts[0][1]);
      if (path.style === 'straight' || pxPts.length <= 2) {
        for (let i = 1; i < pxPts.length; i++) ctx.lineTo(pxPts[i][0], pxPts[i][1]);
      } else {
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

    // Editable vertex handles for the selected organic zone.
    const selZone = zones.find(z => z.id === selId);
    if (selZone?.verts && selZone.verts.length >= 3) {
      ctx.save();
      for (const [vx, vy] of selZone.verts) {
        const [hx, hy] = ftToPxRef.current(vx, vy);
        ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'white'; ctx.fill();
        ctx.strokeStyle = selZone.color; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }

    // Editable vertex handles for the selected walkway.
    const selPathDraw = curPaths.find(p => p.id === selectedPathIdRef.current);
    if (selPathDraw && selPathDraw.pts.length >= 2) {
      ctx.save();
      for (const [vx, vy] of selPathDraw.pts) {
        const [hx, hy] = ftToPxRef.current(vx, vy);
        ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'white'; ctx.fill();
        ctx.strokeStyle = '#3F454D'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }

    // Walkway draw — show the first point as it's placed (project-area boundary style).
    if (pathDrawStart.current) {
      const [hx, hy] = ftToPxRef.current(pathDrawStart.current[0], pathDrawStart.current[1]);
      ctx.save();
      ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'white'; ctx.fill();
      ctx.strokeStyle = '#2F6B4F'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.restore();
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

  useEffect(() => { draw(); }, [draw, placedZones, selectedId, paths, selectedPathId, placedBeds, selectedBedId, boundaryFt, obstacleFt, mapAffine, defaultVariant]);

  // Persist the plan so the review screen (a separate route) can summarize and draw it.
  // We bake each shape's polygon ring (ft coords) so the review page can render a plan
  // view without re-implementing the shape/seed logic.
  useEffect(() => {
    try {
      const ring = (s: { shape: string; xFt: number; yFt: number; wFt: number; hFt: number; id: string; verts?: [number, number][] }) =>
        shapeRingFt(s.shape, s.xFt, s.yFt, s.wFt, s.hFt, s.id, s.verts);
      localStorage.setItem('diyPlacementPlan', JSON.stringify({
        zones: placedZones.map(z => ({ ...z, ring: ring(z) })),
        beds:  placedBeds.map(b => ({ ...b, ring: ring(b) })),
        paths,
        primary: { material: defaultMaterial, variant: defaultVariant },
        boundary:  boundaryFt,
        obstacles: obstacleFt,
        projectAreaFt: boundaryAreaFt,
        primaryGroundAreaFt,
        address: (siteContext && siteContext.address) || '',
      }));
    } catch { /* ignore quota / serialization issues */ }
  }, [placedZones, placedBeds, paths, defaultMaterial, defaultVariant, boundaryFt, obstacleFt, siteContext]);

  // ── Drag ref ─────────────────────────────────────────────────────────────────
  const dragRef = useRef<{
    kind:    'move' | 'resize' | 'vertex';
    zoneId:  string;
    startMx: number; startMy: number;
    origX:   number; origY:   number;
    origW:   number; origH:   number;
    vertIdx?:   number;
    origVerts?: [number, number][];
  } | null>(null);

  const pathDragRef = useRef<{ pathId: string; vertIdx: number } | null>(null);

  const bedDragRef = useRef<{
    kind:      'move' | 'resize';
    bedId:     string;
    startMx:   number; startMy: number;
    origX:     number; origY:   number;
    origW:     number; origH:   number;
    origVerts?: [number, number][];
  } | null>(null);

  // ── Hit test ─────────────────────────────────────────────────────────────────
  const hitTest = useCallback((mx: number, my: number): {
    zone: PlacedZone; part: 'move' | 'resize' | 'vertex' | 'edge'; vertIdx?: number; edgeIdx?: number; ptFt?: [number, number];
  } | null => {
    const zones = zonesRef.current;
    const sel   = selRef.current;
    const segClosest = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      return { dist: Math.hypot(px - cx, py - cy), cx, cy };
    };
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = zones[i];

      // Editable polygon zones (organic): vertices and edges are interactive when selected.
      if (z.verts && z.verts.length >= 3) {
        if (z.id === sel) {
          for (let v = 0; v < z.verts.length; v++) {
            const [vx, vy] = ftToPxRef.current(z.verts[v][0], z.verts[v][1]);
            if (Math.hypot(mx - vx, my - vy) <= 9) return { zone: z, part: 'vertex', vertIdx: v };
          }
          for (let e = 0; e < z.verts.length; e++) {
            const a = z.verts[e], b = z.verts[(e + 1) % z.verts.length];
            const [ax, ay] = ftToPxRef.current(a[0], a[1]);
            const [bx, by] = ftToPxRef.current(b[0], b[1]);
            const c = segClosest(mx, my, ax, ay, bx, by);
            if (c.dist <= 7) return { zone: z, part: 'edge', edgeIdx: e, ptFt: pxToFtRef.current(c.cx, c.cy) };
          }
        }
        const [fx, fy] = pxToFtRef.current(mx, my);
        if (ptInPoly(fx, fy, z.verts)) return { zone: z, part: 'move' };
        // Near the outline (so an unselected organic zone can be selected by its edge).
        for (let e = 0; e < z.verts.length; e++) {
          const a = z.verts[e], b = z.verts[(e + 1) % z.verts.length];
          const [ax, ay] = ftToPxRef.current(a[0], a[1]);
          const [bx, by] = ftToPxRef.current(b[0], b[1]);
          if (segClosest(mx, my, ax, ay, bx, by).dist <= 7) return { zone: z, part: 'move' };
        }
        continue;
      }

      const [px, py] = ftToPxRef.current(z.xFt, z.yFt);
      const pw = z.wFt * scaleRef.current, ph = z.hFt * scaleRef.current;
      if (z.id === sel) {
        if (mx >= px + pw - 13 && mx <= px + pw + 5 && my >= py + ph - 13 && my <= py + ph + 5)
          return { zone: z, part: 'resize' };
      }
      if (mx >= px && mx <= px + pw && my >= py && my <= py + ph)
        return { zone: z, part: 'move' };
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
      draw();
      return;
    }
    if (pathDrawMode === 'picking-end' && pathDrawStart.current) {
      const endFt = pxToFt(mx, my);
      const seed  = Date.now() % 9999;
      const id = `path_manual_${Date.now()}`;
      const newPath: PlacedPath = {
        id,
        label:    `Walkway ${pathsRef.current.length + 1}`,
        startId:  'manual',
        endId:    'manual',
        pts:      buildPath(pathDrawStart.current, endFt, globalPathStyle, seed),
        style:    globalPathStyle,
        material: globalPathMaterial,
        widthFt:  pathWidthForMaterial(globalPathMaterial),
      };
      setPaths(prev => [...prev, newPath]);
      setSelectedPathId(null);      // collapsed until the user clicks it
      pathDrawStart.current = null;
      setPathDrawMode('idle');
      return;
    }

    // Walkway editing: drag a vertex / insert one on the selected path's line.
    const selPath = pathsRef.current.find(p => p.id === selectedPathIdRef.current);
    if (selPath) {
      for (let v = 0; v < selPath.pts.length; v++) {
        const [vx, vy] = ftToPxRef.current(selPath.pts[v][0], selPath.pts[v][1]);
        if (Math.hypot(mx - vx, my - vy) <= 9) { pathDragRef.current = { pathId: selPath.id, vertIdx: v }; return; }
      }
      for (let e = 0; e < selPath.pts.length - 1; e++) {
        const a = selPath.pts[e], b = selPath.pts[e + 1];
        const [ax, ay] = ftToPxRef.current(a[0], a[1]);
        const [bx, by] = ftToPxRef.current(b[0], b[1]);
        const c = segClosestPx(mx, my, ax, ay, bx, by);
        if (c.dist <= 7) {
          const ptFt = pxToFtRef.current(c.cx, c.cy);
          pathsRef.current = pathsRef.current.map(p => { if (p.id !== selPath.id) return p; const pts = [...p.pts]; pts.splice(e + 1, 0, ptFt); return { ...p, pts }; });
          setPaths([...pathsRef.current]);
          pathDragRef.current = { pathId: selPath.id, vertIdx: e + 1 };
          draw();
          return;
        }
      }
    }
    // Select a walkway by clicking its line.
    for (let i = pathsRef.current.length - 1; i >= 0; i--) {
      const p = pathsRef.current[i];
      let near = false;
      const w = Math.max(7, p.widthFt * scaleRef.current / 2);
      for (let e = 0; e < p.pts.length - 1 && !near; e++) {
        const a = p.pts[e], b = p.pts[e + 1];
        const [ax, ay] = ftToPxRef.current(a[0], a[1]);
        const [bx, by] = ftToPxRef.current(b[0], b[1]);
        if (segClosestPx(mx, my, ax, ay, bx, by).dist <= w) near = true;
      }
      if (near) {
        setSelectedPathId(p.id);
        selRef.current = null; setSelectedId(null);
        selBedRef.current = null; setSelectedBedId(null);
        return;
      }
    }

    // Features are only selectable/editable on the features step.
    const hit = openStepRef.current === 'features' ? hitTest(mx, my) : null;
    if (!hit) {
      const bedHit = hitTestBed(mx, my);
      if (bedHit) {
        selBedRef.current = bedHit.bed.id; setSelectedBedId(bedHit.bed.id);
        selRef.current = null; setSelectedId(null);
        setSelectedPathId(null);
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
        setSelectedPathId(null);
      }
      return;
    }
    setSelectedPathId(null);
    selRef.current = hit.zone.id;
    setSelectedId(hit.zone.id);
    selBedRef.current = null; setSelectedBedId(null);

    // Click an organic edge → insert a new vertex there and start dragging it.
    if (hit.part === 'edge' && hit.ptFt && hit.edgeIdx != null) {
      const zid = hit.zone.id, insertAt = hit.edgeIdx + 1, pt = hit.ptFt;
      zonesRef.current = zonesRef.current.map(z => {
        if (z.id !== zid || !z.verts) return z;
        const verts = [...z.verts]; verts.splice(insertAt, 0, pt); return { ...z, verts };
      });
      setPlacedZones([...zonesRef.current]);
      dragRef.current = { kind: 'vertex', zoneId: zid, vertIdx: insertAt, startMx: mx, startMy: my, origX: 0, origY: 0, origW: 0, origH: 0 };
      draw();
      return;
    }
    if (hit.part === 'vertex') {
      dragRef.current = { kind: 'vertex', zoneId: hit.zone.id, vertIdx: hit.vertIdx, startMx: mx, startMy: my, origX: 0, origY: 0, origW: 0, origH: 0 };
      return;
    }
    dragRef.current = {
      kind: hit.part as 'move' | 'resize', zoneId: hit.zone.id,
      startMx: mx, startMy: my,
      origX: hit.zone.xFt, origY: hit.zone.yFt,
      origW: hit.zone.wFt, origH: hit.zone.hFt,
      origVerts: hit.zone.verts ? hit.zone.verts.map(v => [v[0], v[1]] as [number, number]) : undefined,
    };
  }, [hitTest, hitTestBed, pathDrawMode, pxToFt, buildPath, globalPathStyle, globalPathMaterial, draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my]  = getPos(e);

    // Live bed draw preview
    if (addingBedRef.current?.step === 'draw') {
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      bedDrawCursorRef.current = pxToFtRef.current(mx, my);
      draw();
      return;
    }

    // Dragging a walkway vertex.
    if (pathDragRef.current) {
      const { pathId, vertIdx } = pathDragRef.current;
      const ptFt = pxToFtRef.current(mx, my);
      pathsRef.current = pathsRef.current.map(p => p.id === pathId ? { ...p, pts: p.pts.map((pt, i) => i === vertIdx ? ptFt : pt) } : p);
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
            canvasRef.current.style.cursor =
              hit.part === 'resize' ? 'se-resize' : hit.part === 'vertex' ? 'grab' : hit.part === 'edge' ? 'crosshair' : 'move';
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
    if (drag.kind === 'vertex') {
      const ptFt = pxToFtRef.current(mx, my);
      zonesRef.current = zonesRef.current.map(z =>
        (z.id === drag.zoneId && z.verts) ? { ...z, verts: z.verts.map((v, i) => i === drag.vertIdx ? ptFt : v) } : z);
      draw();
      return;
    }
    const dxFt = (mx - drag.startMx) / scaleRef.current;
    const dyFt = (my - drag.startMy) / scaleRef.current;
    zonesRef.current = zonesRef.current.map(z => {
      if (z.id !== drag.zoneId) return z;
      if (drag.kind === 'move') {
        if (drag.origVerts) return { ...z, verts: drag.origVerts.map(v => [v[0] + dxFt, v[1] + dyFt] as [number, number]) };
        return { ...z, xFt: drag.origX + dxFt, yFt: drag.origY + dyFt };
      }
      return { ...z, wFt: Math.max(3, drag.origW + dxFt), hFt: Math.max(3, drag.origH + dyFt) };
    });
    draw();
  }, [hitTest, hitTestBed, draw]);

  const handleMouseUp = useCallback(() => {
    if (addingBedRef.current?.step === 'draw') return; // finalised via onDoubleClick
    if (pathDragRef.current) {
      setPaths([...pathsRef.current]);
      pathDragRef.current = null;
      return;
    }
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

  // Place a feature via the list "+" button (alternative to dragging) — drops it near
  // the centre of the yard, staggered so repeated placements stay visible.
  const placeFeature = useCallback((item: ToolbarItem) => {
    if (!cs) return;
    const offset = zonesRef.current.filter(z => z.key === item.key).length * 6;
    const x0 = cs.widthFt / 2 - item.defaultW / 2 + offset;
    const y0 = cs.heightFt / 2 - item.defaultH / 2 + offset;
    const id = `z_${Date.now()}`;
    const newZone: PlacedZone = {
      id, key: item.key, label: item.label,
      color: item.color, shape: item.shape,
      xFt: x0, yFt: y0, wFt: item.defaultW, hFt: item.defaultH,
    };
    const updated = [...zonesRef.current, newZone];
    zonesRef.current = updated;
    selRef.current   = newZone.id;
    setPlacedZones(updated);
    setSelectedId(newZone.id);
    setActiveToolKey(item.key);
    setSkippedKeys(prev => { if (!prev.has(item.key)) return prev; const n = new Set(prev); n.delete(item.key); return n; });
    selBedRef.current = null; setSelectedBedId(null);
    draw();
  }, [cs, draw]);

  // Remove a single placed instance (the "✕" on a placed feature row).
  const removeInstance = useCallback((zoneId: string) => {
    const updated = zonesRef.current.filter(z => z.id !== zoneId);
    zonesRef.current = updated;
    setPlacedZones(updated);
    if (selRef.current === zoneId) { selRef.current = null; setSelectedId(null); }
    draw();
  }, [draw]);

  // Update a placed feature (shape / material) from the sidebar editor under its row.
  const updateZone = useCallback((zoneId: string, patch: Partial<PlacedZone>) => {
    const updated = zonesRef.current.map(z => z.id === zoneId ? { ...z, ...patch } : z);
    zonesRef.current = updated;
    setPlacedZones(updated);
  }, []);

  // Update a placed bed (type / material / variant) from the sidebar editor under its row.
  const updateBed = useCallback((bedId: string, patch: Partial<PlacedBed>) => {
    const updated = bedsRef.current.map(b => b.id === bedId ? { ...b, ...patch } : b);
    bedsRef.current = updated;
    setPlacedBeds(updated);
  }, []);

  // Approximate footprint of a placed feature, in sq ft.
  const zoneAreaFt = useCallback((z: PlacedZone): number => {
    if (z.verts && z.verts.length >= 3) {
      let a = 0;
      for (let i = 0; i < z.verts.length; i++) { const j = (i + 1) % z.verts.length; a += z.verts[i][0] * z.verts[j][1] - z.verts[j][0] * z.verts[i][1]; }
      return Math.abs(a / 2);
    }
    if (z.shape === 'circle') return (Math.PI / 4) * z.wFt * z.hFt;
    return z.wFt * z.hFt;
  }, []);

  // Skip a feature the user doesn't want (the "✕" on an unplaced feature row) — marks it
  // decided so the step can auto-advance. Toggles back off.
  const toggleSkip = useCallback((key: string) => {
    setSkippedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

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

    const { type = 'planted', material = 'mulch', variant } = addingBedRef.current!;
    const bedNum = bedsRef.current.filter(b => b.material !== 'lawn').length + 1;
    const newBed: PlacedBed = {
      id:    `bed_${Date.now()}`,
      label: material === 'lawn' ? 'Lawn area' : `Bed ${bedNum}`,
      type, material, variant, shape: 'poly',
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

  // Keep the satellite locked to the canvas view, applied imperatively (the GoogleMap
  // zoom/center props aren't reliably re-applied after mount). This keeps the imagery,
  // existing features, and the canvas (where clipping happens) in one coordinate space.
  useEffect(() => {
    const map = mapRef.current;
    if (map && boundary.length >= 3) { map.setCenter(mapView.center); map.setZoom(mapView.zoom); }
  }, [mapView, boundary.length]);

  // Wheel over the canvas must NOT zoom the map (that would desync it from the canvas).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // ── Accordion state ──────────────────────────────────────────────────────────
  const [openStep,  setOpenStep]  = useState<StepId | null>('features');
  const [doneSteps, setDoneSteps] = useState<Set<StepId>>(new Set());

  // Changing steps (incl. clicking Done) deactivates everything, so no leftover
  // shape/size toolbar or handles linger on a later step.
  const openStepRef = useRef<StepId | null>('features');
  useEffect(() => {
    openStepRef.current = openStep;
    selRef.current = null;    setSelectedId(null);
    selBedRef.current = null; setSelectedBedId(null);
    setSelectedPathId(null);
  }, [openStep]);

  // Visible steps
  const visibleSteps = useMemo<StepId[]>(() => [
    'features',
    'walkways',
    'materials',
  ], []);

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
  // Lawn coverage = the lawn zones the user placed (not residual space).
  const lawnAreaFt = useMemo(() => {
    if (!cs) return 0;
    const lawns = placedZones.filter(z => z.key === 'lawn' && z.wFt > 0 && z.hFt > 0);
    if (!lawns.length) return 0;
    // Same obstacles the renderer clips the lawn against, so the area matches what's drawn.
    const obstacles: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    for (const z of placedZones) if (z.key !== 'lawn' && (z.verts || (z.wFt > 0 && z.hFt > 0))) { try { obstacles.push(turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts)])); } catch { /* skip */ } }
    for (const b of placedBeds) { try { obstacles.push(turf.polygon([shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)])); } catch { /* skip */ } }
    for (const p of paths) { const pp = pathPolyFt(p.pts, p.widthFt); if (pp) obstacles.push(pp); }
    for (const v of obstacleFt) { const r = closeRingPts(v); if (r) { try { obstacles.push(turf.polygon([r])); } catch { /* skip */ } } }
    let bdy: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
    const bc = closeRingPts(boundaryFt); if (bc) { try { bdy = turf.polygon([bc]); } catch { bdy = null; } }
    let total = 0;
    for (const z of lawns) {
      let geom: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts)]);
      if (bdy) { try { geom = turf.intersect(geom, bdy) as typeof geom; } catch { /* keep */ } }
      for (const ob of obstacles) { if (!geom) break; try { geom = turf.difference(geom, ob) as typeof geom; } catch { /* keep */ } }
      if (geom) total += featureAreaFt(geom);
    }
    return Math.round(total);
  }, [placedZones, placedBeds, paths, obstacleFt, boundaryFt, cs]);
  const lawnPct    = boundaryAreaFt > 0 ? Math.min(100, Math.round(lawnAreaFt / boundaryAreaFt * 100)) : 0;

  // The open ground covered by the primary material: boundary minus every feature, bed,
  // walkway and existing structure — clipped (not summed) so overlaps don't double-count.
  const primaryGroundAreaFt = useMemo(() => {
    if (!cs || boundaryFt.length < 3) return 0;
    const bc = closeRingPts(boundaryFt);
    if (!bc) return 0;
    let geom: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
    try { geom = turf.polygon([bc]); } catch { return 0; }
    const cut = (poly: turf.Feature<turf.Polygon | turf.MultiPolygon> | null) => { if (geom && poly) { try { geom = turf.difference(geom, poly) as typeof geom; } catch { /* keep */ } } };
    for (const v of obstacleFt) { const r = closeRingPts(v); if (r) { try { cut(turf.polygon([r])); } catch { /* skip */ } } }
    for (const z of placedZones) if (z.verts || (z.wFt > 0 && z.hFt > 0)) { try { cut(turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts)])); } catch { /* skip */ } }
    for (const b of placedBeds) { try { cut(turf.polygon([shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)])); } catch { /* skip */ } }
    for (const p of paths) { const pp = pathPolyFt(p.pts, p.widthFt); if (pp) cut(pp); }
    return geom ? Math.round(featureAreaFt(geom)) : 0;
  }, [placedZones, placedBeds, paths, obstacleFt, boundaryFt, cs]);

  // Every selected feature must be placed or skipped before leaving the features step.
  const allFeaturesDecided = featItems.length > 0 && featItems.every(item => placedZones.some(z => z.key === item.key) || skippedKeys.has(item.key));

  // Tight-gap warnings: two features less than ~2 ft apart but not touching — too small
  // to plant, yet not flush. The user should either close the gap or open it up.
  const GAP_MIN_FT = 2;
  const gapWarnings = useMemo(() => {
    type GapItem = { label: string; ring: Ring; bbox: [number, number, number, number] };
    const mk = (label: string, ring: Ring): GapItem => ({ label, ring, bbox: ringBbox(ring) });

    // The placed features we warn about being too tight.
    const zones: GapItem[] = placedZones
      .filter(z => z.verts || (z.wFt > 0 && z.hFt > 0))
      .map(z => mk(z.label, shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts)));

    // Everything a feature could sit too close to: walkways + non-tree existing features.
    const others: GapItem[] = [];
    for (const p of paths) { const poly = pathPolyFt(p.pts, p.widthFt); if (poly) for (const r of featureRings(poly)) others.push(mk('Walkway', r)); }
    if (cs) for (const f of existing) {
      if (!f.keep || f.type === 'tree' || f.vertices.length < 3) continue;
      const cr = closeRingPts(f.vertices.map(v => cs.toXY(v[0], v[1])));
      if (cr) others.push(mk(f.type === 'house' ? 'House' : 'Existing feature', cr));
    }

    const out: { a: string; b: string; gap: number }[] = [];
    const check = (A: GapItem, B: GapItem) => {
      if (bboxGapFt(A.bbox, B.bbox) >= GAP_MIN_FT) return;
      if (ringsOverlap(A.ring, B.ring)) return; // overlapping → clipped flush, no gap
      const gap = ringsMinDist(A.ring, B.ring);
      if (gap > 0.15 && gap < GAP_MIN_FT) out.push({ a: A.label, b: B.label, gap });
    };
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) check(zones[i], zones[j]);
    for (const z of zones) for (const o of others) check(z, o);
    return out;
  }, [placedZones, paths, existing, cs]);

  const waterHint = lawnAmount === 'none'
    ? "Since you're not planning much lawn, position this as a focal point — something you walk toward or see from the house."
    : lawnAmount === 'lot'
    ? 'A focal point at the far end works especially well with more lawn — gives the open space a visual anchor.'
    : "Place it where you'll see it most — near the house, along a path, or as a focal point at the far end you can enjoy from inside.";

  // Selection panel
  const selectedZone = placedZones.find(z => z.id === selectedId) ?? null;

  // Active feature (defaults to the first in the list) and its placement hint for the map banner.
  const activeKey  = activeToolKey ?? featItems[0]?.key ?? null;
  const activeHint = activeKey ? (activeKey === 'water' ? waterHint : (FEAT_HINTS[activeKey] ?? '')) : '';

  // Instruction shown at the top of the map (active feature hint on the features step) —
  // only once at least one feature has actually been placed.
  const topBanner =
    openStep === 'features' ? (placedZones.length > 0 ? activeHint : '')
    : '';

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
        <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Build your layout</h1>
      </div>

      <div className="flex flex-1 overflow-hidden pr-32 gap-5 items-start" style={{ paddingBottom: '1.25rem', paddingLeft: '8rem' }}>

        {/* ── Left sidebar ── */}
        <div className="flex flex-col flex-shrink-0" style={{ width: '33%', height: '81%', background: '#EFE9DA', overflow: 'hidden', borderRadius: '1rem', boxShadow: '0 12px 48px rgba(0,0,0,0.12)' }}>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

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
                  if (stepId === 'materials') { const parts = [defaultMaterial, placedBeds.length > 0 ? `${placedBeds.length} bed${placedBeds.length !== 1 ? 's' : ''}` : null].filter(Boolean); return parts.length ? `— ${parts.join(', ')}` : null; }
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
                          // Clicking anywhere in this step that isn't a feature row collapses the active feature.
                          <div className="flex flex-col gap-2 pt-3" onClick={() => { selRef.current = null; setSelectedId(null); }}>
                            {gapWarnings.length > 0 && (
                              <div style={{ borderRadius: 12, padding: '0.7rem 0.85rem', background: '#FEF3C7', border: '1px solid #F59E0B' }}>
                                <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#92400E', margin: '0 0 0.35rem', fontWeight: 600 }}>
                                  Tight gap{gapWarnings.length > 1 ? 's' : ''} under {GAP_MIN_FT} ft
                                </p>
                                <p style={{ fontFamily: IT, fontSize: '0.73rem', color: '#92400E', margin: '0 0 0.45rem', lineHeight: 1.5 }}>
                                  Too small to plant — either move these together so they touch, or leave at least {GAP_MIN_FT} ft between them.
                                </p>
                                <div className="flex flex-col gap-0.5">
                                  {gapWarnings.slice(0, 4).map((w, i) => (
                                    <span key={i} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#92400E' }}>• {w.a} ↔ {w.b} ({w.gap.toFixed(1)} ft)</span>
                                  ))}
                                  {gapWarnings.length > 4 && (
                                    <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#92400E', opacity: 0.8 }}>+{gapWarnings.length - 4} more</span>
                                  )}
                                </div>
                              </div>
                            )}
                            {featItems.flatMap(item => {
                              const instances = placedZones.filter(z => z.key === item.key);
                              if (skippedKeys.has(item.key)) return [];   // skipped → shown in Deleted features below
                              // One row per placed instance (numbered), or a single unplaced row.
                              const rows: { zone: PlacedZone | null; label: string }[] =
                                instances.length > 0
                                  ? instances.map((zone, i) => ({ zone, label: i === 0 ? item.label : `${item.label} ${i + 1}` }))
                                  : [{ zone: null, label: item.label }];
                              return rows.map(row => {
                                const isActive = row.zone ? selectedId === row.zone.id : activeKey === item.key;
                                const labelStyle: React.CSSProperties = { fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.09em', textTransform: 'uppercase', fontWeight: 700 };
                                return (
                                  <div key={row.zone ? row.zone.id : item.key} className="flex flex-col gap-2" onClick={e => e.stopPropagation()}>
                                    <div draggable
                                      onDragStart={e => { setActiveToolKey(item.key); handleToolDragStart(item)(e); }}
                                      onClick={() => { setActiveToolKey(item.key); if (row.zone) { const on = selectedId === row.zone.id; selRef.current = on ? null : row.zone.id; setSelectedId(on ? null : row.zone.id); selBedRef.current = null; setSelectedBedId(null); } }}
                                      className="flex items-center gap-3 rounded-2xl p-3 transition-all"
                                      style={{ background: 'white', cursor: 'grab', userSelect: 'none',
                                        outline: isActive ? `2px solid ${item.color}` : '1.5px solid transparent',
                                        boxShadow: isActive ? `0 0 0 3px ${item.color}26` : 'none' }}>
                                      <div style={{
                                        width: 28, height: 28, flexShrink: 0,
                                        borderRadius: item.shape === 'circle' ? '50%' : 6,
                                        background: item.color,
                                      }} />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <span style={{ fontFamily: IT, fontSize: '0.88rem', color: '#2A2A26', fontWeight: 600 }}>{row.label}</span>
                                      </div>
                                      <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => placeFeature(item)} title="Add new"
                                          className="flex items-center justify-center rounded-xl hover:opacity-80 transition-all"
                                          style={{ width: 40, height: 40, cursor: 'pointer', fontSize: '1.25rem', fontWeight: 700, lineHeight: 1,
                                            background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', color: '#2F6B4F' }}>
                                          +
                                        </button>
                                        <button onClick={() => { if (row.zone) removeInstance(row.zone.id); else toggleSkip(item.key); }}
                                          title="Delete"
                                          className="flex items-center justify-center rounded-xl hover:opacity-80 transition-all"
                                          style={{ width: 40, height: 40, fontSize: '0.9rem', cursor: 'pointer',
                                            background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)', color: '#9A9A92' }}>
                                          ✕
                                        </button>
                                      </div>
                                    </div>

                                    {/* Active feature editor — shape, material & size, mirroring the walkway flow */}
                                    {row.zone && isActive && (() => {
                                      const z = row.zone;
                                      return (
                                        <div className="flex flex-col gap-2.5 px-1 pb-1">
                                          <div className="flex flex-col gap-1.5">
                                            <span style={labelStyle}>Shape</span>
                                            <div className="flex gap-1.5">
                                              {([{ k: 'rect' as ZoneShape, r: 6 as number | string }, { k: 'circle' as ZoneShape, r: '50%' }, { k: 'organic' as ZoneShape, r: '62% 38% 55% 45% / 55% 48% 52% 45%' }]).map(s => {
                                                const on = z.shape === s.k;
                                                return (
                                                  <button key={s.k} onClick={() => updateZone(z.id, { shape: s.k, verts: undefined })}
                                                    className="flex-1 flex items-center justify-center rounded-xl py-2.5 hover:opacity-80 transition-all"
                                                    style={{ cursor: 'pointer', border: on ? `2px solid ${item.color}` : '1.5px solid rgba(42,42,38,0.12)', background: on ? item.color + '12' : 'white' }}>
                                                    <div style={{ width: 22, height: s.k === 'rect' ? 16 : 22, borderRadius: s.r, background: item.color }} />
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                          {MATERIAL_FEATURES.has(item.key) && (
                                            <div className="flex flex-col gap-1.5">
                                              <span style={labelStyle}>Material</span>
                                              <div className="flex flex-wrap gap-1.5">
                                                {FEATURE_MATERIALS.map(m => {
                                                  const on = z.material === m.id;
                                                  return (
                                                    <button key={m.id} onClick={() => updateZone(z.id, { material: on ? undefined : m.id })}
                                                      className="flex items-center gap-1 rounded-full px-2.5 py-1 transition-all hover:opacity-80"
                                                      style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                                                        background: on ? '#2A2A26' : 'rgba(42,42,38,0.06)', color: on ? '#efe9db' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                                      <div style={{ width: 10, height: 10, borderRadius: 2, background: m.color, flexShrink: 0, boxShadow: on ? '0 0 0 1.5px rgba(255,255,255,0.5)' : 'none' }} />
                                                      {m.label}<span style={{ fontSize: '0.66rem', opacity: 0.6, marginLeft: 3 }}>{m.price}</span>
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          )}
                                          <div className="flex items-center justify-between">
                                            <span style={labelStyle}>Size</span>
                                            <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26', fontWeight: 600 }}>
                                              {Math.round(z.wFt)} × {Math.round(z.hFt)} ft · {Math.round(zoneAreaFt(z)).toLocaleString()} sq ft
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })()}
                                  </div>
                                );
                              });
                            })}
                            {(() => {
                              const deleted = featItems.filter(it => skippedKeys.has(it.key));
                              if (deleted.length === 0) return null;
                              return (
                                <div className="flex flex-col gap-1.5 pt-1">
                                  <button onClick={() => setShowDeleted(s => !s)}
                                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', fontWeight: 500 }}>
                                    <span>{showDeleted ? '▾' : '▸'}</span>
                                    Deleted features ({deleted.length})
                                  </button>
                                  {showDeleted && deleted.map(item => (
                                    <div key={item.key} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'rgba(42,42,38,0.04)' }}>
                                      <div style={{ width: 18, height: 18, borderRadius: item.shape === 'circle' ? '50%' : 4, flexShrink: 0, opacity: 0.5, background: item.color }} />
                                      <span style={{ flex: 1, minWidth: 0, fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                                      <button onClick={() => toggleSkip(item.key)}
                                        style={{ flexShrink: 0, background: 'none', border: '1.5px solid rgba(42,42,38,0.2)', borderRadius: 100, padding: '3px 10px', cursor: 'pointer', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, color: '#2A2A26' }}>
                                        Restore
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}
                            <div className="flex items-center justify-between mt-1">
                              <button onClick={() => {
                                  zonesRef.current = [];
                                  setPlacedZones([]);
                                  setSkippedKeys(new Set());
                                  selRef.current = null; setSelectedId(null);
                                  setActiveToolKey(null);
                                  draw();
                                }}
                                style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                Reset
                              </button>
                              <button onClick={() => advanceToNext('features')} disabled={!allFeaturesDecided}
                                title={allFeaturesDecided ? '' : 'Place or skip each feature first'}
                                className="rounded-full px-5 py-1.5 transition-all"
                                style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none',
                                  cursor: allFeaturesDecided ? 'pointer' : 'default', opacity: allFeaturesDecided ? 1 : 0.4 }}>
                                Done →
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Walkways step ── */}
                    {stepId === 'walkways' && isOpen && (() => {
                      return (
                        <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                          {/* Clicking anywhere in this step that isn't a walkway row deselects the active walkway. */}
                          <div className="flex flex-col gap-3 pt-3" onClick={() => setSelectedPathId(null)}>

                            {/* Add a walkway → pick a style → click two points on the map */}
                            {pathDrawMode === 'idle' ? (
                              <button onClick={() => setPathDrawMode('choosing-style')}
                                className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                                style={{ width: '100%', background: 'rgba(42,42,38,0.04)', border: '1.5px dashed rgba(42,42,38,0.18)', cursor: 'pointer' }}>
                                <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500 }}>Add a walkway</span>
                                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}>+</span>
                              </button>
                            ) : (
                              <div className="flex flex-col gap-2 rounded-xl px-3 py-3" style={{ background: 'rgba(196,173,140,0.18)', border: '1.5px solid rgba(196,173,140,0.5)' }}>
                                <div className="flex items-start justify-between gap-2">
                                  {pathDrawMode === 'picking-start' || pathDrawMode === 'picking-end' ? (
                                    <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26' }}>Click two points on the map to connect them.</span>
                                  ) : (
                                    <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', paddingTop: 2 }}>
                                      {pathDrawMode === 'choosing-style' ? 'Walkway style' : 'Material'}
                                    </span>
                                  )}
                                  <button onClick={() => { setPathDrawMode('idle'); pathDrawStart.current = null; }}
                                    style={{ fontFamily: IT, fontSize: '0.75rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>✕</button>
                                </div>
                                {pathDrawMode === 'choosing-style' && (
                                  <div className="flex gap-2">
                                    {(['straight', 'winding'] as const).map(s => (
                                      <button key={s} onClick={() => { setGlobalPathStyle(s); setPathDrawMode('choosing-material'); }}
                                        className="flex-1 rounded-xl py-2 transition-all hover:opacity-80"
                                        style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                        {s.charAt(0).toUpperCase() + s.slice(1)}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {pathDrawMode === 'choosing-material' && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {PATH_MATERIALS.map(m => (
                                      <button key={m.id} onClick={() => { setGlobalPathMaterial(m.id); setPathDrawMode('picking-start'); }}
                                        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all hover:opacity-80"
                                        style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                        {m.label}
                                        <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{m.price}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Walkway list — click to select & edit; style selector shows under the selected one */}
                            {paths.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Walkways</span>
                                {paths.map(p => (
                                  <div key={p.id} className="flex flex-col gap-2" onClick={e => e.stopPropagation()}>
                                    <div onClick={() => setSelectedPathId(selectedPathId === p.id ? null : p.id)}
                                      className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
                                      style={{ background: selectedPathId === p.id ? 'white' : 'rgba(42,42,38,0.06)', cursor: 'pointer', border: selectedPathId === p.id ? `1.5px solid ${PATH_COLOR}66` : '1.5px solid transparent' }}>
                                      <div style={{ width: 20, height: 3, borderRadius: 2, background: PATH_COLOR, flexShrink: 0 }} />
                                      <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                                      {selectedPathId !== p.id && <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6', whiteSpace: 'nowrap' }}>{p.style}{p.material ? ` - ${p.material}` : ''}</span>}
                                      <button onClick={(e) => { e.stopPropagation(); setPaths(prev => prev.filter(x => x.id !== p.id)); if (selectedPathId === p.id) setSelectedPathId(null); }}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0, flexShrink: 0 }}>✕</button>
                                    </div>
                                    {selectedPathId === p.id && (
                                      <div className="flex flex-col gap-2.5 px-1">
                                        <div className="flex flex-col gap-1.5">
                                        <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.09em', textTransform: 'uppercase', fontWeight: 700 }}>Style</span>
                                        <div className="flex gap-2">
                                        {(['straight', 'winding'] as const).map(s => (
                                          <button key={s}
                                            onClick={() => {
                                              setGlobalPathStyle(s);
                                              setPaths(prev => prev.map(x => {
                                                if (x.id !== p.id || x.pts.length < 2) return x;
                                                const a = x.pts[0], b = x.pts[x.pts.length - 1];
                                                const seed = x.id.split('').reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
                                                return { ...x, style: s, pts: clipPathToBoundary(generatePathPts(a, b, s, seed), boundaryFtRef.current) };
                                              }));
                                            }}
                                            className="flex-1 rounded-xl py-1.5 transition-all hover:opacity-80"
                                            style={{
                                              fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer',
                                              background: p.style === s ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                              color:      p.style === s ? '#efe9db' : '#2A2A26',
                                              border:     p.style === s ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                                            }}>
                                            {s.charAt(0).toUpperCase() + s.slice(1)}
                                          </button>
                                        ))}
                                        </div>
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                        <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.09em', textTransform: 'uppercase', fontWeight: 700 }}>Material</span>
                                        <div className="flex flex-wrap gap-1.5">
                                          {PATH_MATERIALS.map(m => {
                                            const on = p.material === m.id;
                                            return (
                                              <button key={m.id}
                                                onClick={() => setPaths(prev => prev.map(x => x.id === p.id ? { ...x, material: m.id, widthFt: pathWidthForMaterial(m.id) } : x))}
                                                className="flex items-center gap-1 rounded-full px-2.5 py-1 transition-all hover:opacity-80"
                                                style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                                                  background: on ? '#2A2A26' : 'rgba(42,42,38,0.06)', color: on ? '#efe9db' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                                {m.label}<span style={{ fontSize: '0.66rem', opacity: 0.6, marginLeft: 3 }}>{m.price}</span>
                                              </button>
                                            );
                                          })}
                                        </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="flex items-center justify-end mt-1">
                              <button onClick={() => advanceToNext('walkways')}
                                className="rounded-full px-5 py-1.5 hover:opacity-90 transition-all"
                                style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                {paths.length > 0 ? 'Done →' : 'Skip →'}
                              </button>
                            </div>
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
                                <button key={m} onClick={() => { setDefaultMaterial(m); setDefaultVariant(null); }}
                                  className="flex-1 flex items-center gap-2 rounded-xl py-2.5 px-3 transition-all hover:opacity-80"
                                  style={{
                                    fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer',
                                    background: defaultMaterial === m ? '#2A2A26' : 'rgba(42,42,38,0.06)',
                                    color:      defaultMaterial === m ? '#efe9db' : '#2A2A26',
                                    border:     defaultMaterial === m ? 'none'    : '1.5px solid rgba(42,42,38,0.12)',
                                  }}>
                                  <div style={{ width: 12, height: 12, borderRadius: 3, background: MATERIAL_COLOR[m], flexShrink: 0, opacity: defaultMaterial === m ? 0.8 : 1 }} />
                                  {m.charAt(0).toUpperCase() + m.slice(1)}
                                  {m === 'mulch' && (
                                    <span
                                      onMouseEnter={() => setRecTip(true)} onMouseLeave={() => setRecTip(false)}
                                      style={{ position: 'relative', fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginLeft: 3, cursor: 'help' }}>
                                      <span style={{ opacity: 0.65 }}>Recommended</span>
                                      {recTip && (
                                        <span style={{ position: 'absolute', top: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)', width: 230, background: '#2A2A26', color: '#efe9db', fontSize: '0.72rem', fontWeight: 400, textTransform: 'none', letterSpacing: 0, lineHeight: 1.45, padding: '8px 10px', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.28)', zIndex: 50, textAlign: 'left', pointerEvents: 'none' }}>
                                          Mulch is better for soil health — it retains moisture, feeds the soil as it breaks down, costs less, and reflects less heat than rock (less urban heat-island effect).
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>

                            {/* Variant of the chosen material — fills the yard's open ground */}
                            {(defaultMaterial === 'mulch' || defaultMaterial === 'rock') && (
                              <div className="flex flex-col gap-1.5 mt-2.5">
                                <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.09em', textTransform: 'uppercase', fontWeight: 700 }}>
                                  {defaultMaterial === 'rock' ? 'Rock type' : 'Mulch color'}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                {variantsFor(defaultMaterial).map(v => {
                                  const active = defaultVariant === v.id;
                                  return (
                                    <button key={v.id} onClick={() => setDefaultVariant(v.id)}
                                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all hover:opacity-80"
                                      style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer',
                                        background: active ? '#2A2A26' : 'white', color: active ? '#efe9db' : '#2A2A26',
                                        border: active ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                      <div style={{ width: 11, height: 11, borderRadius: '50%', background: v.color, flexShrink: 0, boxShadow: active ? '0 0 0 1.5px rgba(255,255,255,0.5)' : 'none' }} />
                                      {v.label}
                                    </button>
                                  );
                                })}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Add secondary planting beds — staged like the walkway flow */}
                          {addingBed === null ? (
                            <button onClick={() => setAddingBed({ step: 'type' })}
                              className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                              style={{ width: '100%', background: 'rgba(42,42,38,0.04)', border: '1.5px dashed rgba(42,42,38,0.18)', cursor: 'pointer' }}>
                              <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500 }}>Add secondary planting beds</span>
                              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}>+</span>
                            </button>
                          ) : (
                            <div className="flex flex-col gap-2 rounded-xl px-3 py-3" style={{ background: 'rgba(42,42,38,0.06)', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                              <div className="flex items-start justify-between gap-2">
                                {addingBed.step === 'draw' ? (
                                  <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26' }}>Click to place points on the map. Double-click to close the shape.</span>
                                ) : (
                                  <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', paddingTop: 2 }}>
                                    {addingBed.step === 'type' ? 'Type' : addingBed.step === 'material' ? 'Material' : (addingBed.material === 'rock' ? 'Rock type' : 'Color')}
                                  </span>
                                )}
                                <button onClick={() => { setAddingBed(null); bedDrawVertsRef.current = []; bedDrawCursorRef.current = null; draw(); }}
                                  style={{ fontFamily: IT, fontSize: '0.75rem', color: '#B0B0A6', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>✕</button>
                              </div>
                              {addingBed.step === 'type' && (
                                <div className="flex gap-2">
                                  {([{ type: 'planted' as const, label: 'Planted bed' }, { type: 'unplanted' as const, label: 'Unplanted area' }]).map(({ type, label }) => (
                                    <button key={type} onClick={() => setAddingBed({ step: 'material', type })}
                                      className="flex-1 rounded-xl py-2 transition-all hover:opacity-80"
                                      style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {addingBed.step === 'material' && (
                                <div className="flex gap-2">
                                  {(['mulch', 'rock'] as const).map(m => (
                                    <button key={m} onClick={() => setAddingBed({ ...addingBed, step: 'variant', material: m })}
                                      className="flex-1 flex items-center gap-2 rounded-xl py-2 px-3 transition-all hover:opacity-80"
                                      style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                      <div style={{ width: 10, height: 10, borderRadius: 2, background: MATERIAL_COLOR[m], flexShrink: 0 }} />
                                      {m.charAt(0).toUpperCase() + m.slice(1)}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {addingBed.step === 'variant' && addingBed.material && (
                                <div className="flex flex-wrap gap-1.5">
                                  {variantsFor(addingBed.material).map(v => (
                                    <button key={v.id} onClick={() => setAddingBed({ ...addingBed, step: 'draw', variant: v.id })}
                                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all hover:opacity-80"
                                      style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: 'white', color: '#2A2A26', border: '1.5px solid rgba(42,42,38,0.12)' }}>
                                      <div style={{ width: 11, height: 11, borderRadius: '50%', background: v.color, flexShrink: 0 }} />
                                      {v.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Bed list (lawn areas live on the Lawn step) */}
                          {placedBeds.filter(b => b.material !== 'lawn').length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Secondary beds</span>
                              {placedBeds.filter(b => b.material !== 'lawn').map(b => {
                                const open = selectedBedId === b.id;
                                const bedLabelStyle: React.CSSProperties = { fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', letterSpacing: '0.09em', textTransform: 'uppercase', fontWeight: 700 };
                                return (
                                <div key={b.id} className="flex flex-col gap-2">
                                  <div onClick={() => { const on = open; selBedRef.current = on ? null : b.id; setSelectedBedId(on ? null : b.id); selRef.current = null; setSelectedId(null); }}
                                    className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
                                    style={{ background: open ? 'white' : 'rgba(42,42,38,0.06)', cursor: 'pointer', border: open ? `1.5px solid ${(b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material])}55` : '1.5px solid transparent' }}>
                                    <div style={{ width: 12, height: 12, borderRadius: b.shape === 'circle' ? '50%' : 3, background: b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material], flexShrink: 0 }} />
                                    <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{b.label}</span>
                                    {!open && <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6' }}>{b.type === 'planted' ? 'Planted' : 'Unplanted'}{b.variant ? ` · ${VARIANT_LABEL[b.variant]}` : ''}</span>}
                                    <button onClick={(e) => { e.stopPropagation(); setPlacedBeds(prev => prev.filter(x => x.id !== b.id)); if (open) { selBedRef.current = null; setSelectedBedId(null); } }}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                  </div>
                                  {open && (
                                    <div className="flex flex-col gap-2.5 px-1 pb-1">
                                      <div className="flex flex-col gap-1.5">
                                        <span style={bedLabelStyle}>Type</span>
                                        <div className="flex gap-2">
                                          {([{ t: 'planted' as const, l: 'Planted bed' }, { t: 'unplanted' as const, l: 'Unplanted area' }]).map(o => {
                                            const on = b.type === o.t;
                                            return (
                                              <button key={o.t} onClick={() => updateBed(b.id, { type: o.t })}
                                                className="flex-1 rounded-xl py-2 transition-all hover:opacity-80"
                                                style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer',
                                                  background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                                {o.l}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                      <div className="flex flex-col gap-1.5">
                                        <span style={bedLabelStyle}>Material</span>
                                        <div className="flex gap-2">
                                          {(['mulch', 'rock'] as const).map(m => {
                                            const on = b.material === m;
                                            return (
                                              <button key={m} onClick={() => updateBed(b.id, { material: m, variant: GROUND_VARIANTS[m][0].id })}
                                                className="flex-1 flex items-center gap-2 rounded-xl py-2 px-3 transition-all hover:opacity-80"
                                                style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer',
                                                  background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                                <div style={{ width: 10, height: 10, borderRadius: 2, background: MATERIAL_COLOR[m], flexShrink: 0 }} />
                                                {m.charAt(0).toUpperCase() + m.slice(1)}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                      <div className="flex flex-col gap-1.5">
                                        <span style={bedLabelStyle}>{b.material === 'rock' ? 'Rock type' : 'Color'}</span>
                                        <div className="flex flex-wrap gap-1.5">
                                          {variantsFor(b.material).map(v => {
                                            const on = b.variant === v.id;
                                            return (
                                              <button key={v.id} onClick={() => updateBed(b.id, { variant: v.id })}
                                                className="flex items-center gap-1 rounded-full px-2.5 py-1 transition-all hover:opacity-80"
                                                style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                                                  background: on ? '#2A2A26' : 'rgba(42,42,38,0.06)', color: on ? '#efe9db' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                                <div style={{ width: 10, height: 10, borderRadius: '50%', background: v.color, flexShrink: 0, boxShadow: on ? '0 0 0 1.5px rgba(255,255,255,0.5)' : 'none' }} />
                                                {v.label}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                );
                              })}
                            </div>
                          )}

                          <button onClick={() => { setDoneSteps(prev => new Set([...prev, 'materials'])); setOpenStep(null); }}
                            className="self-end mt-1 rounded-full px-5 py-1.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Done
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
                center={mapView.center}
                zoom={mapView.zoom}
                options={{
                  mapTypeId: 'satellite',
                  disableDefaultUI: true,
                  gestureHandling: 'none',
                  clickableIcons: false,
                  draggable: false,
                  disableDoubleClickZoom: true,
                  scrollwheel: false,
                  zoomControl: false,
                }}
                onLoad={map => {
                  mapRef.current = map;
                  const ov = new google.maps.OverlayView();
                  ov.onAdd = () => {};
                  ov.onRemove = () => {};
                  ov.draw = () => { recomputeAffine(); };
                  ov.setMap(map);
                  overlayRef.current = ov;
                }}
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

            {/* Instruction shown at the top of the map (active feature hint, or lawn guidance) */}
            {topBanner && (
              <div className="absolute px-5 py-2.5 rounded-2xl"
                style={{ top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', maxWidth: 'min(520px, calc(100% - 32px))', textAlign: 'center', lineHeight: 1.45 }}>
                {topBanner}
              </div>
            )}


          </div>
        </div>
      </div>

      {/* Fixed nav — matches the preferences page placement */}
      <button onClick={() => navigate('/diy/boundary')}
        className="fixed bottom-8 left-10 transition-all hover:opacity-70"
        style={{ color: '#7A7A73', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>
      <button onClick={() => navigate('/diy/review')}
        className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
        style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
        Review your plan →
      </button>
    </div>
  );
}
