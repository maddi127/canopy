import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import * as turf from '@turf/turf';
import Logo from '../components/Logo';
import IllustrativeSite from '../components/IllustrativeSite';
import YardIllustration from '../components/YardIllustration';
import { sampleSun, type SunMap } from '../services/sunAnalysis';
import { generateLayout } from '../services/layoutGenerator';
import { designProgress, DESIGN_STEP_TITLE } from '../lib/designProgress';
import type { ConfirmedFeature } from './DiyFeatureConfirmPage';
import {
  selectTrees, selectLayer, mapStyle, STYLE_TOTAL_SPECIES, LAYER_SPECIES_TARGET,
  PLANT_PACKING_EFFICIENCY, LAYER_QTY_PER_SPECIES, canopyFootprintFt, placePlan,
  TREE_CANOPY_COVERAGE_GOAL, SHADE_CANOPY_COVERAGE_GOAL, plantSunCats,
  plantCapacity, cloneCapacity, pocketFits, consumePocket, densityParams, plantableStats,
  type Layer, type TreeSelection, type LayerSelection, type SpeciesCandidate, type SunCat, type PlantCapacity,
} from '../services/plantSelectionService';
import { buildPlantSlots, type PlantSlot } from '../services/plantSlots';
import BackButton from '../components/BackButton';
import { fetchHardinessZone } from '../features/sun/hardinessZone';
import { bloomColorFor } from '../lib/plantColors';
import { buildPlantClusters, paintPlantClusters, paintSketchFeaturePoly, paintSketchGroundFill, paintLawnMowerArcs, paintPathEdges, paintPathBody } from '../lib/planPainter';
import { useAutosave } from '../hooks/useAutosave';
import SaveStatusChip from '../components/SaveStatusChip';
import { IS, IT, HAND, INK, GREEN } from '../lib/theme';

