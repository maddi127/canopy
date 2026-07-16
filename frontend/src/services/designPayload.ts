/**
 * designPayload — the ONE place that maps the DIY flow's localStorage state
 * ⇄ the relational row shapes (addresses / projects / designs).
 *
 * The flow itself still reads and writes localStorage exactly as before (Phase 1
 * changes the data layer only, not the flow). This module is the seam between
 * that working cache and the Supabase rows: `collectActiveDesign` splits the
 * current localStorage state into the three row shapes for persistence, and
 * `applyDesign` writes a loaded row back into the exact keys the flow reads.
 *
 * See docs/data-model.md and backend/scripts/schema_relational_v1.sql.
 */

import { inputSignature } from '../lib/planSignature';
import { snapshotPlanInputs } from '../lib/planInputs';

// Pinned generator version stamped onto newly-generated designs (written to
// diyPlanGeneratorVersion at each generation site). Bumped when the generator's
// rules change so a design records which engine produced it; the Phase 4c
// "regenerate with the improved planner" offer compares this to the current value.
// A bump does NOT force regeneration — existing designs keep their plan until the
// user explicitly regenerates. g23: the lawn sweeps several proportions and keeps the largest that
// fits beside features (fills far more of a narrow yard). g21: lawn sits beside features + walkways skirt.
export const GENERATOR_VERSION = 'g23';

// ── Row shapes (subset of DB columns the client controls; ids/timestamps/user_id
//    are managed by Supabase + triggers and live in db.ts's *Row types) ──────────
export interface AddressData {
  formatted_address: string;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  hardiness_zone: string | null;
}

export interface ProjectData {
  yard_type: string;
}

export interface DesignData {
  name: string | null;
  boundary: unknown | null;
  existing_features: unknown | null;
  door_point: unknown | null;
  sun_map: unknown | null;
  preferences: Record<string, unknown> | null;
  plan: unknown | null;
  plant_instances: unknown | null;
  generator_version: string | null;
}

export interface ActiveDesignPayload {
  address: AddressData;
  project: ProjectData;
  design: DesignData;
}

// ── localStorage helpers ─────────────────────────────────────────────────────
function readJSON<T = unknown>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  if (value === null || value === undefined) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

