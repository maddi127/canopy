/**
 * useAutosave — debounced, best-effort autosave of the active design row.
 *
 * Active ONLY when the user is signed in AND an active design id exists. For
 * anonymous users (or before a draft is adopted) it is fully idle and triggers
 * ZERO database writes — anonymous work persists nothing until signup adoption.
 *
 * How it detects change: it polls a cheap hash of the design payload
 * (JSON.stringify(collectActiveDesign())) every POLL_MS. When the hash differs
 * from the last-saved one, it debounces DEBOUNCE_MS and then calls
 * flushActiveDesign() (a design-row-only PATCH). It also flushes on component
 * unmount and on `document visibilitychange → hidden`, so leaving the tab or the
 * editor route persists the latest edit even if the debounce hasn't fired.
 *
 * Returns a UI status ('idle' | 'saving' | 'saved' | 'error'); 'saved' reverts
 * to 'idle' after a short linger. Overlapping saves are guarded by an in-flight
 * ref; errors are swallowed (logged) and surfaced as 'error' — never crash the
 * editor. Timers are for UI only; nothing here feeds the deterministic plan.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { collectActiveDesign } from '../services/designPayload';
import { flushActiveDesign, getActiveDesignId } from '../services/activeDesign';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const POLL_MS = 3000;        // how often we re-hash the payload to notice edits
const DEBOUNCE_MS = 2500;    // quiet period after a change before we save
const SAVED_LINGER_MS = 3000; // how long "Saved" shows before reverting to idle

/** Cheap change signature of the current design payload, or null when nothing to save. */
function payloadHash(): string | null {
  const payload = collectActiveDesign();
  return payload ? JSON.stringify(payload) : null;
}

export function useAutosave(): SaveStatus {
  const { user } = useAuth();
  const [status, setStatus] = useState<SaveStatus>('idle');

  const lastSavedHashRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const statusRef = useRef<SaveStatus>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setStatusSafe = useCallback((s: SaveStatus) => {
    statusRef.current = s;
    if (mountedRef.current) setStatus(s);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // The actual save. Guarded against overlap; no-ops when nothing changed or
  // there's no active design. Never throws — errors become 'error' status.
  const doSave = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!getActiveDesignId()) return;
    const hash = payloadHash();
    if (hash === null) return;
    if (hash === lastSavedHashRef.current) return;

    inFlightRef.current = true;
    setStatusSafe('saving');
    try {
      const result = await flushActiveDesign();
      if (result === 'saved') {
        lastSavedHashRef.current = hash;
        setStatusSafe('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => {
          if (statusRef.current === 'saved') setStatusSafe('idle');
        }, SAVED_LINGER_MS);
      } else {
        // 'noop' — not signed in / no active design; stay quiet.
        setStatusSafe('idle');
      }
    } catch (err) {
      console.error('Autosave failed:', err);
      setStatusSafe('error');
    } finally {
      inFlightRef.current = false;
    }
  }, [setStatusSafe]);

  useEffect(() => {
    // Fully idle for anonymous users — no polling, no listeners, no writes.
    if (!user) {
      setStatusSafe('idle');
      return;
    }

    // Baseline the last-saved hash to the current state so an unchanged design
    // doesn't trigger a save on the first poll; only later edits do.
    if (lastSavedHashRef.current === null) lastSavedHashRef.current = payloadHash();

    const interval = setInterval(() => {
      if (!getActiveDesignId()) return;
      const hash = payloadHash();
      if (hash === null || hash === lastSavedHashRef.current) return;
      // Change noticed → (re)arm the debounce.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void doSave(); }, DEBOUNCE_MS);
    }, POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        void doSave();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Flush the latest on unmount (leaving the editor/route).
      void doSave();
    };
  }, [user, doSave, setStatusSafe]);

  return status;
}
