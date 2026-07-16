// Street View extraction service (front yards only).
//
// Pulls Google Street View imagery of the property and runs a Gemini vision pass
// to (a) capture how the house actually looks (so the 3D render can match it) and
// (b) surface placement-relevant facts (side gate, driveway, garage side, ...) for
// a later layout phase. Results are cached to localStorage `diyStreetView`.
//
// Dependency-light on purpose: fetch + localStorage only. NO imports from pages or
// components — services importing pages has broken vitest before.

// Dev-only key: the import.meta.env.DEV gate lets Vite strip the key and the
// direct-to-Google branch out of production bundles entirely.
const GEMINI_API_KEY  = import.meta.env.DEV ? (import.meta.env.VITE_GEMINI_API_KEY || '') : '';
const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY   || '';
const VISION_MODEL    = 'gemini-2.5-flash';

// Same routing pattern as geminiService: in local dev a VITE_GEMINI_API_KEY sends
// calls straight to Google; in prod the key lives on the server so calls go via the
// Netlify Function proxy.
const geminiUrl = (model: string) =>
  import.meta.env.DEV && GEMINI_API_KEY
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
    : `/.netlify/functions/gemini?model=${model}`;
const VISION_API_URL = geminiUrl(VISION_MODEL);
// The key header only exists on the dev direct path — never sent to the proxy.
const GEMINI_HEADERS: Record<string, string> =
  import.meta.env.DEV && GEMINI_API_KEY
    ? { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }
    : { 'Content-Type': 'application/json' };

const CACHE_KEY = 'diyStreetView';
const PHOTO_KEY = 'diyStreetViewPhoto';

// Bump whenever `StreetInsights` gains fields that older cached entries won't have,
// so a stale cache entry is treated as a miss and refetched once rather than served
// with the new fields silently missing.
const CACHE_VERSION = 2;

// Street View analysis is PARKED for now. Its live payoff is thin relative to the per-session Gemini
// vision call: the only clearly user-visible consumer today is the side-gate walkway (and only when a
// gate is detected); the mailbox/porch beds are dormant (accent beds disabled) and the roof-type only
// shows on the standalone /diy/yard-3d page. When `false`: the boundary page skips the fetch and the
// input signature ignores any (possibly stale) diyStreetView entry. Flip to `true` to re-enable once
// the dormant consumers (accent beds, 3D) are back in the main flow — no other code changes needed.
export const STREET_VIEW_ENABLED = false;

// ── Public types ──────────────────────────────────────────────────────────────

export interface StreetInsights {
  house: {
    stories: number | null;
    sidingMaterial: 'stucco' | 'brick' | 'siding' | 'stone' | 'wood' | null;
    mainColorHex: string | null;   // dominant facade color
    trimColorHex: string | null;
    roofType: 'gable' | 'hip' | 'flat' | null;
    roofColorHex: string | null;
    frontDoorColorHex: string | null;
    garage: { present: boolean; side: 'left' | 'right' | 'center' | null };
  };
  sideGate: { present: boolean; side: 'left' | 'right' | null };
  driveway: { present: boolean; side: 'left' | 'right' | null };
  frontPorch: { present: boolean };
  fence: { present: boolean; material: string | null };
  /** Visible gutter downspouts along the front facade, viewer-relative. Optional — absent in older cached results. */
  downspouts?: { position: 'left' | 'center' | 'right' }[];
  /** Curbside post-mounted mailbox (not wall-mounted). Optional — absent in older cached results. */
  mailbox?: { present: boolean; side: 'left' | 'right' | null };
  /** Front entry steps up to the door/porch. Optional — absent in older cached results. */
  porchSteps?: { present: boolean; count: number | null };
  confidence: 'high' | 'medium' | 'low';
}

export interface StreetViewResult {
  insights: StreetInsights;
  heading: number;              // pano → house bearing used for the shot
  panoLatLng: { lat: number; lng: number };
  fetchedAt: string;            // ISO
}

interface LatLng { lat: number; lng: number }

// ── Pure helpers (exported for unit tests) ──────────────────────────────────────

/**
 * Initial great-circle bearing from point `a` to point `b`, in degrees clockwise
 * from North (0–360). Used to aim the Street View camera at the house.
 */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

const SIDING = new Set(['stucco', 'brick', 'siding', 'stone', 'wood']);
const ROOF   = new Set(['gable', 'hip', 'flat']);
const SIDE_LR = new Set(['left', 'right']);
const SIDE_LRC = new Set(['left', 'right', 'center']);
const CONF   = new Set(['high', 'medium', 'low']);

const enumOrNull = <T extends string>(v: any, set: Set<string>): T | null =>
  typeof v === 'string' && set.has(v) ? (v as T) : null;

