// RegenPrompt — the "You have a draft design" modal.
//
// The app never silently regenerates a plan. When a design's INPUTS change after a plan was generated
// (inputSignature() !== stored diyPlacementPlanSig), the page overlays this prompt instead of quietly
// rebuilding. The user chooses:
//   • Edit my active draft          → onRegenerate: rebuild this draft's plan to match the changes.
//   • Save as a new design          → onNewDesign (signed-in only): fork a sibling design, keep this one.
//   • Discard my edits (text link)  → onKeep: leave the previous draft's plan untouched.
//
// Presentational only — the page owns the decision and the actions (see the wiring in DiyAutoLayoutPage
// / DiyPlanReadyPage). Styling copies the flow's idiom: cream card, Instrument Serif title, Inter Tight.
import type { CSSProperties } from 'react';
import { IS, IT } from '../lib/theme';

const DARK = '#2A2A26';

interface Props {
  onRegenerate: () => void;
  onKeep: () => void;
  // Phase 4a — optional third action. When provided (signed-in user with a saved current design),
  // the modal offers "Start a new design": preserve the current design row (old inputs + plan) and
  // branch a fresh sibling design with the changed inputs. Omitted → the classic two-button modal.
  onNewDesign?: () => void;
}

// Full-width pills — primary (regenerate this draft), secondary (fork a new design).
const primaryBtn: CSSProperties = {
  width: '100%', background: DARK, color: '#efe9db', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500,
  border: 'none', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer', textAlign: 'center',
};
const secondaryBtn: CSSProperties = {
  width: '100%', background: 'white', color: DARK, fontFamily: IT, fontSize: '0.9rem', fontWeight: 500,
  border: '1.5px solid rgba(42,42,38,0.16)', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer', textAlign: 'center',
};
// Discard: a quiet text link (not a pill) — reverts to the previous draft, dropping the recent changes.
const discardLink: CSSProperties = {
  display: 'block', margin: '1rem auto 0', background: 'none', border: 'none', cursor: 'pointer',
  color: '#8A8A80', fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, padding: 4,
};

export default function RegenPrompt({ onRegenerate, onKeep, onNewDesign }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      // Blocking scrim: fixed full-screen backdrop captures clicks so no editing happens underneath
      // while the user decides. (No onClick handler — clicking the scrim is a no-op, not a dismiss.)
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(42,42,38,0.45)', padding: '1.5rem',
      }}
    >
      <div
        style={{
          background: '#efe9db', borderRadius: 20, maxWidth: 440, width: '100%',
          padding: '2.2rem 2.2rem 1.8rem', boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
          border: '1px solid rgba(42,42,38,0.08)',
        }}
      >
        <h2 style={{ fontFamily: IS, fontSize: '2rem', color: DARK, fontWeight: 400, lineHeight: 1.1, margin: 0 }}>
          You have a draft design
        </h2>
        <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#5A5A50', lineHeight: 1.5, margin: '0.9rem 0 1.6rem' }}>
          You've made changes since this draft was generated.
        </p>
        <div className="flex flex-col" style={{ gap: '0.7rem' }}>
          <button onClick={onRegenerate} className="transition-all hover:opacity-90" style={primaryBtn}>
            Edit my active draft
          </button>
          {onNewDesign && (
            <button onClick={onNewDesign} className="transition-all hover:opacity-85" style={secondaryBtn}>
              Save as a new design
            </button>
          )}
        </div>
        <button onClick={onKeep} className="transition-all hover:opacity-80 hover:underline" style={discardLink}>
          Discard my edits — return to my previous draft
        </button>
      </div>
    </div>
  );
}
