/**
 * planInputs — a snapshot of the design INPUTS a plan was generated with.
 *
 * The RegenPrompt's "Discard my edits — return to my previous draft" must truly revert the inputs
 * (not just silence the drift), so the Preferences step shows what it did when the current plan was
 * made. We snapshot the input localStorage keys at every generation/load and restore them on discard.
 *
 * INPUT_KEYS mirrors exactly what inputSignature() reads (see lib/planSignature.ts) — keep in sync so
 * that after a restore, inputSignature() matches the plan's stored signature (no residual drift).
 */
const INPUT_KEYS = ['userPreferences', 'diyBoundaryFinal', 'siteContext', 'diyDoorPoint'] as const;
const SNAP_KEY = 'diyPlanInputsSnapshot';

/** Capture the current inputs as the baseline the freshly generated/loaded plan matches. */
export function snapshotPlanInputs(): void {
  try {
    const snap: Record<string, string | null> = {};
    for (const k of INPUT_KEYS) snap[k] = localStorage.getItem(k);
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch { /* ignore — worst case, discard falls back to silencing the drift */ }
}

/** Restore the snapshotted inputs (the previous draft's inputs). Returns false if none was taken. */
export function restorePlanInputs(): boolean {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw) as Record<string, string | null>;
    for (const k of INPUT_KEYS) {
      const v = snap[k];
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
    return true;
  } catch { return false; }
}
