/**
 * projectsService — thin compatibility facade over the relational data layer.
 *
 * The old localStorage-blob `projects` table is gone (see docs/data-model.md).
 * The real implementations now live in:
 *   - designPayload.ts  — localStorage ⇄ row-shape mapping, clearAllDesignState, currentAddress
 *   - db.ts             — typed Supabase CRUD + addressExists RPC
 *   - activeDesign.ts   — save/load the active design, active-id cache
 *
 * This module re-exports the handful of names the flow pages still import so their
 * import paths keep working. Prefer importing from the modules above in new code.
 */
export { currentAddress, clearAllDesignState } from './designPayload';
export { addressExists } from './db';
export { saveActiveDesign, loadDesign, getActiveDesignId, getActiveProjectId } from './activeDesign';
