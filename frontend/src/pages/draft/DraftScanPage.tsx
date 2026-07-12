// Draft flow S2 — quick picks over a live site scan. The three questions that drive generation
// (yard side, wanted features, style) are answered while Gemini detects the site in the background,
// so preference-gathering costs zero perceived time. Skippable — everything has a default.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../../components/Logo';
import { detectSiteFeatures } from '../../services/geminiService';
import { detectionBox } from '../../services/boundaryProposer';
import type { ConfirmedFeature } from '../DiyFeatureConfirmPage';

const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";
const GOOGLE_MAPS_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY ?? '';

const FEATURES = [
  { id: 'seating', label: 'Seating' }, { id: 'dining', label: 'Dining' },
  { id: 'cooking', label: 'Fire / cooking' }, { id: 'water', label: 'Water feature' },
  { id: 'garden', label: 'Veggie garden' }, { id: 'storage', label: 'Storage' },
];
const STYLES = [
  { id: 'natural_wild', label: 'Whimsical', desc: 'Loose, colorful, cottage' },
  { id: 'modern_structured', label: 'Modern', desc: 'Clean lines, structure' },
  { id: 'traditional', label: 'Traditional', desc: 'Classic and polished' },
  { id: 'desert_minimal', label: 'Desert', desc: 'Drought-tolerant, rock' },
];

