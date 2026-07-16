import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import BackButton from '../components/BackButton';
import { generateLandscapeConcept, type GenerateConceptParams } from '../services/geminiService';

import { IS, IT, PAGE_BG } from '../lib/theme';

const LOADING_MESSAGES = [
  'Analyzing your yard…',
  'Applying your style…',
  'Generating concepts…',
  'Almost ready…',
];

// Subtle variation nudges — enough to produce distinct results without overriding the user's stated style
const VARIANTS = [
  '',
  'Try a different seasonal color palette and vary the plant placement.',
  'Explore an alternative layout with different focal points and plant groupings.',
];

async function compressImage(dataUrl: string, maxDim = 1200, quality = 0.82): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export default function DiyConceptPage() {
  const navigate  = useNavigate();
  const started   = useRef(false);

  // 3 concept slots — null = not yet loaded
  const [concepts, setConcepts]   = useState<(string | null)[]>([null, null, null]);
  const [errors,   setErrors]     = useState<(string | null)[]>([null, null, null]);
  const [loading,  setLoading]    = useState<boolean[]>([true, true, true]);
  const [selected, setSelected]   = useState<Set<number>>(new Set());
  const [msgIdx,   setMsgIdx]     = useState(0);

  const anyLoading = loading.some(Boolean);
  const anyReady   = concepts.some(Boolean);
  const allFailed  = !anyLoading && !anyReady;

  const buildParams = useCallback((variantHint: string): GenerateConceptParams => {
    const sc:    any = (() => { try { return JSON.parse(localStorage.getItem('siteContext')    || '{}'); } catch { return {}; } })();
    const prefs: any = (() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } })();
    return {
      photoDataUrl:     sc.photo ?? '',
      address:          sc.address ?? '',
      yardType:         sc.yard_type ?? prefs.yardType ?? 'yard',
      style:            prefs.style ?? 'traditional',
      priorities:       prefs.goal_priority ?? [],
      features:         prefs.space_usage ?? [],
      editInstructions: variantHint || undefined,
      polygonRing:      sc.polygon ?? undefined,
      usdaZone:         sc.usda_zone ?? undefined,
      photoPolygon:     sc.photo_polygon ?? undefined,
      houseFootprint:   sc.house_footprint ?? undefined,
    };
  }, []);

  const generateAll = useCallback(() => {
    setConcepts([null, null, null]);
    setErrors([null, null, null]);
    setLoading([true, true, true]);
    setSelected(new Set());

    VARIANTS.forEach((hint, i) => {
      generateLandscapeConcept(buildParams(hint))
        .then(result => {
          setConcepts(prev => prev.map((c, idx) => idx === i ? result.imageDataUrl : c));
          setLoading(prev  => prev.map((l, idx) => idx === i ? false : l));
        })
        .catch(err => {
          setErrors(_prev => errors.map((e, idx) => idx === i ? (err?.message ?? 'Failed') : e));
          setLoading(prev => prev.map((l, idx) => idx === i ? false : l));
        });
    });
  }, [buildParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => Math.min(i + 1, LOADING_MESSAGES.length - 1)), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    generateAll();
  }, [generateAll]);

  const toggleSelect = (i: number) => {
    if (!concepts[i]) return;
    setSelected(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const handleContinue = async () => {
    const chosen = [...selected].sort().map(i => concepts[i]!).filter(Boolean);
    if (!chosen.length) return;
    const compressed = await Promise.all(chosen.map(c => compressImage(c)));
    localStorage.setItem('diySelectedConcepts', JSON.stringify(compressed));
    localStorage.setItem('generatedConcept', compressed[0]); // backwards-compat
    navigate('/diy/payment');
  };

  const [activeIdx, setActiveIdx] = useState(0);
  const canContinue = selected.size > 0;

  const prev = () => setActiveIdx(i => (i - 1 + 3) % 3);
  const next = () => setActiveIdx(i => (i + 1) % 3);

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: PAGE_BG, overflow: 'hidden' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div className="flex items-start px-10 pt-8 mb-6 flex-shrink-0">
        <Logo />
      </div>

      {/* Title — visible once something is loading or ready */}
      <div className="px-10 mb-5 flex-shrink-0">
        <h1 style={{ fontFamily: IS, fontSize: '3rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>
          {anyLoading && !anyReady ? 'Generating your concepts…' : 'Choose the concepts you love.'}
        </h1>
        {(!anyLoading || anyReady) && (
          <p style={{ fontFamily: IT, fontSize: '0.88rem', color: '#6A6A60', marginTop: '0.5rem' }}>
            Pick all the images that inspire you — we'll refine the plan together later.
          </p>
        )}
        {anyLoading && !anyReady && (
          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', marginTop: '0.5rem' }}>
            {LOADING_MESSAGES[msgIdx]}
          </p>
        )}
      </div>

      {/* All-failed state */}
      {allFailed && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5">
          <p style={{ fontFamily: IS, fontStyle: 'italic', fontSize: '1.6rem', color: '#2A2A26' }}>Generation failed</p>
          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#D65C5C' }}>
            {errors.find(Boolean) ?? 'Something went wrong.'}
          </p>
          <button
            onClick={() => { started.current = false; generateAll(); }}
            className="px-6 py-2.5 rounded-full hover:opacity-90 transition-all"
            style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      )}

      {/* Carousel */}
      {!allFailed && (
        <div className="flex-1 overflow-hidden px-10 pb-20 flex flex-col gap-4">

          {/* Main slide */}
          <div
            className="flex-1 relative rounded-3xl overflow-hidden"
            style={{ background: '#F4EAD2', cursor: concepts[activeIdx] ? 'pointer' : 'default' }}
            onClick={() => toggleSelect(activeIdx)}
          >
            {/* Loading */}
            {loading[activeIdx] && (
              <div className="w-full h-full flex flex-col items-center justify-center gap-4">
                <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid rgba(42,42,38,0.12)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite' }} />
                <span style={{ fontFamily: IT, fontSize: '0.75rem', color: '#B0B0A6' }}>
                  {LOADING_MESSAGES[msgIdx]}
                </span>
              </div>
            )}

            {/* Error */}
            {!loading[activeIdx] && errors[activeIdx] && (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                <span style={{ fontFamily: IT, fontSize: '0.78rem', color: '#D65C5C' }}>Failed to generate</span>
                <button
                  onClick={e => { e.stopPropagation(); started.current = false; generateAll(); }}
                  style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  retry all
                </button>
              </div>
            )}

            {/* Image */}
            {concepts[activeIdx] && (
              <>
                <img
                  key={activeIdx}
                  src={concepts[activeIdx]!}
                  alt={`Concept ${activeIdx + 1}`}
                  className="w-full h-full object-cover block"
                  style={{ opacity: selected.has(activeIdx) ? 1 : 0.9, transition: 'opacity 0.15s' }}
                />
                {selected.has(activeIdx) && (
                  <div className="absolute inset-0" style={{ background: 'rgba(47,107,79,0.1)' }} />
                )}

                {/* Select / deselect badge */}
                <div
                  className="absolute top-4 right-4 flex items-center gap-2 rounded-full px-4 py-2"
                  style={{
                    background: selected.has(activeIdx) ? '#2F6B4F' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(8px)',
                    border: selected.has(activeIdx) ? 'none' : '1.5px solid rgba(255,255,255,0.9)',
                    transition: 'all 0.15s',
                  }}>
                  <span style={{ fontFamily: IT, fontSize: '0.75rem', fontWeight: 600, color: selected.has(activeIdx) ? 'white' : '#2A2A26' }}>
                    {selected.has(activeIdx) ? '✓ Selected' : 'Select this'}
                  </span>
                </div>
              </>
            )}

            {/* Prev / next arrows */}
            <button onClick={e => { e.stopPropagation(); prev(); }}
              className="absolute left-4 top-1/2 flex items-center justify-center rounded-full hover:opacity-90 transition-all"
              style={{ transform: 'translateY(-50%)', width: 40, height: 40, background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(6px)', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: '#2A2A26' }}>
              ‹
            </button>
            <button onClick={e => { e.stopPropagation(); next(); }}
              className="absolute right-4 top-1/2 flex items-center justify-center rounded-full hover:opacity-90 transition-all"
              style={{ transform: 'translateY(-50%)', width: 40, height: 40, background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(6px)', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: '#2A2A26' }}>
              ›
            </button>
          </div>

          {/* Dot / thumbnail strip */}
          <div className="flex justify-center items-center gap-3 flex-shrink-0">
            {concepts.map((img, i) => {
              const isActive   = i === activeIdx;
              const isSelected = selected.has(i);
              const isLoading  = loading[i];
              return (
                <button
                  key={i}
                  onClick={() => setActiveIdx(i)}
                  style={{
                    width: 56, height: 56, borderRadius: 12, overflow: 'hidden', padding: 0,
                    border: isActive ? `3px solid ${isSelected ? '#2F6B4F' : '#2A2A26'}` : `2px solid ${isSelected ? '#2F6B4F' : 'rgba(42,42,38,0.15)'}`,
                    cursor: 'pointer', position: 'relative', flexShrink: 0,
                    background: '#F4EAD2',
                    transition: 'border-color 0.15s',
                  }}>
                  {img
                    ? <img src={img} alt={`Concept ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : isLoading
                      ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(42,42,38,0.15)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite' }} />
                        </div>
                      : null
                  }
                  {isSelected && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(47,107,79,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ color: 'white', fontSize: '0.7rem', fontWeight: 700, textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>✓</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <BackButton onClick={() => navigate(-1)}
        className="fixed bottom-8 left-10" />

      {anyReady && (
        <button
          onClick={handleContinue}
          disabled={!canContinue}
          className="fixed bottom-8 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90 disabled:opacity-35"
          style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: canContinue ? 'pointer' : 'default' }}>
          {canContinue
            ? `Continue with ${selected.size} concept${selected.size !== 1 ? 's' : ''} →`
            : 'Select at least one to continue'}
        </button>
      )}
    </div>
  );
}
