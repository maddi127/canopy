import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import AddressInput from '../features/onboarding/AddressInput';
import { useAuth } from '../context/AuthContext';

const BG  = '#e9e4d9';
const DARK = '#1a1a16';
const RUST = '#c96b3a';
const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

const STEPS = [
  {
    num: '01',
    label: 'STEP 1',
    title: 'Tell us about your space',
    desc: 'Where you are, how the sun moves, what stays. Five minutes of questions and a couple photos — we do the rest.',
    checks: ['Address + lot details', 'Sun & soil quick read', 'A handful of phone photos'],
  },
  {
    num: '02',
    label: 'STEP 2',
    title: 'Choose from a curated plant list',
    desc: "We'll suggest plants that fit your style, climate, and sun. Swap anything you don't love before we lock it in.",
    checks: ['Climate-matched selections', 'Style-filtered options', 'Swap freely before approving'],
  },
  {
    num: '03',
    label: 'STEP 3',
    title: 'Review your finished plan',
    desc: 'Precise plant placement, spacing, and a shopping list. One last pass — then the plan is yours to build.',
    checks: ['Full site plan with spacing', 'Curated plant + material list', 'Installation-ready PDF'],
  },
];

// ── Plan illustration ─────────────────────────────────────────────────────────

function PlanIllustration() {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: '480px', marginLeft: 'auto' }}>
      <svg viewBox="0 0 460 430" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
        {/* Drop shadow filter */}
        <defs>
          <filter id="card-shadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow dx="0" dy="8" stdDeviation="16" floodColor="#1a1a16" floodOpacity="0.13" />
          </filter>
          <filter id="back-shadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#1a1a16" floodOpacity="0.09" />
          </filter>
          <clipPath id="front-card-clip">
            <rect x="20" y="20" width="360" height="360" rx="20" />
          </clipPath>
        </defs>

        {/* Back card — rotated, peeking at bottom-right */}
        <g transform="rotate(5, 230, 380)" filter="url(#back-shadow)">
          <rect x="100" y="290" width="300" height="160" rx="16" fill="#f5f0e6" />
          <text x="123" y="342" fontFamily={IT} fontSize="11" fill="#9a9485" letterSpacing="0.04em">your plan</text>
          <text x="360" y="342" fontFamily={IT} fontSize="11" fill="#c0bdb0" textAnchor="end">2026</text>
          {/* Mini plan lines */}
          <rect x="123" y="355" width="60" height="6" rx="3" fill="#e0dbd0" />
          <rect x="123" y="368" width="42" height="6" rx="3" fill="#e0dbd0" />
          <rect x="123" y="381" width="52" height="6" rx="3" fill="#e0dbd0" />
          <rect x="240" y="355" width="32" height="32" rx="4" fill="#c8d2bc" />
          <circle cx="300" cy="368" r="14" fill="#3d5c3a" opacity="0.45" />
          <circle cx="328" cy="362" r="9" fill="#5a7a50" opacity="0.4" />
        </g>

        {/* Front card */}
        <g filter="url(#card-shadow)">
          <rect x="20" y="20" width="360" height="360" rx="20" fill="#c4cfb8" />

          {/* Clipped content */}
          <g clipPath="url(#front-card-clip)">
            {/* Rain texture dots */}
            {Array.from({ length: 48 }).map((_, i) => {
              const col = i % 8;
              const row = Math.floor(i / 8);
              return (
                <rect
                  key={i}
                  x={38 + col * 44}
                  y={38 + row * 52}
                  width="1.5"
                  height="7"
                  rx="1"
                  fill="#a8b89e"
                  opacity="0.45"
                />
              );
            })}

            {/* Large tree blob (main) */}
            <ellipse cx="145" cy="175" rx="68" ry="88" fill="#2d4e2a" />
            <ellipse cx="118" cy="135" rx="42" ry="48" fill="#263e24" />
            <ellipse cx="165" cy="215" rx="32" ry="36" fill="#3a5e36" />

            {/* Secondary tree cluster top-right */}
            <circle cx="280" cy="82" r="38" fill="#deba5c" opacity="0.82" />
            <circle cx="308" cy="96" r="18" fill="#c9a63e" opacity="0.7" />

            {/* Small shrub bottom-right */}
            <circle cx="300" cy="290" r="22" fill="#4a6e40" opacity="0.75" />
            <circle cx="322" cy="305" r="14" fill="#3d5c3a" opacity="0.65" />
            <circle cx="286" cy="312" r="10" fill="#5a7a50" opacity="0.7" />

            {/* Walkway / path */}
            <path
              d="M155 378 Q175 320 225 265 Q270 215 315 155 Q340 115 350 68"
              stroke="#9a9180"
              strokeWidth="20"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M155 378 Q175 320 225 265 Q270 215 315 155 Q340 115 350 68"
              stroke="#b0a896"
              strokeWidth="14"
              fill="none"
              strokeLinecap="round"
            />

            {/* Plant dots along path */}
            {[
              { cx: 162, cy: 360, fill: '#d45c3a' },
              { cx: 178, cy: 340, fill: '#4a7a50' },
              { cx: 195, cy: 315, fill: '#d45c3a' },
              { cx: 213, cy: 290, fill: '#6a9460' },
              { cx: 235, cy: 263, fill: '#d45c3a' },
              { cx: 255, cy: 238, fill: '#4a7a50' },
              { cx: 275, cy: 210, fill: '#d45c3a' },
              { cx: 298, cy: 178, fill: '#6a9460' },
              { cx: 315, cy: 152, fill: '#4a6aaa' },
              { cx: 328, cy: 127, fill: '#d45c3a' },
              { cx: 340, cy: 100, fill: '#4a7a50' },
            ].map((dot, i) => (
              <circle key={i} cx={dot.cx} cy={dot.cy} r="5.5" fill={dot.fill} />
            ))}
          </g>
        </g>

        {/* Zone badge overlay */}
        <g>
          <rect x="36" y="36" width="156" height="24" rx="12" fill="white" opacity="0.92" />
          <circle cx="50" cy="48" r="4" fill="#3d5c3a" />
          <text x="60" y="52.5" fontFamily={IT} fontSize="10.5" fill="#1a1a16" fontWeight="500" letterSpacing="0.06em">
            ZONE 6B · BRYN MAWR
          </text>
        </g>
      </svg>
    </div>
  );
}

