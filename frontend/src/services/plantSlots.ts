/**
 * buildPlantSlots — the ONE plant-instance builder. Turns a selected pick set + the yard's context
 * (plantable area, sun-region shares, density) into the flat list of plant instances ("slots") that
 * placePlan then positions. Both the interactive editor (DiyPlacementPage) and the "plan is ready"
 * preview (draftPlants) call this, so the preview a user sees is exactly the plan they'll edit.
 *
 * Previously this logic was duplicated — plantSlots in DiyPlacementPage and buildSlots in draftPlants —
 * and the two drifted (different drift counts, ground shares, structural budgets, no clumping in the
 * preview), so the two views showed different plans. This module is now the single source of truth;
 * placePlan was already shared, so together they fully determine the plan.
 *
 * Pure and deterministic: no randomness, no side effects — safe to call repeatedly (the select-then-
 * place substitution loops rebuild slots after each swap).
 */
import {
  type SpeciesCandidate, type Layer, type SunCat, plantSunCats, isUnderPlanting,
} from './plantSelectionService';

const SUN_CATS: SunCat[] = ['full', 'part', 'shade'];

// Largest-remainder allocation of `total` across weighted buckets (never rounds a present bucket to 0
// when total allows). Copied from the editor so the two produce identical splits.
function allocateProportional(total: number, weights: number[]): number[] {
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
}

const canopyR = (c: SpeciesCandidate) => Math.max(0.4, c.matureWidthFt / 2);
// Groundcover drifts read as clumps (7 members), not a wall-to-wall blanket.
const DRIFT: Record<string, number> = { large_shrub: 1, shrub: 5, groundcover: 7 };
// Ground area tilted toward mid-height shrubs so the understory has body, not carpet. large_shrub's
// share here is unused — large shrubs run off their own structural budget below.
const GROUND_SHARE: Record<string, number> = { large_shrub: 0.10, shrub: 0.50, groundcover: 0.40 };
// Structural budgets, DECOUPLED: trees stay sparse (overstory, 1 per 500 sf); large shrubs are the
// foundation/anchor layer and pack far denser (1 per 175 sf) so real structure builds under the canopy.
const TREE_SF_PER_PLANT = 500;
const LARGE_SHRUB_SF_PER_PLANT = 175;
const FRONT_TALL_HEIGHT_FT = 4;

export interface PlantSlot {
  id: string;
  layer: Layer;
  r: number;
  name: string;
  type: string;
  under: boolean;
  drift: string;
  tall: boolean;
  sun?: SunCat[];
}

export interface BuildPlantSlotsParams {
  picks: Record<Layer, SpeciesCandidate[]>;
  treeTargetToPlant: number;                    // recommended new trees (selectTrees.targetToPlant)
  plantableFt: number;                          // plantable ground area (beds + primary groundcover)
  catAreaPct: Record<SunCat, number> | null;    // sun-region area shares; null → whole yard, unconstrained
  densityCoverage: number;                      // densityParams(slider).coverage — 0.30 (sparse) … 1.0 (lush)
}

