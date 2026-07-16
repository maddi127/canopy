import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import BackButton from '../components/BackButton';

import { IS, IT, PAGE_BG } from '../lib/theme';

interface PaymentRecord {
  projectId: string;
  paymentId: string;
  paidAt: string;
  amount: number;
  currency: 'USD';
  status: 'mock_paid' | 'paid';
}

function getExistingPayment(): PaymentRecord | null {
  try {
    const raw = localStorage.getItem('paymentRecord');
    if (!raw) return null;
    return JSON.parse(raw) as PaymentRecord;
  } catch {
    return null;
  }
}

function saveMockPayment() {
  const sc = (() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } })();
  const record: PaymentRecord = {
    projectId: sc.projectId ?? 'local',
    paymentId: `mock_${Math.random().toString(36).slice(2, 10)}`,
    paidAt: new Date().toISOString(),
    amount: 4900,
    currency: 'USD',
    status: 'mock_paid',
  };
  localStorage.setItem('paymentRecord', JSON.stringify(record));
}

const FEATURES = [
  'Curated plant and material list',
  'Detailed site plan with plant placement & spacing',
  'Canopy satisfaction guarantee'
];

const STEPS = [
  {
    num: '01',
    title: 'Map your project area',
    desc: "Drop pins on an aerial view of your yard so we know exactly what we're designing for — beds, lawn, paths, the works.",
  },
  {
    num: '02',
    title: 'Choose from a curated plant list',
    desc: "We'll suggest plants that fit your style, climate, and sun. Swap anything you don't love before we lock it in.",
  },
  {
    num: '03',
    title: 'Review your final design',
    desc: 'One last pass on the layout, plant placement, and spacing. Approve it and the plan is yours to build.',
  },
];