// ── Step illustration placeholders ────────────────────────────────────────────

function HouseIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs>
        <filter id="house-shadow">
          <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#1a1a16" floodOpacity="0.08" />
        </filter>
      </defs>
      <rect x="20" y="20" width="280" height="200" rx="16" fill="#f0ece3" filter="url(#house-shadow)" />
      {/* Sun rays */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
        <line key={i} x1="240" y1="60" x2={240 + 22 * Math.cos((angle * Math.PI) / 180)} y2={60 + 22 * Math.sin((angle * Math.PI) / 180)} stroke="#c9a63e" strokeWidth="2" strokeLinecap="round" />
      ))}
      <circle cx="240" cy="60" r="12" fill="#deba5c" />
      {/* House outline */}
      <path d="M100 175 L100 120 L160 82 L220 120 L220 175 Z" stroke="#1a1a16" strokeWidth="2" fill="none" strokeLinejoin="round" />
      {/* Roof */}
      <path d="M90 126 L160 78 L230 126" stroke="#1a1a16" strokeWidth="2" fill="none" strokeLinejoin="round" />
      {/* Door */}
      <rect x="145" y="148" width="28" height="27" rx="2" stroke="#1a1a16" strokeWidth="1.5" fill="none" />
      {/* Windows */}
      <rect x="107" y="128" width="22" height="18" rx="2" stroke="#1a1a16" strokeWidth="1.5" fill="none" />
      <rect x="191" y="128" width="22" height="18" rx="2" stroke="#1a1a16" strokeWidth="1.5" fill="none" />
      {/* Trees */}
      <circle cx="72" cy="165" r="18" stroke="#1a1a16" strokeWidth="1.5" fill="none" />
      <line x1="72" y1="183" x2="72" y2="195" stroke="#1a1a16" strokeWidth="1.5" />
      {/* Ground line */}
      <line x1="42" y1="195" x2="278" y2="195" stroke="#1a1a16" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="4 4" />
    </svg>
  );
}

function PaletteIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs>
        <filter id="palette-shadow">
          <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#1a1a16" floodOpacity="0.08" />
        </filter>
      </defs>
      <rect x="20" y="20" width="280" height="200" rx="16" fill="#f0ece3" filter="url(#palette-shadow)" />
      {/* Plant cards grid */}
      {[
        { x: 40, y: 48, fill: '#3d5c3a' },
        { x: 120, y: 48, fill: '#deba5c' },
        { x: 200, y: 48, fill: '#c96b3a' },
        { x: 40, y: 130, fill: '#5a7a50' },
        { x: 120, y: 130, fill: '#4a6aaa' },
        { x: 200, y: 130, fill: '#8a6a3a' },
      ].map((card, i) => (
        <g key={i}>
          <rect x={card.x} y={card.y} width="72" height="72" rx="10" fill="white" opacity="0.7" />
          <circle cx={card.x + 36} cy={card.y + 28} r="18" fill={card.fill} opacity="0.75" />
          <rect x={card.x + 12} y={card.y + 52} width="28" height="5" rx="2.5" fill="#c8c2b4" />
          <rect x={card.x + 12} y={card.y + 62} width="18" height="4" rx="2" fill="#dad5c8" />
        </g>
      ))}
      {/* Checkmark badge */}
      <circle cx="252" cy="188" r="14" fill="#2d4e2a" />
      <path d="M245 188 L250 193 L259 182" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlanDocIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }}>
      <defs>
        <filter id="doc-shadow">
          <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#1a1a16" floodOpacity="0.08" />
        </filter>
      </defs>
      <rect x="20" y="20" width="280" height="200" rx="16" fill="#f0ece3" filter="url(#doc-shadow)" />
      {/* Plan background */}
      <rect x="44" y="44" width="172" height="152" rx="8" fill="#c4cfb8" opacity="0.6" />
      {/* Organic zones on plan */}
      <ellipse cx="100" cy="110" rx="38" ry="46" fill="#3d5c3a" opacity="0.6" />
      <ellipse cx="148" cy="148" rx="28" ry="22" fill="#deba5c" opacity="0.55" />
      <path d="M80 185 Q120 165 170 160 Q195 158 215 150" stroke="#9a9180" strokeWidth="10" fill="none" strokeLinecap="round" opacity="0.7" />
      {/* Plant legend */}
      <rect x="230" y="44" width="55" height="152" rx="8" fill="white" opacity="0.55" />
      {[0, 1, 2, 3, 4].map(i => (
        <g key={i}>
          <circle cx="246" cy={64 + i * 28} r="6" fill={['#3d5c3a', '#deba5c', '#c96b3a', '#5a7a50', '#4a6aaa'][i]} opacity="0.8" />
          <rect x="257" y={59 + i * 28} width="20" height="4" rx="2" fill="#c8c2b4" />
          <rect x="257" y={66 + i * 28} width="14" height="3" rx="1.5" fill="#dad5c8" />
        </g>
      ))}
    </svg>
  );
}

