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
  /** Derived from the linked address (addresses.formatted_address). */
  address: string | null;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  address_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Address {
  id: string;
  formatted_address: string;
  lat: number | null;
  lng: number | null;
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

interface AddressParts {
  formatted: string;
  lat: number | null;
  lng: number | null;
}

/** Parse the `initialAddress` localStorage value: `{ address, lat, lng }`. */
function readAddressParts(bundle: Record<string, string>): AddressParts | null {
  const raw = bundle.initialAddress;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return { formatted: parsed, lat: null, lng: null };
    const formatted: string | undefined = parsed?.address ?? parsed?.formatted;
    if (!formatted) return null;
    return {
      formatted,
      lat: typeof parsed?.lat === 'number' ? parsed.lat : null,
      lng: typeof parsed?.lng === 'number' ? parsed.lng : null,
    };
  } catch {
    return { formatted: raw, lat: null, lng: null };
  }
}

async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('You must be signed in to do that.');
  return data.user.id;
}

/**
 * Find-or-create the address ("home") for the current project state and return
 * its id. One row per (user, formatted_address); coordinates are refreshed.
 */
async function resolveAddressId(userId: string, bundle: Record<string, string>): Promise<string | null> {
  const parts = readAddressParts(bundle);
  if (!parts) return null;

  const { data, error } = await supabase
    .from('addresses')
    .upsert(
      { user_id: userId, formatted_address: parts.formatted, lat: parts.lat, lng: parts.lng },
      { onConflict: 'user_id,formatted_address' },
    )
    .select('id')
    .single();

  if (error) throw error;
  return (data as { id: string }).id;
}

/** Insert a new project from the current localStorage state. */
export async function saveCurrentProject(name: string): Promise<ProjectRow> {
  const userId = await requireUserId();
  const bundle = collectLocalState();
  const address_id = await resolveAddressId(userId, bundle);

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: userId,
      name: name.trim() || 'Untitled project',
      address_id,
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
  const userId = await requireUserId();
  const bundle = collectLocalState();
  const address_id = await resolveAddressId(userId, bundle);

  const patch: Record<string, unknown> = { data: bundle, address_id };
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
    .select('id, name, updated_at, addresses ( formatted_address )')
    .order('updated_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const rel = row.addresses as { formatted_address?: string } | { formatted_address?: string }[] | null;
    const addr = Array.isArray(rel) ? rel[0] : rel;
    return {
      id: row.id as string,
      name: row.name as string,
      updated_at: row.updated_at as string,
      address: addr?.formatted_address ?? null,
    };
  });
}

export interface ProjectWithAddress {
  id: string;
  name: string;
  updated_at: string;
  address_id: string | null;
  address: string | null;
}

/**
 * All of the user's projects with their linked address, newest first — used by
 * the homes → projects view to group projects under each home client-side.
 */
export async function listProjectsWithAddress(): Promise<ProjectWithAddress[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, updated_at, address_id, addresses ( formatted_address )')
    .order('updated_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const rel = row.addresses as { formatted_address?: string } | { formatted_address?: string }[] | null;
    const addr = Array.isArray(rel) ? rel[0] : rel;
    return {
      id: row.id as string,
      name: row.name as string,
      updated_at: row.updated_at as string,
      address_id: (row.address_id as string) ?? null,
      address: addr?.formatted_address ?? null,
    };
  });
}

/** List the current user's addresses ("homes"), each with its project count. */
export async function listAddresses(): Promise<(Address & { project_count: number })[]> {
  const { data, error } = await supabase
    .from('addresses')
    .select('id, formatted_address, lat, lng, projects ( count )')
    .order('updated_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const rel = row.projects as { count: number }[] | null;
    return {
      id: row.id as string,
      formatted_address: row.formatted_address as string,
      lat: (row.lat as number) ?? null,
      lng: (row.lng as number) ?? null,
      project_count: rel?.[0]?.count ?? 0,
    };
  });
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
