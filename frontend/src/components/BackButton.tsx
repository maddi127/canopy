import type { CSSProperties } from 'react';
import { IT } from '../lib/theme';

/**
 * The app-wide Back control: a subtle gray text link with a left chevron (the flow's long-standing back
 * style). Pass `onClick`, and — where the button is positioned (fixed corners, flex rows) — a
 * `className` / `style` for placement only.
 */
export default function BackButton({
  onClick, label = 'back', className = '', style, disabled = false,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`transition-all hover:opacity-70 disabled:opacity-40 ${className}`.trim()}
      style={{
        fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500,
        background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', ...style,
      }}
    >
      ← {label}
    </button>
  );
}
