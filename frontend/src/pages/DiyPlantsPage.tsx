import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import BackButton from '../components/BackButton';
import DiyPlanMap, { type PlantMarker } from '../components/DiyPlanMap';
import {
  selectTrees, selectLayer, mapStyle, STYLE_TOTAL_SPECIES,
  PLANT_PACKING_EFFICIENCY, LAYER_QTY_PER_SPECIES, canopyFootprintFt, placePlan, isUnderPlanting,
  TREE_CANOPY_COVERAGE_GOAL, SHADE_CANOPY_COVERAGE_GOAL,
  type Layer, type TreeSelection, type LayerSelection, type SpeciesCandidate,
} from '../services/plantSelectionService';
import { fetchHardinessZone } from '../features/sun/hardinessZone';

import { IS, IT } from '../lib/theme';

const BG = '#E7E1D5'; // matches the placement page background
const DARK = '#2A2A26';

// Distribute `total` species across [tree, large_shrub, shrub, groundcover], at least one
// each, weighted toward the matrix layers so variety lives in shrubs/groundcover, not structure.
const SPECIES_WEIGHT = [0.15, 0.20, 0.35, 0.30]; // tree, large_shrub, shrub, groundcover
const allocate = (total: number): number[] => {
  const base = [1, 1, 1, 1];
  const rem = Math.max(0, total - 4);
  const raw = SPECIES_WEIGHT.map(w => w * rem);
  const fl = raw.map(Math.floor);
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
const STEPS: { title: string; sub: string; layers: Layer[] }[] = [
  { title: 'Foundation plants', sub: 'Trees and large shrubs — the structure everything else builds around.', layers: ['tree', 'large_shrub'] },
  { title: 'Shrubs',            sub: 'Medium and small shrubs that fill in between the foundation plants.', layers: ['shrub'] },
  { title: 'Groundcover',       sub: 'Low, spreading plants that cover the ground and tie the beds together.', layers: ['groundcover'] },
];
const THUMB: Record<Layer, 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'> = {
  tree: 'trees', large_shrub: 'large_shrub', shrub: 'small_shrub', groundcover: 'groundcover',
};

