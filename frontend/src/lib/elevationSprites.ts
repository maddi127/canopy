// Per-species IMAGE sprites for the elevation illustration — an experiment: for a handful of
// species we have a real hand-drawn botanical illustration (background knocked out to transparent),
// and the elevation painter draws that image in place of the procedural standing symbol. Everything
// else still uses the sketch-kit glyphs (elevationSymbols).
//
// Sprites are decoded ONCE (module-level cache). Because paintElevation() draws synchronously,
// callers must `await preloadSpeciesSprites()` before painting a cache-miss frame — after that,
// spriteFor() returns the ready <img> instantly.
import fernbushUrl from '../assets/plants/fernbush.png';

interface SpriteDef { re: RegExp; url: string }
// Match on the plant's stored `name` (common or botanical). Add more entries to grow the set.
const SPRITES: SpriteDef[] = [
  { re: /fernbush|fern\s*bush|chamaebatiaria/i, url: fernbushUrl },
];

const _cache = new Map<string, HTMLImageElement>();
let _preload: Promise<void> | null = null;

function load(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => { _cache.set(url, img); resolve(); };
    img.onerror = () => resolve(); // a missing sprite just falls back to the procedural glyph
    img.src = url;
  });
}

/** Decode every registered sprite once. Idempotent — safe to await repeatedly. */
export function preloadSpeciesSprites(): Promise<void> {
  if (!_preload) _preload = Promise.all(SPRITES.map(s => load(s.url))).then(() => undefined);
  return _preload;
}

/** The decoded sprite for a plant name, or null if none matches / not yet loaded. */
export function spriteFor(name: string | undefined): HTMLImageElement | null {
  if (!name) return null;
  for (const s of SPRITES) {
    if (s.re.test(name)) {
      const img = _cache.get(s.url);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    }
  }
  return null;
}

/** Draw a sprite standing on (x, baseY), sized to the plant's projected box (bottom-centre anchor,
 *  preserving the image's aspect; a touch lush, capped so it never dwarfs its box). */
export function drawSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, baseY: number, wPx: number, hPx: number): void {
  const aspect = img.naturalWidth / img.naturalHeight;
  let drawW = wPx * 1.15;
  let drawH = drawW / aspect;
  if (drawH > hPx * 1.5) { drawH = hPx * 1.5; drawW = drawH * aspect; }
  ctx.drawImage(img, x - drawW / 2, baseY - drawH, drawW, drawH);
}
