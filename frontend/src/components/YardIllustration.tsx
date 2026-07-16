// The STATIC "garden elevation illustration" of the finished yard — a hand-drawn,
// ground-level watercolour vignette (house elevation line-art at the back, planted beds
// and paths fanning toward the viewer, floating on paper). Same sketch kit as the 2D
// aerial plan.
//
// It renders ONCE into an offscreen canvas via paintElevation() (pure Canvas-2D, reads
// localStorage itself), caches the resulting PNG in sessionStorage keyed by
// planContentHash(), and shows it as an <img> on the paper background. No WebGL, no
// warm-up polling — the paint is synchronous. A try/catch → retry button is kept for
// safety (e.g. a transient canvas failure).
//
// Remount with a `key` (e.g. the caller's plantsVersion) to regenerate after an async
// backfill — planContentHash() is read fresh on mount, so a new key picks up new plants.
import { useEffect, useMemo, useState } from 'react';
import { paintElevation } from '../lib/elevationPainter';
import { preloadSpeciesSprites } from '../lib/elevationSprites';
import { planContentHash } from '../lib/planSignature';
import { IT } from '../lib/theme';

const PAPER_BG = '#f6f1e6';

// Offscreen source dimensions — the PNG inherits this backing store, so a big source
// yields a crisp picture regardless of on-page display size.
const SRC_W = 1600;
const SRC_H = 1000;

// Bump when the RENDERER changes (not just the plan) so a code change regenerates the cached
// image — the hash alone only tracks plan content. v2: per-species image sprites (fernbush).
// v3: existing kept features drawn (hardscape pads, existing-tree glyphs, structure boxes).
const RENDERER_VERSION = 'v4';   // v4: veggie garden drawn as caged tomato plants
const cacheKeyFor = (hash: string) => `diyHeroIllo_${RENDERER_VERSION}_${hash}`;
const readCache = (hash: string): string | null => {
  try { return sessionStorage.getItem(cacheKeyFor(hash)); } catch { return null; }
};

// Paint the elevation into an offscreen canvas and return a PNG data URL (or null on failure).
function renderElevation(): string | null {
  try {
    const cv = document.createElement('canvas');
    cv.width = SRC_W; cv.height = SRC_H;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    paintElevation(ctx, SRC_W, SRC_H);
    return cv.toDataURL('image/png');
  } catch {
    return null;
  }
}

export default function YardIllustration({ height, className, style }: { height?: number | string; className?: string; style?: React.CSSProperties }) {
  // Content hash is read once per mount; a new `key` from the caller re-reads it.
  const hash = useMemo(() => planContentHash(), []);

  const [imgUrl, setImgUrl] = useState<string | null>(() => readCache(hash));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump → re-run the paint

  useEffect(() => {
    if (imgUrl || failed) return;
    let cancelled = false;
    // Species image sprites (fernbush, …) must be decoded before the synchronous paint, or the
    // first render silently omits them. Preload once (cached after) then paint.
    preloadSpeciesSprites().then(() => {
      if (cancelled) return;
      const url = renderElevation();
      if (url) {
        try { sessionStorage.setItem(cacheKeyFor(hash), url); } catch { /* quota — hold in state only */ }
        setImgUrl(url);
      } else {
        setFailed(true);
      }
    });
    return () => { cancelled = true; };
  }, [hash, attempt, imgUrl, failed]);

  const retry = () => { setFailed(false); setAttempt(a => a + 1); };

  const box: React.CSSProperties = {
    position: 'relative', width: '100%', height: height ?? '100%',
    background: PAPER_BG, overflow: 'hidden', ...style,
  };

  return (
    <div className={className} style={box}>
      <style>{`@keyframes yardIlloShimmer { 0% { background-position: -600px 0; } 100% { background-position: 600px 0; } }`}</style>

      {imgUrl ? (
        // 'contain' on the paper background keeps it a faithful "picture on a page".
        <img src={imgUrl} alt="Illustration of your finished yard"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: PAPER_BG }} />
      ) : failed ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 20, background: PAPER_BG }}>
          <span style={{ fontFamily: IT, fontSize: '0.9rem', color: '#7A7A6E' }}>We couldn't illustrate your plan just now.</span>
          <button onClick={retry}
            style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#efe9db', background: '#2A2A26', border: 'none', cursor: 'pointer', padding: '9px 18px', borderRadius: 999 }}>
            Try again
          </button>
        </div>
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(100deg, #f2ece0 30%, #faf6ec 50%, #f2ece0 70%)', backgroundSize: '600px 100%', animation: 'yardIlloShimmer 1.6s linear infinite' }}>
          <span style={{ fontFamily: IT, fontSize: '0.92rem', color: '#8a8270', fontWeight: 500 }}>Illustrating your plan…</span>
        </div>
      )}
    </div>
  );
}