const STEP_ILLUSTRATIONS = [HouseIllustration, PaletteIllustration, PlanDocIllustration];

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const handleAddressSelect = useCallback((address: string, lat: number, lng: number) => {
    localStorage.setItem('initialAddress', JSON.stringify({ address, lat, lng }));
    localStorage.setItem('siteContext', JSON.stringify({ address, lat, lng }));
    localStorage.removeItem('generatedConcept');
    localStorage.removeItem('conceptFeatures');
    navigate('/diy/preferences');
  }, [navigate]);

  // Starting a plan without an address on the homepage sends them to the
  // address step first; otherwise continue straight into preferences.
  const startPlan = useCallback(() => {
    navigate(localStorage.getItem('initialAddress') ? '/diy/preferences' : '/start');
  }, [navigate]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: BG, fontFamily: IT }}>

      {/* ── Header ── */}
      <header style={{ padding: '22px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Logo />
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <button
            onClick={() => navigate(user ? '/projects' : '/auth')}
            style={{ fontFamily: IT, fontSize: '0.88rem', color: '#5a5a50', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}
          >
            {user ? 'My designs' : 'Sign in'}
          </button>
          <button
            onClick={startPlan}
            style={{
              fontFamily: IT,
              fontSize: '0.88rem',
              fontWeight: 500,
              color: BG,
              backgroundColor: DARK,
              border: 'none',
              borderRadius: '100px',
              padding: '10px 20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            Start my design →
          </button>
        </div>
      </header>

      {/* ── Hero ── */}
      <section style={{ padding: '32px 48px 80px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '48px', alignItems: 'center', maxWidth: '1100px', margin: '0 auto' }}>

        {/* Left */}
        <div>
          <h1 style={{
            fontFamily: IS,
            fontSize: 'clamp(3rem, 5.5vw, 5.2rem)',
            color: DARK,
            lineHeight: 1.05,
            margin: '0 0 36px',
            fontWeight: 400,
          }}>
            Your landscape<br />design co-pilot
          </h1>

          {/* Address input pill */}
          <div className="hero-address-wrapper" style={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'white',
            borderRadius: '100px',
            padding: '6px 20px 6px 18px',
            boxShadow: '0 4px 28px rgba(26,26,22,0.13)',
            marginBottom: '18px',
            maxWidth: '460px',
          }}>
            {/* Pin icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: '8px', color: '#9a9485' }}>
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="#9a9485" />
            </svg>

            {/* Geocoder input */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <AddressInput onAddressSelect={handleAddressSelect} />
            </div>
          </div>
        </div>

        {/* Right — illustration */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <PlanIllustration />
        </div>
      </section>

      {/* ── How It Works ── */}
      <section style={{ padding: '80px 48px 0', maxWidth: '1100px', margin: '0 auto' }}>
        <p style={{ fontFamily: IT, fontSize: '0.75rem', color: '#8a8a7a', letterSpacing: '0.14em', fontWeight: 500, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-block', width: '28px', height: '1.5px', backgroundColor: '#9a9485' }} />
          HOW IT WORKS
        </p>
      </section>

      {/* ── Steps ── */}
      <section style={{ padding: '0 48px 100px', maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '80px' }}>
        {STEPS.map((step, i) => {
          const Illustration = STEP_ILLUSTRATIONS[i];
          const isEven = i % 2 === 0;
          return (
            <div key={step.num} style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '64px',
              alignItems: 'center',
              direction: isEven ? 'ltr' : 'rtl',
            }}>
              {/* Text */}
              <div style={{ direction: 'ltr' }}>
                <p style={{ fontFamily: IT, fontSize: '0.7rem', color: RUST, letterSpacing: '0.14em', fontWeight: 600, marginBottom: '14px', margin: '0 0 14px' }}>
                  {step.label}
                </p>
                <h3 style={{ fontFamily: IS, fontSize: '1.75rem', color: DARK, lineHeight: 1.2, fontWeight: 400, margin: '0 0 14px' }}>
                  {step.title}
                </h3>
                <p style={{ fontFamily: IT, fontSize: '0.87rem', color: '#5a5a50', lineHeight: 1.7, margin: '0 0 16px' }}>
                  {step.desc}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  {step.checks.map(check => (
                    <span key={check} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: IT, fontSize: '0.83rem', color: '#5a5a50' }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="3.25" stroke="#9a9485" strokeWidth="1" />
                        <path d="M3.5 7L5.8 9.2L10.5 4.5" stroke="#3d7a5c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {check}
                    </span>
                  ))}
                </div>
              </div>

              {/* Illustration */}
              <div style={{ direction: 'ltr' }}>
                <Illustration />
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Global style overrides for geocoder ── */}
      <style>{`
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder {
          box-shadow: none !important;
          border: none !important;
          border-radius: 0 !important;
          background: transparent !important;
          min-height: unset !important;
          width: 100% !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input {
          font-family: 'Inter Tight', sans-serif !important;
          font-size: 0.88rem !important;
          color: #1a1a16 !important;
          padding: 0 4px !important;
          height: 42px !important;
          line-height: 42px !important;
          background: transparent !important;
          min-width: 0 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input::placeholder {
          color: #a0a090 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-search {
          display: none !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--button {
          background: transparent !important;
          padding: 0 8px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions {
          border-radius: 16px !important;
          box-shadow: 0 8px 28px rgba(26,26,22,0.14) !important;
          border: 1px solid rgba(26,26,22,0.08) !important;
          overflow: hidden;
          z-index: 100;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a {
          font-family: 'Inter Tight', sans-serif !important;
          font-size: 0.86rem !important;
          color: #1a1a16 !important;
          padding: 12px 18px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > .active > a,
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a:hover {
          background-color: #f0ece3 !important;
          color: #1a1a16 !important;
        }
      `}</style>
    </div>
  );
}
