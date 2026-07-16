/**
 * SaveStatusChip — the unobtrusive autosave indicator for the editor.
 *
 * Renders nothing when idle (so it stays silent for anonymous users and for a
 * signed-in user who hasn't edited), a subtle pulsing dot + "Saving…" while a
 * save is in flight, a brief green "Saved ✓", and a muted "Couldn't save" on
 * error. Styled to the app idiom: Inter Tight, muted greys/greens, ~0.75rem.
 */
import type { SaveStatus } from '../hooks/useAutosave';
import { IT } from '../lib/theme';

export default function SaveStatusChip({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null;

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: IT,
    fontSize: '0.75rem',
    fontWeight: 600,
    borderRadius: 999,
    padding: '6px 12px',
    background: 'rgba(247,244,236,0.92)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
    backdropFilter: 'blur(4px)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  if (status === 'saving') {
    return (
      <div style={{ ...base, color: '#6A6A60' }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: '#9A9A92', animation: 'canopySavePulse 1s ease-in-out infinite' }} />
        Saving…
        <style>{'@keyframes canopySavePulse{0%,100%{opacity:0.35}50%{opacity:1}}'}</style>
      </div>
    );
  }

  if (status === 'saved') {
    return (
      <div style={{ ...base, color: '#2F6B4F' }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: '#2F6B4F' }} />
        Saved ✓
      </div>
    );
  }

  // status === 'error'
  return (
    <div style={{ ...base, color: '#9A9A92' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: '#B98A3E' }} />
      Couldn't save
    </div>
  );
}
