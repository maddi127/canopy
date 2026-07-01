import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSaveAndExit } from '../hooks/useSaveAndExit';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import IllustrativeSite from '../components/IllustrativeSite';
import { sampleSun, type SunMap } from '../services/sunAnalysis';
import { designProgress, DESIGN_STEP_TITLE } from '../lib/designProgress';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';
import {
  selectTrees, selectLayer, mapStyle, STYLE_TOTAL_SPECIES,
  PLANT_PACKING_EFFICIENCY, LAYER_QTY_PER_SPECIES, canopyFootprintFt, placePlan, isUnderPlanting,
  TREE_CANOPY_COVERAGE_GOAL, SHADE_CANOPY_COVERAGE_GOAL,
  type Layer, type TreeSelection, type LayerSelection, type SpeciesCandidate,
} from '../services/plantSelectionService';
import { fetchHardinessZone } from '../features/sun/hardinessZone';

// ── Plant-step grouping + formatting (ported from /plant-options, matched to this layout) ──
// Species budget → per-layer counts, weighted toward the matrix (shrubs/groundcover).
const SPECIES_WEIGHT = [0.15, 0.20, 0.35, 0.30]; // tree, large_shrub, shrub, groundcover
const allocateSpecies = (total: number): number[] => {
  const base = [1, 1, 1, 1], rem = Math.max(0, total - 4);
  const raw = SPECIES_WEIGHT.map(w => w * rem), fl = raw.map(Math.floor);
  fl.forEach((v, i) => (base[i] += v));
  let left = rem - fl.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, f: v - fl[i] })).sort((a, b) => b.f - a.f);
  for (let k = 0; left > 0; k++, left--) base[order[k % 4].i]++;
  return base;
};
const LAYER_ORDER: Layer[] = ['tree', 'large_shrub', 'shrub', 'groundcover'];
const LAYER_INFO: Record<Layer, { label: string; sub: string }> = {
  tree:        { label: 'Trees',        sub: 'Canopy & shade' },
  large_shrub: { label: 'Large shrubs', sub: 'Structure & screening (6 ft +)' },
  shrub:       { label: 'Shrubs',       sub: 'Medium & small, filling in' },
  groundcover: { label: 'Groundcover',  sub: 'Low plants that knit it together' },
};
// The three groups shown in the toolbar.
const PLANT_GROUPS: { title: string; sub: string; layers: Layer[] }[] = [
  { title: 'Visual interest plants', sub: 'Trees and large shrubs — the structure everything builds around.', layers: ['tree', 'large_shrub'] },
  { title: 'Foundation plants',      sub: 'Medium and small shrubs that fill in between.', layers: ['shrub'] },
  { title: 'Groundcovers',           sub: 'Low, spreading plants that tie the beds together.', layers: ['groundcover'] },
];
const THUMB_KIND: Record<Layer, 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'> = {
  tree: 'trees', large_shrub: 'large_shrub', shrub: 'small_shrub', groundcover: 'groundcover',
};
function PlantThumb({ kind, seed, size = 130 }: { kind: 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'; seed: number; size?: number }) {
  const greens = ['#3d5c3a', '#4a7a50', '#5a7a50', '#6a9460'];
  const g = greens[seed % greens.length];
  return (
    <svg viewBox="0 0 200 130" style={{ width: '100%', height: '100%', display: 'block' }} preserveAspectRatio="xMidYMid slice">
      <rect width="200" height="130" fill="#e7eede" />
      {kind === 'trees' && (<><rect x="96" y="80" width="8" height="34" rx="2" fill="#8a6a4a" /><circle cx="100" cy="58" r="34" fill={g} /><circle cx="78" cy="68" r="20" fill={g} opacity="0.85" /><circle cx="122" cy="68" r="22" fill={g} opacity="0.9" /></>)}
      {kind === 'large_shrub' && (<><ellipse cx="80" cy="92" rx="34" ry="30" fill={g} /><ellipse cx="125" cy="88" rx="30" ry="34" fill={g} opacity="0.9" /></>)}
      {kind === 'small_shrub' && (<ellipse cx="100" cy="98" rx="40" ry="26" fill={g} />)}
      {kind === 'groundcover' && (<><ellipse cx="100" cy="108" rx="78" ry="16" fill={g} opacity="0.85" />{Array.from({ length: 7 }).map((_, i) => (<circle key={i} cx={28 + i * 24} cy={100 - (i % 2) * 6} r="7" fill={g} />))}</>)}
    </svg>
  );
}
// Species → marker colour on the plan (greens, matching the old plant page).
const PLANT_SPECIES_PALETTE = ['#3d5c3a', '#6a9460', '#4a7a50', '#8aa06a', '#5c8a5c', '#a7b56a', '#7a9a4a', '#386b4a', '#9caf5a', '#6b8e3a', '#5a7a50', '#b0a04a'];

// Sun categories used across the yard + which a species tolerates (from its raw sun_requirement).
type SunCat = 'full' | 'part' | 'shade';
const SUN_CATS: SunCat[] = ['full', 'part', 'shade'];
const SUN_CAT_LABEL: Record<SunCat, string> = { full: 'Full sun', part: 'Part sun', shade: 'Shade' };
function plantSunCats(raw: string | undefined): SunCat[] {
  switch ((raw || '').toLowerCase().trim()) {
    case 'full_sun':   return ['full'];
    case 'part_shade': return ['part'];
    case 'full_shade': return ['shade'];
    case 'adaptable':  return ['full', 'part', 'shade'];
    default:           return ['full', 'part'];
  }
}

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";
const HAND = "'Caveat', cursive"; // hand-lettered labels on the illustrated plan
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
  seating: 'Place close to the house for easy access, or at the far end of your yard to create a destination.',
  dining:  'Place this close to the house door to streamline serving and clean up.',
  cooking: 'This works as its own destination at the far end, or tucked into a corner as an evening gathering spot.',
  water:   '', // set inline based on lawn amount
  garden:  "Put these where plants will get the most sun - usually the open edge furthest from the house and out of any shade.",
  storage: 'Tuck this into the least visible corner of your yard.',
  lawn:    'Aim for a large, uninterrupted space for better usability and easier maintenance.',
};

const FEAT_ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage', 'trees'];

// Why a feature landed where it did, plus the alternative — shown in the guided stepper. `near`
// = the feature sits close to the house/entry (vs. out toward the far end of the yard).
function placementReason(key: string, _label: string, near: boolean): string {
  switch (key) {
    case 'seating': return near
      ? `Placed close to the house for easy access. Alternatively, it could sit at the far end of the yard to create a destination.`
      : `Placed toward the far end of the yard to create a destination. Alternatively, it could sit right off the house for easy access.`;
    case 'dining': return near
      ? `Placed near the house door to streamline serving and cleanup. Alternatively, it could anchor a corner as an evening gathering spot.`
      : `Placed out in the yard as its own gathering spot. Alternatively, it could sit near the door to streamline serving.`;
    case 'cooking': return near
      ? `Placed near the house for convenient cooking. Alternatively, it could become a destination at the far end of the yard.`
      : `Placed as a destination at the far end of the yard. Alternatively, it could tuck into a corner nearer the house.`;
    case 'water': return `Placed as a focal point beside the seating. Alternatively, it could anchor a quieter corner of the yard.`;
    case 'garden': return `Placed in an open, sunny spot away from the shade of the house and big trees.`;
    case 'storage': return `Tucked into the least visible corner. Alternatively, it could sit closer to the house for convenience.`;
    case 'lawn': return `Shaped as a large, central open space. Alternatively, it could shift toward the house or hug one side.`;
    default: return '';
  }
}

// Order features are walked through in the guided (auto-layout) stepper — lawn last.
const GUIDE_ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage', 'lawn'];

// ── Accordion step types ───────────────────────────────────────────────────────
type StepId = 'sun' | 'features' | 'walkways' | 'materials' | 'details' | 'plants' | 'privacy' | 'lawn' | 'review';

const STEP_TITLE: Record<StepId, string> = {
  sun:       'Your sun map',
  features:  'Place your features',
  walkways:  'Walkways',
  materials: 'Planting beds',
  details:   'Fill in the details',
  plants:    'Choose your plants',
  privacy:   'Privacy',
  lawn:      'Lawn',
  review:    'Review your plan',
};

// What the user wants screened: a boundary edge, or the area around a placed feature.
type PrivacyTarget = { kind: 'edge'; edgeIndex: number } | { kind: 'feature'; featureId: string };

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

const PATH_MATERIALS: { id: PathMaterial; label: string; price: string; color: string }[] = [
  { id: 'mulch',     label: 'Mulch',     price: '$',   color: '#8B6F47' },
  { id: 'gravel',    label: 'Gravel',    price: '$',   color: '#A9A395' },
  { id: 'flagstone', label: 'Flagstone', price: '$$',  color: '#8D8577' },
  { id: 'pavers',    label: 'Pavers',    price: '$$',  color: '#9A8E7C' },
  { id: 'concrete',  label: 'Concrete',  price: '$$$', color: '#B8B4AC' },
  { id: 'brick',     label: 'Brick',     price: '$$$', color: '#A5644E' },
];
// Dry creek beds are drawn like a walkway, but filled with river rock rather than paving.
const CREEK_MATERIALS: { id: string; label: string; color: string }[] = [
  { id: 'river-rock', label: 'River rock', color: '#9AA0A6' },
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
  material:  string;
  widthFt:   number;
  kind?:     'walkway' | 'creek'; // creek = dry river bed (river-rock band); default walkway
  color?:    string;              // render colour; walkways fall back to PATH_COLOR
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
  rot?:  number;               // rotation about the feature centre, radians
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

// ── Material textures ──────────────────────────────────────────────────────────
// Procedural fills so each feature reads as its real surface (grass blades, bark mulch, gravel
// pebbles, paver joints, water ripples…). Rendered once into a tiling 128px canvas and reused as a
// repeating pattern (cheap to fill, even while dragging). Texture key → opaque base color:
const TEX_BASE: Record<string, string> = {
  grass: '#8aa663', mulch: '#6f4f37', soil: '#5d4a36', gravel: '#b3aa98', rock: '#9b9a8c',
  water: '#6f97ab', pavers: '#b7ac9a', concrete: '#c4c0b7', flagstone: '#a8a197', brick: '#9e5e48',
};

function paintMaterialTile(c: CanvasRenderingContext2D, S: number, tex: string, seed: number) {
  const rr = seededRng(seed); const R = () => rr();
  c.fillStyle = TEX_BASE[tex] || '#c9c4b8'; c.fillRect(0, 0, S, S);
  const area = S * S;
  c.lineCap = 'round';
  // Pencil hatch — slope ±1 lines tile seamlessly on a square tile; jitter gives a graphite feel.
  const hatch = (slope: number, d: number, color: string, lw: number, jit: number) => {
    c.strokeStyle = color; c.lineWidth = lw;
    for (let b = -S; b <= 2 * S; b += d) {
      c.beginPath();
      c.moveTo(0, b + (R() * 2 - 1) * jit);
      c.lineTo(S, b + slope * S + (R() * 2 - 1) * jit);
      c.stroke();
    }
  };
  if (tex === 'grass') {
    hatch(1, 8, 'rgba(92,120,68,0.34)', 1.2, 1.3);
    hatch(-1, 15, 'rgba(78,104,56,0.2)', 1, 1.6);
    c.strokeStyle = 'rgba(70,96,50,0.4)'; c.lineWidth = 1;               // a few upright blades
    for (let i = 0; i < 55; i++) { const x = R() * S, y = R() * S; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (R() * 2 - 1) * 1.2, y - 2 - R() * 3); c.stroke(); }
  } else if (tex === 'mulch' || tex === 'soil') {
    const dark = tex === 'soil' ? 'rgba(66,50,34,0.44)' : 'rgba(74,52,34,0.44)';
    const lite = tex === 'soil' ? 'rgba(102,82,56,0.24)' : 'rgba(122,90,58,0.26)';
    hatch(1, 7, dark, 1.3, 1.5); hatch(-1, 13, lite, 1, 1.7);
  } else if (tex === 'gravel' || tex === 'rock') {
    const col = tex === 'rock' ? 'rgba(108,106,94,0.3)' : 'rgba(126,120,104,0.28)';
    hatch(1, 9, col, 1, 1.2); hatch(-1, 9, col, 1, 1.2);
    const n = tex === 'rock' ? 40 : 70;                                  // scattered pebbles
    c.fillStyle = 'rgba(90,86,76,0.28)';
    for (let i = 0; i < n; i++) { const x = R() * S, y = R() * S, r = (tex === 'rock' ? 1.4 : 0.7) + R() * (tex === 'rock' ? 2 : 1.2); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
  } else if (tex === 'water') {
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1.2; c.lineCap = 'round';
    for (let row = 0; row < 14; row++) {
      const y = (row + 0.5) * (S / 14);
      c.beginPath(); for (let x = 0; x <= S; x += 3) { const yy = y + Math.sin(x * 0.39 + row) * 1.5; if (!x) c.moveTo(x, yy); else c.lineTo(x, yy); } c.stroke();
    }
  } else if (tex === 'pavers' || tex === 'brick') {
    const cw = tex === 'brick' ? 32 : 32, ch = tex === 'brick' ? 16 : 32;
    c.strokeStyle = 'rgba(60,50,38,0.3)'; c.lineWidth = 1; let row = 0;
    for (let y = 0; y <= S; y += ch) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(S, y); c.stroke();
      const off = tex === 'brick' && row % 2 ? cw / 2 : 0;
      for (let x = off; x <= S; x += cw) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + ch); c.stroke(); }
      row++;
    }
  } else if (tex === 'flagstone') {
    c.strokeStyle = 'rgba(70,64,52,0.32)'; c.lineWidth = 1.2; c.lineCap = 'round';
    const n = Math.floor(area / 800);
    for (let i = 0; i < n; i++) {
      let px = R() * S, py = R() * S; const segs = 3 + Math.floor(R() * 3);
      c.beginPath(); c.moveTo(px, py);
      for (let s = 0; s < segs; s++) { const a = R() * Math.PI * 2, l = 8 + R() * 14; px += Math.cos(a) * l; py += Math.sin(a) * l; c.lineTo(px, py); } c.stroke();
    }
  } else if (tex === 'concrete') {
    hatch(1, 14, 'rgba(96,92,84,0.16)', 1, 1);
  }
}

const _tileCache: Record<string, HTMLCanvasElement> = {};
function materialTile(tex: string): HTMLCanvasElement | null {
  if (!TEX_BASE[tex]) return null;
  if (_tileCache[tex]) return _tileCache[tex];
  const S = 128; const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const c = cv.getContext('2d'); if (!c) return null;
  paintMaterialTile(c, S, tex, 0x9e37 ^ tex.length);
  _tileCache[tex] = cv; return cv;
}

