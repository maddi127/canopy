import { useMemo, useRef } from 'react';
import DiyPlacementPage from './DiyPlacementPage';
import { generateLayout } from '../services/layoutGenerator';
import { sunMapForSite, type SunMap } from '../services/sunAnalysis';

// Auto-layout: run a sun analysis of the site, generate a starting plan (features defaulted to a
// size/shape/location, biased by sun — veggie beds sunny, seating shadier), then reuse the
// /placement editor unchanged so everything stays fully editable. The plan is regenerated whenever
// the design INPUTS change (boundary, existing features, preferences, entry point) but preserved on
// a plain revisit, so manual edits aren't blown away.

function inputSignature(): string {
  try {
    const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
    const prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}');
    const site = JSON.parse(localStorage.getItem('siteContext') || '{}');
    const door = localStorage.getItem('diyDoorPoint') || 'null';
    return JSON.stringify({
      v: 'g4', // bump when the generator's rules change so the plan regenerates once
      boundary: saved.boundary ?? [],
      existing: (saved.confirmedFeatures ?? []).map((f: any) => [f.type, f.keep, f.vertices?.length]),
      features: prefs.space_usage ?? [],
      lawn: prefs.lawnTarget ?? 0,
      style: prefs.style ?? '',
      yard: site.yard_type ?? prefs.yard_type ?? '',
      door,
    });
  } catch { return ''; }
}

export default function DiyAutoLayoutPage() {
  const seedRef = useRef(1);

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
      }
    } catch { /* ignore — editor falls back to an empty plan */ }
  };

  useMemo(() => {
    // Sun analysis — refreshed every visit (it feeds both generation and the "Your sun map" step).
    let sun: SunMap | null = null;
    try {
      const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      sun = sunMapForSite(saved.boundary || [], saved.confirmedFeatures || []);
      if (sun) localStorage.setItem('diySunMap', JSON.stringify(sun)); else localStorage.removeItem('diySunMap');
    } catch { /* none */ }

    // Regenerate the plan only when inputs changed; otherwise keep the current plan (and edits).
    const sig = inputSignature();
    let plan: any = {};
    try { plan = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}'); } catch { /* none */ }
    const hasPlan = plan.zones?.length || plan.beds?.length || plan.paths?.length;
    if (hasPlan && localStorage.getItem('diyPlacementPlanSig') === sig) {
      // Keeping the current plan — make sure a pristine snapshot exists for per-feature "reset".
      if (!localStorage.getItem('diyPlacementPlanOriginal')) {
        localStorage.setItem('diyPlacementPlanOriginal', localStorage.getItem('diyPlacementPlan') || '{}');
      }
      return;
    }
    runGen(seedRef.current, sig, sun);
  }, []);

  return <DiyPlacementPage illustrative />;
}
