// The weekend-by-weekend build plan sections — cost summary, the 3 working weekends (Do + Buy),
// and (optionally) the full shopping list. Shared by the draft flow's output page and the main
// flow's review page so the two can never drift. Reads nothing itself; caller passes plan + plants.
import { useMemo } from 'react';
import { buildWeekendPlan } from '../services/materialsCalculator';
import type { PlantInstance } from '../services/draftPlants';
import { IS, IT } from '../lib/theme';

const DARK = '#2A2A26';
const money = (n: number) => `$${n.toLocaleString()}`;

export default function BuildPlan({ plan, instances, showShoppingList = true, cardClassName = 'build-card' }: {
  plan: any;
  instances: PlantInstance[];
  showShoppingList?: boolean;
  cardClassName?: string;
}) {
  const build = useMemo(() => buildWeekendPlan(plan, instances), [plan, instances]);

  const card: React.CSSProperties = { background: 'white', borderRadius: 18, padding: '22px 24px', boxShadow: '0 2px 14px rgba(42,42,38,0.06)', marginBottom: 18 };
  const th: React.CSSProperties = { fontFamily: IT, fontSize: '0.66rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'left', padding: '0 12px 8px 0' };
  const td: React.CSSProperties = { fontFamily: IT, fontSize: '0.88rem', color: DARK, padding: '8px 12px 8px 0', borderTop: '1px solid rgba(42,42,38,0.08)', verticalAlign: 'middle' };

  return (
    <>
      {/* Cost summary */}
      <div className={cardClassName} style={{ ...card, display: 'flex', gap: 28, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: IT, fontSize: '0.68rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Estimated materials + plants</div>
          <div style={{ fontFamily: IS, fontSize: '2rem', color: DARK }}>{money(build.totalLow)} – {money(build.totalHigh)}</div>
        </div>
        <div style={{ fontFamily: IT, fontSize: '0.8rem', color: '#7A7A6E', maxWidth: 380, lineHeight: 1.5 }}>
          {instances.length} plants · 3 working weekends · retail estimates, before delivery. Call 811 before you dig.
        </div>
      </div>

      {/* Weekends */}
      {build.weekends.map((wk, i) => (
        <div key={i} className={cardClassName} style={card}>
          <h2 style={{ fontFamily: IS, fontSize: '1.45rem', color: DARK, fontWeight: 400, margin: '0 0 2px' }}>{wk.title}</h2>
          <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A6E', margin: '0 0 14px' }}>{wk.subtitle}</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 22 }}>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.66rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Do</div>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {wk.tasks.map((t, j) => (
                  <li key={j} style={{ fontFamily: IT, fontSize: '0.86rem', color: DARK, lineHeight: 1.5, marginBottom: 6 }}>{t}</li>
                ))}
              </ol>
            </div>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.66rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Buy</div>
              {wk.items.length === 0 ? (
                <p style={{ fontFamily: IT, fontSize: '0.84rem', color: '#9A9A92', margin: 0 }}>Nothing new — you're using what you have.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {wk.items.map((it, j) => (
                      <tr key={j}>
                        <td style={{ ...td, borderTop: j === 0 ? 'none' : td.borderTop as string }}>
                          {it.color && <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: it.color, marginRight: 7, verticalAlign: 'middle' }} />}
                          <span style={{ fontWeight: 500 }}>{it.name}</span>
                          <span style={{ color: '#9A9A8E', fontSize: '0.76rem' }}> — {it.detail}</span>
                        </td>
                        <td style={{ ...td, borderTop: j === 0 ? 'none' : td.borderTop as string, whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 600 }}>{it.qty}</td>
                        <td style={{ ...td, borderTop: j === 0 ? 'none' : td.borderTop as string, whiteSpace: 'nowrap', textAlign: 'right', color: '#7A7A6E', fontSize: '0.78rem' }}>
                          {money(it.costLow)}–{money(it.costHigh)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Full shopping list */}
      {showShoppingList && (
        <div className={cardClassName} style={card}>
          <h2 style={{ fontFamily: IS, fontSize: '1.45rem', color: DARK, fontWeight: 400, margin: '0 0 12px' }}>Everything, one list</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Item</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right', paddingRight: 0 }}>Est. cost</th></tr></thead>
            <tbody>
              {build.allItems.map((it, j) => (
                <tr key={j}>
                  <td style={td}>
                    {it.color && <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: it.color, marginRight: 7, verticalAlign: 'middle' }} />}
                    {it.name}<span style={{ color: '#9A9A8E', fontSize: '0.76rem' }}> — {it.detail}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{it.qty}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', paddingRight: 0 }}>{money(it.costLow)}–{money(it.costHigh)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, fontWeight: 700 }}>Total</td>
                <td style={td} />
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, paddingRight: 0 }}>{money(build.totalLow)}–{money(build.totalHigh)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
