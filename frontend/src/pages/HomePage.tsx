import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import AddressInput from '../features/onboarding/AddressInput';
import { clearAllDesignState } from '../services/projectsService';
import { IS, IT, INK, GREEN, PAGE_BG } from '../lib/theme';

const BG      = '#e8e3d5';
const DARK    = INK;
const RUST    = '#c96b3a';
const OLIVE   = '#6b7a48';   // italic accent in the headline
const PANEL   = '#efe9dd';   // step-illustration card backdrop
const MUTED   = '#7c7768';

// ── Watercolour plant blobs (echo the illustrated plan style) ────────────────────
// Seeded so the shapes are stable across renders. A "foliage" blob is a lobed scallop —
// the same silhouette the plan painter draws for a plant clump.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function foliagePath(cx: number, cy: number, r: number, lobes: number, seed: number): string {
  const rng = mulberry32(seed);
  const pts = Array.from({ length: lobes }, (_, i) => {
    const a = (i / lobes) * Math.PI * 2 - Math.PI / 2;
    const rr = r * (0.78 + rng() * 0.32);
    return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, a };
  });
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < lobes; i++) {
    const p = pts[i], q = pts[(i + 1) % lobes];
    const mid = p.a + Math.PI / lobes;
    const bulge = r * 1.16;
    d += ` Q ${(cx + Math.cos(mid) * bulge).toFixed(1)} ${(cy + Math.sin(mid) * bulge).toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  }
  return d + ' Z';
}
function PlantBlob({ cx, cy, r, color, dark, seed, lobes = 9, flower }: { cx: number; cy: number; r: number; color: string; dark: string; seed: number; lobes?: number; flower?: string }) {
  const outer = foliagePath(cx, cy, r, lobes, seed);
  const rng = mulberry32(seed + 99);
  return (
    <g filter="url(#wc)">
      <path d={outer} fill={color} />
      <path d={foliagePath(cx, cy, r * 0.6, lobes, seed + 5)} fill={dark} opacity={0.4} />
      <path d={outer} fill="none" stroke={INK} strokeWidth={1.3} strokeOpacity={0.5} strokeLinejoin="round" />
      {flower && Array.from({ length: 5 }).map((_, i) => {
        const a = rng() * Math.PI * 2, rr = r * 0.45 * rng();
        return <circle key={i} cx={cx + Math.cos(a) * rr} cy={cy + Math.sin(a) * rr} r={r * 0.16} fill={flower} />;
      })}
    </g>
  );
}

const STEPS = [
  {
    label: 'STEP 01',
    title: 'Submit your preferences',
    desc: 'Style, features, budget, and how you actually live outside. We tune everything downstream to what you tell us here.',
    checks: ['Design style & mood', 'Must-have features'],
  },
  {
    label: 'STEP 02',
    title: 'Build a site plan',
    desc: 'Draw your project area right on the map, then confirm the trees, structures, and hardscape that are staying put.',
    checks: ['Draw your project area', 'Confirm existing features', 'Sun & soil analysis'],
  },
  {
    label: 'STEP 03',
    title: 'Finetune your draft design',
    desc: 'Nudge feature placement, choose your groundcover treatment, and swap any plant in the palette before you lock it in.',
    checks: ['Confirm feature placement', 'Groundcover treatment', 'Plant selection & swaps'],
  },
];

// ── Hero aerial-plan illustration ───────────────────────────────────────────────

const HERO_PLANTS = [
  { cx: 106, cy: 118, r: 52, color: '#4a6e40', dark: '#32502e', lobes: 12, seed: 11 },
  { cx: 158, cy: 66,  r: 26, color: '#6f9153', dark: '#516f3c', lobes: 9,  seed: 21 },
  { cx: 176, cy: 232, r: 34, color: '#87a35f', dark: '#5f7c42', lobes: 10, seed: 31 },
  { cx: 252, cy: 168, r: 24, color: '#9b7bb0', dark: '#7a5c93', lobes: 9,  seed: 41, flower: '#cf9bd8' },
  { cx: 330, cy: 84,  r: 27, color: '#d7b256', dark: '#c0983c', lobes: 10, seed: 51 },
  { cx: 302, cy: 250, r: 26, color: '#57784a', dark: '#3f5c37', lobes: 9,  seed: 61 },
  { cx: 234, cy: 288, r: 21, color: '#c96b3a', dark: '#a9542b', lobes: 8,  seed: 71, flower: '#e6a06a' },
  { cx: 352, cy: 178, r: 18, color: '#6f9153', dark: '#516f3c', lobes: 8,  seed: 81 },
];

function PlanIllustration() {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: '440px', marginLeft: 'auto' }}>
      <svg viewBox="0 0 440 400" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
        <defs>
          <filter id="card-shadow" x="-15%" y="-15%" width="140%" height="150%">
            <feDropShadow dx="0" dy="10" stdDeviation="20" floodColor="#1a1a16" floodOpacity="0.14" />
          </filter>
          <clipPath id="front-card-clip"><rect x="30" y="10" width="360" height="330" rx="24" /></clipPath>
        </defs>

        {/* Stacked paper cards behind for depth */}
        <rect x="52" y="26" width="360" height="330" rx="24" fill="#e6dfce" opacity="0.6" />
        <rect x="42" y="18" width="360" height="330" rx="24" fill="#efe8d8" opacity="0.85" />

        {/* Front card — paper plan */}
        <g filter="url(#card-shadow)">
          <rect x="30" y="10" width="360" height="330" rx="24" fill="#f6f1e6" />
          <g clipPath="url(#front-card-clip)">
            {/* Faint graph-paper grid */}
            {Array.from({ length: 9 }).map((_, i) => <line key={`h${i}`} x1="30" y1={10 + i * 40} x2="390" y2={10 + i * 40} stroke={INK} strokeOpacity="0.05" strokeWidth="1" />)}
            {Array.from({ length: 9 }).map((_, i) => <line key={`v${i}`} x1={30 + i * 45} y1="10" x2={30 + i * 45} y2="340" stroke={INK} strokeOpacity="0.05" strokeWidth="1" />)}
            {/* Lawn wash */}
            <g filter="url(#wc)"><path d={foliagePath(232, 232, 92, 16, 3)} fill="#b9c996" opacity="0.85" /></g>
            {/* Gravel path (sketchy) */}
            <g filter="url(#wc)">
              <path d="M120 350 Q210 252 300 152 Q344 102 380 44" stroke="#c2b9a1" strokeWidth="26" fill="none" strokeLinecap="round" />
              <path d="M120 350 Q210 252 300 152 Q344 102 380 44" stroke="#d5ccb4" strokeWidth="16" fill="none" strokeLinecap="round" />
            </g>
            {/* Plant clumps */}
            {HERO_PLANTS.map((p, i) => <PlantBlob key={i} {...p} />)}
          </g>
          {/* Zone badge */}
          <g>
            <rect x="46" y="26" width="186" height="26" rx="13" fill="white" opacity="0.94" />
            <circle cx="62" cy="39" r="4" fill="#3d5c3a" />
            <text x="74" y="43.5" fontFamily={IT} fontSize="11" fill={DARK} fontWeight="500" letterSpacing="0.05em">ZONE 7B · SALT LAKE CITY</text>
          </g>
        </g>
      </svg>
    </div>
  );
}

// ── Step illustrations ──────────────────────────────────────────────────────────

function PreferencesIllustration() {
  const cells = [
    { x: 34,  y: 40,  fill: '#5a7a50' },
    { x: 132, y: 40,  fill: '#deba5c' },
    { x: 230, y: 40,  fill: '#c96b3a' },
    { x: 34,  y: 138, fill: '#5a7a50' },
    { x: 132, y: 138, fill: '#4a6aaa' },
    { x: 230, y: 138, fill: '#6a8a4a', sel: true },
  ];
  return (
    <svg viewBox="0 0 340 250" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs><filter id="pref-shadow" x="-8%" y="-8%" width="116%" height="120%"><feDropShadow dx="0" dy="5" stdDeviation="13" floodColor="#1a1a16" floodOpacity="0.08" /></filter></defs>
      <rect x="10" y="10" width="320" height="230" rx="20" fill={PANEL} filter="url(#pref-shadow)" />
      {cells.map((c, i) => (
        <g key={i}>
          <rect x={c.x} y={c.y} width="76" height="72" rx="12" fill={c.sel ? '#e0ebd4' : '#ffffff'} stroke={c.sel ? '#8aa86a' : 'none'} strokeWidth={c.sel ? 1.5 : 0} />
          <circle cx={c.x + 20} cy={c.y + 22} r="11" fill={c.fill} opacity="0.9" />
          <rect x={c.x + 12} y={c.y + 44} width="42" height="5" rx="2.5" fill="#d8d3c6" />
          <rect x={c.x + 12} y={c.y + 54} width="26" height="5" rx="2.5" fill="#e4dfd3" />
          {c.sel && (
            <g>
              <circle cx={c.x + 60} cy={c.y + 14} r="9" fill="#3d6b4a" />
              <path d={`M ${c.x + 56} ${c.y + 14} l 3 3 l 6 -6.5`} stroke="white" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}

function SitePlanIllustration() {
  return (
    <svg viewBox="0 0 340 250" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs><filter id="site-shadow" x="-8%" y="-8%" width="116%" height="120%"><feDropShadow dx="0" dy="5" stdDeviation="13" floodColor="#1a1a16" floodOpacity="0.08" /></filter></defs>
      <rect x="10" y="10" width="320" height="230" rx="20" fill={PANEL} filter="url(#site-shadow)" />
      {/* Sun */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => (
        <line key={i} x1="256" y1="66" x2={256 + 22 * Math.cos((a * Math.PI) / 180)} y2={66 + 22 * Math.sin((a * Math.PI) / 180)} stroke="#c9a63e" strokeWidth="2" strokeLinecap="round" />
      ))}
      <circle cx="256" cy="66" r="13" fill="#deba5c" />
      {/* House */}
      <path d="M96 178 L96 120 L160 80 L224 120 L224 178 Z" stroke={DARK} strokeWidth="2" fill="none" strokeLinejoin="round" />
      <path d="M86 126 L160 76 L234 126" stroke={DARK} strokeWidth="2" fill="none" strokeLinejoin="round" />
      <rect x="145" y="150" width="30" height="28" rx="2" stroke={DARK} strokeWidth="1.5" fill="none" />
      <rect x="106" y="130" width="24" height="18" rx="2" stroke={DARK} strokeWidth="1.5" fill="none" />
      <rect x="190" y="130" width="24" height="18" rx="2" stroke={DARK} strokeWidth="1.5" fill="none" />
      {/* Tree */}
      <circle cx="66" cy="166" r="19" stroke={DARK} strokeWidth="1.5" fill="none" />
      <line x1="66" y1="185" x2="66" y2="198" stroke={DARK} strokeWidth="1.5" />
      {/* Ground line */}
      <line x1="40" y1="198" x2="300" y2="198" stroke={DARK} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="4 5" />
    </svg>
  );
}

function FinetuneIllustration() {
  return (
    <svg viewBox="0 0 340 250" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs><filter id="fine-shadow" x="-8%" y="-8%" width="116%" height="120%"><feDropShadow dx="0" dy="5" stdDeviation="13" floodColor="#1a1a16" floodOpacity="0.08" /></filter></defs>
      <rect x="10" y="10" width="320" height="230" rx="20" fill={PANEL} filter="url(#fine-shadow)" />
      {/* Left: watercolour plan preview (paper + lawn + clumps, matching the real plan) */}
      <clipPath id="fine-plan-clip"><rect x="30" y="42" width="176" height="166" rx="12" /></clipPath>
      <rect x="30" y="42" width="176" height="166" rx="12" fill="#f6f1e6" />
      <g clipPath="url(#fine-plan-clip)">
        <g filter="url(#wc)"><path d={foliagePath(118, 128, 52, 15, 7)} fill="#b9c996" opacity="0.85" /></g>
        <g filter="url(#wc)"><path d="M40 200 Q90 160 150 120 Q175 104 200 92" stroke="#c8bfa7" strokeWidth="12" fill="none" strokeLinecap="round" /></g>
        <PlantBlob cx={72} cy={92} r={26} color="#4a6e40" dark="#33512f" lobes={11} seed={107} />
        <PlantBlob cx={132} cy={158} r={20} color="#87a35f" dark="#5f7c42" lobes={9} seed={117} />
        <PlantBlob cx={168} cy={104} r={16} color="#9b7bb0" dark="#7a5c93" lobes={9} seed={127} flower="#cf9bd8" />
      </g>
      {/* Right: palette list + swap */}
      <rect x="222" y="42" width="88" height="166" rx="12" fill="#ffffff" />
      {[0, 1, 2].map(i => (
        <g key={i}>
          <circle cx="238" cy={64 + i * 26} r="6" fill={['#3d5c3a', '#deba5c', '#c96b3a'][i]} opacity="0.85" />
          <rect x="250" y={59 + i * 26} width="44" height="4.5" rx="2" fill="#d8d3c6" />
          <rect x="250" y={67 + i * 26} width="30" height="4.5" rx="2" fill="#e4dfd3" />
        </g>
      ))}
      <rect x="234" y="170" width="64" height="26" rx="13" fill="#f4efe6" stroke="#dcd6c8" strokeWidth="1" />
      <text x="266" y="187" fontFamily={IT} fontSize="9.5" fill="#3d5c3a" fontWeight="600" textAnchor="middle">Swap plant</text>
    </svg>
  );
}

const STEP_ILLUSTRATIONS = [PreferencesIllustration, SitePlanIllustration, FinetuneIllustration];

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate();
  const [showMobileGate, setShowMobileGate] = useState(false);

  // The design flow (drawing on a map, editing a detailed plan) needs real screen real estate, so we
  // gate its START on phones and very short windows — measured at click time, not render, so a rotate
  // or resize is always reflected. Everything else on the homepage stays browsable on any device.
  const tooSmallToDesign = () =>
    typeof window !== 'undefined' && (window.innerWidth <= 768 || window.innerHeight <= 450);

  const handleAddressSelect = useCallback((address: string, lat: number, lng: number) => {
    if (tooSmallToDesign()) { setShowMobileGate(true); return; }
    clearAllDesignState();
    localStorage.setItem('initialAddress', JSON.stringify({ address, lat, lng }));
    localStorage.setItem('siteContext', JSON.stringify({ address, lat, lng }));
    navigate('/diy/preferences');
  }, [navigate]);

  // The three "Design my yard" buttons start the flow at preferences even without an address —
  // the address is captured later, above the map on the boundary page. Entering an address in the
  // hero input still auto-advances via handleAddressSelect (which also stores siteContext).
  const startPlan = useCallback(() => {
    if (tooSmallToDesign()) { setShowMobileGate(true); return; }
    clearAllDesignState();   // fresh design — the address is captured above the map on the boundary page
    navigate('/diy/preferences');
  }, [navigate]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: PAGE_BG, fontFamily: IT }}>

      {/* Shared hand-painted edge filter for the watercolour plan illustrations */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <filter id="wc" x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="5" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="4" />
          </filter>
        </defs>
      </svg>

      {/* ── Header ── */}
      <header className="hp-header" style={{ padding: '22px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: '1120px', margin: '0 auto' }}>
        <Logo />
        <button onClick={startPlan}
          style={{ fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, color: BG, backgroundColor: DARK, border: 'none', borderRadius: '100px', padding: '10px 20px', cursor: 'pointer' }}>
          Design my yard →
        </button>
      </header>

      {/* ── Hero ── */}
      <section className="hp-hero" style={{ padding: '40px 48px 80px', display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: '48px', alignItems: 'center', maxWidth: '1120px', margin: '0 auto' }}>
        {/* Left */}
        <div>
          <h1 style={{ fontFamily: IS, fontSize: 'clamp(2.8rem, 5vw, 4.6rem)', color: DARK, lineHeight: 1.04, margin: '0 0 22px', fontWeight: 400 }}>
            Your landscape<br />design <span style={{ fontStyle: 'italic', color: OLIVE }}>co-pilot</span>
          </h1>

          <p style={{ fontFamily: IT, fontSize: '1.02rem', color: MUTED, lineHeight: 1.6, margin: '0 0 30px', maxWidth: '400px' }}>
            Tell us your goals, draw your yard, and watch your planting plan take shape.
          </p>

          {/* Address input pill with inline CTA */}
          <div className="hero-address-wrapper" style={{ display: 'flex', alignItems: 'center', backgroundColor: 'white', borderRadius: '100px', padding: '6px 18px', boxShadow: '0 4px 28px rgba(26,26,22,0.13)', maxWidth: '460px' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: '8px' }}>
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="#9a9485" />
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              <AddressInput onAddressSelect={handleAddressSelect} />
            </div>
          </div>

          {/* Feature pills */}
          <div style={{ display: 'flex', gap: '22px', marginTop: '16px' }}>
            {['First draft in minutes', 'Unlimited plan edits', '100% satisfaction guarantee'].map(t => (
              <span key={t} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontFamily: IT, fontSize: '0.78rem', color: '#8a8574' }}>
                <span style={{ color: '#b4af9c' }}>✦</span>{t}
              </span>
            ))}
          </div>
        </div>

        {/* Right — illustration */}
        <div className="hp-hero-illo" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <PlanIllustration />
        </div>
      </section>

      {/* ── How it works heading ── */}
      <section className="hp-how" style={{ padding: '72px 48px 0', maxWidth: '1120px', margin: '0 auto', textAlign: 'center' }}>
        <p style={{ fontFamily: IT, fontSize: '0.78rem', color: GREEN, letterSpacing: '0.16em', fontWeight: 700, margin: '0 0 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-block', width: '30px', height: '2px', backgroundColor: '#b7bfa6' }} />
          HOW IT WORKS
          <span style={{ display: 'inline-block', width: '30px', height: '2px', backgroundColor: '#b7bfa6' }} />
        </p>
        <h2 style={{ fontFamily: IS, fontSize: 'clamp(2rem, 3.4vw, 2.9rem)', color: DARK, fontWeight: 400, margin: 0, lineHeight: 1.1 }}>
          Three steps to a plan you'll love
        </h2>
      </section>

      {/* ── Steps ── */}
      <section className="hp-steps" style={{ padding: '56px 48px 100px', maxWidth: '1120px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '72px' }}>
        {STEPS.map((step, i) => {
          const Illustration = STEP_ILLUSTRATIONS[i];
          return (
            <div key={step.label} className="hp-step-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '64px', alignItems: 'center' }}>
              {/* Text */}
              <div>
                <p style={{ fontFamily: IT, fontSize: '0.72rem', color: RUST, letterSpacing: '0.14em', fontWeight: 600, margin: '0 0 14px' }}>
                  {step.label}
                </p>
                <h3 style={{ fontFamily: IS, fontSize: '1.85rem', color: DARK, lineHeight: 1.2, fontWeight: 400, margin: '0 0 14px' }}>
                  {step.title}
                </h3>
                <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#5a5a50', lineHeight: 1.7, margin: '0 0 18px', maxWidth: '360px' }}>
                  {step.desc}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                  {step.checks.map(check => (
                    <span key={check} style={{ display: 'flex', alignItems: 'center', gap: '9px', fontFamily: IT, fontSize: '0.85rem', color: '#5a5a50' }}>
                      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                        <path d="M3.5 7.8L6.2 10.4L11.4 4.6" stroke="#3d7a5c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {check}
                    </span>
                  ))}
                </div>
              </div>
              {/* Illustration (always right) */}
              <div><Illustration /></div>
            </div>
          );
        })}
      </section>

      {/* ── Bottom CTA band ── */}
      <section className="hp-cta" style={{ backgroundColor: GREEN, padding: '80px 48px', textAlign: 'center' }}>
        <h2 style={{ fontFamily: IS, fontSize: 'clamp(1.9rem, 3.2vw, 2.6rem)', color: '#f3efe3', fontWeight: 400, margin: '0 0 32px', lineHeight: 1.1 }}>
          Ready to see your yard, reimagined?
        </h2>
        <button onClick={startPlan} className="transition-all hover:opacity-90"
          style={{ fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, color: DARK, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', borderRadius: '100px', padding: '12px 24px', cursor: 'pointer' }}>
          Design my yard
        </button>
      </section>

      {/* ── Geocoder input styling ── */}
      <style>{`
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder {
          box-shadow: none !important; border: none !important; border-radius: 0 !important;
          background: transparent !important; min-height: unset !important; width: 100% !important;
          /* The geocoder box sits ~8px shy of centre (a line-box below its input); nudge it to align
             with the pin icon. */
          position: relative !important; top: 4px !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input {
          font-family: 'Inter Tight', sans-serif !important; font-size: 0.88rem !important;
          color: #1a1a16 !important; padding: 0 4px !important; height: 36px !important;
          line-height: 36px !important; background: transparent !important; min-width: 0 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input::placeholder { color: #a0a090 !important; }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-search { display: none !important; }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--button { background: transparent !important; padding: 0 8px !important; }
        .hero-address-wrapper .canopy-geocoder .suggestions {
          border-radius: 16px !important; box-shadow: 0 8px 28px rgba(26,26,22,0.14) !important;
          border: 1px solid rgba(26,26,22,0.08) !important; overflow: hidden; z-index: 100;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a {
          font-family: 'Inter Tight', sans-serif !important; font-size: 0.86rem !important;
          color: #1a1a16 !important; padding: 12px 18px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > .active > a,
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a:hover {
          background-color: #f0ece3 !important; color: #1a1a16 !important;
        }

        /* ── Mobile: stack everything to one column and tighten gutters ── */
        @media (max-width: 768px) {
          .hp-header { padding: 16px 20px !important; }
          .hp-hero { grid-template-columns: 1fr !important; gap: 30px !important; padding: 24px 20px 52px !important; }
          .hp-hero-illo { justify-content: center !important; }
          .hp-how { padding: 44px 20px 0 !important; }
          .hp-steps { padding: 40px 20px 68px !important; gap: 52px !important; }
          .hp-step-row { grid-template-columns: 1fr !important; gap: 26px !important; }
          .hp-cta { padding: 60px 24px !important; }
        }
      `}</style>

      {/* ── Mobile gate: the design flow needs a bigger screen ── */}
      {showMobileGate && (
        <div onClick={() => setShowMobileGate(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(26,26,22,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
            style={{ background: '#f6f1e6', borderRadius: '24px', padding: '34px 28px 28px', maxWidth: '384px', width: '100%', textAlign: 'center', boxShadow: '0 24px 70px rgba(26,26,22,0.32)' }}>
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" style={{ margin: '0 auto 18px', display: 'block' }} aria-hidden>
              <rect x="3" y="4" width="18" height="12.5" rx="2" stroke={GREEN} strokeWidth="1.7" />
              <path d="M8.5 20h7M12 16.5V20" stroke={GREEN} strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <h3 style={{ fontFamily: IS, fontSize: '1.55rem', color: DARK, fontWeight: 400, margin: '0 0 12px', lineHeight: 1.2 }}>
              Best on a bigger screen
            </h3>
            <p style={{ fontFamily: IT, fontSize: '0.95rem', color: MUTED, lineHeight: 1.6, margin: '0 0 24px' }}>
              Designing your yard means drawing on a map and fine-tuning a detailed plan — it needs more room than a phone can give. Open canopy on a laptop or desktop to start your design.
            </p>
            <button onClick={() => setShowMobileGate(false)}
              style={{ fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, color: BG, background: DARK, border: 'none', borderRadius: '100px', padding: '12px 28px', cursor: 'pointer' }}>
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