export function buildPlantSlots({ picks, treeTargetToPlant, plantableFt, catAreaPct, densityCoverage }: BuildPlantSlotsParams): PlantSlot[] {
  const s: PlantSlot[] = [];
  const cats: (SunCat | null)[] = catAreaPct ? SUN_CATS.filter(c => catAreaPct[c] > 0.01) : [null];
  const treeCap  = Math.max(0, Math.floor(plantableFt / TREE_SF_PER_PLANT));
  const largeCap = Math.max(0, Math.floor(plantableFt / LARGE_SHRUB_SF_PER_PLANT));

  // Trees first (overstory, not sun-constrained). Recommended trees draw from the tree budget; trees the
  // user ADDS beyond the recommendation are placed on TOP of the cap, so a manual tree never evicts a shrub.
  const treeAuto = Math.min(treeTargetToPlant, treeCap);
  const treeOverride = Math.max(0, picks.tree.length - treeTargetToPlant);
  const treeN = treeAuto + treeOverride;
  for (let i = 0; i < treeN && picks.tree.length; i++) {
    const sp = picks.tree[i % picks.tree.length], name = sp.common_name || sp.botanical_name;
    s.push({ id: `tree-${i}`, layer: 'tree', r: canopyR(sp), name, type: sp.type, under: isUnderPlanting(sp), drift: `tree-${i}`, tall: false });
  }

  // Large shrubs run off their OWN (denser) budget, distributed across sun regions by area, cycling
  // picked species. Focal massing: a broad shrub (> 2 ft wide) stands alone; a narrow one (≤ 2 ft — e.g.
  // an upright grass) is planted as a tight clump of 2–3 (one shared drift) so the GROUP reads as one
  // focal mass rather than a lone stick — and the clump still counts as ONE anchor against largeN.
  const largeN = largeCap;
  if (picks.large_shrub.length && largeN > 0) {
    const catList: (SunCat | null)[] = [];
    if (catAreaPct) {
      const presentSun = cats as SunCat[];
      const quota = allocateProportional(largeN, presentSun.map(c => Math.max(0, catAreaPct[c])));
      presentSun.forEach((c, i) => { for (let k = 0; k < quota[i]; k++) catList.push(c); });
    }
    while (catList.length < largeN) catList.push((cats[catList.length % cats.length]) ?? null);
    catList.length = largeN;
    const speciesIdx: Record<string, number> = {};
    catList.forEach((cat, li) => {
      const pool = cat ? picks.large_shrub.filter(sp => plantSunCats(sp.sun_requirement).includes(cat)) : picks.large_shrub;
      if (!pool.length) return;
      const key = cat ?? 'x'; const idx = speciesIdx[key] ?? 0; speciesIdx[key] = idx + 1;
      const sp = pool[idx % pool.length], drift = `large-${key}-${li}`;
      const clumpN = sp.matureWidthFt > 2 ? 1 : Math.max(2, Math.min(3, Math.round(4.5 / Math.max(0.5, sp.matureWidthFt))));
      for (let m = 0; m < clumpN; m++)
        s.push({ id: `${drift}-${m}`, layer: 'large_shrub', r: canopyR(sp), name: sp.common_name || sp.botanical_name, type: sp.type, under: isUnderPlanting(sp), drift, tall: sp.matureHeightFt >= FRONT_TALL_HEIGHT_FT, sun: cat ? [cat] : undefined });
    });
  }

  // Understory (shrubs + groundcover): fill a share of the ground, split by sun region. Density scales the
  // per-species drift COUNT (every selected species appears at every density) and the clump SIZE (members
  // thin ~0.45→1.0) so sparse reads as smaller clumps of everything, not blankets that survive while
  // shrub species vanish.
  const groundLayers = (['shrub', 'groundcover'] as Layer[]).filter(l => picks[l].length);
  const shareSum = groundLayers.reduce((sum, l) => sum + GROUND_SHARE[l], 0) || 1;
  let d = 0;
  const densityFrac = densityCoverage;
  const memberCount = (driftN: number) => Math.max(2, Math.round(driftN * (0.45 + 0.55 * densityFrac)));
  for (const layer of groundLayers) {
    if (plantableFt <= 0) break;
    const driftN = DRIFT[layer] || 3;
    for (const cat of cats) {
      const catSpecies = cat ? picks[layer].filter(sp => plantSunCats(sp.sun_requirement).includes(cat)) : picks[layer];
      if (!catSpecies.length) continue;
      const catShare = cat && catAreaPct ? catAreaPct[cat] : 1;
      const bucketAreaFull = plantableFt * (GROUND_SHARE[layer] / shareSum) * catShare; // at full density
      if (bucketAreaFull <= 0) continue;
      const avgR = catSpecies.reduce((sum, sp) => sum + canopyR(sp), 0) / catSpecies.length;
      const fullDrifts = Math.max(catSpecies.length, Math.round(bucketAreaFull / (driftN * Math.PI * avgR * avgR)));
      const baseN = Math.floor(fullDrifts / catSpecies.length), extraN = fullDrifts % catSpecies.length;
      const mN = memberCount(driftN);
      catSpecies.forEach((sp, i) => {
        const speciesDrifts = Math.max(1, Math.round((baseN + (i < extraN ? 1 : 0)) * densityFrac));
        const r = canopyR(sp), name = sp.common_name || sp.botanical_name;
        const under = isUnderPlanting(sp), tall = sp.matureHeightFt >= FRONT_TALL_HEIGHT_FT;
        for (let n = 0; n < speciesDrifts && s.length < 360; n++) {
          const key = `${layer}-${cat ?? 'x'}-${d}`;
          for (let k = 0; k < mN; k++) s.push({ id: `${key}-${k}`, layer, r, name, type: sp.type, under, drift: key, tall, sun: cat ? [cat] : undefined });
          d++;
        }
      });
    }
  }
  return s;
}