export default function PaymentPage({ nextPath }: { nextPath?: string } = {}) {
  const navigate = useNavigate();
  const existingPayment = getExistingPayment();

  // Load selected concepts; fall back to single generatedConcept for backwards compat
  const selectedConcepts: string[] = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('diySelectedConcepts') || 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* ignore */ }
    const single = localStorage.getItem('generatedConcept');
    return single ? [single] : [];
  })();

  const [activeIdx, setActiveIdx] = useState(0);
  const conceptImage = selectedConcepts[activeIdx] ?? null;

  const handleStart = () => {
    if (!existingPayment) saveMockPayment();
    navigate(nextPath ?? '/diy/boundary');
  };

  return (
    <div className="min-h-screen flex flex-col pt-8 pb-16" style={{ backgroundColor: PAGE_BG }}>

      {/* Logo */}
      <div className="flex items-start justify-between px-10 mb-6 flex-shrink-0">
        <Logo />
      </div>

      <div className="px-32">
      {/* Title */}
      <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, marginBottom: '1.5rem' }}>
        Bring your concept to life.
      </h1>

      {/* Two columns */}
      <div className="flex gap-5 items-start">

        {/* Left: what's next */}
        <div style={{ flex: '1.5' }}>
          <div className="flex flex-col rounded-3xl p-8 gap-0" style={{ backgroundColor: '#F4EAD2' }}>
            <div className="flex items-baseline justify-between mb-2">
              <span style={{ fontFamily: IS, fontStyle: 'italic', fontSize: '2rem', color: '#C77C5B' }}>What's next</span>
              <span style={{ fontFamily: IT, fontSize: '0.62rem', letterSpacing: '0.14em', color: '#9A9A92', fontWeight: 500 }}>
                3 STEPS&nbsp;&nbsp;·&nbsp;&nbsp;~15 MIN
              </span>
            </div>
            {STEPS.map((step, i) => (
              <div key={step.num}>
                <div className="flex gap-5 py-5">
                  <span style={{ fontFamily: IS, fontSize: '1.5rem', color: '#B0B0A6', lineHeight: 1, flexShrink: 0, width: '2.25rem' }}>
                    {step.num}
                  </span>
                  <div className="flex flex-col gap-1.5">
                    <span style={{ fontFamily: IS, fontSize: '1.3rem', color: '#2A2A26', lineHeight: 1.2 }}>{step.title}</span>
                    <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#6A6A60', lineHeight: 1.65 }}>{step.desc}</span>
                  </div>
                </div>
                {i < STEPS.length - 1 && <div style={{ borderBottom: '1px dashed rgba(26,26,22,0.2)' }} />}
              </div>
            ))}
          </div>
        </div>

        {/* Right: concept image + pricing */}
        <div className="flex flex-col gap-4" style={{ flex: '1' }}>

          {/* Concept carousel */}
          <div className="relative rounded-3xl overflow-hidden" style={{ height: '240px', backgroundColor: '#F4EAD2', flexShrink: 0 }}>
            {conceptImage && (
              <img
                key={activeIdx}
                src={conceptImage}
                alt={`Concept ${activeIdx + 1}`}
                className="w-full h-full object-cover"
                style={{ transition: 'opacity 0.25s' }}
              />
            )}

            {/* Label */}
            <div className="absolute top-4 left-4 flex items-center rounded-full px-3 py-1.5"
              style={{ backgroundColor: 'white', border: '1px solid rgba(26,26,22,0.1)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#2F6B4F', display: 'inline-block', marginRight: '7px', flexShrink: 0 }} />
              <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#2A2A26' }}>
                Your selected concept{selectedConcepts.length > 1 ? 's' : ''}
              </span>
            </div>

            {/* Prev / next arrows — only when >1 image */}
            {selectedConcepts.length > 1 && (
              <>
                <button
                  onClick={() => setActiveIdx(i => (i - 1 + selectedConcepts.length) % selectedConcepts.length)}
                  className="absolute left-3 top-1/2 flex items-center justify-center rounded-full transition-all hover:opacity-90"
                  style={{ transform: 'translateY(-50%)', width: 32, height: 32, background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(4px)', border: 'none', cursor: 'pointer', fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26' }}>
                  ‹
                </button>
                <button
                  onClick={() => setActiveIdx(i => (i + 1) % selectedConcepts.length)}
                  className="absolute right-3 top-1/2 flex items-center justify-center rounded-full transition-all hover:opacity-90"
                  style={{ transform: 'translateY(-50%)', width: 32, height: 32, background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(4px)', border: 'none', cursor: 'pointer', fontFamily: IT, fontSize: '0.9rem', color: '#2A2A26' }}>
                  ›
                </button>

                {/* Dot indicators */}
                <div className="absolute bottom-3 left-1/2 flex gap-1.5" style={{ transform: 'translateX(-50%)' }}>
                  {selectedConcepts.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveIdx(i)}
                      style={{
                        width: i === activeIdx ? 18 : 6, height: 6, borderRadius: 999,
                        background: i === activeIdx ? 'white' : 'rgba(255,255,255,0.5)',
                        border: 'none', cursor: 'pointer', padding: 0,
                        transition: 'all 0.2s',
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Pricing */}
          <div className="flex flex-col rounded-3xl p-8 gap-6" style={{ backgroundColor: '#1f3f2c' }}>
            <div className="flex items-center justify-between">
              <span style={{ fontFamily: IS, fontSize: '2.5rem', color: 'white', lineHeight: 1, fontWeight: 400 }}>The Seedling Plan</span>
              <span style={{ fontFamily: IS, fontSize: '2.5rem', color: 'white', lineHeight: 1, fontWeight: 400 }}>$49</span>
            </div>
            <div className="flex flex-col gap-3.5">
              {FEATURES.map(f => (
                <p key={f} style={{ fontFamily: IT, fontSize: '0.87rem', color: 'rgba(255,255,255,0.82)', lineHeight: 1.5 }}>
                  — {f}
                </p>
              ))}
            </div>
          </div>

        </div>
      </div>
      </div>

      {/* Pay now — fixed bottom-right */}
      <button
        onClick={handleStart}
        className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
        style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500 }}
      >
        Pay now →
      </button>

      {/* Back */}
      <BackButton
        onClick={() => navigate(-1)}
        className="fixed bottom-8 left-10"
      />
    </div>
  );
}
