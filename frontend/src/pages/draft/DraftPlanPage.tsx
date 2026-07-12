// Draft flow S4 — the reveal + simplified editing. A complete draft (features, materials, plants)
// renders immediately; the sidebar offers the handful of dials that matter (style, features, lawn,
// shuffle). Deep edits hand off to the full studio, which preserves this exact plan.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../../components/Logo';
import PlanSnapshot from '../../components/PlanSnapshot';
import { generateDraftPlan, type DraftPlan } from '../../services/draftPlan';
import { buildDraftPlants, type DraftPlantResult } from '../../services/draftPlants';

const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

const FEATURES = [
  { id: 'seating', label: 'Seating' }, { id: 'dining', label: 'Dining' },
  { id: 'cooking', label: 'Fire / cooking' }, { id: 'water', label: 'Water feature' },
  { id: 'garden', label: 'Veggie garden' }, { id: 'storage', label: 'Storage' },
];
const STYLES = [
  { id: 'natural_wild', label: 'Whimsical' }, { id: 'modern_structured', label: 'Modern' },
  { id: 'traditional', label: 'Traditional' }, { id: 'desert_minimal', label: 'Desert' },
];
const LAWNS = [
  { id: 0, label: 'No lawn' }, { id: 0.33, label: 'Some lawn' }, { id: 0.67, label: 'Big lawn' },
];