// ── Zone detail symbols ──────────────────────────────────────────────────────
// Hand-drawn furniture / fixtures per zone (chairs, dining set, fire pit, garden rows, water
// ripples). Sized in feet (via px-per-foot `s`) so they scale as the zone grows/shrinks, and
// counts scale with area. Drawn clipped to the zone so nothing spills out.
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const DETAIL_INK = 'rgba(60,52,40,0.82)';
function drawChair(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, face: number) {
  const w = size * 0.9, h = size;
  ctx.save(); ctx.translate(x, y); ctx.rotate(face);
  roundRectPath(ctx, -w / 2, -h / 2, w, h, size * 0.22);
  ctx.fillStyle = '#a98b63'; ctx.fill(); ctx.strokeStyle = DETAIL_INK; ctx.lineWidth = 1.1; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.stroke(); // back bar (faces outward)
  ctx.restore();
}
function drawZoneDetail(ctx: CanvasRenderingContext2D, key: string, cx: number, cy: number, wPx: number, hPx: number, s: number, seed: number) {
  const rr = seededRng(seed);
  const areaFt = (wPx / s) * (hPx / s);
  const minDim = Math.min(wPx, hPx);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (key === 'seating') {
    const n = Math.max(2, Math.min(8, Math.round(areaFt / 28)));
    const arrR = minDim * 0.28, cw = Math.max(8, 2.3 * s);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr() * 0.25;
      const px = cx + Math.cos(a) * arrR, py = cy + Math.sin(a) * arrR;
      drawChair(ctx, px, py, cw, Math.atan2(cy - py, cx - px));
    }
  } else if (key === 'dining') {
    const tr = Math.max(6, minDim * 0.15);
    ctx.beginPath(); ctx.arc(cx, cy, tr, 0, Math.PI * 2); ctx.fillStyle = '#b79a70'; ctx.fill(); ctx.strokeStyle = DETAIL_INK; ctx.lineWidth = 1.4; ctx.stroke();
    const n = Math.max(4, Math.min(8, Math.round(areaFt / 26))), arrR = tr + Math.max(8, 2 * s) * 0.75, cw = Math.max(7, 1.9 * s);
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const px = cx + Math.cos(a) * arrR, py = cy + Math.sin(a) * arrR; drawChair(ctx, px, py, cw, Math.atan2(cy - py, cx - px)); }
  } else if (key === 'cooking') {
    const r0 = Math.max(7, minDim * 0.22);
    ctx.beginPath(); ctx.arc(cx, cy, r0, 0, Math.PI * 2); ctx.fillStyle = '#8a8078'; ctx.fill(); ctx.strokeStyle = DETAIL_INK; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r0 * 0.62, 0, Math.PI * 2); ctx.fillStyle = 'rgba(198,116,58,0.55)'; ctx.fill();
    ctx.strokeStyle = 'rgba(178,88,48,0.85)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0 * 0.28, cy + Math.sin(a) * r0 * 0.28); ctx.lineTo(cx + Math.cos(a) * r0 * 0.5, cy + Math.sin(a) * r0 * 0.5); ctx.stroke(); }
  } else if (key === 'garden') {
    ctx.strokeStyle = 'rgba(70,90,50,0.6)'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
    const gap = Math.max(6, 1.6 * s);
    for (let y = cy - hPx / 2 + gap; y < cy + hPx / 2 - 2; y += gap) { ctx.beginPath(); ctx.moveTo(cx - wPx / 2 + 5, y); ctx.lineTo(cx + wPx / 2 - 5, y); ctx.stroke(); }
    ctx.setLineDash([]);
  } else if (key === 'water') {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.3;
    for (let k = 1; k <= 3; k++) { ctx.beginPath(); ctx.arc(cx, cy, k * minDim * 0.13, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, s * 0.4), 0, Math.PI * 2); ctx.fill();
  } else if (key === 'storage') {
    const bw = Math.max(10, 4 * s), bh = Math.max(8, 3 * s);
    roundRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 2); ctx.fillStyle = '#a89a86'; ctx.fill(); ctx.strokeStyle = DETAIL_INK; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - bw / 2, cy); ctx.lineTo(cx + bw / 2, cy); ctx.stroke();
  }
}

// Hand-drawn "scribbled in" fill for a planting bed — a serpentine wavy line clipped to the shape,
// in the material's color, revealed up to `progress` (0→1) so it looks colored in by hand.
function drawScribbleFill(ctx: CanvasRenderingContext2D, rings: [number, number][][], color: string, progress: number, seed: number) {
  if (progress <= 0 || !rings.length) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!(maxX > minX) || !(maxY > minY)) return;
  ctx.save();
  ctx.beginPath(); for (const ring of rings) ring.forEach(([x, y], k) => { if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.clip('evenodd');
  const rr = seededRng(seed), gap = 5, pts: [number, number][] = [];
  let dir = 1;
  for (let y = minY + 2; y <= maxY - 2; y += gap) {
    const x0 = dir > 0 ? minX : maxX, x1 = dir > 0 ? maxX : minX;
    const steps = Math.max(3, Math.floor(Math.abs(maxX - minX) / 6));
    for (let sIdx = 0; sIdx <= steps; sIdx++) { const t = sIdx / steps; const x = x0 + (x1 - x0) * t; const yy = y + Math.sin(t * Math.PI * 3 + rr() * 0.4) * 1.6 + (rr() * 2 - 1) * 0.7; pts.push([x, yy]); }
    dir = -dir;
  }
  const nDraw = Math.max(2, Math.floor(pts.length * Math.min(1, progress)));
  ctx.strokeStyle = color; ctx.globalAlpha = 0.66; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); for (let i = 0; i < nDraw; i++) { const [x, y] = pts[i]; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
  ctx.restore();
}

// Append a wobbly (hand-drawn) closed sub-path through px points to the current canvas path.
// Seeded so the jitter is stable between redraws. Quadratic segments give a loose ink-pen feel.
function roughSubPath(ctx: CanvasRenderingContext2D, pts: [number, number][], jit: number, seed: number) {
  const rr = seededRng(seed); const j = () => (rr() * 2 - 1) * jit; const n = pts.length;
  if (n < 2) return;
  const sx = pts[0][0] + j(), sy = pts[0][1] + j();
  ctx.moveTo(sx, sy);
  for (let i = 1; i <= n; i++) {
    const a = pts[(i - 1) % n], b = pts[i % n];
    const mx = (a[0] + b[0]) / 2 + j() * 1.4, my = (a[1] + b[1]) / 2 + j() * 1.4;
    const ex = i === n ? sx : b[0] + j(), ey = i === n ? sy : b[1] + j();
    ctx.quadraticCurveTo(mx, my, ex, ey);
  }
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
  const N = 14;
  // Kidney-bean silhouette: an ellipse with a soft concave dent on one side → two lobes.
  const dentA = -Math.PI / 2;        // dent up top
  const pts: Ring = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const da = ((angle - dentA + Math.PI) % (Math.PI * 2)) - Math.PI; // signed distance from the dent
    const dip = 0.5 * Math.exp(-(da * da) / (0.55 * 0.55));           // push inward near the dent
    const j = (1 - dip) * (1 + (rng() * 2 - 1) * 0.06);              // gentle organic wobble
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
function shapeRingFt(shape: string, xFt: number, yFt: number, wFt: number, hFt: number, id: string, verts?: [number, number][], rot = 0): Ring {
  if (verts && verts.length >= 3) {
    const r: Ring = verts.map(v => [v[0], v[1]]);
    r.push([verts[0][0], verts[0][1]]);
    return r;
  }
  const cx = xFt + wFt / 2, cy = yFt + hFt / 2, rx = wFt / 2, ry = hFt / 2;
  let ring: Ring;
  if (shape === 'circle') {
    ring = [];
    const N = 44;
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; ring.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    ring.push(ring[0]);
  } else if (shape === 'organic') {
    ring = organicRingFt(cx, cy, rx, ry, id);
  } else {
    ring = [[xFt, yFt], [xFt + wFt, yFt], [xFt + wFt, yFt + hFt], [xFt, yFt + hFt], [xFt, yFt]];
  }
  if (rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    ring = ring.map(([x, y]) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c] as [number, number]; });
  }
  return ring;
}

