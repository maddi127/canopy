// Draft flow S5 — the deliverable. Weekend-by-weekend install plan with exact material quantities,
// the priced plant list, and the site plan drawing. Print-ready; this is the artifact people act on.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../../components/Logo';
import PlanSnapshot from '../../components/PlanSnapshot';
import BuildPlan from '../../components/BuildPlan';
import type { PlantInstance } from '../../services/draftPlants';
import { IS, IT, PAGE_BG } from '../../lib/theme';

const DARK = '#2A2A26';

export default function DraftOutputPage() {
  const navigate = useNavigate();

  const plan = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { return {}; } }, []);
  const instances = useMemo<PlantInstance[]>(() => { try { return JSON.parse(localStorage.getItem('diyPlantInstances') || '[]'); } catch { return []; } }, []);
  const address = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').address || ''; } catch { return ''; } }, []);

  const card: React.CSSProperties = { background: 'white', borderRadius: 18, padding: '22px 24px', boxShadow: '0 2px 14px rgba(42,42,38,0.06)', marginBottom: 18 };

  return (
    <div style={{ minHeight: '100vh', background: PAGE_BG, fontFamily: IT }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          .build-page { background: white !important; }
          .build-card { box-shadow: none !important; border: 1px solid rgba(42,42,38,0.12); break-inside: avoid; }
        }
      `}</style>

      <div className="build-page" style={{ maxWidth: 860, margin: '0 auto', padding: '32px 28px 80px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
          <div>
            <Logo />
            <h1 style={{ fontFamily: IS, fontSize: '2.5rem', color: DARK, fontWeight: 400, lineHeight: 1.05, margin: '14px 0 4px' }}>Your build plan</h1>
            {address && <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#7A7A6E', margin: 0 }}>{address}</p>}
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <button onClick={() => navigate('/draft/plan')}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#7A7A73', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 4px' }}>
              ← Edit the plan
            </button>
            <button onClick={() => window.print()}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#efe9db', background: DARK, border: 'none', cursor: 'pointer', padding: '10px 20px', borderRadius: 999 }}>
              Print / Save as PDF
            </button>
          </div>
        </div>

        {/* Site plan */}
        <div className="build-card" style={{ ...card, padding: 10 }}>
          <PlanSnapshot plan={plan} plants={instances} height={440} />
        </div>

        {/* Cost summary + weekend schedule + shopping list (shared with the review page). */}
        <BuildPlan plan={plan} instances={instances} />

        <p style={{ fontFamily: IT, fontSize: '0.75rem', color: '#A8A89C', textAlign: 'center', marginTop: 8 }}>
          Quantities derive from your plan's measured areas; prices are retail estimates. Mind utilities — call 811 before planting.
        </p>

        <div className="no-print" style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24 }}>
          <button onClick={() => navigate('/diy/yard-3d')}
            style={{ fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, color: DARK, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer', padding: '12px 24px', borderRadius: 999 }}>
            View in 3D ↗
          </button>
          <button onClick={() => navigate('/diy/auto-layout')}
            style={{ fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, color: DARK, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer', padding: '12px 24px', borderRadius: 999 }}>
            Open the full editor
          </button>
        </div>
      </div>
    </div>
  );
}