/** Normalize a hex-ish string to `#rrggbb`/`#rgb`, else null. */
function hexOrNull(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : null;
}

function boolish(v: any): boolean {
  return v === true || v === 'true' || v === 1;
}

/**
 * Parses the model's raw text into a validated `StreetInsights`. Strips markdown
 * fences, JSON.parses defensively, coerces every field to its allowed shape, and
 * defaults anything missing/invalid to null (or false for presence flags).
 * Exported so it can be unit-tested without a network round-trip.
 */
export function parseStreetInsights(rawText: string): StreetInsights | null {
  if (!rawText) return null;

  // Strip markdown code fences, then grab the outermost JSON object.
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const h = obj.house ?? {};
  const storiesRaw = Number(h.stories);
  const stories = Number.isFinite(storiesRaw) && storiesRaw > 0 && storiesRaw <= 5
    ? Math.round(storiesRaw)
    : null;

  const garage = h.garage ?? {};
  const driveway = obj.driveway ?? {};
  const sideGate = obj.sideGate ?? {};
  const frontPorch = obj.frontPorch ?? {};
  const fence = obj.fence ?? {};

  const downspoutsRaw = Array.isArray(obj.downspouts) ? obj.downspouts : [];
  const downspouts = downspoutsRaw
    .map((d: any) => enumOrNull<'left' | 'center' | 'right'>(d?.position, SIDE_LRC))
    .filter((p: 'left' | 'center' | 'right' | null): p is 'left' | 'center' | 'right' => p !== null)
    .map((position: 'left' | 'center' | 'right') => ({ position }));

  const mailboxRaw = obj.mailbox ?? {};
  const mailbox: { present: boolean; side: 'left' | 'right' | null } = {
    present: boolish(mailboxRaw.present),
    side: enumOrNull<'left' | 'right'>(mailboxRaw.side, SIDE_LR),
  };

  const porchStepsRaw = obj.porchSteps ?? {};
  const stepsCountRaw = Number(porchStepsRaw.count);
  const stepsCount = Number.isFinite(stepsCountRaw) && stepsCountRaw >= 0 && stepsCountRaw <= 20
    ? Math.round(stepsCountRaw)
    : null;
  const porchSteps = {
    present: boolish(porchStepsRaw.present),
    count: stepsCount,
  };

  return {
    house: {
      stories,
      sidingMaterial: enumOrNull(h.sidingMaterial, SIDING),
      mainColorHex: hexOrNull(h.mainColorHex),
      trimColorHex: hexOrNull(h.trimColorHex),
      roofType: enumOrNull(h.roofType, ROOF),
      roofColorHex: hexOrNull(h.roofColorHex),
      frontDoorColorHex: hexOrNull(h.frontDoorColorHex),
      garage: {
        present: boolish(garage.present),
        side: enumOrNull(garage.side, SIDE_LRC),
      },
    },
    sideGate: {
      present: boolish(sideGate.present),
      side: enumOrNull(sideGate.side, SIDE_LR),
    },
    driveway: {
      present: boolish(driveway.present),
      side: enumOrNull(driveway.side, SIDE_LR),
    },
    frontPorch: { present: boolish(frontPorch.present) },
    fence: {
      present: boolish(fence.present),
      material: typeof fence.material === 'string' && fence.material.trim()
        ? fence.material.trim()
        : null,
    },
    downspouts,
    mailbox,
    porchSteps,
    confidence: enumOrNull(obj.confidence, CONF) ?? 'medium',
  };
}

// ── localStorage read helpers ───────────────────────────────────────────────────

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

interface SiteContext { address?: string; lat?: number; lng?: number; yard_type?: string }
interface HouseFeature { type?: string; keep?: boolean; vertices?: [number, number][] }
interface BoundaryFinal { boundary?: [number, number][]; confirmedFeatures?: HouseFeature[] }

/** Centroid ([lng,lat] average) of the largest kept house feature, or null. */
function houseCentroid(bf: BoundaryFinal | null): LatLng | null {
  const feats = bf?.confirmedFeatures ?? [];
  const houses = feats.filter(
    f => f?.type === 'house' && f?.keep !== false && Array.isArray(f.vertices) && f.vertices.length >= 3,
  );
  if (houses.length === 0) return null;

  // Largest by rough bbox area of its vertices.
  let best: HouseFeature | null = null;
  let bestArea = -1;
  for (const f of houses) {
    const vs = f.vertices!;
    const lngs = vs.map(v => v[0]);
    const lats = vs.map(v => v[1]);
    const area = (Math.max(...lngs) - Math.min(...lngs)) * (Math.max(...lats) - Math.min(...lats));
    if (area > bestArea) { bestArea = area; best = f; }
  }
  const vs = best!.vertices!;
  const lng = vs.reduce((s, v) => s + v[0], 0) / vs.length;
  const lat = vs.reduce((s, v) => s + v[1], 0) / vs.length;
  return { lat, lng };
}

