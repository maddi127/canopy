import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Leaf, Star, Flower2, Heart, Droplets, Shield, Armchair, UtensilsCrossed, Flame, Waves, Sprout, Package, Upload, X } from 'lucide-react';
import Logo from '../components/Logo';
import AppStepper from '../components/AppStepper';

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

const YARD_TYPES = [
  { id: 'front', label: 'Front yard', description: 'The welcoming first impression' },
  { id: 'back',  label: 'Back yard',  description: 'Your private retreat' },
];

const STYLE_OPTIONS = [
  { id: 'natural_wild',      title: 'Whimsical',   description: 'Variety of colors and blooms',        photo: '/whimsical.jpg'   },
  { id: 'modern_structured', title: 'Modern',      description: 'Clean geometry and palette',  photo: '/modern.jpg'      },
  { id: 'traditional',       title: 'Traditional', description: 'Classic, polished layouts',                 photo: '/traditional.jpg' },
  { id: 'desert_minimal',    title: 'Desert',      description: 'Drought-tolerant, reduced turf',            photo: '/desert.jpg'      },
];

const ALL_GOALS = [
  { id: 'low_maintenance', label: 'Low maintenance',     icon: Leaf     },
  { id: 'curb_appeal',     label: 'Curb appeal',         icon: Star     },
  { id: 'pollinator',      label: 'Pollinator friendly', icon: Flower2  },
  { id: 'kid_pet',         label: 'Kid or pet friendly', icon: Heart    },
  { id: 'low_water',       label: 'Low water usage',     icon: Droplets },
  { id: 'privacy',         label: 'Privacy',             icon: Shield   },
];

const ALL_FEATURES = [
  { id: 'seating',  label: 'Seating area',     backOnly: false, icon: Armchair        },
  { id: 'dining',   label: 'Dining area',      backOnly: true,  icon: UtensilsCrossed },
  { id: 'cooking',  label: 'Cooking area',     backOnly: true,  icon: Flame           },
  { id: 'water',    label: 'Water feature',    backOnly: false, icon: Waves           },
  { id: 'garden',   label: 'Vegetable garden', backOnly: false, icon: Sprout          },
  { id: 'storage',  label: 'Storage shed',     backOnly: true,  icon: Package         },
];

const LAWN_OPTIONS = [
  { id: 'none', label: 'None',    value: 0,    desc: 'Only planted areas and hardscapes'  },
  { id: 'some', label: 'Some',    value: 0.25, desc: 'A modest open area for pets or kids' },
  { id: 'lot',  label: 'A lot',   value: 0.50, desc: 'Lawn is a central part of the yard' },
];

const QUESTIONS: Record<Step, string> = {
  1: 'What space would you like to design?',
  2: 'What style are you going for?',
  3: 'What are your priorities?',
  4: 'What features would you like?',
  5: 'How much lawn would you like?',
  6: 'Add a photo of your yard',
};

function FrontYardIllustration() {
  return (
    <svg viewBox="0 0 280 170" width="100%" preserveAspectRatio="xMidYMax meet"
      fill="none" stroke="#2F5D3A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="142" x2="276" y2="142" />
      <rect x="88" y="76" width="104" height="66" />
      <polyline points="72,76 140,30 208,76" />
      <rect x="162" y="38" width="14" height="28" />
      <path d="M 120 142 L 120 104 Q 140 96 160 104 L 160 142" />
      <path d="M 120 104 Q 140 96 160 104" />
      <rect x="96" y="88" width="20" height="18" rx="1" />
      <line x1="106" y1="88" x2="106" y2="106" />
      <line x1="96" y1="97" x2="116" y2="97" />
      <rect x="164" y="88" width="20" height="18" rx="1" />
      <line x1="174" y1="88" x2="174" y2="106" />
      <line x1="164" y1="97" x2="184" y2="97" />
      <path d="M 132 142 L 127 162 M 148 142 L 153 162" />
      <path d="M 16 142 C 14 129 23 122 31 127 C 33 119 45 118 48 126 C 52 119 63 122 60 133 C 65 127 77 130 74 142" />
      <path d="M 205 142 C 203 129 212 122 220 127 C 222 119 234 118 237 126 C 241 119 252 122 249 133 C 254 127 266 130 263 142" />
    </svg>
  );
}

