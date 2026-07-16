import { useMemo, useRef, useState, useEffect } from 'react';
import DiyPlacementPage from './DiyPlacementPage';
import RegenPrompt from '../components/RegenPrompt';
import { generateLayout } from '../services/layoutGenerator';
import { sunMapForSite, type SunMap } from '../services/sunAnalysis';
import { inputSignature } from '../lib/planSignature';
import { GENERATOR_VERSION } from '../services/designPayload';
import { useAuth } from '../context/AuthContext';
import { getActiveDesignId, setActiveDesignId, saveActiveDesign } from '../services/activeDesign';
import { snapshotPlanInputs, restorePlanInputs } from '../lib/planInputs';

// Auto-layout: run a sun analysis of the site, generate a starting plan (features defaulted to a
// size/shape/location, biased by sun — veggie beds sunny, seating shadier), then reuse the
// /placement editor unchanged so everything stays fully editable.
//
// Phase 3a — no silent regeneration. The plan is generated exactly ONCE (first arrival, when no
// plan exists). After a plan exists we NEVER silently rebuild: if the design inputs changed since
// generation (inputSignature() !== stored diyPlacementPlanSig) we overlay RegenPrompt and let the
// user choose. A plain revisit with unchanged inputs keeps the current plan (and edits). The
// signature lives in lib/planSignature so the draft flow can write a matching one.

export default function DiyAutoLayoutPage() {
  const { user } = useAuth();
  const seedRef = useRef(1);
  const sunRef = useRef<SunMap | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // Remount key for DiyPlacementPage — bumping it makes the editor re-read diyPlacementPlan from
  // localStorage after an explicit regeneration so the UI reflects the fresh plan.
  const [placementKey, setPlacementKey] = useState(0);
  const wantPromptRef = useRef(false);

  const runGen = (seed: number, sig: string, sun: SunMap | null) => {
    try {
      const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      const prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}');
      const door = (() => { try { return JSON.parse(localStorage.getItem('diyDoorPoint') || 'null') || undefined; } catch { return undefined; } })();
      const yardType = (() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').yard_type || undefined; } catch { return undefined; } })();
      const plan = generateLayout({ boundary: saved.boundary || [], existing: saved.confirmedFeatures || [], prefs, seed, door, sun, yardType });
      if (plan) {
        const json = JSON.stringify(plan);
        localStorage.setItem('diyPlacementPlan', json);
        localStorage.setItem('diyPlacementPlanOriginal', json); // pristine copy for per-feature "reset"
        localStorage.setItem('diyPlacementPlanSig', sig);
        localStorage.setItem('diyPlanGeneratorVersion', GENERATOR_VERSION); // pin the version this plan was generated with
        snapshotPlanInputs(); // baseline for "return to my previous draft" (RegenPrompt discard)
      }
    } catch { /* ignore — editor falls back to an empty plan */ }
  };

  // Mount decision (synchronous, before the editor child reads localStorage).
  useMemo(() => {
    // Sun analysis — refreshed every visit (it feeds both generation and the "Your sun map" step).
    let sun: SunMap | null = null;
    try {
      const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      sun = sunMapForSite(saved.boundary || [], saved.confirmedFeatures || []);
      if (sun) localStorage.setItem('diySunMap', JSON.stringify(sun)); else localStorage.removeItem('diySunMap');
    } catch { /* none */ }
    sunRef.current = sun;

    const sig = inputSignature();
    let plan: any = {};
    try { plan = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { /* none */ }
    const hasPlan = plan.zones?.length || plan.beds?.length || plan.paths?.length;

    if (!hasPlan) {
      // First arrival — nothing to lose, generate once (this stamps a matching sig).
      runGen(seedRef.current, sig, sun);
      return;
    }
    if (localStorage.getItem('diyPlacementPlanSig') === sig) {
      // Inputs unchanged — keep the current plan (and edits). Ensure a pristine snapshot exists.
      if (!localStorage.getItem('diyPlacementPlanOriginal')) {
        localStorage.setItem('diyPlacementPlanOriginal', localStorage.getItem('diyPlacementPlan') || '{}');
      }
      return;
    }
    // Inputs changed since generation — do NOT regenerate. Surface the prompt (Task 2).
    wantPromptRef.current = true;
  }, []);

  // Set the prompt out of the render pass (useMemo above only records intent via the ref).
  useEffect(() => { if (wantPromptRef.current) setShowPrompt(true); }, []);

  const regenerate = () => {
    runGen(seedRef.current, inputSignature(), sunRef.current);
    setShowPrompt(false);
    setPlacementKey(k => k + 1); // remount the editor so it re-reads the fresh plan
  };
  const keep = () => {
    // "Discard my edits — return to my previous draft": restore the inputs the current plan was made
    // with (so Preferences reflects the previous draft, not the abandoned changes), re-stamp a matching
    // sig, and remount the editor so its prefs-derived controls re-read the restored values.
    restorePlanInputs();
    localStorage.setItem('diyPlacementPlanSig', inputSignature());
    setShowPrompt(false);
    setPlacementKey(k => k + 1);
  };

  // Phase 4a — "Start a new design": preserve the current design row (old inputs + plan) and branch
  // a fresh sibling under the same project with the changed inputs. Only offered when eligible
  // (signed in + a saved current design to branch FROM). The step order below is delicate.
  const eligibleForNewDesign = !!user && getActiveDesignId() !== null;
  const startNewDesign = async () => {
    // 1. Do NOT flush the current (mismatched) localStorage to the current design — its row already
    //    holds its last clean {old inputs + plan} from the editor-unmount flush. Leave it alone.
    // 2. Detach the active id so the upcoming save CREATES a new row instead of updating the current.
    setActiveDesignId(null);
    // 3. Run the SAME fresh-generation path used when no plan exists — localStorage now holds
    //    {new inputs + new plan} and a matching sig + generator version.
    runGen(seedRef.current, inputSignature(), sunRef.current);
    // 4. Persist: upsert address, find the SAME project (onConflict address_id+yard_type), create the
    //    new sibling design row, and set the new activeDesignId. Never trap the user on failure.
    try {
      await saveActiveDesign();
    } catch (e) {
      console.error('[startNewDesign] saveActiveDesign failed; proceeding with local plan', e);
    }
    // 5. Close the modal and remount the editor so it re-reads the fresh plan.
    setShowPrompt(false);
    setPlacementKey(k => k + 1);
  };

  return (
    <>
      <DiyPlacementPage key={placementKey} illustrative />
      {showPrompt && (
        <RegenPrompt
          onRegenerate={regenerate}
          onKeep={keep}
          onNewDesign={eligibleForNewDesign ? startNewDesign : undefined}
        />
      )}
    </>
  );
}