/** Small stable cache key for a house location (so we only re-fetch on real moves). */
function houseKey(c: LatLng): string {
  return `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
}

// ── Image fetch ─────────────────────────────────────────────────────────────────

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = blob.type || 'image/jpeg';
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Fetch one Street View Static frame → data URL, or null on any failure. */
async function fetchPanoImage(panoId: string, heading: number): Promise<string | null> {
  const h = ((Math.round(heading) % 360) + 360) % 360;
  const url =
    `https://maps.googleapis.com/maps/api/streetview?size=640x640&pano=${encodeURIComponent(panoId)}` +
    `&heading=${h}&fov=90&pitch=5&key=${GOOGLE_MAPS_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null; // CORS or network — never throw to the caller
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const [header, base64] = dataUrl.split(',');
  const mimeType = header.replace('data:', '').replace(';base64', '');
  return { mimeType, base64 };
}

// ── Vision prompt ───────────────────────────────────────────────────────────────

const VISION_PROMPT =
`You are analyzing Google Street View photo(s) of a single-family house taken from the street, looking at the FRONT of the house.

Extract what you can clearly see and return STRICT JSON only — no prose, no markdown, no code fences.

CRITICAL — LEFT vs RIGHT: all "left"/"right" values are AS SEEN BY THE VIEWER LOOKING AT THE HOUSE FROM THE STREET. The left edge of the image is "left"; the right edge is "right". Do NOT use the homeowner's perspective.

COLORS: give hex approximations ("#rrggbb") of what is actually visible in the image (facade, trim, roof, front door). Match the dominant visible color, not an idealized one.

Rules:
- Use null for anything not clearly visible or that you are unsure about.
- "present" flags are true only when the feature is clearly visible; otherwise false.
- stories: integer count of visible floors (1, 2, ...), or null.
- sidingMaterial: one of "stucco", "brick", "siding", "stone", "wood", or null.
- roofType: one of "gable" (front-facing triangular peak), "hip" (sloped on all sides), "flat", or null.
- garage.side / sideGate.side / driveway.side: "left", "right" (garage may also be "center"), or null.
- A side gate is a pedestrian gate/opening in a fence leading to the back yard, usually at the left or right edge of the house.
- fence.material: short lowercase word like "wood", "vinyl", "chain-link", "wrought-iron", or null.
- downspouts: the vertical gutter pipes running down the front facade, usually at facade corners/edges. List one entry per clearly visible downspout, each with a "position" of "left", "center", or "right" along the facade as the viewer sees it. Return an empty array if none are clearly visible.
- mailbox: a curbside, post-mounted mailbox only — do NOT count a mailbox mounted on the house wall. present is true only if a curbside mailbox is clearly visible; side is "left" or "right" (viewer-relative), or null if unclear.
- porchSteps: visible steps leading up to the front door/porch. present is true only if steps are clearly visible; count is your best approximate integer count of the steps, or null if present but the count is unclear.
- confidence: your overall confidence — "high", "medium", or "low".

Return EXACTLY this JSON shape:
{
  "house": {
    "stories": 1,
    "sidingMaterial": "stucco",
    "mainColorHex": "#d8cbb0",
    "trimColorHex": "#ffffff",
    "roofType": "gable",
    "roofColorHex": "#5a5a5a",
    "frontDoorColorHex": "#3a2a1a",
    "garage": { "present": true, "side": "right" }
  },
  "sideGate": { "present": false, "side": null },
  "driveway": { "present": true, "side": "right" },
  "frontPorch": { "present": false },
  "fence": { "present": false, "material": null },
  "downspouts": [{ "position": "left" }, { "position": "right" }],
  "mailbox": { "present": true, "side": "left" },
  "porchSteps": { "present": true, "count": 3 },
  "confidence": "medium"
}`;

async function runVision(dataUrls: string[]): Promise<StreetInsights | null> {
  const imageParts = dataUrls.map(u => {
    const { mimeType, base64 } = parseDataUrl(u);
    return { inline_data: { mime_type: mimeType, data: base64 } };
  });

  const body = {
    contents: [{ parts: [{ text: VISION_PROMPT }, ...imageParts] }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  let res: Response;
  try {
    res = await fetch(VISION_API_URL, {
      method: 'POST',
      headers: GEMINI_HEADERS,
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: any;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const text: string = data?.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';
  return parseStreetInsights(text);
}

// ── House-attribute seeding ─────────────────────────────────────────────────────

interface HouseAttributes { stories?: number; style?: string; material?: string; color?: string }

/**
 * Merges extracted insights into `diyHouseAttributes` WITHOUT clobbering any field
 * the user already set. Only writes fields currently absent from the stored object.
 */
function seedHouseAttributes(insights: StreetInsights): void {
  let existing: HouseAttributes | null = null;
  try {
    const raw = localStorage.getItem('diyHouseAttributes');
    existing = raw ? (JSON.parse(raw) as HouseAttributes) : null;
  } catch {
    existing = null;
  }

  const material = insights.house.sidingMaterial ?? undefined;
  const color = insights.house.mainColorHex ?? undefined;
  const stories = insights.house.stories ?? 1;

  const merged: HouseAttributes = { ...(existing ?? {}) };
  if (merged.stories === undefined || merged.stories === null) merged.stories = stories;
  if ((merged.material === undefined || merged.material === '') && material) merged.material = material;
  if ((merged.color === undefined || merged.color === '') && color) merged.color = color;

  try {
    localStorage.setItem('diyHouseAttributes', JSON.stringify(merged));
  } catch {
    /* quota — non-fatal */
  }
}

// ── Public API ───────────────────────────────────────────────────────────────────

/** Reads the cached insights from localStorage `diyStreetView`, or null. */
export function getStreetViewInsights(): StreetInsights | null {
  const cached = readJSON<{ result?: StreetViewResult }>(CACHE_KEY);
  return cached?.result?.insights ?? null;
}

/**
 * Front-yard Street View analysis. Returns a `StreetViewResult` on success, or
 * null when gated out / no coverage / any failure (never throws).
 *
 * Caching: on the same house (rounded centroid key) the cached result is returned
 * unless `force` is true.
 */
export async function analyzeStreetView(force = false): Promise<StreetViewResult | null> {
  // ── GATING ────────────────────────────────────────────────────────────────
  const site = readJSON<SiteContext>('siteContext');
  if (!site || site.yard_type !== 'front') return null;   // front yards ONLY
  if (!GOOGLE_MAPS_KEY) return null;

  const bf = readJSON<BoundaryFinal>('diyBoundaryFinal');
  const house = houseCentroid(bf);
  if (!house) return null;                                 // no house feature
  if (typeof house.lat !== 'number' || typeof house.lng !== 'number') return null;

  const key = houseKey(house);

  // ── CACHE ─────────────────────────────────────────────────────────────────
  // A cached entry missing `v === CACHE_VERSION` (i.e. written before the current
  // `StreetInsights` schema) is treated as a miss so it refetches once.
  const cached = readJSON<{ key?: string; v?: number; result?: StreetViewResult }>(CACHE_KEY);
  if (!force && cached?.key === key && cached?.v === CACHE_VERSION && cached.result) {
    return cached.result;
  }

  // ── PANO DISCOVERY (metadata endpoint, queried with the HOUSE centroid) ─────
  let meta: any;
  try {
    const metaUrl =
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${house.lat},${house.lng}` +
      `&source=outdoor&key=${GOOGLE_MAPS_KEY}`;
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) return null;
    meta = await metaRes.json();
  } catch {
    return null;
  }
  if (!meta || meta.status !== 'OK' || !meta.pano_id || !meta.location) return null;

  const panoLatLng: LatLng = {
    lat: Number(meta.location.lat),
    lng: Number(meta.location.lng),
  };
  if (!Number.isFinite(panoLatLng.lat) || !Number.isFinite(panoLatLng.lng)) return null;

  // ── IMAGE(S) ────────────────────────────────────────────────────────────────
  const heading = bearingBetween(panoLatLng, house);
  const primary = await fetchPanoImage(meta.pano_id, heading);
  if (!primary) return null;

  // Second frame offset for gate/driveway visibility (best-effort).
  const secondary = await fetchPanoImage(meta.pano_id, heading + 30);
  const frames = secondary ? [primary, secondary] : [primary];

  // ── VISION EXTRACTION ─────────────────────────────────────────────────────
  const insights = await runVision(frames);
  if (!insights) return null;

  const result: StreetViewResult = {
    insights,
    heading,
    panoLatLng,
    fetchedAt: new Date().toISOString(),
  };

  // ── PERSIST ───────────────────────────────────────────────────────────────
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ key, v: CACHE_VERSION, result }));
  } catch {
    /* quota — non-fatal */
  }

  // Seed house attributes without clobbering user customization.
  seedHouseAttributes(insights);

  // Stash the reference photo for a later rendering phase (sessionStorage).
  try {
    sessionStorage.setItem(PHOTO_KEY, primary);
  } catch {
    /* quota — non-fatal */
  }

  return result;
}
