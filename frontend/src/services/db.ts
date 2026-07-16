/**
 * db — typed Supabase CRUD for the relational schema (addresses → projects → designs).
 *
 * Ownership is enforced two ways and this module respects both:
 *  - addresses.user_id MUST be set by the client on insert (addresses is the root).
 *  - projects.user_id / designs.user_id are DERIVED by BEFORE triggers from the
 *    parent — never send them from the client.
 * RLS scopes every table to the owner; we still pass defensive `.eq('id', id)` so
 * a mistargeted id fails cleanly rather than silently touching nothing.
 *
 * All functions surface Supabase errors by throwing.
 */
import { supabase } from '../lib/supabase';
import type { AddressData, DesignData, ProjectData } from './designPayload';

// ── Row types (full DB columns) ──────────────────────────────────────────────
export interface AddressRow {
  id: string;
  user_id: string;
  formatted_address: string;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  hardiness_zone: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  address_id: string;
  yard_type: string;
  status: string;
  selected_design_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignRow {
  id: string;
  user_id: string;
  project_id: string;
  name: string | null;
  boundary: unknown | null;
  existing_features: unknown | null;
  door_point: unknown | null;
  sun_map: unknown | null;
  preferences: Record<string, unknown> | null;
  plan: unknown | null;
  plant_instances: unknown | null;
  generator_version: string | null;
  edited_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('You must be signed in to do that.');
  return data.user.id;
}

// ── addresses ────────────────────────────────────────────────────────────────

/**
 * Find-or-create the current user's address. MUST set user_id (addresses is the
 * root — no trigger derives it). One row per (user, formatted_address).
 */
export async function upsertAddress(data: AddressData): Promise<AddressRow> {
  const user_id = await requireUserId();
  const { data: row, error } = await supabase
    .from('addresses')
    .upsert({ user_id, ...data }, { onConflict: 'user_id,formatted_address' })
    .select()
    .single();
  if (error) throw error;
  return row as AddressRow;
}

export async function getAddress(id: string): Promise<AddressRow> {
  const { data, error } = await supabase.from('addresses').select('*').eq('id', id).single();
  if (error) throw error;
  return data as AddressRow;
}

export async function listAddresses(): Promise<AddressRow[]> {
  const { data, error } = await supabase
    .from('addresses')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AddressRow[];
}

// ── projects ─────────────────────────────────────────────────────────────────

/**
 * Find-or-create the project (yard) for an address. Do NOT send user_id — the
 * projects_derive_user_id trigger sets it from the address. One row per
 * (address_id, yard_type).
 */
export async function upsertProject(
  input: ProjectData & { address_id: string; status?: string },
): Promise<ProjectRow> {
  const { data, error } = await supabase
    .from('projects')
    .upsert(
      { address_id: input.address_id, yard_type: input.yard_type, ...(input.status ? { status: input.status } : {}) },
      { onConflict: 'address_id,yard_type' },
    )
    .select()
    .single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function getProject(id: string): Promise<ProjectRow> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function setSelectedDesign(projectId: string, designId: string | null): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ selected_design_id: designId })
    .eq('id', projectId);
  if (error) throw error;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectRow[];
}

export async function listProjectsForAddress(addressId: string): Promise<ProjectRow[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('address_id', addressId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectRow[];
}

/** Projects with their designs nested — used by MyProjects to list address → designs. */
export async function listProjectsWithDesigns(): Promise<(ProjectRow & { designs: DesignRow[] })[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*, designs(*)')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...(row as ProjectRow),
    designs: ((row as { designs?: DesignRow[] }).designs ?? []) as DesignRow[],
  }));
}

// ── designs ──────────────────────────────────────────────────────────────────

/** Insert a new design under a project. Do NOT send user_id (trigger derives it). */
export async function createDesign(projectId: string, data: DesignData): Promise<DesignRow> {
  const { data: row, error } = await supabase
    .from('designs')
    .insert({ project_id: projectId, ...data })
    .select()
    .single();
  if (error) throw error;
  return row as DesignRow;
}

export async function updateDesign(
  id: string,
  patch: Partial<DesignData> & { status?: string; edited_at?: string | null },
): Promise<DesignRow> {
  const { data, error } = await supabase
    .from('designs')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as DesignRow;
}

export async function getDesign(id: string): Promise<DesignRow> {
  const { data, error } = await supabase.from('designs').select('*').eq('id', id).single();
  if (error) throw error;
  return data as DesignRow;
}

export async function listDesignsForProject(projectId: string): Promise<DesignRow[]> {
  const { data, error } = await supabase
    .from('designs')
    .select('*')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DesignRow[];
}

export async function deleteDesign(id: string): Promise<void> {
  const { error } = await supabase.from('designs').delete().eq('id', id);
  if (error) throw error;
}

// ── pre-auth address existence hint (SECURITY DEFINER RPC; RLS-independent) ────

/**
 * Whether this address already exists for ANY user (via the address_exists RPC).
 * Used to default the auth page to sign-in for returning addresses. Fails closed.
 */
export async function addressExists(formattedAddress: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('address_exists', { p_address: formattedAddress });
  if (error) return false;
  return Boolean(data);
}
