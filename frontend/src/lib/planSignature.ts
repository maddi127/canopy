import { STREET_VIEW_ENABLED } from '../services/streetViewService';

// The design-input signature: a pure input-change detector. It answers exactly one question —
// "did the design INPUTS change since this plan was generated?" — and nothing else. It NEVER
// carries a generator version: that is now pinned per-design via generator_version /
// diyPlanGeneratorVersion (Phase 2), so an engine version bump must NOT change this hash or it
// would falsely report an input change. The draft flow writes a matching signature so handing off
// to the studio keeps the draft intact; a mismatch on mount surfaces the "your changes aren't in
// the plan yet" prompt (RegenPrompt) — it never silently regenerates.
// Content hash of the CURRENT plan + placed plants — unlike inputSignature(), this changes when
// the user edits the plan (drags a feature, adds a walkway, swaps plants), so anything derived
// from the plan's actual content (e.g. the AI rendering cache) stays honest after edits.
export function planContentHash(): string {
  try {
    const plan = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
    const plants: any[] = JSON.parse(localStorage.getItem('diyPlantInstances') || '[]');
    const src = JSON.stringify({
      zones: (plan.zones ?? []).map((z: any) => [z.key, z.label, z.shape, z.material, Math.round(z.x ?? 0), Math.round(z.y ?? 0), Math.round(z.wFt ?? 0), Math.round(z.hFt ?? 0)]),
      beds: (plan.beds ?? []).map((b: any) => [b.material, Math.round(b.x ?? 0), Math.round(b.y ?? 0), Math.round(b.wFt ?? 0), Math.round(b.hFt ?? 0)]),
      paths: (plan.paths ?? []).map((p: any) => [p.kind, p.material, p.widthFt, p.pts?.length]),
      primary: [plan.primary?.material ?? '', plan.primary?.variant ?? ''],
      // Plant coords are lng/lat — scale before rounding so moves actually change the hash.
      plants: plants.map(p => [p.name, p.color, Math.round((p.x ?? 0) * 1e6), Math.round((p.y ?? 0) * 1e6)]),
    });
    // FNV-1a — cheap, deterministic, good enough for a cache key.
    let h = 0x811c9dc5;
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  } catch { return 'nohash'; }
}

export function inputSignature(): string {
  try {
    const saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
    const prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}');
    const site = JSON.parse(localStorage.getItem('siteContext') || '{}');
    const door = localStorage.getItem('diyDoorPoint') || 'null';
    // Placement-relevant Street View facts ONLY — the side gate + driveway sides feed layout rules.
    // House colours/roof are render-only and deliberately excluded: they must not change the plan
    // signature (which gates regeneration) or a first Street View fetch would clobber user edits.
    // Street View is parked (see STREET_VIEW_ENABLED): don't let a stale diyStreetView entry feed the
    // signature, so it can never trigger a regeneration while disabled.
    let street: { gate: [boolean, string | null]; drive: [boolean, string | null]; porch: boolean } | null = null;
    if (STREET_VIEW_ENABLED) try {
      const sv = JSON.parse(localStorage.getItem('diyStreetView') || 'null');
      const ins = sv?.result?.insights;
      if (ins) street = {
        gate:  [ins.sideGate?.present ?? false, ins.sideGate?.side ?? null],
        drive: [ins.driveway?.present ?? false, ins.driveway?.side ?? null],
        porch: ins.frontPorch?.present ?? false,
      };
    } catch { street = null; }
    return JSON.stringify({
      // No `v`/generator-version tag here — this hash tracks design INPUTS only (see header).
      boundary: saved.boundary ?? [],
      existing: (saved.confirmedFeatures ?? []).map((f: any) => [f.type, f.keep, f.vertices?.length]),
      features: prefs.space_usage ?? [],
      lawn: prefs.lawnTarget ?? 0,
      style: prefs.style ?? '',
      yard: site.yard_type ?? prefs.yard_type ?? '',
      door,
      street,
    });
  } catch { return ''; }
}