function BackYardIllustration() {
  return (
    <svg viewBox="0 0 280 170" width="100%" preserveAspectRatio="xMidYMid meet"
      fill="none" stroke="#8B4A2C" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">

      {/* Ground */}
      <line x1="4" y1="150" x2="276" y2="150" />

      {/* Tree trunk */}
      <path d="M 57 150 C 54 135 62 122 60 101" strokeWidth="2.5" />
      {/* Organic multi-lobed canopy */}
      <path d="M 60 26 C 72 18 92 26 90 44 C 100 44 102 62 90 66 C 96 78 88 92 74 91 C 70 101 50 101 46 91 C 32 92 24 78 30 66 C 18 62 20 44 30 44 C 28 26 48 18 60 26 Z" />

      {/* Table top */}
      <rect x="132" y="93" width="80" height="8" rx="3" />
      {/* Table legs */}
      <line x1="141" y1="101" x2="139" y2="150" />
      <line x1="204" y1="101" x2="206" y2="150" />

      {/* Left chair — seat + back + legs */}
      <rect x="97" y="112" width="34" height="5" rx="1.5" />
      <rect x="122" y="88" width="5" height="29" rx="1.5" />
      <line x1="100" y1="117" x2="98" y2="150" />
      <line x1="128" y1="117" x2="129" y2="150" />

      {/* Right chair */}
      <rect x="213" y="112" width="34" height="5" rx="1.5" />
      <rect x="217" y="88" width="5" height="29" rx="1.5" />
      <line x1="216" y1="117" x2="214" y2="150" />
      <line x1="244" y1="117" x2="245" y2="150" />
    </svg>
  );
}

