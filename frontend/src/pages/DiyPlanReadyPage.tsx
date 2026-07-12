// "Your draft plan is ready" — the interstitial between the site page and the plan editor.
// Left: the flat plan view. Right: a placeholder for the real-life rendering (engine TBD).
// Generates the draft on arrival (preserving an existing plan whose inputs haven't changed),
// then offers "← Back" (site setup) or "Refine the plan →" (editor).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import PlanSnapshot from '../components/PlanSnapshot';
import YardIllustration from '../components/YardIllustration';
import { generateDraftPlan } from '../services/draftPlan';
import { buildDraftPlants } from '../services/draftPlants';
import { inputSignature } from '../lib/planSignature';

const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

export default function DiyPlanReadyPage() {
  const navigate = useNavigate();

  // Generate (or preserve) the draft plan, exactly like the editor would on mount — so what's shown
  // here is what the editor opens with, and edits made later aren't clobbered on a revisit.
  // `regenerated` tells us whether plants need to be (re)built to match a fresh plan.
  const [{ plan, regenerated }] = useState(() => {
    try {
      const sig = inputSignature();
      const existing = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
      if ((existing.zones?.length || existing.paths?.length) && localStorage.getItem('diyPlacementPlanSig') === sig) return { plan: existing, regenerated: false };
    } catch { /* regenerate */ }
    return { plan: generateDraftPlan(1), regenerated: true };
  });

  // Plants: shown as soon as they exist, backfilled if the plan was regenerated or none exist yet.
  const [plants, setPlants] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem('diyPlantInstances') || '[]'); } catch { return []; } });
  // YardIllustration reads diyPlantInstances (via planContentHash) once at mount — bump this and
  // pass it as its `key` so the illustration regenerates once the backfill writes fresh instances.
  const [plantsVersion, setPlantsVersion] = useState(0);

  // Backfill plants once the plan is resolved: if regenerated OR no instances exist, build them
  // (buildDraftPlants persists diyPlantInstances itself). Don't block the page on a spinner —
  // the plan renders immediately and plants pop in when ready.
  useEffect(() => {
    let cancelled = false;
    if (!plan) return;
    const existing = plants;
    if (!regenerated && existing.length > 0) return;
    (async () => {
      try {
        const res = await buildDraftPlants(plan as any);
        if (!cancelled) { setPlants(res.instances); setPlantsVersion(v => v + 1); }
      } catch (e) {
        console.error('[buildDraftPlants]', e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, regenerated]);

  const badge = (text: string, dark = false): React.CSSProperties => ({
    position: 'absolute', top: 18, left: 18, zIndex: 5,
    fontFamily: IT, fontSize: '0.78rem', fontWeight: 600, padding: '7px 15px', borderRadius: 999,
    background: dark ? '#2A2A26' : 'white', color: dark ? '#efe9db' : '#2A2A26',
    boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
  });

  if (!plan) {
    // No confirmed site yet — this page only makes sense after the boundary flow.
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: '#efe9db' }}>
        <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60' }}>We need your site first.</p>
        <button onClick={() => navigate('/diy/boundary')}
          className="px-6 py-3 rounded-full transition-all hover:opacity-90"
          style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          Set up my site →
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F6F2E8' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-10 pt-7 flex-shrink-0">
        <Logo />
      </div>

      {/* Title */}
      <div className="flex-shrink-0" style={{ marginTop: '1.33rem', marginBottom: '1.6rem' }}>
        <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.05, margin: 0, paddingLeft: '2.5rem' }}>
          Here's your draft landscaping plan
        </h1>
      </div>

      {/* Two panels: plan view + rendering placeholder */}
      <div className="flex-1 grid gap-6 px-10" style={{ gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
        {/* Plan view */}
        <div style={{ position: 'relative', background: '#EFE9DA', borderRadius: 20, overflow: 'hidden', border: '1px solid rgba(42,42,38,0.08)' }}>
          <span style={badge('Plan view')}>Plan view</span>
          <div style={{ position: 'absolute', inset: 0 }}>
            <PlanSnapshot plan={plan} plants={plants} height={typeof window !== 'undefined' ? Math.max(420, window.innerHeight - 320) : 560} showDimensions={false} />
          </div>
        </div>

        {/* Standing in your yard: the static rendered illustration — a picture of the finished
            yard on paper. Keyed on plantsVersion so it regenerates once plants backfill. */}
        <div style={{ position: 'relative', background: '#f6f1e6', borderRadius: 20, overflow: 'hidden', border: '1px solid rgba(42,42,38,0.08)' }}>
          <span style={badge('Street view', true)}>Street view</span>
          <div style={{ position: 'absolute', inset: 0 }}>
            <YardIllustration key={plantsVersion} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-10 flex-shrink-0" style={{ padding: '1.4rem 2.5rem 1.8rem' }}>
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/diy/boundary')}
            className="rounded-full px-6 py-3.5 transition-all hover:opacity-85"
            style={{ background: 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
            ← Back
          </button>
        </div>
        <button onClick={() => navigate('/diy/auto-layout')}
          className="rounded-full px-7 py-3.5 transition-all hover:opacity-90"
          style={{ background: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          Refine the plan →
        </button>
      </div>
    </div>
  );
}