export default function DraftScanPage() {
  const navigate = useNavigate();
  const sc = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);

  const [yard, setYard] = useState<'front' | 'back'>('front');
  const [feats, setFeats] = useState<string[]>(['seating']);
  const [style, setStyle] = useState('traditional');

  const [found, setFound] = useState<string[]>([]);
  const [scanState, setScanState] = useState<'scanning' | 'done' | 'failed'>('scanning');
  const detectionsRef = useRef<ConfirmedFeature[]>([]);

  // Kick off detection immediately; the picks card sits on top of the live feed.
  useEffect(() => {
    if (typeof sc.lat !== 'number' || typeof sc.lng !== 'number') { navigate('/draft'); return; }
    let live = true;
    const box = detectionBox(sc.lat, sc.lng);
    try { localStorage.setItem('draftDetectionBox', JSON.stringify(box)); } catch { /* ignore */ }
    detectSiteFeatures(box)
      .then(detected => {
        if (!live) return;
        const feats: ConfirmedFeature[] = detected.map((f: any) => ({
          id: `detected_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type: f.type, keep: true, source: 'detected' as const,
          vertices: f.vertices, confidence: f.confidence, label: f.label ?? f.type, attributes: f.attributes ?? {},
        }));
        detectionsRef.current = feats;
        try { localStorage.setItem('draftDetections', JSON.stringify(feats)); } catch { /* ignore */ }
        // Reveal findings with a small stagger so the scan reads as live.
        const names = feats.map(f => f.label || f.type);
        names.forEach((n, i) => setTimeout(() => { if (live) setFound(prev => [...prev, n]); }, i * 350));
        setTimeout(() => { if (live) setScanState('done'); }, names.length * 350 + 200);
      })
      .catch(() => { if (live) setScanState('failed'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const continueOn = () => {
    try {
      localStorage.setItem('userPreferences', JSON.stringify({
        style, space_usage: feats, lawnTarget: 0.33,
        goal_priority: [], not_important: [],
      }));
      localStorage.setItem('siteContext', JSON.stringify({ ...sc, yard_type: yard }));
    } catch { /* ignore */ }
    navigate('/draft/confirm');
  };

  const satUrl = (typeof sc.lat === 'number' && GOOGLE_MAPS_KEY)
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${sc.lat},${sc.lng}&zoom=20&size=640x640&scale=2&maptype=satellite&key=${GOOGLE_MAPS_KEY}`
    : null;

  const chip = (on: boolean): React.CSSProperties => ({
    fontFamily: IT, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer', borderRadius: 999, padding: '8px 16px',
    background: on ? '#2A2A26' : 'white', color: on ? '#efe9db' : '#2A2A26',
    border: on ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.16)', transition: 'all 0.12s',
  });

  return (
    <div className="min-h-screen relative" style={{ backgroundColor: '#1c1a16', overflow: 'hidden' }}>
      {/* Their yard, scanning */}
      {satUrl && (
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${satUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.55, filter: 'saturate(0.9)' }} />
      )}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, rgba(28,26,22,0.15), rgba(28,26,22,0.75))' }} />
      <style>{`@keyframes scanline { 0% { top: -4%; } 100% { top: 104%; } } @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
      {scanState === 'scanning' && (
        <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, rgba(244,197,66,0.9), transparent)', animation: 'scanline 3.2s linear infinite' }} />
      )}

      <div className="relative flex flex-col items-center min-h-screen px-6" style={{ paddingTop: '4vh', paddingBottom: '5vh' }}>
        <Logo />

        {/* Live scan feed */}
        <div className="flex flex-wrap items-center justify-center gap-2" style={{ margin: '20px 0 22px', minHeight: 30 }}>
          <span style={{ fontFamily: IT, fontSize: '0.8rem', color: 'rgba(239,233,219,0.85)', fontWeight: 500 }}>
            {scanState === 'scanning' ? 'Scanning your yard…' : scanState === 'failed' ? "Scan couldn't finish — you can still continue." : 'Scan complete.'}
          </span>
          {found.map((n, i) => (
            <span key={i} style={{ fontFamily: IT, fontSize: '0.74rem', color: '#efe9db', background: 'rgba(47,107,79,0.85)', borderRadius: 999, padding: '3px 11px', animation: 'fadeIn 0.35s ease both' }}>
              ✓ {n}
            </span>
          ))}
        </div>

        {/* Quick picks card */}
        <div style={{ width: 'min(560px, 94vw)', background: '#F4F0E6', borderRadius: 20, padding: '26px 28px', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }}>
          <h2 style={{ fontFamily: IS, fontSize: '1.6rem', color: '#2A2A26', fontWeight: 400, margin: '0 0 18px' }}>While we scan — three quick picks</h2>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Which yard?</div>
            <div className="flex gap-2">
              <button style={chip(yard === 'front')} onClick={() => setYard('front')}>Front yard</button>
              <button style={chip(yard === 'back')} onClick={() => setYard('back')}>Back yard</button>
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>What do you want out there?</div>
            <div className="flex flex-wrap gap-2">
              {FEATURES.map(f => (
                <button key={f.id} style={chip(feats.includes(f.id))}
                  onClick={() => setFeats(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 22 }}>
            <div style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Your style</div>
            <div className="grid grid-cols-2 gap-2">
              {STYLES.map(s => (
                <button key={s.id} onClick={() => setStyle(s.id)}
                  className="text-left rounded-xl px-3.5 py-2.5 transition-all"
                  style={{ background: style === s.id ? '#2A2A26' : 'white', border: style === s.id ? '1.5px solid #2A2A26' : '1.5px solid rgba(42,42,38,0.14)', cursor: 'pointer' }}>
                  <div style={{ fontFamily: IT, fontSize: '0.86rem', fontWeight: 600, color: style === s.id ? '#efe9db' : '#2A2A26' }}>{s.label}</div>
                  <div style={{ fontFamily: IT, fontSize: '0.72rem', color: style === s.id ? 'rgba(239,233,219,0.7)' : '#9A9A8E' }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <button onClick={continueOn} disabled={scanState === 'scanning'}
            className="w-full py-3.5 rounded-full transition-all hover:opacity-90 disabled:opacity-60"
            style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.95rem', fontWeight: 500, border: 'none', cursor: scanState === 'scanning' ? 'default' : 'pointer' }}>
            {scanState === 'scanning' ? 'Finishing the scan…' : 'Continue →'}
          </button>
        </div>
      </div>
    </div>
  );
}