export default function PreferencesGoalsPage({ nextPath, skipPhoto }: { nextPath?: string; skipPhoto?: boolean } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const sc    = (() => { try { return JSON.parse(localStorage.getItem('siteContext')     || '{}'); } catch { return {}; } })();
  const saved = (() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } })();

  const [step,             setStep]             = useState<Step>(((location.state as any)?.step as Step) || 1);
  const [yardType,         setYardType]         = useState<string>(sc.yard_type || '');
  const [style,            setStyle]            = useState<string>(saved.style || '');
  const [selectedGoals,    setSelectedGoals]    = useState<string[]>(saved.goal_priority || []);
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>(saved.space_usage   || []);
  const [selectedLawn,     setSelectedLawn]     = useState<string>(LAWN_OPTIONS.find(o => o.value === saved.lawnTarget)?.id ?? '');
  const [photo,            setPhoto]            = useState<string | null>(sc.photo || null);
  const [dragging,         setDragging]         = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const goBack = () => {
    if (step > 1) setStep((step - 1) as Step);
    else navigate('/');
  };

  const handleYardType = (type: string) => {
    setYardType(type);
    setTimeout(() => setStep(2), 520);
  };

  const handleStyle = (styleId: string) => {
    setStyle(styleId);
    setTimeout(() => setStep(3), 520);
  };

  const toggleGoal = (id: string) => {
    setSelectedGoals(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleFeature = (id: string) => {
    setSelectedFeatures(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handlePhotoFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => setPhoto(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleFinish = (lawnId = selectedLawn) => {
    const validIds = new Set(ALL_FEATURES.filter(f => yardType !== 'front' || !f.backOnly).map(f => f.id));
    localStorage.setItem('userPreferences', JSON.stringify({
      style,
      goal_priority:  selectedGoals,
      not_important:  ALL_GOALS.filter(g => !selectedGoals.includes(g.id)).map(g => g.id),
      space_usage:    selectedFeatures.filter(id => validIds.has(id)),
      lawnTarget:     LAWN_OPTIONS.find(o => o.id === lawnId)?.value ?? null,
    }));
    const existing = (() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } })();
    localStorage.setItem('siteContext', JSON.stringify({
      ...existing,
      address: sc.address, lat: sc.lat, lng: sc.lng, yard_type: yardType,
      ...(photo ? { photo } : {}),
    }));
    navigate(nextPath ?? '/concept-generating');
  };

  const handleLawn = (id: string) => {
    setSelectedLawn(id);
    setTimeout(() => {
      if (skipPhoto) handleFinish(id);
      else setStep(6 as Step);
    }, 520);
  };

  const visibleFeatures = ALL_FEATURES.filter(f => yardType !== 'front' || !f.backOnly);

  return (
    <div className="min-h-screen flex flex-col pt-8 pb-24 relative" style={{ backgroundColor: '#efe9db' }}>

      {/* Header */}
      <div className="flex items-start justify-between px-10 mb-6 flex-shrink-0">
        <Logo />
        <AppStepper step={step} total={skipPhoto ? 5 : 6} />
      </div>

      {/* Question heading */}
      <h1 style={{ fontFamily: IS, fontSize: '4rem', color: '#2A2A26', lineHeight: 1.05, marginBottom: '1.5rem', paddingLeft: '8rem' }}>
        {QUESTIONS[step]}
      </h1>

      {/* ── Step 1: Yard type ─────────────────────────────────────── */}
      {step === 1 && (
        <div className="flex gap-5 mx-auto" style={{ maxWidth: '840px', width: '100%' }}>
          {YARD_TYPES.map((opt) => {
            const selected = yardType === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => handleYardType(opt.id)}
                className="flex-1 rounded-3xl focus:outline-none transition-all duration-300 hover:-translate-y-1 active:translate-y-0 flex flex-col overflow-hidden"
                style={{
                  backgroundColor: selected ? '#C8DFC8' : '#F4EAD2',
                  height: '460px',
                  border: '2px solid #1A1A16',
                }}
              >
                {/* Title + subtitle */}
                <div className="flex flex-col gap-2 px-6 pt-20 pb-4">
                  <span style={{ fontFamily: IS, fontSize: '2.4rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1 }}>
                    {opt.label}
                  </span>
                  <span style={{ fontFamily: IT, fontSize: '0.88rem', color: '#6A6A60', lineHeight: 1.5 }}>
                    {opt.description}
                  </span>
                </div>

                {/* Illustration */}
                <div className="flex-1 flex items-end justify-center px-6 pb-20">
                  {opt.id === 'front' ? <FrontYardIllustration /> : <BackYardIllustration />}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Step 2: Style ─────────────────────────────────────────── */}
      {step === 2 && (
        <div className="flex gap-4 mx-auto" style={{ width: '75%' }}>
          {STYLE_OPTIONS.map((opt) => {
            const selected = style === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => handleStyle(opt.id)}
                className="flex-1 rounded-3xl overflow-hidden focus:outline-none transition-all duration-300 hover:-translate-y-1 active:translate-y-0 flex flex-col"
                style={{
                  height: '420px',
                  border: selected ? '2px solid #1A1A16' : '1.5px solid rgba(26,26,22,0.18)',
                }}
              >
                {/* Photo area */}
                <div style={{ height: '67%', flexShrink: 0, overflow: 'hidden' }}>
                  <img src={opt.photo} alt={opt.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>

                {/* Text area */}
                <div
                  className="flex flex-col justify-center gap-1 px-5 py-4"
                  style={{ flex: 1, backgroundColor: selected ? '#C8DFC8' : '#F4EAD2', transition: 'background-color 0.3s ease' }}
                >
                  <span style={{ fontFamily: IS, fontSize: '2.4rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1 }}>
                    {opt.title}
                  </span>
                  <span style={{ fontFamily: IT, fontSize: '0.88rem', color: '#6A6A60', lineHeight: 1.5 }}>
                    {opt.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Step 3: Goals ─────────────────────────────────────────── */}
      {step === 3 && (
        <div className="flex flex-col gap-5 mx-auto" style={{ width: '75%' }}>
          <div className="flex flex-wrap justify-center gap-4">
            {ALL_GOALS.map(goal => {
              const selected = selectedGoals.includes(goal.id);
              const Icon = goal.icon;
              return (
                <button
                  key={goal.id}
                  onClick={() => toggleGoal(goal.id)}
                  className="rounded-3xl focus:outline-none transition-all duration-300 hover:-translate-y-1 active:translate-y-0 flex flex-col items-center justify-center gap-3 p-6"
                  style={{
                    width: 'calc(33.33% - 11px)',
                    height: '150px',
                    backgroundColor: selected ? '#C8DFC8' : '#F4EAD2',
                    border: selected ? '2px solid #1A1A16' : '1.5px solid rgba(26,26,22,0.18)',
                    transition: 'background-color 0.3s ease, transform 0.2s ease',
                  }}
                >
                  <Icon className="w-5 h-5" style={{ color: '#2A2A26' }} strokeWidth={1.5} />
                  <span style={{ fontFamily: IS, fontSize: '1.4rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1, textAlign: 'center' }}>
                    {goal.label}
                  </span>
                </button>
              );
            })}
          </div>

        </div>
      )}

      {/* ── Step 4: Features ──────────────────────────────────────── */}
      {step === 4 && (
        <div className="mx-auto" style={{ width: '75%' }}>
          <div className="flex flex-wrap justify-center gap-4">
            {visibleFeatures.map(opt => {
              const selected = selectedFeatures.includes(opt.id);
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  onClick={() => toggleFeature(opt.id)}
                  className="rounded-3xl focus:outline-none transition-all duration-300 hover:-translate-y-1 active:translate-y-0 flex flex-col items-center justify-center gap-3 p-6"
                  style={{
                    width: 'calc(33.33% - 11px)',
                    height: '150px',
                    backgroundColor: selected ? '#C8DFC8' : '#F4EAD2',
                    border: selected ? '2px solid #1A1A16' : '1.5px solid rgba(26,26,22,0.18)',
                    transition: 'background-color 0.3s ease, transform 0.2s ease',
                  }}
                >
                  <Icon className="w-5 h-5" style={{ color: '#2A2A26' }} strokeWidth={1.5} />
                  <span style={{ fontFamily: IS, fontSize: '1.4rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1, textAlign: 'center' }}>
                    {opt.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Step 5: Lawn ─────────────────────────────────────────── */}
      {step === 5 && (
        <div className="mx-auto" style={{ width: '75%' }}>
          <div className="flex gap-4">
            {LAWN_OPTIONS.map(opt => {
              const active = selectedLawn === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => handleLawn(opt.id)}
                  className="rounded-3xl focus:outline-none transition-all duration-300 hover:-translate-y-1 active:translate-y-0 flex flex-col items-center justify-center gap-2 p-6 flex-1"
                  style={{
                    height: '150px',
                    backgroundColor: active ? '#C8DFC8' : '#F4EAD2',
                    border: active ? '2px solid #1A1A16' : '1.5px solid rgba(26,26,22,0.18)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontFamily: IS, fontSize: '1.8rem', color: '#2A2A26', fontWeight: 400 }}>
                    {opt.label}
                  </span>
                  <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#7A7A73' }}>
                    {opt.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Step 6: Photo upload ──────────────────────────────────── */}
      {!skipPhoto && step === 6 && (
        <div className="mx-auto flex flex-col items-center gap-6" style={{ width: '75%', maxWidth: '640px' }}>
          <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#7A7A73', textAlign: 'center', lineHeight: 1.6 }}>
            A photo helps us generate concepts that match your home's architecture. You can skip this if you don't have one handy.
          </p>

          {photo ? (
            <div style={{ position: 'relative', width: '100%', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(26,26,22,0.12)' }}>
              <img src={photo} alt="Your yard" style={{ width: '100%', maxHeight: '360px', objectFit: 'cover', display: 'block' }} />
              <button
                onClick={() => setPhoto(null)}
                style={{ position: 'absolute', top: '12px', right: '12px', backgroundColor: 'rgba(26,26,22,0.7)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer' }}
              >
                <X size={16} color="white" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handlePhotoFile(f); }}
              style={{
                width: '100%', height: '280px', borderRadius: '20px', border: `2px dashed ${dragging ? '#2A2A26' : 'rgba(26,26,22,0.25)'}`,
                backgroundColor: dragging ? '#E8E2D4' : '#F4EAD2', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: '12px', cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              <Upload size={28} color="#7A7A73" strokeWidth={1.5} />
              <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#7A7A73' }}>Click or drag a photo here</span>
              <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#A8A8A0' }}>JPG or PNG</span>
            </button>
          )}

          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoFile(f); }} />
        </div>
      )}

      {/* Back — fixed bottom-left, hidden on step 1 */}
      {step > 1 && (
        <button
          onClick={goBack}
          className="fixed bottom-8 left-10 transition-all hover:opacity-70"
          style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500 }}
        >
          ← back
        </button>
      )}

      {/* Continue — fixed bottom-right, steps 3–4 and 6 */}
      {(step === 3 || step === 4 || step === 6) && (() => {
        const hasSelection = step === 3 ? selectedGoals.length > 0
                           : step === 4 ? selectedFeatures.length > 0
                           : photo !== null;
        const onClick = step === 3 ? () => setStep(4)
                      : step === 4 ? () => setStep(5 as Step)
                      : () => handleFinish();
        const primaryLabel = step === 6 ? 'Generate concepts →' : 'Continue →';
        const skipLabel    = step === 6 ? 'Skip, generate without photo →' : 'Skip →';
        return hasSelection ? (
          <button onClick={onClick}
            className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
            style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500 }}>
            {primaryLabel}
          </button>
        ) : (
          <button onClick={onClick}
            className="fixed bottom-8 right-10 transition-all hover:opacity-70"
            style={{ color: '#A8A8A0', fontFamily: IT, fontSize: '0.85rem' }}>
            {skipLabel}
          </button>
        );
      })()}
    </div>
  );
}
