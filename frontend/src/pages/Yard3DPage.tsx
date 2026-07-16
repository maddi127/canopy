import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Yard3D from '../components/Yard3D';
import BackButton from '../components/BackButton';
import { IT } from '../lib/theme';

interface HouseAttrs { stories: number; style: string; material: string; color: string; }
const DEFAULT_ATTRS: HouseAttrs = { stories: 1, style: 'ranch', material: 'stucco', color: '#D8D2C4' };
const STYLES = ['ranch', 'rambler', 'two-story', 'split-level', 'modern', 'bungalow', 'other'];
const MATERIALS = ['stucco', 'brick', 'siding', 'stone', 'wood'];
const MATERIAL_DEFAULT_COLOR: Record<string, string> = { stucco: '#D8D2C4', brick: '#9E5E48', siding: '#CFCCC0', stone: '#B0A99A', wood: '#B08850' };

function loadAttrs(): HouseAttrs {
  try { const a = JSON.parse(localStorage.getItem('diyHouseAttributes') || 'null'); if (a) return { ...DEFAULT_ATTRS, ...a }; } catch { /* none */ }
  return DEFAULT_ATTRS;
}

export default function Yard3DPage() {
  const navigate = useNavigate();
  const [attrs, setAttrs] = useState<HouseAttrs>(loadAttrs);
  const [open, setOpen] = useState(true);
  const [illustration, setIllustration] = useState(true); // prototype: default to the new NPR look
  const update = (patch: Partial<HouseAttrs>) => setAttrs(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem('diyHouseAttributes', JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const chip = (active: boolean): React.CSSProperties => ({ fontFamily: IT, fontSize: '0.74rem', fontWeight: 500, padding: '5px 10px', borderRadius: 999, cursor: 'pointer', border: '1.5px solid ' + (active ? '#2A2A26' : 'rgba(42,42,38,0.15)'), background: active ? '#2A2A26' : 'white', color: active ? '#efe9db' : '#2A2A26' });

  return (
    <div style={{ position: 'fixed', inset: 0, background: illustration ? '#f6f1e6' : '#EEF0E9' }}>
      <Yard3D houseAttrs={attrs} illustration={illustration} />

      {/* Style toggle: Realistic vs Illustration (NPR prototype) */}
      <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 4, background: 'rgba(255,255,255,0.95)', borderRadius: 999, padding: 4, boxShadow: '0 4px 18px rgba(0,0,0,0.16)' }}>
        {([['Illustration', true], ['Realistic', false]] as const).map(([label, val]) => (
          <button key={label} onClick={() => setIllustration(val)}
            style={{ fontFamily: IT, fontSize: '0.8rem', fontWeight: 600, padding: '8px 18px', borderRadius: 999, cursor: 'pointer', border: 'none',
              background: illustration === val ? '#2A2A26' : 'transparent', color: illustration === val ? '#efe9db' : '#2A2A26' }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ position: 'absolute', top: 20, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ background: 'rgba(42,42,38,0.85)', color: '#efe9db', fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, padding: '8px 18px', borderRadius: 18, boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}>
          Drag to orbit · scroll to zoom · a rough 3D preview of your yard at maturity
        </div>
      </div>

      <BackButton onClick={() => navigate('/diy/plant-options')}
        style={{ position: 'absolute', top: 20, left: 24 }} />

      {/* House control panel */}
      <div style={{ position: 'absolute', top: 20, right: 24, width: 250, background: 'rgba(255,255,255,0.95)', borderRadius: 16, boxShadow: '0 4px 18px rgba(0,0,0,0.16)', overflow: 'hidden' }}>
        <button onClick={() => setOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: IT, fontSize: '0.85rem', fontWeight: 600, color: '#2A2A26' }}>
          House <span style={{ color: '#B0B0A6' }}>{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A8E', marginBottom: 6 }}>Stories</div>
              <div style={{ display: 'flex', gap: 6 }}>{[1, 2, 3].map(n => <button key={n} style={chip(attrs.stories === n)} onClick={() => update({ stories: n })}>{n}</button>)}</div>
            </div>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A8E', marginBottom: 6 }}>Style</div>
              <select value={attrs.style} onChange={e => update({ style: e.target.value })} style={{ width: '100%', fontFamily: IT, fontSize: '0.78rem', padding: '6px 8px', borderRadius: 8, border: '1.5px solid rgba(42,42,38,0.15)', background: 'white', color: '#2A2A26', textTransform: 'capitalize' }}>
                {STYLES.map(s => <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A8E', marginBottom: 6 }}>Material</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{MATERIALS.map(m => <button key={m} style={{ ...chip(attrs.material === m), textTransform: 'capitalize' }} onClick={() => update({ material: m, color: MATERIAL_DEFAULT_COLOR[m] })}>{m}</button>)}</div>
            </div>
            <div>
              <div style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A8E', marginBottom: 6 }}>Color</div>
              <input type="color" value={attrs.color} onChange={e => update({ color: e.target.value })} style={{ width: '100%', height: 32, border: '1.5px solid rgba(42,42,38,0.15)', borderRadius: 8, background: 'white', cursor: 'pointer' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
