import { supabase } from '../lib/supabase';

/**
 * The DIY flow stores all of its state across these localStorage keys.
 * A "project" is a snapshot of these keys; saving collects them into a JSON
 * bundle, loading writes them back. Centralizing the list here means save/load
 * works without touching the individual flow pages.
 */
export const DIY_STATE_KEYS = [
  'initialAddress',
  'userPreferences',
  'siteContext',
  'diyBoundary',
  'diyBoundaryFinal',
  'diyDoorPoint',
  'diyDetectedFeatures',
  'diyConfirmedFeatures',
  'conceptFeatures',
  'diySelectedConcepts',
  'generatedConcept',
  'diyFinalConcept',
  'diyFinalRender',
  'diyPalettes',
  'diySystemFills',
  'diyPlantIncludes',
  'diyPlantExcludes',
  'diyLayout',
  'diyDensity',
  'diySunModel',
  'diyQueueIdx',
  'diyRoundCount',
  'diyIdentifyDone',
  'diyPlanRevealSeen',
  'paymentRecord',
] as const;

export interface ProjectSummary {
  id: string;
  name: string;
  address: string | null;
  updated_at: string;
}

export interface ProjectRow extends ProjectSummary {
  user_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** Read the current DIY flow state out of localStorage into a plain object. */
export function collectLocalState(): Record<string, string> {
  const bundle: Record<string, string> = {};
  for (const key of DIY_STATE_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) bundle[key] = value;
  }
  return bundle;
}

/** Write a saved bundle back into localStorage, clearing any stale keys first. */
export function applyLocalState(bundle: Record<string, unknown>): void {
  for (const key of DIY_STATE_KEYS) {
    const value = bundle[key];
    if (typeof value === 'string') localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }
}

/** Clear all DIY state — used when starting a fresh project. */
export function clearLocalState(): void {
  for (const key of DIY_STATE_KEYS) localStorage.removeItem(key);
  localStorage.removeItem(ACTIVE_KEY);
}

// Tracks which saved project the current localStorage state belongs to, so the
// in-flow Save button updates an existing row instead of creating duplicates.
const ACTIVE_KEY = 'activeProjectId';
export function getActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}
function setActiveProjectId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

function readAddress(bundle: Record<string, string>): string | null {
  const raw = bundle.initialAddress;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.address === 'string') return parsed.address;
    if (parsed && typeof parsed.formatted === 'string') return parsed.formatted;
  } catch {
    return raw;
  }
  return raw;
}

/** Insert a new project from the current localStorage state. */
export async function saveCurrentProject(name: string): Promise<ProjectRow> {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) throw new Error('You must be signed in to save a project.');

  const bundle = collectLocalState();
  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: userData.user.id,
      name: name.trim() || 'Untitled project',
      address: readAddress(bundle),
      data: bundle,
    })
    .select()
    .single();

  if (error) throw error;
  setActiveProjectId((data as ProjectRow).id);
  return data as ProjectRow;
}

/** Overwrite an existing project with the current localStorage state. */
export async function updateProject(id: string, name?: string): Promise<ProjectRow> {
  const bundle = collectLocalState();
  const patch: Record<string, unknown> = { data: bundle, address: readAddress(bundle) };
  if (name !== undefined) patch.name = name.trim() || 'Untitled project';

  const { data, error } = await supabase
    .from('projects')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as ProjectRow;
}

/** List the current user's projects, most recently updated first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, address, updated_at')
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as ProjectSummary[];
}

/** Fetch a project and hydrate localStorage with its saved state. */
export async function loadProject(id: string): Promise<ProjectRow> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
  if (error) throw error;
  const row = data as ProjectRow;
  applyLocalState(row.data ?? {});
  setActiveProjectId(row.id);
  return row;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}