interface AddressParts {
  formatted: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Read the working address out of localStorage. `siteContext` is the canonical
 * source (it carries yard_type and is refreshed through the flow); `initialAddress`
 * is the earlier homepage capture and a fallback. Both are `{ address, lat, lng }`.
 */
function readAddressParts(): AddressParts {
  const site = readJSON<Record<string, unknown>>('siteContext');
  const initial = readJSON<Record<string, unknown> | string>('initialAddress');

  const initObj = typeof initial === 'string' ? { address: initial } : (initial ?? {});
  const pick = (k: string): unknown =>
    (site as Record<string, unknown> | null)?.[k] ?? (initObj as Record<string, unknown>)[k];

  const formattedRaw = pick('address') ?? pick('formatted');
  const lat = pick('lat');
  const lng = pick('lng');
  return {
    formatted: typeof formattedRaw === 'string' && formattedRaw.trim() ? formattedRaw : null,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
  };
}

/** The formatted address the current DIY session is working on, or null. */
export function currentAddress(): string | null {
  return readAddressParts().formatted;
}

/**
 * Split the current localStorage state into the three row shapes. Returns null
 * when there isn't enough to persist yet — we need an address plus at least a
 * drawn boundary or a generated plan (otherwise there's no design to save).
 */
export function collectActiveDesign(): ActiveDesignPayload | null {
  const addr = readAddressParts();
  if (!addr.formatted) return null;

  const site = readJSON<Record<string, unknown>>('siteContext') ?? {};
  const prefs = readJSON<Record<string, unknown>>('userPreferences') ?? {};
  const boundaryFinal = readJSON<Record<string, unknown>>('diyBoundaryFinal') ?? {};

  const boundary = boundaryFinal.boundary ?? null;
  let plan = readJSON('diyPlacementPlan');
  // Not enough to persist: no scope drawn and nothing generated.
  if (boundary === null && plan === null) return null;

  // Manual plant edits (drags of trees/large shrubs, keyed by slot id) live in
  // 'diyPlantOverrides'. There's no dedicated designs column for them, so we
  // ferry them THROUGH the existing `plan` jsonb under a namespaced key — the
  // editor re-hydrates them on load so the saved design reproduces the moves,
  // not just the rendered plant_instances. Only bundle when the override sig
  // matches the current plan (stale overrides from a prior plan are dropped).
  const overridesSig = localStorage.getItem('diyPlantOverridesSig') ?? '';
  const planSig = localStorage.getItem('diyPlacementPlanSig') ?? '';
  const overrides =
    overridesSig && overridesSig === planSig ? readJSON('diyPlantOverrides') : null;
  if (
    overrides &&
    typeof overrides === 'object' &&
    Object.keys(overrides as object).length &&
    plan &&
    typeof plan === 'object'
  ) {
    plan = { ...(plan as Record<string, unknown>), __plantOverrides: overrides };
  }

  const existing_features =
    boundaryFinal.confirmedFeatures ?? readJSON('diyConfirmedFeatures') ?? null;
  const door_point = readJSON('diyDoorPoint') ?? boundaryFinal.doorPoint ?? null;
  const sun_map = readJSON('diySunMap');
  const plant_instances = readJSON('diyPlantInstances');

  const yard_type =
    (typeof site.yard_type === 'string' && site.yard_type) ||
    (typeof prefs.yard_type === 'string' && prefs.yard_type) ||
    'front';

  // preferences = userPreferences minus yard_type (yard_type lives on the project).
  const { yard_type: _omit, ...preferences } = prefs as Record<string, unknown>;

  return {
    address: {
      formatted_address: addr.formatted,
      lat: addr.lat,
      lng: addr.lng,
      // No stable localStorage key holds either today (place_id isn't captured;
      // hardiness is fetched on demand in DiyPlantsPage and not cached locally).
      place_id: null,
      hardiness_zone: null,
    },
    project: { yard_type },
    design: {
      name: null,
      boundary,
      existing_features,
      door_point,
      sun_map,
      preferences: Object.keys(preferences).length ? preferences : null,
      plan,
      plant_instances,
      // Stamp the version the plan was GENERATED with (written to
      // 'diyPlanGeneratorVersion' at each generation site), not the current
      // constant at persist time — so a code bump to g21 doesn't retroactively
      // relabel a plan generated under g20. Falls back to the constant when a
      // plan predates the stamp.
      generator_version: localStorage.getItem('diyPlanGeneratorVersion') ?? GENERATOR_VERSION,
    },
  };
}

/**
 * Inverse of collectActiveDesign: write a loaded row set back into the exact
 * localStorage keys the flow reads, so hydrating a saved design makes the
 * editor/review pages work. Callers should clearAllDesignState() first so no
 * stale keys from a previous design leak through.
 */
export function applyDesign(payload: ActiveDesignPayload): void {
  const { address, project, design } = payload;

  const site = {
    address: address.formatted_address,
    lat: address.lat,
    lng: address.lng,
    yard_type: project.yard_type,
  };
  writeJSON('siteContext', site);
  writeJSON('initialAddress', {
    address: address.formatted_address,
    lat: address.lat,
    lng: address.lng,
  });

  // Merge yard_type back into preferences (it was stripped on collect).
  const prefs = { ...(design.preferences ?? {}), yard_type: project.yard_type };
  writeJSON('userPreferences', prefs);

  // diyBoundaryFinal bundles the scope the engines read.
  if (design.boundary !== null || design.existing_features !== null || design.door_point !== null) {
    writeJSON('diyBoundaryFinal', {
      boundary: design.boundary ?? [],
      confirmedFeatures: design.existing_features ?? [],
      doorPoint: design.door_point ?? null,
    });
  } else {
    localStorage.removeItem('diyBoundaryFinal');
  }

  // ALSO rehydrate the boundary page's own working keys. clearAllDesignState() (run before applyDesign)
  // wipes these, and without re-writing them, revisiting the boundary/door/existing-features step after
  // loading a design (e.g. going into the edit flow and back) showed a blank canvas — the drawn boundary,
  // door, and confirmed features had vanished. The boundary page reads `diyBoundary.ring` and
  // `diyConfirmedFeatures` directly.
  writeJSON('diyBoundary', design.boundary ? { ring: design.boundary } : null);
  writeJSON('diyConfirmedFeatures', design.existing_features ?? []);

  writeJSON('diyDoorPoint', design.door_point);
  writeJSON('diySunMap', design.sun_map);

  // Pull the ferried manual plant overrides back out of the plan (see
  // collectActiveDesign) BEFORE persisting the working plan, so the editor's
  // feature layout stays clean of plant data. Restore them to their own key +
  // sig so the editor re-applies the drags on top of the regenerated slots.
  let planToStore = design.plan;
  const bundledOverrides =
    planToStore && typeof planToStore === 'object'
      ? (planToStore as Record<string, unknown>).__plantOverrides
      : null;
  if (planToStore && typeof planToStore === 'object' && '__plantOverrides' in (planToStore as object)) {
    const { __plantOverrides: _drop, ...rest } = planToStore as Record<string, unknown>;
    planToStore = rest;
  }
  writeJSON('diyPlacementPlan', planToStore);
  writeJSON('diyPlantInstances', design.plant_instances);

  if (bundledOverrides && typeof bundledOverrides === 'object') {
    writeJSON('diyPlantOverrides', bundledOverrides);
    // Match the plan sig set below (inputSignature()) so the editor's override
    // gate accepts them. Inputs were already written above.
    try { localStorage.setItem('diyPlantOverridesSig', inputSignature()); } catch { /* ignore */ }
  } else {
    localStorage.removeItem('diyPlantOverrides');
    localStorage.removeItem('diyPlantOverridesSig');
  }

  // Restore the version this design was generated with so a re-save preserves it
  // (collectActiveDesign reads this key). Clear it when the row carries no version.
  if (design.generator_version) {
    localStorage.setItem('diyPlanGeneratorVersion', design.generator_version);
  } else {
    localStorage.removeItem('diyPlanGeneratorVersion');
  }

  // Restore the regeneration gate + per-feature reset baseline so opening a saved
  // design and entering the editor does NOT auto-regenerate over the loaded plan.
  // The inputs were just written above, so recomputing inputSignature() yields the
  // signature that matches this plan → the studio keeps it. (Phase 2 retires this
  // gate; until then loading must leave a matching sig.)
  if (design.plan) {
    writeJSON('diyPlacementPlanOriginal', design.plan);   // reset-to-original baseline
    try { localStorage.setItem('diyPlacementPlanSig', inputSignature()); } catch { /* ignore */ }
    snapshotPlanInputs(); // baseline for "return to my previous draft" (RegenPrompt discard)
  } else {
    localStorage.removeItem('diyPlacementPlanOriginal');
    localStorage.removeItem('diyPlacementPlanSig');
  }
}

// Non-diy keys the flow uses that must also be cleared between designs/users.
const EXPLICIT_STATE_KEYS = [
  'userPreferences',
  'siteContext',
  'initialAddress',
  'generatedConcept',
  'conceptFeatures',
  'paymentRecord',
  'draftDetections',
  'draftDetectionBox',
];

/**
 * Wildcard clear: remove EVERY localStorage key beginning with 'diy' or 'draft',
 * plus the explicit non-diy flow keys. Replaces the old enumerated clearLocalState
 * so no state can leak between designs or users. Does NOT touch the Supabase auth
 * session (sb-* keys) or the active-design pointers (callers manage those).
 */
export function clearAllDesignState(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) keys.push(k);
  }
  for (const k of keys) {
    if (k.startsWith('diy') || k.startsWith('draft')) localStorage.removeItem(k);
  }
  for (const k of EXPLICIT_STATE_KEYS) localStorage.removeItem(k);
}