// ── Plant-step grouping + formatting (ported from /plant-options, matched to this layout) ──
// Species budget → per-layer counts, weighted toward the matrix (shrubs/groundcover).
// (SPECIES_WEIGHT percentage split retired — see LAYER_SPECIES_TARGET in plantSelectionService)
// Deterministic largest-remainder allocation of `total` across `weights`. Every positive-weight
// slot is floored at 1 when the budget allows (total >= #slots); when total < #slots only the
// highest-weight slots get a 1 (smallest-weight slots dropped last). No randomness. Shared by the
// layer-budget split (allocateSpecies) and the FIX A sun-region species split (seed).
const allocateProportional = (total: number, weights: number[]): number[] => {
  const n = weights.length, out = new Array(n).fill(0);
  if (n === 0 || total <= 0) return out;
  const byWeight = weights.map((w, i) => ({ i, w })).sort((a, b) => (b.w - a.w) || (a.i - b.i));
  if (total <= n) { for (let k = 0; k < total; k++) out[byWeight[k].i] = 1; return out; }
  out.fill(1);
  const rem = total - n, sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map(w => (w / sum) * rem), fl = raw.map(Math.floor);
  fl.forEach((v, i) => (out[i] += v));
  let left = rem - fl.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, f: v - fl[i] })).sort((a, b) => (b.f - a.f) || (a.i - b.i));
  for (let k = 0; left > 0; k++, left--) out[order[k % n].i]++;
  return out;
};
const LAYER_ORDER: Layer[] = ['tree', 'large_shrub', 'shrub', 'groundcover'];
const LAYER_INFO: Record<Layer, { label: string; sub: string }> = {
  tree:        { label: 'Trees',        sub: 'Canopy & shade' },
  large_shrub: { label: 'Large shrubs', sub: 'Structure & screening (6 ft +)' },
  shrub:       { label: 'Shrubs',       sub: 'Medium & small, filling in' },
  groundcover: { label: 'Filler plant',  sub: 'Low plants that knit it together' },
};
// The three groups shown in the toolbar.
const PLANT_GROUPS: { title: string; sub: string; layers: Layer[] }[] = [
  { title: 'Visual interest plants', sub: 'Trees and large shrubs — the structure everything builds around.', layers: ['tree', 'large_shrub'] },
  { title: 'Foundation plants',      sub: 'Medium and small shrubs that fill in between.', layers: ['shrub'] },
  { title: 'Filler plants',          sub: 'Low, spreading plants that tie the beds together.', layers: ['groundcover'] },
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

// Real plant photo (Conservation Garden Park) when the species has one; otherwise the procedural
// PlantThumb. A load error (e.g. a broken hotlink) falls back to the procedural thumb too — so the
// UI never shows a broken image. Lazy-loaded per visible card.
function PlantImage({ url, kind, seed }: { url?: string | null; kind: 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'; seed: number }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <PlantThumb kind={kind} seed={seed} />;
  return (
    <img src={url} alt="" loading="lazy" onError={() => setBroken(true)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
  );
}
// Species → marker colour on the plan (greens, matching the old plant page).
const PLANT_SPECIES_PALETTE = ['#3d5c3a', '#6a9460', '#4a7a50', '#8aa06a', '#5c8a5c', '#a7b56a', '#7a9a4a', '#386b4a', '#9caf5a', '#6b8e3a', '#5a7a50', '#b0a04a'];

// Sun categories used across the yard + which a species tolerates. Parsing is canonical in
// plantSelectionService — the old local copy here matched a legacy underscore vocabulary no DB
// row uses, so every plant read as ['full','part'] and shade tolerance was invisible.
const SUN_CATS: SunCat[] = ['full', 'part', 'shade'];
const SUN_CAT_LABEL: Record<SunCat, string> = { full: 'Full sun', part: 'Part sun', shade: 'Shade' };


// ── Shared sidebar primitives (visual consistency across Features / Details / Plants) ────────────
// One card shell, one disclosure chevron, one uppercase control-group label, one dashed "add" row,
// and one selected-state treatment — so every editor section reads as the same system.
const cardShell = (open = false): React.CSSProperties => ({
  border: `1.5px solid ${open ? 'rgba(42,42,38,0.35)' : 'rgba(42,42,38,0.12)'}`,
  borderRadius: 12, background: 'white', overflow: 'hidden',
});
const CARD_TITLE: React.CSSProperties = { fontFamily: IT, fontSize: '0.9rem', fontWeight: 600, color: '#2A2A26' };
const CARD_SUMMARY: React.CSSProperties = { fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', flexShrink: 0, textAlign: 'right', marginLeft: 'auto' };
const GROUP_LABEL: React.CSSProperties = { fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 600 };
const ADD_ROW: React.CSSProperties = { background: 'rgba(42,42,38,0.03)', border: '1.5px dashed rgba(42,42,38,0.2)', cursor: 'pointer', color: '#7A7A6E', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500 };
// Selected list item / card: cream fill + dark 2px ring (used for selected feature, path, species).
const selShell = (on: boolean): React.CSSProperties => ({
  background: on ? '#F4F0E6' : 'rgba(42,42,38,0.05)',
  border: on ? '2px solid #2A2A26' : '2px solid transparent',
});
// The summary span (CARD_SUMMARY) carries margin-left:auto and pushes right; the chevron sits flush
// after it — so it must NOT also take auto margin, or the free space splits and a gap opens up.
const Chevron = ({ open }: { open: boolean }) => (
  <span style={{ fontFamily: IT, fontSize: '1rem', color: '#9A9A92', flexShrink: 0, display: 'inline-block', lineHeight: 1, transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : 'none' }}>›</span>
);
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
    case 'water': return `Placed as a focal point in the yard. Alternatively, it could anchor a quieter corner.`;
    case 'garden': return `Placed in an open, sunny spot away from the shade of the house and big trees.`;
    case 'storage': return `Tucked into the least visible corner. Alternatively, it could sit closer to the house for convenience.`;
    case 'lawn': return `Shaped as a large, central open space. Alternatively, it could shift toward the house or hug one side.`;
    default: return '';
  }
}

// Order features are walked through in the guided (auto-layout) stepper — lawn last.
const GUIDE_ORDER = ['seating', 'dining', 'cooking', 'water', 'garden', 'storage', 'lawn'];

// ── Accordion step types ───────────────────────────────────────────────────────
type StepId = 'sun' | 'features' | 'walkways' | 'materials' | 'details' | 'groundcover' | 'plants' | 'privacy' | 'lawn' | 'review';

const STEP_TITLE: Record<StepId, string> = {
  sun:         'Your sun map',
  features:    'Place your features',
  walkways:    'Walkways',
  materials:   'Planting beds',
  details:     'Fill in the details',
  groundcover: 'Groundcovers',
  plants:      'Choose your plants',
  privacy:     'Privacy',
  lawn:        'Lawn',
  review:      'Review your plan',
};

// First-run editor tour: a short walkthrough shown once (per browser) the first time a design opens in
// the guided editor. Step 0 is the existing sun-map explanation; the rest introduce the editable layers
// and open the sidebar section they describe (sidebarStep) so the user sees the controls in question.
type OnboardStep = { key: string; eyebrow: string; title: string; intro: string; intro2?: string; bullets: { icon: string; text: string }[]; sidebarStep?: StepId; };
const ONBOARD_STEPS: OnboardStep[] = [
  {
    key: 'sun', eyebrow: 'Before you dig in', title: 'We analyzed your sunlight',
    intro: 'Using your home, trees, and structures, we modeled how the sun moves across your yard:',
    bullets: [],
  },
  {
    key: 'features', eyebrow: 'Getting around', title: 'Everything starts with your features',
    intro: "We've placed your features based on landscape design principles, but now it's time to make it your own.",
    intro2: 'Click any feature to open and edit it. Move it, resize it, change its shape, or rotate it to your liking.',
    bullets: [],
    sidebarStep: 'features',
  },
  {
    key: 'details', eyebrow: 'Getting around', title: 'Fill in the details',
    intro: 'Start with your groundcover — the material that fills the open ground — then add the finishing touches.',
    bullets: [
      { icon: '🪨', text: 'Pick a primary groundcover (mulch or stone) for the whole yard.' },
      { icon: '🚶', text: 'Add walkways and dry creek beds by clicking points on the plan.' },
      { icon: '✏️', text: 'Draw accent beds wherever you want extra planting — we’ll fill them with plants suited to that spot’s sun.' },
    ],
    sidebarStep: 'details',
  },
  {
    key: 'plants', eyebrow: 'Getting around', title: 'Choose your plants',
    intro: "We chose plants suited to your yard's sun, hardiness zone, and style — the last step is making them yours.",
    bullets: [
      { icon: '🔁', text: 'Swap or add species in any group, and dial plant density up or down.' },
      { icon: '👆', text: 'Click a plant on the plan to jump straight to it in the list.' },
    ],
    sidebarStep: 'plants',
  },
];

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
// Darken a #rrggbb toward graphite for a colored-pencil ink edge.
function darkenHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

type PlantMarker = { x: number; y: number; rFt: number; color: string; kind: Layer; name: string };
type PlantCluster = { kind: Layer; name: string; members: PlantMarker[] };

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
// Min distance from a point to a ring's PERIMETER (feet) — checks edges, not just vertices, so a
// point beside the middle of a long edge isn't mistaken for "clear".
function ptToRingEdgeDist(x: number, y: number, ring: Ring): number {
  let min = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    min = Math.min(min, segPointDist(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  }
  return min;
}

// Min distance from a ring's boundary to a path polyline (feet).
function ringToPathMinDist(ring: Ring, pts: [number, number][]): number {
  let min = Infinity;
  for (const [px, py] of ring) for (let i = 0; i < pts.length - 1; i++) min = Math.min(min, segPointDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return min;
}
// Closest point on a path polyline to a reference point (feet).
function nearestOnPath(fx: number, fy: number, pts: [number, number][]): { x: number; y: number; d: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (let i = 0; i < pts.length - 1; i++) { const c = segClosestPx(fx, fy, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]); if (!best || c.dist < best.d) best = { x: c.cx, y: c.cy, d: c.dist }; }
  return best;
}
// Nearest point on a ring's perimeter to a target (feet) — to start a path at a feature's edge.
function nearestOnRing(ring: Ring, tx: number, ty: number): [number, number] {
  let best: [number, number] = ring[0], bd = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? ((tx - ax) * dx + (ty - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(tx - px, ty - py);
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best;
}
function ringAreaAbs(r: Ring): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }

// HARD RULE — a plant's FULL mature footprint (radius rFt = matureWidth/2) must NEVER overlap a
// feature. Returns clearOf(cx, cy, rFt) → false when ANY feature-zone footprint, path corridor, or
// house/structure/hardscape obstacle is nearer than rFt to the centre; a centre INSIDE any of them
// always fails (distance treated as 0). All geometry is in FEET (plan space). Kept identical to the
// twin helper in services/draftPlants.ts so both plant pipelines enforce the rule the same way.
function makePlantClearance(
  zones: any[],
  paths: { pts: [number, number][]; widthFt?: number }[],
  obstacleRings: Ring[],
): (cx: number, cy: number, rFt: number) => boolean {
  // Zone footprint: prefer the baked ring; else derive (ellipse for circle/organic, rect otherwise).
  const zoneRings: Ring[] = [];
  for (const z of zones) {
    const ring: Ring | null = (z && z.ring && z.ring.length >= 3)
      ? z.ring
      : (z && typeof z.xFt === 'number' && typeof z.wFt === 'number')
        ? shapeRingFt(z.shape || 'rect', z.xFt, z.yFt, z.wFt, z.hFt, z.id || 'z', z.verts, z.rot || 0)
        : null;
    if (ring && ring.length >= 3) zoneRings.push(ring);
  }
  const corridors = paths
    .filter(p => (p.pts?.length ?? 0) >= 2)
    .map(p => ({ pts: p.pts, hw: Math.max((p.widthFt || 3) / 2, 0) }));
  const distRing = (x: number, y: number, r: Ring): number => ptInPoly(x, y, r) ? 0 : ptToRingEdgeDist(x, y, r);
  const distPoly = (x: number, y: number, pts: [number, number][]): number => {
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segPointDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    return m;
  };
  return (cx: number, cy: number, rFt: number): boolean => {
    for (const r of zoneRings) if (distRing(cx, cy, r) < rFt) return false;
    for (const o of obstacleRings) if (distRing(cx, cy, o) < rFt) return false;
    for (const c of corridors) if (distPoly(cx, cy, c.pts) - c.hw < rFt) return false; // corridor edge
    return true;
  };
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

  // Debounced autosave of the active design row. Idle (zero DB writes) for
  // anonymous users and until a design is adopted; drives the save-status chip.
  const saveStatus = useAutosave();

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
  // Existing detected features are editable on the satellite editor (see the feature-edit layer
  // below): kept as state so a correction re-flows through every geometry consumer (walkways,
  // area, plant/layout placement), and persisted back to the boundary blob so pages that re-read
  // localStorage — and a later revisit — pick up the corrected shapes.
  const [existing, setExisting] = useState<ConfirmedFeature[]>(() => saved.confirmedFeatures ?? []);
  const originalExistingRef = useRef<ConfirmedFeature[]>(saved.confirmedFeatures ?? []);
  const commitExisting = useCallback((feats: ConfirmedFeature[]) => {
    setExisting(feats);
    try {
      const cur = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      cur.confirmedFeatures = feats;
      localStorage.setItem('diyBoundaryFinal', JSON.stringify(cur));
    } catch { /* ignore quota / serialization issues */ }
  }, []);
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

  // Kept existing features as ft-space polygons — the interactive edit layer (satellite editor).
  type FeatFt = { id: string; type: ConfirmedFeature['type']; label: string; verts: [number, number][] };
  const featFt = useMemo<FeatFt[]>(() => {
    if (!cs) return [];
    return existing
      .filter(f => f.keep && f.vertices.length >= 3)
      .map(f => ({ id: f.id, type: f.type, label: f.label, verts: f.vertices.map(v => cs.toXY(v[0], v[1]) as [number, number]) }));
  }, [existing, cs]);
  const featFtRef = useRef<FeatFt[]>([]);
  useEffect(() => { featFtRef.current = featFt; }, [featFt]);

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
  // Composition focal slots (plan-feet) come from generation and are carried through verbatim — the
  // editor doesn't edit them; it just persists them and feeds them to plant placement. Captured once.
  const focalSlotsRef = useRef<any[]>(Array.isArray(savedPlan.focalSlots) ? savedPlan.focalSlots : []);
  const [addingBed,       setAddingBed]       = useState<{ step: 'type' | 'material' | 'variant' | 'draw'; type?: BedType; material?: GroundMaterial; variant?: GroundVariant; accent?: boolean } | null>(null);
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

  // The editor is always the flat top-down plan now — editing needs a flat interactive surface.
  // (The axonometric "Illustration" tilt was retired in favor of a real, read-only 3D preview —
  // see `show3D` below.) Kept as state (never set past its initial value — no setter is wired to
  // any UI) rather than a plain const: TS narrows an unreassigned `const 'a'|'b' = 'a'` to the
  // literal 'a', which turns every `viewMode === 'illustration'` comparison below into a type
  // error; useState's declared generic isn't narrowed that way, and T/standing/clip/elevation all
  // still correctly no-op to flat/plan behavior since 'illustration' is simply never reached.
  const [viewMode] = useState<'plan' | 'illustration'>('plan');
  const viewModeRef = useRef(viewMode);

  // Read-only illustration preview modal — the static rendered picture of the finished yard, opened
  // on demand so editing (which needs the 2D canvas) and the illustration never have to coexist.
  const [show3D, setShow3D] = useState(false);

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
    // Illustration view: an axonometric tilt — the ground plane's y-axis is squashed. Still an
    // affine, so pxToFt's generic inverse (and therefore every drag/resize/rotate) keeps working.
    const T = viewMode === 'illustration' ? 0.62 : 1;
    // Boundary rotated bbox → sets the scale (the project area fills ~80% of the view).
    let rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
    for (const [x, y] of boundaryFt) { const [rx, ry] = rot(x, y); if (rx < rminX) rminX = rx; if (rx > rmaxX) rmaxX = rx; if (ry < rminY) rminY = ry; if (ry > rmaxY) rmaxY = ry; }
    const rw = (rmaxX - rminX) || 1, rh = (rmaxY - rminY) || 1, fill = 0.8;
    const s = Math.min(fill * cssSize.w / rw, fill * cssSize.h / (rh * T));
    // Visual-mass rotated bbox (boundary + house + trees + hardscape) → used to balance the framing
    // so the plan doesn't float to one side. We blend 60% toward it; the house still clips off-view.
    let uminX = rminX, umaxX = rmaxX, uminY = rminY, umaxY = rmaxY;
    for (const f of existing) {
      if (!f.keep || f.vertices.length < 3) continue;
      for (const v of f.vertices) { const [rx, ry] = rot(...cs!.toXY(v[0], v[1])); if (rx < uminX) uminX = rx; if (rx > umaxX) umaxX = rx; if (ry < uminY) uminY = ry; if (ry > umaxY) umaxY = ry; }
    }
    const uw = (umaxX - uminX) || 1, uh = (umaxY - uminY) || 1, k = 0.6;
    const txB = (cssSize.w - s * rw) / 2 - s * rminX, tyB = (cssSize.h - s * T * rh) / 2 - s * T * rminY;
    const txU = (cssSize.w - s * uw) / 2 - s * uminX, tyU = (cssSize.h - s * T * uh) / 2 - s * T * uminY;
    let tx = txB + (txU - txB) * k, ty = tyB + (tyU - tyB) * k;
    // Keep the ENTIRE project boundary in frame: clamp the mass-blended shift so the boundary's scaled
    // bbox never leaves the viewport. When the house is large (e.g. a front yard), it crops off-view
    // instead of pushing the boundary's far edge out of sight. (pixel_x = s·rx + tx; pixel_y = T·s·ry + ty.)
    const pad = 0.03 * Math.min(cssSize.w, cssSize.h);
    const loTx = pad - s * rminX, hiTx = cssSize.w - pad - s * rmaxX;
    const loTy = pad - s * T * rminY, hiTy = cssSize.h - pad - s * T * rmaxY;
    if (loTx <= hiTx) tx = Math.min(Math.max(tx, loTx), hiTx);
    if (loTy <= hiTy) ty = Math.min(Math.max(ty, loTy), hiTy);
    return {
      a: s * cosT,     c: -s * sinT,    e: tx - s * cosT * cx + s * sinT * cy,
      b: T * s * sinT, d: T * s * cosT, f: ty - T * s * sinT * cx - T * s * cosT * cy,
    };
  }, [illustrative, boundaryFt, houseGeomFt, yardType, cssSize, existing, cs, viewMode]);

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
  const [showResetConfirm, setShowResetConfirm] = useState(false); // "Reset plan" confirmation screen
  const showSunRef = useRef(false);
  useEffect(() => { showSunRef.current = showSun; }, [showSun]);
  // First-run editor tour (see ONBOARD_STEPS). onboardIdx = -1 means the tour isn't running; 0..N-1
  // walks the steps. The sun-specific chrome (heatmap + button highlight) keys off the sun step.
  const [onboardIdx, setOnboardIdx] = useState(-1);
  const inTour = onboardIdx >= 0;
  const onboardStep = inTour ? ONBOARD_STEPS[onboardIdx] : null;
  const sunOnboard = onboardStep?.key === 'sun';
  useEffect(() => {
    if (!illustrative || !sunMap) return;
    if (localStorage.getItem('canopyEditorTourSeen') === '1') return;
    setOnboardIdx(0); // opens on the sun step (the apply-effect below reveals the heatmap)
  }, [illustrative, sunMap]);
  const endTour = useCallback(() => {
    setOnboardIdx(-1);
    setShowSun(false); // clean working view; the button re-enables the layer any time
    try { localStorage.setItem('canopyEditorTourSeen', '1'); } catch { /* ignore */ }
  }, []);
  const nextOnboard = useCallback(() => setOnboardIdx(i => (i < 0 ? i : i >= ONBOARD_STEPS.length - 1 ? (endTour(), -1) : i + 1)), [endTour]);
  const backOnboard = useCallback(() => setOnboardIdx(i => (i > 0 ? i - 1 : i)), []);

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
  const [placedZones,    setPlacedZones]    = useState<PlacedZone[]>(() => {
    if (!Array.isArray(savedPlan.zones)) return [];
    // Guard: a plan should never carry two lawn zones (regeneration seams could stack them,
    // and duplicates collapse onto the same '__lawn' review key). Keep the largest.
    const lawns = savedPlan.zones.filter((z: any) => z.key === 'lawn');
    if (lawns.length <= 1) return savedPlan.zones;
    const keep = lawns.reduce((a: any, b: any) => (a.wFt * a.hFt >= b.wFt * b.hFt ? a : b));
    return savedPlan.zones.filter((z: any) => z.key !== 'lawn' || z === keep);
  });
  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  // The feature row the user has highlighted in the list — its hint shows atop the map.
  const [activeToolKey,  setActiveToolKey]  = useState<string | null>(null);
  // Features the user has skipped (the "✕") — counts as decided, like a delete on /boundary.
  const [skippedKeys,    setSkippedKeys]    = useState<Set<string>>(new Set());
  const [showDeleted,    setShowDeleted]    = useState(false);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedBedId,  setSelectedBedId]  = useState<string | null>(null);
  // Existing detected feature the user is correcting (satellite editor only).
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  // Species highlight (plants step): click a plant on the plan — or a species card — to spotlight it;
  // the shared plan painter dims every other species. Toggling the same name (or null) clears it.
  const [selSpecies,     setSelSpecies]     = useState<string | null>(null);
  const toggleSpecies = useCallback((name: string | null) => setSelSpecies(cur => (name && cur === name) ? null : name), []);
  // A single visual-interest plant (tree / large shrub) selected on the map — shows a move handle and can
  // be dragged to reposition (e.g. off a utility). Other plant layers are spotlight-only.
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const selPlantRef = useRef<string | null>(null);
  // Guided (auto-layout) stepper: which placed feature we're walking through.
  const [guideIdx,       setGuideIdx]       = useState(-1);   // no feature card auto-expanded on landing

  const zonesRef    = useRef<PlacedZone[]>([]);
  const selRef      = useRef<string | null>(null);
  const guideZonesRef = useRef<PlacedZone[]>([]); // mirror of guideZones → clicking a feature opens its card
  const selSpeciesRef = useRef<string | null>(null); // mirror of selSpecies for the imperative draw()
  const plantSlotsRef = useRef<{ id: string; r: number; name: string; layer: Layer }[]>([]); // for the plan click hit-test (layer → which sidebar group to open)
  // Clicking a plant on the plan jumps to the Plants step and spotlights its species: this ref holds
  // the species name whose sidebar card should scroll into view once the step (re)renders, and the
  // map of species → card element to scroll to.
  const pendingPlantScrollRef = useRef<string | null>(null);
  const plantCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const ghostRef    = useRef<{ item: ToolbarItem; cx: number; cy: number } | null>(null);
  const scaleRef    = useRef(scale);
  const ftToPxRef   = useRef(ftToPx);
  const pxToFtRef   = useRef(pxToFt);
  const existingRef = useRef<ConfirmedFeature[]>([]);
  const selFeatRef  = useRef<string | null>(null);
  const pathsRef       = useRef<PlacedPath[]>([]);
  const bedsRef        = useRef<PlacedBed[]>([]);
  const selBedRef      = useRef<string | null>(null);
  const addingBedRef      = useRef<{ step: 'type' | 'material' | 'variant' | 'draw'; type?: BedType; material?: GroundMaterial; variant?: GroundVariant; accent?: boolean } | null>(null);
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
  useEffect(() => { selFeatRef.current  = selectedFeatureId; }, [selectedFeatureId]);
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

    const drawFeature = (feat: turf.Feature<turf.Polygon | turf.MultiPolygon>, fill: string, stroke: string, lineWidth: number, tex: string | null = null, active = false, inkOverride: string | null = null) => {
      const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
      for (const poly of polys) {
        if (illustrative) {
          // Hand-drawn colored-pencil fill + wobbly ink outline (shared plan painter).
          const rings = poly.map(ring => ring.map(([x, y]) => ftToPxRef.current(x, y)) as [number, number][]);
          paintSketchFeaturePoly(ctx, rings, { fill, stroke, lineWidth, tex, active, ink: inkOverride });
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
          // Open ground: colour wash + the material's bold hand-drawn tile (bark mulch or drawn
          // pebbles), so the base surface has texture instead of a flat serpentine scribble.
          const v = defaultVariantRef.current;
          const skind: 'mulch' | 'pebble' = (v === 'river' || v === 'pea' || v === 'lava') ? 'pebble' : 'mulch';
          const gpolys = ground.geometry.type === 'Polygon' ? [ground.geometry.coordinates] : ground.geometry.coordinates;
          const grings = gpolys.flatMap(poly => poly.map(ring => ring.map(([x, y]: number[]) => ftToPxRef.current(x, y)) as [number, number][]));
          paintSketchGroundFill(ctx, grings, { color: VARIANT_COLOR[v], kind: skind });
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

      // Lawn gets a green colored-pencil ink edge; other ground surfaces keep graphite.
      const lawnInk = illustrative && r.key === 'lawn' ? darkenHex((r.fill.slice(0, 7) || '#8daa6a'), 0.62) : null;
      ctx.save();
      drawFeature(geom, r.fill, r.stroke, r.lineWidth, r.tex, r.active, lawnInk);
      ctx.restore();
      // Lawn: 2–3 gentle seeded "mower arcs" across the turf at low alpha (drawn grass, not vector).
      if (illustrative && r.key === 'lawn') {
        const spolys = geom.geometry.type === 'Polygon' ? [geom.geometry.coordinates] : geom.geometry.coordinates;
        const srings = spolys.flatMap(poly => poly.map(ring => ring.map(([x, y]: number[]) => ftToPxRef.current(x, y)) as [number, number][]));
        paintLawnMowerArcs(ctx, srings, ftToPxRef.current(r.bbox[0], r.bbox[1]), ftToPxRef.current(r.bbox[2], r.bbox[3]), lawnInk || 'rgba(74,92,52,0.8)');
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
          ctx.fillStyle = INK; ctx.fillText(label, 0, 0);
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
      // Sampled centreline (straight segments or the smoothed spline) — shared by the
      // drafted material body and the inked corridor edges so the two align exactly.
      const buildCl = (): [number, number][] => {
        const cl: [number, number][] = [];
        if (path.style === 'straight' || pxPts.length <= 2) { cl.push(...pxPts); }
        else {
          cl.push(pxPts[0]);
          for (let i = 0; i < pxPts.length - 1; i++) {
            const p0 = pxPts[Math.max(i - 1, 0)], p1 = pxPts[i], p2 = pxPts[i + 1], p3 = pxPts[Math.min(i + 2, pxPts.length - 1)];
            const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
            const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
            for (let s = 1; s <= 6; s++) { const t = s / 6, mt = 1 - t; cl.push([mt * mt * mt * p1[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * p2[0], mt * mt * mt * p1[1] + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * p2[1]]); }
          }
        }
        return cl;
      };
      if (path.kind === 'creek') {
        if (isSelPth) {
          // Selected creek: keep the original selection highlight EXACTLY (band + sparkle + dark outline).
          ctx.globalAlpha = 1;
          trace(); ctx.strokeStyle = baseColor; ctx.lineWidth = w; ctx.stroke();
          ctx.globalAlpha = 0.5;
          trace(); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, w * 0.42); ctx.setLineDash([1.5, w * 0.5]); ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1; trace(); ctx.strokeStyle = '#3F454D'; ctx.lineWidth = 1.5; ctx.stroke();
        } else if (illustrative) {
          // Dry creek bed: drafted river-rock body (stones + meander) inside the corridor.
          ctx.globalAlpha = 0.95;
          paintPathBody(ctx, buildCl(), w, scaleRef.current, { kind: 'creek', material: path.material, color: baseColor, id: path.id });
        } else {
          ctx.globalAlpha = 0.92;
          trace(); ctx.strokeStyle = baseColor; ctx.lineWidth = w; ctx.stroke();
          ctx.globalAlpha = 0.5;
          trace(); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, w * 0.42); ctx.setLineDash([1.5, w * 0.5]); ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        if (isSelPth) {
          // Selected walkway: keep the original selection highlight EXACTLY (solid dark corridor).
          ctx.globalAlpha = 1;
          trace(); ctx.strokeStyle = '#3F454D'; ctx.lineWidth = w; ctx.stroke();
        } else if (illustrative) {
          // Drafted material body (flagstone / pavers / brick / concrete / gravel) inside the corridor.
          ctx.globalAlpha = 1;
          paintPathBody(ctx, buildCl(), w, scaleRef.current, { kind: 'walkway', material: path.material, color: baseColor, id: path.id });
        } else {
          ctx.globalAlpha = 0.9;
          trace(); ctx.strokeStyle = baseColor; ctx.lineWidth = w; ctx.stroke();
        }
        // Ink the two corridor edges with a wobbly line (same geometry, offset ±w/2).
        if (illustrative) paintPathEdges(ctx, buildCl(), w, pxPts[0]);
      }
      ctx.restore();
    }

    // Plant plan — illustrated foliage on EVERY step (the plan reads as a finished planting
    // illustration, not empty beds). Plan view uses drafting symbology (connected scallop masses
    // per species + inked edges + interior pencil texture); illustration view keeps standing sprites.
    if (illustrative && plantMarkersRef.current.length) {
      const pbClip = boundaryFtRef.current;
      const standing = viewModeRef.current === 'illustration';
      ctx.save();
      // Plan view clips foliage to the yard; illustration view must NOT — standing canopies rise
      // above the boundary line by design.
      if (!standing && pbClip.length >= 3) { ctx.beginPath(); pbClip.forEach(([x, y], i) => { const [px, py] = ftToPxRef.current(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.clip(); }

      if (standing) {
        // ── Illustration view: standing 3D-ish sprites (unchanged) ──
        const order: Record<string, number> = { groundcover: 0, shrub: 1, large_shrub: 2, tree: 3 };
        const sorted = [...plantMarkersRef.current].sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
        const blob = (px: number, py: number, r: number, seedN: number, lump = 0.22) => {
          const rr = seededRng(seedN), N = 10;
          ctx.beginPath();
          for (let k = 0; k < N; k++) {
            const a = (k / N) * Math.PI * 2;
            const rad = r * (1 - lump / 2 + rr() * lump);
            const x = px + Math.cos(a) * rad, y = py + Math.sin(a) * rad;
            if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.closePath();
        };
        const H_FT: Record<string, number> = { tree: 15, large_shrub: 6, shrub: 2.5, groundcover: 0 };
        const painted = [...sorted].sort((a, b) => ftToPxRef.current(a.x, a.y)[1] - ftToPxRef.current(b.x, b.y)[1] || (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
        const passes = [painted.filter(m => m.kind === 'groundcover'), painted.filter(m => m.kind !== 'groundcover')];
        for (const pass of passes) for (const mk of pass) {
          const [px, py] = ftToPxRef.current(mk.x, mk.y);
          const rPx = Math.max(mk.kind === 'groundcover' ? 2.5 : 4, mk.rFt * scaleRef.current);
          const seedN = (Math.abs(Math.round(mk.x * 73 + mk.y * 179)) | 0) + 1;
          const rr = seededRng(seedN + 7);
          const hPx = H_FT[mk.kind] * scaleRef.current * 0.75;
          if (mk.kind !== 'groundcover') {
            ctx.save(); ctx.globalAlpha = 0.1; ctx.beginPath();
            ctx.ellipse(px + rPx * 0.1, py + rPx * 0.06, rPx * 0.85, rPx * 0.32, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#33402A'; ctx.fill(); ctx.restore();
          }
          if (mk.kind === 'tree') {
            const cy2 = py - hPx;
            ctx.save(); ctx.strokeStyle = '#7A5B3E'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, rPx * 0.14);
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + rPx * 0.05, cy2 + rPx * 0.3); ctx.stroke(); ctx.restore();
            blob(px, cy2, rPx, seedN); ctx.fillStyle = '#AECB8E'; ctx.fill();
            ctx.lineWidth = 1.6; ctx.strokeStyle = '#7C9C5B'; ctx.stroke();
            blob(px - rPx * 0.22, cy2 - rPx * 0.22, rPx * 0.55, seedN + 3, 0.3); ctx.fillStyle = '#C7DCAC'; ctx.fill();
          } else if (mk.kind === 'groundcover') {
            blob(px, py, rPx, seedN, 0.3); ctx.fillStyle = '#B9CF9BB3'; ctx.fill();
            const dots = 4 + Math.floor(rr() * 3);
            for (let d = 0; d < dots; d++) {
              const a = rr() * Math.PI * 2, dist = rr() * rPx * 0.7;
              ctx.beginPath(); ctx.arc(px + Math.cos(a) * dist, py + Math.sin(a) * dist, Math.max(1, rPx * 0.18), 0, Math.PI * 2);
              ctx.fillStyle = mk.color; ctx.fill();
              ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(70,75,55,0.35)'; ctx.stroke();
            }
          } else {
            const cy2 = py - hPx * 0.55;
            blob(px, cy2, rPx, seedN); ctx.fillStyle = mk.kind === 'large_shrub' ? '#96B877' : '#A6C286'; ctx.fill();
            ctx.lineWidth = 1.1; ctx.strokeStyle = '#7C9C5B'; ctx.stroke();
            blob(px - rPx * 0.2, cy2 - rPx * 0.2, rPx * 0.5, seedN + 3, 0.3); ctx.fillStyle = '#C2D8A4'; ctx.fill();
            const blooms = mk.kind === 'large_shrub' ? 7 : 5;
            for (let d = 0; d < blooms; d++) {
              const a = rr() * Math.PI * 2, dist = (0.25 + rr() * 0.5) * rPx;
              ctx.beginPath(); ctx.arc(px + Math.cos(a) * dist, cy2 + Math.sin(a) * dist, Math.max(1.1, rPx * 0.13), 0, Math.PI * 2);
              ctx.fillStyle = mk.color; ctx.fill();
              ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(70,75,55,0.35)'; ctx.stroke();
            }
          }
        }
        ctx.restore();
      } else {
        // ── Plan view: colored-pencil drafting symbology (shared plan painter) ──
        paintPlantClusters(ctx, plantClustersRef.current, ftToPxRef.current, scaleRef.current, { highlightName: selSpeciesRef.current });
        ctx.restore();
      }
    }

    // Selected visual-interest plant → dashed selection ring + a move-handle badge (drag to reposition).
    if (illustrative && selPlantRef.current) {
      const pp = plantPositionsRef.current[selPlantRef.current];
      const slot = plantSlotsRef.current.find(s => s.id === selPlantRef.current);
      if (pp && slot) {
        const [px, py] = ftToPxRef.current(pp.x, pp.y);
        const rPx = Math.max(15, slot.r * scaleRef.current);
        ctx.save();
        ctx.beginPath(); ctx.arc(px, py, rPx + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#2A2A26'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.stroke();
        ctx.setLineDash([]);
        // Move badge above the plant with a 4-arrow glyph.
        const bx = px, by = py - rPx - 15;
        ctx.beginPath(); ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#2A2A26'; ctx.fill();
        ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const a = 5, h = 2.3;
        ctx.beginPath();
        ctx.moveTo(bx, by - a); ctx.lineTo(bx, by + a);
        ctx.moveTo(bx - a, by); ctx.lineTo(bx + a, by);
        ctx.moveTo(bx - h, by - a + h); ctx.lineTo(bx, by - a); ctx.lineTo(bx + h, by - a + h);
        ctx.moveTo(bx - h, by + a - h); ctx.lineTo(bx, by + a); ctx.lineTo(bx + h, by + a - h);
        ctx.moveTo(bx - a + h, by - h); ctx.lineTo(bx - a, by); ctx.lineTo(bx - a + h, by + h);
        ctx.moveTo(bx + a - h, by - h); ctx.lineTo(bx + a, by); ctx.lineTo(bx + a - h, by + h);
        ctx.stroke();
        ctx.restore();
      }
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

    // ── Existing-feature edit overlay (satellite editor) ──────────────────────────
    // The selected feature is drawn here (its read-only map polygon is hidden while selected) with
    // the live drag geometry, a highlighted outline, draggable vertex dots and a resize corner.
    if (!illustrative && selFeatRef.current) {
      const fd = featDragRef.current;
      const src = fd && fd.featId === selFeatRef.current
        ? { verts: fd.liveVerts, feat: featFtRef.current.find(f => f.id === selFeatRef.current) }
        : (() => { const f = featFtRef.current.find(f => f.id === selFeatRef.current); return f ? { verts: f.verts, feat: f } : null; })();
      if (src && src.verts.length >= 3) {
        const color = FEATURE_COLOR[src.feat?.type ?? ''] ?? '#9A9A92';
        const pxV = src.verts.map(v => ftToPxRef.current(v[0], v[1]));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pxV[0][0], pxV[0][1]);
        for (let i = 1; i < pxV.length; i++) ctx.lineTo(pxV[i][0], pxV[i][1]);
        ctx.closePath();
        ctx.fillStyle = color + '4D';
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        for (const [vx, vy] of pxV) {
          ctx.beginPath(); ctx.arc(vx, vy, 5, 0, Math.PI * 2);
          ctx.fillStyle = 'white'; ctx.fill();
          ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        }
        const maxX = Math.max(...pxV.map(p => p[0])), maxY = Math.max(...pxV.map(p => p[1]));
        ctx.fillStyle = 'white'; ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.rect(maxX + 2, maxY + 2, 14, 14); ctx.fill(); ctx.stroke();
        // Diagonal ticks to read as a resize grip, distinct from the round vertex dots.
        ctx.beginPath();
        ctx.moveTo(maxX + 5, maxY + 12); ctx.lineTo(maxX + 12, maxY + 5);
        ctx.moveTo(maxX + 8, maxY + 13); ctx.lineTo(maxX + 13, maxY + 8);
        ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
    }
  }, [cs, cssSize, sunMap, illustrative]);

  // Keep the sun-layer ref in sync (heatmap shows during the intro OR when toggled on) + redraw.
  useEffect(() => { draw(); }, [showSun, draw]);

  // Mirror the species highlight into its ref and repaint (draw reads the ref, like the sun layer).
  useEffect(() => { selSpeciesRef.current = selSpecies; draw(); }, [selSpecies, draw]);
  useEffect(() => { selPlantRef.current = selectedPlantId; draw(); }, [selectedPlantId, draw]);

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

  useEffect(() => { draw(); }, [draw, placedZones, selectedId, paths, selectedPathId, placedBeds, selectedBedId, selectedFeatureId, existing, boundaryFt, obstacleFt, mapAffine, illoXf, defaultVariant, privacyTargets, privacyPick]);

  // Persist the plan so the review screen (a separate route) can summarize and draw it.
  // We bake each shape's polygon ring (ft coords) so the review page can render a plan
  // view without re-implementing the shape/seed logic.
  useEffect(() => {
    try {
      const ring = (s: { shape: string; xFt: number; yFt: number; wFt: number; hFt: number; id: string; verts?: [number, number][] }) =>
        shapeRingFt(s.shape, s.xFt, s.yFt, s.wFt, s.hFt, s.id, s.verts);
      // Defensive dedupe: a plan should never persist two lawn zones (mirrors the guard in the
      // placedZones initializer above) — if one has snuck in mid-session, keep only the largest.
      const lawns = placedZones.filter(z => z.key === 'lawn');
      const zonesToPersist = lawns.length > 1
        ? placedZones.filter(z => z.key !== 'lawn' || z === lawns.reduce((a, b) => (a.wFt * a.hFt >= b.wFt * b.hFt ? a : b)))
        : placedZones;
      localStorage.setItem('diyPlacementPlan', JSON.stringify({
        zones: zonesToPersist.map(z => ({ ...z, ring: ring(z) })),
        beds:  placedBeds.map(b => ({ ...b, ring: ring(b) })),
        paths,
        focalSlots: focalSlotsRef.current,
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

  const featDragRef = useRef<{
    kind:      'move' | 'resize' | 'vertex';
    featId:    string;
    vertexIdx?: number;
    startMx:   number; startMy: number;
    origVerts: [number, number][];   // ft
    liveVerts: [number, number][];   // ft — updated during the drag, drawn by the overlay
    cxFt?:     number; cyFt?: number; d0?: number; // resize: centroid (ft) + start pointer dist (px)
  } | null>(null);

  const bedDragRef = useRef<{
    kind:      'move' | 'resize';
    bedId:     string;
    startMx:   number; startMy: number;
    origX:     number; origY:   number;
    origW:     number; origH:   number;
    origVerts?: [number, number][];
  } | null>(null);
  const plantDragRef = useRef<{ id: string } | null>(null); // dragging a selected visual-interest plant

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
      // Guided (illustrative) mode: ANY zone is hit-testable so a click can select it and open its
      // card. The edit HANDLES (rotate/resize/vertex/edge) below stay gated on `z.id === sel`, so a
      // non-active zone only ever yields a plain `move` (i.e. select) — never a stray handle grab.

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

  // Handles of the currently-selected existing feature (vertices + resize corner).
  const hitTestFeatureHandle = useCallback((mx: number, my: number) => {
    const sel = selFeatRef.current;
    if (!sel) return null;
    const f = featDragRef.current?.featId === sel && featDragRef.current
      ? { verts: featDragRef.current.liveVerts }
      : featFtRef.current.find(ft => ft.id === sel);
    if (!f || f.verts.length < 3) return null;
    const pxV = f.verts.map(v => ftToPxRef.current(v[0], v[1]));
    for (let i = 0; i < pxV.length; i++) {
      if (Math.hypot(mx - pxV[i][0], my - pxV[i][1]) <= 9) return { part: 'vertex' as const, vertexIdx: i };
    }
    // Resize corner sits just OUTSIDE the bbox bottom-right so it clears the SE vertex (which, for a
    // rectangle, lands exactly on the bbox corner and — being tested first — would otherwise shadow it).
    const maxX = Math.max(...pxV.map(p => p[0])), maxY = Math.max(...pxV.map(p => p[1]));
    if (Math.hypot(mx - (maxX + 9), my - (maxY + 9)) <= 11) return { part: 'resize' as const };
    return null;
  }, []);

  const hitTestFeature = useCallback((mx: number, my: number) => {
    const [xFt, yFt] = pxToFtRef.current(mx, my);
    const feats = featFtRef.current;
    for (let i = feats.length - 1; i >= 0; i--) {
      if (feats[i].verts.length >= 3 && ptInPoly(xFt, yFt, feats[i].verts)) return feats[i];
    }
    return null;
  }, []);

  // Nearest placed plant to a click, in feet space — the species name + layer of the slot the cursor
  // is over (within max(rFt, 2.5 ft)), else null. Used to spotlight a species from a click on the plan
  // (the layer says which sidebar plant-group to expand so its card renders and can scroll into view).
  const hitPlant = useCallback((mx: number, my: number): { id: string; name: string; layer: Layer; r: number } | null => {
    const [pfx, pfy] = pxToFtRef.current(mx, my);
    let best: { id: string; name: string; layer: Layer; r: number } | null = null, bestD = Infinity;
    for (const s of plantSlotsRef.current) {
      const pp = plantPositionsRef.current[s.id]; if (!pp) continue;
      const dd = Math.hypot(pp.x - pfx, pp.y - pfy);
      if (dd <= Math.max(s.r, 2.5) && dd < bestD) { bestD = dd; best = { id: s.id, name: s.name, layer: s.layer, r: s.r }; }
    }
    return best;
  }, []);

  const getPos = (e: React.MouseEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // One-at-a-time selection: clear EVERY on-map selection — feature zones, beds, detected features,
  // walkways, and the plant spotlight. Each selection branch below calls this first and then sets its
  // own, so selecting anything unselects everything else across all categories.
  const clearAllSelections = useCallback(() => {
    selRef.current = null; setSelectedId(null);
    selBedRef.current = null; setSelectedBedId(null);
    selFeatRef.current = null; setSelectedFeatureId(null);
    setSelectedPathId(null);
    setSelSpecies(null);
    selPlantRef.current = null; setSelectedPlantId(null);
  }, []);

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
          style: detailStyleRef.current, material: cm.id, widthFt: 2, kind: 'creek', color: cm.color,
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
        clearAllSelections();
        setSelectedPathId(p.id);
        return;
      }
    }

    // Existing-feature correction (satellite editor): grab a vertex or the resize corner of the
    // already-selected feature (top priority, so handles win over anything beneath them).
    if (!illustrative && selFeatRef.current) {
      const fh = hitTestFeatureHandle(mx, my);
      if (fh) {
        const f = featFtRef.current.find(ft => ft.id === selFeatRef.current);
        if (f) {
          const origVerts = f.verts.map(v => [...v] as [number, number]);
          if (fh.part === 'resize') {
            const cxFt = f.verts.reduce((s, v) => s + v[0], 0) / f.verts.length;
            const cyFt = f.verts.reduce((s, v) => s + v[1], 0) / f.verts.length;
            const [cpx, cpy] = ftToPxRef.current(cxFt, cyFt);
            featDragRef.current = { kind: 'resize', featId: f.id, startMx: mx, startMy: my, origVerts, liveVerts: origVerts, cxFt, cyFt, d0: Math.max(6, Math.hypot(mx - cpx, my - cpy)) };
          } else {
            featDragRef.current = { kind: 'vertex', featId: f.id, vertexIdx: fh.vertexIdx, startMx: mx, startMy: my, origVerts, liveVerts: origVerts };
          }
          return;
        }
      }
    }

    // The currently-selected bed or feature owns its own body + resize/rotate handles: if the pointer is
    // on the ALREADY-selected item, act on it before the plant spotlight can steal the click. Without
    // this, a plant marker overlapping your selected bed makes "move/resize" select the plant instead.
    // Only the selected item gets this priority; unselected items still yield to plants below.
    const grabSelBed = illustrative && selBedRef.current ? hitTestBed(mx, my) : null;
    if (grabSelBed && grabSelBed.bed.id === selBedRef.current) {
      bedDragRef.current = {
        kind: grabSelBed.part, bedId: grabSelBed.bed.id,
        startMx: mx, startMy: my,
        origX: grabSelBed.bed.xFt, origY: grabSelBed.bed.yFt,
        origW: grabSelBed.bed.wFt, origH: grabSelBed.bed.hFt,
        origVerts: grabSelBed.bed.verts ? [...grabSelBed.bed.verts] : undefined,
      };
      return;
    }
    // Same for a selected feature zone: if the pointer is on it, skip the plant check and fall through to
    // the zone-handling below (which starts the move/resize/vertex/rotate drag for that zone).
    const onSelZone = illustrative && selRef.current ? hitTest(mx, my) : null;
    const grabSelZone = !!onSelZone && onSelZone.zone.id === selRef.current;

    // Precedence, topmost first: a click landing directly on a placed plant marker jumps to the Plants
    // step and spotlights that species — from ANY step — and WINS over the feature zone / bed beneath it
    // (plants sit on top; hitPlant is a precise radius test, so a null result means the cursor wasn't on
    // a plant and we fall through to feature/bed selection).
    const plant = (illustrative && !grabSelZone) ? hitPlant(mx, my) : null;
    if (plant) {
      clearAllSelections();
      if (openStepRef.current !== 'plants') setOpenStep('plants');
      // Expand the sidebar plant-group that holds this layer, else its card stays collapsed (unmounted)
      // and can't be highlighted or scrolled to.
      const gi = PLANT_GROUPS.findIndex(g => g.layers.includes(plant.layer));
      if (gi >= 0) setPlantGroupOpen(gi);
      setSelSpecies(plant.name);
      pendingPlantScrollRef.current = plant.name;
      // Visual-interest plants (trees + large shrubs) are individually movable: select THIS instance and
      // arm a drag so the user can reposition it (e.g. off a utility). Other layers stay spotlight-only.
      if (plant.layer === 'tree' || plant.layer === 'large_shrub') {
        selPlantRef.current = plant.id; setSelectedPlantId(plant.id);
        plantDragRef.current = { id: plant.id };
      }
      return;
    }

    // Feature zones are selectable/editable. In the guided (illustrative) editor a click on a feature
    // from ANY step jumps to the Features step and opens that feature's card (the plant check above
    // already peeled off plant clicks, incl. on the plants step). In the satellite editor, only on the
    // features step.
    const featuresClickable = illustrative ? true : openStepRef.current === 'features';
    const hit = featuresClickable ? hitTest(mx, my) : null;
    if (!hit) {
      // Guided mode: keep the active feature selected (its selection is driven by the stepper);
      // clicking empty space shouldn't deselect it or grab a bed.
      if (illustrative && openStepRef.current === 'features') return;
      const bedHit = hitTestBed(mx, my);
      if (bedHit) {
        clearAllSelections();
        selBedRef.current = bedHit.bed.id; setSelectedBedId(bedHit.bed.id);
        bedDragRef.current = {
          kind: bedHit.part, bedId: bedHit.bed.id,
          startMx: mx, startMy: my,
          origX: bedHit.bed.xFt, origY: bedHit.bed.yFt,
          origW: bedHit.bed.wFt, origH: bedHit.bed.hFt,
          origVerts: bedHit.bed.verts ? [...bedHit.bed.verts] : undefined,
        };
        return;
      }
      // Existing detected feature (house/tree/hardscape): select it and start a move drag. Lower
      // priority than zones/beds so a placed feature on top still wins; above the plant spotlight.
      if (!illustrative) {
        const featHit = hitTestFeature(mx, my);
        if (featHit) {
          clearAllSelections();
          selFeatRef.current = featHit.id; setSelectedFeatureId(featHit.id);
          const origVerts = featHit.verts.map(v => [...v] as [number, number]);
          featDragRef.current = { kind: 'move', featId: featHit.id, startMx: mx, startMy: my, origVerts, liveVerts: origVerts };
          return;
        }
      }
      // Nothing geometric (zone/path/bed) and no plant was hit — clear every selection.
      clearAllSelections();
      return;
    }
    clearAllSelections();
    selRef.current = hit.zone.id;
    setSelectedId(hit.zone.id);
    // Open the Features step + expand this feature's card so it's editable in the sidebar.
    if (illustrative) {
      if (openStepRef.current !== 'features') setOpenStep('features');
      const gi = guideZonesRef.current.findIndex(z => z.id === hit.zone.id);
      if (gi >= 0) setGuideIdx(gi);
    }

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
  }, [hitTest, hitTestBed, hitTestFeature, hitTestFeatureHandle, hitPlant, clearAllSelections, pathDrawMode, pxToFt, buildPath, globalPathStyle, globalPathMaterial, draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my]  = getPos(e);

    // Live bed draw preview
    if (addingBedRef.current?.step === 'draw') {
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
      bedDrawCursorRef.current = pxToFtRef.current(mx, my);
      draw();
      return;
    }

    // Dragging a selected visual-interest plant → it follows the cursor (updates its placed position live).
    if (plantDragRef.current) {
      const id = plantDragRef.current.id;
      const [fx, fy] = pxToFtRef.current(mx, my);
      setPlantPositions(prev => ({ ...prev, [id]: { x: fx, y: fy } }));
      if (canvasRef.current) canvasRef.current.style.cursor = 'move';
      return;
    }

    // Correcting an existing feature (move / reshape a vertex / resize about its centre).
    const featDrag = featDragRef.current;
    if (featDrag) {
      if (featDrag.kind === 'move') {
        const d0 = pxToFtRef.current(featDrag.startMx, featDrag.startMy), d1 = pxToFtRef.current(mx, my);
        const dxFt = d1[0] - d0[0], dyFt = d1[1] - d0[1];
        featDrag.liveVerts = featDrag.origVerts.map(v => [v[0] + dxFt, v[1] + dyFt] as [number, number]);
      } else if (featDrag.kind === 'vertex') {
        const ptFt = pxToFtRef.current(mx, my);
        featDrag.liveVerts = featDrag.origVerts.map((v, i) => i === featDrag.vertexIdx ? ptFt : v);
      } else {
        const cx = featDrag.cxFt!, cy = featDrag.cyFt!;
        const [cpx, cpy] = ftToPxRef.current(cx, cy);
        const factor = Math.max(0.2, Math.hypot(mx - cpx, my - cpy) / (featDrag.d0 || 1));
        featDrag.liveVerts = featDrag.origVerts.map(v => [cx + (v[0] - cx) * factor, cy + (v[1] - cy) * factor] as [number, number]);
      }
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
          const featHandle = !illustrative && selFeatRef.current ? hitTestFeatureHandle(mx, my) : null;
          const hit = hitTest(mx, my);
          if (featHandle) {
            canvasRef.current.style.cursor = featHandle.part === 'resize' ? 'se-resize' : 'grab';
          } else if (hit) {
            canvasRef.current.style.cursor =
              hit.part === 'resize' ? 'se-resize' : hit.part === 'vertex' ? 'grab' : hit.part === 'edge' ? 'crosshair' : 'move';
          } else {
            const bedHit = hitTestBed(mx, my);
            canvasRef.current.style.cursor = bedHit
              ? bedHit.part === 'resize' ? 'se-resize' : 'move'
              : (!illustrative && hitTestFeature(mx, my)) ? 'move' : 'default';
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
  }, [hitTest, hitTestBed, hitTestFeature, hitTestFeatureHandle, illustrative, draw]);

  const handleMouseUp = useCallback(() => {
    if (addingBedRef.current?.step === 'draw') return; // finalised via onDoubleClick
    if (plantDragRef.current) {
      const movedId = plantDragRef.current.id;
      plantDragRef.current = null;
      // Remember this move (persisted) so it survives leaving and re-entering the editor.
      const movedPos = plantPositionsRef.current[movedId];
      if (movedPos) { plantOverridesRef.current = { ...plantOverridesRef.current, [movedId]: movedPos }; persistPlantOverrides(); }
      // Re-flow the plan around the moved plant: pin every placed tree/large-shrub at its current spot
      // (incl. this one at its new position) and let the understory re-place around them.
      const fixed: Record<string, { x: number; y: number }> = {};
      for (const s of plantSlotsRef.current) {
        if (s.layer === 'tree' || s.layer === 'large_shrub') { const p = plantPositionsRef.current[s.id]; if (p) fixed[s.id] = p; }
      }
      runPlacementRef.current(fixed);
      return;
    }
    if (featDragRef.current) {
      const fd = featDragRef.current;
      featDragRef.current = null;
      const csNow = csRef.current;
      if (csNow) {
        commitExisting(existingRef.current.map(f =>
          f.id === fd.featId ? { ...f, vertices: fd.liveVerts.map(v => csNow.toLngLat(v[0], v[1]) as [number, number]) } : f));
      }
      return;
    }
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
  }, [generatePathPts, commitExisting]);

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

    const { type = 'planted', material = 'mulch', variant, accent } = addingBedRef.current!;
    const bedNum = bedsRef.current.filter(b => b.material !== 'lawn').length + 1;
    const newBed: PlacedBed = {
      id:    `${accent ? 'det_bed' : 'bed'}_${Date.now()}`,   // det_bed → shows in the Accent beds list
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

  // Tour context: reveal the sun layer on the sun step, and open the sidebar section each step
  // describes so the controls it talks about are visible beside the card.
  useEffect(() => {
    if (onboardIdx < 0) return;
    const step = ONBOARD_STEPS[onboardIdx];
    setShowSun(step.key === 'sun');
    if (step.sidebarStep) setOpenStep(step.sidebarStep);
  }, [onboardIdx]);

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

  // Visible steps. Illustrative accordion = features (incl. lawn) → details (incl. ground cover)
  // → plants; the primary ground cover is defaulted by style, so 'materials' is no longer a step.
  const visibleSteps = useMemo<StepId[]>(() => [
    'features',
    ...(illustrative ? [] : ['walkways' as StepId, 'materials' as StepId]),
    ...(illustrative ? ['details' as StepId, 'plants' as StepId] : []),
    ...(wantsPrivacy ? ['privacy' as StepId] : []),
  ], [wantsPrivacy, illustrative]);

  // ── Lawn amount (features accordion) ─────────────────────────────────────────
  // Defaulted by style + yard side at preferences; adjustable here. Changing it re-derives ONLY the
  // lawn zone from the rule engine — the user's feature edits stay put (the fresh lawn is sited
  // against the default layout, so small overlaps are possible and remain editable).
  const applyLawnTarget = useCallback((v: number, shape?: ZoneShape) => {
    try {
      const p = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      p.lawnTarget = v;
      localStorage.setItem('userPreferences', JSON.stringify(p));
    } catch { /* ignore */ }
    if (v === 0) { setPlacedZones(prev => prev.filter(z => z.key !== 'lawn')); return; }
    try {
      const saved2 = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      const prefs2 = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      const door2 = (() => { try { return JSON.parse(localStorage.getItem('diyDoorPoint') || 'null') || undefined; } catch { return undefined; } })();
      const yard2 = (() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').yard_type || undefined; } catch { return undefined; } })();
      const fresh = generateLayout({ boundary: saved2.boundary || [], existing: saved2.confirmedFeatures || [], prefs: prefs2, seed: 1, door: door2, sun: sunMap, yardType: yard2 });
      const lawn0 = fresh?.zones.find(z => z.key === 'lawn');
      const lawn = lawn0 && shape ? { ...lawn0, shape } : lawn0;
      setPlacedZones(prev => {
        const rest = prev.filter(z => z.key !== 'lawn');
        return lawn ? [lawn as any, ...rest] : rest;
      });
    } catch { /* keep current lawn */ }
  }, [sunMap]);

  const getNextStep = useCallback((from: StepId): StepId | null => {
    const idx = visibleSteps.indexOf(from);
    return idx >= 0 && idx + 1 < visibleSteps.length ? visibleSteps[idx + 1] : null;
  }, [visibleSteps]);

  const advanceToNext = useCallback((from: StepId) => {
    setDoneSteps(prev => new Set([...prev, from]));
    setOpenStep(getNextStep(from));
  }, [getNextStep]);

  const isDoneStep = (id: StepId) => doneSteps.has(id);

  // Open primary-ground area (boundary − structures − features − beds − walkways). Declared here so
  // the plant engine below can consume it directly from state (reading the persisted plan from
  // localStorage was stale-by-one-render: the persist effect runs AFTER memos read).
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

  // ── Plant selection (ported from /plant-options) — species picked & placed for the open ground ──
  const dbStyle = useMemo(() => mapStyle(prefs.style || ''), [prefs]);
  const shade = useMemo(() => Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('shade'), [prefs]);
  const speciesBudget = STYLE_TOTAL_SPECIES[dbStyle];
  // Explicit per-layer species targets (user-tuned: foundation carries the variety — the old
  // percentage split gave it only ~4 species; see LAYER_SPECIES_TARGET in plantSelectionService).
  const speciesShares = LAYER_SPECIES_TARGET[dbStyle]; // [tree, large_shrub, shrub, groundcover]

  const [treeSel, setTreeSel] = useState<TreeSelection | null>(null);
  const [layerSel, setLayerSel] = useState<Record<'large_shrub' | 'shrub' | 'groundcover', LayerSelection | null>>({ large_shrub: null, shrub: null, groundcover: null });
  const [picks, setPicks] = useState<Record<Layer, SpeciesCandidate[]>>({ tree: [], large_shrub: [], shrub: [], groundcover: [] });
  const [plantsLoaded, setPlantsLoaded] = useState(false);
  const [plantsErr, setPlantsErr] = useState(false);
  const [plantGroupOpen, setPlantGroupOpen] = useState(0); // which plant-type group is expanded
  const [groundOpen, setGroundOpen] = useState(false);     // Primary-groundcover card collapsed by default (like features)
  const [swapTarget, setSwapTarget] = useState<{ layer: Layer; idx: number } | null>(null); // open swap popup
  const [swapPage, setSwapPage] = useState(0); // paged 8-at-a-time in the swap grid
  useEffect(() => { setSwapPage(0); }, [swapTarget]); // reset paging each time the popup opens
  const [plantDensity, setPlantDensity] = useState(1);     // 0.5 sparse → 1.5 lush; scales the understory fill
  const plantMarkersRef = useRef<PlantMarker[]>([]);
  // Connected same-species scallop masses. Recomputed only when the plant set changes (regenerate /
  // swap), NOT per drag frame — the O(n²) clustering is memoised here via the markers effect below.
  const plantClustersRef = useRef<PlantCluster[]>([]);

  // Sun category at a feet position, from the sun map (full ≥6 hrs, part 4–6 hrs, else shade).
  // 0.72 matches the "full sun" threshold used by the sun stat/legend — keep them in lockstep.
  const sunCatAt = useCallback((x: number, y: number): SunCat => {
    if (!sunMap) return 'full';
    const v = sampleSun(sunMap, x, y);
    return v >= 0.72 ? 'full' : v >= 0.45 ? 'part' : 'shade';
  }, [sunMap]);

  // Fraction of the open planting ground in each sun category (grid-sampled inside the boundary,
  // excluding features / structures / beds). Drives species variety + how many go in each region.
  // Plantable ground AREA + sun-region SHARES, from the ONE shared rule placePlan uses (plantableStats,
  // over the same shapeRingFt-baked features the plan persists). The "plan is ready" preview measures the
  // yard the identical way off the same persisted plan — so the editor can reproduce the stored plan
  // exactly instead of generating a different one. Feeds the plant budgets (plantable) + sun distribution.
  const plantStats = useMemo(() => {
    const bake = (s: any): [number, number][] | null => { try { return shapeRingFt(s.shape, s.xFt, s.yFt, s.wFt, s.hFt, s.id, s.verts, s.rot); } catch { return null; } };
    const zones = placedZones.filter(z => z.verts || (z.wFt > 0 && z.hFt > 0)).map(z => ({ ring: bake(z) })).filter(z => z.ring);
    const beds = placedBeds.map(b => ({ ring: bake(b), material: b.material, type: b.type })).filter(b => b.ring);
    return plantableStats({ boundary, existing, plan: { zones, beds, paths }, sunAt: sunMap ? sunCatAt : undefined });
  }, [boundary, existing, placedZones, placedBeds, paths, sunMap, sunCatAt]);
  const sunAreaPct = plantStats.sunShares;
  const sunAreaPctRef = useRef(sunAreaPct);
  useEffect(() => { sunAreaPctRef.current = sunAreaPct; }, [sunAreaPct]);

  // Sun regions actually present in the open ground (≥8% of it) — the selection buckets.
  const presentCats = useMemo<SunCat[]>(() => sunAreaPct ? SUN_CATS.filter(c => sunAreaPct[c] >= 0.08) : (['full', 'part'] as SunCat[]), [sunAreaPct]);

  // ── Capacity-first: open-pocket radii per sun region + 'any' union ──────────────────────────
  // Measured from the SAME plantable rule placePlan uses (shared builder in the service), so the
  // two can never disagree. Selection gates structural species on this so a species that provably
  // can't fit any pocket is never picked — making the old "couldn't fit" warning unrepresentable.
  const plantPockets = useMemo<PlantCapacity | null>(() => {
    if (boundaryFt.length < 3) return null;
    const zonesR: any[] = [];
    for (const z of placedZones) if (z.verts || (z.wFt > 0 && z.hFt > 0)) { try { zonesR.push({ ring: shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot) }); } catch { /* skip */ } }
    const bedsR: any[] = [];
    for (const b of placedBeds) { try { bedsR.push({ ring: shapeRingFt(b.shape, b.xFt, b.yFt, b.wFt, b.hFt, b.id, b.verts), material: b.material, type: b.type }); } catch { /* skip */ } }
    return plantCapacity({ boundary, existing, plan: { zones: zonesR, beds: bedsR, paths }, sunAt: sunMap ? sunCatAt : undefined });
  }, [boundary, existing, boundaryFt, placedZones, placedBeds, paths, sunMap, sunCatAt]);
  const plantPocketsRef = useRef(plantPockets);
  useEffect(() => { plantPocketsRef.current = plantPockets; }, [plantPockets]);

  // Select species once (async DB + hardiness zone), seeding the per-layer picks from the budget.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let zone: number | undefined;
        if (typeof siteContext.lat === 'number' && typeof siteContext.lng === 'number') { try { zone = (await fetchHardinessZone(siteContext.lat, siteContext.lng))?.zone_number; } catch { /* no zone */ } }
        const plan = (() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } })();
        const ps = prefs.style || '';
        const pockets = plantPocketsRef.current;
        const [ts, ls, ms, gc] = await Promise.all([
          selectTrees({ prefsStyle: ps, boundary, existing, projectAreaFt: plan.projectAreaFt, zone, coverageGoal: shade ? SHADE_CANOPY_COVERAGE_GOAL : TREE_CANOPY_COVERAGE_GOAL, capacity: pockets ?? undefined, yardType }),
          selectLayer('large_shrub', { prefsStyle: ps, zone }),
          selectLayer('shrub', { prefsStyle: ps, zone }),
          selectLayer('groundcover', { prefsStyle: ps, zone }),
        ]);
        if (!live) return;
        setTreeSel(ts);
        setLayerSel({ large_shrub: ls, shrub: ms, groundcover: gc });
        // FIX A (monoculture): seed picks so each sun REGION gets variety proportional to its AREA
        // share — not just the old "≥1 compatible species per present category". Screenshot bug: a
        // yard whose dominant sun condition was ~90% of the ground had 5 shrub species picked but
        // only 1 was compatible with that condition, so that 1 blanketed the entire understory. Now
        // the dominant region receives a proportional slice of the budget from its best compatible
        // species, then we top up by ranked order.
        const areaPct = sunAreaPctRef.current;
        const presentCats = areaPct ? SUN_CATS.filter(c => areaPct[c] >= 0.08) : (['full', 'part'] as SunCat[]);
        // Capacity-first (mirrors draftPlants): structural picks (large shrubs) CONSUME a pocket per
        // chosen species from a shared working copy — a species with no remaining pocket in its region
        // is skipped before it can ever produce an unplaceable slot. Understory gets only a cheap
        // sanity screen. Absent capacity → behaves exactly as before.
        const capWork = pockets ? cloneCapacity(pockets) : null;
        // grassCap: max ornamental-grass species allowed (foundation layer) so a grass-heavy modern
        // pool doesn't fill the whole layer with grasses. A final uncapped pass still fills the budget
        // if grasses are all that's left (better a grass than an empty slot).
        const seed = (cands: SpeciesCandidate[], count: number, structural: boolean, grassCap = Infinity): SpeciesCandidate[] => {
          if (count <= 0) return [];
          const chosen: SpeciesCandidate[] = [], used = new Set<number>();
          const isGrass = (c: SpeciesCandidate) => c.type === 'ornamental grass';
          let grasses = 0;
          // Per-category weight = its area share (equal weight if no sun map). Allocate the species
          // budget across regions proportionally, then serve the biggest region first.
          const weights = presentCats.map(cat => (areaPct ? Math.max(0, areaPct[cat]) : 1));
          const quota = allocateProportional(Math.min(count, cands.length), weights);
          const order = presentCats
            .map((cat, i) => ({ cat, q: quota[i], w: weights[i], i }))
            .sort((a, b) => (b.w - a.w) || (a.i - b.i));
          let carry = 0; // unmet quota from a thin compatible pool, rolled to the next-biggest region
          for (const { cat, q } of order) {
            let need = q + carry;
            for (const c of cands) {
              if (need <= 0) break;
              if (used.has(c.id) || !plantSunCats(c.sun_requirement).includes(cat)) continue;
              if (isGrass(c) && grasses >= grassCap) continue; // hold grasses back for a mixed layer
              if (capWork) {
                const r = c.matureWidthFt / 2;
                if (structural) { if (!consumePocket(capWork[cat], r)) continue; }  // no pocket left → skip
                else if (!pocketFits(pockets![cat], r)) continue;                    // sanity screen only
              }
              chosen.push(c); used.add(c.id); need--; if (isGrass(c)) grasses++;
            }
            carry = Math.max(0, need); // thin data here → its remainder redistributes to the next region
          }
          // Top up to the budget from the best remaining ranked candidates (category-agnostic) —
          // preserves the original "always try to fill the species budget" guarantee, still gated.
          const topUp = (respectCap: boolean) => {
            for (const c of cands) {
              if (chosen.length >= count) break;
              if (used.has(c.id)) continue;
              if (respectCap && isGrass(c) && grasses >= grassCap) continue;
              if (capWork) {
                const r = c.matureWidthFt / 2;
                if (structural) { if (!consumePocket(capWork.any, r)) continue; }
                else if (!pocketFits(pockets!.any, r)) continue;
              }
              chosen.push(c); used.add(c.id); if (isGrass(c)) grasses++;
            }
          };
          topUp(true);   // prefer non-grass fills
          topUp(false);  // …but fill the budget with grasses rather than leave the layer short
          return chosen;
        };
        // HYDRATE vs GENERATE. If the "plan is ready" step already picked species for THIS plan (its
        // signature matches the current plan), surface those exact picks instead of re-selecting — so the
        // preview and the editor show the same plan. The selection above still ran (its candidate pools
        // feed the swap menus). Only when there's no matching stored plan do we generate fresh.
        const storedPicks = (() => {
          try {
            const sig = localStorage.getItem('diyPlantPicksSig') || '';
            if (!sig || sig !== (localStorage.getItem('diyPlacementPlanSig') || '')) return null;
            const p = JSON.parse(localStorage.getItem('diyPlantPicks') || 'null');
            if (p && ['tree', 'large_shrub', 'shrub', 'groundcover'].every(k => Array.isArray(p[k]))) return p as Record<Layer, SpeciesCandidate[]>;
          } catch { /* fall through to generate */ }
          return null;
        })();
        if (storedPicks) {
          autoSubstRef.current = false; // stored picks are already final (substitution ran when generated)
          setPicks(storedPicks);
        } else {
          // Arm the structural self-correction loop for this fresh (auto) generation.
          autoSubstRef.current = true; substIterRef.current = 0; substTriedRef.current = new Set();
          setPicks({
            tree: ts.candidates.slice(0, Math.min(ts.candidates.length, ts.targetToPlant === 0 ? 0 : Math.max(1, Math.min(speciesShares[0], ts.targetToPlant)))),
            // No grass cap here: narrow upright grasses now read as focals via clumping (see plantSlots),
            // so capping them would fight that. The width-sort in selectLayer still leads with broad species.
            large_shrub: seed(ls.candidates, Math.min(ls.candidates.length, speciesShares[1]), true),
            shrub: seed(ms.candidates, Math.min(ms.candidates.length, speciesShares[2]), false, Math.ceil(Math.min(ms.candidates.length, speciesShares[2]) / 2)),
            groundcover: seed(gc.candidates, Math.min(gc.candidates.length, speciesShares[3]), false),
          });
        }
        setPlantsLoaded(true);
      } catch { if (live) setPlantsErr(true); }
    })();
    return () => { live = false; };
  }, [prefs, speciesShares, shade, boundary, existing, siteContext]);

  const poolFor = (l: Layer): SpeciesCandidate[] => l === 'tree' ? (treeSel?.candidates || []) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.candidates || []);
  const styleMatchedFor = (l: Layer): number => l === 'tree' ? (treeSel?.styleMatched ?? 0) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.styleMatched ?? 0);
  const plantTotalSpecies = LAYER_ORDER.reduce((s, l) => s + picks[l].length, 0);
  const plantsAtMax = plantTotalSpecies >= speciesBudget.max;

  // Structural space budget — trees + large shrubs compete for open planting ground. Uses the shared
  // plantableStats measure (above) so the editor and the "plan is ready" preview agree on the yard's size.
  const plantable = plantStats.plantableFt;
  const usableGround = plantable * PLANT_PACKING_EFFICIENCY;
  const hasPlantSpace = plantable > 0;
  const treeAvgFoot = picks.tree.length ? picks.tree.reduce((s, t) => s + canopyFootprintFt(t.matureWidthFt), 0) / picks.tree.length : 0;
  const consumedTrees = treeSel ? treeSel.targetToPlant * treeAvgFoot : 0;
  const consumedLarge = picks.large_shrub.reduce((s, c) => s + LAYER_QTY_PER_SPECIES.large_shrub * canopyFootprintFt(c.matureWidthFt), 0);
  const structuralRoom = usableGround - consumedTrees - consumedLarge;
  const avgLargeFoot = (() => { const pool = poolFor('large_shrub'); return pool.length ? pool.reduce((s, c) => s + canopyFootprintFt(c.matureWidthFt), 0) / pool.length : canopyFootprintFt(8); })();
  const canAddLarge = !hasPlantSpace || (structuralRoom - LAYER_QTY_PER_SPECIES.large_shrub * avgLargeFoot >= 0);

  // ── Capacity gating for the UI (swap / add) ─────────────────────────────────────────────────
  // Never offer a species the yard can't actually fit. A structural candidate is eligible only when
  // a pocket for its mature footprint remains after the CURRENTLY-PLACED structural species have
  // claimed theirs. (References placedPicks, defined below — only ever called from render/handlers.)
  const structuralLayer = (l: Layer) => l === 'tree' || l === 'large_shrub';
  const speciesFitsCapacity = (l: Layer, sp: SpeciesCandidate, cap: PlantCapacity | null): boolean => {
    if (!cap) return true;
    const r = sp.matureWidthFt / 2;
    if (l === 'tree') return pocketFits(cap.any, r);
    if (l === 'large_shrub') {
      const cats = presentCats.filter(c => plantSunCats(sp.sun_requirement).includes(c));
      return cats.some(c => pocketFits(cap[c], r)) || pocketFits(cap.any, r);
    }
    return true; // understory has no structural failure mode
  };
  // Pockets left after every placed structural species consumes one (best-fit in its region); pass
  // an id to leave that species' pocket un-consumed (used when swapping it out).
  const remainingCapacity = (excludeId?: number): PlantCapacity | null => {
    if (!plantPockets) return null;
    const cap = cloneCapacity(plantPockets);
    for (const sp of placedPicks.tree) if (sp.id !== excludeId) consumePocket(cap.any, sp.matureWidthFt / 2);
    for (const sp of placedPicks.large_shrub) if (sp.id !== excludeId) {
      const r = sp.matureWidthFt / 2;
      const cats = presentCats.filter(c => plantSunCats(sp.sun_requirement).includes(c));
      if (!cats.some(c => consumePocket(cap[c], r))) consumePocket(cap.any, r);
    }
    return cap;
  };

  // Swap the pick at [layer][idx] for a specific alternative chosen from the popup.
  const applySwap = (l: Layer, idx: number, next: SpeciesCandidate) => {
    setPicks(prev => { const copy = [...prev[l]]; copy[idx] = next; return { ...prev, [l]: copy }; });
    setSwapTarget(null);
  };
  // Trees are optional, so their X may remove the last one (→ zero trees); other layers keep ≥1.
  const removePick = (l: Layer, idx: number) => setPicks(prev => (prev[l].length <= 1 && l !== 'tree') ? prev : { ...prev, [l]: prev[l].filter((_, i) => i !== idx) });
  const addPick = (l: Layer) => setPicks(prev => {
    const pool = poolFor(l), shown = new Set(prev[l].map(c => c.id));
    const cap = structuralLayer(l) ? remainingCapacity() : null;
    const next = pool.find(c => !shown.has(c.id) && speciesFitsCapacity(l, c, cap));
    return next ? { ...prev, [l]: [...prev[l], next] } : prev;
  });
  const canAddLayer = (l: Layer) => {
    if (plantsAtMax || picks[l].length >= poolFor(l).length) return false;
    if (l === 'large_shrub' && !canAddLarge) return false;
    if (structuralLayer(l)) {
      const cap = remainingCapacity();
      const shown = new Set(picks[l].map(c => c.id));
      if (!poolFor(l).some(c => !shown.has(c.id) && speciesFitsCapacity(l, c, cap))) return false;
    }
    return true;
  };
  const layerRight = (l: Layer): string => {
    if (l === 'tree' && treeSel) {
      if (treeSel.targetToPlant === 0) return placedPicks.tree.length ? `${placedPicks.tree.length} selected (override)` : 'None recommended';
      return `Aim for ${treeSel.targetToPlant} new ${treeSel.targetToPlant === 1 ? 'tree' : 'trees'}${treeSel.existingCounted ? ` · ${treeSel.existingCounted} existing` : ''}${shade ? ' · shade priority' : ''}`;
    }
    return `${placedPicks[l].length} selected`;
  };

  // Plant instances (trees as individuals; shrubs/groundcover as drifts filling a share of the ground).
  // The instance-building rules live in the SHARED buildPlantSlots so the "plan is ready" preview
  // (draftPlants) and this editor produce the identical plan — see services/plantSlots.ts.
  const plantSlots = useMemo<PlantSlot[]>(() => buildPlantSlots({
    picks,
    treeTargetToPlant: treeSel?.targetToPlant ?? 0,
    plantableFt: plantable,
    catAreaPct: sunAreaPct,
    densityCoverage: densityParams(plantDensity).coverage,
  }), [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover, treeSel, plantable, sunAreaPct, plantDensity]);

  const [plantPositions, setPlantPositions] = useState<Record<string, { x: number; y: number }>>({});
  const plantPositionsRef = useRef(plantPositions);
  useEffect(() => { plantPositionsRef.current = plantPositions; }, [plantPositions]);
  // Manual plant-move overrides (slot id → position), so a dragged visual-interest plant STAYS where the
  // user put it across re-entry. Seeded from localStorage only when its signature matches the current
  // plan (a regenerate invalidates them). Merged into `fixed` at placement so the placer honours them.
  const plantOverridesRef = useRef<Record<string, { x: number; y: number }>>((() => {
    try {
      const sig = localStorage.getItem('diyPlantOverridesSig') || '';
      if (sig && sig === (localStorage.getItem('diyPlacementPlanSig') || '')) {
        const o = JSON.parse(localStorage.getItem('diyPlantOverrides') || '{}');
        if (o && typeof o === 'object') return o as Record<string, { x: number; y: number }>;
      }
    } catch { /* ignore */ }
    return {};
  })());
  const persistPlantOverrides = useCallback(() => {
    try {
      localStorage.setItem('diyPlantOverrides', JSON.stringify(plantOverridesRef.current));
      localStorage.setItem('diyPlantOverridesSig', localStorage.getItem('diyPlacementPlanSig') || '');
    } catch { /* quota */ }
  }, []);
  useEffect(() => { plantSlotsRef.current = plantSlots; }, [plantSlots]); // keep the click hit-test slots fresh
  // The plantSlots reference the CURRENT plantPositions were computed for. Placement runs in the
  // effect below (after render), so between a slot-set change and that effect this ref still points
  // at the OLD slots — letting the UI tell "placement settled" from "placement still pending".
  const placedSlotsRef = useRef<PlantSlot[] | null>(null);

  // ── Iterative select-then-place self-correction (structural layers only) ──────────────────────
  // After the AUTO selection places, any tree / large-shrub species that ended with ZERO placed
  // instances (too big to legally fit — the Smooth-Sumac bug) is swapped for the smallest still-
  // untried, sun-compatible candidate from that layer's pool, or DROPPED if the pool is exhausted —
  // then re-placed. Bounded to MAX_SUBST_ITERS deterministic passes. Only runs for auto generation:
  // a user's manual swap / add leaves autoSubstRef false, so their explicit choice is never
  // overridden. Realised as a bounded reactive loop (setPicks → re-slot → re-place → re-check) so it
  // is robust to the late-settling plantable / sun-area memos, converging before the user interacts.
  const MAX_SUBST_ITERS = 3;
  const autoSubstRef = useRef(false);          // is an auto self-correction pass allowed right now?
  const substIterRef = useRef(0);              // passes spent this generation
  const substTriedRef = useRef<Set<number>>(new Set()); // candidate ids already tried & failed this generation
  // Run placement with a GIVEN set of fixed positions, then commit. Shared by the slot-change effect
  // (pins every already-placed instance so edits don't re-shuffle the plan) and the plant-move handler
  // (pins only the structural plants, so the understory re-flows around a dragged tree/large shrub).
  const runPlacement = useCallback((fixed: Record<string, { x: number; y: number }>) => {
    if (!plantSlots.length) { placedSlotsRef.current = plantSlots; setPlantPositions({}); return; }
    const plan = (() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } })();
    const raw = placePlan({ boundary, existing, plan: { zones: plan.zones || [], beds: plan.beds || [], paths: plan.paths || [] }, instances: plantSlots.map(s => ({ id: s.id, layer: s.layer, r: s.r, under: s.under, drift: s.drift, tall: s.tall, sun: s.sun, name: s.name, type: s.type })), fixed, sunAt: sunMap ? sunCatAt : undefined, focalSlots: focalSlotsRef.current.length ? focalSlotsRef.current : undefined, packing: densityParams(plantDensity).packing, massing: dbStyle === 'modern' ? 'row' : undefined });
    // HARD RULE: reject any placed plant whose full mature footprint overlaps a feature (zone pad,
    // path corridor, or house/structure/hardscape). placePlan already avoids these, but this is the
    // authoritative guard — it also catches zones that reached the engine without a baked ring.
    const obstacleRings: Ring[] = cs
      ? existing.filter(f => f.keep && (f.type === 'house' || f.type === 'structure' || f.type === 'hardscape') && (f.vertices?.length ?? 0) >= 3)
          .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring)
      : [];
    const clearOf = makePlantClearance(plan.zones || [], plan.paths || [], obstacleRings);
    const rById = new Map(plantSlots.map(s => [s.id, s.r]));
    const clean: Record<string, { x: number; y: number }> = {};
    for (const id in raw) { const p = raw[id]; if (clearOf(p.x, p.y, rById.get(id) ?? 0)) clean[id] = p; }
    // Understory must not hide UNDER a large shrub (they share the ground plane). Drop any understory
    // instance whose centre falls inside a placed non-underplanting large-shrub canopy.
    const bigShrubs = plantSlots
      .filter(s => s.layer === 'large_shrub' && !s.under && clean[s.id])
      .map(s => ({ x: clean[s.id].x, y: clean[s.id].y, r: s.r }));
    if (bigShrubs.length) {
      for (const s of plantSlots) {
        if (s.layer !== 'shrub' && s.layer !== 'groundcover') continue;
        const p = clean[s.id]; if (!p) continue;
        if (bigShrubs.some(b => Math.hypot(p.x - b.x, p.y - b.y) < b.r)) delete clean[s.id];
      }
    }
    placedSlotsRef.current = plantSlots; // these positions correspond to THIS slot set
    setPlantPositions(clean);
  }, [plantSlots, boundary, existing, cs, sunMap, sunCatAt, plantDensity, dbStyle]);
  const runPlacementRef = useRef(runPlacement);
  useEffect(() => { runPlacementRef.current = runPlacement; }, [runPlacement]);

  // Auto-place whenever the slot set changes, pinning every already-placed instance so edits (swap/add/
  // density) don't re-shuffle the whole plan.
  useEffect(() => {
    if (!plantsLoaded) return;
    const fixed: Record<string, { x: number; y: number }> = {};
    for (const s of plantSlots) {
      // Prefer a live position; else a persisted manual override (so a re-entry restores dragged plants).
      if (plantPositionsRef.current[s.id]) fixed[s.id] = plantPositionsRef.current[s.id];
      else if (plantOverridesRef.current[s.id]) fixed[s.id] = plantOverridesRef.current[s.id];
    }
    runPlacement(fixed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantSlots, plantsLoaded, boundary, existing, wantsPrivacy, sunMap, sunCatAt]);

  // Structural self-correction pass — see autoSubstRef above. Runs ONLY after placement has settled
  // for the current slot set, so it reads truthful placed/unplaced counts. Each pass swaps every
  // structural species that placed ZERO instances for the smallest untried sun-compatible substitute
  // (or drops it), then setPicks re-triggers slot-building + placement and this effect fires again —
  // a bounded, deterministic loop (no randomness) that stops on convergence or MAX_SUBST_ITERS.
  useEffect(() => {
    if (!autoSubstRef.current || !plantsLoaded) return;
    if (placedSlotsRef.current !== plantSlots) return;         // wait for placement of THIS slot set
    if (substIterRef.current >= MAX_SUBST_ITERS) { autoSubstRef.current = false; return; }

    let changed = false;
    const nextPicks: Record<Layer, SpeciesCandidate[]> = { ...picks };
    for (const layer of (['tree', 'large_shrub'] as Layer[])) {
      // Per picked species in this layer: the sun regions its slots were assigned + whether ANY placed.
      const info = new Map<string, { cats: Set<SunCat>; placed: boolean }>();
      for (const s of plantSlots) {
        if (s.layer !== layer) continue;
        let e = info.get(s.name); if (!e) { e = { cats: new Set(), placed: false }; info.set(s.name, e); }
        (s.sun || []).forEach(c => e!.cats.add(c));
        if (plantPositions[s.id]) e.placed = true;
      }
      const pool = poolFor(layer);
      const next: SpeciesCandidate[] = [];
      for (const sp of picks[layer]) {
        const name = sp.common_name || sp.botanical_name, e = info.get(name);
        if (!e || e.placed) { next.push(sp); continue; } // got no slot (budget) or placed fine → keep
        substTriedRef.current.add(sp.id);
        const exclude = new Set<number>([...picks[layer].map(c => c.id), ...substTriedRef.current]);
        // Smallest untried candidate that is sun-compatible with the region(s) the failed species held.
        const sub = pool
          .filter(c => !exclude.has(c.id))
          .filter(c => e.cats.size === 0 || plantSunCats(c.sun_requirement).some(cat => e.cats.has(cat as SunCat)))
          .sort((a, b) => (a.matureWidthFt - b.matureWidthFt) || (a.id - b.id))[0];
        if (sub) next.push(sub);          // substitute smaller species
        // else: drop entirely (no push) rather than leave a phantom "selected but unplaceable" entry
        changed = true;
      }
      nextPicks[layer] = next;
    }
    substIterRef.current++;
    if (changed) setPicks(nextPicks);
    else autoSubstRef.current = false; // converged: every structural pick now places (or is over-budget)
  }, [plantPositions, plantSlots, plantsLoaded, picks]);

  // Distinct colour per species (greens), matching the old plant page.
  // Species colour = its DB bloom colour, translated to our palette (unique shade per species).
  const plantSpeciesColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) {
      const name = sp.common_name || sp.botanical_name;
      if (!m.has(name)) m.set(name, bloomColorFor((sp as any).color, name));
    }
    return m;
  }, [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover]);

  // Which selected species actually landed ≥1 placed instance, and whether the pipeline has fully
  // SETTLED — placement finished for the current slot set AND the structural substitution loop is no
  // longer running. The panel renders ONLY placed species (placedPicks below), so a "couldn't fit"
  // disagreement between selection and the plan is unrepresentable — no warning is ever shown.
  const placedSpeciesNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of plantSlots) if (plantPositions[s.id]) set.add(s.name);
    return set;
  }, [plantSlots, plantPositions]);
  const placementSettled = plantsLoaded && placedSlotsRef.current === plantSlots && !autoSubstRef.current;

  // ── List-as-output ──────────────────────────────────────────────────────────────────────────
  // The "Choose your plants" panel renders ONLY species with ≥1 placed instance (the OUTPUT), not
  // the internal `picks` working set (an INPUT the substitution loop mutates). Held stable during
  // placement + substitution churn: while not settled we keep showing the LAST settled list rather
  // than flicker through mid-churn states. Join is by species name → placed slot name.
  const [placedPicks, setPlacedPicks] = useState<Record<Layer, SpeciesCandidate[]>>({ tree: [], large_shrub: [], shrub: [], groundcover: [] });
  useEffect(() => {
    if (!placementSettled) return; // hold the last stable list until placement + substitution settle
    setPlacedPicks({
      tree: picks.tree.filter(sp => placedSpeciesNames.has(sp.common_name || sp.botanical_name)),
      large_shrub: picks.large_shrub.filter(sp => placedSpeciesNames.has(sp.common_name || sp.botanical_name)),
      shrub: picks.shrub.filter(sp => placedSpeciesNames.has(sp.common_name || sp.botanical_name)),
      groundcover: picks.groundcover.filter(sp => placedSpeciesNames.has(sp.common_name || sp.botanical_name)),
    });
  }, [placementSettled, picks, placedSpeciesNames]);
  // Has the panel ever settled? Before the first settle we show a loading state, not "none selected".
  const placedPicksReady = placementSettled || LAYER_ORDER.some(l => placedPicks[l].length > 0);
  const placedTotalSpecies = LAYER_ORDER.reduce((s, l) => s + placedPicks[l].length, 0);

  // When a plan click spotlighted a species (pendingPlantScrollRef), scroll its card into view once
  // the Plants step is open and the cards have rendered. Retries across renders until the card mounts.
  useEffect(() => {
    const name = pendingPlantScrollRef.current;
    if (!name || openStep !== 'plants') return;
    const el = plantCardRefs.current[name];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pendingPlantScrollRef.current = null;
    }
  }, [selSpecies, openStep, plantGroupOpen, plantsLoaded, placedPicksReady, placedPicks]);

  // Feed the drawn markers to the canvas (feet coords — same CS as the placement page).
  useEffect(() => {
    const out: PlantMarker[] = [];
    for (const s of plantSlots) {
      const p = plantPositions[s.id]; if (!p) continue;
      out.push({ x: p.x, y: p.y, rFt: s.r, color: plantSpeciesColor.get(s.name) ?? '#5a7a50', kind: s.layer, name: s.name });
    }
    plantMarkersRef.current = out;
    plantClustersRef.current = buildPlantClusters(out); // memoised: recomputes only on plant-set change
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

  // Keep the persisted picks in sync with the current selection, tagged with the plan signature — so a
  // later re-entry (or the review/3D views) hydrates the SAME plan, and edits here are what gets surfaced.
  useEffect(() => {
    if (!plantsLoaded) return;
    try {
      localStorage.setItem('diyPlantPicks', JSON.stringify(picks));
      localStorage.setItem('diyPlantPicksSig', localStorage.getItem('diyPlacementPlanSig') || '');
    } catch { /* quota */ }
  }, [picks, plantsLoaded]);


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

  // ── Auto-suggested detail features (walkways + fills), rule-based, added once on the details step ──
  const suggestDetails = useCallback(() => {
    const c = csRef.current, bf = boundaryFtRef.current; if (!c || bf.length < 3) return;
    const zones = zonesRef.current, obs = obstacleFtRef.current, curPaths = pathsRef.current;
    const doorFt = doorPointRef.current ? c.toXY(doorPointRef.current[0], doorPointRef.current[1]) : null;
    const seed0 = Math.round(boundaryAreaFt) | 0;
    const style: PathStyle = dbStyle === 'whimsical' ? 'winding' : 'straight';
    const ringOf = (z: PlacedZone) => shapeRingFt(z.shape, z.xFt, z.yFt, z.wFt, z.hFt, z.id, z.verts, z.rot);
    const flagColor = PATH_MATERIALS.find(m => m.id === 'flagstone')?.color;
    const newPaths: PlacedPath[] = [];

    // R1 / R2 — connect gathering features + the vegetable garden to a walkway (or entry/house).
    const CONNECT: Record<string, string> = { seating: 'seating', dining: 'dining area', cooking: 'fire pit', garden: 'vegetable garden' };
    const allPolylines = () => [...curPaths.map(p => p.pts), ...newPaths.map(p => p.pts)].filter(pl => pl.length >= 2);
    for (const z of zones) {
      if (!(z.key in CONNECT) || !(z.verts || (z.wFt > 0 && z.hFt > 0))) continue;
      const ring = ringOf(z); if (ring.length < 3) continue;
      const [cx, cy] = [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2];
      if (allPolylines().some(pl => ringToPathMinDist(ring, pl) <= 2)) continue;              // already served by a walkway
      // Circulation (generation) already routes gathering paths to zones >4ft from a walkway, pulling
      // the endpoint into the zone. Its GATHER set {seating,dining,cooking,fire,garden} fully covers
      // R1/R2's CONNECT targets, so gate on it at the SAME 4ft threshold to avoid a redundant stub.
      if (curPaths.some(p => p.id?.startsWith('circ_') && p.pts.length >= 2 && ringToPathMinDist(ring, p.pts) <= 4)) continue;
      if (doorFt && Math.min(...ring.map(([x, y]) => Math.hypot(x - doorFt[0], y - doorFt[1]))) <= 2) continue; // touches the entry
      // Target: nearest existing walkway point, else the entry, else the nearest house/structure edge.
      let target: [number, number] | null = null, bestD = Infinity;
      for (const pl of curPaths.map(p => p.pts).filter(pl => pl.length >= 2)) { const n = nearestOnPath(cx, cy, pl); if (n && n.d < bestD) { bestD = n.d; target = [n.x, n.y]; } }
      if (!target && doorFt) target = doorFt;
      if (!target) { for (const o of obs) { if (o.length < 3) continue; const p = nearestOnRing(o, cx, cy); const d = Math.hypot(p[0] - cx, p[1] - cy); if (d < bestD) { bestD = d; target = p; } } }
      if (!target) continue;
      const from = nearestOnRing(ring, target[0], target[1]);
      const dx = target[0] - from[0], dy = target[1] - from[1], L = Math.hypot(dx, dy) || 1;
      if (L < 2) continue; // already effectively adjacent
      const start: [number, number] = [from[0] + (dx / L) * 0.5, from[1] + (dy / L) * 0.5];
      const pts = buildPath(start, target, style, seed0 + z.id.length * 7);
      if (pts.length >= 2) newPaths.push({ id: `det_auto_${z.id}`, label: `Path to ${CONNECT[z.key]}`, startId: 'auto', endId: 'auto', pts, style, material: 'flagstone', widthFt: pathWidthForMaterial('flagstone'), kind: 'walkway', color: flagColor });
    }

    // R3 (open-ground dry creek / accent bed) RETIRED — the composition planner now owns void-filling
    // (accent beds + dry creek + focal slots) during generation, so it no longer lives here.

    if (newPaths.length) setPaths(prev => [...prev, ...newPaths]);
  }, [buildPath, dbStyle, boundaryAreaFt]);

  // Run the suggestions once per plan, the first time the details step opens. Keyed to the plan
  // signature so a regenerated plan (new project / changed inputs) suggests afresh, but the user's
  // edits within a plan aren't clobbered on revisit.
  const suggestedRef = useRef(false);
  useEffect(() => {
    if (!illustrative || openStep !== 'details' || suggestedRef.current) return;
    suggestedRef.current = true;
    const sig = localStorage.getItem('diyPlacementPlanSig') || '';
    if (localStorage.getItem('diyDetailsSuggested') === sig) return; // already suggested for this plan
    try { localStorage.setItem('diyDetailsSuggested', sig); } catch { /* ignore */ }
    suggestDetails();
  }, [openStep, illustrative, suggestDetails]);

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
  const selectedFeature = (!illustrative && selectedFeatureId) ? (existing.find(f => f.id === selectedFeatureId) ?? null) : null;

  // Active feature (defaults to the first in the list) and its placement hint for the map banner.
  const activeKey  = activeToolKey ?? featItems[0]?.key ?? null;
  const activeHint = activeKey ? (activeKey === 'water' ? waterHint : (FEAT_HINTS[activeKey] ?? '')) : '';

  // Guided stepper (auto-layout): the placed features to walk through, in order, lawn last.
  // Feature cards: the placed features in guide order, with the lawn as the final card.
  const guideZones = useMemo(
    // 'lawn' is excluded from the GUIDE_ORDER pass — it's appended explicitly (last) below, and
    // GUIDE_ORDER also listing it produced every lawn card TWICE (the '__lawn' duplicate-key bug).
    () => illustrative ? [...GUIDE_ORDER.filter(k => k !== 'lawn').flatMap(k => placedZones.filter(z => z.key === k)), ...placedZones.filter(z => z.key === 'lawn')] : [],
    [illustrative, placedZones],
  );
  guideZonesRef.current = guideZones;
  // Lawn is ALWAYS a feature card (its amount is a style-based suggestion): when no lawn zone
  // exists ("None"), a placeholder card offers the amount chips; picking Some/A lot swaps it for
  // the real zone card (same position) with shape + placement guidance.
  const featureCards = useMemo<{ z: PlacedZone | null }[]>(() => {
    const cards: { z: PlacedZone | null }[] = guideZones.map(z => ({ z }));
    if (illustrative && !guideZones.some(zz => zz.key === 'lawn')) cards.push({ z: null });
    return cards;
  }, [guideZones, illustrative]);
  const guideZone = guideZones[guideIdx] ?? null;
  const guideHint = guideZone ? (guideZone.key === 'water' ? waterHint : (FEAT_HINTS[guideZone.key] ?? '')) : '';
  // Global "reset to generated plan": revert ALL plan geometry (zones incl. lawn, beds, walkways/creeks,
  // primary groundcover) to the as-generated snapshot (diyPlacementPlanOriginal). Plant choices are a
  // separate step and are left untouched. Refs sync from state via effects, which also trigger a redraw.
  const resetToGenerated = useCallback(() => {
    try {
      const orig = JSON.parse(localStorage.getItem('diyPlacementPlanOriginal') || 'null');
      if (!orig || !Array.isArray(orig.zones)) return;
      // Same lawn-dedup guard as the initial load.
      const lawns = orig.zones.filter((z: any) => z.key === 'lawn');
      const zones = lawns.length <= 1 ? orig.zones
        : orig.zones.filter((z: any) => z.key !== 'lawn' || z === lawns.reduce((a: any, b: any) => (a.wFt * a.hFt >= b.wFt * b.hFt ? a : b)));
      setPlacedZones(zones);
      setPlacedBeds(Array.isArray(orig.beds) ? orig.beds : []);
      setPaths(Array.isArray(orig.paths) ? orig.paths : []);
      setDefaultMaterial(orig.primary?.material ?? null);
      setDefaultVariant(orig.primary?.variant ?? null);
      focalSlotsRef.current = Array.isArray(orig.focalSlots) ? orig.focalSlots : [];
      clearAllSelections();
      setGuideIdx(-1);
      localStorage.setItem('diyPlacementPlan', JSON.stringify(orig)); // persist the reverted plan
    } catch { /* ignore */ }
  }, [clearAllSelections]);
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
  // Features panel — one sub-card per placed feature (+ the lawn), expandable to edit shape,
  // material, and lawn amount.
  const SHAPE_LABEL: Record<string, string> = { rect: 'Square', circle: 'Round', organic: 'Organic' };
  const guidedStepperPanel = (
    <div className="flex flex-col gap-2.5">
      {featureCards.length === 0 && <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', margin: 0 }}>No features to place.</p>}
      {featureCards.map(({ z }, i) => {
        const open = guideIdx === i;
        const isLawn = !z || z.key === 'lawn';
        const label = z?.label ?? 'Lawn';
        const w = z ? Math.round(z.wFt) : 0, h = z ? Math.round(z.hFt) : 0;
        const area = z ? Math.round((z.shape === 'circle' ? Math.PI / 4 : z.shape === 'organic' ? 0.82 : 1) * z.wFt * z.hFt) : 0;
        const summary = !z ? 'None'
          : isLawn ? `${SHAPE_LABEL[z.shape] ?? z.shape} · ${area.toLocaleString()} sq ft`
          : z.shape === 'circle' && w === h ? `${SHAPE_LABEL.circle} · ${w} ft`
          : `${SHAPE_LABEL[z.shape] ?? z.shape} · ${w} × ${h} ft`;
        const reason = (() => {
          if (!z) return "Your style leans away from a lawn, so we didn't add one. Pick a shape below to override.";
          if (isLawn) return "Placed in an open, uninterrupted section of the yard so it's easier to use and maintain.";
          const fx = z.xFt + z.wFt / 2, fy = z.yFt + z.hFt / 2;
          let near = true;
          const ref = houseGeomFt?.centroid;
          if (ref && cs) near = Math.hypot(fx - ref[0], fy - ref[1]) < Math.hypot(cs.widthFt, cs.heightFt) * 0.33;
          return placementReason(z.key, (z.label || '').toLowerCase(), near) || (z.key === 'water' ? waterHint : (FEAT_HINTS[z.key] ?? ''));
        })();
        return (
          <div key={z ? z.id : '__lawn_placeholder'} style={cardShell(open)}>
            {/* Card header */}
            <button onClick={() => setGuideIdx(open ? -1 : i)}
              className="w-full flex items-center gap-2.5 transition-all hover:opacity-85"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '11px 13px', textAlign: 'left' }}>
              <span style={CARD_TITLE}>{label}</span>
              <span className="ml-auto" style={CARD_SUMMARY}>
                {open ? (z ? `${w} × ${h} ft · ${area.toLocaleString()} sq ft` : 'None') : summary}
              </span>
              <Chevron open={open} />
            </button>

            {open && (
              <div className="px-3.5 pb-3.5 flex flex-col gap-3">
                <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>{reason}</p>

                {z && !isLawn && (
                <div className="flex flex-col gap-1.5">
                  <span style={stepLabelStyle}>Shape</span>
                  <div className="flex gap-1.5">
                    {([{ id: 'rect', label: 'Square' }, { id: 'circle', label: 'Round' }, { id: 'organic', label: 'Organic' }] as { id: ZoneShape; label: string }[]).map(s => {
                      const on = z.shape === s.id;
                      return (
                        <button key={s.id} onClick={() => updateZone(z.id, { shape: s.id })}
                          className="flex-1 py-2 rounded-full transition-all hover:opacity-90"
                          style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                            background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
                            border: on ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.14)' }}>
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                )}

                {z && MATERIAL_FEATURES.has(z.key) && (
                  <div className="flex flex-col gap-1.5">
                    <span style={stepLabelStyle}>Material</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                      {FEATURE_MATERIALS.map(m => {
                        const on = (z.material ?? 'gravel') === m.id;
                        return (
                          <button key={m.id} onClick={() => updateZone(z.id, { material: m.id })}
                            className="flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all hover:opacity-90"
                            style={{ fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer', color: '#2A2A26',
                              background: on ? 'rgba(47,107,79,0.07)' : 'white',
                              border: on ? '1.5px solid #2F6B4F' : '1.5px solid rgba(42,42,38,0.14)' }}>
                            <span style={{ width: 13, height: 13, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.12)' }} />
                            {m.label}
                            {on && <span className="ml-auto" style={{ color: '#2F6B4F', fontWeight: 700 }}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {isLawn && (
                  <div className="flex flex-col gap-1.5">
                    <span style={stepLabelStyle}>Shape</span>
                    <div className="flex gap-1.5">
                      {([{ id: 'rect', label: 'Square' }, { id: 'circle', label: 'Round' }, { id: 'organic', label: 'Organic' }, { id: 'none', label: 'None' }] as { id: ZoneShape | 'none'; label: string }[]).map(s => {
                        const on = s.id === 'none' ? !z : (!!z && z.shape === s.id);
                        return (
                          <button key={s.id} onClick={() => {
                            if (s.id === 'none') { applyLawnTarget(0); }
                            else if (z) { updateZone(z.id, { shape: s.id }); }
                            else { applyLawnTarget(typeof prefs.lawnTarget === 'number' && prefs.lawnTarget > 0 ? prefs.lawnTarget : 0.33, s.id); }
                          }}
                            className="flex-1 py-2 rounded-full transition-all hover:opacity-90"
                            style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                              background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
                              border: on ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.14)' }}>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // "Fill in the details" panel — draw walkways / dry creek beds, or click one to edit it.
  const detailMaterialOptions = detailKind === 'creek'
    ? CREEK_MATERIALS
    : PATH_MATERIALS.map(m => ({ id: m.id, label: m.label, color: m.color }));
  const selDetailPath = paths.find(p => p.id === selectedPathId) ?? null;
  const accentBeds = placedBeds.filter(b => b.id.startsWith('det_bed'));
  const groundVariantLabel = defaultMaterial ? (variantsFor(defaultMaterial).find(v => v.id === defaultVariant)?.label ?? '') : '';
  const groundSummary = defaultMaterial
    ? `${defaultMaterial.charAt(0).toUpperCase()}${defaultMaterial.slice(1)}${groundVariantLabel ? ` · ${groundVariantLabel}` : ''}`
    : 'Not set';

  // Each detail type (walkways / dry creek beds / accent beds) is rendered like a plant layer: a
  // labeled list of what's already built, then an "Add another" (or first-add) button below.
  const walkwayPaths = paths.filter(p => (p.kind ?? 'walkway') !== 'creek');
  const creekPaths   = paths.filter(p => (p.kind ?? 'walkway') === 'creek');
  const detailHeader = (label: string, count: number) => (
    <div className="flex items-baseline gap-2">
      <span style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26' }}>{label}</span>
      {count > 0 && <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', marginLeft: 'auto' }}>{count}</span>}
    </div>
  );
  const detailAddBtn = (label: string, onClick: () => void) => (
    <button onClick={onClick} className="flex items-center gap-2 rounded-xl px-3 py-2 hover:opacity-80 transition-all" style={ADD_ROW}>
      <span style={{ fontSize: '1.05rem', lineHeight: 1 }}>+</span> {label}
    </button>
  );
  const pathRow = (p: PlacedPath) => (
    <div onClick={() => { if (detailKind) cancelDetailDraw(); setSelectedPathId(selectedPathId === p.id ? null : p.id); }}
      className="flex items-center gap-2 rounded-xl px-3 py-2 transition-all"
      style={{ ...selShell(selectedPathId === p.id), cursor: 'pointer' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color ?? PATH_COLOR, flexShrink: 0 }} />
      <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{p.label}</span>
      <button onClick={(e) => { e.stopPropagation(); setPaths(prev => prev.filter(x => x.id !== p.id)); if (selectedPathId === p.id) setSelectedPathId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
    </div>
  );
  const accentRow = (b: PlacedBed) => (
    <div onClick={() => { const on = selectedBedId === b.id; setSelectedPathId(null); setSelectedBedId(on ? null : b.id); }}
      className="flex items-center gap-2 rounded-xl px-3 py-2 transition-all"
      style={{ ...selShell(selectedBedId === b.id), cursor: 'pointer' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material], flexShrink: 0 }} />
      <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26', flex: 1 }}>{b.label}</span>
      <button onClick={(e) => { e.stopPropagation(); setPlacedBeds(prev => prev.filter(x => x.id !== b.id)); if (selectedBedId === b.id) setSelectedBedId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontFamily: IT, fontSize: '0.75rem', padding: 0 }}>✕</button>
    </div>
  );
  // Add an accent bed by choosing a shape: drop a default-sized bed of that shape at the yard's centre
  // (staggered so repeats don't stack) and select it, so the user drags/resizes it like a feature.
  const addAccentBed = (shape: ZoneShape) => {
    let cx = 0, cy = 0;
    if (boundaryFt.length) { for (const [x, y] of boundaryFt) { cx += x; cy += y; } cx /= boundaryFt.length; cy /= boundaryFt.length; }
    const off = accentBeds.length * 3; // stagger so successive beds don't land exactly on top of each other
    const w = 12, h = 10;
    // Material: match existing accent beds if any; otherwise contrast the primary groundcover (rock beds
    // on a mulch yard, or vice versa) so the first accent reads as an accent rather than blending in.
    const prior = accentBeds[accentBeds.length - 1];
    let material: GroundMaterial, variant: GroundVariant;
    if (prior && (prior.material === 'mulch' || prior.material === 'rock')) {
      material = prior.material; variant = prior.variant as GroundVariant;
    } else {
      const primary: GroundMaterial = defaultMaterial ?? 'mulch';
      material = primary === 'mulch' ? 'rock' : 'mulch';
      variant = GROUND_VARIANTS[material][0].id;
    }
    const bed: PlacedBed = {
      id: `det_bed_${Date.now()}`,
      label: `Bed ${placedBeds.filter(b => b.material !== 'lawn').length + 1}`,
      type: 'planted', material, variant, shape,
      xFt: cx - w / 2 + off, yFt: cy - h / 2 + off, wFt: w, hFt: h,
    };
    setPlacedBeds(prev => [...prev, bed]);
    setSelectedPathId(null);
    setSelectedBedId(bed.id);
  };
  // Accent-bed editor (material + variant, same options as the primary groundcover) — shown inline
  // beneath the selected bed's row.
  const accentEditCard = (b: PlacedBed) => (
    <div className="flex flex-col gap-3 rounded-xl p-3.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
      <div className="flex items-center gap-2">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material], flexShrink: 0 }} />
        <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26', fontWeight: 600, flex: 1 }}>{b.label}</span>
        <button onClick={() => setSelectedBedId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontFamily: IT, fontSize: '0.78rem' }}>Done</button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span style={stepLabelStyle}>Shape</span>
        <div className="flex gap-1.5">
          {([{ id: 'rect', label: 'Square' }, { id: 'circle', label: 'Round' }, { id: 'organic', label: 'Organic' }] as { id: ZoneShape; label: string }[]).map(s => {
            const on = b.shape === s.id;
            return (
              <button key={s.id} onClick={() => {
                // Switch a drawn (poly) or existing bed to a regular shape, sizing it to its current bounds.
                const patch: Partial<PlacedBed> = { shape: s.id, verts: undefined };
                if (b.verts && b.verts.length >= 3) {
                  const xs = b.verts.map(v => v[0]), ys = b.verts.map(v => v[1]);
                  const x0 = Math.min(...xs), y0 = Math.min(...ys);
                  patch.xFt = x0; patch.yFt = y0; patch.wFt = Math.max(...xs) - x0; patch.hFt = Math.max(...ys) - y0;
                }
                updateBed(b.id, patch);
              }}
                className="flex-1 py-2 rounded-full transition-all hover:opacity-90"
                style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                  background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
                  border: on ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.14)' }}>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span style={stepLabelStyle}>Material</span>
        <div className="flex gap-1.5">
          {(['mulch', 'rock'] as const).map(m => (
            <button key={m} onClick={() => updateBed(b.id, { material: m, variant: GROUND_VARIANTS[m][0].id })}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl px-3 py-2 capitalize transition-all"
              style={{ background: b.material === m ? 'rgba(47,107,79,0.07)' : 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: `1.5px solid ${b.material === m ? '#2F6B4F' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, background: MATERIAL_COLOR[m], flexShrink: 0 }} />
              {m}{b.material === m ? ' ✓' : ''}
            </button>
          ))}
        </div>
      </div>
      {variantsFor(b.material).length > 0 && (
        <div className="flex gap-1.5">
          {variantsFor(b.material).map(v => (
            <button key={v.id} onClick={() => updateBed(b.id, { variant: v.id })}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-full px-2 py-1 transition-all"
              style={{ background: b.variant === v.id ? 'white' : 'transparent', color: '#2A2A26', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, border: `1.5px solid ${b.variant === v.id ? '#2F6B4F' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: v.color, flexShrink: 0 }} />
              {v.label}
            </button>
          ))}
        </div>
      )}
      <button onClick={() => { setPlacedBeds(prev => prev.filter(x => x.id !== b.id)); setSelectedBedId(null); }} className="rounded-full px-4 py-2 transition-all hover:opacity-90"
        style={{ background: 'white', color: '#B4534B', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: '1.5px solid rgba(180,83,75,0.3)', cursor: 'pointer' }}>Remove</button>
    </div>
  );
  // Draw-in-progress card for a new walkway/creek (title follows detailKind); only rendered in the
  // matching section.
  const pathDrawCard = (
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
            <button key={s} onClick={() => setDetailStyleLive(s)} className="flex-1 rounded-full px-3 py-1.5 capitalize transition-all"
              style={{ background: detailStyle === s ? '#2A2A26' : 'white', color: detailStyle === s ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, border: `1.5px solid ${detailStyle === s ? '#2A2A26' : 'rgba(42,42,38,0.16)'}`, cursor: 'pointer' }}>{s}</button>
          ))}
        </div>
      </div>
      {detailMaterialOptions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span style={stepLabelStyle}>Material</span>
          <div className="grid grid-cols-2 gap-1.5">
            {detailMaterialOptions.map(m => (
              <button key={m.id} onClick={() => setDetailMaterial(m.id)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition-all"
                style={{ background: detailMaterial === m.id ? 'white' : 'transparent', border: `1.5px solid ${detailMaterial === m.id ? '#2A2A26' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
  // Edit card for the selected path — shown inline beneath its row (so a built item expands to edit).
  const pathEditCard = selDetailPath ? (
    <div className="flex flex-col gap-3 rounded-xl p-3.5" style={{ background: 'rgba(42,42,38,0.06)' }}>
      <div className="flex items-center gap-2">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: selDetailPath.color ?? PATH_COLOR, flexShrink: 0 }} />
        <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26', fontWeight: 600, flex: 1 }}>{selDetailPath.label}</span>
        <button onClick={() => setSelectedPathId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontFamily: IT, fontSize: '0.78rem' }}>Done</button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span style={stepLabelStyle}>Shape</span>
        <div className="flex gap-1.5">
          {(['straight', 'winding'] as PathStyle[]).map(s => (
            <button key={s} onClick={() => reshapePathById(selDetailPath.id, s)} className="flex-1 rounded-full px-3 py-1.5 capitalize transition-all"
              style={{ background: selDetailPath.style === s ? '#2A2A26' : 'white', color: selDetailPath.style === s ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, border: `1.5px solid ${selDetailPath.style === s ? '#2A2A26' : 'rgba(42,42,38,0.16)'}`, cursor: 'pointer' }}>{s}</button>
          ))}
        </div>
      </div>
      {(selDetailPath.kind ?? 'walkway') !== 'creek' && (
        <div className="flex flex-col gap-1.5">
          <span style={stepLabelStyle}>Material</span>
          <div className="grid grid-cols-2 gap-1.5">
            {PATH_MATERIALS.map(m => (
              <button key={m.id} onClick={() => setPathMaterialById(selDetailPath.id, m.id)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition-all"
                style={{ background: selDetailPath.material === m.id ? 'white' : 'transparent', border: `1.5px solid ${selDetailPath.material === m.id ? '#2A2A26' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: m.color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => { setPaths(prev => prev.filter(x => x.id !== selDetailPath.id)); setSelectedPathId(null); }} className="rounded-full px-4 py-2 transition-all hover:opacity-90"
        style={{ background: 'white', color: '#B4534B', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: '1.5px solid rgba(180,83,75,0.3)', cursor: 'pointer' }}>Remove</button>
    </div>
  ) : null;

  // "Details" panel (merged): primary groundcover up top, then walkways / dry creek beds / accent beds,
  // each shown like a plant layer (built items + "Add another").
  const detailsPanel = (
    <div className="flex flex-col gap-3">
      {/* Primary groundcover — collapsible card (same pattern as the feature cards). */}
      <div style={cardShell(groundOpen)}>
        <button onClick={() => setGroundOpen(o => !o)}
          className="w-full flex items-center gap-2.5 transition-all hover:opacity-85"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '11px 13px', textAlign: 'left' }}>
          <span style={CARD_TITLE}>Primary groundcover</span>
          <span style={CARD_SUMMARY}>{groundSummary}</span>
          <Chevron open={groundOpen} />
        </button>
        {groundOpen && (
          <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>

            <div style={GROUP_LABEL}>Material</div>
            <div className="flex gap-1.5">
              {(['mulch', 'rock'] as const).map(m => (
                <button key={m} onClick={() => { setDefaultMaterial(m); setDefaultVariant(GROUND_VARIANTS[m][0].id); }}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl px-3 py-2 capitalize transition-all"
                  style={{ background: defaultMaterial === m ? 'rgba(47,107,79,0.07)' : 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: `1.5px solid ${defaultMaterial === m ? '#2F6B4F' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: MATERIAL_COLOR[m], flexShrink: 0 }} />
                  {m}{defaultMaterial === m ? ' ✓' : ''}
                </button>
              ))}
            </div>
            {defaultMaterial && (
              <div className="flex gap-1.5">
                {variantsFor(defaultMaterial).map(v => (
                  <button key={v.id} onClick={() => setDefaultVariant(v.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-full px-2 py-1 transition-all"
                    style={{ background: defaultVariant === v.id ? 'white' : 'transparent', color: '#2A2A26', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, border: `1.5px solid ${defaultVariant === v.id ? '#2F6B4F' : 'rgba(42,42,38,0.14)'}`, cursor: 'pointer' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: v.color, flexShrink: 0 }} />
                    {v.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Walkways */}
      <div className="flex flex-col gap-2">
        {detailHeader('Walkways', walkwayPaths.length)}
        {walkwayPaths.map(p => (
          <Fragment key={p.id}>
            {selectedPathId === p.id ? pathEditCard : pathRow(p)}
          </Fragment>
        ))}
        {detailKind === 'walkway'
          ? pathDrawCard
          : detailAddBtn(walkwayPaths.length ? 'Add another' : 'Add a walkway', () => startDetailDraw('walkway'))}
      </div>

      {/* Dry creek beds */}
      <div className="flex flex-col gap-2">
        {detailHeader('Dry creek beds', creekPaths.length)}
        {creekPaths.map(p => (
          <Fragment key={p.id}>
            {selectedPathId === p.id ? pathEditCard : pathRow(p)}
          </Fragment>
        ))}
        {detailKind === 'creek'
          ? pathDrawCard
          : detailAddBtn(creekPaths.length ? 'Add another' : 'Add a dry creek bed', () => startDetailDraw('creek'))}
      </div>

      {/* Accent beds */}
      <div className="flex flex-col gap-2">
        {detailHeader('Accent beds', accentBeds.length)}
        {accentBeds.map(b => (
          <Fragment key={b.id}>
            {selectedBedId === b.id ? accentEditCard(b) : accentRow(b)}
          </Fragment>
        ))}
        {detailAddBtn(accentBeds.length ? 'Add another' : 'Add an accent bed',
          // Drop a bed in the style's default shape — square for modern, organic otherwise — then the
          // editor's Shape selector lets the user change it.
          () => addAccentBed(designStyle === 'modern_structured' ? 'rect' : 'organic'))}
      </div>
    </div>
  );

  // "Choose your plants" panel — species grouped by type (visual interest / foundation / groundcover),
  // each with compact swap/remove/add rows, matched to this sidebar layout.
  // showLabel: only name the plant type when a group holds more than one (e.g. trees vs large shrubs).
  const renderPlantLayer = (l: Layer, showLabel = true) => (
    <div key={l} className="flex flex-col gap-2" style={{ marginTop: 4 }}>
      <div className="flex items-baseline gap-2">
        {showLabel && <span style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26' }}>{LAYER_INFO[l].label}</span>}
        <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#B0B0A6', marginLeft: 'auto' }}>
          {!plantsLoaded && !treeSel ? 'Loading…' : (l !== 'tree' && !placedPicksReady) ? 'Choosing…' : layerRight(l)}
        </span>
      </div>
      {plantsLoaded && placedPicksReady && placedPicks[l].length === 0 && (
        <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#9A9A8E', margin: 0, lineHeight: 1.45 }}>
          {l === 'tree' && treeSel && treeSel.targetToPlant === 0
            ? `Based on your project size, we don't think you need any more trees.`
            : styleMatchedFor(l) === 0 ? `No ${dbStyle} ${LAYER_INFO[l].label.toLowerCase()} in the database.` : 'None selected — add one below.'}
        </p>
      )}
      {placedPicks[l].map((sp) => {
        // Card click spotlights this species on the plan (toggle off if re-clicked); the Swap/Remove
        // buttons stopPropagation so they still act on their own without also toggling the highlight.
        // Only PLACED species render here — map back to the working `picks` index (by species id)
        // before mutating, since Swap/Remove act on `picks`, not this filtered view.
        const spName = sp.common_name || sp.botanical_name;
        const sel = selSpecies === spName;
        const trueIdx = picks[l].findIndex(c => c.id === sp.id);
        return (
        <div key={sp.id} role="button" tabIndex={0}
          ref={el => { plantCardRefs.current[spName] = el; }}
          onClick={() => toggleSpecies(spName)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSpecies(spName); } }}
          className="flex items-center gap-2.5 rounded-xl p-2" style={{ background: sel ? '#F4F0E6' : 'white', border: sel ? '2px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.1)', cursor: 'pointer' }}>
          <div style={{ width: 80, height: 80, borderRadius: 10, overflow: 'hidden', flexShrink: 0, border: `2px solid ${plantSpeciesColor.get(spName) ?? '#5a7a50'}` }}>
            <PlantImage url={sp.image_url} kind={THUMB_KIND[l]} seed={sp.id} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: '#2A2A26', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{spName}</div>
            <div style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A8E' }}>{sp.sizeLabel}</div>
          </div>
          <button onClick={e => { e.stopPropagation(); if (trueIdx >= 0) setSwapTarget({ layer: l, idx: trueIdx }); }} title="Swap species"
            className="flex items-center gap-1 transition-all hover:opacity-80"
            style={{ background: 'rgba(61,92,58,0.09)', border: '1.5px solid rgba(61,92,58,0.25)', borderRadius: 999, padding: '4px 9px', cursor: 'pointer', color: '#3d5c3a', fontFamily: IT, fontSize: '0.72rem', fontWeight: 500, flexShrink: 0 }}>
            Swap
          </button>
          {(l === 'tree' || placedPicks[l].length > 1) && <button onClick={e => { e.stopPropagation(); if (trueIdx >= 0) removePick(l, trueIdx); }} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontSize: '0.8rem', padding: '2px 4px', flexShrink: 0 }}>✕</button>}
        </div>
        );
      })}
      {l === 'tree' && treeSel && treeSel.targetToPlant === 0 && placedPicks.tree.length === 0 ? (
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

      {/* Plant density — scales how fully the understory (shrubs + groundcover) fills the beds. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 600 }}>Plant density</span>
          <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#6A6A60' }}>{plantDensity < 0.8 ? 'Sparse' : plantDensity > 1.2 ? 'Lush' : 'Balanced'}</span>
        </div>
        <input type="range" min={0.5} max={1.5} step={0.05} value={plantDensity}
          onChange={e => setPlantDensity(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#2F6B4F', cursor: 'pointer' }} />
      </div>

      {plantsErr && <p style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A6A2A', margin: 0 }}>Couldn't reach the plant database — check your connection.</p>}
      {!plantsLoaded && !plantsErr && (
        <div className="flex items-center gap-2.5" style={{ fontFamily: IT, fontSize: '0.85rem', color: '#9A9A92' }}>
          <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.25)', borderTopColor: '#2A2A26', animation: 'spin 0.8s linear infinite' }} />
          Choosing plants for your beds…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {plantsLoaded && (
        <div className="flex flex-col gap-2.5">
          {PLANT_GROUPS.map((grp, i) => {
            const isOpen = plantGroupOpen === i;
            const count = grp.layers.reduce((a, l) => a + placedPicks[l].length, 0);
            return (
              <div key={grp.title} style={cardShell(isOpen)}>
                <button onClick={() => setPlantGroupOpen(isOpen ? -1 : i)} className="w-full flex items-center gap-2.5 transition-all hover:opacity-85"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '11px 13px', textAlign: 'left' }}>
                  <span style={CARD_TITLE}>{grp.title}</span>
                  <span style={CARD_SUMMARY}>{count > 0 ? count : ''}</span>
                  <Chevron open={isOpen} />
                </button>
                {isOpen && (
                  <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
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

  // The plan is one editable surface (accordion of components), not a stepper. Footer: a compact
  // issue strip (when spacing warnings exist) + a full-width Finish button with a helper line.
  const stepNav = (() => {
    const blocked = gapWarnings.length > 0;
    const w = gapWarnings[0];
    return (
      <div className="flex flex-col gap-2.5">
        {blocked && w && (
          <div className="flex items-center gap-2 rounded-xl px-3.5 py-2.5" style={{ background: '#FBF1DA', border: '1.5px solid #E4C475' }}>
            <span style={{ fontFamily: IT, fontSize: '0.78rem', fontWeight: 600, color: '#8A5B14', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {w.a} &lt;&gt; {w.b} · {w.gap.toFixed(1)} ft apart{gapWarnings.length > 1 ? `  (+${gapWarnings.length - 1} more)` : ''}
            </span>
            <button onClick={() => setOpenStep('features')}
              style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 600, color: '#8A5B14', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', flexShrink: 0, padding: 0 }}>
              View
            </button>
          </div>
        )}
        <div className="flex gap-2.5 justify-between">
          <BackButton onClick={() => navigate('/diy/plan-ready')} style={{ flexShrink: 0 }} />
          <button onClick={() => { if (!blocked) navigate('/diy/review'); }} disabled={blocked}
            className="rounded-full px-5 py-2.5 transition-all hover:opacity-90"
            style={{ background: blocked ? 'rgba(42,42,38,0.14)' : '#2A2A26', color: blocked ? '#8F8F86' : '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, border: 'none', cursor: blocked ? 'default' : 'pointer', flexShrink: 0 }}>
            Finish
          </button>
        </div>
        {blocked && (
          <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#8A5B14', textAlign: 'center', margin: 0 }}>
            Resolve {gapWarnings.length} issue{gapWarnings.length !== 1 ? 's' : ''} to finish — features are too close together (leave ≥{GAP_MIN_FT} ft, or let them touch).
          </p>
        )}
      </div>
    );
  })();

  // ── Render ───────────────────────────────────────────────────────────────────
  const accordionStepNum = Math.max(1, visibleSteps.indexOf(openStep ?? 'features') + 1);
  const designProg = designProgress(openStep ?? 'features');
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: illustrative ? '#F4F0E6' : '#E7E1D5', overflow: 'hidden', paddingTop: illustrative ? 0 : '2rem' }}>


      {/* Plant swap popup — choose an alternative species for the selected slot. */}
      {swapTarget && (() => {
        const current = picks[swapTarget.layer][swapTarget.idx];
        // Only offer species the yard can actually fit: gate structural alternatives on the capacity
        // remaining AFTER the other placed structural species claim their pockets (the one being
        // swapped is excluded, so its pocket is available to its replacement). Understory: unfiltered.
        const swapCap = structuralLayer(swapTarget.layer) ? remainingCapacity(current?.id) : null;
        // Keep alternatives near the current plant's footprint — the bed was laid out for THIS size,
        // so a much-bigger swap overflows (understory isn't capacity-gated, which is where this bit).
        // A tolerance band (not exact) keeps real variety; SWAP_WIDTH_TOL_FT is the ± dial.
        const SWAP_WIDTH_TOL_FT = 1.5;
        const curW = current?.matureWidthFt ?? Infinity;
        const nearSize = (sp: SpeciesCandidate) => Math.abs(sp.matureWidthFt - curW) <= SWAP_WIDTH_TOL_FT;
        const pool = poolFor(swapTarget.layer).filter(sp =>
          sp.id === current?.id || (nearSize(sp) && speciesFitsCapacity(swapTarget.layer, sp, swapCap)));
        const usedIds = new Set(picks[swapTarget.layer].filter((_, i) => i !== swapTarget.idx).map(c => c.id));
        const PER_PAGE = 8; // 4 across × 2 rows
        const pageCount = Math.max(1, Math.ceil(pool.length / PER_PAGE));
        const page = Math.min(swapPage, pageCount - 1);
        const visible = pool.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
        const arrow = (dir: -1 | 1, enabled: boolean): React.CSSProperties => ({
          width: 38, height: 38, borderRadius: '50%', border: 'none', flexShrink: 0,
          background: enabled ? '#2A2A26' : 'rgba(42,42,38,0.12)', color: enabled ? '#efe9db' : '#B0B0A6',
          cursor: enabled ? 'pointer' : 'default', fontSize: '1.1rem', lineHeight: 1,
        });
        return (
          <div onClick={() => setSwapTarget(null)} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,18,12,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div onClick={e => e.stopPropagation()} style={{ width: 860, maxWidth: '94vw', display: 'flex', flexDirection: 'column', background: '#F4F0E6', borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.32)', overflow: 'hidden' }}>
              <div className="flex items-center justify-between" style={{ padding: '16px 22px 12px', flexShrink: 0 }}>
                <div>
                  <div style={{ fontFamily: IS, fontSize: '1.4rem', color: '#2A2A26', lineHeight: 1.1 }}>Swap {LAYER_INFO[swapTarget.layer].label.toLowerCase()}</div>
                  <div style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A8E' }}>{pool.length} {dbStyle} option{pool.length === 1 ? '' : 's'} for your zone</div>
                </div>
                <button onClick={() => setSwapTarget(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
              </div>
              {/* Horizontal tray: ‹ arrow · 4×2 square tiles · › arrow */}
              <div className="flex items-center" style={{ gap: 12, padding: '0 18px 18px' }}>
                {pageCount > 1 && (
                  <button onClick={() => setSwapPage(p => Math.max(0, p - 1))} disabled={page === 0} style={arrow(-1, page > 0)} title="Previous">‹</button>
                )}
                <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: '1fr', gap: 10 }}>
                  {visible.map(sp => {
                    const isCurrent = sp.id === current?.id, inUse = usedIds.has(sp.id);
                    const name = sp.common_name || sp.botanical_name;
                    return (
                      <button key={sp.id} disabled={inUse} onClick={() => applySwap(swapTarget.layer, swapTarget.idx, sp)}
                        className="transition-all hover:opacity-95 disabled:opacity-45"
                        style={{ position: 'relative', aspectRatio: '1 / 1', background: 'white', borderRadius: 12, overflow: 'hidden', cursor: inUse ? 'default' : 'pointer', border: `2px solid ${isCurrent ? GREEN : 'rgba(42,42,38,0.1)'}`, padding: 0 }}>
                        <div style={{ position: 'absolute', inset: 0 }}>
                          <PlantImage url={sp.image_url} kind={THUMB_KIND[swapTarget.layer]} seed={sp.id} />
                        </div>
                        {(isCurrent || inUse) && (
                          <span style={{ position: 'absolute', top: 7, right: 7, fontFamily: IT, fontSize: '0.62rem', fontWeight: 600, color: 'white', background: isCurrent ? GREEN : 'rgba(42,42,38,0.6)', borderRadius: 999, padding: '2px 7px' }}>{isCurrent ? 'Current' : 'In use'}</span>
                        )}
                        {/* Name overlaid on the image with a bottom scrim. */}
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 10px 8px', textAlign: 'left', background: 'linear-gradient(to top, rgba(20,18,12,0.72), rgba(20,18,12,0))' }}>
                          <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, color: 'white', lineHeight: 1.15, textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>{name}</div>
                          <div style={{ fontFamily: IT, fontSize: '0.68rem', color: 'rgba(255,255,255,0.82)' }}>{sp.sizeLabel}</div>
                        </div>
                      </button>
                    );
                  })}
                  {pool.length === 0 && (
                    <p style={{ gridColumn: '1 / -1', fontFamily: IT, fontSize: '0.85rem', color: '#9A9A8E', margin: 0, padding: '20px 4px' }}>No other options available for your style and zone.</p>
                  )}
                </div>
                {pageCount > 1 && (
                  <button onClick={() => setSwapPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} style={arrow(1, page < pageCount - 1)} title="More">›</button>
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
              </div>
              <div style={{ marginTop: '1.5rem', marginBottom: '0.9rem' }}>
                <h1 style={{ fontFamily: IS, fontSize: '4rem', color: INK, margin: '0.3rem 0 0', lineHeight: 1.05, fontWeight: 400 }}>
                  Your {yardType === 'back' ? 'backyard ' : yardType === 'front' ? 'front yard ' : ''}plan
                </h1>
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            {/* Accordion */}
            <div style={illustrative ? { paddingTop: 6 } : { borderTop: '1px solid rgba(42,42,38,0.08)' }}>
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

                const shortTitle = illustrative
                  ? ({ features: 'Features', details: 'Details', groundcover: 'Groundcovers', plants: 'Plants', privacy: 'Privacy' } as Partial<Record<StepId, string>>)[stepId] ?? STEP_TITLE[stepId]
                  : STEP_TITLE[stepId];
                // Per-section status chip (illustrative cards).
                const hasIssue = illustrative && stepId === 'details' && gapWarnings.length > 0;
                const chip = (() => {
                  if (!illustrative) return null;
                  if (hasIssue) return { text: `${gapWarnings.length} issue${gapWarnings.length !== 1 ? 's' : ''}`, tone: 'warn' as const };
                  if (stepId === 'features') {
                    const total = featureCards.length;
                    if (!total) return null;
                    return { text: `${total} feature${total !== 1 ? 's' : ''}`, tone: 'neutral' as const };
                  }
                  if (stepId === 'details') {
                    const added = paths.length + accentBeds.length;
                    const mat = defaultMaterial ? `${defaultMaterial.charAt(0).toUpperCase()}${defaultMaterial.slice(1)}` : null;
                    const parts = [mat, added ? `${added} added` : null].filter(Boolean);
                    return parts.length ? { text: parts.join(' · '), tone: 'neutral' as const } : null;
                  }
                  if (stepId === 'plants') return plantsLoaded ? { text: `${placedTotalSpecies} species · ${Object.keys(plantPositions).length} plants`, tone: 'neutral' as const } : { text: 'Choosing…', tone: 'neutral' as const };
                  return null;
                })();
                const cardBorder = !illustrative ? undefined : isOpen ? '#2F6B4F' : hasIssue ? '#D9A441' : 'rgba(42,42,38,0.12)';
                return (
                  <div key={stepId}
                    style={illustrative ? { margin: '0 18px 12px', border: `1.5px solid ${cardBorder}`, borderRadius: 14, background: hasIssue && !isOpen ? '#FBF4E2' : 'white', overflow: 'hidden' } : undefined}>
                    {idx > 0 && !illustrative && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}

                    {/* Section header — the plan's editable components, not sequential steps. */}
                    <button
                      className="w-full flex items-center gap-3 transition-all hover:opacity-80"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: illustrative ? '14px 16px' : '14px 20px' }}
                      onClick={() => setOpenStep(isOpen ? null : stepId)}>
                      {!illustrative && (
                        <div style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: isOpen ? '#2A2A26' : isDone ? '#2F6B4F' : 'rgba(42,42,38,0.1)',
                          color: (isOpen || isDone) ? 'white' : '#9A9A92',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: IT, fontSize: '0.73rem', fontWeight: 600, flexShrink: 0,
                        }}>
                          {isDone && !isOpen ? '✓' : idx + 1}
                        </div>
                      )}
                      <span style={{ fontFamily: IT, fontSize: illustrative ? '0.95rem' : '0.85rem', color: '#2A2A26', fontWeight: 600 }}>
                        {shortTitle}
                      </span>
                      {!illustrative && !isOpen && statusText && (
                        <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>{statusText}</span>
                      )}
                      {chip && (
                        <span className="ml-auto" style={{
                          fontFamily: IT, fontSize: '0.72rem', fontWeight: 600, flexShrink: 0,
                          ...(chip.tone === 'done' ? { color: '#2F6B4F', background: 'rgba(47,107,79,0.1)', borderRadius: 999, padding: '3px 10px' }
                            : chip.tone === 'warn' ? { color: '#8A5B14', background: '#F3E3BD', borderRadius: 999, padding: '3px 10px' }
                            : { color: '#9A9A92' }),
                        }}>{chip.text}</span>
                      )}
                      <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6', marginLeft: chip ? 8 : 'auto' }}>{isOpen ? '▾' : '▸'}</span>
                    </button>

                    {/* ── Features step ── */}
                    {stepId === 'features' && isOpen && illustrative && (
                      <div className="px-4 pb-4 pt-1">{guidedStepperPanel}</div>
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

                    {/* ── Details step (groundcover + walkways + creeks + accent beds) ── */}
                    {stepId === 'details' && isOpen && illustrative && (
                      <div className="px-7 pb-4 pt-1">{detailsPanel}</div>
                    )}

                    {/* ── Plants step ── */}
                    {stepId === 'plants' && isOpen && illustrative && (
                      <div className="px-7 pb-4 pt-5">{plantsPanel}</div>
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

          {/* Sidebar footer: issue strip + Finish (the strip lives inside stepNav). */}
          {illustrative && (
            <div className="flex-shrink-0" style={{ padding: '1rem 1.4rem 1.4rem', borderTop: '1px solid rgba(42,42,38,0.08)' }}>
              {stepNav}
            </div>
          )}

        </div>

        {/* ── Right: canvas (illustrative drawn plan, or satellite editor) ── */}
        <div className={illustrative ? 'flex-1 overflow-hidden relative' : 'flex-1 overflow-hidden'} style={illustrative ? undefined : { height: '81%' }}>
          {illustrative && (
            <>
              {/* Clean paper base — no graph grid; the plan reads as a finished illustration. */}
              <div style={{ position: 'absolute', inset: 0, backgroundColor: '#F7F4EC' }} />
              {/* Read-only street-view preview (top-left) — opens a modal; editing pauses while open. */}
              <button onClick={() => setShow3D(true)}
                className="absolute flex items-center gap-1.5 transition-all hover:opacity-90"
                style={{ top: 18, left: 18, zIndex: 11, background: '#2A2A26', color: '#efe9db', borderRadius: 999, padding: '9px 16px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)', fontFamily: IT, fontSize: '0.78rem', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                View street view
              </button>
              {/* Autosave status — sits just right of the street-view button; renders
                  nothing unless a signed-in user with an active design is editing. */}
              <div className="absolute" style={{ top: 20, left: 170, zIndex: 11 }}>
                <SaveStatusChip status={saveStatus} />
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
              {/* Global reset — revert the whole plan to the originally generated layout (confirms first). */}
              <button onClick={() => setShowResetConfirm(true)}
                title="Revert to the originally generated plan"
                className="absolute flex items-center gap-1.5 transition-all hover:opacity-90"
                style={{ top: 18, right: sunMap ? 136 : 18, zIndex: 11, borderRadius: 999, padding: '7px 14px', cursor: 'pointer',
                  fontFamily: IT, fontSize: '0.75rem', fontWeight: 600, background: 'white', color: '#2A2A26',
                  border: '1.5px solid rgba(42,42,38,0.16)', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
                ↺ Reset plan
              </button>
              {/* Reset confirmation screen — a blocking modal before the destructive revert. */}
              {showResetConfirm && (
                <div role="dialog" aria-modal="true" onClick={() => setShowResetConfirm(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(42,42,38,0.45)', padding: '1.5rem' }}>
                  <div onClick={e => e.stopPropagation()}
                    style={{ background: '#efe9db', borderRadius: 20, maxWidth: 420, width: '100%', padding: '2.2rem 2.2rem 1.8rem', boxShadow: '0 20px 60px rgba(0,0,0,0.28)', border: '1px solid rgba(42,42,38,0.08)' }}>
                    <h2 style={{ fontFamily: IS, fontSize: '2rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1, margin: 0 }}>Reset your plan?</h2>
                    <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#5A5A50', lineHeight: 1.5, margin: '0.9rem 0 1.6rem' }}>
                      This reverts every feature, bed, and walkway to the originally generated layout. All your edits will be lost.
                    </p>
                    <div className="flex flex-col" style={{ gap: '0.7rem' }}>
                      <button onClick={() => { resetToGenerated(); setShowResetConfirm(false); }} className="transition-all hover:opacity-90"
                        style={{ width: '100%', background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer', textAlign: 'center' }}>
                        Reset to generated plan
                      </button>
                      <button onClick={() => setShowResetConfirm(false)} className="transition-all hover:opacity-85"
                        style={{ width: '100%', background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer', textAlign: 'center' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {/* First-run tour — a short multi-step walkthrough over the plan (heatmap live behind the
                  sun step). The scrim covers only the plan, so the sidebar section each step opens stays
                  bright and visible beside the card. */}
              {inTour && onboardStep && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 50, padding: 24 }}>
                  <div className="absolute inset-0" style={{ background: 'rgba(20,18,12,0.30)' }} />
                  <div className="relative flex flex-col gap-4" style={{ width: 430, maxWidth: '94%', background: '#F4F0E6', borderRadius: 20, padding: '26px 30px 22px', boxShadow: '0 24px 80px rgba(0,0,0,0.35)' }}>
                    <div>
                      <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>{onboardStep.eyebrow} · {onboardIdx + 1} of {ONBOARD_STEPS.length}</span>
                      <h2 style={{ fontFamily: IS, fontSize: '1.65rem', color: '#2A2A26', margin: '6px 0 0', fontWeight: 400, lineHeight: 1.1 }}>{onboardStep.title}</h2>
                    </div>
                    <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>{onboardStep.intro}</p>
                    {onboardStep.intro2 && (
                      <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>{onboardStep.intro2}</p>
                    )}
                    {onboardStep.key === 'sun' && (
                      <>
                        {sunBrightPct != null && (
                          <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#2A2A26', margin: 0, fontWeight: 700 }}>{sunBrightPct}% of your yard gets full sun.</p>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <div style={{ height: 10, borderRadius: 999, background: 'linear-gradient(90deg, #5B7FA6, #A9B36E, #F4C542)' }} />
                          <div className="flex justify-between" style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', fontWeight: 500 }}>
                            <span>Shade (&lt;3 hrs)</span><span>Full sun (6+ hrs)</span>
                          </div>
                        </div>
                        <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', margin: 0, lineHeight: 1.55 }}>
                          Sunlight informs your feature and plant placement. View the sun layer at any time by hitting the <strong style={{ color: '#2A2A26' }}>☀ Sun layer</strong> button in the top right of your plan.
                        </p>
                      </>
                    )}
                    {onboardStep.bullets.length > 0 && (
                      <div className="flex flex-col gap-2" style={{ fontFamily: IT, fontSize: '0.85rem', color: '#6A6A60', lineHeight: 1.5 }}>
                        {onboardStep.bullets.map((b, i) => (
                          <div key={i} className="flex gap-2.5"><span style={{ flexShrink: 0 }}>{b.icon}</span><span>{b.text}</span></div>
                        ))}
                      </div>
                    )}
                    {/* Progress dots */}
                    <div className="flex items-center justify-center gap-1.5" style={{ marginTop: 2 }}>
                      {ONBOARD_STEPS.map((_, i) => (
                        <span key={i} style={{ width: i === onboardIdx ? 18 : 6, height: 6, borderRadius: 999, background: i === onboardIdx ? '#2F6B4F' : 'rgba(42,42,38,0.18)', transition: 'all 0.2s' }} />
                      ))}
                    </div>
                    {/* Navigation */}
                    <div className="flex items-center gap-2">
                      <button onClick={endTour} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9A9A92', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500 }}>Skip tour</button>
                      <div style={{ flex: 1 }} />
                      {onboardIdx > 0 && (
                        <button onClick={backOnboard} className="rounded-full transition-all hover:opacity-80"
                          style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer', padding: '9px 18px' }}>Back</button>
                      )}
                      <button onClick={nextOnboard} className="rounded-full transition-all hover:opacity-90"
                        style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, border: 'none', cursor: 'pointer', padding: '9px 20px' }}>
                        {onboardIdx >= ONBOARD_STEPS.length - 1 ? 'Start designing' : 'Next'}
                      </button>
                    </div>
                  </div>
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
                <IllustrativeSite width={cssSize.w} height={cssSize.h} animate={false} transform={illoXf} bare elevation={viewMode === 'illustration'} />
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
                {existing.filter(f => f.keep && f.vertices.length >= 3 && f.id !== selectedFeatureId).map((feat, i) => {
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
            {topBanner && !selectedFeature && (
              <div className="absolute px-5 py-2.5 rounded-2xl"
                style={{ top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', maxWidth: 'min(520px, calc(100% - 32px))', textAlign: 'center', lineHeight: 1.45 }}>
                {topBanner}
              </div>
            )}

            {/* Existing-feature correction card — shows when a detected feature is selected. */}
            {selectedFeature && (() => {
              const color     = FEATURE_COLOR[selectedFeature.type] ?? '#9A9A92';
              const typeLabel = selectedFeature.type.charAt(0).toUpperCase() + selectedFeature.type.slice(1);
              const orig = originalExistingRef.current.find(f => f.id === selectedFeature.id);
              const dirty = orig ? JSON.stringify(orig.vertices) !== JSON.stringify(selectedFeature.vertices) : false;
              return (
                <div className="absolute rounded-2xl"
                  style={{ top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 11, background: '#2A2A26', color: '#efe9db', fontFamily: IT, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', maxWidth: 'min(560px, calc(100% - 32px))', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{selectedFeature.label || typeLabel}</span>
                  <span style={{ fontSize: '0.76rem', color: '#c9c4b6', fontWeight: 500 }}>
                    Drag to move · drag a dot to reshape · corner to resize
                  </span>
                  <button
                    onClick={() => { if (orig && dirty) commitExisting(existingRef.current.map(f => f.id === selectedFeature.id ? { ...f, vertices: orig.vertices.map(v => [...v] as [number, number]) } : f)); }}
                    disabled={!dirty}
                    style={{ fontSize: '0.74rem', fontWeight: 600, color: dirty ? '#efe9db' : '#7a766c', background: dirty ? 'rgba(255,255,255,0.12)' : 'transparent', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8, padding: '4px 10px', cursor: dirty ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                    Reset
                  </button>
                  <button
                    onClick={() => { selFeatRef.current = null; setSelectedFeatureId(null); }}
                    style={{ fontSize: '0.9rem', fontWeight: 600, color: '#c9c4b6', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
                    aria-label="Done">✕</button>
                </div>
              );
            })()}


          </div>
        </div>

        </div>{/* card wrapper */}
      </div>

      {/* Fixed nav (satellite editor only — illustrative uses the sidebar footer) */}
      {!illustrative && (<>
      <BackButton onClick={() => navigate('/diy/boundary')} className="fixed bottom-8 left-10" />
      <button onClick={() => navigate('/diy/review')}
        className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
        style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
        Review your plan →
      </button>
      </>)}

      {/* Read-only illustration preview modal — the static rendered picture of the finished yard,
          mounted fresh on each open (so it reflects the latest saved plan) and unmounted on close.
          Editing is paused while it's open: it's a full-screen overlay, not an inline view. */}
      {show3D && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200, background: 'rgba(20,20,18,0.72)' }} onClick={() => setShow3D(false)}>
          <div className="relative" style={{ width: '92vw', height: '86vh', maxWidth: 1400, borderRadius: 20, overflow: 'hidden', background: '#f6f1e6', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }} onClick={e => e.stopPropagation()}>
            <YardIllustration />
            <button onClick={() => setShow3D(false)}
              className="absolute flex items-center justify-center transition-all hover:opacity-90"
              style={{ top: 16, right: 16, width: 38, height: 38, borderRadius: '50%', background: 'white', color: '#2A2A26', border: 'none', cursor: 'pointer', fontSize: '1.1rem', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }}>
              ✕
            </button>
            <div className="absolute" style={{ top: 18, left: 18, background: 'rgba(42,42,38,0.85)', color: '#efe9db', fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, padding: '7px 16px', borderRadius: 999 }}>
              Street view of your plan
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
