/**
 * theme — the single source of truth for the DIY flow's visual language.
 *
 * The flow's pages are inline-styled (not Tailwind), so these JS constants are the counterpart to the
 * Tailwind tokens in tailwind.config.js (canopy/soil/rounded-canopy/shadow-canopy). Import from here
 * instead of re-declaring fonts or hardcoding near-duplicate creams/inks/greens per file.
 */
import type { CSSProperties } from 'react';

// ── Fonts ────────────────────────────────────────────────────────────────────
export const IS = "'Instrument Serif', serif";   // serif — page & section titles
export const IT = "'Inter Tight', sans-serif";    // UI sans — everything else
export const HAND = "'Caveat', cursive";          // hand-lettered labels on the illustrated plan

// ── Backgrounds ───────────────────────────────────────────────────────────────
// ONE canonical page background for full-page surfaces (kills the four-cream flicker across the flow).
// The other warm creams are reserved for cards/panels.
export const PAGE_BG = '#F4F0E6';
export const CARD_BG = '#FFFFFF';       // primary card surface
export const CARD_BG_WARM = '#EFE9DB';  // warm inset panels
export const CARD_BG_SOFT = '#F6F2E8';  // soft raised panels / modals

// ── Ink (text) ────────────────────────────────────────────────────────────────
// Collapses the near-duplicate inks (#1a1a16, #40392e, …) onto the majority value (Tailwind soil.900).
export const INK = '#2A2A26';
export const INK_SOFT = '#6A6A60';
export const INK_FAINT = '#9A9A92';
export const CREAM = '#EFE9DB';         // light text on dark pills

// ── Greens ────────────────────────────────────────────────────────────────────
// Collapses the five near-duplicate greens (#2F5D3A, #4c6440, #3d5c3a, …) onto the brand token
// (Tailwind canopy.600). GREEN_DEEP is the one deliberate deep-serif accent (the editor title).
export const GREEN = '#2F6B4F';
export const GREEN_DEEP = '#274435';

// ── Radius & shadow (mirror Tailwind rounded-canopy / shadow-canopy) ────────────
export const RADIUS = 16;
export const RADIUS_SM = 12;
export const RADIUS_LG = 20;
export const SHADOW = '0 4px 16px rgba(0,0,0,0.05)';
export const SHADOW_LG = '0 8px 24px rgba(0,0,0,0.08)';

// ── Titles (item 8) ─────────────────────────────────────────────────────────────
// Canonical page title: 4rem serif, ink, generous lead. Use `titleStyle()` for size overrides.
export const PAGE_TITLE: CSSProperties = {
  fontFamily: IS, fontSize: '4rem', fontWeight: 400, color: INK, lineHeight: 1.05, margin: 0,
};
export const titleStyle = (fontSize = '4rem', color: string = INK): CSSProperties => ({
  fontFamily: IS, fontSize, fontWeight: 400, color, lineHeight: 1.05, margin: 0,
});
// The one deliberate "editor" title variant (in-app section header): italic deep green, smaller.
export const EDITOR_TITLE: CSSProperties = {
  fontFamily: IS, fontSize: '1.9rem', fontWeight: 400, fontStyle: 'italic', color: GREEN_DEEP, lineHeight: 1.05, margin: 0,
};

// ── Primary CTA (item 9) ─────────────────────────────────────────────────────────
// ONE primary action (dark ink pill) + ONE accent variant (brand green). Spread and add width/margin.
export const ctaPrimary: CSSProperties = {
  background: INK, color: CREAM, fontFamily: IT, fontSize: '0.95rem', fontWeight: 600,
  border: 'none', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer',
};
export const ctaAccent: CSSProperties = {
  background: GREEN, color: '#FFFFFF', fontFamily: IT, fontSize: '0.95rem', fontWeight: 600,
  border: 'none', borderRadius: 999, padding: '0.85rem 1.6rem', cursor: 'pointer',
};
