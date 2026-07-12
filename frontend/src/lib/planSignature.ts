// The design-input signature: identifies WHICH inputs produced the current auto-generated plan.
// The studio (/diy/auto-layout) regenerates when it changes and preserves edits when it matches;
// the draft flow writes a matching signature so handing off to the studio keeps the draft intact.
// Bump `v` whenever the generator's rules change so existing plans regenerate once.
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
    let street: { gate: [boolean, string | null]; drive: [boolean, string | null]; porch: boolean } | null = null;
    try {
      const sv = JSON.parse(localStorage.getItem('diyStreetView') || 'null');
      const ins = sv?.result?.insights;
      if (ins) street = {
        gate:  [ins.sideGate?.present ?? false, ins.sideGate?.side ?? null],
        drive: [ins.driveway?.present ?? false, ins.driveway?.side ?? null],
        porch: ins.frontPorch?.present ?? false,
      };
    } catch { street = null; }
    return JSON.stringify({
      v: 'g20', // g20: only shade-tolerant plants under existing tree canopies
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
