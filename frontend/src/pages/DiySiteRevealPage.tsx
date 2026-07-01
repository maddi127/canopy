import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import IllustrativeSite from '../components/IllustrativeSite';

const IT = "'Inter', system-ui, sans-serif";

// Interstitial after /boundary: animates the project area being "drawn," holds a beat, then
// fades into /auto-layout automatically — no button.
export default function DiySiteRevealPage() {
  const navigate = useNavigate();
  const boardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fading, setFading] = useState(false);
  const timers = useRef<number[]>([]);

  useLayoutEffect(() => {
    const measure = () => { const el = boardRef.current; if (el) setSize({ w: el.clientWidth, h: el.clientHeight }); };
    measure(); window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const yardType = (() => {
    try {
      const p = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      const s = JSON.parse(localStorage.getItem('siteContext') || '{}');
      return s.yard_type ?? p.yard_type ?? '';
    } catch { return ''; }
  })();

  // IllustrativeSite draws the plan in, holds, then rotates it into the auto-layout orientation.
  // onComplete fires after the rotation — we cross-fade into /auto-layout, which is already in that
  // exact orientation, so the screen appears to "open up" into the editor.
  const onComplete = () => {
    setFading(true);
    timers.current.push(window.setTimeout(() => navigate('/diy/auto-layout'), 550));
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#E7E1D5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', padding: '2rem', opacity: fading ? 0 : 1, transition: 'opacity 0.6s ease' }}>
      <div style={{ fontFamily: IT, fontSize: '1.4rem', fontWeight: 600, color: '#2A2A26' }}>Mapping your yard…</div>
      <div ref={boardRef} style={{ width: 'min(960px, 92vw)', height: 'min(600px, 62vh)', background: '#F4F0E6', borderRadius: 18, boxShadow: '0 10px 40px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
        {size.w > 0 && <IllustrativeSite width={size.w} height={size.h} onComplete={onComplete} finishOrientation={{ yardType }} />}
      </div>
    </div>
  );
}
