import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import { generateFinalPlanImage } from '../services/geminiService';
import { PLANTS } from '../features/planting/plantDatabase';
import type { ZonePalette } from '../features/planting/paletteCurator';

const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

const LOADING_MESSAGES = [
  'Painting your landscape…',
  'Adding plants and texture…',
  'Refining the details…',
  'Almost ready…',
];

async function compressImage(dataUrl: string, maxDim = 1400, quality = 0.88): Promise<string> {
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

export default function DiyFinalRenderPage() {
  const navigate  = useNavigate();
  const started   = useRef(false);

  const [image,   setImage]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [msgIdx,  setMsgIdx]  = useState(0);

  // ── Read data from localStorage ────────────────────────────────────────────
  const sc    = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext')     || '{}'); } catch { return {}; } }, []);
  const prefs = useMemo(() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } }, []);
  const palettes: ZonePalette[] = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyPalettes') || '[]'); } catch { return []; } }, []);
  const { featureZones, boundaryVerts } = useMemo(() => {
    try {
      const bd = JSON.parse(localStorage.getItem('diyBoundary') || '{}');
      return {
        featureZones:  (bd.featureZones ?? []) as any[],
        boundaryVerts: (bd.ring ?? []) as [number, number][],
      };
    } catch { return { featureZones: [], boundaryVerts: [] }; }
  }, []);

  // Derive plant list from palettes + PLANTS database
  const plants = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const p of palettes) {
      for (const s of p.selections) {
        countMap.set(s.plantId, (countMap.get(s.plantId) ?? 0) + s.targetCount);
      }
    }
    return [...countMap.entries()].flatMap(([id, count]) => {
      const plant = PLANTS.find(p => p.id === id);
      if (!plant) return [];
      return [{ commonName: plant.common_name, botanicalName: plant.botanical_name, type: plant.type, count }];
    });
  }, [palettes]);

  // Rotating loading message
  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => Math.min(i + 1, LOADING_MESSAGES.length - 1)), 6000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const photo = sc.photo ?? '';
    if (!photo) { setError('No photo found.'); setLoading(false); return; }

    generateFinalPlanImage({
      photoDataUrl: photo,
      address:      sc.address ?? '',
      yardType:     sc.yard_type ?? prefs.yardType ?? 'yard',
      style:        prefs.style ?? 'traditional',
      priorities:   prefs.goal_priority ?? [],
      plants,
      boundaryVerts,
      zones: featureZones.map((z: any) => ({
        toolId:   z.toolId,
        label:    z.label,
        color:    z.color,
        vertices: z.vertices,
        existing: z.existing,
      })),
    })
      .then(async url => {
        const compressed = await compressImage(url);
        localStorage.setItem('diyFinalRender', compressed);
        setImage(compressed);
        setLoading(false);
      })
      .catch(err => {
        setError(err?.message ?? 'Generation failed.');
        setLoading(false);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContinue = () => navigate('/diy/plan');

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#efe9db', overflow: 'hidden' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0">
        <Logo />
      </div>

      <div className="px-10 mt-8 mb-5 flex-shrink-0">
        <h1 style={{ fontFamily: IS, fontSize: '3rem', color: '#2A2A26', lineHeight: 1.05, margin: 0, fontWeight: 400 }}>
          {loading ? 'Rendering your plan…' : error ? 'Generation failed' : 'Your finished landscape.'}
        </h1>
        <p style={{ fontFamily: IT, fontSize: '0.88rem', color: '#6A6A60', marginTop: '0.5rem' }}>
          {loading
            ? LOADING_MESSAGES[msgIdx]
            : error
              ? error
              : 'A photorealistic view of your design with every selected plant in place.'}
        </p>
      </div>

      <div className="flex-1 overflow-hidden px-10 pb-20">
        <div className="h-full rounded-3xl overflow-hidden relative" style={{ background: '#F4EAD2' }}>

          {loading && (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
              <div style={{ width: 32, height: 32, borderRadius: '50%', border: '3px solid rgba(42,42,38,0.1)', borderTopColor: '#C77C5B', animation: 'spin 0.9s linear infinite' }} />
              <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#B0B0A6' }}>{LOADING_MESSAGES[msgIdx]}</span>
            </div>
          )}

          {!loading && error && (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
              <p style={{ fontFamily: IS, fontStyle: 'italic', fontSize: '1.4rem', color: '#2A2A26' }}>Something went wrong</p>
              <p style={{ fontFamily: IT, fontSize: '0.8rem', color: '#D65C5C' }}>{error}</p>
              <button
                onClick={() => { started.current = false; setLoading(true); setError(null); setMsgIdx(0); }}
                className="px-6 py-2.5 rounded-full hover:opacity-90 transition-all"
                style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                Try again
              </button>
            </div>
          )}

          {image && (
            <img src={image} alt="Final landscape render"
              className="w-full h-full object-cover block" />
          )}
        </div>
      </div>

      <button onClick={() => navigate(-1)}
        className="fixed bottom-6 left-10 hover:opacity-70 transition-all"
        style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>

      {image && (
        <button onClick={handleContinue}
          className="fixed bottom-6 right-10 flex items-center gap-2.5 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
          style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          Continue to my plan →
        </button>
      )}
    </div>
  );
}