function PlantThumb({ kind, seed }: { kind: 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'; seed: number }) {
  const greens = ['#3d5c3a', '#4a7a50', '#5a7a50', '#6a9460'];
  const g = greens[seed % greens.length];
  return (
    <svg viewBox="0 0 200 130" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="200" height="130" fill="#e7eede" />
      {kind === 'trees' && (<><rect x="96" y="80" width="8" height="34" rx="2" fill="#8a6a4a" /><circle cx="100" cy="58" r="34" fill={g} /><circle cx="78" cy="68" r="20" fill={g} opacity="0.85" /><circle cx="122" cy="68" r="22" fill={g} opacity="0.9" /></>)}
      {kind === 'large_shrub' && (<><ellipse cx="80" cy="92" rx="34" ry="30" fill={g} /><ellipse cx="125" cy="88" rx="30" ry="34" fill={g} opacity="0.9" /></>)}
      {kind === 'small_shrub' && (<ellipse cx="100" cy="98" rx="40" ry="26" fill={g} />)}
      {kind === 'groundcover' && (<><ellipse cx="100" cy="108" rx="78" ry="16" fill={g} opacity="0.85" />{Array.from({ length: 7 }).map((_, i) => (<circle key={i} cx={28 + i * 24} cy={100 - (i % 2) * 6} r="7" fill={g} />))}</>)}
    </svg>
  );
}

const cardStyle: React.CSSProperties = { background: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(42,42,38,0.07)', width: 200, flexShrink: 0 };
function Card({ kind, seed, name, size, onSwap, onRemove }: { kind: 'trees' | 'large_shrub' | 'small_shrub' | 'groundcover'; seed: number; name: string; size: string; onSwap?: () => void; onRemove?: () => void }) {
  return (
    <div style={cardStyle}>
      <div style={{ position: 'relative', height: 130 }}>
        <PlantThumb kind={kind} seed={seed} />
        {onRemove && (
          <button onClick={onRemove} title="Remove" style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'rgba(42,42,38,0.55)', color: 'white', fontSize: '0.85rem', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        )}
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ fontFamily: IT, fontSize: '0.92rem', fontWeight: 600, color: DARK }}>{name}</div>
        <div style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A8E', marginBottom: 10 }}>{size}</div>
        {onSwap && (
          <button onClick={onSwap} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#3d5c3a', background: 'rgba(61,92,58,0.08)', border: '1.5px solid rgba(61,92,58,0.25)', borderRadius: 999, padding: '7px 0', cursor: 'pointer' }}>Swap species</button>
        )}
      </div>
    </div>
  );
}
const AddCard = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} style={{ width: 200, flexShrink: 0, minHeight: 130, borderRadius: 16, border: '1.5px dashed rgba(42,42,38,0.22)', background: 'rgba(42,42,38,0.02)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: '#7A7A6E', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500 }}>
    <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>+</span>Add another
  </button>
);

export default function DiyPlantsPage() {
  const navigate = useNavigate();
  const [openStep, setOpenStep] = useState(0); // which plant-type accordion step is expanded

  const prefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } }, []);
  const dbStyle = useMemo(() => mapStyle(prefs.style || ''), [prefs]);
  const shade = useMemo(() => Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('shade'), [prefs]);
  // Privacy screening requested? (goal priority OR edges/features marked on the placement page.)
  const wantsPrivacy = useMemo(() => {
    const goal = Array.isArray(prefs.goal_priority) && prefs.goal_priority.includes('privacy');
    let targets = false;
    try { const t = JSON.parse(localStorage.getItem('diyPrivacyTargets') || '[]'); targets = Array.isArray(t) && t.length > 0; } catch { /* none */ }
    return goal || targets;
  }, [prefs]);
  const budget = STYLE_TOTAL_SPECIES[dbStyle];
  const shares = useMemo(() => allocate(budget.target), [budget]); // [tree, large_shrub, shrub, groundcover]
  const address = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').address || ''; } catch { return ''; } }, []);

  const [treeSel, setTreeSel] = useState<TreeSelection | null>(null);
  const [layerSel, setLayerSel] = useState<Record<'large_shrub' | 'shrub' | 'groundcover', LayerSelection | null>>({ large_shrub: null, shrub: null, groundcover: null });
  const [picks, setPicks] = useState<Record<Layer, SpeciesCandidate[]>>({ tree: [], large_shrub: [], shrub: [], groundcover: [] });
  const [err, setErr] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const sc = JSON.parse(localStorage.getItem('siteContext') || '{}');
        let zone: number | undefined;
        if (typeof sc.lat === 'number' && typeof sc.lng === 'number') { try { zone = (await fetchHardinessZone(sc.lat, sc.lng))?.zone_number; } catch { /* no zone */ } }
        const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
        const plan = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
        const ps = prefs.style || '';
        const [ts, ls, ms, gc] = await Promise.all([
          selectTrees({ prefsStyle: ps, boundary: saved.boundary || [], existing: saved.confirmedFeatures || [], projectAreaFt: plan.projectAreaFt, zone, coverageGoal: shade ? SHADE_CANOPY_COVERAGE_GOAL : TREE_CANOPY_COVERAGE_GOAL, yardType: sc.yard_type ?? prefs.yard_type }),
          selectLayer('large_shrub', { prefsStyle: ps, zone }),
          selectLayer('shrub', { prefsStyle: ps, zone }),
          selectLayer('groundcover', { prefsStyle: ps, zone }),
        ]);
        if (!live) return;
        setTreeSel(ts);
        setLayerSel({ large_shrub: ls, shrub: ms, groundcover: gc });
        const nextPicks = {
          tree: ts.candidates.slice(0, Math.min(ts.candidates.length, ts.targetToPlant === 0 ? 0 : Math.max(1, Math.min(shares[0], ts.targetToPlant)))),
          large_shrub: ls.candidates.slice(0, Math.min(ls.candidates.length, shares[1])),
          shrub: ms.candidates.slice(0, Math.min(ms.candidates.length, shares[2])),
          groundcover: gc.candidates.slice(0, Math.min(gc.candidates.length, shares[3])),
        };
        setPicks(nextPicks);
        setLoaded(true);
      } catch { if (live) setErr(true); }
    })();
    return () => { live = false; };
  }, [prefs, shares, shade]);

  const poolFor = (l: Layer): SpeciesCandidate[] => l === 'tree' ? (treeSel?.candidates || []) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.candidates || []);
  const styleMatchedFor = (l: Layer): number => l === 'tree' ? (treeSel?.styleMatched ?? 0) : (layerSel[l as 'large_shrub' | 'shrub' | 'groundcover']?.styleMatched ?? 0);

  // Garden-wide species budget (variety).
  const total = LAYER_ORDER.reduce((s, l) => s + picks[l].length, 0);
  const atMax = total >= budget.max;

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
  }, []);
  const usable = plantable * PLANT_PACKING_EFFICIENCY;
  const hasSpace = plantable > 0;
  const treeAvgFoot = picks.tree.length ? picks.tree.reduce((s, t) => s + canopyFootprintFt(t.matureWidthFt), 0) / picks.tree.length : 0;
  const consumedTrees = treeSel ? treeSel.targetToPlant * treeAvgFoot : 0;
  const consumedLarge = picks.large_shrub.reduce((s, c) => s + LAYER_QTY_PER_SPECIES.large_shrub * canopyFootprintFt(c.matureWidthFt), 0);
  const structuralRoom = usable - consumedTrees - consumedLarge;
  const avgLargeFoot = (() => { const pool = poolFor('large_shrub'); return pool.length ? pool.reduce((s, c) => s + canopyFootprintFt(c.matureWidthFt), 0) / pool.length : canopyFootprintFt(8); })();
  const canAddLarge = !hasSpace || (structuralRoom - LAYER_QTY_PER_SPECIES.large_shrub * avgLargeFoot >= 0);

  const swap = (l: Layer, idx: number) => setPicks(prev => {
    const pool = poolFor(l); if (!pool.length) return prev;
    const cur = prev[l], shown = new Set(cur.map(c => c.id));
    const next = pool.find(c => !shown.has(c.id)) ?? pool[(pool.findIndex(c => c.id === cur[idx].id) + 1) % pool.length];
    const copy = [...cur]; copy[idx] = next; return { ...prev, [l]: copy };
  });
  const remove = (l: Layer, idx: number) => setPicks(prev => prev[l].length <= 1 ? prev : { ...prev, [l]: prev[l].filter((_, i) => i !== idx) });
  const add = (l: Layer) => setPicks(prev => {
    const pool = poolFor(l), shown = new Set(prev[l].map(c => c.id));
    const next = pool.find(c => !shown.has(c.id)); return next ? { ...prev, [l]: [...prev[l], next] } : prev;
  });

  const canAdd = (l: Layer) => !atMax && picks[l].length < poolFor(l).length && (l !== 'large_shrub' || canAddLarge);
  const layerRight = (l: Layer) => {
    if (l === 'tree' && treeSel) {
      if (treeSel.targetToPlant === 0) return picks.tree.length ? `${picks.tree.length} selected (override)` : 'None recommended';
      return `Aim for ${treeSel.targetToPlant} new ${treeSel.targetToPlant === 1 ? 'tree' : 'trees'}${treeSel.existingCounted ? ` · ${treeSel.existingCounted} existing` : ''}${shade ? ' · shade priority' : ''}`;
    }
    return `${picks[l].length} selected`;
  };

  // ── Placement on the map ─────────────────────────────────────────────────────
  const frontYard = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').yard_type === 'front'; } catch { return false; } }, []);
  const canopyR = (c: SpeciesCandidate) => Math.max(0.4, c.matureWidthFt / 2); // true mature half-width (to-scale)
  // Plant instances across every layer. Trees are individuals (each its own "drift" → no
  // clustering); shrubs & groundcover are planted as drifts of N per species.
  const DRIFT: Record<string, number> = { large_shrub: 1, shrub: 5, groundcover: 10 }; // plants per drift (large shrubs are specimens → planted singly)
  const COVERAGE_TARGET = 1.2; // overfill slightly; ground-tier spacing trims the excess so beds read full but not stacked. User-tunable later.
  // Share of the planted GROUND each layer occupies (a "massing budget"). Trees are overstory
  // and budgeted separately by canopy coverage. Sparse structure, groundcover-dominant matrix.
  const GROUND_SHARE: Record<string, number> = { large_shrub: 0.10, shrub: 0.40, groundcover: 0.50 };
  const FRONT_TALL_HEIGHT_FT = 4; // ground plants this tall+ are kept off the street-facing front edge
  type Slot = { id: string; layer: Layer; r: number; name: string; label: string; under: boolean; drift: string; tall: boolean };
  const slots = useMemo<Slot[]>(() => {
    const s: Slot[] = [];
    // Trees: individuals from the canopy-coverage target (each its own "drift"). If the user
    // overrides (adds trees when none were recommended), place at least one per picked species.
    const n = Math.max(treeSel?.targetToPlant ?? 0, picks.tree.length);
    for (let i = 0; i < n && picks.tree.length; i++) {
      const sp = picks.tree[i % picks.tree.length], name = sp.common_name || sp.botanical_name;
      s.push({ id: `tree-${i}`, layer: 'tree', r: canopyR(sp), name, label: name, under: isUnderPlanting(sp), drift: `tree-${i}`, tall: false }); // trees are overstory → fine at the front
    }
    // Ground tier: each layer fills to its share of the plantable area (drifts repeat to fill).
    // Shares of layers with no species selected redistribute across the rest.
    const groundLayers = (['large_shrub', 'shrub', 'groundcover'] as Layer[]).filter(l => picks[l].length);
    const shareSum = groundLayers.reduce((sum, l) => sum + GROUND_SHARE[l], 0) || 1;
    let d = 0;
    for (const layer of groundLayers) {
      if (plantable <= 0) break;
      const layerSpecies = picks[layer];
      const target = plantable * COVERAGE_TARGET * (GROUND_SHARE[layer] / shareSum);
      const driftN = DRIFT[layer] || 3;
      let acc = 0, j = 0, guard = 0;
      while (acc < target && guard < 200 && s.length < 360) {
        const sp = layerSpecies[j % layerSpecies.length], r = canopyR(sp), key = `${layer}-${d}`;
        const name = sp.common_name || sp.botanical_name, under = isUnderPlanting(sp);
        const tall = sp.matureHeightFt >= FRONT_TALL_HEIGHT_FT;
        for (let k = 0; k < driftN; k++) s.push({ id: `${key}-${k}`, layer, r, name, label: k === 0 ? name : '', under, drift: key, tall });
        acc += driftN * Math.PI * r * r;
        j++; d++; guard++;
      }
    }
    return s;
  }, [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover, treeSel, plantable]);

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const positionsRef = useRef(positions);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  // Auto-place whenever the slot set changes, preserving any positions the user dragged.
  useEffect(() => {
    if (!loaded) return;
    if (!slots.length) { setPositions({}); return; }
    const saved = (() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } })();
    const fixed: Record<string, { x: number; y: number }> = {};
    for (const s of slots) if (positionsRef.current[s.id]) fixed[s.id] = positionsRef.current[s.id];
    const plan = (() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } })();
    // Front grading is always on. Privacy screening (when built) will exempt only the marked
    // edges locally, rather than globally disabling grading. See [[planting-engine]].
    setPositions(placePlan({ boundary: saved.boundary || [], existing: saved.confirmedFeatures || [], plan: { zones: plan.zones || [], beds: plan.beds || [], paths: plan.paths || [] }, instances: slots.map(s => ({ id: s.id, layer: s.layer, r: s.r, under: s.under, drift: s.drift, tall: s.tall })), fixed }));
  }, [slots, loaded, wantsPrivacy]);

  // Distinct colour per species (shown in the legend instead of map labels).
  const speciesColor = useMemo(() => {
    const PALETTE = ['#3d5c3a', '#6a9460', '#4a7a50', '#8aa06a', '#5c8a5c', '#a7b56a', '#7a9a4a', '#386b4a', '#9caf5a', '#6b8e3a', '#5a7a50', '#b0a04a'];
    const m = new Map<string, string>(); let i = 0;
    for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) {
      const name = sp.common_name || sp.botanical_name;
      if (!m.has(name)) m.set(name, PALETTE[i++ % PALETTE.length]);
    }
    return m;
  }, [picks.tree, picks.large_shrub, picks.shrub, picks.groundcover]);
  const legend = useMemo(() => [...speciesColor.entries()].map(([name, color]) => ({ name, color })), [speciesColor]);

  const markers: PlantMarker[] = slots.filter(s => positions[s.id]).map(s => ({ id: s.id, x: positions[s.id].x, y: positions[s.id].y, r: s.r, kind: s.layer, label: '', underPlanting: s.under, color: speciesColor.get(s.name), drift: s.drift, name: s.name }));
  const [highlightName, setHighlightName] = useState<string | null>(null);

  // Persist placed instances (+ species data) so the 3D view can render the exact plan.
  useEffect(() => {
    if (!loaded) return;
    const byName = new Map<string, SpeciesCandidate>();
    for (const sp of [...picks.tree, ...picks.large_shrub, ...picks.shrub, ...picks.groundcover]) byName.set(sp.common_name || sp.botanical_name, sp);
    const ev = (v: any) => v === true || v === 'true' || v === 'TRUE' || v === 't';
    const instances = slots.filter(s => positions[s.id]).map(s => {
      const sp = byName.get(s.name);
      return { x: positions[s.id].x, y: positions[s.id].y, name: s.name, layer: s.layer, widthFt: sp ? sp.matureWidthFt : s.r * 2, heightFt: sp ? sp.matureHeightFt : 4, type: sp ? sp.type : '', evergreen: sp ? ev(sp.is_evergreen) : false, color: (sp as any)?.color || '' };
    });
    try { localStorage.setItem('diyPlantInstances', JSON.stringify(instances)); } catch { /* ignore */ }
  }, [positions, slots, speciesColor, loaded, picks.tree, picks.large_shrub, picks.shrub, picks.groundcover]);
  const onPlantMove = (id: string, x: number, y: number) => setPositions(prev => ({ ...prev, [id]: { x, y } }));
  // Species where no instance could be placed fully inside the boundary (too big for the space).
  const droppedSpecies = useMemo(() => {
    const byName = new Map<string, boolean>(); // name → placed anywhere?
    for (const s of slots) byName.set(s.name, (byName.get(s.name) || false) || !!positions[s.id]);
    return [...byName.entries()].filter(([, placed]) => !placed).map(([name]) => name);
  }, [slots, positions]);
  const planForMap = useMemo(() => { try { const p = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); return { zones: p.zones || [], beds: p.beds || [], paths: p.paths || [], primary: p.primary || { material: null, variant: null } }; } catch { return { zones: [], beds: [], paths: [], primary: { material: null, variant: null } }; } }, []);

  const renderLayer = (l: Layer) => (
    <section key={l} style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <h3 style={{ fontFamily: IT, fontSize: '0.9rem', fontWeight: 600, color: DARK, margin: 0 }}>{LAYER_INFO[l].label}</h3>
        <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A9A8E' }}>{LAYER_INFO[l].sub}</span>
        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#B0B0A2', marginLeft: 'auto' }}>{loaded || treeSel ? layerRight(l) : 'Loading…'}</span>
      </div>
      {loaded && picks[l].length === 0 && (
        <p style={{ fontFamily: IT, fontSize: '0.88rem', color: '#9A9A8E', margin: 0, lineHeight: 1.5, maxWidth: 520 }}>
          {l === 'tree' && treeSel && treeSel.targetToPlant === 0
            ? `Based on your project size, we don't think you need any more trees.`
            : styleMatchedFor(l) === 0
              ? `No ${dbStyle} ${LAYER_INFO[l].label.toLowerCase()} in the database.`
              : 'None selected — add one below.'}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        {picks[l].map((sp, idx) => (
          <Card key={sp.id} kind={THUMB[l]} seed={sp.id} name={sp.common_name || sp.botanical_name} size={sp.sizeLabel}
            onSwap={() => swap(l, idx)} onRemove={picks[l].length > 1 ? () => remove(l, idx) : undefined} />
        ))}
        {l === 'tree' && treeSel && treeSel.targetToPlant === 0 && picks.tree.length === 0 ? (
          <button onClick={() => add('tree')}
            className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:opacity-80 transition-all"
            style={{ width: '100%', background: 'rgba(42,42,38,0.04)', border: '1.5px dashed rgba(42,42,38,0.18)', cursor: 'pointer', marginTop: 4 }}>
            <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500 }}>Add one anyways — I want more shade</span>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#2A2A26', color: '#efe9db', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}>+</span>
          </button>
        ) : (
          canAdd(l) && <AddCard onClick={() => add(l)} />
        )}
      </div>
    </section>
  );

  // Draggable split — widen the toolbar over the map. Map keeps a fixed placement-sized height.
  // The toolbar can never be narrower than the /placement sidebar (33% of the row).
  const mapH = 'clamp(360px, calc(100vh - 21rem), 620px)';
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowW, setRowW] = useState(0);
  useEffect(() => {
    const el = rowRef.current; if (!el) return;
    const obs = new ResizeObserver(([e]) => setRowW(e.contentRect.width));
    obs.observe(el); return () => obs.disconnect();
  }, []);
  const minToolbarW = rowW ? Math.round(rowW * 0.33) : 360;
  const [toolbarW, setToolbarW] = useState(0);
  const effToolbarW = Math.max(toolbarW, minToolbarW);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = effToolbarW;
    const move = (ev: MouseEvent) => {
      const w = rowRef.current?.clientWidth ?? rowW ?? 1000;
      setToolbarW(Math.max(Math.round(w * 0.33), Math.min(w - 60, startW + (ev.clientX - startX))));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  };

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: IT }}>
      {/* Header */}
      <div className="flex items-start justify-between px-10" style={{ paddingTop: '2rem' }}>
        <Logo />
      </div>

      {/* Title */}
      <div style={{ paddingLeft: '8rem', paddingRight: '8rem', marginTop: '2rem', marginBottom: '2.5rem' }}>
        <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>Select your plants</h1>
      </div>

      <div style={{ paddingLeft: '8rem', paddingRight: '4rem', paddingBottom: '7rem' }}>
        {err && <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#9A6A2A', margin: '0 0 16px' }}>Couldn't reach the plant database — check your connection or that the table is readable.</p>}

        <div ref={rowRef} style={{ display: 'flex', alignItems: 'flex-start' }}>
          {/* Left toolbar — plant selection accordion (drag the handle to widen) */}
          <div style={{ flex: `0 0 ${effToolbarW}px`, height: mapH, overflowY: 'auto', background: '#EFE9DA', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.10)' }}>
            {STEPS.map((s, i) => {
              const isOpen = openStep === i;
              const count = s.layers.reduce((a, l) => a + picks[l].length, 0);
              return (
                <div key={s.title}>
                  {i > 0 && <div style={{ borderTop: '1px solid rgba(42,42,38,0.1)' }} />}
                  <button onClick={() => setOpenStep(isOpen ? -1 : i)}
                    className="w-full flex items-center gap-3 px-5 py-3.5 transition-all hover:opacity-80"
                    style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: isOpen ? '#2A2A26' : 'rgba(42,42,38,0.1)', color: isOpen ? 'white' : '#9A9A92', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: IT, fontSize: '0.73rem', fontWeight: 600, flexShrink: 0 }}>{i + 1}</div>
                    <span style={{ fontFamily: IT, fontSize: '0.85rem', color: '#2A2A26', fontWeight: 500 }}>{s.title}</span>
                    {!isOpen && count > 0 && <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#9A9A92', marginLeft: 2 }}>— {count} selected</span>}
                    <span className="ml-auto" style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6' }}>{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
                      {s.layers.map(l => renderLayer(l))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Drag handle — widen the toolbar over the map */}
          <div onMouseDown={startResize} title="Drag to resize" style={{ flexShrink: 0, width: 20, height: mapH, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 4, height: 46, borderRadius: 2, background: 'rgba(42,42,38,0.25)' }} />
          </div>

          {/* Right — placement map */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <DiyPlanMap plan={planForMap} plants={markers} onPlantMove={onPlantMove} height={mapH}
              highlightName={highlightName} onPlantSelect={setHighlightName} showFront={!wantsPrivacy}
              topBanner={
                <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#efe9db', background: '#2A2A26', borderRadius: 999, padding: '8px 18px', textAlign: 'center', lineHeight: 1.4, boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}>
                  Drag plants to edit their placement. The circle represents the plant's size at maturity.
                </div>
              }
              bottomBanner={
                <div style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 500, color: '#7a5326', background: '#FBF1E2', border: '1.5px solid rgba(199,123,43,0.55)', borderRadius: 16, padding: '8px 16px', textAlign: 'center', lineHeight: 1.4, boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}>
                  ⚠️ Mind utilities — call 811 before planting. Keep large trees off the house{frontYard ? ' and the street edge' : ''} (outlined amber).
                </div>
              } />
            {legend.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', margin: '12px 2px 0' }}>
                {legend.map(l => {
                  const active = highlightName === l.name;
                  return (
                    <button key={l.name} onClick={() => setHighlightName(active ? null : l.name)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: IT, fontSize: '0.78rem', color: '#3a3a32', cursor: 'pointer', border: 'none', borderRadius: 999, padding: '3px 9px', background: active ? 'rgba(42,42,38,0.10)' : 'transparent', opacity: highlightName && !active ? 0.5 : 1, transition: 'opacity .12s, background .12s' }}>
                      <span style={{ width: 12, height: 12, borderRadius: '50%', background: l.color, flexShrink: 0 }} />
                      {l.name}
                    </button>
                  );
                })}
              </div>
            )}
            {droppedSpecies.length > 0 && (
              <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#9A6A2A', margin: '8px 2px 0', lineHeight: 1.45 }}>
                ⚠ {droppedSpecies.join(', ')} {droppedSpecies.length > 1 ? "don't" : "doesn't"} fit fully inside your yard — swap for a smaller species or remove.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Fixed nav — matches the placement / boundary pages */}
      <BackButton onClick={() => navigate('/diy/review')}
        className="fixed bottom-8 left-10" />
      <div className="fixed bottom-8 right-10 flex items-center gap-3">
        <button onClick={() => navigate('/diy/yard-3d')}
          className="flex items-center gap-2 px-6 py-3.5 rounded-full transition-all hover:opacity-80"
          style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.14)', cursor: 'pointer' }}>
          View in 3D ↗
        </button>
        <button onClick={() => navigate('/diy/review')}
          className="flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
          style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          Done →
        </button>
      </div>
    </div>
  );
}
