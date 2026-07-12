// Species → bloom colour for the plan view. Colours come from the plant database's `color` column
// (its raw values: green / red / purple / pink / white / yellow), translated into our earthy
// watercolor palette. Each colour family holds several shades and every species hashes to its own
// variant + a subtle lightness jitter — so two "pink" bloomers still read as different plants.

const FAMILIES: Record<string, string[]> = {
  green:  ['#5F7F4A', '#6E8F55', '#4E7A50', '#7F9A5E', '#54714D', '#8AA662'],
  red:    ['#B85C4A', '#A54B3F', '#C4705C', '#B06451'],
  purple: ['#8E6FA8', '#7C5E96', '#A186BB', '#96789F'],
  pink:   ['#D08CA0', '#C77E92', '#DA9FB0', '#C98F9B'],
  white:  ['#F2ECDC', '#EAE2CE', '#F6F0E2'],
  yellow: ['#DFAF4E', '#D5A23F', '#E5BC66'],
  orange: ['#D98548', '#CB763B'],
  blue:   ['#7B93C0', '#6A82AE'],
};
// Species without a usable colour rotate through this muted mixed set.
const FALLBACK = ['#8AA662', '#C4705C', '#A186BB', '#DA9FB0', '#DFAF4E', '#6E8F55', '#B06451', '#96789F'];

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Bloom colour for a species — `raw` is the DB `color` value; `speciesName` seeds the variant. */
export function bloomColorFor(raw: string | null | undefined, speciesName: string): string {
  const key = (raw || '').trim().toLowerCase().split(/[,/]/)[0].trim(); // first colour when multi-valued
  const family = FAMILIES[key] ?? FALLBACK;
  const h = hash(speciesName || 'plant');
  const base = family[h % family.length];
  // Subtle per-species lightness jitter (±8%); whites stay near-white so they keep reading as white.
  const jitter = key === 'white' ? 1 - ((h >> 8) % 5) / 100 : 0.92 + ((h >> 8) % 17) / 100;
  return shade(base, jitter);
}
