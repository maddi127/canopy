// Draft flow: standalone plant pipeline — species selection (style + hardiness + sun aware) and
// deterministic placement over the draft plan's open ground. A compact port of the plants step in
// DiyPlacementPage, callable without the page. Persists `diyPlantInstances` so review/3D reuse it.
import * as turf from '@turf/turf';
import {
  selectTrees, selectLayer, mapStyle, STYLE_TOTAL_SPECIES, LAYER_SPECIES_TARGET,
  placePlan, isUnderPlanting, plantSunCats, densityParams,
  plantCapacity, cloneCapacity, pocketFits, consumePocket,
  TREE_CANOPY_COVERAGE_GOAL, SHADE_CANOPY_COVERAGE_GOAL,
  type Layer, type SpeciesCandidate, type SunCat, type PlantCapacity,
} from './plantSelectionService';
import { fetchHardinessZone } from '../features/sun/hardinessZone';
import { sampleSun, type SunMap } from './sunAnalysis';
import { buildCS, type DraftPlan, type Ring } from './draftPlan';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

export interface PlantInstance {
  x: number; y: number; name: string; layer: Layer;
  widthFt: number; heightFt: number; type: string; evergreen: boolean; color: string;
}
export interface DraftPlantResult {
  instances: PlantInstance[];
  species: { name: string; layer: Layer; count: number; color: string; sizeLabel: string }[];
}

// (SPECIES_WEIGHT percentage split retired — see LAYER_SPECIES_TARGET in plantSelectionService)
// Deterministic largest-remainder allocation of `total` across `weights`. Every positive-weight
// slot is floored at 1 when the budget allows (total >= #slots); when total < #slots only the
// highest-weight slots get a 1 (smallest-weight slots dropped last). No randomness. Shared by the
// layer-budget split (allocate) and the FIX A sun-region species split (seedPicks).
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

// Sun parsing is canonical in plantSelectionService — the old local copy here matched a legacy
// underscore vocabulary no DB row uses, so every plant read as ['full','part'] and shade was invisible.
const SUN_CATS: SunCat[] = ['full', 'part', 'shade'];
import { bloomColorFor } from '../lib/plantColors';

function closeR(r: Ring): Ring { const f = r[0], l = r[r.length - 1]; return (f[0] === l[0] && f[1] === l[1]) ? r : [...r, f]; }

