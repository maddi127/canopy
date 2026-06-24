import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSaveAndExit } from '../hooks/useSaveAndExit';
import Logo from '../components/Logo';
import { PLANTS, type Plant } from '../features/planting/plantDatabase';

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlantRow {
  plant: Plant;
  qty: number;
  mine: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const TYPE_ORDER: Plant['type'][] = ['tree', 'large_shrub', 'foundation_shrub', 'perimeter_shrub', 'filler'];
const TYPE_LABELS: Record<Plant['type'], string> = {
  tree:              'Trees',
  large_shrub:       'Large Shrubs',
  foundation_shrub:  'Foundation Shrubs',
  perimeter_shrub:   'Perimeter Shrubs',
  filler:            'Fillers & Groundcovers',
};
// Fraction of plantable area allocated to each plant type
const TYPE_FRACTIONS: Record<Plant['type'], number> = {
  tree:             0.04,
  large_shrub:      0.18,
  foundation_shrub: 0.22,
  perimeter_shrub:  0.18,
  filler:           0.38,
};

const DENSITY_MULT: Record<string, number> = { low: 0.55, medium: 1.0, high: 1.55 };

function calcQty(p: Plant, numInGroup: number, areaSqFt: number, density: string): number {
  const plantableArea = areaSqFt * 0.72;
  const mult = DENSITY_MULT[density] ?? 1.0;
  const share = (plantableArea * (TYPE_FRACTIONS[p.type] ?? 0.2) * mult) / numInGroup;
  return Math.max(1, Math.ceil(share / (p.spacing_ft * p.spacing_ft)));
}

function careNote(p: Plant): string {
  const sunMap: Record<string, string> = {
    full_sun:   'full sun (6 + hrs)',
    part_shade: 'partial shade (3–6 hrs)',
    full_shade: 'shade (< 3 hrs)',
    adaptable:  'sun or shade',
  };
  const sun   = sunMap[p.sun] ?? p.sun;
  const water = p.priorities.includes('low_water')
    ? 'drought-tolerant once established'
    : 'water weekly until established, then as needed';
  const space = `space ${p.spacing_ft} ft on center`;
  return `${sun} · ${water} · ${space}`;
}

function plantBgColor(p: Plant): string {
  if (p.styles.includes('natural_wild'))      return '#4A7C59';
  if (p.styles.includes('desert_minimal'))    return '#C8893A';
  if (p.styles.includes('modern_structured')) return '#5A6A7A';
  return '#7A6A5A';
}

function priorityBadge(priority: string): string {
  const map: Record<string, string> = {
    low_maintenance: 'low maint.',
    low_water:       'low water',
    pollinator:      'pollinator',
    kid_pet:         'kid + pet safe',
    curb_appeal:     'curb appeal',
    privacy:         'privacy',
  };
  return map[priority] ?? priority;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function DiyPlanPage() {
  const navigate = useNavigate();
  const saveAndExit = useSaveAndExit();

  // Load all persisted state
  const conceptImage = localStorage.getItem('diyFinalConcept') || localStorage.getItem('generatedConcept') || '';
  const boundary: { areaSqFt: number } | null = (() => {
    try { return JSON.parse(localStorage.getItem('diyBoundary') || 'null'); } catch { return null; }
  })();
  const areaSqFt = boundary?.areaSqFt ?? 0;

  const sc:    any = (() => { try { return JSON.parse(localStorage.getItem('siteContext')      || '{}'); } catch { return {}; } })();
  const prefs: any = (() => { try { return JSON.parse(localStorage.getItem('userPreferences')  || '{}'); } catch { return {}; } })();

  const address  = sc.address  ?? '';
  const density  = localStorage.getItem('diyDensity') ?? 'medium';
  const roundCount = parseInt(localStorage.getItem('diyRoundCount') ?? '0', 10);

  const includeIds: string[] = (() => { try { return JSON.parse(localStorage.getItem('diyPlantIncludes') || '[]'); } catch { return []; } })();
  const excludeIds: string[] = (() => { try { return JSON.parse(localStorage.getItem('diyPlantExcludes') || '[]'); } catch { return []; } })();
  const systemFillIds: string[] = (() => { try { return JSON.parse(localStorage.getItem('diySystemFills') || '[]'); } catch { return []; } })();

  const style = prefs.style ?? sc.style ?? 'traditional';
  const zone  = sc.usda_zone ?? 7;

  // Assemble final plant list: user picks first, then system fills (excluding rejects + already included)
  const finalPlants: PlantRow[] = useMemo(() => {
    const allIds = [...new Set([...includeIds, ...systemFillIds])].filter(id => !excludeIds.includes(id));
    return allIds
      .map(id => PLANTS.find(p => p.id === id))
      .filter((p): p is Plant => !!p);
  }, [includeIds, systemFillIds, excludeIds]).map(p => ({ plant: p, qty: 0, mine: includeIds.includes(p.id) }));

  // Group by type and calculate quantities
  const grouped = useMemo(() => {
    const byType: Partial<Record<Plant['type'], PlantRow[]>> = {};
    for (const row of finalPlants) {
      (byType[row.plant.type] ??= []).push(row);
    }
    const result: { type: Plant['type']; rows: PlantRow[] }[] = [];
    for (const type of TYPE_ORDER) {
      const rows = byType[type];
      if (!rows || rows.length === 0) continue;
      const withQty = rows.map(r => ({
        ...r,
        qty: areaSqFt > 0 ? calcQty(r.plant, rows.length, areaSqFt, density) : 1,
      }));
      result.push({ type, rows: withQty });
    }
    return result;
  }, [finalPlants, areaSqFt, density]);

  const totalQty   = useMemo(() => grouped.reduce((sum, g) => sum + g.rows.reduce((s, r) => s + r.qty, 0), 0), [grouped]);
  const totalSpecies = finalPlants.length;

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#efe9db', overflow: 'hidden' }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0 no-print">
        <Logo />
        <button
          onClick={saveAndExit}
          style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Save & exit ↗
        </button>
      </div>

      {/* Title */}
      <div className="px-10 mt-8 mb-5 flex-shrink-0 no-print">
        <h1 style={{ fontFamily: IS, fontSize: '3rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>
          Your Canopy plan.
        </h1>
        {address && (
          <p style={{ fontFamily: IT, fontSize: '0.88rem', color: '#6A6A60', marginTop: '0.4rem' }}>{address}</p>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden px-10 pb-16 gap-5">

        {/* Left — concept image + stats */}
        <div className="flex flex-col gap-4" style={{ width: 420, flexShrink: 0 }}>

          {/* Concept image */}
          {conceptImage ? (
            <div className="rounded-2xl overflow-hidden flex-shrink-0" style={{ aspectRatio: '4/3', background: '#d8d0c0' }}>
              <img src={conceptImage} alt="Your landscape concept" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          ) : (
            <div className="rounded-2xl flex items-center justify-center" style={{ aspectRatio: '4/3', background: '#d8d0c0' }}>
              <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92' }}>No concept image</span>
            </div>
          )}

          {/* Summary stats */}
          <div className="rounded-2xl p-5 grid grid-cols-3 gap-4" style={{ backgroundColor: '#F4EAD2' }}>
            {[
              { label: 'SPECIES', value: String(totalSpecies) },
              { label: 'PLANTS', value: areaSqFt > 0 ? String(totalQty) : '—' },
              { label: 'SQ FT', value: areaSqFt > 0 ? areaSqFt.toLocaleString() : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span style={{ fontFamily: IT, fontSize: '0.62rem', letterSpacing: '0.12em', color: '#9A9A92', fontWeight: 600 }}>{label}</span>
                <span style={{ fontFamily: IS, fontSize: '1.6rem', color: '#2A2A26', lineHeight: 1 }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Refinement note */}
          {roundCount > 0 && (
            <div className="rounded-2xl px-4 py-3" style={{ backgroundColor: '#F4EAD2' }}>
              <p style={{ fontFamily: IT, fontSize: '0.78rem', color: '#6A6A60', margin: 0, lineHeight: 1.5 }}>
                Refined {roundCount} time{roundCount !== 1 ? 's' : ''} · {density} planting density · {DENSITY_MULT[density]}× fill rate
              </p>
            </div>
          )}

          {/* Print / Download */}
          <button
            onClick={() => window.print()}
            className="no-print w-full py-2.5 rounded-full transition-all hover:opacity-80"
            style={{ border: '1.5px solid rgba(26,26,22,0.2)', fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', background: 'none', cursor: 'pointer' }}
          >
            Print / save as PDF
          </button>
        </div>

        {/* Right — plant guide */}
        <div className="flex-1 overflow-y-auto pr-1" style={{ paddingBottom: '4rem' }}>

          {grouped.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <p style={{ fontFamily: IS, fontStyle: 'italic', fontSize: '1.4rem', color: '#9A9A92' }}>No plants selected</p>
              <button onClick={() => navigate('/diy/refine')}
                style={{ fontFamily: IT, fontSize: '0.82rem', color: '#C77C5B', background: 'none', border: 'none', cursor: 'pointer' }}>
                ← Back to refine
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {grouped.map(({ type, rows }) => (
                <div key={type}>
                  {/* Type header */}
                  <div className="flex items-center gap-3 mb-3">
                    <span style={{ fontFamily: IT, fontSize: '0.65rem', letterSpacing: '0.12em', fontWeight: 700, color: '#9A9A92' }}>
                      {TYPE_LABELS[type].toUpperCase()}
                    </span>
                    <div style={{ flex: 1, height: 1, background: 'rgba(26,26,22,0.1)' }} />
                    <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A8' }}>
                      {rows.reduce((s, r) => s + r.qty, 0)} plants
                    </span>
                  </div>

                  {/* Plant rows */}
                  <div className="flex flex-col gap-2">
                    {rows.map(({ plant: p, qty, mine }) => (
                      <PlantRow key={p.id} plant={p} qty={qty} mine={mine} />
                    ))}
                  </div>
                </div>
              ))}

              {/* Zone notes */}
              <ZoneNotes zone={zone} style={style} />
            </div>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <button
        onClick={() => navigate('/diy/refine')}
        className="fixed bottom-6 left-10 hover:opacity-70 transition-all no-print"
        style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}
      >
        ← back
      </button>

      <button
        onClick={() => navigate('/')}
        className="fixed bottom-6 right-10 flex items-center gap-2 px-7 py-3.5 rounded-full transition-all hover:opacity-90 no-print"
        style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}
      >
        Start a new project →
      </button>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function PlantRow({ plant: p, qty, mine }: { plant: Plant; qty: number; mine: boolean }) {
  const bg = plantBgColor(p);
  const badges = p.priorities.slice(0, 2);

  return (
    <div className="flex gap-3 items-start rounded-xl p-3.5" style={{ backgroundColor: '#F4EAD2' }}>
      {/* Color swatch / initial */}
      <div className="rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ width: 38, height: 38, background: bg }}>
        <span style={{ fontFamily: IS, fontSize: '1rem', color: 'white', fontWeight: 400 }}>
          {p.common_name[0]}
        </span>
      </div>

      {/* Plant info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 600, color: '#2A2A26' }}>{p.common_name}</span>
            {mine && (
              <span className="inline-block ml-2 px-1.5 py-0.5 rounded"
                style={{ fontSize: '0.62rem', fontFamily: IT, backgroundColor: 'rgba(42,42,38,0.08)', color: '#6A6A60', verticalAlign: 'middle' }}>
                your pick
              </span>
            )}
            <p style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', fontStyle: 'italic', margin: '1px 0 4px' }}>
              {p.botanical_name}
            </p>
          </div>
          {qty > 0 && (
            <div className="flex-shrink-0 text-right">
              <span style={{ fontFamily: IS, fontSize: '1.4rem', color: '#2A2A26', lineHeight: 1 }}>{qty}</span>
              <span style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', display: 'block' }}>plants</span>
            </div>
          )}
        </div>

        {/* Care note */}
        <p style={{ fontFamily: IT, fontSize: '0.72rem', color: '#6A6A60', lineHeight: 1.5, margin: '0 0 6px' }}>
          {careNote(p)}
        </p>

        {/* Priority badges */}
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {badges.map(b => (
              <span key={b} className="px-2 py-0.5 rounded-full"
                style={{ fontFamily: IT, fontSize: '0.62rem', color: '#6A6A60', backgroundColor: 'rgba(26,26,22,0.07)' }}>
                {priorityBadge(b)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ZoneNotes({ zone, style }: { zone: number; style: string }) {
  const IT = "'Inter Tight', sans-serif";
  const IS = "'Instrument Serif', serif";

  const seasonNote = zone <= 5
    ? 'Short growing season — plant after last frost (May–June). Mulch perennials in fall.'
    : zone <= 7
    ? 'Mild winters — plant spring or fall. Water deeply in summer heat.'
    : zone <= 9
    ? 'Long growing season — spring planting ideal. Provide afternoon shade for sensitive plants.'
    : 'Warm climate — plant in fall or winter for best establishment. Shade cloth may help in summer.';

  const styleNote: Record<string, string> = {
    natural_wild:      'Embrace self-seeding and naturalistic drifts. Leave seed heads through winter for wildlife.',
    modern_structured: 'Keep edges clean. Deadhead regularly and prune for tight silhouettes.',
    desert_minimal:    'Avoid overwatering — most plants prefer lean, well-drained soil.',
    traditional:       'Deadhead flowers to encourage rebloom. Divide perennials every 2–3 years.',
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ backgroundColor: '#1f3f2c', marginTop: 8 }}>
      <span style={{ fontFamily: IS, fontSize: '1rem', color: 'rgba(255,255,255,0.85)', fontWeight: 400 }}>
        Planting notes for your region
      </span>
      <p style={{ fontFamily: IT, fontSize: '0.78rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, margin: 0 }}>
        <strong style={{ color: 'rgba(255,255,255,0.85)' }}>Zone {zone}</strong> — {seasonNote}
      </p>
      {styleNote[style] && (
        <p style={{ fontFamily: IT, fontSize: '0.78rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, margin: 0 }}>
          {styleNote[style]}
        </p>
      )}
      <p style={{ fontFamily: IT, fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, margin: 0 }}>
        Canopy plant quantities are estimates based on mature spacing. Adjust for your specific soil, drainage, and sun conditions.
      </p>
    </div>
  );
}
