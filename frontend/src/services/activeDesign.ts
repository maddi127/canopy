/**
 * activeDesign — the active-design cache and the save/load operations that bridge
 * localStorage (the working copy) and the Supabase rows (source of truth).
 *
 * Only one design is "active" in localStorage at a time. `saveActiveDesign`
 * persists the current work as address → project → design rows; `loadDesign`
 * hydrates localStorage from a stored design. This is the data-layer plumbing
 * only — Phase 2/3 wire it into the flow (autosave, edit-vs-new, draft adoption).
 */
import { supabase } from '../lib/supabase';
import {
  collectActiveDesign,
  applyDesign,
  clearAllDesignState,
  type ActiveDesignPayload,
} from './designPayload';
import {
  upsertAddress,
  upsertProject,
  createDesign,
  updateDesign,
  getDesign,
  getProject,
  getAddress,
} from './db';

export const ACTIVE_DESIGN_KEY = 'activeDesignId';
export const ACTIVE_PROJECT_KEY = 'activeProjectId';

export function getActiveDesignId(): string | null {
  return localStorage.getItem(ACTIVE_DESIGN_KEY);
}
export function setActiveDesignId(id: string | null): void {
  // Passing null detaches the active design (e.g. "Start a new design" — Phase 4a) so the next
  // saveActiveDesign CREATES a fresh design row instead of updating the current one.
  if (id === null) localStorage.removeItem(ACTIVE_DESIGN_KEY);
  else localStorage.setItem(ACTIVE_DESIGN_KEY, id);
}
export function getActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_PROJECT_KEY);
}
export function setActiveProjectId(id: string): void {
  localStorage.setItem(ACTIVE_PROJECT_KEY, id);
}
export function clearActiveIds(): void {
  localStorage.removeItem(ACTIVE_DESIGN_KEY);
  localStorage.removeItem(ACTIVE_PROJECT_KEY);
}

async function isSignedIn(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  return Boolean(data.user);
}

/**
 * Persist the current localStorage work as rows: upsert the address, upsert the
 * project (yard), then update the active design in place or insert a new one.
 * Stores the active project/design ids. Throws if there's nothing to save yet.
 */
export async function saveActiveDesign(name?: string): Promise<{ projectId: string; designId: string }> {
  const payload = collectActiveDesign();
  if (!payload) throw new Error('There is nothing to save yet.');

  const address = await upsertAddress(payload.address);
  const project = await upsertProject({ address_id: address.id, yard_type: payload.project.yard_type });

  const design = { ...payload.design, ...(name !== undefined ? { name } : {}) };

  const activeId = getActiveDesignId();
  let designId: string;
  if (activeId) {
    const row = await updateDesign(activeId, design);
    designId = row.id;
  } else {
    const row = await createDesign(project.id, design);
    designId = row.id;
  }

  setActiveProjectId(project.id);
  setActiveDesignId(designId);
  return { projectId: project.id, designId };
}

/**
 * Load a stored design into localStorage: fetch the design + its project + address,
 * clear all local design state, hydrate the flow keys, and mark it active.
 */
export async function loadDesign(designId: string): Promise<void> {
  const design = await getDesign(designId);
  const project = await getProject(design.project_id);
  const address = await getAddress(project.address_id);

  const payload: ActiveDesignPayload = {
    address: {
      formatted_address: address.formatted_address,
      lat: address.lat,
      lng: address.lng,
      place_id: address.place_id,
      hardiness_zone: address.hardiness_zone,
    },
    project: { yard_type: project.yard_type },
    design: {
      name: design.name,
      boundary: design.boundary,
      existing_features: design.existing_features,
      door_point: design.door_point,
      sun_map: design.sun_map,
      preferences: design.preferences,
      plan: design.plan,
      plant_instances: design.plant_instances,
      generator_version: design.generator_version,
    },
  };

  clearAllDesignState();
  applyDesign(payload);
  setActiveProjectId(project.id);
  setActiveDesignId(design.id);
}

export type FlushResult = 'saved' | 'noop';

/**
 * Cheap autosave flush: DESIGN-ROW-ONLY update. Editing changes the design's
 * plan/plants/preferences — never the address or project — so unlike
 * saveActiveDesign (which re-upserts address + project on every call, for
 * adoption/first-save), this only PATCHes the active design row.
 *
 * No-ops (returns 'noop', zero DB writes) when there is no active design id
 * (never adopted/saved — first persistence must go through adoption or
 * saveActiveDesign), when not signed in, or when there's nothing to collect yet.
 */
export async function flushActiveDesign(): Promise<FlushResult> {
  const activeId = getActiveDesignId();
  if (!activeId) return 'noop';
  if (!(await isSignedIn())) return 'noop';

  const payload = collectActiveDesign();
  if (!payload) return 'noop';

  const { design } = payload;
  await updateDesign(activeId, {
    boundary: design.boundary,
    existing_features: design.existing_features,
    door_point: design.door_point,
    sun_map: design.sun_map,
    preferences: design.preferences,
    plan: design.plan,
    plant_instances: design.plant_instances,
    generator_version: design.generator_version,
  });
  return 'saved';
}
