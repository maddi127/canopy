// Shared render/cache logic for the Gemini "real-life photo" of the plan, used by both
// /diy/plan-ready (auto-generate 1× when the plan first appears) and /diy/review (the final
// output, regenerated when the plan changed since the last render).
//
// The cache key is derived from planContentHash() — a hash of the ACTUAL plan + plant content —
// so edits invalidate the cached photo (unlike inputSignature(), which never changes on edits).
// The key is recomputed at generate time (not just on mount) because plants may be backfilled
// asynchronously after the component mounts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { renderPlanImage, refinePlanImage } from '../services/planRenderService';
import { planContentHash } from '../lib/planSignature';

export interface CaptureRefs { planPng: string | null; perspectivePng: string | null }

const cacheKeyFor = (hash: string) => `diyPlanRender_${hash}`;
const attemptKeyFor = (hash: string) => `diyPlanRenderAttempted_${hash}`;

const readCache = (hash: string): string | null => {
  try { return sessionStorage.getItem(cacheKeyFor(hash)); } catch { return null; }
};

export interface PlanRender {
  renderUrl: string | null;
  rendering: boolean;
  /** Which pass is currently in flight (`rendering` stays true across both for back-compat). */
  phase: 'idle' | 'rendering' | 'refining';
  renderErr: string | null;
  /** Manual generate — ignores the auto-fire marker; used by the "⟳ Regenerate" button. */
  generate: (refs: CaptureRefs) => Promise<void>;
  /**
   * Auto-generate ONCE for the current content hash, if there's no cached render for it.
   * Waits for capture readiness (polls getRefs via rAF until both PNGs are non-null; the WebGL
   * canvas needs a couple frames), gives up after ~5s. Guards against StrictMode double-fire and
   * a sessionStorage marker so an error never re-bills on every visit. Manual regenerate ignores
   * the marker. `enabled` gates firing until the plan/plants are resolved.
   */
  autoGenerateOnce: (getRefs: () => CaptureRefs | null, enabled: boolean) => void;
}

export function usePlanRender(opts?: { refine?: boolean }): PlanRender {
  const refine = opts?.refine ?? false;
  // Initial render from the cache for the CURRENT content hash (may be stale if plants backfill).
  const [renderUrl, setRenderUrl] = useState<string | null>(() => readCache(planContentHash()));
  const [rendering, setRendering] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'rendering' | 'refining'>('idle');
  const [renderErr, setRenderErr] = useState<string | null>(null);

  // Track the last content hash we've reconciled the cache against; re-check when plants backfill.
  const lastHashRef = useRef<string>(planContentHash());
  const autoFiredRef = useRef(false); // StrictMode double-invoke guard for the current hash
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
  }, []);

  const runRender = useCallback(async (refs: CaptureRefs, hash: string) => {
    if (!refs.planPng) { setRenderErr("Couldn't capture the plan — try again."); return; }
    setRendering(true); setPhase('rendering'); setRenderErr(null);
    try {
      // Pass 1: the photographic render from the plan + massing.
      let url = await renderPlanImage({ perspectivePng: refs.perspectivePng, planPng: refs.planPng });
      // Pass 2 (optional): a corrective refine against the 3D massing. Only runs when a perspective
      // was captured. A refine failure is non-fatal — pass 1 already succeeded, so we keep its url
      // and just log a warning rather than surfacing an error to the user.
      if (refine && refs.perspectivePng) {
        setPhase('refining');
        try {
          url = await refinePlanImage({ photoPng: url, perspectivePng: refs.perspectivePng });
        } catch (e: any) {
          console.warn('[planRender] refine failed, using pass-1 render', e);
        }
      }
      setRenderUrl(url);
      // Cache only the FINAL url under the content-hash key.
      try { sessionStorage.setItem(cacheKeyFor(hash), url); } catch { /* too big for the cache — fine */ }
    } catch (e: any) {
      setRenderErr('Rendering failed — try again in a moment.');
      console.error('[planRender]', e);
    } finally { setRendering(false); setPhase('idle'); }
  }, [refine]);

  const generate = useCallback(async (refs: CaptureRefs) => {
    // Recompute at generate time — plants may have been backfilled since mount.
    await runRender(refs, planContentHash());
  }, [runRender]);

  const autoGenerateOnce = useCallback((getRefs: () => CaptureRefs | null, enabled: boolean) => {
    if (!enabled || autoFiredRef.current) return;

    // Recompute the current content hash — plants may have just been backfilled.
    const hash = planContentHash();

    // If the hash changed since mount, re-check the cache for this content.
    if (hash !== lastHashRef.current) {
      lastHashRef.current = hash;
      const cached = readCache(hash);
      if (cached) { setRenderUrl(cached); return; }
    }

    // Already have a render for this content → nothing to do.
    if (readCache(hash)) return;
    // Already attempted this content in this session (success or error) → don't re-bill.
    try { if (sessionStorage.getItem(attemptKeyFor(hash))) return; } catch { /* ignore */ }

    autoFiredRef.current = true;
    try { sessionStorage.setItem(attemptKeyFor(hash), '1'); } catch { /* ignore */ }

    // Poll for capture readiness — the WebGL canvas needs a couple frames before it yields a PNG.
    const start = Date.now();
    const tick = () => {
      const refs = getRefs();
      if (refs && refs.planPng && refs.perspectivePng) {
        void runRender(refs, hash);
        return;
      }
      if (Date.now() - start > 5000) {
        // Give up quietly — the manual "Regenerate" button is still available.
        const refs2 = getRefs();
        if (refs2 && refs2.planPng) void runRender(refs2, hash); // best-effort with plan-only
        else setRenderErr('Rendering failed — try again in a moment.');
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [runRender]);

  return { renderUrl, rendering, phase, renderErr, generate, autoGenerateOnce };
}
