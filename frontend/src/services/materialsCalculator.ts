// Draft flow: turns the plan + plant instances into a build-it list — exact material quantities
// (mulch yards, flagstone sq ft, paver pads…), a priced plant list, and a weekend-by-weekend
// install phasing. All quantities derive from plan geometry; prices are rough retail estimates.
import type { PlantInstance } from './draftPlants';

export interface ShoppingItem {
  name: string;
  detail: string;      // e.g. "3 in deep over 640 sq ft"
  qty: string;         // e.g. "6 cu yd"
  costLow: number;
  costHigh: number;
  kind: 'material' | 'plant';
  color?: string;
}
export interface WeekendPhase {
  title: string;
  subtitle: string;
  tasks: string[];
  items: ShoppingItem[];
}
export interface BuildPlan {
  weekends: WeekendPhase[];
  allItems: ShoppingItem[];
  totalLow: number;
  totalHigh: number;
}

const ringArea = (r: [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
  return Math.abs(a / 2);
};
const pathLen = (pts: [number, number][]): number => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
const zoneArea = (z: any): number => z.ring?.length >= 3 ? ringArea(z.ring) : (z.shape === 'circle' ? (Math.PI / 4) * z.wFt * z.hFt : z.wFt * z.hFt);
const cuYd = (areaSf: number, depthIn: number) => Math.max(0.5, Math.ceil((areaSf * (depthIn / 12) / 27) * 2) / 2);

// Rough retail unit prices (USD). Ranges are shown to the user as estimates.
const PRICE: Record<string, [number, number]> = {
  mulchYd: [38, 55], rockYd: [70, 110], flagstoneSf: [4.5, 7], paverSf: [4, 8], concreteSf: [6, 10],
  gravelYd: [45, 70], sodSf: [0.5, 0.85], riverRockYd: [80, 120],
  tree: [90, 180], large_shrub: [35, 60], shrub: [14, 28], groundcover: [6, 12],
};
const POT: Record<string, string> = { tree: '15-gal', large_shrub: '5-gal', shrub: '1-gal', groundcover: '4-in' };

export function buildWeekendPlan(plan: any, instances: PlantInstance[]): BuildPlan {
  const mk = (name: string, detail: string, qty: string, unit: [number, number], units: number, kind: 'material' | 'plant' = 'material', color?: string): ShoppingItem =>
    ({ name, detail, qty, costLow: Math.round(unit[0] * units), costHigh: Math.round(unit[1] * units), kind, color });

  // Feature pads (seating/dining/fire etc. with a hard material).
  const padSf: Record<string, number> = {};
  for (const z of plan.zones || []) {
    if (z.key === 'lawn' || !z.material) continue;
    padSf[z.material] = (padSf[z.material] || 0) + zoneArea(z);
  }
  const MAT_LABEL: Record<string, string> = { pavers: 'Pavers', concrete: 'Concrete (bags/ready-mix)', flagstone: 'Flagstone', gravel: 'Gravel', mulch: 'Mulch', brick: 'Brick' };
  const padItems: ShoppingItem[] = Object.entries(padSf).map(([m, sf]) => {
    const a = Math.ceil(sf);
    if (m === 'gravel') return mk('Gravel (feature areas)', `3 in deep over ${a} sq ft`, `${cuYd(a, 3)} cu yd`, PRICE.gravelYd, cuYd(a, 3));
    const unit = m === 'concrete' ? PRICE.concreteSf : m === 'flagstone' ? PRICE.flagstoneSf : PRICE.paverSf;
    return mk(`${MAT_LABEL[m] || m} (feature areas)`, `${a} sq ft of pad`, `${a} sq ft`, unit, a);
  });

  // Walkways & dry creeks.
  const walkItems: ShoppingItem[] = [];
  let walkSf = 0, gravelWalkSf = 0, creekLen = 0;
  for (const p of plan.paths || []) {
    const area = pathLen(p.pts || []) * (p.widthFt || 3);
    if (p.kind === 'creek') { creekLen += pathLen(p.pts || []); continue; }
    if (p.material === 'gravel' || p.material === 'mulch') gravelWalkSf += area; else walkSf += area;
  }
  if (walkSf > 0) walkItems.push(mk('Flagstone / pavers (walkways)', `${Math.ceil(walkSf)} sq ft of path`, `${Math.ceil(walkSf)} sq ft`, PRICE.flagstoneSf, Math.ceil(walkSf)));
  if (gravelWalkSf > 0) walkItems.push(mk('Gravel (walkways)', `3 in deep over ${Math.ceil(gravelWalkSf)} sq ft`, `${cuYd(gravelWalkSf, 3)} cu yd`, PRICE.gravelYd, cuYd(gravelWalkSf, 3)));
  if (creekLen > 0) {
    const sf = creekLen * 1.5; // 1 ft bed + shoulders
    walkItems.push(mk('River rock (dry creek bed)', `${Math.round(creekLen)} ft run`, `${cuYd(sf, 3)} cu yd`, PRICE.riverRockYd, cuYd(sf, 3)));
  }

  // Ground cover (primary material over open ground) + lawn.
  const groundItems: ShoppingItem[] = [];
  const openSf = Math.max(0, Math.round(plan.primaryGroundAreaFt ?? estimateOpenGround(plan)));
  const primary = plan.primary?.material;
  if (primary === 'rock') groundItems.push(mk('Landscape rock (ground cover)', `2 in deep over ${openSf} sq ft`, `${cuYd(openSf, 2)} cu yd`, PRICE.rockYd, cuYd(openSf, 2)));
  else if (primary) groundItems.push(mk('Mulch (ground cover)', `3 in deep over ${openSf} sq ft`, `${cuYd(openSf, 3)} cu yd`, PRICE.mulchYd, cuYd(openSf, 3)));
  let lawnSf = 0;
  for (const z of plan.zones || []) if (z.key === 'lawn') lawnSf += zoneArea(z);
  if (lawnSf > 0) groundItems.push(mk('Sod', `${Math.ceil(lawnSf)} sq ft of lawn`, `${Math.ceil(lawnSf)} sq ft`, PRICE.sodSf, Math.ceil(lawnSf)));

  // Plants, grouped by species.
  const byName = new Map<string, { count: number; layer: string; color: string }>();
  for (const p of instances) {
    const cur = byName.get(p.name);
    if (cur) cur.count++; else byName.set(p.name, { count: 1, layer: p.layer, color: p.color });
  }
  const rank: Record<string, number> = { tree: 0, large_shrub: 1, shrub: 2, groundcover: 3 };
  const plantItems: ShoppingItem[] = [...byName.entries()]
    .sort((a, b) => (rank[a[1].layer] - rank[b[1].layer]) || b[1].count - a[1].count)
    .map(([name, v]) => mk(name, `${POT[v.layer] || ''} · ${v.layer.replace('_', ' ')}`, `× ${v.count}`, PRICE[v.layer] ?? [10, 30], v.count, 'plant', v.color));
  const treesLarge = plantItems.filter(p => /15-gal|5-gal/.test(p.detail));
  const smallPlants = plantItems.filter(p => !/15-gal|5-gal/.test(p.detail));

  const weekends: WeekendPhase[] = [
    {
      title: 'Weekend 1 — Lay out & build the bones',
      subtitle: 'Mark the plan on the ground, then build every hard surface.',
      tasks: [
        'Call 811 a few days ahead to mark utilities',
        'Paint or string the boundary, feature pads, and walkway lines from the plan',
        'Excavate pads and paths (3–4 in), lay base, set pavers / flagstone',
        ...(creekLen > 0 ? ['Trench and line the dry creek bed, set river rock'] : []),
      ],
      items: [...padItems, ...walkItems],
    },
    {
      title: 'Weekend 2 — Plant the structure',
      subtitle: 'Trees and large shrubs first — everything else arranges around them.',
      tasks: [
        'Set out trees and large shrubs in their pots per the plan; step back and adjust',
        'Dig holes 2× the root-ball width, plant, and build watering basins',
        'Deep-water everything the same day',
      ],
      items: treesLarge,
    },
    {
      title: 'Weekend 3 — Fill in & finish',
      subtitle: 'Small plants, ground cover, and the final dress layer.',
      tasks: [
        'Plant shrubs and groundcover in their drifts per the plan',
        ...(lawnSf > 0 ? ['Lay sod over the prepped lawn area'] : []),
        `Spread ${primary === 'rock' ? 'rock' : 'mulch'} across all open ground, keeping it off plant stems`,
        'Water everything in and set a watering schedule',
      ],
      items: [...smallPlants, ...groundItems],
    },
  ];

  const allItems = [...padItems, ...walkItems, ...treesLarge, ...smallPlants, ...groundItems];
  return {
    weekends,
    allItems,
    totalLow: allItems.reduce((s, i) => s + i.costLow, 0),
    totalHigh: allItems.reduce((s, i) => s + i.costHigh, 0),
  };
}

// Fallback open-ground estimate when the plan lacks primaryGroundAreaFt (fresh draft):
// project area − features − obstacles − path footprints.
function estimateOpenGround(plan: any): number {
  const bdy: [number, number][] = plan.boundary || [];
  if (bdy.length < 3) return 0;
  let open = ringArea(bdy);
  for (const z of plan.zones || []) open -= zoneArea(z);
  for (const o of plan.obstacles || []) if (o.length >= 3) open -= ringArea(o);
  for (const p of plan.paths || []) open -= pathLen(p.pts || []) * (p.widthFt || 3);
  return Math.max(0, open);
}