// ── Mature-footprint clearance ────────────────────────────────────────────────────────────────
// HARD RULE — a plant's FULL mature footprint (radius rFt = matureWidth/2) must NEVER overlap a
// feature. All geometry is in FEET (plan space). Kept identical to the twin helper in
// pages/DiyPlacementPage.tsx (makePlantClearance) so both plant pipelines enforce the rule the same.
function ptInRingFt(px: number, py: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDistFt(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function ptToRingEdgeFt(x: number, y: number, ring: Ring): number {
  let min = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) min = Math.min(min, segDistFt(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  return min;
}
// Zone footprint: prefer the baked ring; else derive (ellipse for circle/organic, rect otherwise).
function zoneRingFt(z: any): Ring | null {
  if (z && z.ring && z.ring.length >= 3) return z.ring as Ring;
  if (z && z.verts && z.verts.length >= 3) return z.verts as Ring;
  if (!z || typeof z.xFt !== 'number' || typeof z.wFt !== 'number') return null;
  const x = z.xFt, y = z.yFt, w = z.wFt, h = z.hFt;
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  if (z.shape === 'circle' || z.shape === 'organic') {
    const r: Ring = []; for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } r.push(r[0]); return r;
  }
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}
// Returns clearOf(cx, cy, rFt) → false when any zone footprint, path corridor, or obstacle ring is
// nearer than rFt to the centre; a centre INSIDE any of them always fails (distance treated as 0).
function makePlantClearance(
  zones: any[],
  paths: { pts: [number, number][]; widthFt?: number }[],
  obstacleRings: Ring[],
): (cx: number, cy: number, rFt: number) => boolean {
  const zoneRings: Ring[] = [];
  for (const z of zones) { const r = zoneRingFt(z); if (r && r.length >= 3) zoneRings.push(r); }
  const corridors = paths.filter(p => (p.pts?.length ?? 0) >= 2).map(p => ({ pts: p.pts, hw: Math.max((p.widthFt || 3) / 2, 0) }));
  const distRing = (x: number, y: number, r: Ring): number => ptInRingFt(x, y, r) ? 0 : ptToRingEdgeFt(x, y, r);
  const distPoly = (x: number, y: number, pts: [number, number][]): number => {
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDistFt(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    return m;
  };
  return (cx: number, cy: number, rFt: number): boolean => {
    for (const r of zoneRings) if (distRing(cx, cy, r) < rFt) return false;
    for (const o of obstacleRings) if (distRing(cx, cy, o) < rFt) return false;
    for (const c of corridors) if (distPoly(cx, cy, c.pts) - c.hw < rFt) return false; // corridor edge
    return true;
  };
}

export async function buildDraftPlants(plan: DraftPlan): Promise<DraftPlantResult> {
  let saved: any = {}, prefs: any = {}, sc: any = {};
  try { saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { /* none */ }
  try { prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { /* none */ }
  try { sc = JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { /* none */ }
  const boundary: [number, number][] = saved.boundary || [];
  const existing: ConfirmedFeature[] = saved.confirmedFeatures || [];
  const empty: DraftPlantResult = { instances: [], species: [] };
  if (boundary.length < 3) return empty;

  const cs = buildCS(boundary);
  const sunMap: SunMap | null = plan.sunMap;
  const sunCatAt = (x: number, y: number): SunCat => {
    if (!sunMap) return 'full';
    const v = sampleSun(sunMap, x, y);
    return v >= 0.72 ? 'full' : v >= 0.45 ? 'part' : 'shade';
  };

  // Open planting ground (boundary − structures − placed features − paths) in feet.
  let ground: any = null;
  try {
    ground = turf.polygon([closeR(plan.boundary)]);
    const cut = (r: Ring) => { try { const d = turf.difference(ground, turf.polygon([closeR(r)])); if (d) ground = d; } catch { /* keep */ } };
    for (const f of existing) if (f.keep && f.type !== 'tree' && (f.vertices?.length ?? 0) >= 3) cut(f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring);
    for (const z of plan.zones) if (z.ring?.length >= 3) cut(z.ring);
  } catch { ground = null; }
  // Planar (feet²) area of the remaining ground — turf.area assumes lng/lat, so compute directly.
  const planarArea = (g: any): number => {
    if (!g) return 0;
    const polys = g.geometry.type === 'Polygon' ? [g.geometry.coordinates] : g.geometry.coordinates;
    let sum = 0;
    for (const poly of polys) {
      const outer = poly[0]; let a = 0;
      for (let i = 0; i < outer.length - 1; i++) a += outer[i][0] * outer[i + 1][1] - outer[i + 1][0] * outer[i][1];
      sum += Math.abs(a / 2);
    }
    return sum;
  };
  const openGround = planarArea(ground);

  // Capacity-first: measure the open pockets (per sun region + 'any' union) BEFORE selecting, so a
  // structural species that provably can't fit anywhere is never picked. Uses the same plantable
  // rule as placePlan (shared builder) so the two can never disagree. Deterministic + pure.
  const capacity: PlantCapacity = plantCapacity({
    boundary, existing,
    plan: { zones: plan.zones, beds: plan.beds, paths: plan.paths },
    sunAt: sunMap ? sunCatAt : undefined,
  });

  // Species selection (async: DB + hardiness zone).
  const dbStyle = mapStyle(prefs.style || '');
  const shade = Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('shade');
  let zone: number | undefined;
  if (typeof sc.lat === 'number' && typeof sc.lng === 'number') { try { zone = (await fetchHardinessZone(sc.lat, sc.lng))?.zone_number; } catch { /* none */ } }
  const [ts, ls, ms, gc] = await Promise.all([
    selectTrees({ prefsStyle: prefs.style || '', boundary, existing, projectAreaFt: undefined, zone, coverageGoal: shade ? SHADE_CANOPY_COVERAGE_GOAL : TREE_CANOPY_COVERAGE_GOAL, capacity }),
    selectLayer('large_shrub', { prefsStyle: prefs.style || '', zone }),
    selectLayer('shrub', { prefsStyle: prefs.style || '', zone }),
    selectLayer('groundcover', { prefsStyle: prefs.style || '', zone }),
  ]);

  // Sun categories present in the yard (sampled over the sun grid inside the boundary) AND their
  // area fractions. FIX A needs the fractions as WEIGHTS (they were previously discarded after the
  // ≥8% present-filter), so the dominant sun region gets a proportional share of the species budget.
  const { presentCats, catAreaPct } = ((): { presentCats: SunCat[]; catAreaPct: Record<SunCat, number> | null } => {
    if (!sunMap) return { presentCats: ['full', 'part'], catAreaPct: null };
    const cnt: Record<SunCat, number> = { full: 0, part: 0, shade: 0 };
    let tot = 0;
    for (let r = 0; r < sunMap.rows; r++) for (let c = 0; c < sunMap.cols; c++) {
      const v = sunMap.score[r * sunMap.cols + c]; if (v < 0) continue;
      cnt[v >= 0.72 ? 'full' : v >= 0.45 ? 'part' : 'shade']++; tot++;
    }
    if (!tot) return { presentCats: ['full', 'part'], catAreaPct: null };
    const pct: Record<SunCat, number> = { full: cnt.full / tot, part: cnt.part / tot, shade: cnt.shade / tot };
    return { presentCats: SUN_CATS.filter(cat => pct[cat] >= 0.08), catAreaPct: pct };
  })();

  // Explicit per-layer species targets (user-tuned: foundation carries the variety — the old
  // percentage split gave it only ~4 species). Mirrors the editor exactly.
  const shares = LAYER_SPECIES_TARGET[dbStyle];
  // FIX A (monoculture): pick species so each sun REGION gets variety proportional to its AREA
  // share — not just the old "≥1 compatible species per present category". Screenshot bug: a yard
  // whose dominant sun condition was ~90% of the ground had 5 shrub species picked but only 1 was
  // compatible with that condition, so that 1 blanketed the entire understory. Now the dominant
  // region receives a proportional slice of the budget from the highest-ranked compatible species.
  // Structural picks (large shrubs) CONSUME a pocket per chosen species from a shared working copy,
  // so choosing N big shrubs requires N pockets — a species with no remaining pocket in its region
  // is skipped before it can produce an unplaceable slot. Understory (shrub/groundcover) gets only a
  // cheap sanity screen (candidate radius ≤ the region's largest pocket): their many-small-plants
  // placement has no structural failure mode. Trees were already gated inside selectTrees ('any').
  const capWork = cloneCapacity(capacity);
  // grassCap: max ornamental-grass species (foundation layer) so a grass-heavy modern pool doesn't
  // fill the whole layer with grasses. A final uncapped pass still fills the budget if grasses are
  // all that's left. Mirrors DiyPlacementPage's seed().
  const seedPicks = (cands: SpeciesCandidate[], count: number, structural: boolean, grassCap = Infinity): SpeciesCandidate[] => {
    if (count <= 0) return [];
    const chosen: SpeciesCandidate[] = [], used = new Set<number>();
    const isGrass = (c: SpeciesCandidate) => c.type === 'ornamental grass';
    let grasses = 0;
    // Per-category weight = its area share (equal weight if no sun map). Allocate the species
    // budget across regions proportionally, then serve the biggest region first.
    const weights = presentCats.map(cat => (catAreaPct ? Math.max(0, catAreaPct[cat]) : 1));
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
        const r = c.matureWidthFt / 2;
        if (structural) { if (!consumePocket(capWork[cat], r)) continue; }   // no pocket left → skip
        else if (!pocketFits(capacity[cat], r)) continue;                    // sanity screen only
        chosen.push(c); used.add(c.id); need--; if (isGrass(c)) grasses++;
      }
      carry = Math.max(0, need); // thin data here → its remainder is redistributed to the next region
    }
    // Top up to the budget from the best remaining ranked candidates (category-agnostic) — keeps the
    // original "always try to fill the species budget" guarantee, still capacity-gated.
    const topUp = (respectCap: boolean) => {
      for (const c of cands) {
        if (chosen.length >= count) break;
        if (used.has(c.id)) continue;
        if (respectCap && isGrass(c) && grasses >= grassCap) continue;
        const r = c.matureWidthFt / 2;
        if (structural) { if (!consumePocket(capWork.any, r)) continue; }
        else if (!pocketFits(capacity.any, r)) continue;
        chosen.push(c); used.add(c.id); if (isGrass(c)) grasses++;
      }
    };
    topUp(true);   // prefer non-grass fills
    topUp(false);  // …but fill the budget with grasses rather than leave the layer short
    return chosen;
  };
  let picks: Record<Layer, SpeciesCandidate[]> = {
    tree: ts.candidates.slice(0, Math.min(ts.candidates.length, ts.targetToPlant === 0 ? 0 : Math.max(1, Math.min(shares[0], ts.targetToPlant)))),
    large_shrub: seedPicks(ls.candidates, Math.min(ls.candidates.length, shares[1]), true),
    shrub: seedPicks(ms.candidates, Math.min(ms.candidates.length, shares[2]), false, Math.ceil(Math.min(ms.candidates.length, shares[2]) / 2)),
    groundcover: seedPicks(gc.candidates, Math.min(gc.candidates.length, shares[3]), false),
  };

  // Instances: trees + large shrubs capped at 1/500 sf; shrubs/groundcover fill ground shares.
  const canopyR = (c: SpeciesCandidate) => Math.max(0.4, c.matureWidthFt / 2);
  const DRIFT: Record<string, number> = { shrub: 5, groundcover: 10 };
  const GROUND_SHARE: Record<string, number> = { shrub: 0.44, groundcover: 0.56 };
  // Density from prefs (the editor's slider persists here; default balanced) → coverage + packing.
  const density = densityParams(Number(prefs.plantDensity) || 1);
  type Slot = { id: string; layer: Layer; r: number; name: string; type: string; under: boolean; drift: string; tall: boolean; sun?: SunCat[] };
  const visualCap = Math.max(0, Math.floor(openGround / 500));

  // Slot generation for a given pick set — pure (no side effects), so the select-then-place loop can
  // rebuild it after each structural substitution. Trees + large shrubs are single/few individuals
  // capped at 1/500 sf; shrubs/groundcover fill ground shares as drifts.
  const buildSlots = (pk: Record<Layer, SpeciesCandidate[]>): Slot[] => {
    const slots: Slot[] = [];
    const treeN = Math.min(Math.max(ts.targetToPlant, pk.tree.length ? 1 : 0), visualCap);
    for (let i = 0; i < treeN && pk.tree.length; i++) {
      const sp = pk.tree[i % pk.tree.length];
      slots.push({ id: `tree-${i}`, layer: 'tree', r: canopyR(sp), name: sp.common_name || sp.botanical_name, type: sp.type, under: isUnderPlanting(sp), drift: `tree-${i}`, tall: false });
    }
    const largeN = Math.max(0, visualCap - treeN);
    if (pk.large_shrub.length && largeN > 0) {
      // FIX A consistency: distribute large shrubs across sun regions BY AREA (mirrors
      // DiyPlacementPage, which already does this — this twin previously used a flat round-robin that
      // under-represented the dominant region), cycling species within each region for variety.
      const catList: SunCat[] = [];
      if (catAreaPct) {
        // FIX 1 (mirrors DiyPlacementPage): largest-remainder split of the large-shrub budget across
        // present sun regions — never Math.round-to-zero — so every present category keeps ≥1 slot
        // when largeN allows. Previously a minority region could round to 0 and a species whose only
        // compatible region was that one got zero placement attempts.
        const quota = allocateProportional(largeN, presentCats.map(cat => Math.max(0, catAreaPct[cat])));
        presentCats.forEach((cat, i) => { for (let k = 0; k < quota[i]; k++) catList.push(cat); });
      }
      while (catList.length < largeN) catList.push(presentCats[catList.length % presentCats.length]);
      catList.length = largeN;
      const idx: Record<string, number> = {};
      catList.forEach((cat, li) => {
        const pool = pk.large_shrub.filter(sp => plantSunCats(sp.sun_requirement).includes(cat));
        const use = pool.length ? pool : pk.large_shrub;
        const j = idx[cat] ?? 0; idx[cat] = j + 1;
        const sp = use[j % use.length];
        slots.push({ id: `large-${cat}-${li}-0`, layer: 'large_shrub', r: canopyR(sp), name: sp.common_name || sp.botanical_name, type: sp.type, under: isUnderPlanting(sp), drift: `large-${cat}-${li}`, tall: sp.matureHeightFt >= 4, sun: pool.length ? [cat] : undefined });
      });
    }
    // Density as a PER-SPECIES count scale (mirrors the editor): each sun-bucket's full-density
    // drift budget splits equally among its species (equal split IS the anti-monoculture rule),
    // then each species' share scales by densityFrac flooring at 1 — every species appears at
    // every density. Clump SIZE also thins (members scale ~0.45→1.0) so sparse reads open.
    let d = 0;
    const densityFrac = density.coverage; // 0.30 (sparse) … 1.0 (lush)
    const memberCount = (driftN: number) => Math.max(2, Math.round(driftN * (0.45 + 0.55 * densityFrac)));
    for (const layer of (['shrub', 'groundcover'] as Layer[])) {
      if (!pk[layer].length || openGround <= 0) continue;
      const driftN = DRIFT[layer];
      for (const cat of presentCats) {
        const catSpecies = pk[layer].filter(sp => plantSunCats(sp.sun_requirement).includes(cat));
        if (!catSpecies.length) continue;
        const bucketAreaFull = openGround * GROUND_SHARE[layer] / presentCats.length; // full density
        if (bucketAreaFull <= 0) continue;
        const avgR = catSpecies.reduce((s, sp) => s + canopyR(sp), 0) / catSpecies.length;
        const fullDrifts = Math.max(catSpecies.length, Math.round(bucketAreaFull / (driftN * Math.PI * avgR * avgR)));
        const baseN = Math.floor(fullDrifts / catSpecies.length), extraN = fullDrifts % catSpecies.length;
        const mN = memberCount(driftN);
        catSpecies.forEach((sp, i) => {
          const speciesDrifts = Math.max(1, Math.round((baseN + (i < extraN ? 1 : 0)) * densityFrac));
          const r = canopyR(sp), name = sp.common_name || sp.botanical_name;
          for (let n = 0; n < speciesDrifts && slots.length < 360; n++) {
            const key = `${layer}-${cat}-${d}`;
            for (let k = 0; k < mN; k++) slots.push({ id: `${key}-${k}`, layer, r, name, type: sp.type, under: isUnderPlanting(sp), drift: key, tall: sp.matureHeightFt >= 4, sun: [cat] });
            d++;
          }
        });
      }
    }
    return slots;
  };

  // HARD RULE: a plant's full mature footprint must never overlap a feature. placePlan already
  // avoids these, but this is the authoritative guard — it also catches zones that reached the engine
  // without a baked ring. All feet space (positions, zone rings, path pts). Defined before the loop
  // so both the substitution check and the final emit judge "placed" by the same criterion.
  const obstacleRings: Ring[] = existing
    .filter(f => f.keep && (f.type === 'house' || f.type === 'structure' || f.type === 'hardscape') && (f.vertices?.length ?? 0) >= 3)
    .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as Ring);
  const clearOf = makePlantClearance(plan.zones || [], plan.paths || [], obstacleRings);

  // Deterministic placement (same engine as the studio's plants step).
  const focalSlots = Array.isArray((plan as any).focalSlots) ? (plan as any).focalSlots : undefined;
  const place = (slots: Slot[]): Record<string, { x: number; y: number }> => placePlan({
    boundary, existing,
    plan: { zones: plan.zones, beds: plan.beds, paths: plan.paths },
    instances: slots.map(s => ({ id: s.id, layer: s.layer, r: s.r, under: s.under, drift: s.drift, tall: s.tall, sun: s.sun, name: s.name, type: s.type })),
    sunAt: sunMap ? sunCatAt : undefined,
    focalSlots,
    packing: density.packing,
    massing: dbStyle === 'modern' ? 'row' : undefined,
  });

  // ── Iterative select-then-place loop (structural layers only) ───────────────────────────────
  // Mirrors DiyPlacementPage: after placement, any tree / large-shrub species with ZERO placed
  // instances (too big to legally fit — the Smooth-Sumac bug) is swapped for the smallest untried,
  // sun-compatible candidate from that layer's already style+zone-filtered pool, or DROPPED if the
  // pool is exhausted. Then re-slot + re-place, bounded to MAX_SUBST_ITERS deterministic passes.
  const MAX_SUBST_ITERS = 3;
  const structuralPools: Record<'tree' | 'large_shrub', SpeciesCandidate[]> = { tree: ts.candidates, large_shrub: ls.candidates };
  const tried = new Set<number>(); // candidate ids already tried & failed
  let slots = buildSlots(picks);
  let positions = place(slots);
  const isPlaced = (s: Slot): boolean => { const p = positions[s.id]; return !!p && clearOf(p.x, p.y, s.r); };
  for (let iter = 0; iter < MAX_SUBST_ITERS; iter++) {
    let changed = false;
    for (const layer of (['tree', 'large_shrub'] as ('tree' | 'large_shrub')[])) {
      // Per picked species in this layer: the sun regions its slots held + whether ANY instance placed.
      const info = new Map<string, { cats: Set<SunCat>; placed: boolean }>();
      for (const s of slots) {
        if (s.layer !== layer) continue;
        let e = info.get(s.name); if (!e) { e = { cats: new Set(), placed: false }; info.set(s.name, e); }
        (s.sun || []).forEach(c => e!.cats.add(c));
        if (isPlaced(s)) e.placed = true;
      }
      const pool = structuralPools[layer];
      const next: SpeciesCandidate[] = [];
      for (const sp of picks[layer]) {
        const name = sp.common_name || sp.botanical_name, e = info.get(name);
        if (!e || e.placed) { next.push(sp); continue; } // got no slot (budget) or placed fine → keep
        tried.add(sp.id);
        const exclude = new Set<number>([...picks[layer].map(c => c.id), ...tried]);
        const sub = pool
          .filter(c => !exclude.has(c.id))
          .filter(c => e.cats.size === 0 || plantSunCats(c.sun_requirement).some(cat => e.cats.has(cat)))
          .sort((a, b) => (a.matureWidthFt - b.matureWidthFt) || (a.id - b.id))[0];
        if (sub) next.push(sub); // substitute smaller species; else drop entirely (no phantom entry)
        changed = true;
      }
      picks = { ...picks, [layer]: next };
    }
    if (!changed) break;
    slots = buildSlots(picks);
    positions = place(slots);
  }

  // Colour per species — the DB bloom colour mapped to our palette (unique shade per species).
  const colorOf = new Map<string, string>();
  const spByName = new Map<string, SpeciesCandidate>();
  for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) spByName.set(sp.common_name || sp.botanical_name, sp);
  const ev = (v: any) => v === true || v === 'true' || v === 'TRUE' || v === 't';

  const instances: PlantInstance[] = [];
  for (const s of slots) {
    const p = positions[s.id]; if (!p) continue;
    if (!clearOf(p.x, p.y, s.r)) continue; // reject: mature footprint overlaps a feature
    const sp = spByName.get(s.name);
    if (!colorOf.has(s.name)) colorOf.set(s.name, bloomColorFor((sp as any)?.color, s.name));
    instances.push({ x: p.x, y: p.y, name: s.name, layer: s.layer, widthFt: sp ? sp.matureWidthFt : s.r * 2, heightFt: sp ? sp.matureHeightFt : 4, type: sp ? sp.type : '', evergreen: sp ? ev(sp.is_evergreen) : false, color: colorOf.get(s.name)! });
  }
  try { localStorage.setItem('diyPlantInstances', JSON.stringify(instances)); } catch { /* quota */ }

  const counts = new Map<string, { name: string; layer: Layer; count: number; color: string; sizeLabel: string }>();
  for (const inst of instances) {
    const cur = counts.get(inst.name);
    if (cur) cur.count++;
    else counts.set(inst.name, { name: inst.name, layer: inst.layer, count: 1, color: inst.color, sizeLabel: spByName.get(inst.name)?.sizeLabel ?? '' });
  }
  const rank: Record<string, number> = { tree: 0, large_shrub: 1, shrub: 2, groundcover: 3 };
  return { instances, species: [...counts.values()].sort((a, b) => (rank[a.layer] - rank[b.layer]) || b.count - a.count) };
}