// Rotate-gizmo geometry (px): the ring's outer edge point and the grab handle, along the feature's
// local "up" projected to screen (so it respects both the feature's own rotation and the plan's).
function rotateHandlePx(ftToPx: (x: number, y: number) => [number, number], scale: number, center: [number, number], rot: number, bbox: [number, number, number, number]): { edge: [number, number]; hpx: [number, number] } {
  const cPx = ftToPx(center[0], center[1]);
  const upEnd = ftToPx(center[0] + Math.sin(rot), center[1] - Math.cos(rot));
  let udx = upEnd[0] - cPx[0], udy = upEnd[1] - cPx[1]; const ul = Math.hypot(udx, udy) || 1; udx /= ul; udy /= ul;
  const half = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2 * scale;
  return { edge: [cPx[0] + udx * half, cPx[1] + udy * half], hpx: [cPx[0] + udx * (half + 24), cPx[1] + udy * (half + 24)] };
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
export default function DiyPlacementPage({ illustrative = false }: { illustrative?: boolean } = {}) {
  const navigate = useNavigate();
  const saveAndExit = useSaveAndExit();

  // ── Data ────────────────────────────────────────────────────────────────────
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const prefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences')  || '{}'); } catch { return {}; } }, []);
  const siteContext = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const sunMap = useMemo<SunMap | null>(() => { try { return JSON.parse(localStorage.getItem('diySunMap') || 'null'); } catch { return null; } }, []);
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

  // ── Privacy screening ─────────────────────────────────────────────────────────
  const wantsPrivacy = useMemo(() => Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('privacy'), [prefs]);
  const [privacyTargets, setPrivacyTargets] = useState<PrivacyTarget[]>(() => { try { return JSON.parse(localStorage.getItem('diyPrivacyTargets') || '[]'); } catch { return []; } });
  const [privacyPick, setPrivacyPick] = useState(false); // edge-marking mode
  const privacyTargetsRef = useRef<PrivacyTarget[]>(privacyTargets);
  const privacyPickRef = useRef(false);
  useEffect(() => { privacyTargetsRef.current = privacyTargets; try { localStorage.setItem('diyPrivacyTargets', JSON.stringify(privacyTargets)); } catch { /* ignore */ } }, [privacyTargets]);
  useEffect(() => { privacyPickRef.current = privacyPick; }, [privacyPick]);
  const togglePrivacyEdge = useCallback((i: number) => setPrivacyTargets(prev => prev.some(t => t.kind === 'edge' && t.edgeIndex === i) ? prev.filter(t => !(t.kind === 'edge' && t.edgeIndex === i)) : [...prev, { kind: 'edge', edgeIndex: i }]), []);
  const togglePrivacyFeature = useCallback((id: string) => setPrivacyTargets(prev => prev.some(t => t.kind === 'feature' && t.featureId === id) ? prev.filter(t => !(t.kind === 'feature' && t.featureId === id)) : [...prev, { kind: 'feature', featureId: id }]), []);

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

  // ── "Fill in the details" step: draw walkways / dry creek beds by clicking two points ──────────
  // A tool is picked (walkway|creek), the user sets style + material, then clicks two points on the
  // map (via the shared pathDrawMode) to lay it down. Refs feed the map click handler.
  const [detailKind, setDetailKind] = useState<'walkway' | 'creek' | null>(null);
  const [detailStyle, setDetailStyle] = useState<PathStyle>('winding');
  const [detailMaterial, setDetailMaterial] = useState<string>('flagstone');
  const detailKindRef = useRef<'walkway' | 'creek' | null>(null);
  const detailStyleRef = useRef<PathStyle>('winding');
  const detailMaterialRef = useRef<string>('flagstone');
  // Endpoints/seed of paths drawn in the current (un-"Done") session, so toggling Shape re-shapes them.
  const detailDrawn = useRef<{ id: string; start: [number, number]; end: [number, number]; seed: number }[]>([]);
  useEffect(() => { detailKindRef.current = detailKind; }, [detailKind]);
  useEffect(() => { detailStyleRef.current = detailStyle; }, [detailStyle]);
  useEffect(() => { detailMaterialRef.current = detailMaterial; }, [detailMaterial]);

  // Start a two-point draw for the given tool (defaulting its material to the first of its palette).
  const startDetailDraw = useCallback((kind: 'walkway' | 'creek') => {
    const mat = kind === 'creek' ? CREEK_MATERIALS[0].id : 'flagstone';
    setDetailKind(kind);
    setDetailMaterial(mat);
    detailDrawn.current = [];
    pathDrawStart.current = null;
    setPathDrawMode('picking-start');
  }, []);

  const cancelDetailDraw = useCallback(() => {
    setDetailKind(null);
    detailDrawn.current = [];
    pathDrawStart.current = null;
    setPathDrawMode('idle');
  }, []);

  // Toggle Shape and re-shape every path drawn in this active session (until "Done").
  const setDetailStyleLive = useCallback((s: PathStyle) => {
    setDetailStyle(s);
    if (!detailDrawn.current.length) return;
    setPaths(prev => prev.map(p => {
      const rec = detailDrawn.current.find(d => d.id === p.id);
      return rec ? { ...p, style: s, pts: buildPath(rec.start, rec.end, s, rec.seed) } : p;
    }));
  }, [buildPath]);

  // Editing a single drawn path (clicked to select on the details step): re-shape / re-material it.
  const reshapePathById = useCallback((id: string, s: PathStyle) => {
    setPaths(prev => prev.map(x => {
      if (x.id !== id || x.pts.length < 2) return x;
      const rec = detailDrawn.current.find(d => d.id === id); // exact endpoints if drawn this session
      const a = rec ? rec.start : x.pts[0], b = rec ? rec.end : x.pts[x.pts.length - 1];
      const seed = rec ? rec.seed : x.id.split('').reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
      return { ...x, style: s, pts: buildPath(a, b, s, seed) };
    }));
  }, [buildPath]);

  const setPathMaterialById = useCallback((id: string, mId: string) => {
    const wc = PATH_MATERIALS.find(m => m.id === mId)?.color;
    setPaths(prev => prev.map(x => x.id === id ? { ...x, material: mId, widthFt: pathWidthForMaterial(mId as PathMaterial), color: wc ?? x.color } : x));
  }, []);

  // ── Canvas / scale ──────────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const [cssSize, setCssSize] = useState({ w: 900, h: 600 });

  const fitScale = useMemo(() => {
    if (!cs) return 5;
    return Math.min((cssSize.w - PAD * 2) / cs.widthFt, (cssSize.h - PAD * 2) / cs.heightFt);
  }, [cs, cssSize]);

  // House footprint (feet): centroid + the angle of its longest edge — used to orient the plan so
  // the house sits square to the view (its wall parallel to the container), not skewed.
  const houseGeomFt = useMemo<{ centroid: [number, number]; edgeAngle: number } | null>(() => {
    if (!cs) return null;
    let best: [number, number][] | null = null, bestArea = 0;
    for (const f of existing) {
      if (!f.keep || f.type !== 'house' || f.vertices.length < 3) continue;
      const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
      let a = 0; for (let i = 0; i < ring.length; i++) { const j = (i + 1) % ring.length; a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]; }
      const area = Math.abs(a / 2);
      if (area > bestArea) { bestArea = area; best = ring; }
    }
    if (!best) return null;
    let cx = 0, cy = 0; for (const [x, y] of best) { cx += x; cy += y; } cx /= best.length; cy /= best.length;
    let edgeAngle = 0, longest = 0;
    for (let i = 0; i < best.length; i++) {
      const a = best[i], b = best[(i + 1) % best.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len > longest) { longest = len; edgeAngle = Math.atan2(dy, dx); }
    }
    return { centroid: [cx, cy], edgeAngle };
  }, [cs, existing]);

  // Illustrative transform: rotate the plan so the house wall is parallel to the view and the house
  // sits at the top (front yards) or bottom (back yards), then fit the project area to ~90% of the
  // view (the house pokes past & clips). Returns an affine matrix px = [a·x + c·y + e, b·x + d·y + f]
  // shared by the canvas & base render.
  const illoXf = useMemo(() => {
    if (!illustrative || boundaryFt.length < 3) return null;
    let cx = 0, cy = 0; for (const [x, y] of boundaryFt) { cx += x; cy += y; } cx /= boundaryFt.length; cy /= boundaryFt.length;
    let theta = 0;
    if (houseGeomFt) {
      // Align the house's longest wall to horizontal, then add a 90° multiple so the house lands on
      // the correct side (top for front yards, bottom for back) — keeping walls axis-parallel.
      const theta0 = -houseGeomFt.edgeAngle;
      const vx = houseGeomFt.centroid[0] - cx, vy = houseGeomFt.centroid[1] - cy;
      const c0 = Math.cos(theta0), s0 = Math.sin(theta0);
      const phi = Math.atan2(vx * s0 + vy * c0, vx * c0 - vy * s0);
      const target = /back/i.test(yardType) ? Math.PI / 2 : -Math.PI / 2; // back → bottom (+y), else top (−y)
      theta = theta0 + Math.round((target - phi) / (Math.PI / 2)) * (Math.PI / 2);
    }
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const rot = (x: number, y: number): [number, number] => { const qx = x - cx, qy = y - cy; return [qx * cosT - qy * sinT, qx * sinT + qy * cosT]; };
    // Boundary rotated bbox → sets the scale (the project area fills ~80% of the view).
    let rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
    for (const [x, y] of boundaryFt) { const [rx, ry] = rot(x, y); if (rx < rminX) rminX = rx; if (rx > rmaxX) rmaxX = rx; if (ry < rminY) rminY = ry; if (ry > rmaxY) rmaxY = ry; }
    const rw = (rmaxX - rminX) || 1, rh = (rmaxY - rminY) || 1, fill = 0.8;
    const s = Math.min(fill * cssSize.w / rw, fill * cssSize.h / rh);
    // Visual-mass rotated bbox (boundary + house + trees + hardscape) → used to balance the framing
    // so the plan doesn't float to one side. We blend 60% toward it; the house still clips off-view.
    let uminX = rminX, umaxX = rmaxX, uminY = rminY, umaxY = rmaxY;
    for (const f of existing) {
      if (!f.keep || f.vertices.length < 3) continue;
      for (const v of f.vertices) { const [rx, ry] = rot(...cs!.toXY(v[0], v[1])); if (rx < uminX) uminX = rx; if (rx > umaxX) umaxX = rx; if (ry < uminY) uminY = ry; if (ry > umaxY) umaxY = ry; }
    }
    const uw = (umaxX - uminX) || 1, uh = (umaxY - uminY) || 1, k = 0.6;
    const txB = (cssSize.w - s * rw) / 2 - s * rminX, tyB = (cssSize.h - s * rh) / 2 - s * rminY;
    const txU = (cssSize.w - s * uw) / 2 - s * uminX, tyU = (cssSize.h - s * uh) / 2 - s * uminY;
    const tx = txB + (txU - txB) * k, ty = tyB + (tyU - tyB) * k;
    return {
      a: s * cosT, c: -s * sinT, e: tx - s * cosT * cx + s * sinT * cy,
      b: s * sinT, d: s * cosT,  f: ty - s * sinT * cx - s * cosT * cy,
    };
  }, [illustrative, boundaryFt, houseGeomFt, yardType, cssSize, existing, cs]);

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

  const scale = illoXf ? Math.hypot(illoXf.a, illoXf.b) : mapAffine ? mapAffine.scale : fitScale;

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
    if (illoXf) return [illoXf.a * xFt + illoXf.c * yFt + illoXf.e, illoXf.b * xFt + illoXf.d * yFt + illoXf.f];
    if (mapAffine) return [mapAffine.ox + xFt * mapAffine.scale, mapAffine.oy + yFt * mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * fitScale) / 2;
    const oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [ox + xFt * fitScale, oy + yFt * fitScale];
  }, [illoXf, mapAffine, cs, fitScale, cssSize]);

  const pxToFt = useCallback((cx: number, cy: number): [number, number] => {
    if (illoXf) {
      const det = illoXf.a * illoXf.d - illoXf.b * illoXf.c;
      const u = cx - illoXf.e, w = cy - illoXf.f;
      return [(illoXf.d * u - illoXf.c * w) / det, (-illoXf.b * u + illoXf.a * w) / det];
    }
    if (mapAffine) return [(cx - mapAffine.ox) / mapAffine.scale, (cy - mapAffine.oy) / mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt  * fitScale) / 2;
    const oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [(cx - ox) / fitScale, (cy - oy) / fitScale];
  }, [illoXf, mapAffine, cs, fitScale, cssSize]);

  // Soft fade-in for the graph-paper grid lines (avoids a hard pop when the editor mounts).
  const [gridIn, setGridIn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGridIn(true)); return () => cancelAnimationFrame(id); }, []);

  // Sun layer: toggleable on the grid via the "Sun layer" button. Introduced by a one-time onboarding
  // popup (anchored to that button) the first time the user reaches feature placement.
  const [showSun, setShowSun] = useState(false);
  const showSunRef = useRef(false);
  useEffect(() => { showSunRef.current = showSun; }, [showSun]);
  const [sunOnboard, setSunOnboard] = useState(false);
  useEffect(() => {
    if (!illustrative || !sunMap) return;
    if (localStorage.getItem('diySunOnboardSeen') === '1') return;
    setSunOnboard(true);
    setShowSun(true); // reveal the heatmap while we explain it
  }, [illustrative, sunMap]);
  const dismissSunOnboard = useCallback(() => {
    setSunOnboard(false);
    setShowSun(false); // clean working view; the button re-enables the layer any time
    try { localStorage.setItem('diySunOnboardSeen', '1'); } catch { /* ignore */ }
  }, []);

  // Measure synchronously before the first paint so the plan renders at the real size immediately —
  // otherwise it draws at the 900×600 default, then the ResizeObserver snaps it (a visible pulse).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && el.clientWidth > 0) setCssSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setCssSize(prev => (prev.w === Math.floor(width) && prev.h === Math.floor(height)) ? prev : { w: Math.floor(width), h: Math.floor(height) });
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
  // Guided (auto-layout) stepper: which placed feature we're walking through.
  const [guideIdx,       setGuideIdx]       = useState(0);

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

  // Scribble-in progress (0→1) for planting beds when the materials step opens.
  const scribbleTRef = useRef(1);

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
      fill: string; stroke: string; lineWidth: number; tex: string | null; active: boolean; key: string | null; rot: number;
      label: string | null; labelMinPx: number;
      center: [number, number]; handle: boolean;
    };
    const renderables: Renderable[] = [];
    const ACCENT = '#2F6B4F'; // active-feature outline (visible on the light illustrative base)

    const pushZone = (z: PlacedZone) => {
      if (!z.verts && (z.wFt <= 0 || z.hFt <= 0)) return;
      try {
        const poly = turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)]);
        const isSel = z.id === selId;
        const zc = z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color;
        const tex = z.key === 'lawn' ? 'grass' : z.key === 'water' ? 'water' : z.key === 'garden' ? 'soil'
          : z.material ? z.material : MATERIAL_FEATURES.has(z.key) ? 'gravel' : null;
        const bb = turf.bbox(poly) as [number, number, number, number];
        renderables.push({
          poly, bbox: bb, tex, active: isSel, key: z.key, rot: z.rot ?? 0,
          fill: zc + (isSel ? 'F2' : 'E6'), stroke: isSel ? (illustrative ? ACCENT : '#FFFFFF') : zc, lineWidth: isSel ? 2.5 : 1.5,
          label: z.label, labelMinPx: 40, center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], handle: isSel && !z.verts,
        });
      } catch { /* skip degenerate */ }
    };
    const pushBed = (b: PlacedBed) => {
      try {
        const poly = turf.polygon([shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)]);
        const isSel = b.id === selBedRef.current;
        const color = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material];
        const tex = b.material === 'lawn' ? 'grass' : b.material === 'rock' ? 'rock' : 'mulch';
        const c = turf.centroid(poly).geometry.coordinates as [number, number];
        renderables.push({
          poly, bbox: turf.bbox(poly) as [number, number, number, number], tex, active: isSel, key: null, rot: 0,
          fill: color + (isSel ? 'CC' : '88'), stroke: isSel && illustrative ? ACCENT : color, lineWidth: isSel ? 2 : 1,
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

    const drawFeature = (feat: turf.Feature<turf.Polygon | turf.MultiPolygon>, fill: string, stroke: string, lineWidth: number, tex: string | null = null, active = false) => {
      const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
      for (const poly of polys) {
        if (illustrative) {
          // Hand-drawn: wobbly material-textured fill + sketchy double ink outline.
          const rings = poly.map(ring => ring.map(([x, y]) => ftToPxRef.current(x, y)) as [number, number][]);
          let sx = 0, sy = 0; for (const p of rings[0]) { sx += p[0]; sy += p[1]; }
          const seed = (Math.round(Math.abs(sx) + Math.abs(sy)) | 0) + 1;
          ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 1.1, seed + ri)); ctx.closePath();
          const tile = tex ? materialTile(tex) : null;
          const pat = tile ? ctx.createPattern(tile, 'repeat') : null;
          ctx.fillStyle = pat || fill; ctx.fill('evenodd');
          // Sketched pencil outline: warm graphite (accent when active), overlapping wobbly strokes.
          const ink = active ? stroke : '#40392e';
          ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          if (active) {
            ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 1.1, seed + ri));
            ctx.shadowColor = 'rgba(47,107,79,0.85)'; ctx.shadowBlur = 13; ctx.strokeStyle = ink; ctx.lineWidth = lineWidth + 1; ctx.stroke();
            ctx.shadowBlur = 0;
          }
          ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 1.2, seed + ri + 9)); ctx.globalAlpha = 0.85; ctx.strokeStyle = ink; ctx.lineWidth = lineWidth; ctx.stroke();
          ctx.beginPath(); rings.forEach((pts, ri) => roughSubPath(ctx, pts, 2.1, seed + ri + 37)); ctx.globalAlpha = 0.32; ctx.strokeStyle = ink; ctx.lineWidth = lineWidth * 0.9; ctx.stroke();
          ctx.restore();
          continue;
        }
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
      if (ground) {
        if (illustrative) {
          // Scribble the open ground in the chosen material's colour once one is picked.
          const gpolys = ground.geometry.type === 'Polygon' ? [ground.geometry.coordinates] : ground.geometry.coordinates;
          const grings: [number, number][][] = [];
          for (const poly of gpolys) for (const ring of poly) grings.push(ring.map(([x, y]) => ftToPxRef.current(x, y)) as [number, number][]);
          drawScribbleFill(ctx, grings, VARIANT_COLOR[defaultVariantRef.current], scribbleTRef.current, 7);
        } else {
          drawFeature(ground, VARIANT_COLOR[defaultVariantRef.current] + 'D9', VARIANT_COLOR[defaultVariantRef.current], 1);
        }
      }
    }

    // Sun layer: the sun→shade heatmap, clipped to the yard. Toggled via the grid "Sun layer" button
    // (and shown while the sun onboarding popup is open). Drawn UNDER the features/handles so the plan
    // stays fully visible and editable.
    if (illustrative && sunMap && showSunRef.current) {
      const m = sunMap;
      ctx.save();
      const bf = boundaryFtRef.current;
      if (bf.length >= 3) { ctx.beginPath(); bf.forEach(([x, y], k) => { const [px, py] = ftToPxRef.current(x, y); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.clip(); }
      for (let rr = 0; rr < m.rows; rr++) for (let cc = 0; cc < m.cols; cc++) {
        const v = m.score[rr * m.cols + cc]; if (v < 0) continue;
        const x0 = m.minX + (cc - 0.5) * m.step, y0 = m.minY + (rr - 0.5) * m.step, x1 = x0 + m.step, y1 = y0 + m.step;
        const a = ftToPxRef.current(x0, y0), b = ftToPxRef.current(x1, y0), d = ftToPxRef.current(x1, y1), e = ftToPxRef.current(x0, y1);
        const rC = Math.round(91 + (244 - 91) * v), gC = Math.round(127 + (197 - 127) * v), bC = Math.round(166 + (66 - 166) * v);
        ctx.fillStyle = `rgba(${rC},${gC},${bC},0.5)`;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d[0], d[1]); ctx.lineTo(e[0], e[1]); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
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

      // Planting beds (key === null) in illustrative mode get a hand "scribbled-in" material fill
      // instead of the tiled texture — flat tint + outline first, then the scribble on top.
      const bedScribble = illustrative && r.key === null;
      ctx.save();
      drawFeature(geom, r.fill, r.stroke, r.lineWidth, bedScribble ? null : r.tex, r.active);
      ctx.restore();
      if (bedScribble) {
        const spolys = geom.geometry.type === 'Polygon' ? [geom.geometry.coordinates] : geom.geometry.coordinates;
        const srings: [number, number][][] = [];
        for (const poly of spolys) for (const ring of poly) srings.push(ring.map(([x, y]) => ftToPxRef.current(x, y)) as [number, number][]);
        drawScribbleFill(ctx, srings, r.fill.slice(0, 7), scribbleTRef.current, (Math.round(Math.abs(r.bbox[0]) + Math.abs(r.bbox[1])) | 0) + 1);
      }

      const [cpx, cpy] = ftToPxRef.current(r.center[0], r.center[1]);
      const pw = (r.bbox[2] - r.bbox[0]) * scaleRef.current;
      const ph = (r.bbox[3] - r.bbox[1]) * scaleRef.current;

      // Zone detail symbols (furniture, fire pit, rows…) — clipped to the feature, scaled to its size.
      if (illustrative && r.key && pw > 16 && ph > 16) {
        ctx.save();
        const dpolys = geom.geometry.type === 'Polygon' ? [geom.geometry.coordinates] : geom.geometry.coordinates;
        ctx.beginPath();
        for (const poly of dpolys) for (const ring of poly) ring.forEach(([x, y], k) => { const [px, py] = ftToPxRef.current(x, y); if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.clip('evenodd');
        drawZoneDetail(ctx, r.key, cpx, cpy, pw, ph, scaleRef.current, (Math.round(Math.abs(cpx) + Math.abs(cpy)) | 0) + 3);
        ctx.restore();
      }

      if (r.label && pw > r.labelMinPx && ph > 18) {
        ctx.save();
        const fs = Math.max(8, Math.min(12, pw / 9));
        if (illustrative) {
          // Hand-lettered: cursive script, warm graphite, paper halo, a touch of rotation.
          ctx.translate(cpx, cpy); ctx.rotate((seededRng((cpx * 13 + cpy) | 0)() * 2 - 1) * 0.04);
          ctx.font = `600 ${Math.round(fs * 1.5)}px ${HAND}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const label = r.label.charAt(0).toUpperCase() + r.label.slice(1);
          ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(247,243,234,0.92)'; ctx.lineJoin = 'round'; ctx.strokeText(label, 0, 0);
          ctx.fillStyle = '#40392e'; ctx.fillText(label, 0, 0);
        } else {
          ctx.fillStyle = '#FFFFFF'; ctx.font = `600 ${fs}px ${IT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3;
          ctx.fillText(r.label.toUpperCase(), cpx, cpy);
        }
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

      // Active feature: dimension labels along its width & height, for easier scaling.
      if (illustrative && r.active) {
        const wFt = Math.round(r.bbox[2] - r.bbox[0]), hFt = Math.round(r.bbox[3] - r.bbox[1]);
        const cP = ftToPxRef.current((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
        const out = (p: [number, number], dist: number): [number, number] => { const dx = p[0] - cP[0], dy = p[1] - cP[1], d = Math.hypot(dx, dy) || 1; return [p[0] + dx / d * dist, p[1] + dy / d * dist]; };
        const wMid = out(ftToPxRef.current((r.bbox[0] + r.bbox[2]) / 2, r.bbox[3]), 13);
        const hMid = out(ftToPxRef.current(r.bbox[2], (r.bbox[1] + r.bbox[3]) / 2), 15);
        ctx.save();
        ctx.font = `600 11px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        const dim = (t: string, x: number, y: number) => { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(247,243,234,0.95)'; ctx.strokeText(t, x, y); ctx.fillStyle = '#2F6B4F'; ctx.fillText(t, x, y); };
        dim(`${wFt} ft`, wMid[0], wMid[1]);
        dim(`${hFt} ft`, hMid[0], hMid[1]);
        ctx.restore();

        // Rotate gizmo: a handle on a stem above the feature — drag to rotate.
        if (r.key !== null) {
          const g = rotateHandlePx(ftToPxRef.current, scaleRef.current, r.center, r.rot, r.bbox);
          ctx.save();
          ctx.strokeStyle = '#2F6B4F'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
          ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(g.edge[0], g.edge[1]); ctx.lineTo(g.hpx[0], g.hpx[1]); ctx.stroke(); ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(g.hpx[0], g.hpx[1], 9, 0, Math.PI * 2); ctx.fillStyle = 'white'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
          ctx.beginPath(); ctx.arc(g.hpx[0], g.hpx[1], 4.5, Math.PI * 0.15, Math.PI * 1.5); ctx.lineWidth = 1.5; ctx.stroke(); // ↻ glyph
          ctx.restore();
        }
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
      // Trace the path's centreline (straight segments or a smoothed spline) as the current subpath.
      const trace = () => {
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
      };
      const w = Math.max(2, path.widthFt * scaleRef.current); // true width, to-scale
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const baseColor = path.color ?? PATH_COLOR;
      if (path.kind === 'creek') {
        // Dry creek bed: a river-rock band with a soft edge and a scatter of stones down the centre.
        ctx.globalAlpha = isSelPth ? 1 : 0.92;
        trace(); ctx.strokeStyle = baseColor; ctx.lineWidth = w; ctx.stroke();
        ctx.globalAlpha = 0.5;
        trace(); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, w * 0.42); ctx.setLineDash([1.5, w * 0.5]); ctx.stroke();
        ctx.setLineDash([]);
        if (isSelPth) { ctx.globalAlpha = 1; trace(); ctx.strokeStyle = '#3F454D'; ctx.lineWidth = 1.5; ctx.stroke(); }
      } else {
        ctx.globalAlpha = isSelPth ? 1 : 0.9;
        trace(); ctx.strokeStyle = isSelPth ? '#3F454D' : baseColor; ctx.lineWidth = w; ctx.stroke();
      }
      ctx.restore();
    }

    // Plant plan: species canopies, shown on the plants step (drawn over the ground & features).
    // Ordered groundcover → shrub → large shrub → tree so overstory sits on top.
    if (illustrative && openStepRef.current === 'plants' && plantMarkersRef.current.length) {
      const pbClip = boundaryFtRef.current;
      const order: Record<string, number> = { groundcover: 0, shrub: 1, large_shrub: 2, tree: 3 };
      const sorted = [...plantMarkersRef.current].sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
      ctx.save();
      if (pbClip.length >= 3) { ctx.beginPath(); pbClip.forEach(([x, y], i) => { const [px, py] = ftToPxRef.current(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.clip(); }
      for (const mk of sorted) {
        const [px, py] = ftToPxRef.current(mk.x, mk.y);
        const rPx = Math.max(mk.kind === 'groundcover' ? 2.5 : 4, mk.rFt * scaleRef.current);
        ctx.beginPath(); ctx.arc(px, py, rPx, 0, Math.PI * 2);
        ctx.fillStyle = mk.color + (mk.kind === 'groundcover' ? '9C' : 'CC'); ctx.fill();
        ctx.lineWidth = mk.kind === 'tree' ? 1.6 : 1.1; ctx.strokeStyle = mk.color; ctx.stroke();
        if (mk.kind === 'tree') { ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fillStyle = '#5a4632'; ctx.fill(); }
      }
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

    // ── Privacy screening targets ───────────────────────────────────────────────
    const pTargets = privacyTargetsRef.current;
    const pickMode = privacyPickRef.current;
    if (pTargets.length || pickMode) {
      const bf = boundaryFtRef.current;
      const lbl = (text: string, cx: number, cy: number) => {
        ctx.font = `600 11px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width + 12;
        ctx.beginPath(); if ((ctx as any).roundRect) (ctx as any).roundRect(cx - w / 2, cy - 8, w, 16, 4); else ctx.rect(cx - w / 2, cy - 8, w, 16);
        ctx.fillStyle = '#2F6B4F'; ctx.fill(); ctx.fillStyle = '#eef3ee'; ctx.fillText(text, cx, cy);
      };
      // Boundary edges
      for (let i = 0; i < bf.length; i++) {
        const a = bf[i], b = bf[(i + 1) % bf.length];
        const [ax, ay] = ftToPxRef.current(a[0], a[1]);
        const [bx, by] = ftToPxRef.current(b[0], b[1]);
        const sel = pTargets.some(t => t.kind === 'edge' && t.edgeIndex === i);
        if (sel) {
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.strokeStyle = '#2F6B4F'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
          lbl('🔒 Privacy', (ax + bx) / 2, (ay + by) / 2);
        } else if (pickMode) {
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.setLineDash([7, 5]); ctx.strokeStyle = 'rgba(47,107,79,0.6)'; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // Feature targets — a dashed ring around the placed feature.
      for (const t of pTargets) {
        if (t.kind !== 'feature') continue;
        const z = zonesRef.current.find(zz => zz.id === t.featureId);
        if (!z) continue;
        const ring = shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
        const [cx, cy] = ftToPxRef.current((minX + maxX) / 2, (minY + maxY) / 2);
        const rPx = (Math.max(maxX - minX, maxY - minY) / 2 + 4) * scaleRef.current;
        ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, Math.PI * 2); ctx.setLineDash([7, 5]); ctx.strokeStyle = '#2F6B4F'; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
        lbl('🔒 Privacy', cx, cy - rPx - 2);
      }
    }
  }, [cs, cssSize, sunMap, illustrative]);

  // Keep the sun-layer ref in sync (heatmap shows during the intro OR when toggled on) + redraw.
  useEffect(() => { draw(); }, [showSun, draw]);

  // Size + draw the editing canvas BEFORE paint so the plan is present on the first frame (no
  // blank flash / jump when the auto-layout page mounts after the reveal hand-off).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(cssSize.w * dpr);
    canvas.height = Math.floor(cssSize.h * dpr);
    canvas.style.width  = cssSize.w + 'px';
    canvas.style.height = cssSize.h + 'px';
    draw();
  }, [cssSize, draw]);

  useEffect(() => { draw(); }, [draw, placedZones, selectedId, paths, selectedPathId, placedBeds, selectedBedId, boundaryFt, obstacleFt, mapAffine, defaultVariant, privacyTargets, privacyPick]);

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
    kind:    'move' | 'resize' | 'vertex' | 'rotate';
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
    zone: PlacedZone; part: 'move' | 'resize' | 'vertex' | 'edge' | 'rotate'; vertIdx?: number; edgeIdx?: number; ptFt?: [number, number];
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
      // Guided (illustrative) mode: only the active feature is interactive — you can move/resize the
      // one you're on, but clicks elsewhere don't grab other features.
      if (illustrative && z.id !== sel) continue;

      // Rotate handle (active feature, illustrative) takes priority over move/resize.
      if (illustrative && z.id === sel && z.key !== undefined && !z.verts) {
        const ring = shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot);
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const [x, y] of ring) { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
        const g = rotateHandlePx(ftToPxRef.current, scaleRef.current, [(bx0 + bx1) / 2, (by0 + by1) / 2], z.rot ?? 0, [bx0, by0, bx1, by1]);
        if (Math.hypot(mx - g.hpx[0], my - g.hpx[1]) <= 12) return { zone: z, part: 'rotate' };
      }

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

      // Rotation-agnostic: test the resize handle by its drawn (rotated) position, and test move in
      // FEET space (so it works whatever the plan's rotation is, not just axis-aligned).
      if (z.id === sel) {
        const [hx, hy] = ftToPxRef.current(z.xFt + z.wFt, z.yFt + z.hFt);
        if (Math.hypot(mx - hx, my - hy) <= 13) return { zone: z, part: 'resize' };
      }
      const [fx, fy] = pxToFtRef.current(mx, my);
      if (fx >= z.xFt && fx <= z.xFt + z.wFt && fy >= z.yFt && fy <= z.yFt + z.hFt)
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

      if (b.id === sel) {
        const [hx, hy] = ftToPxRef.current(b.xFt + b.wFt, b.yFt + b.hFt);
        if (Math.hypot(mx - hx, my - hy) <= 13) return { bed: b, part: 'resize' as const };
      }
      const [fx, fy] = pxToFtRef.current(mx, my);
      if (fx >= b.xFt && fx <= b.xFt + b.wFt && fy >= b.yFt && fy <= b.yFt + b.hFt)
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

    // Privacy edge-marking: clicking toggles the nearest boundary edge.
    if (privacyPickRef.current) {
      const bf = boundaryFtRef.current;
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < bf.length; i++) {
        const a = bf[i], b = bf[(i + 1) % bf.length];
        const [ax, ay] = ftToPxRef.current(a[0], a[1]);
        const [bx, by] = ftToPxRef.current(b[0], b[1]);
        const d = segPointDist(mx, my, ax, ay, bx, by);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0 && bestD <= 16) togglePrivacyEdge(bestI);
      return;
    }

    if (addingBedRef.current?.step === 'draw') return; // handled by onClick / onDoubleClick

    if (pathDrawMode === 'picking-start') {
      pathDrawStart.current = pxToFt(mx, my);
      setPathDrawMode('picking-end');
      draw();
      return;
    }
    if (pathDrawMode === 'picking-end' && pathDrawStart.current) {
      const startFt = pathDrawStart.current;
      const endFt = pxToFt(mx, my);
      const seed  = Date.now() % 9999;
      const id = `path_manual_${Date.now()}`;
      // Details step (illustrative) draws either a walkway or a dry creek bed with the tool's chosen
      // style/material; the non-illustrative walkways step uses the global walkway settings.
      const dk = detailKindRef.current;
      let newPath: PlacedPath;
      if (dk === 'creek') {
        const cm = CREEK_MATERIALS.find(m => m.id === detailMaterialRef.current) ?? CREEK_MATERIALS[0];
        newPath = {
          id, label: `Dry creek bed ${pathsRef.current.filter(p => p.kind === 'creek').length + 1}`,
          startId: 'manual', endId: 'manual',
          pts: buildPath(pathDrawStart.current, endFt, detailStyleRef.current, seed),
          style: detailStyleRef.current, material: cm.id, widthFt: 1, kind: 'creek', color: cm.color,
        };
      } else if (dk === 'walkway') {
        const wm = (detailMaterialRef.current as PathMaterial);
        const wc = PATH_MATERIALS.find(m => m.id === wm)?.color;
        newPath = {
          id, label: `Walkway ${pathsRef.current.filter(p => (p.kind ?? 'walkway') === 'walkway').length + 1}`,
          startId: 'manual', endId: 'manual',
          pts: buildPath(pathDrawStart.current, endFt, detailStyleRef.current, seed),
          style: detailStyleRef.current, material: wm, widthFt: pathWidthForMaterial(wm), kind: 'walkway', color: wc,
        };
      } else {
        newPath = {
          id, label: `Walkway ${pathsRef.current.length + 1}`,
          startId: 'manual', endId: 'manual',
          pts: buildPath(pathDrawStart.current, endFt, globalPathStyle, seed),
          style: globalPathStyle, material: globalPathMaterial, widthFt: pathWidthForMaterial(globalPathMaterial),
        };
      }
      if (dk) detailDrawn.current.push({ id, start: startFt, end: endFt, seed }); // for live Shape re-shaping
      setPaths(prev => [...prev, newPath]);
      setSelectedPathId(null);      // collapsed until the user clicks it
      pathDrawStart.current = null;
      // Keep the tool active so multiple can be drawn in a row (details step); otherwise stop.
      setPathDrawMode(dk ? 'picking-start' : 'idle');
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
      // Guided mode: keep the active feature selected (its selection is driven by the stepper);
      // clicking empty space shouldn't deselect it or grab a bed.
      if (illustrative && openStepRef.current === 'features') return;
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
    if (hit.part === 'rotate') {
      dragRef.current = { kind: 'rotate', zoneId: hit.zone.id, startMx: mx, startMy: my, origX: 0, origY: 0, origW: 0, origH: 0 };
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
      const d0 = pxToFtRef.current(bedDrag.startMx, bedDrag.startMy), d1 = pxToFtRef.current(mx, my);
      const dxFt = d1[0] - d0[0], dyFt = d1[1] - d0[1];
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
    if (drag.kind === 'rotate') {
      const [fx, fy] = pxToFtRef.current(mx, my);
      zonesRef.current = zonesRef.current.map(z => {
        if (z.id !== drag.zoneId) return z;
        const cx = z.xFt + z.wFt / 2, cy = z.yFt + z.hFt / 2;
        return { ...z, rot: Math.atan2(fy - cy, fx - cx) + Math.PI / 2 };
      });
      draw();
      return;
    }
    const d0 = pxToFtRef.current(drag.startMx, drag.startMy), d1 = pxToFtRef.current(mx, my);
    const dxFt = d1[0] - d0[0], dyFt = d1[1] - d0[1];
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
  // Deep-link support: /review's "Edit plan" reopens the flow on a specific step (e.g. plants).
  const location = useLocation();
  const initialStep: StepId = ((location.state as any)?.step === 'plants' && illustrative) ? 'plants' : 'features';
  const [openStep,  setOpenStep]  = useState<StepId | null>(initialStep);
  const [doneSteps, setDoneSteps] = useState<Set<StepId>>(new Set());

  // Changing steps (incl. clicking Done) deactivates everything, so no leftover
  // shape/size toolbar or handles linger on a later step.
  const openStepRef = useRef<StepId | null>(initialStep);
  useEffect(() => {
    openStepRef.current = openStep;
    // Clear selection on step change — EXCEPT the guided features step, whose own effect selects the
    // active feature (so it's highlighted immediately on arrival, not only after the first edit).
    if (!(illustrative && openStep === 'features')) {
      selRef.current = null;    setSelectedId(null);
      selBedRef.current = null; setSelectedBedId(null);
      setSelectedPathId(null);
    }
    if (openStep !== 'privacy') setPrivacyPick(false);
    if (openStep !== 'details') { setDetailKind(null); pathDrawStart.current = null; setPathDrawMode('idle'); } // stop any in-progress draw
    draw(); // redraw for the new step (e.g. show/hide the sun heatmap)
  }, [openStep, draw]);

  // Animate the planting beds being "scribbled in" when the materials step opens.
  useEffect(() => {
    if (!illustrative || openStep !== 'materials') { scribbleTRef.current = 1; return; }
    scribbleTRef.current = 0;
    let raf = 0, start = 0;
    const step = (ts: number) => { if (!start) start = ts; scribbleTRef.current = Math.min(1, (ts - start) / 1000); draw(); if (scribbleTRef.current < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [illustrative, openStep, draw]);

  // Visible steps — the illustrative flow opens on feature placement (the sun map is now an
  // onboarding popup, not a step). Walkways are deferred to the later "details" pass.
  const visibleSteps = useMemo<StepId[]>(() => [
    'features',
    ...(illustrative ? [] : ['walkways' as StepId]),
    'materials',
    ...(illustrative ? ['details' as StepId, 'plants' as StepId] : []),
    ...(wantsPrivacy ? ['privacy' as StepId] : []),
  ], [wantsPrivacy, illustrative]);

  const getNextStep = useCallback((from: StepId): StepId | null => {
    const idx = visibleSteps.indexOf(from);
    return idx >= 0 && idx + 1 < visibleSteps.length ? visibleSteps[idx + 1] : null;
  }, [visibleSteps]);

  const advanceToNext = useCallback((from: StepId) => {
    setDoneSteps(prev => new Set([...prev, from]));
    setOpenStep(getNextStep(from));
  }, [getNextStep]);

  const isDoneStep = (id: StepId) => doneSteps.has(id);

  // ── Plant selection (ported from /plant-options) — species picked & placed for the open ground ──
  const dbStyle = useMemo(() => mapStyle(prefs.style || ''), [prefs]);
  const shade = useMemo(() => Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('shade'), [prefs]);
  const speciesBudget = STYLE_TOTAL_SPECIES[dbStyle];
  const speciesShares = useMemo(() => allocateSpecies(speciesBudget.target), [speciesBudget]); // [tree, large_shrub, shrub, groundcover]

  const [treeSel, setTreeSel] = useState<TreeSelection | null>(null);
  const [layerSel, setLayerSel] = useState<Record<'large_shrub' | 'shrub' | 'groundcover', LayerSelection | null>>({ large_shrub: null, shrub: null, groundcover: null });
  const [picks, setPicks] = useState<Record<Layer, SpeciesCandidate[]>>({ tree: [], large_shrub: [], shrub: [], groundcover: [] });
  const [plantsLoaded, setPlantsLoaded] = useState(false);
  const [plantsErr, setPlantsErr] = useState(false);
  const [plantGroupOpen, setPlantGroupOpen] = useState(0); // which plant-type group is expanded
  const [swapTarget, setSwapTarget] = useState<{ layer: Layer; idx: number } | null>(null); // open swap popup
  const plantMarkersRef = useRef<{ x: number; y: number; rFt: number; color: string; kind: Layer }[]>([]);

  // Sun category at a feet position, from the sun map (full ≥6 hrs, part 4–6 hrs, else shade).
  const sunCatAt = useCallback((x: number, y: number): SunCat => {
    if (!sunMap) return 'full';
    const v = sampleSun(sunMap, x, y);
    return v >= 0.66 ? 'full' : v >= 0.33 ? 'part' : 'shade';
  }, [sunMap]);

  // Fraction of the open planting ground in each sun category (grid-sampled inside the boundary,
  // excluding features / structures / beds). Drives species variety + how many go in each region.
  const sunAreaPct = useMemo<Record<SunCat, number> | null>(() => {
    if (!sunMap || boundaryFt.length < 3) return null;
    const featRings: [number, number][][] = [];
    for (const z of placedZones) if (z.verts || (z.wFt > 0 && z.hFt > 0)) { try { featRings.push(shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)); } catch { /* skip */ } }
    for (const b of placedBeds) { try { featRings.push(shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)); } catch { /* skip */ } }
    for (const v of obstacleFt) featRings.push(v);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of boundaryFt) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    const step = Math.max(2, Math.max(maxX - minX, maxY - minY) / 60);
    const cnt: Record<SunCat, number> = { full: 0, part: 0, shade: 0 };
    let tot = 0;
    for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) {
      if (!ptInPoly(x, y, boundaryFt)) continue;
      if (featRings.some(r => ptInPoly(x, y, r))) continue;
      cnt[sunCatAt(x, y)]++; tot++;
    }
    if (!tot) return null;
    return { full: cnt.full / tot, part: cnt.part / tot, shade: cnt.shade / tot };
  }, [sunMap, boundaryFt, obstacleFt, placedZones, placedBeds, sunCatAt]);
  const sunAreaPctRef = useRef(sunAreaPct);
  useEffect(() => { sunAreaPctRef.current = sunAreaPct; }, [sunAreaPct]);

  // Select species once (async DB + hardiness zone), seeding the per-layer picks from the budget.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let zone: number | undefined;
        if (typeof siteContext.lat === 'number' && typeof siteContext.lng === 'number') { try { zone = (await fetchHardinessZone(siteContext.lat, siteContext.lng))?.zone_number; } catch { /* no zone */ } }
        const plan = (() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } })();
        const ps = prefs.style || '';
        const [ts, ls, ms, gc] = await Promise.all([
          selectTrees({ prefsStyle: ps, boundary, existing, projectAreaFt: plan.projectAreaFt, zone, coverageGoal: shade ? SHADE_CANOPY_COVERAGE_GOAL : TREE_CANOPY_COVERAGE_GOAL }),
          selectLayer('large_shrub', { prefsStyle: ps, zone }),
          selectLayer('shrub', { prefsStyle: ps, zone }),
          selectLayer('groundcover', { prefsStyle: ps, zone }),
        ]);
        if (!live) return;
        setTreeSel(ts);
        setLayerSel({ large_shrub: ls, shrub: ms, groundcover: gc });
        // Seed picks so the chosen varieties cover each sun category present in the yard (≥8% of
        // ground), then fill the remaining budget by ranked order.
        const areaPct = sunAreaPctRef.current;
        const presentCats = areaPct ? SUN_CATS.filter(c => areaPct[c] >= 0.08) : (['full', 'part'] as SunCat[]);
        const seed = (cands: SpeciesCandidate[], count: number): SpeciesCandidate[] => {
          if (count <= 0) return [];
          const chosen: SpeciesCandidate[] = [], used = new Set<number>();
          for (const cat of presentCats) {
            if (chosen.length >= count) break;
            const sp = cands.find(c => !used.has(c.id) && plantSunCats(c.sun_requirement).includes(cat));
            if (sp) { chosen.push(sp); used.add(sp.id); }
          }
          for (const c of cands) { if (chosen.length >= count) break; if (!used.has(c.id)) { chosen.push(c); used.add(c.id); } }
          return chosen;
        };
        setPicks({
          tree: ts.candidates.slice(0, Math.min(ts.candidates.length, ts.targetToPlant === 0 ? 0 : Math.max(1, Math.min(speciesShares[0], ts.targetToPlant)))),
          large_shrub: seed(ls.candidates, Math.min(ls.candidates.length, speciesShares[1])),
          shrub: seed(ms.candidates, Math.min(ms.candidates.length, speciesShares[2])),
          groundcover: seed(gc.candidates, Math.min(gc.candidates.length, speciesShares[3])),
        });
        setPlantsLoaded(true);
      } catch { if (live) setPlantsErr(true); }
    })();
    return () => { live = false; };
  }, [prefs, speciesShares, shade, boundary, existing, siteContext]);

  const poolFor = (l: Layer): SpeciesCandidate[] => l === 'tree' ? (treeSel?.candidates || []) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.candidates || []);
  const styleMatchedFor = (l: Layer): number => l === 'tree' ? (treeSel?.styleMatched ?? 0) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.styleMatched ?? 0);
  const plantTotalSpecies = LAYER_ORDER.reduce((s, l) => s + picks[l].length, 0);
  const plantsAtMax = plantTotalSpecies >= speciesBudget.max;

  // Structural space budget — trees + large shrubs compete for open planting ground.
  const plantable = useMemo(() => {
    try {
      const plan = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
      let beds = 0;
      for (const b of plan.beds || []) {
        if (b.material === 'lawn' || b.type !== 'planted' || !b.ring || b.ring.length < 3) continue;
        let a = 0; const r = b.ring;
        for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
        beds += Math.abs(a / 2);
      }
      return Math.max(0, (plan.primaryGroundAreaFt || 0) + beds);
    } catch { return 0; }
  }, [placedBeds, placedZones, paths, defaultVariant]);
  const usableGround = plantable * PLANT_PACKING_EFFICIENCY;
  const hasPlantSpace = plantable > 0;
  const treeAvgFoot = picks.tree.length ? picks.tree.reduce((s, t) => s + canopyFootprintFt(t.matureWidthFt), 0) / picks.tree.length : 0;
  const consumedTrees = treeSel ? treeSel.targetToPlant * treeAvgFoot : 0;
  const consumedLarge = picks.large_shrub.reduce((s, c) => s + LAYER_QTY_PER_SPECIES.large_shrub * canopyFootprintFt(c.matureWidthFt), 0);
  const structuralRoom = usableGround - consumedTrees - consumedLarge;
  const avgLargeFoot = (() => { const pool = poolFor('large_shrub'); return pool.length ? pool.reduce((s, c) => s + canopyFootprintFt(c.matureWidthFt), 0) / pool.length : canopyFootprintFt(8); })();
  const canAddLarge = !hasPlantSpace || (structuralRoom - LAYER_QTY_PER_SPECIES.large_shrub * avgLargeFoot >= 0);

  // Swap the pick at [layer][idx] for a specific alternative chosen from the popup.
  const applySwap = (l: Layer, idx: number, next: SpeciesCandidate) => {
    setPicks(prev => { const copy = [...prev[l]]; copy[idx] = next; return { ...prev, [l]: copy }; });
    setSwapTarget(null);
  };
  const removePick = (l: Layer, idx: number) => setPicks(prev => prev[l].length <= 1 ? prev : { ...prev, [l]: prev[l].filter((_, i) => i !== idx) });
  const addPick = (l: Layer) => setPicks(prev => {
    const pool = poolFor(l), shown = new Set(prev[l].map(c => c.id));
    const next = pool.find(c => !shown.has(c.id)); return next ? { ...prev, [l]: [...prev[l], next] } : prev;
  });
  const canAddLayer = (l: Layer) => !plantsAtMax && picks[l].length < poolFor(l).length && (l !== 'large_shrub' || canAddLarge);
  const layerRight = (l: Layer): string => {
    if (l === 'tree' && treeSel) {
      if (treeSel.targetToPlant === 0) return picks.tree.length ? `${picks.tree.length} selected (override)` : 'None recommended';
      return `Aim for ${treeSel.targetToPlant} new ${treeSel.targetToPlant === 1 ? 'tree' : 'trees'}${treeSel.existingCounted ? ` · ${treeSel.existingCounted} existing` : ''}${shade ? ' · shade priority' : ''}`;
    }
    return `${picks[l].length} selected`;
  };

  // Plant instances (trees as individuals; shrubs/groundcover as drifts filling a share of the ground).
  const canopyR = (c: SpeciesCandidate) => Math.max(0.4, c.matureWidthFt / 2);
  const DRIFT: Record<string, number> = { large_shrub: 1, shrub: 5, groundcover: 10 };
  const COVERAGE_TARGET = 1.2;
  const GROUND_SHARE: Record<string, number> = { large_shrub: 0.10, shrub: 0.40, groundcover: 0.50 };
  const FRONT_TALL_HEIGHT_FT = 4;
  type PlantSlot = { id: string; layer: Layer; r: number; name: string; under: boolean; drift: string; tall: boolean; sun?: SunCat[] };
  // Visual-interest plants (trees + large shrubs) are capped at 1 per 500 sf of planting ground,
  // rounded down — split across the yard's sun regions and cycling species for variety.
  const VISUAL_SF_PER_PLANT = 500;
  const plantSlots = useMemo<PlantSlot[]>(() => {
    const s: PlantSlot[] = [];
    const catAreaPct = sunAreaPct; // null → treat the whole yard as one region (unconstrained)
    const cats: (SunCat | null)[] = catAreaPct ? SUN_CATS.filter(c => catAreaPct[c] > 0.01) : [null];
    const visualCap = Math.max(0, Math.floor(plantable / VISUAL_SF_PER_PLANT));

    // Trees first (overstory, not sun-constrained), capped by the visual-interest budget.
    const treeWant = Math.max(treeSel?.targetToPlant ?? 0, picks.tree.length);
    const treeN = Math.min(treeWant, visualCap);
    for (let i = 0; i < treeN && picks.tree.length; i++) {
      const sp = picks.tree[i % picks.tree.length], name = sp.common_name || sp.botanical_name;
      s.push({ id: `tree-${i}`, layer: 'tree', r: canopyR(sp), name, under: isUnderPlanting(sp), drift: `tree-${i}`, tall: false });
    }

    // Large shrubs fill the remaining visual-interest budget, distributed across sun regions by area
    // and cycling through the picked species so it's not all one plant.
    const largeN = Math.max(0, visualCap - treeN);
    if (picks.large_shrub.length && largeN > 0) {
      const catList: (SunCat | null)[] = [];
      if (catAreaPct) { for (const c of cats as SunCat[]) { const k = Math.round(largeN * catAreaPct[c]); for (let i = 0; i < k; i++) catList.push(c); } }
      while (catList.length < largeN) catList.push((cats[catList.length % cats.length]) ?? null);
      catList.length = largeN;
      const speciesIdx: Record<string, number> = {};
      catList.forEach((cat, li) => {
        const pool = cat ? picks.large_shrub.filter(sp => plantSunCats(sp.sun_requirement).includes(cat)) : picks.large_shrub;
        if (!pool.length) return;
        const key = cat ?? 'x'; const idx = speciesIdx[key] ?? 0; speciesIdx[key] = idx + 1;
        const sp = pool[idx % pool.length], drift = `large-${key}-${li}`;
        s.push({ id: `${drift}-0`, layer: 'large_shrub', r: canopyR(sp), name: sp.common_name || sp.botanical_name, under: isUnderPlanting(sp), drift, tall: sp.matureHeightFt >= FRONT_TALL_HEIGHT_FT, sun: cat ? [cat] : undefined });
      });
    }

    // Understory (shrubs + groundcover): fill a share of the ground, split by sun region.
    const groundLayers = (['shrub', 'groundcover'] as Layer[]).filter(l => picks[l].length);
    const shareSum = groundLayers.reduce((sum, l) => sum + GROUND_SHARE[l], 0) || 1;
    let d = 0;
    for (const layer of groundLayers) {
      if (plantable <= 0) break;
      const layerArea = plantable * COVERAGE_TARGET * (GROUND_SHARE[layer] / shareSum);
      const driftN = DRIFT[layer] || 3;
      for (const cat of cats) {
        const catArea = cat && catAreaPct ? layerArea * catAreaPct[cat] : layerArea;
        if (catArea <= 0) continue;
        const catSpecies = cat ? picks[layer].filter(sp => plantSunCats(sp.sun_requirement).includes(cat)) : picks[layer];
        if (!catSpecies.length) continue;
        let acc = 0, j = 0, guard = 0;
        while (acc < catArea && guard < 200 && s.length < 360) {
          const sp = catSpecies[j % catSpecies.length], r = canopyR(sp), key = `${layer}-${cat ?? 'x'}-${d}`;
          const name = sp.common_name || sp.botanical_name, under = isUnderPlanting(sp), tall = sp.matureHeightFt >= FRONT_TALL_HEIGHT_FT;
          for (let k = 0; k < driftN; k++) s.push({ id: `${key}-${k}`, layer, r, name, under, drift: key, tall, sun: cat ? [cat] : undefined });
          acc += driftN * Math.PI * r * r; j++; d++; guard++;
        }
      }
    }
    return s;
  }, [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover, treeSel, plantable, sunAreaPct]);

  const [plantPositions, setPlantPositions] = useState<Record<string, { x: number; y: number }>>({});
  const plantPositionsRef = useRef(plantPositions);
  useEffect(() => { plantPositionsRef.current = plantPositions; }, [plantPositions]);
  // Auto-place whenever the slot set changes (preserving any positions already computed).
  useEffect(() => {
    if (!plantsLoaded) return;
    if (!plantSlots.length) { setPlantPositions({}); return; }
    const plan = (() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } })();
    const fixed: Record<string, { x: number; y: number }> = {};
    for (const s of plantSlots) if (plantPositionsRef.current[s.id]) fixed[s.id] = plantPositionsRef.current[s.id];
    setPlantPositions(placePlan({ boundary, existing, plan: { zones: plan.zones || [], beds: plan.beds || [], paths: plan.paths || [] }, instances: plantSlots.map(s => ({ id: s.id, layer: s.layer, r: s.r, under: s.under, drift: s.drift, tall: s.tall, sun: s.sun })), fixed, sunAt: sunMap ? sunCatAt : undefined }));
  }, [plantSlots, plantsLoaded, boundary, existing, wantsPrivacy, sunMap, sunCatAt]);

  // Distinct colour per species (greens), matching the old plant page.
  const plantSpeciesColor = useMemo(() => {
    const m = new Map<string, string>(); let i = 0;
    for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) {
      const name = sp.common_name || sp.botanical_name;
      if (!m.has(name)) m.set(name, PLANT_SPECIES_PALETTE[i++ % PLANT_SPECIES_PALETTE.length]);
    }
    return m;
  }, [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover]);

  // Feed the drawn markers to the canvas (feet coords — same CS as the placement page).
  useEffect(() => {
    const out: { x: number; y: number; rFt: number; color: string; kind: Layer }[] = [];
    for (const s of plantSlots) {
      const p = plantPositions[s.id]; if (!p) continue;
      out.push({ x: p.x, y: p.y, rFt: s.r, color: plantSpeciesColor.get(s.name) ?? '#5a7a50', kind: s.layer });
    }
    plantMarkersRef.current = out;
    draw();
  }, [plantSlots, plantPositions, plantSpeciesColor, draw]);

  // Persist placed instances so the 3D / review views can render the same plan.
  useEffect(() => {
    if (!plantsLoaded) return;
    const byName = new Map<string, SpeciesCandidate>();
    for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) byName.set(sp.common_name || sp.botanical_name, sp);
    const ev = (v: any) => v === true || v === 'true' || v === 'TRUE' || v === 't';
    const instances = plantSlots.filter(s => plantPositions[s.id]).map(s => {
      const sp = byName.get(s.name);
      return { x: plantPositions[s.id].x, y: plantPositions[s.id].y, name: s.name, layer: s.layer, widthFt: sp ? sp.matureWidthFt : s.r * 2, heightFt: sp ? sp.matureHeightFt : 4, type: sp ? sp.type : '', evergreen: sp ? ev(sp.is_evergreen) : false, color: plantSpeciesColor.get(s.name) || '' };
    });
    try { localStorage.setItem('diyPlantInstances', JSON.stringify(instances)); } catch { /* ignore */ }
  }, [plantPositions, plantSlots, plantSpeciesColor, plantsLoaded, picks]);


  // ── Stats
  // Lawn coverage = the lawn zones the user placed (not residual space).
  const lawnAreaFt = useMemo(() => {
    if (!cs) return 0;
    const lawns = placedZones.filter(z => z.key === 'lawn' && z.wFt > 0 && z.hFt > 0);
    if (!lawns.length) return 0;
    // Same obstacles the renderer clips the lawn against, so the area matches what's drawn.
    const obstacles: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    for (const z of placedZones) if (z.key !== 'lawn' && (z.verts || (z.wFt > 0 && z.hFt > 0))) { try { obstacles.push(turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)])); } catch { /* skip */ } }
    for (const b of placedBeds) { try { obstacles.push(turf.polygon([shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts)])); } catch { /* skip */ } }
    for (const p of paths) { const pp = pathPolyFt(p.pts, p.widthFt); if (pp) obstacles.push(pp); }
    for (const v of obstacleFt) { const r = closeRingPts(v); if (r) { try { obstacles.push(turf.polygon([r])); } catch { /* skip */ } } }
    let bdy: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
    const bc = closeRingPts(boundaryFt); if (bc) { try { bdy = turf.polygon([bc]); } catch { bdy = null; } }
    let total = 0;
    for (const z of lawns) {
      let geom: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)]);
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
    for (const z of placedZones) if (z.verts || (z.wFt > 0 && z.hFt > 0)) { try { cut(turf.polygon([shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)])); } catch { /* skip */ } }
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
      .map(z => mk(z.label, shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot)));

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

  // Guided stepper (auto-layout): the placed features to walk through, in order, lawn last.
  const guideZones = useMemo(
    () => illustrative ? GUIDE_ORDER.flatMap(k => placedZones.filter(z => z.key === k)) : [],
    [illustrative, placedZones],
  );
  const guideZone = guideZones[guideIdx] ?? null;
  const guideHint = guideZone ? (guideZone.key === 'water' ? waterHint : (FEAT_HINTS[guideZone.key] ?? '')) : '';
  // Pristine as-generated zones (by id) so a feature can be reset to its original shape/material/placement.
  const originalZones = useMemo<Record<string, PlacedZone>>(() => {
    try { const p = JSON.parse(localStorage.getItem('diyPlacementPlanOriginal') || '{}'); const m: Record<string, PlacedZone> = {}; for (const z of (p.zones ?? [])) m[z.id] = z; return m; } catch { return {}; }
  }, []);
  const resetGuideZone = useCallback(() => {
    if (!guideZone) return;
    const o = originalZones[guideZone.id];
    if (!o) return;
    updateZone(guideZone.id, { shape: o.shape, material: o.material, xFt: o.xFt, yFt: o.yFt, wFt: o.wFt, hFt: o.hFt, rot: o.rot ?? 0, verts: o.verts });
  }, [guideZone, originalZones, updateZone]);
  // Explain why this feature landed where it did (near the house vs. out in the yard) + the alternative.
  const guideReason = (() => {
    if (!guideZone) return '';
    const fx = guideZone.xFt + guideZone.wFt / 2, fy = guideZone.yFt + guideZone.hFt / 2;
    let near = true;
    const ref = houseGeomFt?.centroid;
    if (ref && cs) near = Math.hypot(fx - ref[0], fy - ref[1]) < Math.hypot(cs.widthFt, cs.heightFt) * 0.33;
    return placementReason(guideZone.key, (guideZone.label || '').toLowerCase(), near) || guideHint;
  })();

  // Selecting the current step's feature highlights it (+ drag/resize handles) on the canvas.
  // Only while the "features" step is open, so it doesn't fight selection on later steps.
  useEffect(() => {
    if (!illustrative || openStep !== 'features') return;
    const id = guideZones[guideIdx]?.id ?? null;
    selRef.current = id; setSelectedId(id); setSelectedBedId(null); setSelectedPathId(null);
  }, [illustrative, openStep, guideIdx, guideZones]);

  // Instruction shown at the top of the map (active feature hint on the features step) —
  // only once at least one feature has actually been placed. Suppressed in guided mode (the
  // hint lives in the stepper card instead).
  const topBanner =
    !illustrative && openStep === 'features' ? (placedZones.length > 0 ? activeHint : '')
    : '';

  // Guided one-feature-at-a-time panel — replaces the "Place your features" step's content in
  // auto-layout (illustrative) mode. The features are pre-placed; the user walks through each to
  // fine-tune position/shape/material.
  const stepLabelStyle = { fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', textTransform: 'uppercase' as const, letterSpacing: '0.09em', fontWeight: 600 };

  // Share of the yard in full sun (~6+ hrs) — shown on the sun-map step.
  const sunBrightPct = (() => {
    if (!sunMap) return null;
    let n = 0, bright = 0;
    for (const v of sunMap.score) { if (v < 0) continue; n++; if (v >= 0.72) bright++; } // ~6+ hrs
    return n ? Math.round((bright / n) * 100) : null;
  })();
  const guidedStepperPanel = (
    <div className="flex flex-col gap-5">
      {guideZones.length === 0 ? (
        <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>No features to place.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 style={{ fontFamily: IS, fontSize: '2rem', color: '#2A2A26', margin: 0, fontWeight: 400, lineHeight: 1.05 }}>{guideZone?.label ?? ''}</h2>
              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontWeight: 500, flexShrink: 0 }}>{Math.min(guideIdx + 1, guideZones.length)} of {guideZones.length}</span>
            </div>
            {guideReason && <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>{guideReason}</p>}
          </div>

          {guideZone && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span style={stepLabelStyle}>Shape</span>
                {(() => {
                  const w = Math.round(guideZone.wFt), h = Math.round(guideZone.hFt);
                  const area = Math.round((guideZone.shape === 'circle' ? Math.PI / 4 : guideZone.shape === 'organic' ? 0.82 : 1) * guideZone.wFt * guideZone.hFt);
                  return <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', fontWeight: 500 }}>{w} × {h} ft · {area.toLocaleString()} sq ft</span>;
                })()}
              </div>
              <div className="flex gap-2">
                {([{ id: 'rect', label: 'Square' }, { id: 'circle', label: 'Round' }, { id: 'organic', label: 'Organic' }] as { id: ZoneShape; label: string }[]).map(s => {
                  const on = guideZone.shape === s.id;
                  return (
                    <button key={s.id} onClick={() => updateZone(guideZone.id, { shape: s.id })}
                      className="flex-1 py-2.5 rounded-xl transition-all hover:opacity-90"
                      style={{ fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, cursor: 'pointer',
                        background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
                        border: on ? 'none' : '1.5px solid rgba(42,42,38,0.14)' }}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {guideZone && MATERIAL_FEATURES.has(guideZone.key) && (
            <div className="flex flex-col gap-2">
              <span style={stepLabelStyle}>Material</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                {FEATURE_MATERIALS.map(m => {
                  const on = (guideZone.material ?? 'gravel') === m.id;
                  return (
                    <button key={m.id} onClick={() => updateZone(guideZone.id, { material: m.id })}
                      className="flex items-center gap-2 px-3 py-3 rounded-xl transition-all hover:opacity-90"
                      style={{ fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, cursor: 'pointer', color: '#2A2A26',
                        background: on ? 'rgba(47,107,79,0.08)' : 'white',
                        border: on ? '1.5px solid #2F6B4F' : '1.5px solid rgba(42,42,38,0.14)' }}>
                      <span style={{ width: 14, height: 14, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.12)' }} />
                      {m.label}
                      {on && <span className="ml-auto" style={{ color: '#2F6B4F', fontWeight: 700 }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {guideZone && originalZones[guideZone.id] && (
            <button onClick={resetGuideZone}
              className="self-start transition-all hover:opacity-80"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#7A7A73' }}>
              Reset this feature
            </button>
          )}
        </>
      )}
    </div>
  );

  // "Fill in the details" panel — draw walkways / dry creek beds, or click one to edit it.
  const detailMaterialOptions = detailKind === 'creek'
    ? CREEK_MATERIALS
    : PATH_MATERIALS.map(m => ({ id: m.id, label: m.label, color: m.color }));
  const selDetailPath = paths.find(p => p.id === selectedPathId) ?? null;
  const detailsPanel = (
    <div className="flex flex-col gap-4">
      <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
        Add the finishing touches to your project layout.
      </p>

      {detailKind ? (
        <div className="flex flex-col gap-3 rounded-xl p-3.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26', fontWeight: 600 }}>{detailKind === 'creek' ? 'Dry creek bed' : 'Walkway'}</span>
            <button onClick={cancelDetailDraw} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontFamily: IT, fontSize: '0.78rem' }}>Done</button>
          </div>
          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>
            Click two points on the map to connect them{pathDrawMode === 'picking-end' ? ' — now click the end point.' : '.'}
          </p>

          <div className="flex flex-col gap-1.5">
            <span style={stepLabelStyle}>Shape</span>
            <div className="flex gap-1.5">
              {(['straight', 'winding'] as PathStyle[]).map(s => (
                <button key={s} onClick={() => setDetailStyleLive(s)}
                  className="flex-1 rounded-full px-3 py-1.5 capitalize transition-all"
                  style={{ background: detailStyle === s ? '#2A2A26' : 'white', color: detailStyle === s ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, border: `1.5px solid ${detailStyle === s ? '#2A2A26' : 'rgba(42,42,38,0.16)'}`, cursor: 'pointer' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {detailMaterialOptions.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span style={stepLabelStyle}>Material</span>
            <div className="grid grid-cols-2 gap-1.5">
              {detailMaterialOptions.map(m => (
                <button key={m.id} onClick={() => setDetailMaterial(m.id)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition-all"
                  style={{ background: detailMaterial === m.id ? 'white' : 'transparent', border: `1.5px solid ${detailMaterial === m.id ? '#2A2A26' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>{m.label}</span>
                </button>
              ))}
            </div>
          </div>
          )}
        </div>
      ) : selDetailPath ? (
        <div className="flex flex-col gap-3 rounded-xl p-3.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26', fontWeight: 600 }}>{selDetailPath.label}</span>
            <button onClick={() => setSelectedPathId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontFamily: IT, fontSize: '0.78rem' }}>Done</button>
          </div>

          <div className="flex flex-col gap-1.5">
            <span style={stepLabelStyle}>Shape</span>
            <div className="flex gap-1.5">
              {(['straight', 'winding'] as PathStyle[]).map(s => (
                <button key={s} onClick={() => reshapePathById(selDetailPath.id, s)}
                  className="flex-1 rounded-full px-3 py-1.5 capitalize transition-all"
                  style={{ background: selDetailPath.style === s ? '#2A2A26' : 'white', color: selDetailPath.style === s ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, border: `1.5px solid ${selDetailPath.style === s ? '#2A2A26' : 'rgba(42,42,38,0.16)'}`, cursor: 'pointer' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {(selDetailPath.kind ?? 'walkway') !== 'creek' && (
          <div className="flex flex-col gap-1.5">
            <span style={stepLabelStyle}>Material</span>
            <div className="grid grid-cols-2 gap-1.5">
              {PATH_MATERIALS.map(m => (
                <button key={m.id} onClick={() => setPathMaterialById(selDetailPath.id, m.id)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition-all"
                  style={{ background: selDetailPath.material === m.id ? 'white' : 'transparent', border: `1.5px solid ${selDetailPath.material === m.id ? '#2A2A26' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>{m.label}</span>
                </button>
              ))}
            </div>
          </div>
          )}

          <button onClick={() => { setPaths(prev => prev.filter(x => x.id !== selDetailPath.id)); setSelectedPathId(null); }}
            className="rounded-full px-4 py-2 transition-all hover:opacity-90"
            style={{ background: 'white', color: '#B4534B', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: '1.5px solid rgba(180,83,75,0.3)', cursor: 'pointer' }}>
            Remove
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {([
            { kind: 'walkway' as const, label: 'Walkway', sub: 'Draw a path to connect spaces' },
            { kind: 'creek' as const, label: 'Dry creek bed', sub: 'Wind a river-rock bed through the yard' },
          ]).map(o => (
            <button key={o.kind} onClick={() => startDetailDraw(o.kind)}
              className="flex items-center justify-between gap-2 rounded-xl px-3.5 py-3 transition-all hover:opacity-90"
              style={{ background: 'white', border: '1.5px solid rgba(42,42,38,0.14)', cursor: 'pointer', textAlign: 'left' }}>
              <div>
                <div style={{ fontFamily: IT, fontSize: '0.86rem', color: '#2A2A26', fontWeight: 500 }}>{o.label}</div>
                <div style={{ fontFamily: IT, fontSize: '0.74rem', color: '#9A9A92' }}>{o.sub}</div>
              </div>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}>+</span>
            </button>
          ))}
        </div>
      )}

      {paths.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700 }}>Added</span>
          {paths.map(p => (
            <div key={p.id} onClick={() => { if (detailKind) cancelDetailDraw(); setSelectedPathId(p.id); }}
              className="flex items-center gap-2 rounded-xl px-3 py-2 transition-all"
              style={{ background: selectedPathId === p.id ? 'white' : 'rgba(42,42,38,0.05)', border: `1.5px solid ${selectedPathId === p.id ? 'rgba(42,42,38,0.16)' : 'transparent'}`, cursor: 'pointer' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color ?? PATH_COLOR, flexShrink: 0 }} />
              <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{p.label}</span>
              <button onClick={(e) => { e.stopPropagation(); setPaths(prev => prev.filter(x => x.id !== p.id)); if (selectedPathId === p.id) setSelectedPathId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // "Choose your plants" panel — species grouped by type (visual interest / foundation / groundcover),
  // each with compact swap/remove/add rows, matched to this sidebar layout.
  // showLabel: only name the plant type when a group holds more than one (e.g. trees vs large shrubs).
  const renderPlantLayer = (l: Layer, showLabel = true) => (
    <div key={l} className="flex flex-col gap-2" style={{ marginTop: 4 }}>
      <div className="flex items-baseline gap-2">
        {showLabel && <span style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26' }}>{LAYER_INFO[l].label}</span>}
        <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', marginLeft: 'auto' }}>{plantsLoaded || treeSel ? layerRight(l) : 'Loading…'}</span>
      </div>
      {plantsLoaded && picks[l].length === 0 && (
        <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#9A9A8E', margin: 0, lineHeight: 1.45 }}>
          {l === 'tree' && treeSel && treeSel.targetToPlant === 0
            ? `Based on your project size, we don't think you need any more trees.`
            : styleMatchedFor(l) === 0 ? `No ${dbStyle} ${LAYER_INFO[l].label.toLowerCase()} in the database.` : 'None selected — add one below.'}
        </p>
      )}
      {picks[l].map((sp, idx) => (
        <div key={sp.id} className="flex items-center gap-2.5 rounded-xl p-2" style={{ background: 'white', border: '1.5px solid rgba(42,42,38,0.1)' }}>
          <div style={{ width: 40, height: 40, borderRadius: 8, overflow: 'hidden', flexShrink: 0, border: `2px solid ${plantSpeciesColor.get(sp.common_name || sp.botanical_name) ?? '#5a7a50'}` }}>
            <PlantThumb kind={THUMB_KIND[l]} seed={sp.id} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.common_name || sp.botanical_name}</div>
            <div style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A8E' }}>{sp.sizeLabel}</div>
          </div>
          <button onClick={() => setSwapTarget({ layer: l, idx })} title="Swap species"
            className="flex items-center gap-1 transition-all hover:opacity-80"
            style={{ background: 'rgba(61,92,58,0.09)', border: '1.5px solid rgba(61,92,58,0.25)', borderRadius: 999, padding: '4px 9px', cursor: 'pointer', color: '#3d5c3a', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, flexShrink: 0 }}>
            ↻ Swap
          </button>
          {picks[l].length > 1 && <button onClick={() => removePick(l, idx)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontSize: '0.8rem', padding: '2px 4px', flexShrink: 0 }}>✕</button>}
        </div>
      ))}
      {l === 'tree' && treeSel && treeSel.targetToPlant === 0 && picks.tree.length === 0 ? (
        <button onClick={() => addPick('tree')} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
          style={{ background: 'rgba(42,42,38,0.04)', border: '1.5px dashed rgba(42,42,38,0.18)', cursor: 'pointer' }}>
          <span style={{ fontFamily: IT, fontSize: '0.76rem', color: '#6A6A60', fontWeight: 500 }}>Add one anyway — I want more shade</span>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '0.9rem', lineHeight: 1, flexShrink: 0 }}>+</span>
        </button>
      ) : canAddLayer(l) && (
        <button onClick={() => addPick(l)} className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all"
          style={{ background: 'rgba(42,42,38,0.03)', border: '1.5px dashed rgba(42,42,38,0.2)', cursor: 'pointer', color: '#7A7A6E', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500 }}>
          <span style={{ fontSize: '1.05rem', lineHeight: 1 }}>+</span> Add another
        </button>
      )}
    </div>
  );
  const plantsPanel = (
    <div className="flex flex-col gap-3">
      <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
        We chose plants suited to your yard's sun, hardiness zone, and style — and placed each only where its sun needs are met.
      </p>
      {plantsErr && <p style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A6A2A', margin: 0 }}>Couldn't reach the plant database — check your connection.</p>}
      {!plantsLoaded && !plantsErr && (
        <div className="flex items-center gap-2.5" style={{ fontFamily: IT, fontSize: '0.85rem', color: '#9A9A92' }}>
          <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.25)', borderTopColor: '#2A2A26', animation: 'spin 0.8s linear infinite' }} />
          Choosing plants for your beds…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {plantsLoaded && (
        <div className="flex flex-col" style={{ border: '1px solid rgba(42,42,38,0.1)', borderRadius: 14, overflow: 'hidden' }}>
          {PLANT_GROUPS.map((grp, i) => {
            const isOpen = plantGroupOpen === i;
            const count = grp.layers.reduce((a, l) => a + picks[l].length, 0);
            return (
              <div key={grp.title}>
                {i > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}
                <button onClick={() => setPlantGroupOpen(isOpen ? -1 : i)} className="w-full flex items-center gap-2.5 px-3.5 py-3 transition-all hover:opacity-80"
                  style={{ background: isOpen ? 'rgba(42,42,38,0.04)' : 'none', border: 'none', cursor: 'pointer' }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: isOpen ? '#2A2A26' : 'rgba(42,42,38,0.1)', color: isOpen ? 'white' : '#9A9A92', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: IT, fontSize: '0.72rem', fontWeight: 600, flexShrink: 0 }}>{i + 1}</div>
                  <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500, textAlign: 'left' }}>{grp.title}</span>
                  {!isOpen && count > 0 && <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92' }}>· {count}</span>}
                  <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.78rem', color: '#B0B0A6' }}>{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="px-3.5 pb-3.5 pt-2 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                    {grp.layers.map(l => renderPlantLayer(l, grp.layers.length > 1))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // Unified Back / Continue for every placement step — same controls across the whole flow.
  // Features advances through each feature first, then steps advance walkways → materials → review.
  // Placement-rule alert: features left in a too-tight (0–2 ft) gap block progress until fixed.
  const gapAlert = gapWarnings.length > 0 ? (
    <div style={{ borderRadius: 12, padding: '0.7rem 0.85rem', background: '#FEF3C7', border: '1px solid #F59E0B' }}>
      <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#92400E', margin: '0 0 0.35rem', fontWeight: 600 }}>
        Features are too close together
      </p>
      <div className="flex flex-col gap-0.5" style={{ margin: '0 0 0.45rem' }}>
        {gapWarnings.slice(0, 4).map((w, i) => (
          <span key={i} style={{ fontFamily: IT, fontSize: '0.72rem', color: '#92400E' }}>{w.a} &lt;&gt; {w.b} ({w.gap.toFixed(1)} ft)</span>
        ))}
        {gapWarnings.length > 4 && <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#92400E', opacity: 0.8 }}>+{gapWarnings.length - 4} more</span>}
      </div>
      <p style={{ fontFamily: IT, fontSize: '0.73rem', color: '#92400E', margin: 0, lineHeight: 1.5 }}>
        Either move them so that they're touching, or leave at least {GAP_MIN_FT} ft between them for planting space.
      </p>
    </div>
  ) : null;

  const stepNav = (() => {
    const order = visibleSteps;
    const i = Math.max(0, order.indexOf(openStep ?? 'features'));
    const onFeatures = openStep === 'features';
    const blocked = gapWarnings.length > 0;
    const back = () => {
      if (onFeatures && guideIdx > 0) setGuideIdx(g => g - 1);
      else if (i > 0) setOpenStep(order[i - 1]);
      else navigate('/diy/boundary', { state: { step: 'door' } }); // back to the main-entry step
    };
    const next = () => {
      if (blocked) return; // resolve tight-gap warnings first
      if (onFeatures && guideIdx < guideZones.length - 1) setGuideIdx(g => g + 1);
      else if (i < order.length - 1) advanceToNext(order[i]);
      else navigate('/diy/review');
    };
    return (
      <div className="flex gap-2.5 justify-between">
        <button onClick={back}
          className="rounded-full px-6 py-3 transition-all hover:opacity-90"
          style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
          ← Back
        </button>
        <button onClick={next} disabled={blocked} title={blocked ? 'Fix the spacing warnings to continue' : undefined}
          className="rounded-full px-6 py-3 transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: 'none', cursor: blocked ? 'default' : 'pointer' }}>
          Continue →
        </button>
      </div>
    );
  })();

  // ── Render ───────────────────────────────────────────────────────────────────
  const accordionStepNum = Math.max(1, visibleSteps.indexOf(openStep ?? 'features') + 1);
  const designProg = designProgress(openStep ?? 'features');
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: illustrative ? '#F4F0E6' : '#E7E1D5', overflow: 'hidden', paddingTop: illustrative ? 0 : '2rem' }}>

      {/* Sun onboarding: dim the rest of the UI so the popup + "Sun layer" button stand out. */}
      {sunOnboard && (
        <div onClick={dismissSunOnboard} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(20,18,12,0.34)', cursor: 'pointer' }} />
      )}

      {/* Plant swap popup — choose an alternative species for the selected slot. */}
      {swapTarget && (() => {
        const pool = poolFor(swapTarget.layer);
        const current = picks[swapTarget.layer][swapTarget.idx];
        const usedIds = new Set(picks[swapTarget.layer].filter((_, i) => i !== swapTarget.idx).map(c => c.id));
        return (
          <div onClick={() => setSwapTarget(null)} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,18,12,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: '#F4F0E6', borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.32)', overflow: 'hidden' }}>
              <div className="flex items-center justify-between" style={{ padding: '16px 18px 12px', flexShrink: 0 }}>
                <div>
                  <div style={{ fontFamily: IS, fontSize: '1.4rem', color: '#2A2A26', lineHeight: 1.1 }}>Swap {LAYER_INFO[swapTarget.layer].label.toLowerCase()}</div>
                  <div style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A8E' }}>{pool.length} {dbStyle} option{pool.length === 1 ? '' : 's'} for your zone</div>
                </div>
                <button onClick={() => setSwapTarget(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ overflowY: 'auto', padding: '0 18px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {pool.map(sp => {
                  const isCurrent = sp.id === current?.id, inUse = usedIds.has(sp.id);
                  return (
                    <button key={sp.id} disabled={inUse} onClick={() => applySwap(swapTarget.layer, swapTarget.idx, sp)}
                      className="flex flex-col transition-all hover:opacity-95 disabled:opacity-45"
                      style={{ textAlign: 'left', background: 'white', borderRadius: 12, overflow: 'hidden', cursor: inUse ? 'default' : 'pointer', border: `2px solid ${isCurrent ? '#3d5c3a' : 'rgba(42,42,38,0.1)'}`, padding: 0 }}>
                      <div style={{ position: 'relative', height: 76 }}>
                        <PlantThumb kind={THUMB_KIND[swapTarget.layer]} seed={sp.id} />
                        {(isCurrent || inUse) && (
                          <span style={{ position: 'absolute', top: 6, right: 6, fontFamily: IT, fontSize: '0.62rem', fontWeight: 600, color: 'white', background: isCurrent ? '#3d5c3a' : 'rgba(42,42,38,0.6)', borderRadius: 999, padding: '2px 7px' }}>{isCurrent ? 'Current' : 'In use'}</span>
                        )}
                      </div>
                      <div style={{ padding: '8px 10px 10px' }}>
                        <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.common_name || sp.botanical_name}</div>
                        <div style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A8E' }}>{sp.sizeLabel}</div>
                      </div>
                    </button>
                  );
                })}
                {pool.length === 0 && (
                  <p style={{ gridColumn: '1 / -1', fontFamily: IT, fontSize: '0.85rem', color: '#9A9A8E', margin: 0 }}>No other options available for your style and zone.</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Header (non-illustrative only — illustrative tucks it into the sidebar) */}
      {!illustrative && (
        <div className="flex items-start justify-between px-10 mb-6 flex-shrink-0">
          <Logo />
          <button onClick={saveAndExit}
            style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
            Save & exit ↗
          </button>
        </div>
      )}

      {!illustrative && (
        <div className="flex-shrink-0" style={{ paddingLeft: '8rem', marginTop: '2rem', marginBottom: '3.5rem' }}>
          <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Build your layout</h1>
        </div>
      )}

      <div className={illustrative ? 'flex flex-1 overflow-hidden' : 'flex flex-1 overflow-hidden pr-32 gap-5 items-start'}
        style={illustrative ? undefined : { paddingBottom: '1.25rem', paddingLeft: '8rem' }}>

        {/* The working area fills the viewport edge-to-edge in illustrative mode. */}
        <div className={illustrative ? 'flex w-full h-full overflow-hidden' : 'contents'}
          style={illustrative ? { background: '#F4F0E6' } : undefined}>

        {/* ── Left sidebar ── */}
        <div className="flex flex-col flex-shrink-0"
          style={illustrative
            ? { width: '34%', minWidth: 380, maxWidth: 540, height: '100%', background: '#F4F0E6', overflow: 'hidden', borderRight: '1px solid rgba(42,42,38,0.1)' }
            : { width: '33%', height: '81%', background: '#EFE9DA', overflow: 'hidden', borderRadius: '1rem', boxShadow: '0 12px 48px rgba(0,0,0,0.12)' }}>

          {illustrative && (
            <div className="flex-shrink-0" style={{ padding: '1.6rem 1.9rem 1.1rem' }}>
              <div className="flex items-center justify-between">
                <Logo />
                <button onClick={saveAndExit}
                  style={{ fontFamily: IT, fontSize: '0.8rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
                  Save &amp; exit ↗
                </button>
              </div>
              <div style={{ marginTop: '1.7rem' }}>
                <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Step {designProg.num} of {designProg.total}</span>
                <h1 style={{ fontFamily: IS, fontSize: '1.9rem', color: '#2A2A26', margin: '0.3rem 0 0', lineHeight: 1.05, fontWeight: 400, fontStyle: 'italic' }}>{DESIGN_STEP_TITLE[(openStep ?? 'features') as keyof typeof DESIGN_STEP_TITLE] ?? 'Refine your layout'}</h1>
                <div style={{ height: 3, marginTop: '1rem', background: 'rgba(42,42,38,0.1)', borderRadius: 999 }}>
                  <div style={{ height: '100%', borderRadius: 999, background: '#2F6B4F', transition: 'width 0.4s', width: `${designProg.pct}%` }} />
                </div>
              </div>
            </div>
          )}

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
                    {idx > 0 && !illustrative && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}

                    {/* Step header — hidden in illustrative (the sidebar shows a linear STEP X OF 3 instead). */}
                    {!illustrative && (
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
                    )}

                    {/* ── Features step ── */}
                    {stepId === 'features' && isOpen && illustrative && (
                      <div className="px-7 pb-2 pt-5">{guidedStepperPanel}</div>
                    )}
                    {stepId === 'features' && isOpen && !illustrative && (
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

                            {!illustrative && (
                            <div className="flex items-center justify-end mt-1">
                              <button onClick={() => advanceToNext('walkways')}
                                className="rounded-full px-5 py-1.5 hover:opacity-90 transition-all"
                                style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                                {paths.length > 0 ? 'Done →' : 'Skip →'}
                              </button>
                            </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Materials step ── */}
                    {stepId === 'materials' && isOpen && (
                      <div className={illustrative ? 'px-7 pb-2 pt-5' : 'px-5 pb-4'} style={illustrative ? undefined : { borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <div className="flex flex-col gap-4">
                          {illustrative && (
                            <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                              Choose the material you'd like to use across your remaining project space.
                            </p>
                          )}

                          {/* Primary material */}
                          <div>
                            <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'block', marginBottom: '0.5rem' }}>
                              Material
                            </span>
                            <div className="flex gap-2">
                              {(['mulch', 'rock'] as const).map(m => (
                                <button key={m} onClick={() => { setDefaultMaterial(m); setDefaultVariant(GROUND_VARIANTS[m][0].id); }}
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

                          {/* Secondary planting beds — deferred for now (illustrative flow shows only the primary fill). */}
                          {!illustrative && (<>
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
                          </>)}

                          {!illustrative && (
                          <button onClick={() => { setDoneSteps(prev => new Set([...prev, 'materials'])); setOpenStep(null); }}
                            className="self-end mt-1 rounded-full px-5 py-1.5 hover:opacity-90 transition-all"
                            style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                            Done
                          </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── Details step ── */}
                    {stepId === 'details' && isOpen && illustrative && (
                      <div className="px-7 pb-2 pt-5">{detailsPanel}</div>
                    )}

                    {/* ── Plants step ── */}
                    {stepId === 'plants' && isOpen && illustrative && (
                      <div className="px-7 pb-2 pt-5">{plantsPanel}</div>
                    )}

                    {/* ── Privacy step ── */}
                    {stepId === 'privacy' && isOpen && (
                      <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                        <div className="flex flex-col gap-3 pt-3">
                          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', lineHeight: 1.5, margin: 0 }}>
                            What would you like screened? Mark a property edge to line with evergreens, or screen the area around a feature.
                          </p>

                          <button onClick={() => setPrivacyPick(p => !p)}
                            className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
                            style={{ width: '100%', cursor: 'pointer', background: privacyPick ? '#2F6B4F' : 'rgba(42,42,38,0.04)', border: privacyPick ? 'none' : '1.5px dashed rgba(42,42,38,0.18)' }}>
                            <span style={{ fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, color: privacyPick ? '#eef3ee' : '#6A6A60' }}>{privacyPick ? 'Done marking edges' : 'Mark a property edge'}</span>
                            <span style={{ fontFamily: IT, fontSize: '0.9rem', color: privacyPick ? '#eef3ee' : '#9A9A92' }}>🔒</span>
                          </button>
                          {privacyPick && <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#2F6B4F', margin: 0 }}>Click a boundary edge on the map to screen it.</p>}

                          {placedZones.filter(z => z.key !== 'lawn').length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#6A6A60', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Or screen around a feature</span>
                              <div className="flex flex-wrap gap-1.5">
                                {placedZones.filter(z => z.key !== 'lawn').map(z => {
                                  const on = privacyTargets.some(t => t.kind === 'feature' && t.featureId === z.id);
                                  return (
                                    <button key={z.id} onClick={() => togglePrivacyFeature(z.id)}
                                      className="rounded-full px-3 py-1.5 transition-all hover:opacity-80"
                                      style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: on ? '#2F6B4F' : 'white', color: on ? '#eef3ee' : '#2A2A26', border: on ? 'none' : '1.5px solid rgba(42,42,38,0.12)' }}>
                                      {z.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {privacyTargets.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <span style={{ fontFamily: IT, fontSize: '0.68rem', color: '#B0B0A6', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Screening</span>
                              {privacyTargets.map((t, i) => (
                                <div key={i} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(47,107,79,0.08)' }}>
                                  <span style={{ width: 12, height: 12, borderRadius: 3, background: '#2F6B4F', flexShrink: 0 }} />
                                  <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{t.kind === 'edge' ? `Property edge ${t.edgeIndex + 1}` : (placedZones.find(z => z.id === t.featureId)?.label ?? 'Feature')}</span>
                                  <button onClick={() => t.kind === 'edge' ? togglePrivacyEdge(t.edgeIndex) : togglePrivacyFeature(t.featureId)}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}

                          <button onClick={() => { setPrivacyPick(false); setDoneSteps(prev => new Set([...prev, 'privacy'])); setOpenStep(null); }}
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

          {/* Sidebar footer: rule alerts + consistent Back / Continue across every step. */}
          {illustrative && (
            <div className="flex-shrink-0 flex flex-col gap-2.5" style={{ padding: '1rem 1.9rem 1.6rem', borderTop: '1px solid rgba(42,42,38,0.08)' }}>
              {gapAlert}
              {stepNav}
            </div>
          )}

        </div>

        {/* ── Right: canvas (illustrative drawn plan, or satellite editor) ── */}
        <div className={illustrative ? 'flex-1 overflow-hidden relative' : 'flex-1 overflow-hidden'} style={illustrative ? undefined : { height: '81%' }}>
          {illustrative && (
            <>
              {/* paper base (instant) + graph-paper lines (soft fade-in) */}
              <div style={{ position: 'absolute', inset: 0, backgroundColor: '#EFE9DA' }} />
              <div style={{ position: 'absolute', inset: 0, opacity: gridIn ? 1 : 0, transition: 'opacity 0.9s ease',
                backgroundImage: 'linear-gradient(rgba(42,42,38,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(42,42,38,0.05) 1px, transparent 1px)',
                backgroundSize: '34px 34px' }} />
              <div className="absolute" style={{ top: 18, left: 18, zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', padding: '6px 14px', borderRadius: 999 }}>
                {((siteContext.address || '').split(',')[0].trim().toUpperCase() || 'SITE PLAN')}
              </div>
              {/* Sun layer toggle — introduced by the onboarding popup, then always available. */}
              {sunMap && (
                <button onClick={() => setShowSun(s => !s)} title="Toggle the sun/shade layer"
                  className="absolute flex items-center gap-1.5 transition-all hover:opacity-90"
                  style={{ top: 18, right: 18, zIndex: sunOnboard ? 50 : 11, borderRadius: 999, padding: '7px 14px', cursor: 'pointer',
                    fontFamily: IT, fontSize: '0.75rem', fontWeight: 600,
                    background: showSun ? '#F4C542' : 'white', color: '#2A2A26',
                    border: showSun ? 'none' : '1.5px solid rgba(42,42,38,0.16)',
                    boxShadow: sunOnboard ? '0 0 0 4px rgba(244,197,66,0.5), 0 2px 10px rgba(0,0,0,0.12)' : '0 2px 10px rgba(0,0,0,0.12)' }}>
                  ☀ Sun layer
                </button>
              )}
              {/* Sun onboarding popup — one-time, anchored under the toggle; the rest of the UI dims. */}
              {sunMap && sunOnboard && (
                <div className="absolute flex flex-col gap-3" style={{ top: 56, right: 18, zIndex: 50, width: 268, background: 'white', borderRadius: 16, padding: '16px 16px 14px', boxShadow: '0 12px 40px rgba(0,0,0,0.28)' }}>
                  <p style={{ fontFamily: IT, fontSize: '0.86rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>
                    We ran a sun analysis of your project area to help place your key features and choose plants that work best for your yard.
                  </p>
                  {sunBrightPct != null && (
                    <p style={{ fontFamily: IT, fontSize: '0.86rem', color: '#2A2A26', margin: 0, fontWeight: 700, lineHeight: 1.5 }}>
                      About {sunBrightPct}% of your yard gets full sun.
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <div style={{ height: 9, borderRadius: 999, background: 'linear-gradient(90deg, #5B7FA6, #A9B36E, #F4C542)' }} />
                    <div className="flex justify-between" style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontWeight: 500 }}>
                      <span>Shade (&lt;3 hrs)</span><span>Full sun (6+ hrs)</span>
                    </div>
                  </div>
                  <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>
                    You can view this data at any time to fine-tune the placement of your features.
                  </p>
                  <button onClick={dismissSunOnboard}
                    className="rounded-full py-2 transition-all hover:opacity-90"
                    style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                    Got it
                  </button>
                </div>
              )}
              {/* Sun legend — shown under the toggle while the sun layer is on (outside onboarding). */}
              {sunMap && showSun && !sunOnboard && (
                <div className="absolute flex flex-col gap-1" style={{ top: 56, right: 18, zIndex: 11, width: 150, background: 'white', borderRadius: 12, padding: '8px 10px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
                  <div style={{ height: 8, borderRadius: 999, background: 'linear-gradient(90deg, #5B7FA6, #A9B36E, #F4C542)' }} />
                  <div className="flex justify-between" style={{ fontFamily: IT, fontSize: '0.66rem', color: '#9A9A92', fontWeight: 500 }}>
                    <span>Shade</span><span>Full sun</span>
                  </div>
                </div>
              )}
              {/* Paper grain — subtle grayscale noise over the whole plan for a drawn-on-paper feel. */}
              <div style={{ position: 'absolute', inset: 0, zIndex: 8, pointerEvents: 'none', mixBlendMode: 'multiply', opacity: 0.12,
                backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
                backgroundSize: '160px 160px' }} />
            </>
          )}
          <div className={illustrative ? 'w-full h-full overflow-hidden relative' : 'w-full h-full rounded-2xl overflow-hidden relative'}
            ref={containerRef}
            style={illustrative ? { background: 'transparent' } : { boxShadow: '0 12px 48px rgba(0,0,0,0.22)', background: '#1a1a1a' }}>

            {illustrative && illoXf && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <IllustrativeSite width={cssSize.w} height={cssSize.h} animate={false} transform={illoXf} bare />
              </div>
            )}

            {!illustrative && isLoaded && (
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

        </div>{/* card wrapper */}
      </div>

      {/* Fixed nav (satellite editor only — illustrative uses the sidebar footer) */}
      {!illustrative && (<>
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
      </>)}
    </div>
  );
}