export default function DraftPlanPage() {
  const navigate = useNavigate();
  const sc = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const initialPrefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } }, []);

  const [style, setStyle] = useState<string>(initialPrefs.style || 'traditional');
  const [feats, setFeats] = useState<string[]>(Array.isArray(initialPrefs.space_usage) ? initialPrefs.space_usage : ['seating']);
  const [lawn, setLawn] = useState<number>(typeof initialPrefs.lawnTarget === 'number' ? initialPrefs.lawnTarget : 0.33);
  const [seed, setSeed] = useState(1);

  const [plan, setPlan] = useState<DraftPlan | null>(null);
  const [plants, setPlants] = useState<DraftPlantResult>({ instances: [], species: [] });
  const [building, setBuilding] = useState(true);
  const runRef = useRef(0);

  // (Re)generate the whole draft — layout sync, plants async. Deterministic per (inputs, seed).
  const regenerate = useCallback(async (s: string, f: string[], l: number, sd: number) => {
    const run = ++runRef.current;
    setBuilding(true);
    try {
      const prev = (() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } })();
      localStorage.setItem('userPreferences', JSON.stringify({ ...prev, style: s, space_usage: f, lawnTarget: l }));
    } catch { /* ignore */ }
    const draft = generateDraftPlan(sd);
    if (runRef.current !== run) return;
    setPlan(draft);
    if (draft) {
      try {
        const result = await buildDraftPlants(draft);
        if (runRef.current !== run) return;
        setPlants(result);
      } catch { setPlants({ instances: [], species: [] }); }
    }
    if (runRef.current === run) setBuilding(false);
  }, []);

  useEffect(() => {
    const saved = (() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } })();
    if (!Array.isArray(saved.boundary) || saved.boundary.length < 3) { navigate('/draft'); return; }
    regenerate(style, feats, lawn, seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (next: { s?: string; f?: string[]; l?: number; sd?: number }) => {
    const s = next.s ?? style, f = next.f ?? feats, l = next.l ?? lawn, sd = next.sd ?? seed;
    if (next.s !== undefined) setStyle(next.s);
    if (next.f !== undefined) setFeats(next.f);
    if (next.l !== undefined) setLawn(next.l);
    if (next.sd !== undefined) setSeed(next.sd);
    regenerate(s, f, l, sd);
  };

  const chip = (on: boolean): React.CSSProperties => ({
    fontFamily: IT, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', borderRadius: 999, padding: '7px 13px',
    background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
    border: on ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.16)', transition: 'all 0.12s',
  });
  const label: React.CSSProperties = { fontFamily: IT, fontSize: '0.7rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 };

  const totalPlants = plants.instances.length;

  return (
    <div className="h-screen flex" style={{ backgroundColor: '#F4F0E6', overflow: 'hidden' }}>
      {/* Sidebar — the simplified edit panel */}
      <div className="flex flex-col" style={{ width: 'min(400px, 36vw)', flexShrink: 0, borderRight: '1px solid rgba(42,42,38,0.08)' }}>
        <div className="px-7 pt-7 pb-3"><Logo /></div>
        <div className="px-7 flex-1 overflow-y-auto">
          <h1 style={{ fontFamily: IS, fontSize: '1.8rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1, margin: '2px 0 6px' }}>
            Here's a starting plan
          </h1>
          <p style={{ fontFamily: IT, fontSize: '0.86rem', color: '#6A6A60', lineHeight: 1.5, margin: '0 0 16px' }}>
            {sc.address ? `${String(sc.address).split(',')[0]} · ` : ''}{plants.species.length} plant species · {totalPlants} plants
          </p>

          <div style={{ marginBottom: 16 }}>
            <div style={label}>Style</div>
            <div className="flex flex-wrap gap-2">
              {STYLES.map(s => <button key={s.id} style={chip(style === s.id)} onClick={() => change({ s: s.id })}>{s.label}</button>)}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={label}>Features</div>
            <div className="flex flex-wrap gap-2">
              {FEATURES.map(f => (
                <button key={f.id} style={chip(feats.includes(f.id))}
                  onClick={() => change({ f: feats.includes(f.id) ? feats.filter(x => x !== f.id) : [...feats, f.id] })}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={label}>Lawn</div>
            <div className="flex gap-2">
              {LAWNS.map(l => <button key={l.id} style={chip(lawn === l.id)} onClick={() => change({ l: l.id })}>{l.label}</button>)}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <button onClick={() => change({ sd: seed + 1 })}
              className="w-full py-2.5 rounded-full transition-all hover:opacity-90"
              style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
              ⟳ Shuffle the layout
            </button>
          </div>

          {plants.species.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={label}>Your plants</div>
              <div className="flex flex-col gap-1">
                {plants.species.slice(0, 8).map(sp => (
                  <div key={sp.name} className="flex items-center gap-2" style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: sp.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.name}</span>
                    <span style={{ color: '#9A9A92', fontSize: '0.74rem' }}>×{sp.count}</span>
                  </div>
                ))}
                {plants.species.length > 8 && <span style={{ fontFamily: IT, fontSize: '0.74rem', color: '#9A9A92' }}>+ {plants.species.length - 8} more</span>}
              </div>
            </div>
          )}

          <button onClick={() => navigate('/diy/auto-layout')}
            style={{ fontFamily: IT, fontSize: '0.8rem', color: '#6A6A60', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, marginBottom: 18 }}>
            Fine-tune every detail in the full editor →
          </button>
        </div>

        <div className="px-7 pb-7 pt-3" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
          <button onClick={() => navigate('/draft/output')} disabled={building || !plan}
            className="w-full py-3.5 rounded-full transition-all hover:opacity-90 disabled:opacity-60"
            style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.95rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            {building ? 'Drafting…' : 'Looks good — build my plan →'}
          </button>
        </div>
      </div>

      {/* Plan canvas */}
      <div className="flex-1 flex items-center justify-center p-6" style={{ position: 'relative' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        {plan ? (
          <div style={{ width: '100%', maxWidth: 980 }}>
            <PlanSnapshot plan={{ ...plan, obstacles: [] }} plants={plants.instances} height={Math.min(640, window.innerHeight - 100)} />
          </div>
        ) : (
          <div style={{ fontFamily: IT, color: '#9A9A92' }}>Preparing your draft…</div>
        )}
        {building && (
          <div className="absolute flex items-center gap-2" style={{ top: 24, right: 28, background: 'white', borderRadius: 999, padding: '8px 16px', boxShadow: '0 2px 12px rgba(0,0,0,0.12)' }}>
            <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.25)', borderTopColor: '#2A2A26', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>Updating…</span>
          </div>
        )}
      </div>
    </div>
  );
}
