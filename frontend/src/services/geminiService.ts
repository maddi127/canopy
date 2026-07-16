import * as turf from '@turf/turf';
import { PLANTS } from '../features/planting/plantDatabase';
import type { ExtractedFeature } from './planTranslationService';

// Direct-to-Google is DEV-ONLY: gating on import.meta.env.DEV lets Vite
// statically eliminate the key and the direct-URL branch from production
// bundles, so a VITE_GEMINI_API_KEY accidentally set in Netlify can't leak.
const GEMINI_API_KEY    = import.meta.env.DEV ? (import.meta.env.VITE_GEMINI_API_KEY || '') : '';
const GOOGLE_MAPS_KEY   = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const TEXT_MODEL  = 'gemini-2.0-flash';

// Gemini routing: in production the API key lives only on the server, so calls
// go through the Netlify Function proxy. In local dev, a VITE_GEMINI_API_KEY in
// .env makes calls go straight to Google so `vite dev` works without netlify dev.
const geminiUrl = (model: string) =>
  import.meta.env.DEV && GEMINI_API_KEY
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
    : `/.netlify/functions/gemini?model=${model}`;
// The key header only exists on the dev direct path — never sent to the proxy.
const GEMINI_HEADERS: Record<string, string> =
  import.meta.env.DEV && GEMINI_API_KEY
    ? { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }
    : { 'Content-Type': 'application/json' };
const IMAGE_API_URL = geminiUrl(IMAGE_MODEL);
const TEXT_API_URL  = geminiUrl(TEXT_MODEL);

const STYLE_LABELS: Record<string, string> = {
  natural_wild: 'Whimsical / wildflower cottage style',
  modern_structured: 'Modern / minimalist structured style',
  desert_minimal: 'Desert / xeriscape drought-tolerant style',
  traditional: 'Traditional / classic formal style',
};

const PRIORITY_LABELS: Record<string, string> = {
  low_maintenance: 'low maintenance',
  curb_appeal: 'strong curb appeal',
  pollinator: 'pollinator-friendly plantings',
  kid_pet: 'kid and pet safe design',
};

const FEATURE_LABELS: Record<string, string> = {
  walkway: 'a walkway to the door',
  seating: 'a seating area',
  dining: 'an outdoor dining area',
  cooking: 'an outdoor cooking area',
  water: 'a water feature',
  garden: 'a vegetable garden',
  storage: 'a storage shed',
  trees: 'shade trees',
};

function extractCity(address: string): string {
  const parts = address.split(',');
  if (parts.length >= 2) return parts[1].trim();
  return address;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const [header, base64] = dataUrl.split(',');
  const mimeType = header.replace('data:', '').replace(';base64', '');
  return { mimeType, base64 };
}

// ── Layout-aware concept generation ──────────────────────────────────────────

/** Minimal GeoJSON polygon shape — avoids importing turf just for types. */
type GeoPolygon = { geometry: { coordinates: [number, number][][] } };

export interface LayoutPlacement {
  type: string;
  label: string;
  center: [number, number]; // [lng, lat]
  radiusMeters: number;
}

export interface GenerateLayoutConceptParams {
  photoDataUrl: string;
  address: string;
  yardType: string;
  style: string;
  priorities: string[];
  features: string[];
  placements: LayoutPlacement[];
  propertyPolygon: GeoPolygon;
  houseFootprint?: GeoPolygon | null;
}

const ZONE_COLORS: Record<string, string> = {
  cooking: '#E76F51', dining: '#E9C46A', seating: '#F4A261',
  water:   '#5DA9E9', garden: '#2D6A4F', lawn:    '#6FBF73',
  storage: '#A0522D', other:  '#1B4332',
};

/**
 * Renders an overhead layout diagram as a PNG data URL.
 *
 * The canvas shows:
 *   - property polygon outline (green)
 *   - house footprint filled amber (if available)
 *   - each zone as a proportionally-sized, labelled circle
 *
 * All measurements are converted to a meter coordinate system first so
 * zone radii are geometrically accurate relative to the polygon size.
 */
function createLayoutDiagram(
  placements: LayoutPlacement[],
  propertyPolygon: GeoPolygon,
  houseFootprint?: GeoPolygon | null,
): string {
  const SIZE = 512;
  const PAD  = 36;

  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  // ── Meter coordinate system ─────────────────────────────────────────────
  const ring = propertyPolygon.geometry.coordinates[0] as [number, number][];
  const lngs = ring.map(c => c[0]);
  const lats  = ring.map(c => c[1]);
  const refLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const refLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180);
  const mpdLat = 110540;

  const toM = (lng: number, lat: number): [number, number] => [
    (lng - refLng) * mpdLng,
    (lat - refLat) * mpdLat,
  ];

  // ── Scale: fit the polygon's meter bbox into the canvas ─────────────────
  const polyM = ring.map(c => toM(c[0], c[1]));
  const mxs = polyM.map(p => p[0]), mys = polyM.map(p => p[1]);
  const minMx = Math.min(...mxs), maxMx = Math.max(...mxs);
  const minMy = Math.min(...mys), maxMy = Math.max(...mys);
  const rangeX = maxMx - minMx || 1, rangeY = maxMy - minMy || 1;
  const pixPerM = Math.min((SIZE - PAD * 2) / rangeX, (SIZE - PAD * 2) / rangeY);

  // Center the drawing
  const offX = (SIZE - rangeX * pixPerM) / 2;
  const offY = (SIZE - rangeY * pixPerM) / 2;

  const toPx = (mx: number, my: number): [number, number] => [
    offX + (mx - minMx) * pixPerM,
    SIZE - offY - (my - minMy) * pixPerM, // Y flipped: north = up
  ];

  // ── Background ───────────────────────────────────────────────────────────
  ctx.fillStyle = '#f5f5f0';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ── Property polygon ────────────────────────────────────────────────────
  ctx.beginPath();
  polyM.forEach(([mx, my], i) => {
    const [px, py] = toPx(mx, my);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = '#dff0e0';
  ctx.fill();
  ctx.strokeStyle = '#2f6b4f';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // ── House footprint ─────────────────────────────────────────────────────
  if (houseFootprint?.geometry?.coordinates?.[0]?.length) {
    const hRing = houseFootprint.geometry.coordinates[0] as [number, number][];
    const hM = hRing.map(c => toM(c[0], c[1]));
    ctx.beginPath();
    hM.forEach(([mx, my], i) => {
      const [px, py] = toPx(mx, my);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,158,11,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // HOUSE label at centroid
    const cMx = hM.reduce((s, p) => s + p[0], 0) / hM.length;
    const cMy = hM.reduce((s, p) => s + p[1], 0) / hM.length;
    const [hpx, hpy] = toPx(cMx, cMy);
    ctx.fillStyle = '#92400e';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HOUSE', hpx, hpy);
  }

  // ── Zone circles ────────────────────────────────────────────────────────
  for (const p of placements) {
    const [mx, my] = toM(p.center[0], p.center[1]);
    const [px, py] = toPx(mx, my);
    const rPx = Math.max(p.radiusMeters * pixPerM, 10);
    const col = ZONE_COLORS[p.type] ?? '#888888';

    // Filled circle
    ctx.beginPath();
    ctx.arc(px, py, rPx, 0, Math.PI * 2);
    ctx.fillStyle = col + 'aa';   // ~67% opacity
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label — split into two lines if > 12 chars
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(8, Math.min(11, rPx * 0.45))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const words = p.label.split(' ');
    if (words.length > 1 && rPx > 18) {
      const mid = Math.ceil(words.length / 2);
      const line1 = words.slice(0, mid).join(' ');
      const line2 = words.slice(mid).join(' ');
      const lh = Math.max(8, Math.min(11, rPx * 0.45)) * 1.25;
      ctx.fillText(line1, px, py - lh / 2);
      ctx.fillText(line2, px, py + lh / 2);
    } else {
      ctx.fillText(p.label, px, py);
    }
  }

  // ── Legend ───────────────────────────────────────────────────────────────
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let legendY = 14;
  ctx.fillStyle = '#333';
  ctx.fillText('LAYOUT PLAN', 10, legendY);
  legendY += 16;
  for (const p of placements) {
    const col = ZONE_COLORS[p.type] ?? '#888';
    ctx.fillStyle = col;
    ctx.fillRect(10, legendY - 5, 10, 10);
    ctx.fillStyle = '#333';
    ctx.fillText(p.label, 25, legendY);
    legendY += 14;
  }

  return canvas.toDataURL('image/png');
}

// ── Spatial translation layer ─────────────────────────────────────────────────

/** Converts a bearing in degrees (clockwise from North) to an 8-point compass label. */
function bearingToCompass(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Distance from point P to segment AB, all in meters. */
function ptSegDistM(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface ZoneWithLocation {
  placement: LayoutPlacement;
  areaSqFt: number;
  relativeLocation: string; // human-readable, e.g. "18 ft NW of the house"
}

/**
 * For each placement, computes:
 *   - size in sq ft
 *   - distance + compass bearing from house center
 *   - whether the zone abuts a property line (and which cardinal side)
 *
 * Returns an array of enriched zone objects ready for prompt insertion.
 */
function enrichZonesWithLocation(
  placements: LayoutPlacement[],
  propertyPolygon: GeoPolygon,
  houseFootprint?: GeoPolygon | null,
): ZoneWithLocation[] {
  const ring = propertyPolygon.geometry.coordinates[0] as [number, number][];

  // Meter conversion helpers
  const refLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  const refLng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180);
  const mpdLat = 110540;
  const toM = (lng: number, lat: number): [number, number] => [
    (lng - refLng) * mpdLng,
    (lat - refLat) * mpdLat,
  ];

  // House center in meters
  let houseMx: number, houseMy: number;
  if (houseFootprint?.geometry?.coordinates?.[0]?.length) {
    const hr = houseFootprint.geometry.coordinates[0] as [number, number][];
    const mc = hr.map(c => toM(c[0], c[1]));
    houseMx = mc.reduce((s, p) => s + p[0], 0) / mc.length;
    houseMy = mc.reduce((s, p) => s + p[1], 0) / mc.length;
  } else {
    // Fall back to midpoint of southernmost edge
    let minAvgY = Infinity;
    houseMx = 0; houseMy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = toM(ring[i][0], ring[i][1]);
      const [bx, by] = toM(ring[i + 1][0], ring[i + 1][1]);
      const avgY = (ay + by) / 2;
      if (avgY < minAvgY) {
        minAvgY = avgY;
        houseMx = (ax + bx) / 2;
        houseMy = (ay + by) / 2;
      }
    }
  }

  // Property edges in meters + their cardinal label (which side of the polygon)
  const polyM = ring.map(c => toM(c[0], c[1]));
  const polyCx = polyM.reduce((s, p) => s + p[0], 0) / polyM.length;
  const polyCy = polyM.reduce((s, p) => s + p[1], 0) / polyM.length;

  const edges = polyM.slice(0, -1).map((a, i) => {
    const b = polyM[i + 1];
    const midX = (a[0] + b[0]) / 2, midY = (a[1] + b[1]) / 2;
    // Bearing from polygon centroid to edge midpoint → which side the edge is on
    const bearing = ((Math.atan2(midX - polyCx, midY - polyCy) * 180 / Math.PI) + 360) % 360;
    const side = bearing < 45 || bearing >= 315 ? 'Northern'
               : bearing < 135                  ? 'Eastern'
               : bearing < 225                  ? 'Southern'
               :                                  'Western';
    return { a, b, side };
  });

  return placements.map(p => {
    const [zx, zy] = toM(p.center[0], p.center[1]);
    const dx = zx - houseMx, dy = zy - houseMy;
    const distM  = Math.hypot(dx, dy);
    const distFt = Math.round(distM * 3.28084);

    // Bearing from house → zone (clockwise from North: atan2(east, north))
    const bearingDeg = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    const compass = bearingToCompass(bearingDeg);

    // Property line check: is the zone's edge within ~1 m of any property edge?
    let lineNote = '';
    for (const edge of edges) {
      const d = ptSegDistM(zx, zy, edge.a[0], edge.a[1], edge.b[0], edge.b[1]);
      if (d < p.radiusMeters + 1.0) {
        lineNote = `, abutting the ${edge.side} property line`;
        break;
      }
    }

    // Proximity label
    let relativeLocation: string;
    if (distM < 2) {
      relativeLocation = `immediately adjacent to the house (${compass} side)${lineNote}`;
    } else if (distM < 5) {
      relativeLocation = `${distFt} ft ${compass} of the house, very close to the house wall${lineNote}`;
    } else {
      relativeLocation = `${distFt} ft ${compass} of the house${lineNote}`;
    }

    const areaSqFt = Math.round(Math.PI * p.radiusMeters ** 2 / 0.0929);
    return { placement: p, areaSqFt, relativeLocation };
  });
}

export async function generateLayoutConcept(params: GenerateLayoutConceptParams): Promise<string> {
  const city       = extractCity(params.address);
  const yardLabel  = `${params.yardType} yard`;
  const styleLabel = STYLE_LABELS[params.style] || params.style;
  const priorityList = params.priorities.map(p => PRIORITY_LABELS[p] || p).filter(Boolean).join(', ');

  // ── Spatial data ────────────────────────────────────────────────────────────
  const enriched = enrichZonesWithLocation(
    params.placements, params.propertyPolygon, params.houseFootprint,
  );

  const diagramDataUrl = params.placements.length > 0
    ? createLayoutDiagram(params.placements, params.propertyPolygon, params.houseFootprint)
    : null;

  // ── Prompt ──────────────────────────────────────────────────────────────────
  const houseCoordNote = params.houseFootprint
    ? 'The amber shape in the layout plan represents the house footprint.'
    : 'The house is at the edge of the yard nearest the street.';

  const zoneConstraints = enriched
    .map(z => `Place the ${z.placement.label} (~${z.areaSqFt} sq ft) exactly ${z.relativeLocation}.`)
    .join('\n- ');

  const wantsLawn = params.features.includes('lawn');
  const lawnRule = wantsLawn
    ? `- An open lawn area has been requested. Include it as a clearly defined grass zone.`
    : `- Do NOT include any lawn or grass area. The user did not request it. Fill all open soil with planting beds, groundcovers, or mulch instead.`;

  const prompt =
`You are a professional landscape designer in ${city}.
${diagramDataUrl ? `The first image is a precise top-down layout plan of the ${yardLabel}. Use it as a geometric source of truth — zone positions and sizes in the diagram are accurate. ${houseCoordNote}` : ''}

STRICT SPATIAL CONSTRAINTS:
- ${zoneConstraints}
- Preserve the exact distances and bearings between the house and each zone.
- Zone sizes must reflect their actual footprint areas relative to the yard.

STYLE & EXECUTION:
- Transform the yard photo into a photorealistic ${styleLabel} design.
${priorityList ? `- Priorities: ${priorityList}.\n` : ''}- Respect the existing house structure and any visible hard surfaces.
- Do not add fences unless already visible in the photo. Do not add signs or small decorative accents.
${lawnRule}
- Output a high-quality professional landscape photograph.`;

  const { mimeType, base64 } = parseDataUrl(params.photoDataUrl);

  // Build parts: diagram first (spatial reference), then the yard photo
  const imageParts: object[] = [];
  if (diagramDataUrl) {
    const { base64: diagB64 } = parseDataUrl(diagramDataUrl);
    imageParts.push({ inline_data: { mime_type: 'image/png', data: diagB64 } });
  }
  imageParts.push({ inline_data: { mime_type: mimeType, data: base64 } });

  const body = {
    contents: [{
      parts: [{ text: prompt }, ...imageParts],
    }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  const res = await fetch(IMAGE_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!imagePart) throw new Error('No image returned from Gemini');
  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

// ── Original concept generation (unchanged) ───────────────────────────────────

export interface HardscapeZone {
  type: 'driveway' | 'walkway' | 'patio' | 'steps' | 'other';
  label: string;
  /** Normalized polygon vertices: (0,0) = top-left, (1,1) = bottom-right */
  polygon: [number, number][];
}

export async function detectHardscapes(photoDataUrl: string): Promise<HardscapeZone[]> {
  const prompt =
    `You are analyzing a photo of a residential property.\n\n` +
    `Identify and trace every driveway, walkway, front path, patio, steps, and paved hardscape surface visible.\n\n` +
    `Return ONLY a JSON array, no other text:\n` +
    `[{"type":"driveway|walkway|patio|steps|other","label":"human-readable name","polygon":[[x1,y1],[x2,y2],...]}]\n\n` +
    `Coordinates are normalized: (0,0) = top-left, (1,1) = bottom-right. Use 4–8 vertices per polygon.\n` +
    `If no hardscape is visible, return an empty array: []`;

  const { mimeType, base64 } = parseDataUrl(photoDataUrl);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) return [];

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  const VALID_TYPES = new Set(['driveway', 'walkway', 'patio', 'steps', 'other']);
  try {
    const parsed = JSON.parse(match[0]) as any[];
    return parsed
      .filter(z => Array.isArray(z.polygon) && z.polygon.length >= 3)
      .map(z => ({
        type: VALID_TYPES.has(z.type) ? z.type as HardscapeZone['type'] : 'other',
        label: typeof z.label === 'string' ? z.label : 'Hardscape',
        polygon: (z.polygon as any[]).map((pt: any) =>
          (Array.isArray(pt) ? [pt[0], pt[1]] : [pt.x, pt.y]) as [number, number]
        ),
      }));
  } catch { return []; }
}

// ── Aerial site feature detection ─────────────────────────────────────────────

export interface AerialTree {
  /** Normalized position in the aerial image: (0,0)=top-left, (1,1)=bottom-right */
  centerNorm: [number, number];
  /** Radius as a fraction of the image width */
  radiusNorm: number;
}

export interface AerialHardscape {
  type: 'walkway' | 'driveway' | 'patio' | 'other';
  label: string;
  /** Normalized polygon vertices: (0,0)=top-left, (1,1)=bottom-right */
  polygonNorm: [number, number][];
}

export interface AerialSiteFeatures {
  trees: AerialTree[];
  hardscapes: AerialHardscape[];
}

/**
 * Analyzes a satellite/aerial map screenshot and returns the positions of
 * existing trees and hardscape surfaces (driveways, walkways, patios).
 *
 * Coordinates are normalized to the canvas: (0,0) = top-left, (1,1) = bottom-right.
 * The caller is responsible for converting to geographic coordinates using
 * the map's `unproject` method.
 */
export async function detectAerialSiteFeatures(
  aerialImageDataUrl: string,
): Promise<AerialSiteFeatures> {
  const prompt =
    `You are analyzing a satellite aerial image of a residential property.\n\n` +
    `Identify ALL of the following visible in the image:\n` +
    `1. Trees — round canopy shapes visible from above (green/dark blobs). Each tree is a separate entry.\n` +
    `2. Hardscapes — trace EACH surface as a SEPARATE polygon entry:\n` +
    `   - Driveways (wide paved areas leading from street to garage)\n` +
    `   - Walkways / front paths (narrow strips of concrete/pavers leading to doors)\n` +
    `   - Side paths or stepping stone paths\n` +
    `   - Patios or paved pads\n\n` +
    `IMPORTANT: Do NOT merge multiple surfaces into one polygon. A driveway and a walkway must be separate entries even if they connect.\n\n` +
    `Use normalized image coordinates: (0,0) = top-left corner, (1,1) = bottom-right corner.\n\n` +
    `Return ONLY a valid JSON object with no markdown:\n` +
    `{\n` +
    `  "trees": [\n` +
    `    {"centerNorm": [x, y], "radiusNorm": r}\n` +
    `  ],\n` +
    `  "hardscapes": [\n` +
    `    {"type": "driveway|walkway|patio|other", "label": "human label", "polygonNorm": [[x1,y1],[x2,y2],...]}\n` +
    `  ]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Tree radius is half the canopy diameter as a fraction of image width\n` +
    `- Hardscape polygons may use up to 16 vertices — use as many as needed to trace the shape accurately\n` +
    `- Narrow walkways need at least 4 vertices (two per long edge) to capture their shape\n` +
    `- Include all clearly visible features anywhere in the image; ignore map UI controls\n` +
    `- If none found return empty arrays`;

  const { mimeType, base64 } = parseDataUrl(aerialImageDataUrl);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ]}],
    }),
  });

  if (!res.ok) return { trees: [], hardscapes: [] };

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { trees: [], hardscapes: [] };

  try {
    const parsed = JSON.parse(match[0]);
    const VALID_HS = new Set(['walkway', 'driveway', 'patio', 'other']);
    return {
      trees: (parsed.trees ?? [])
        .filter((t: any) => Array.isArray(t.centerNorm) && typeof t.radiusNorm === 'number')
        .map((t: any) => ({
          centerNorm: [Number(t.centerNorm[0]), Number(t.centerNorm[1])] as [number, number],
          radiusNorm: Number(t.radiusNorm),
        })),
      hardscapes: (parsed.hardscapes ?? [])
        .filter((h: any) => Array.isArray(h.polygonNorm) && h.polygonNorm.length >= 3)
        .map((h: any) => ({
          type: VALID_HS.has(h.type) ? h.type as AerialHardscape['type'] : 'other',
          label: typeof h.label === 'string' ? h.label : 'Hardscape',
          polygonNorm: (h.polygonNorm as any[]).map((pt: any) =>
            [Number(pt[0]), Number(pt[1])] as [number, number]
          ),
        })),
    };
  } catch {
    return { trees: [], hardscapes: [] };
  }
}

export interface ConceptFeature {
  feature_name: string;
  relative_position: [number, number]; // [x, y], (0,0)=top-left, (1,1)=bottom-right
  area_sq_ft: number;
  shape: FeatureShape;
  /** Clockwise bearing from North (0–360). Orientation of the long axis for
   *  rectangle / rounded_rectangle; ignored for circle. */
  bearing: number;
}

export interface GenerateConceptResult {
  imageDataUrl: string;
  features: ConceptFeature[];
  hardscapeZones: HardscapeZone[];
}

export interface GenerateConceptParams {
  photoDataUrl: string;
  address: string;
  yardType: string;
  style: string;
  priorities: string[];
  features: string[];
  editInstructions?: string;
  polygonRing?: [number, number][]; // [lng, lat] points (open ring, first ≠ last)
  usdaZone?: number | null;
  /** All boundary vertices traced on the photo, in the same order as polygonRing.
   *  Each entry is [normX, normY] with (0,0)=top-left, (1,1)=bottom-right.
   *  Preferred over anchorPixels/anchorLabels — gives a full perspective homography. */
  photoPolygon?: [number, number][];
  /** @deprecated Use photoPolygon. Kept for backward compat with old sessions. */
  anchorPixels?: ([number, number] | null)[] | null;
  /** @deprecated Use photoPolygon. Kept for backward compat with old sessions. */
  anchorLabels?: (string | null)[] | null;
  houseFootprint?: { coordinates: [number, number][][]; height?: number } | null;
  hardscapeZones?: HardscapeZone[];
}

const PRIORITY_CONSTRAINTS = ['pollinator', 'kid_pet', 'low_water'] as const;

function buildApprovedPlantList(usdaZone: number, priorities: string[]): string {
  const activeConstraints = priorities.filter(p =>
    (PRIORITY_CONSTRAINTS as readonly string[]).includes(p)
  );

  let filtered = PLANTS.filter(p => p.min_zone <= usdaZone && p.max_zone >= usdaZone);

  if (activeConstraints.length > 0) {
    const constrained = filtered.filter(p =>
      activeConstraints.every(c => p.priorities.includes(c as any))
    );
    // Fall back to zone-only if constraints are too restrictive
    if (constrained.length >= 5) filtered = constrained;
  }

  // Group by type for readability
  const byType: Record<string, string[]> = {};
  for (const p of filtered) {
    (byType[p.type] ??= []).push(p.common_name);
  }

  const typeLabels: Record<string, string> = {
    tree: 'Trees', large_shrub: 'Large shrubs', foundation_shrub: 'Foundation shrubs',
    perimeter_shrub: 'Perimeter shrubs', filler: 'Fillers & groundcovers',
  };

  return Object.entries(byType)
    .map(([type, names]) => `${typeLabels[type] ?? type}: ${names.join(', ')}`)
    .join('\n');
}

/** Converts a polygon ring to local [x, y] feet coords with SW corner at (0,0), north = +y. */
function polygonToLocalFeet(ring: [number, number][]): [number, number][] {
  const lngs = ring.map(p => p[0]);
  const lats  = ring.map(p => p[1]);
  const refLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180) * 3.28084; // ft per deg lng
  const mpdLat = 110540 * 3.28084;                                      // ft per deg lat
  const minLng = Math.min(...lngs);
  const minLat = Math.min(...lats);
  return ring.map(([lng, lat]) => [
    Math.round((lng - minLng) * mpdLng),
    Math.round((lat - minLat) * mpdLat),
  ]);
}

// ── Feature default sizes ─────────────────────────────────────────────────────

/** Canonical sq-ft footprints for each feature type. Used instead of Gemini estimates. */
export type FeatureShape = 'circle' | 'rectangle' | 'rounded_rectangle' | 'square';

export const FEATURE_DEFAULT_SQ_FT: Record<string, number> = {
  seating:  120,  // ~10×12 ft patio/seating area
  dining:   160,  // ~10×16 ft outdoor dining
  cooking:   80,  // ~8×10 ft cooking/grill zone
  water:     20,  // small fountain / water feature
  garden:    80,  // ~4×20 ft raised/in-ground bed
  storage:   64,  // 8×8 shed footprint
  trees:     10,  // tree trunk/base marker
  lawn:     600,  // open lawn area
};

const FEATURE_DEFAULT_SHAPE: Record<string, FeatureShape> = {
  seating:  'rounded_rectangle',
  dining:   'rectangle',
  cooking:  'square',
  water:    'circle',
  garden:   'rectangle',
  storage:  'square',
  trees:    'circle',
  lawn:     'rounded_rectangle',
};

/** Returns the default sq-ft for a feature by matching its name to known keys. */
export function resolveDefaultSqFt(featureName: string): number {
  const lower = featureName.toLowerCase();
  for (const [key, sqFt] of Object.entries(FEATURE_DEFAULT_SQ_FT)) {
    if (lower.includes(key)) return sqFt;
  }
  return 100; // fallback
}

/** Returns the default shape for a feature by matching its name to known keys. */
export function resolveDefaultShape(featureName: string): FeatureShape {
  const lower = featureName.toLowerCase();
  for (const [key, shape] of Object.entries(FEATURE_DEFAULT_SHAPE)) {
    if (lower.includes(key)) return shape;
  }
  return 'circle';
}

// ── Overlap resolution ────────────────────────────────────────────────────────

const WALKWAY_HALF_WIDTH_FT = 2;   // 4 ft walkway → 2 ft each side from centerline
const WALKWAY_BUFFER_FT     = 1;   // extra clearance beyond the walkway edge
const FEATURE_MARGIN_FT     = 1;   // minimum gap between feature circle edges

/**
 * Iteratively pushes feature centers apart from each other and away from
 * walkway centerlines, working in local-feet space.
 *
 * @param features   Features with normalized [x,y] positions and resolved sq-ft
 * @param walkwaysFt Walkway polylines already converted to local feet
 * @param wFt        Polygon width in feet
 * @param hFt        Polygon height in feet
 */
/** Bounding circle radius in feet for a given shape and area, used for collision detection. */
function boundingRadius(sqFt: number, shape: FeatureShape): number {
  switch (shape) {
    case 'circle':           return Math.sqrt(sqFt / Math.PI);
    case 'square':           return Math.sqrt(sqFt) / 2 * Math.SQRT2; // half-diagonal
    case 'rectangle':
    case 'rounded_rectangle': {
      // 2:1 aspect ratio — half-diagonal of the bounding box
      const w = Math.sqrt(sqFt / 2);
      const h = 2 * w;
      return Math.hypot(w / 2, h / 2);
    }
  }
}

function resolveOverlaps(
  features: ConceptFeature[],
  walkwaysFt: [number, number][][],
  wFt: number,
  hFt: number,
  iterations = 20,
): ConceptFeature[] {
  // Work in feet; convert normalized → feet
  const pos: [number, number][] = features.map(f => [
    f.relative_position[0] * wFt,
    f.relative_position[1] * hFt,
  ]);
  const radii = features.map(f => boundingRadius(f.area_sq_ft, f.shape));

  for (let iter = 0; iter < iterations; iter++) {
    // ── Push away from each walkway segment ─────────────────────
    for (let i = 0; i < pos.length; i++) {
      let [px, py] = pos[i];
      const minDist = radii[i] + WALKWAY_HALF_WIDTH_FT + WALKWAY_BUFFER_FT;

      for (const walkway of walkwaysFt) {
        for (let s = 0; s < walkway.length - 1; s++) {
          const [ax, ay] = walkway[s];
          const [bx, by] = walkway[s + 1];
          const dx = bx - ax, dy = by - ay;
          const len2 = dx * dx + dy * dy;
          if (len2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const cx = ax + t * dx, cy = ay + t * dy; // closest point on segment
          const ex = px - cx, ey = py - cy;
          const dist = Math.hypot(ex, ey);
          if (dist < minDist) {
            const push = dist > 0 ? (minDist - dist) / dist : minDist / Math.max(1e-9, minDist);
            px += ex * push;
            py += ey * push;
          }
        }
      }
      pos[i] = [px, py];
    }

    // ── Push features apart from each other ─────────────────────
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const [ax, ay] = pos[i];
        const [bx, by] = pos[j];
        const minDist = radii[i] + radii[j] + FEATURE_MARGIN_FT;
        const dx = bx - ax, dy = by - ay;
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) {
          const overlap = (minDist - dist) / 2;
          if (dist > 0) {
            const ux = dx / dist, uy = dy / dist;
            pos[i] = [ax - ux * overlap, ay - uy * overlap];
            pos[j] = [bx + ux * overlap, by + uy * overlap];
          } else {
            // Exactly coincident — separate along x
            pos[i] = [ax - overlap, ay];
            pos[j] = [bx + overlap, by];
          }
        }
      }
    }

    // ── Clamp to polygon bounds (with feature radius as margin) ─
    for (let i = 0; i < pos.length; i++) {
      const r = radii[i];
      pos[i] = [
        Math.max(r, Math.min(wFt - r, pos[i][0])),
        Math.max(r, Math.min(hFt - r, pos[i][1])),
      ];
    }
  }

  return features.map((f, i) => ({
    ...f,
    relative_position: [pos[i][0] / wFt, pos[i][1] / hFt] as [number, number],
  }));
}

// ── Material zone detection ───────────────────────────────────────────────────

export type MaterialType =
  | 'lawn' | 'mulch' | 'rock' | 'gravel' | 'concrete'
  | 'pavers' | 'decking' | 'decomposed_granite' | 'sand' | 'other';

export interface MaterialZone {
  material: MaterialType;
  label: string;
  /** Normalized polygon vertices: (0,0) = SW corner, (1,1) = NE corner. */
  polygon: [number, number][];
}

export const MATERIAL_COLORS: Record<string, string> = {
  lawn:               '#6FBF73',
  mulch:              '#8B5E3C',
  rock:               '#9E9E9E',
  gravel:             '#BDBDBD',
  concrete:           '#CFD8DC',
  pavers:             '#A1887F',
  decking:            '#D7CBA3',
  decomposed_granite: '#C8A96E',
  sand:               '#F2D06B',
  other:              '#B0BEC5',
};

/**
 * Analyzes the concept image and returns approximate polygons for each
 * distinct surface material zone (lawn, mulch, rock, concrete, etc.).
 * Polygon vertices are in the same normalized (0,0)=SW, (1,1)=NE space
 * as ConceptFeature relative_position.
 */
export async function detectMaterialZones(params: {
  conceptImageDataUrl: string;
  polygonRing: [number, number][];
}): Promise<MaterialZone[]> {
  const { polygonRing } = params;

  const lngs = polygonRing.map(p => p[0]);
  const lats  = polygonRing.map(p => p[1]);
  const refLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180) * 3.28084;
  const mpdLat = 110540 * 3.28084;
  const wFt = Math.round((Math.max(...lngs) - Math.min(...lngs)) * mpdLng);
  const hFt = Math.round((Math.max(...lats) - Math.min(...lats)) * mpdLat);

  const prompt =
    `You are a landscape design analyst. Examine this landscape concept image.\n\n` +
    `PROJECT AREA: ${wFt} ft wide × ${hFt} ft deep.\n` +
    `Coordinate system: SW corner = (0,0), NE corner = (1,1).\n\n` +
    `Identify every distinct surface material zone visible in the image — ` +
    `e.g. lawn/grass, mulch/bark, rock/gravel, concrete, pavers, decking, decomposed granite, sand, etc.\n\n` +
    `For each zone trace an approximate polygon outline using 4–8 vertices in normalized coordinates.\n` +
    `Zones should tile the full yard area with minimal gaps or overlaps.\n\n` +
    `Output ONLY a JSON array, no other text:\n` +
    `[{"material":"lawn|mulch|rock|gravel|concrete|pavers|decking|decomposed_granite|sand|other",` +
    `"label":"human-readable name","polygon":[[x1,y1],[x2,y2],...]}, ...]`;

  const { mimeType, base64 } = parseDataUrl(params.conceptImageDataUrl);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini material detection error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No material zones returned from Gemini');

  const parsed: MaterialZone[] = JSON.parse(match[0]);
  const VALID_MATERIALS = new Set<string>([
    'lawn','mulch','rock','gravel','concrete','pavers',
    'decking','decomposed_granite','sand','other',
  ]);

  return parsed
    .filter(z => Array.isArray(z.polygon) && z.polygon.length >= 3)
    .map(z => ({
      ...z,
      material: VALID_MATERIALS.has(z.material) ? z.material as MaterialType : 'other',
    }));
}

// ── Corner-anchored feature location ──────────────────────────────────────────

/**
 * Locates concept features in the image using a user-marked yard corner as a
 * spatial anchor. The corner pixel (image-normalized [x,y], top-left origin)
 * and its cardinal label (NE/NW/SE/SW) are known ground-truth reference points
 * that Gemini can use to calibrate feature positions.
 */
export async function locateFeatures(params: {
  conceptImageDataUrl: string;
  polygonRing: [number, number][];
  features: string[];
  anchorPixels?: ([number, number] | null)[] | null;
  anchorLabels?: (string | null)[] | null;
}): Promise<ConceptFeature[]> {
  const { polygonRing, features: featureKeys } = params;

  // ── Local feet coordinate system (SW = origin) ──────────────────────────
  const lngs  = polygonRing.map(p => p[0]);
  const lats   = polygonRing.map(p => p[1]);
  const minLng = Math.min(...lngs);
  const minLat = Math.min(...lats);
  const refLat = (minLat + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180) * 3.28084;
  const mpdLat = 110540 * 3.28084;
  const wFt    = Math.round((Math.max(...lngs) - minLng) * mpdLng);
  const hFt    = Math.round((Math.max(...lats) - minLat) * mpdLat);

  // ── Anchor reference points ──────────────────────────────────────────────
  // Image coords and Gemini both use (0,0)=top-left — no flip needed.
  let cornerNote = '';
  const anchorPts  = params.anchorPixels ?? [];
  const anchorLbls = params.anchorLabels ?? [];
  const valid = anchorPts
    .map((pt, i) => ({ pt, label: anchorLbls[i] }))
    .filter(a => a.pt && a.label);
  if (valid.length >= 2) {
    const lines = valid.map(({ pt, label }, i) => {
      const gx = pt![0].toFixed(2);
      const gy = pt![1].toFixed(2);
      return `  Point ${i + 1}: the ${label} corner is at (${gx}, ${gy})`;
    });
    cornerNote =
      `SPATIAL ANCHORS (confirmed ground-truth — use to calibrate all positions):\n` +
      lines.join('\n') + '\n\n';
  } else if (valid.length === 1) {
    const { pt, label } = valid[0];
    const gx = pt![0].toFixed(2);
    const gy = pt![1].toFixed(2);
    cornerNote =
      `SPATIAL ANCHOR (confirmed ground-truth):\n` +
      `The ${label} corner of the project area appears at normalized position (${gx}, ${gy}) in this image.\n\n`;
  }

  // Clean display names for each user-requested feature key
  const FEATURE_DISPLAY_NAMES: Record<string, string> = {
    walkway: 'Walkway',
    seating: 'Seating Area',
    dining:  'Dining Area',
    cooking: 'Outdoor Kitchen',
    water:   'Water Feature',
    garden:  'Vegetable Garden',
    storage: 'Storage Shed',
    trees:   'Shade Trees',
  };

  // User-requested features (include walkways; exclude mulch/lawn since that's the default)
  const userFeatures = featureKeys
    .filter(f => FEATURE_DISPLAY_NAMES[f])
    .map(f => FEATURE_DISPLAY_NAMES[f]);

  // Always detect these regardless of user preferences
  const alwaysDetect: string[] = [];
  if (!featureKeys.includes('walkway')) alwaysDetect.push('Walkway');
  alwaysDetect.push('Open Lawn');
  alwaysDetect.push('Rock Garden');

  const allFeatures = [...userFeatures, ...alwaysDetect];

  const featureLines = allFeatures
    .map(name => `  - "${name}"`)
    .join('\n');

  const prompt =
    `You are a landscape design analyst. Examine this landscape concept image.\n\n` +
    `PROJECT AREA: ${wFt} ft wide × ${hFt} ft deep.\n` +
    `Coordinate system: (0,0) = top-left corner of the image, (1,1) = bottom-right corner.\n\n` +
    cornerNote +
    `Identify the following features ONLY if they appear INSIDE the defined project area boundary.\n` +
    `Use EXACTLY the names listed below — do not rename or describe differently:\n` +
    featureLines + '\n\n' +
    `Rules:\n` +
    `- Only include a feature if it is clearly visible inside the project area\n` +
    `- Skip "Rock Garden" if no rock garden is visible\n` +
    `- Do NOT return mulch, planting beds, or groundcover — these are the default background\n` +
    `- Use the exact feature_name strings listed above\n\n` +
    `Output ONLY a JSON array. Normalized coords: (0,0) = top-left, (1,1) = bottom-right.\n` +
    `For each feature also output:\n` +
    `  "shape": one of "circle", "rectangle", "rounded_rectangle", "square"\n` +
    `  "bearing": clockwise degrees from North (0=N, 90=E, 180=S, 270=W) for the long axis orientation. Use 0 for circles/squares.\n` +
    `The "area_sq_ft" field is ignored — output 0 for it.\n` +
    `Format: [{"feature_name": "...", "relative_position": [x, y], "area_sq_ft": 0, "shape": "...", "bearing": N}, ...]`;

  const { mimeType, base64 } = parseDataUrl(params.conceptImageDataUrl);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const textContent: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text)
    .map((p: any) => p.text)
    .join('') ?? '';

  const jsonMatch = textContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No feature placements returned from Gemini');

  const parsed: ConceptFeature[] = JSON.parse(jsonMatch[0]);
  const VALID_SHAPES = new Set<FeatureShape>(['circle', 'rectangle', 'rounded_rectangle', 'square']);

  const withDefaults = parsed.map(f => ({
    ...f,
    area_sq_ft: resolveDefaultSqFt(f.feature_name),
    shape:   VALID_SHAPES.has(f.shape) ? f.shape : resolveDefaultShape(f.feature_name),
    bearing: (typeof f.bearing === 'number' && isFinite(f.bearing))
               ? ((f.bearing % 360) + 360) % 360
               : 0,
  }));

  return resolveOverlaps(withDefaults, [], wFt, hFt);
}

// ── Linear algebra helpers ────────────────────────────────────────────────────

/** Gaussian elimination with partial pivoting. Solves Ax = b in-place. */
function gaussianElim(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]); // augmented [A|b]

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
    }
  }

  // Back-substitute
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    x[row] = M[row][n];
    for (let k = row + 1; k < n; k++) x[row] -= M[row][k] * x[k];
    x[row] /= M[row][row];
  }
  return x;
}

/**
 * Computes a projective homography from ≥4 point correspondences using the
 * Direct Linear Transform (DLT).
 *
 * For exactly 4 pairs: solves the 8×8 exact system.
 * For N>4 pairs: uses normal equations (AᵀA·h = Aᵀb) for a least-squares fit,
 * which reduces the influence of any single noisy correspondence.
 *
 * Returns a function that maps (mx, my) → (px, py) in normalized image coords.
 */
function computeHomographyDLT(
  meterPts: [number, number][],
  pixelPts: [number, number][],
): ((mx: number, my: number) => [number, number]) | null {
  const n = meterPts.length;
  if (n < 4) return null;

  // Build 2n×8 matrix rows: A·h ≈ b
  const rows: number[][] = [];
  const bvec: number[] = [];
  for (let i = 0; i < n; i++) {
    const [mx, my] = meterPts[i];
    const [px, py] = pixelPts[i];
    rows.push([mx, my, 1,  0,  0, 0, -px * mx, -px * my]);  bvec.push(px);
    rows.push([ 0,  0, 0, mx, my, 1, -py * mx, -py * my]);  bvec.push(py);
  }

  let h: number[] | null;

  if (n === 4) {
    // Exact square system
    h = gaussianElim(rows, bvec);
  } else {
    // Overdetermined: normal equations  (AᵀA)·h = Aᵀb  →  8×8 system
    const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb: number[]   = new Array(8).fill(0);
    for (let k = 0; k < rows.length; k++) {
      for (let i = 0; i < 8; i++) {
        Atb[i] += rows[k][i] * bvec[k];
        for (let j = 0; j < 8; j++) {
          AtA[i][j] += rows[k][i] * rows[k][j];
        }
      }
    }
    h = gaussianElim(AtA, Atb);
  }

  if (!h) return null;

  return (mx: number, my: number): [number, number] => {
    const w = h![6] * mx + h![7] * my + 1;
    if (Math.abs(w) < 1e-12) return [0, 0];
    return [(h![0] * mx + h![1] * my + h![2]) / w, (h![3] * mx + h![4] * my + h![5]) / w];
  };
}

/**
 * Physical camera model: level camera at fixed height, solving for camera
 * ground position (ce, cn), azimuth (θ) and tilt (α) via Newton-Raphson.
 *
 * Supports mixed-height correspondences: ground-contact points (height=0) and
 * roofline points (height=buildingHeight) are handled by computing each anchor's
 * effective camera-to-point vertical distance: hEff = camHeight − point.height.
 * This means roofline pairs directly constrain camera tilt (α), eliminating the
 * "ground plane drift" that occurs when only ground points are available.
 *
 * Projection equations for each anchor (hEff = camHeight − point.height):
 *   r  = cos(θ)·dx − sin(θ)·dy
 *   q  = sin(θ)·dx + cos(θ)·dy
 *   D  = cos(α)·q + sin(α)·hEff
 *   Nb = cos(α)·hEff − sin(α)·q
 *   u  = fn·r/D + 0.5,  v = (fn/A)·Nb/D + 0.5
 *
 * Returns null when the solver doesn't converge (residual > 0.05).
 */
function buildCameraGroundTransform(
  pairs: Array<{ geo: [number, number]; px: [number, number]; height?: number }>,
  toGeoEN: (geo: [number, number]) => [number, number],
  aspectRatio: number,
  camHeight = 1.6,
  focalNorm = 0.82,
): ((pt: [number, number]) => [number, number]) | null {
  const fn = focalNorm, A = aspectRatio;

  const anchors = pairs.map(p => {
    const [e, n] = toGeoEN(p.geo);
    return {
      e, n,
      U: p.px[0] - 0.5,
      V: p.px[1] - 0.5,
      hEff: camHeight - (p.height ?? 0),  // camera→point vertical distance
    };
  });

  // terms() is parameterised by hEff so ground and roof pairs use different depths
  const terms = (
    e: number, n: number, hEff: number,
    ce: number, cn: number, theta: number, alpha: number,
  ) => {
    const dx = e - ce, dy = n - cn;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const r  = ct * dx - st * dy;
    const q  = st * dx + ct * dy;
    const D  = ca * q + sa * hEff;
    const Nb = ca * hEff - sa * q;
    return { r, q, D, Nb, ct, st, ca, sa };
  };

  const F = (ce: number, cn: number, theta: number, alpha: number): number[] => {
    const res: number[] = [];
    for (const { e, n, U, V, hEff } of anchors) {
      const { r, D, Nb } = terms(e, n, hEff, ce, cn, theta, alpha);
      if (Math.abs(D) < 1e-6) { res.push(1e6, 1e6); continue; }
      res.push(fn * r / D - U, (fn / A) * Nb / D - V);
    }
    return res;
  };

  const J = (ce: number, cn: number, theta: number, alpha: number): number[][] => {
    const rows: number[][] = [];
    for (const { e, n, hEff } of anchors) {
      const { r, q, D, Nb, ct, st, ca } = terms(e, n, hEff, ce, cn, theta, alpha);
      const D2 = D * D;
      if (D2 < 1e-12) { rows.push([0, 0, 0, 0], [0, 0, 0, 0]); continue; }
      // ∂u/∂[ce, cn, θ, α] — identical in form to ground-only; hEff absorbed in D, Nb
      rows.push([
        fn * (-ct * D + r * ca * st) / D2,
        fn * ( st * D + r * ca * ct) / D2,
        fn * (-q  * D - ca * r * r ) / D2,
        -fn * r * Nb / D2,
      ]);
      // ∂v/∂[ce, cn, θ, α] — note ∂v/∂ce = (fn/A)·st·hEff/D² (proved via sa·D + ca·Nb = hEff)
      rows.push([
        (fn / A) *  st * hEff / D2,
        (fn / A) *  ct * hEff / D2,
        -(fn / A) * r  * hEff / D2,
        -(fn / A) * (D2 + Nb * Nb) / D2,
      ]);
    }
    return rows;
  };

  const residualNorm = (ce: number, cn: number, theta: number, alpha: number): number => {
    const f = F(ce, cn, theta, alpha);
    return Math.sqrt(f.reduce((s, x) => s + x * x, 0));
  };

  // Grid search starting points: 8 azimuths × 4 tilts
  const ceCentroid = anchors.reduce((s, a) => s + a.e, 0) / anchors.length;
  const cnCentroid = anchors.reduce((s, a) => s + a.n, 0) / anchors.length;

  let bestRes = Infinity;
  let bestParams: [number, number, number, number] | null = null;

  for (let ti = 0; ti < 8; ti++) {
    const theta0 = ti * Math.PI / 4;
    for (let ai = 0; ai < 4; ai++) {
      const alpha0 = (15 + ai * 10) * Math.PI / 180;
      let ce = ceCentroid, cn = cnCentroid, theta = theta0, alpha = alpha0;

      for (let iter = 0; iter < 40; iter++) {
        const f   = F(ce, cn, theta, alpha);
        const jac = J(ce, cn, theta, alpha);
        const sol = gaussianElim(jac, f.map(x => -x));
        if (!sol) break;
        ce    += sol[0];
        cn    += sol[1];
        theta += sol[2];
        alpha  = Math.max(0.05, Math.min(1.4, alpha + sol[3]));
      }

      const res = residualNorm(ce, cn, theta, alpha);
      if (res < bestRes) {
        bestRes = res;
        bestParams = [ce, cn, theta, alpha];
      }
    }
  }

  if (!bestParams || bestRes > 0.05) return null;

  const [ce, cn, theta, alpha] = bestParams;
  // Return function always projects ground-plane points (hEff = camHeight, point.height = 0)
  return ([lng, lat]: [number, number]): [number, number] => {
    const [e, n] = toGeoEN([lng, lat]);
    const { r, D, Nb } = terms(e, n, camHeight, ce, cn, theta, alpha);
    if (Math.abs(D) < 1e-6) return [0.5, 0.5];
    return [fn * r / D + 0.5, (fn / A) * Nb / D + 0.5];
  };
}

/**
 * Projects the aerial polygon onto photo-image space using the user-confirmed
 * anchor correspondences (image pixel ↔ polygon corner).
 *
 * With 4 anchors (all four corners marked): computes an exact projective
 * homography — correctly handles perspective foreshortening of the ground plane.
 *
 * With 2 anchors + aspectRatio: uses the physical camera model (level camera,
 * fixed height, Newton-Raphson) — correctly models ground-plane perspective.
 *
 * Falls back to a similarity transform (scale + rotation) when camera model
 * is unavailable or fails to converge.
 *
 * All coordinates use the image convention: x = right (+east), y = down (+south).
 *
 * Exported so React components can project the polygon for SVG previews.
 */
export function buildGeoToImageTransform(
  polygonRing: [number, number][],
  anchorPixels: ([number, number] | null)[],
  anchorLabels: (string | null)[],
  aspectRatio?: number,
  extraPairs?: Array<{ geo: [number, number]; px: [number, number]; height?: number }>,
): ((pt: [number, number]) => [number, number]) | null {
  // ── Find which polygon vertex each anchor label refers to ────────────────────
  const dirScore = ([lng, lat]: [number, number], label: string): number => {
    if (label === 'NE') return  lng + lat;
    if (label === 'NW') return -lng + lat;
    if (label === 'SE') return  lng - lat;
    if (label === 'SW') return -lng - lat;
    return 0;
  };
  const labelToGeo = (label: string): [number, number] =>
    polygonRing.reduce((best, pt) =>
      dirScore(pt, label) > dirScore(best, label) ? pt : best
    );

  const pairs: Array<{ geo: [number, number]; px: [number, number] }> = [];
  for (let i = 0; i < anchorPixels.length && i < anchorLabels.length; i++) {
    const pt = anchorPixels[i];
    const label = anchorLabels[i];
    if (pt && label) pairs.push({ geo: labelToGeo(label), px: pt });
  }
  // Merge house-corner pairs (from Gemini ground-contact extraction) — these
  // often dominate the homography because they span the house footprint precisely.
  if (extraPairs?.length) pairs.push(...extraPairs);
  if (pairs.length < 2) return null;

  // ── Meter coordinate systems ──────────────────────────────────────────────────
  const lngs  = polygonRing.map(p => p[0]);
  const lats   = polygonRing.map(p => p[1]);
  const refLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180);
  const mpdLat = 110540;
  const swLng  = Math.min(...lngs);
  const maxLat = Math.max(...lats);
  const refLng = swLng;
  const refLatVal = Math.min(...lats);

  // Image convention: x = east (+right), y = south (+down)
  const toLocalM = ([lng, lat]: [number, number]): [number, number] => [
    (lng    - swLng) * mpdLng,
    (maxLat - lat)   * mpdLat,
  ];

  // Standard geo convention: x = east (+right), y = north (+up) — for camera model
  const toGeoEN = ([lng, lat]: [number, number]): [number, number] => [
    (lng - refLng)    * mpdLng,
    (lat - refLatVal) * mpdLat,
  ];

  // DLT requires all points on the same ground plane — exclude elevated (roof) pairs
  const groundPairs = pairs.filter(p => !(p as any).height || (p as any).height < 0.5);
  const groundMeterPts = groundPairs.map(p => toLocalM(p.geo));
  const groundPixelPts = groundPairs.map(p => p.px);

  // ── 4-point homography (ground-plane, perspective-correct) ───────────────────
  if (groundPairs.length >= 4) {
    const hom = computeHomographyDLT(groundMeterPts, groundPixelPts);
    if (hom) {
      return ([lng, lat]: [number, number]): [number, number] => {
        const [mx, my] = toLocalM([lng, lat]);
        return hom(mx, my);
      };
    }
  }

  // ── Physical camera model — uses ALL pairs including elevated roof points ────
  // Roof correspondences constrain camera tilt more precisely than ground-only.
  if (pairs.length >= 2 && aspectRatio != null && aspectRatio > 0) {
    const camTransform = buildCameraGroundTransform(pairs, toGeoEN, aspectRatio);
    if (camTransform) return camTransform;
  }

  // ── 2-point similarity fallback (scale + rotation, no perspective) ───────────
  const [px1, py1] = pairs[0].px;
  const [px2, py2] = pairs[1].px;
  const [m1x, m1y] = toLocalM(pairs[0].geo);
  const [m2x, m2y] = toLocalM(pairs[1].geo);
  const dmx = m2x - m1x, dmy = m2y - m1y;
  const dpx = px2 - px1, dpy = py2 - py1;
  const dm2 = dmx * dmx + dmy * dmy;
  if (dm2 < 1e-8) return null;
  const a = (dpx * dmx + dpy * dmy) / dm2;
  const b = (dpy * dmx - dpx * dmy) / dm2;
  const tx = px1 - (a * m1x - b * m1y);
  const ty = py1 - (b * m1x + a * m1y);
  return ([lng, lat]: [number, number]): [number, number] => {
    const [mx, my] = toLocalM([lng, lat]);
    return [a * mx - b * my + tx, b * mx + a * my + ty];
  };
}

/**
 * Numerical inverse of buildGeoToImageTransform.
 *
 * Given an image-space point (px, py) ∈ [0,1]² — where (0,0) = top-left and
 * (1,1) = bottom-right — returns the geographic [lng, lat] that the forward
 * transform maps to that point.
 *
 * Uses Newton-Raphson with a numerical Jacobian. Falls back gracefully when the
 * iteration doesn't converge (returns null for that point).
 *
 * Seeded from the bounding-box linear inverse so it converges in very few steps
 * for all supported transform types (similarity, camera model, DLT homography).
 */
export function buildImageToGeoTransform(
  polygonRing: [number, number][],
  anchorPixels: ([number, number] | null)[],
  anchorLabels: (string | null)[],
  aspectRatio?: number,
  extraPairs?: Array<{ geo: [number, number]; px: [number, number]; height?: number }>,
): ((px: number, py: number) => [number, number] | null) | null {
  const forward = buildGeoToImageTransform(polygonRing, anchorPixels, anchorLabels, aspectRatio, extraPairs);
  if (!forward) return null;

  const lngs = polygonRing.map(p => p[0]);
  const lats  = polygonRing.map(p => p[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  const EPS = 1e-7; // ~1 cm in degrees

  return (px: number, py: number): [number, number] | null => {
    // Seed: bounding-box linear inverse (image y↓ maps to lat↑)
    let lng = minLng + px * (maxLng - minLng);
    let lat = maxLat - py * (maxLat - minLat);

    for (let iter = 0; iter < 50; iter++) {
      const [fx, fy] = forward([lng, lat]);
      const rx = px - fx, ry = py - fy;
      if (Math.abs(rx) < 1e-5 && Math.abs(ry) < 1e-5) break;

      // Numerical Jacobian via forward differences
      const [fxdl, fydl] = forward([lng + EPS, lat]);
      const [fxda, fyda] = forward([lng, lat + EPS]);
      const J00 = (fxdl - fx) / EPS, J01 = (fxda - fx) / EPS;
      const J10 = (fydl - fy) / EPS, J11 = (fyda - fy) / EPS;

      const det = J00 * J11 - J01 * J10;
      if (Math.abs(det) < 1e-20) break;

      lng += ( J11 * rx - J01 * ry) / det;
      lat += (-J10 * rx + J00 * ry) / det;
    }

    const [fx, fy] = forward([lng, lat]);
    if (Math.abs(px - fx) > 0.02 || Math.abs(py - fy) > 0.02) return null;
    return [lng, lat];
  };
}

/**
 * Asks Gemini to identify BOTH the house ground-contact polygon AND the
 * roofline polygon, then matches each detected vertex back to its corresponding
 * Mapbox building footprint corner using nearest-neighbour search against the
 * rough 2-anchor similarity transform.
 *
 * Returns a combined array of geo→pixel pairs:
 *   - Ground pairs (height = undefined / 0): used for DLT homography
 *   - Roof pairs (height = buildingHeight): passed to the camera model so
 *     the known vertical extent constrains camera tilt precisely — the "3D
 *     wireframe" effect that eliminates ground-plane drift.
 */
export async function extractHousePixelAnchors(params: {
  photoDataUrl: string;
  houseFootprint: { coordinates: [number, number][][]; height?: number };
  polygonRing: [number, number][];
  anchorPixels: ([number, number] | null)[];
  anchorLabels: (string | null)[];
}): Promise<HousePixelAnchors | null> {
  const { houseFootprint, polygonRing, anchorPixels, anchorLabels } = params;
  const buildingHeight = houseFootprint.height ?? 7; // default ~2-storey if unknown

  const roughProject = buildGeoToImageTransform(polygonRing, anchorPixels, anchorLabels);
  if (!roughProject) return null;

  const houseRing = houseFootprint.coordinates[0] as [number, number][];
  const projectedCorners = houseRing.map(geo => ({
    geo: geo as [number, number],
    approxPx: roughProject(geo as [number, number]),
  }));

  // ── Ask Gemini for both ground and roof polygons in one call ────────────────
  const prompt =
    `You are analyzing a photo of a residential house.\n\n` +
    `Return a JSON object with exactly two keys (no other text):\n\n` +
    `{\n` +
    `  "ground_contact": [[x1,y1],[x2,y2],...],\n` +
    `  "roof_perimeter": [[x1,y1],[x2,y2],...]\n` +
    `}\n\n` +
    `"ground_contact": the polygon where the exterior house walls meet the ground/lawn.\n` +
    `"roof_perimeter": the outer edge of the roofline (ridge / fascia / eave outline).\n\n` +
    `Rules for both polygons:\n` +
    `- Normalized coords: (0,0) = top-left, (1,1) = bottom-right\n` +
    `- 4–8 vertices, ordered clockwise from the front-left corner\n` +
    `- Match vertex order: ground_contact[i] and roof_perimeter[i] must be the same house corner\n` +
    `- Estimate occluded corners from house geometry/symmetry\n` +
    `- ground_contact: only where exterior walls meet bare ground (exclude steps/planters)\n` +
    `- roof_perimeter: outer roofline edge only (exclude chimneys, vents, dormers)`;

  const { mimeType, base64 } = parseDataUrl(params.photoDataUrl);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  // Parse the JSON object (may be wrapped in markdown code fences)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;

  let parsed: { ground_contact?: unknown; roof_perimeter?: unknown };
  try { parsed = JSON.parse(objMatch[0]); } catch { return null; }

  const normalisePts = (raw: unknown): [number, number][] =>
    Array.isArray(raw)
      ? (raw as any[])
          .map((item: any) => Array.isArray(item) ? item : [item.x, item.y])
          .filter((item: any) => typeof item[0] === 'number' && typeof item[1] === 'number')
          .map((item: any) => [item[0], item[1]] as [number, number])
      : [];

  const groundPts = normalisePts(parsed.ground_contact);
  const roofPts   = normalisePts(parsed.roof_perimeter);

  // ── Match detected pixels → nearest unmatched Mapbox corner ────────────────
  const matchToCorners = (
    pts: [number, number][],
    height: number | undefined,
  ): Array<{ geo: [number, number]; px: [number, number]; height?: number }> => {
    const used = new Set<number>();
    const result: Array<{ geo: [number, number]; px: [number, number]; height?: number }> = [];
    for (const [dpx, dpy] of pts) {
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < projectedCorners.length; i++) {
        if (used.has(i)) continue;
        const [ax, ay] = projectedCorners[i].approxPx;
        const dist = Math.hypot(ax - dpx, ay - dpy);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestDist < 0.25) {
        used.add(bestIdx);
        const entry: { geo: [number, number]; px: [number, number]; height?: number } =
          { geo: projectedCorners[bestIdx].geo, px: [dpx, dpy] };
        if (height !== undefined) entry.height = height;
        result.push(entry);
      }
    }
    return result;
  };

  const groundPairs = groundPts.length >= 3 ? matchToCorners(groundPts, undefined) : [];
  // Roof pairs share the same geo corners but carry the building height
  const roofPairs   = roofPts.length   >= 3 ? matchToCorners(roofPts,   buildingHeight) : [];

  const all = [...groundPairs, ...roofPairs];
  if (all.length < 2) return null;
  return { pairs: all, groundPixels: groundPts, roofPixels: roofPts };
}

export interface HousePixelAnchors {
  /** Geo→pixel pairs (ground + roof) for buildGeoToImageTransform extraPairs. */
  pairs: Array<{ geo: [number, number]; px: [number, number]; height?: number }>;
  /** Raw Gemini-detected ground-contact polygon vertices (normalized 0–1, top-left origin). */
  groundPixels: [number, number][];
  /** Raw Gemini-detected roof-perimeter polygon vertices (normalized 0–1, top-left origin). */
  roofPixels: [number, number][];
}

/**
 * Back-projects a Gemini concept image onto the Mapbox coordinate system.
 *
 * Pipeline:
 *   1. Re-detects the house ground-contact + roofline in the concept image
 *      (separate from the original photo) to build a concept-image-specific
 *      homography. This accounts for any perspective shift Gemini introduced.
 *   2. Segments the concept image into material zones via detectMaterialZones.
 *   3. Projects each zone polygon from SW-origin image space → geo coordinates
 *      using the calibrated inverse transform.
 *   4. Clips each polygon to the property boundary.
 *   5. Subtracts the house footprint from each zone.
 *
 * Returns a GeoJSON FeatureCollection ready for Mapbox Source/Layer rendering.
 * Each feature has properties: { material, label, color }.
 */
export async function projectConceptToMap(params: {
  conceptImageDataUrl: string;
  polygonRing: [number, number][];
  anchorPixels: ([number, number] | null)[];
  anchorLabels: (string | null)[];
  houseFootprint?: { coordinates: [number, number][][]; height?: number } | null;
  aspectRatio?: number;
}): Promise<GeoJSON.FeatureCollection> {
  const { conceptImageDataUrl, polygonRing, anchorPixels, anchorLabels,
          houseFootprint, aspectRatio } = params;

  // ── Step 1: Re-detect house in concept image for fresh calibration ─────────
  // Running extractHousePixelAnchors against the concept image (not the original
  // photo) gives geo→pixel pairs calibrated to Gemini's rendered output.
  let extraPairs: Array<{ geo: [number, number]; px: [number, number]; height?: number }> = [];
  if (houseFootprint?.coordinates?.[0]?.length >= 3 && anchorPixels.some(p => p !== null)) {
    try {
      const houseAnchors = await extractHousePixelAnchors({
        photoDataUrl:   conceptImageDataUrl,
        houseFootprint,
        polygonRing,
        anchorPixels,
        anchorLabels,
      });
      if (houseAnchors) extraPairs = houseAnchors.pairs;
    } catch { /* fall back to user-only anchors */ }
  }

  // ── Step 2: Build calibrated image→geo inverse transform ──────────────────
  const inverseTransform = buildImageToGeoTransform(
    polygonRing, anchorPixels, anchorLabels, aspectRatio,
    extraPairs.length > 0 ? extraPairs : undefined,
  );

  const lngs  = polygonRing.map(p => p[0]);
  const lats   = polygonRing.map(p => p[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  // detectMaterialZones uses SW-origin (y=0=south, y=1=north).
  // buildImageToGeoTransform uses image-origin (y=0=top, y=1=bottom).
  // Convert: imageY = 1 − swY.
  // Parallax note (per spec): only ground-level pixels are used — the SW-origin
  // coordinate system from detectMaterialZones already describes ground coverage.
  const swToGeo = (swX: number, swY: number): [number, number] =>
    inverseTransform?.(swX, 1 - swY)
    ?? [minLng + swX * (maxLng - minLng), minLat + swY * (maxLat - minLat)];

  // ── Step 3: Segment concept image into material zones ─────────────────────
  const zones = await detectMaterialZones({ conceptImageDataUrl, polygonRing });

  // ── Step 4: Build clipping geometry ──────────────────────────────────────
  const boundaryRing: [number, number][] = [...polygonRing];
  if (boundaryRing[0][0] !== boundaryRing[boundaryRing.length - 1][0] ||
      boundaryRing[0][1] !== boundaryRing[boundaryRing.length - 1][1]) {
    boundaryRing.push(boundaryRing[0]);
  }
  const boundaryPoly = turf.polygon([boundaryRing]);

  let housePoly: GeoJSON.Feature<GeoJSON.Polygon> | null = null;
  if (houseFootprint?.coordinates?.[0]?.length >= 3) {
    const hRing = [...houseFootprint.coordinates[0]] as [number, number][];
    if (hRing[0][0] !== hRing[hRing.length - 1][0] ||
        hRing[0][1] !== hRing[hRing.length - 1][1]) hRing.push(hRing[0]);
    try { housePoly = turf.polygon([hRing]); } catch {}
  }

  // ── Step 5: Project, clip, and de-house each zone ─────────────────────────
  const features: GeoJSON.Feature[] = [];

  for (const zone of zones) {
    const geoRing: [number, number][] = zone.polygon.map(([sx, sy]) => swToGeo(sx, sy));
    if (geoRing.length < 3) continue;
    geoRing.push(geoRing[0]); // close the ring

    let zoneFeat: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    try { zoneFeat = turf.polygon([geoRing]); } catch { continue; }

    // Clip to property boundary
    try {
      const clipped = turf.intersect(
        zoneFeat as GeoJSON.Feature<GeoJSON.Polygon>, boundaryPoly,
      );
      if (clipped) zoneFeat = clipped;
      else continue;
    } catch { continue; }

    // Subtract house footprint
    if (housePoly) {
      if (zoneFeat.geometry.type === 'Polygon') {
        try {
          const diffed = turf.difference(
            zoneFeat as GeoJSON.Feature<GeoJSON.Polygon>, housePoly,
          );
          if (!diffed) continue;
          zoneFeat = diffed;
        } catch {}
      } else {
        // MultiPolygon — difference each sub-polygon individually
        const subFeatures: GeoJSON.Feature[] = [];
        for (const coords of (zoneFeat.geometry as GeoJSON.MultiPolygon).coordinates) {
          try {
            const sub     = turf.polygon(coords as [number, number][][]);
            const diffed  = turf.difference(sub, housePoly!);
            if (diffed) subFeatures.push({
              ...diffed,
              properties: { material: zone.material, label: zone.label,
                            color: MATERIAL_COLORS[zone.material] ?? MATERIAL_COLORS.other },
            });
          } catch {}
        }
        features.push(...subFeatures);
        continue;
      }
    }

    features.push({
      ...zoneFeat,
      properties: {
        material: zone.material,
        label:    zone.label,
        color:    MATERIAL_COLORS[zone.material] ?? MATERIAL_COLORS.other,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// ── Dual-grid zone extraction ─────────────────────────────────────────────────
//
// Strategy: generate two versions of a shared [gx, gy] coordinate grid.
//   • Perspective grid  → painted on the concept image (warped by the camera)
//   • Flat grid         → painted on the aerial map capture (top-down, undistorted)
// Both grids label the same physical point with the same [gx, gy] coordinate.
// Gemini reads polygons off the concept image using the perspective grid and
// returns them in grid units.  Converting back to geo is trivial:
//   lng = SW_lng + gx * GRID_M / mpdLng
//   lat = SW_lat + gy * GRID_M / mpdLat
// No inverse-homography or Newton-Raphson needed.

const GRID_FT = 5; // feet per grid square

interface GridDims {
  minLng: number; minLat: number;
  mpdLng: number; mpdLat: number;
  GRID_M: number;
  nCols: number; nRows: number;
}

function computeGridDims(polygonRing: [number, number][]): GridDims {
  const lngs = polygonRing.map(p => p[0]);
  const lats  = polygonRing.map(p => p[1]);
  const refLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180);
  const mpdLat = 110540;
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const GRID_M = GRID_FT * 0.3048;
  const nCols = Math.ceil((maxLng - minLng) * mpdLng / GRID_M);
  const nRows = Math.ceil((maxLat - minLat) * mpdLat / GRID_M);
  return { minLng, minLat, mpdLng, mpdLat, GRID_M, nCols, nRows };
}

function gridToGeo(gx: number, gy: number, dims: GridDims): [number, number] {
  return [
    dims.minLng + (gx * dims.GRID_M) / dims.mpdLng,
    dims.minLat + (gy * dims.GRID_M) / dims.mpdLat,
  ];
}

function geoToGrid(lng: number, lat: number, dims: GridDims): [number, number] {
  return [
    ((lng - dims.minLng) * dims.mpdLng) / dims.GRID_M,
    ((lat - dims.minLat) * dims.mpdLat) / dims.GRID_M,
  ];
}

/**
 * Draws the perspective-warped coordinate grid onto the concept image.
 * Grid lines "lie flat on the ground" — they are projected via the same
 * geo→image homography used during annotation, so they correctly deform
 * with the camera perspective.  Each intersection is labelled [gx, gy]
 * so Gemini can read coordinates directly off the image.
 */
async function paintPerspectiveGridOnConcept(params: {
  conceptImageDataUrl: string;
  polygonRing: [number, number][];
  anchorPixels: ([number, number] | null)[];
  anchorLabels: (string | null)[];
  houseFootprint?: { coordinates: [number, number][][] } | null;
  extraPairs?: Array<{ geo: [number, number]; px: [number, number]; height?: number }>;
}): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      const { polygonRing, anchorPixels, anchorLabels, houseFootprint, extraPairs } = params;
      const project = buildGeoToImageTransform(
        polygonRing, anchorPixels, anchorLabels, W / H, extraPairs,
      );
      if (!project) { resolve(params.conceptImageDataUrl); return; }

      const proj = ([lng, lat]: [number, number]): [number, number] => {
        const [nx, ny] = project([lng, lat]);
        return [nx * W, ny * H];
      };

      const dims = computeGridDims(polygonRing);
      const { nCols, nRows } = dims;
      const gridPx = (gx: number, gy: number) => proj(gridToGeo(gx, gy, dims));

      // ── Grid lines ──────────────────────────────────────────────────────────
      const lw = Math.max(1, W * 0.0012);
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([lw * 4, lw * 2]);

      for (let gy = 0; gy <= nRows; gy++) {
        ctx.beginPath();
        for (let gx = 0; gx <= nCols; gx++) {
          const [px, py] = gridPx(gx, gy);
          gx === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      for (let gx = 0; gx <= nCols; gx++) {
        ctx.beginPath();
        for (let gy = 0; gy <= nRows; gy++) {
          const [px, py] = gridPx(gx, gy);
          gy === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // ── Coordinate labels (sparse — every ~⌈max/6⌉ squares) ────────────────
      const step = Math.max(1, Math.ceil(Math.max(nCols, nRows) / 6));
      const fs   = Math.max(9, W * 0.013);
      ctx.font = `bold ${fs}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let gx = 0; gx <= nCols; gx += step) {
        for (let gy = 0; gy <= nRows; gy += step) {
          const [px, py] = gridPx(gx, gy);
          if (px < 0 || px > W || py < 0 || py > H) continue;
          ctx.lineWidth   = fs * 0.18;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(`[${gx},${gy}]`, px, py);
          ctx.fillStyle   = 'rgba(255,255,255,0.95)';
          ctx.fillText(`[${gx},${gy}]`, px, py);
        }
      }

      // ── House footprint outline (amber) ─────────────────────────────────────
      if (houseFootprint?.coordinates?.[0]) {
        const verts = (houseFootprint.coordinates[0] as [number, number][]).map(proj);
        ctx.beginPath();
        verts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.strokeStyle = 'rgba(217,119,6,1)';
        ctx.lineWidth   = Math.max(2, W * 0.004);
        ctx.setLineDash([]);
        ctx.stroke();
      }

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(params.conceptImageDataUrl);
    img.src = params.conceptImageDataUrl;
  });
}

/**
 * Draws the flat top-down coordinate grid onto an aerial map image.
 * `geoToPixel` must be derived from the live Mapbox map's `project()` method
 * so the grid exactly matches the satellite tile projection.
 */
export async function paintFlatGridOnAerial(
  aerialImageDataUrl: string,
  polygonRing: [number, number][],
  geoToPixel: (lng: number, lat: number) => [number, number] | null,
  houseFootprint?: { coordinates: [number, number][][] } | null,
): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      const dims = computeGridDims(polygonRing);
      const { nCols, nRows } = dims;
      const gridPx = (gx: number, gy: number) =>
        geoToPixel(...gridToGeo(gx, gy, dims));

      // ── Grid lines ──────────────────────────────────────────────────────────
      const drawPolyLine = (pts: ([number, number] | null)[]) => {
        ctx.beginPath();
        let on = false;
        for (const pt of pts) {
          if (!pt) { on = false; continue; }
          on ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]);
          on = true;
        }
        ctx.stroke();
      };

      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);

      for (let gy = 0; gy <= nRows; gy++)
        drawPolyLine(Array.from({ length: nCols + 1 }, (_, gx) => gridPx(gx, gy)));
      for (let gx = 0; gx <= nCols; gx++)
        drawPolyLine(Array.from({ length: nRows + 1 }, (_, gy) => gridPx(gx, gy)));
      ctx.setLineDash([]);

      // ── Coordinate labels ───────────────────────────────────────────────────
      const step = Math.max(1, Math.ceil(Math.max(nCols, nRows) / 6));
      const fs   = Math.max(8, W * 0.012);
      ctx.font = `bold ${fs}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let gx = 0; gx <= nCols; gx += step) {
        for (let gy = 0; gy <= nRows; gy += step) {
          const pt = gridPx(gx, gy);
          if (!pt) continue;
          const [px, py] = pt;
          if (px < 5 || px > W - 5 || py < 5 || py > H - 5) continue;
          ctx.lineWidth   = fs * 0.18;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(`[${gx},${gy}]`, px, py);
          ctx.fillStyle   = 'rgba(255,255,255,0.95)';
          ctx.fillText(`[${gx},${gy}]`, px, py);
        }
      }

      // ── House footprint (amber fill + label) ────────────────────────────────
      if (houseFootprint?.coordinates?.[0]) {
        const verts = (houseFootprint.coordinates[0] as [number, number][])
          .map(([lng, lat]) => geoToPixel(lng, lat));
        if (verts.every(Boolean)) {
          const pts = verts as [number, number][];
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.closePath();
          ctx.fillStyle   = 'rgba(217,119,6,0.30)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(217,119,6,1)';
          ctx.lineWidth   = 2;
          ctx.stroke();
          const cx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
          const cy = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
          ctx.font      = `bold ${Math.max(10, W * 0.014)}px sans-serif`;
          ctx.fillStyle = 'rgba(217,119,6,1)';
          ctx.fillText('HOUSE', cx, cy);
        }
      }

      resolve(canvas.toDataURL('image/jpeg', 0.90));
    };
    img.onerror = () => resolve(aerialImageDataUrl);
    img.src = aerialImageDataUrl;
  });
}

const STYLE_GRID_HINTS: Record<string, string> = {
  natural_wild:
    'Trace organic, flowing curved outlines. Prefer rounded polygon vertices — curves matter more than right angles. Capture the drift of mulch beds into lawn areas.',
  modern_structured:
    'Use rigid rectangular polygons. Snap every vertex to exact grid intersections. Clean straight edges only — no curves.',
  traditional:
    'Map symmetrical planting beds as strips parallel to house walls. Note foundation beds by their distance (in grid squares) from the house.',
  desert_minimal:
    'Identify hydrozone clusters. Mark rock-garden area boundaries and gravel path perimeters. Group by water-use similarity.',
};

/** Paints projected hardscape zones (red) onto an already-annotated aerial image. */
async function paintHardscapesOnAerial(
  imageDataUrl: string,
  hardscapeGeoZones: Array<{ label: string; geoRing: [number, number][] }>,
  geoToPixel: (lng: number, lat: number) => [number, number] | null,
): Promise<string> {
  if (hardscapeGeoZones.length === 0) return imageDataUrl;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      for (const zone of hardscapeGeoZones) {
        const verts = zone.geoRing
          .map(([lng, lat]) => geoToPixel(lng, lat))
          .filter(Boolean) as [number, number][];
        if (verts.length < 3) continue;

        ctx.beginPath();
        verts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fillStyle   = 'rgba(220,38,38,0.40)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(220,38,38,1)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([]);
        ctx.stroke();

        const cx = verts.reduce((s, [x]) => s + x, 0) / verts.length;
        const cy = verts.reduce((s, [, y]) => s + y, 0) / verts.length;
        const fs = Math.max(9, W * 0.012);
        ctx.font          = `bold ${fs}px sans-serif`;
        ctx.textAlign     = 'center';
        ctx.textBaseline  = 'middle';
        ctx.strokeStyle   = 'white';
        ctx.lineWidth     = fs * 0.22;
        ctx.strokeText(zone.label, cx, cy);
        ctx.fillStyle     = 'rgba(220,38,38,1)';
        ctx.fillText(zone.label, cx, cy);
      }

      resolve(canvas.toDataURL('image/jpeg', 0.90));
    };
    img.onerror = () => resolve(imageDataUrl);
    img.src = imageDataUrl;
  });
}

/**
 * Dual-grid zone extraction pipeline.
 *
 * 1. Paints a perspective-warped coordinate grid on the concept image.
 * 2. Paints a flat top-down grid on the aerial map capture, plus projects any
 *    detected hardscape zones (driveways/walkways/patios) as red overlays so
 *    Gemini knows their exact grid positions.
 * 3. Sends BOTH images to Gemini; asks it to return zone polygons in [gx, gy]
 *    grid units (same coordinate space in both images).
 * 4. Converts grid units → geo coordinates (no inverse homography needed).
 * 5. Clips to property boundary and subtracts house footprint.
 *
 * @param geoToPixel  Derived from `mapRef.current.getMap().project([lng, lat])`.
 *                    Must reflect the current map viewport so grid labels align
 *                    with the captured aerial image.
 * @param hardscapeZones  Detected during concept generation (image-normalized,
 *                        top-left origin).  Projected to geo/grid here.
 * @param aspectRatio  Photo width/height — needed for the inverse transform that
 *                     converts hardscape image-space coords to geo.
 */
export async function dualGridExtractZones(params: {
  conceptImageDataUrl: string;
  aerialImageDataUrl: string;
  polygonRing: [number, number][];
  anchorPixels: ([number, number] | null)[];
  anchorLabels: (string | null)[];
  houseFootprint?: { coordinates: [number, number][][]; height?: number } | null;
  extraPairs?: Array<{ geo: [number, number]; px: [number, number]; height?: number }>;
  geoToPixel: (lng: number, lat: number) => [number, number] | null;
  style: string;
  hardscapeZones?: HardscapeZone[];
  aspectRatio?: number;
}): Promise<GeoJSON.FeatureCollection> {
  const {
    conceptImageDataUrl, aerialImageDataUrl, polygonRing,
    anchorPixels, anchorLabels, houseFootprint, extraPairs,
    geoToPixel, style,
  } = params;

  const dims = computeGridDims(polygonRing);
  const { nCols, nRows } = dims;

  // ── House footprint → grid constraint ──────────────────────────────────────
  let houseConstraint = '';
  if (houseFootprint?.coordinates?.[0]) {
    const hGrid = (houseFootprint.coordinates[0] as [number, number][])
      .map(([lng, lat]) => geoToGrid(lng, lat, dims));
    const minGx = Math.max(0, Math.floor(Math.min(...hGrid.map(p => p[0])) - 0.5));
    const maxGx = Math.min(nCols, Math.ceil(Math.max(...hGrid.map(p => p[0])) + 0.5));
    const minGy = Math.max(0, Math.floor(Math.min(...hGrid.map(p => p[1])) - 0.5));
    const maxGy = Math.min(nRows, Math.ceil(Math.max(...hGrid.map(p => p[1])) + 0.5));
    houseConstraint =
      `\nHOUSE FOOTPRINT: columns [${minGx}–${maxGx}], rows [${minGy}–${maxGy}] ` +
      `(shown in amber/orange on both images). Do NOT place any zone polygon inside this area.\n`;
  }

  // ── Hardscape zones: project from photo image-space → geo → grid ───────────
  // detectHardscapes returns polygons in the ORIGINAL PHOTO's normalized space
  // (0,0 = top-left).  We re-use buildImageToGeoTransform to recover geo coords,
  // then convert to [gx,gy] for the constraint note.
  type HardscapeGeoZone = { label: string; geoRing: [number, number][]; gridBbox: string };
  const hardscapeGeoZones: HardscapeGeoZone[] = [];

  if (params.hardscapeZones?.length && anchorPixels.some(p => p !== null)) {
    const imgToGeo = buildImageToGeoTransform(
      polygonRing, anchorPixels, anchorLabels, params.aspectRatio, extraPairs,
    );
    if (imgToGeo) {
      for (const zone of params.hardscapeZones) {
        const geoVerts = zone.polygon
          .map(([nx, ny]) => imgToGeo(nx, ny))
          .filter(Boolean) as [number, number][];
        if (geoVerts.length < 3) continue;

        const gridVerts = geoVerts.map(([lng, lat]) => geoToGrid(lng, lat, dims));
        const minGx = Math.max(0, Math.floor(Math.min(...gridVerts.map(p => p[0]))));
        const maxGx = Math.min(nCols, Math.ceil(Math.max(...gridVerts.map(p => p[0]))));
        const minGy = Math.max(0, Math.floor(Math.min(...gridVerts.map(p => p[1]))));
        const maxGy = Math.min(nRows, Math.ceil(Math.max(...gridVerts.map(p => p[1]))));

        hardscapeGeoZones.push({
          label:    zone.label,
          geoRing:  [...geoVerts, geoVerts[0]],
          gridBbox: `columns [${minGx}–${maxGx}], rows [${minGy}–${maxGy}]`,
        });
      }
    }
  }

  let hardscapeConstraint = '';
  if (hardscapeGeoZones.length > 0) {
    const lines = hardscapeGeoZones
      .map(z => `  - ${z.label}: ${z.gridBbox}`)
      .join('\n');
    hardscapeConstraint =
      `\nHARDSCAPE EXCLUSION ZONES (driveways / walkways / patios — shown in RED on Image 2):\n` +
      lines + '\n' +
      `Do NOT place any landscape zone polygon over these areas. ` +
      `Their grid positions are anchored and must remain empty of planted/mulched zones.\n`;
  }

  const styleHint = STYLE_GRID_HINTS[style] ?? STYLE_GRID_HINTS.traditional;

  // ── Paint grids on both images; add hardscapes on aerial ───────────────────
  const [gridConcept, rawGridAerial] = await Promise.all([
    paintPerspectiveGridOnConcept({
      conceptImageDataUrl, polygonRing, anchorPixels, anchorLabels,
      houseFootprint, extraPairs,
    }),
    paintFlatGridOnAerial(aerialImageDataUrl, polygonRing, geoToPixel, houseFootprint),
  ]);

  // Paint hardscape overlays on aerial AFTER the flat grid so they sit on top
  const gridAerial = hardscapeGeoZones.length > 0
    ? await paintHardscapesOnAerial(rawGridAerial, hardscapeGeoZones, geoToPixel)
    : rawGridAerial;

  const prompt =
    `You are analyzing two views of the same residential property.\n\n` +
    `IMAGE 1 — Design Concept with Perspective Grid:\n` +
    `A landscape design rendered from a ground-level perspective. The white grid lines appear warped due to camera perspective, but every coordinate [gx, gy] maps to the SAME physical location as the matching coordinate in Image 2.\n\n` +
    `IMAGE 2 — Aerial Map with Flat Grid:\n` +
    `Overhead satellite view of the same property. Grid is undistorted. ` +
    `SW corner = [0, 0], NE corner = [${nCols}, ${nRows}]. Each square = ${GRID_FT} ft.\n` +
    houseConstraint +
    hardscapeConstraint + '\n' +
    `TASK: Examine the Design Concept (Image 1). Identify every distinct landscape surface/material zone. ` +
    `For each zone trace its polygon boundary in GRID COORDINATES by cross-referencing both images.\n\n` +
    `Style guidance (${style}): ${styleHint}\n\n` +
    `BASE-ONLY RULE: For trees, shrubs, and structures, plot ONLY the trunk base or structural footprint — ` +
    `NOT the canopy shadow or foliage. This prevents parallax errors on the map.\n\n` +
    `Return ONLY a JSON array — no markdown fences, no explanation:\n` +
    `[\n` +
    `  {\n` +
    `    "feature_name": "descriptive name",\n` +
    `    "material": "lawn|mulch|rock|gravel|concrete|pavers|decking|decomposed_granite|sand|other",\n` +
    `    "label": "Short Label",\n` +
    `    "polygon": [[gx,gy], ...]\n` +
    `  }\n` +
    `]\n\n` +
    `Constraints:\n` +
    `- All [gx, gy] must be within [0, ${nCols}] × [0, ${nRows}].\n` +
    `- Minimum 4 vertices per polygon, maximum 14.\n` +
    `- Zones must collectively cover the full yard (excluding house footprint and hardscapes) with minimal gaps.\n` +
    `- No polygon may overlap the house footprint or any hardscape exclusion zone.\n`;

  const { mimeType: m1, base64: b1 } = parseDataUrl(gridConcept);
  const { mimeType: m2, base64: b2 } = parseDataUrl(gridAerial);

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: m1, data: b1 } },
          { inline_data: { mime_type: m2, data: b2 } },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini dual-grid error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { type: 'FeatureCollection', features: [] };

  let rawZones: { feature_name: string; material: string; label: string; polygon: [number, number][] }[];
  try { rawZones = JSON.parse(match[0]); }
  catch { return { type: 'FeatureCollection', features: [] }; }

  // Build clipping geometry
  const boundaryRing = [...polygonRing] as [number, number][];
  if (boundaryRing[0][0] !== boundaryRing[boundaryRing.length - 1][0] ||
      boundaryRing[0][1] !== boundaryRing[boundaryRing.length - 1][1]) {
    boundaryRing.push(boundaryRing[0]);
  }
  const boundaryPoly = turf.polygon([boundaryRing]);

  let housePoly: GeoJSON.Feature<GeoJSON.Polygon> | null = null;
  if (houseFootprint?.coordinates?.[0]?.length >= 3) {
    const hRing = [...houseFootprint.coordinates[0]] as [number, number][];
    if (hRing[0][0] !== hRing[hRing.length - 1][0] || hRing[0][1] !== hRing[hRing.length - 1][1])
      hRing.push(hRing[0]);
    try { housePoly = turf.polygon([hRing]); } catch {}
  }

  const VALID_MATS = new Set([
    'lawn', 'mulch', 'rock', 'gravel', 'concrete', 'pavers',
    'decking', 'decomposed_granite', 'sand', 'other',
  ]);

  const features: GeoJSON.Feature[] = [];

  for (const zone of rawZones) {
    if (!Array.isArray(zone.polygon) || zone.polygon.length < 3) continue;

    // Grid → geo
    const geoRing: [number, number][] = zone.polygon.map(([gx, gy]) => gridToGeo(gx, gy, dims));
    geoRing.push(geoRing[0]);

    let feat: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    try { feat = turf.polygon([geoRing]); } catch { continue; }

    // Clip to boundary
    try {
      const clipped = turf.intersect(feat as GeoJSON.Feature<GeoJSON.Polygon>, boundaryPoly);
      if (clipped) feat = clipped; else continue;
    } catch { continue; }

    const material = VALID_MATS.has(zone.material) ? zone.material : 'other';
    const props = {
      material,
      label: zone.label ?? zone.feature_name,
      color: MATERIAL_COLORS[material] ?? MATERIAL_COLORS.other,
    };

    // Subtract house
    if (housePoly) {
      if (feat.geometry.type === 'Polygon') {
        try {
          const diffed = turf.difference(feat as GeoJSON.Feature<GeoJSON.Polygon>, housePoly);
          if (!diffed) continue;
          feat = diffed;
        } catch {}
        features.push({ ...feat, properties: props });
      } else {
        // MultiPolygon after intersect — difference each sub-polygon individually
        for (const coords of (feat.geometry as GeoJSON.MultiPolygon).coordinates) {
          try {
            const sub    = turf.polygon(coords as [number, number][][]);
            const diffed = turf.difference(sub, housePoly);
            if (diffed) features.push({ ...diffed, properties: props });
          } catch {}
        }
      }
    } else {
      features.push({ ...feat, properties: props });
    }
  }

  return { type: 'FeatureCollection', features };
}

/** Paints red semi-transparent overlays for hardscape zones onto the photo. */
async function paintHardscapesOnPhoto(
  photoDataUrl: string,
  hardscapeZones: HardscapeZone[],
): Promise<string> {
  if (hardscapeZones.length === 0) return photoDataUrl;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      for (const zone of hardscapeZones) {
        const verts = zone.polygon.map(([x, y]) => [x * W, y * H] as [number, number]);

        // Filled region — more opaque so Gemini clearly registers it
        ctx.beginPath();
        verts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(220, 38, 38, 0.55)';
        ctx.fill();

        // Bold solid stroke
        ctx.beginPath();
        verts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
        ctx.closePath();
        ctx.strokeStyle = 'rgba(220, 38, 38, 1.0)';
        ctx.lineWidth = Math.max(3, W * 0.005);
        ctx.setLineDash([]);
        ctx.stroke();

        // Label in the centroid of the zone
        const cx = verts.reduce((s, [px]) => s + px, 0) / verts.length;
        const cy = verts.reduce((s, [, py]) => s + py, 0) / verts.length;
        const fontSize = Math.max(14, Math.round(W * 0.018));
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'rgba(180, 0, 0, 0.9)';
        ctx.lineWidth = Math.max(2, fontSize * 0.12);
        ctx.strokeText('NO PLANT', cx, cy);
        ctx.fillText('NO PLANT', cx, cy);
      }
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(photoDataUrl);
    img.src = photoDataUrl;
  });
}

/**
 * Builds a spatial reference image for Gemini with three annotation layers:
 *
 *   1. Original photo as background (unmodified).
 *   2. House footprint — semi-transparent amber fill + solid amber border.
 *      Gemini treats this as the "house foundation": no planting inside.
 *   3. Project boundary — thin dashed green line. No darkening / vignette.
 *   4. North arrow — small compass indicator in the bottom-right corner,
 *      oriented correctly for the camera's perspective.
 *
 * Falls back to the original photo if the geo→pixel transform can't be built.
 */
async function paintBoundaryOnPhoto(
  photoDataUrl: string,
  polygonRing: [number, number][],
  anchorPixels: ([number, number] | null)[],
  anchorLabels: (string | null)[],
  houseFootprint?: { coordinates: [number, number][][] } | null,
  extraPairs?: Array<{ geo: [number, number]; px: [number, number] }>,
  roofPixels?: [number, number][] | null,
): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const project = buildGeoToImageTransform(polygonRing, anchorPixels, anchorLabels, W / H, extraPairs);
      if (!project) { resolve(photoDataUrl); return; }

      const canvas = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;

      // ── 1. Original photo ──────────────────────────────────────────────────
      ctx.drawImage(img, 0, 0);

      const proj = (pt: [number, number]): [number, number] => {
        const [nx, ny] = project(pt);
        return [nx * W, ny * H];
      };

      // ── 2. House footprint — amber overlay ────────────────────────────────
      if (houseFootprint?.coordinates?.[0]) {
        const houseVerts = (houseFootprint.coordinates[0] as [number, number][]).map(proj);
        ctx.beginPath();
        houseVerts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fillStyle   = 'rgba(217, 119, 6, 0.45)';   // amber-600 at 45%
        ctx.fill();
        ctx.strokeStyle = 'rgba(217, 119, 6, 1.0)';
        ctx.lineWidth   = Math.max(2, W * 0.004);
        ctx.setLineDash([]);
        ctx.stroke();
      }

      // ── 2b. Roofline — blue dashed outline (Gemini-detected, image-space coords) ──
      if (roofPixels && roofPixels.length >= 3) {
        const roofLineW = Math.max(2, W * 0.003);
        ctx.beginPath();
        roofPixels.forEach(([nx, ny], i) => {
          const px = nx * W, py = ny * H;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';  // blue-500
        ctx.lineWidth   = roofLineW;
        ctx.setLineDash([roofLineW * 3, roofLineW * 1.5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── 3. Project boundary — dashed green line ───────────────────────────
      const boundaryVerts = polygonRing.map(proj);
      ctx.beginPath();
      boundaryVerts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      const strokeW = Math.max(2, W * 0.008);
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.95)';     // green-600
      ctx.lineWidth   = strokeW;
      ctx.setLineDash([strokeW * 3, strokeW * 1.5]);
      ctx.stroke();

      // ── 4. North arrow ────────────────────────────────────────────────────
      // Determine north direction by projecting two points that differ only in latitude.
      const centroid = polygonRing.reduce(
        (acc, pt) => [acc[0] + pt[0], acc[1] + pt[1]] as [number, number],
        [0, 0] as [number, number],
      ).map(v => v / polygonRing.length) as [number, number];
      const northPt: [number, number] = [centroid[0], centroid[1] + 0.001]; // ~111 m north
      const [cx, cy] = proj(centroid);
      const [nx, ny] = proj(northPt);
      const ndx = nx - cx, ndy = ny - cy;
      const nlen = Math.hypot(ndx, ndy);

      if (nlen > 0.5) {
        const unx = ndx / nlen, uny = ndy / nlen;   // unit north vector in pixel space
        const perpx = -uny, perpy = unx;             // perpendicular

        const aLen   = Math.min(W, H) * 0.055;
        const ax     = W * 0.93;
        const ay     = H * 0.93;
        const tipX   = ax + unx * aLen * 0.5;
        const tipY   = ay + uny * aLen * 0.5;
        const baseX  = ax - unx * aLen * 0.5;
        const baseY  = ay - uny * aLen * 0.5;

        // Background circle
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(ax, ay, aLen * 0.75, 0, Math.PI * 2);
        ctx.fill();

        // Arrow shaft
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = Math.max(2, aLen * 0.1);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        // Arrowhead
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - unx * aLen * 0.35 + perpx * aLen * 0.18,
                   tipY - uny * aLen * 0.35 + perpy * aLen * 0.18);
        ctx.lineTo(tipX - unx * aLen * 0.35 - perpx * aLen * 0.18,
                   tipY - uny * aLen * 0.35 - perpy * aLen * 0.18);
        ctx.closePath();
        ctx.fill();

        // "N" label
        const labelSize = Math.round(aLen * 0.38);
        ctx.font         = `bold ${labelSize}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = 'white';
        ctx.fillText('N', tipX + unx * aLen * 0.5, tipY + uny * aLen * 0.5);
      }

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(photoDataUrl);
    img.src = photoDataUrl;
  });
}

/**
 * Composites a Gemini-generated image with the original clean photo so that
 * only the area inside the project polygon shows the new design — everything
 * outside is pixel-identical to the original.
 *
 * Both images are scaled to the original photo's native dimensions before
 * compositing, so the result is always full-resolution.
 */
async function compositeWithOriginal(
  originalPhotoUrl: string,
  generatedUrl: string,
  polygonRing: [number, number][],
  anchorPixels: ([number, number] | null)[],
  anchorLabels: (string | null)[],
): Promise<string> {
  return new Promise(resolve => {
    const orig = new Image();
    orig.onload = () => {
      const W = orig.naturalWidth;
      const H = orig.naturalHeight;
      const project = buildGeoToImageTransform(polygonRing, anchorPixels, anchorLabels, W / H);
      if (!project) { resolve(generatedUrl); return; }

      const gen = new Image();
      gen.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d')!;

        // Base layer: original photo (covers everything outside boundary)
        ctx.drawImage(orig, 0, 0, W, H);

        // Project polygon vertices into absolute pixel coordinates
        const verts = polygonRing.map(pt => {
          const [nx, ny] = project(pt);
          return [nx * W, ny * H] as [number, number];
        });

        // Clip to polygon, then draw generated image over it
        ctx.save();
        ctx.beginPath();
        verts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(gen, 0, 0, W, H);
        ctx.restore();

        resolve(canvas.toDataURL('image/jpeg', 0.92));
      };
      gen.onerror = () => resolve(generatedUrl);
      gen.src = generatedUrl;
    };
    orig.onerror = () => resolve(generatedUrl);
    orig.src = originalPhotoUrl;
  });
}

// ── Hard-rule violation checker ───────────────────────────────────────────────

const HARD_RULE_CHECKS: Array<{ label: string; question: string }> = [
  { label: 'swimming pool',   question: 'Does this image show a swimming pool or large decorative pond (not a small fountain or rill)?' },
  { label: 'outdoor kitchen', question: 'Does this image show a fixed outdoor kitchen with built-in appliances or masonry countertops?' },
  { label: 'retaining wall',  question: 'Does this image show retaining walls or significant terracing / grade changes?' },
  { label: 'artificial turf', question: 'Does this image show artificial turf or synthetic grass?' },
  { label: 'painted rocks',   question: 'Does this image show painted rocks or brightly colored decorative non-natural elements?' },
];

async function checkHardRules(imageBase64: string, imageMimeType: string): Promise<string[]> {
  const questions = HARD_RULE_CHECKS
    .map((c, i) => `${i + 1}. ${c.question} Answer YES or NO only.`)
    .join('\n');
  const prompt = `Look at this landscape design image and answer each question with YES or NO.\n\n${questions}`;
  try {
    const res = await fetch(TEXT_API_URL, {
      method: 'POST',
      headers: GEMINI_HEADERS,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: imageMimeType, data: imageBase64 } }] }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts
      ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '').toLowerCase();
    const lines = text.split('\n');
    return HARD_RULE_CHECKS
      .filter((_, i) => (lines[i] ?? '').includes('yes'))
      .map(c => c.label);
  } catch {
    return [];
  }
}

export async function generateLandscapeConcept(params: GenerateConceptParams): Promise<GenerateConceptResult> {
  const city = extractCity(params.address);
  const yardLabel = `${params.yardType} yard`;
  const styleLabel = STYLE_LABELS[params.style] || params.style;
  const priorityList = params.priorities.map(p => PRIORITY_LABELS[p] || p).join(', ');
  const featureList = params.features.map(f => FEATURE_LABELS[f] || f).join(', ');

  // ── Build photo polygon extra pairs ─────────────────────────────────────────
  // If the user traced all boundary corners on their photo, each photo point
  // corresponds 1-to-1 with the matching polygon ring vertex. These pairs feed
  // directly into the DLT homography (≥4 pts) or camera model (≥2 pts), giving
  // a much more accurate geo→image projection than the old single-anchor system.
  const photoExtraPairs: Array<{ geo: [number, number]; px: [number, number] }> =
    params.photoPolygon && params.polygonRing && params.photoPolygon.length >= 2
      ? params.polygonRing
          .slice(0, params.photoPolygon.length)
          .map((geo, i) => ({ geo: geo as [number, number], px: params.photoPolygon![i] }))
      : [];

  // Whether we have enough anchor data to run spatial transforms
  const hasAnchors = photoExtraPairs.length >= 2 ||
    (params.anchorPixels ?? []).some(p => p !== null);

  // Resolve legacy anchor arrays for functions that still accept them
  const anchorPixels = params.anchorPixels ?? [];
  const anchorLabels = params.anchorLabels ?? [];

  // ── Project house footprint onto image space ──────────────────────────────────
  let houseNote = '';
  if (params.houseFootprint && params.polygonRing && params.polygonRing.length >= 3 && hasAnchors) {
    const project = buildGeoToImageTransform(
      params.polygonRing,
      anchorPixels,
      anchorLabels,
      undefined,
      photoExtraPairs,
    );
    if (project) {
      const ring = params.houseFootprint.coordinates[0] as [number, number][];
      const imgPts = ring.map(pt => project(pt));
      const xs = imgPts.map(p => p[0]);
      const ys = imgPts.map(p => p[1]);
      const x0 = Math.max(0, Math.min(...xs)).toFixed(2);
      const x1 = Math.min(1, Math.max(...xs)).toFixed(2);
      const y0 = Math.max(0, Math.min(...ys)).toFixed(2);
      const y1 = Math.min(1, Math.max(...ys)).toFixed(2);
      houseNote =
        `HOUSE LOCATION (from building data — treat as ground truth):\n` +
        `The house structure occupies the region x=[${x0}, ${x1}], y=[${y0}, ${y1}] ` +
        `in normalized image coordinates (0,0 = top-left, 1,1 = bottom-right).\n` +
        `- Do not redesign, paint over, or alter the house facade or roof in any way.\n` +
        `- Do not place any plants, mulch, or features on or overlapping the house footprint.\n`;
    }
  }

  // hardscapeRules is a function so it can reference the final detectedHardscapes count
  // (which isn't resolved until after Step B2 below). We call it lazily inside buildImagePrompt.
  const buildHardscapeRules = (zones: HardscapeZone[]) => {
    const hasVisualZones = zones.length > 0;
    if (params.editInstructions) {
      return `HARDSCAPE RULES — highest priority constraint, must not be violated:\n` +
        (hasVisualZones
          ? `- The RED "NO PLANT" zones in the annotated image mark every driveway, walkway, patio, and paved surface. These areas are completely off-limits.\n`
          : '') +
        `- DRIVEWAYS and PATIOS are permanently locked. Do not alter, relocate, cover, or redesign them under any circumstances.\n` +
        `- WALKWAYS may only be changed if the user's edit instructions explicitly request a change to the walkway (location, material, or both). If the instructions do not mention walkways, preserve every existing walkway exactly as-is.\n` +
        `- Do NOT place any plant, flower, shrub, groundcover, mulch, or gravel on top of any driveway or patio — even partially.\n` +
        `- The driveway must remain fully open, unchanged, and unobstructed in the output image.\n` +
        `- All new plantings must stay within the unpaved soil areas only.\n` +
        `- Keep any existing trees in their exact position unless the user explicitly asks to remove them.\n`;
    }
    return `HARDSCAPE RULES — highest priority constraint, must not be violated:\n` +
      (hasVisualZones
        ? `- The RED "NO PLANT" zones in the annotated photo mark every driveway, walkway, patio, and paved surface. These areas are completely off-limits for any landscaping change.\n`
        : `- Preserve every existing driveway, walkway, patio, and paved surface exactly as-is.\n`) +
      `- Preserve every hardscape EXACTLY as-is — same position, width, material, color, and layout. Do not alter, remove, shrink, or cover them in any way.\n` +
      `- Do NOT place any plant, flower, shrub, groundcover, mulch, gravel, or design element on top of or overlapping a driveway, walkway, patio, or any paved surface — even partially.\n` +
      `- The driveway must remain fully open, unchanged, and unobstructed in the output image.\n` +
      `- All new plantings must stay within the unpaved soil areas only, with a clear visible gap between plantings and the edge of any hardscape.\n` +
      `- Keep any existing trees in their exact position unless the user explicitly asks to remove them.\n`;
  };

  const treeRules =
    `TREE PLACEMENT RULES:\n` +
    `- Never place any new tree within 10 feet of the house foundation or footprint.\n` +
    `- Any tree that would reach 20 feet or taller at maturity must be placed at least 20 feet from the house foundation or footprint.\n` +
    `- These clearances apply to the tree trunk position, not the canopy edge.\n`;

  const plantCoverTarget = params.style === 'natural_wild' ? '75%' : '50%';
  const wantsLawn = params.features.includes('lawn');
  const groundCoverRules =
    `GROUND COVER & PLANTING DENSITY RULES:\n` +
    (wantsLawn
      ? `- An open lawn area has been requested. Include it as a clearly defined grass zone.\n`
      : `- Do NOT include any lawn or grass area. The user did not request it. Fill all open soil with planting beds, groundcovers, mulch, or featured zones instead.\n`) +
    `- Aim for at least ${plantCoverTarget} plant cover on all non-lawn, non-feature areas (beds, borders, open soil). Fill gaps with groundcovers, low perennials, or mulch — do not leave bare soil visible.\n` +
    `- Use mulch (bark/wood chip) as the primary ground cover in planting beds. Gravel or rocks are only appropriate for: dry creek beds, desert-style planting beds (for ${params.style === 'desert_minimal' ? 'this desert style' : 'desert_minimal designs'}), or as a base material under dining/seating/cooking areas.\n` +
    `- No more than 25% of the non-feature unpaved area should be covered in gravel or rocks total.\n` +
    `- Dining, seating, and cooking zones may use gravel, decomposed granite, or pavers as their surface material.\n`;

  const wantsSeating = params.features.some(f => f === 'seating' || f === 'dining');
  const wantsWater   = params.features.includes('water');
  const wantsTrees   = params.features.includes('trees');

  const bedShapeRules =
    `BED SHAPES — use only these shape vocabularies for planting beds:\n` +
    `kidney curves, free-form blobs, irregular polygons, ovals, rounded rectangles, crescents, gentle lazy-S curves.\n` +
    `No exotic geometric shapes (pentagrams, fractal edges, paisley, star shapes).\n`;

  const surfaceRules =
    `SURFACE TREATMENTS — use only: bark mulch planting beds, turf lawn, simple gravel.\n` +
    `Do not use exotic or premium materials: no decomposed granite, river stones, slate, pebble mosaic, polished concrete, or flagstone.\n` +
    (wantsLawn ? `` : `No lawn or grass — the user did not request it.\n`);

  const featureScaleRules =
    (wantsSeating || wantsWater || wantsTrees)
      ? `FEATURE SCALE RULES:\n` +
        (wantsSeating
          ? `- Seating and dining areas should be modestly sized (~${params.yardType === 'front' ? '100' : '150'} sq ft) — not sprawling hardscape plazas.\n`
          : ``) +
        (wantsWater
          ? `- Water features should be small to medium scale (fountain, small pond, or rill) — not large reflecting pools.\n`
          : ``) +
        (wantsTrees
          ? `- Limit trees to a realistic count for the yard size — typically 1–4 trees maximum.\n`
          : ``)
      : ``;

  const outOfScopeRules =
    `OUT OF SCOPE — DO NOT INCLUDE ANY OF THESE:\n` +
    `- Swimming pools or large ponds or streams\n` +
    `- Outdoor kitchens with built-in masonry appliances (a simple portable grill is acceptable)\n` +
    `- Retaining walls or grade changes\n` +
    `- Artificial turf or synthetic grass\n` +
    `- Painted rocks or decorative non-natural elements\n`;

  const infrastructurePreservationRules =
    `RULE 17 — INFRASTRUCTURE PRESERVATION (HARD):\n` +
    `The original photograph (attached) is the source of truth for what already exists on this property. ` +
    `The following features in the original photo are infrastructure and must appear in the concept ` +
    `exactly as they do in the original photo, unchanged in position, materials, and appearance:\n` +
    `- Existing trees (any size) — same species, position, approximate size\n` +
    `- Mature woody shrubs (3+ feet tall) — same position\n` +
    `- Fences and walls — same material, position, style\n` +
    `- The house — same color, facade, windows, doors, position\n` +
    `- Driveways — same material (do not change concrete to pavers, etc.)\n` +
    `- Walkways and paths — same material and position\n` +
    `- Sheds and outbuildings — same position and appearance\n` +
    `- Solar panels — same position\n` +
    `- Utility infrastructure (A/C, meters, hose bibs, irrigation) — same position\n` +
    `- Mailboxes — same position\n` +
    `The concept shows the new landscape design AROUND these features. Modifications, removals, or relocations are not permitted.\n`;

  const redesignCandidateRules =
    `RULE 18 — REDESIGN-CANDIDATE FEATURES (HARD):\n` +
    `The following feature types may exist in the original photo but should appear in the concept ONLY if ` +
    `the user has selected the corresponding feature below. If not selected, replace with planted landscape.\n` +
    `- Existing seating areas → show only if "seating" is in the user's selected features\n` +
    `- Existing dining areas → show only if "dining" is in the user's selected features\n` +
    `- Existing cooking/grill areas → show only if "cooking" is in the user's selected features\n` +
    `- Existing water features → show only if "water feature" is in the user's selected features\n` +
    `- Existing vegetable gardens → show only if "vegetable garden" is in the user's selected features\n` +
    `- Existing lawn → show only if "open lawn" is in the user's selected features\n` +
    `- Existing planted beds and decorative plantings → replaced by the new design's bed composition\n\n` +
    `USER-SELECTED FEATURES (the features that should appear in the new design):\n` +
    (featureList ? featureList + '\n' : '(none selected)\n') +
    `DO NOT include any redesign-candidate features not in this list, even if visible in the original photo.\n`;

  const buildImagePrompt = (zones: HardscapeZone[], clarifyingSuffix = '') => {
    const hardscapeRules = buildHardscapeRules(zones);
    if (params.editInstructions) {
      return `You are a professional landscape designer in ${city}. ` +
        `You are iterating on an existing landscape design. Make only the changes described below — keep everything else the same.\n\n` +
        `USER CHANGES: ${params.editInstructions}\n\n` +
        (zones.length > 0
          ? `IMAGE ANNOTATIONS (overlaid on the image for reference only — do NOT reproduce them in the output):\n` +
            `- RED "NO PLANT" areas = driveways, walkways, patios, and paved surfaces. Do not cover, alter, or plant over them.\n\n`
          : '') +
        (houseNote ? houseNote + '\n' : '') +
        hardscapeRules + '\n' +
        treeRules + '\n' +
        groundCoverRules +
        `\nOTHER RULES:\n` +
        `- Keep the exact camera angle, focal length, and perspective of the original photo. Do not shift the viewpoint, zoom, or tilt.\n` +
        `- Never add fences unless already visible in the image.\n` +
        `- Never add signs, birdhouses, or small decorative accents.\n` +
        `- Output a high-quality professional landscape photograph.` +
        clarifyingSuffix;
    }
    return `You are a professional landscape designer in ${city}. ` +
      `Transform this photo of a ${yardLabel} into a photorealistic redesign.\n\n` +
      `STYLE: ${styleLabel}.\n` +
      `PRIORITIES: ${priorityList}.\n` +
      `FEATURES TO INCLUDE: ${featureList}.\n\n` +
      infrastructurePreservationRules + '\n' +
      redesignCandidateRules + '\n' +
      (params.polygonRing && params.polygonRing.length >= 3 && hasAnchors
        ? `IMAGE ANNOTATIONS (overlaid on the photo for spatial reference only — do NOT reproduce any of these lines, shapes, or markers in the output image):\n` +
          (params.houseFootprint
            ? `- AMBER polygon = the house foundation (from official building data). ` +
              `This is a non-traversable structure. Do not place any plants, mulch, or features inside or on top of it. ` +
              `Preserve the house facade exactly as it appears in the photo.\n`
            : '') +
          `- BLUE DASHED outline = the roofline of the house as visible in the photo. Use this to understand the 3D extent of the structure.\n` +
          `- GREEN DASHED line = the project boundary. Redesign the landscaping within this area. Do not draw this line in the output.\n` +
          (zones.length > 0
            ? `- RED areas = existing hardscape surfaces (driveways, walkways, patios, steps). Preserve them exactly as-is. Do not cover with plants, mulch, or any design elements.\n`
            : '') +
          `- NORTH ARROW = compass orientation. Use for design orientation only; do not include it in the output.\n\n`
        : '') +
      (houseNote ? houseNote + '\n' : '') +
      hardscapeRules + '\n' +
      treeRules + '\n' +
      groundCoverRules + '\n' +
      bedShapeRules + '\n' +
      surfaceRules + '\n' +
      (featureScaleRules ? featureScaleRules + '\n' : '') +
      outOfScopeRules +
      `\nOTHER RULES:\n` +
      `- Keep the exact camera angle, focal length, and perspective of the original photo. Do not shift the viewpoint, zoom, or tilt.\n` +
      `- Never add fences unless already visible in the photo.\n` +
      `- Never add signs, birdhouses, or small decorative accents.\n` +
      `- Output a high-quality professional landscape photograph.\n\n` +
      (params.usdaZone
        ? `APPROVED PLANTS — use ONLY plants from this list (selected for USDA Zone ${params.usdaZone} and the user's preferences). Do not depict any other species:\n` +
          buildApprovedPlantList(params.usdaZone, params.priorities)
        : '') +
      clarifyingSuffix;
  };

  // ── Step A/B: Extract house ground-contact pixels + match to Mapbox footprint ──
  // Only for initial generation; gives extra geo→pixel pairs for the homography.
  let houseAnchors: HousePixelAnchors | null = null;
  if (!params.editInstructions && params.houseFootprint &&
      params.polygonRing && params.polygonRing.length >= 3 && hasAnchors) {
    try {
      houseAnchors = await extractHousePixelAnchors({
        photoDataUrl:   params.photoDataUrl,
        houseFootprint: params.houseFootprint,
        polygonRing:    params.polygonRing,
        anchorPixels:   anchorPixels,
        anchorLabels:   anchorLabels,
      });
    } catch { /* fall back */ }
  }

  // ── Step B2: Detect hardscape exclusion zones (driveways, walkways, patios) ──
  // Initial generation: detect fresh from the photo.
  // Edit mode: reuse previously-detected zones from params.hardscapeZones so the
  // visual red annotation is preserved on the concept image sent to Gemini.
  let detectedHardscapes: HardscapeZone[] = [];
  if (!params.editInstructions) {
    try {
      detectedHardscapes = await detectHardscapes(params.photoDataUrl);
    } catch { /* continue without */ }
  } else if (params.hardscapeZones && params.hardscapeZones.length > 0) {
    detectedHardscapes = params.hardscapeZones;
  }

  // Merge all geo→pixel pairs: photo polygon + house anchors
  const allExtraPairs = [
    ...photoExtraPairs,
    ...(houseAnchors?.pairs ?? []),
  ];

  // ── Step C: Annotate photo with spatial reference overlays ───────────────────
  const annotatedPhotoUrl =
    !params.editInstructions && params.polygonRing && params.polygonRing.length >= 3 && hasAnchors
      ? await paintBoundaryOnPhoto(
          params.photoDataUrl,
          params.polygonRing,
          anchorPixels,
          anchorLabels,
          params.houseFootprint,
          allExtraPairs.length > 0 ? allExtraPairs : undefined,
          houseAnchors?.roofPixels ?? null,
        )
      : params.photoDataUrl;

  // ── Step D: Paint hardscape exclusion zones (red) onto the annotated photo ──
  const hardscapeAnnotatedUrl = detectedHardscapes.length
    ? await paintHardscapesOnPhoto(annotatedPhotoUrl, detectedHardscapes)
    : annotatedPhotoUrl;

  const { mimeType, base64 } = parseDataUrl(hardscapeAnnotatedUrl);

  // ── Step 1: Generate the concept image (with hard-rule validation + regen) ──
  const MAX_REGEN_ATTEMPTS = 2;
  let imagePart: any;
  let imageDataUrl = '';
  let lastViolations: string[] = [];

  for (let attempt = 0; attempt <= MAX_REGEN_ATTEMPTS; attempt++) {
    const clarifyingSuffix = lastViolations.length > 0
      ? `\n\nCRITICAL — the previous image violated these rules: ${lastViolations.join(', ')}. ` +
        `Regenerate the design without including any of these. This overrides all other instructions.`
      : '';

    const genRes = await fetch(IMAGE_API_URL, {
      method: 'POST',
      headers: GEMINI_HEADERS,
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildImagePrompt(detectedHardscapes, clarifyingSuffix) }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    });

    if (!genRes.ok) {
      if (attempt === 0) throw new Error(`Gemini API error ${genRes.status}: ${await genRes.text()}`);
      break; // use last good result
    }

    const genData = await genRes.json();
    const part = genData.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) {
      if (attempt === 0) throw new Error('No image returned from Gemini');
      break;
    }

    imagePart = part;
    imageDataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;

    // Hard-rule check — only for initial generation; skip for edits and final attempt
    if (!params.editInstructions && attempt < MAX_REGEN_ATTEMPTS) {
      lastViolations = await checkHardRules(part.inlineData.data, part.inlineData.mimeType);
      if (lastViolations.length === 0) break;
      console.log(`[concept gen] hard rule violations (attempt ${attempt + 1}): ${lastViolations.join(', ')} — regenerating`);
    } else {
      if (lastViolations.length > 0) {
        console.warn(`[concept gen] hard rule violations persist after ${attempt} attempts: ${lastViolations.join(', ')} — using best result`);
      }
      break;
    }
  }

  // ── Step 2: Extract feature placements (initial generation only) ─────────────
  let features: ConceptFeature[] = [];
  if (!params.editInstructions) {
    const featuresToLocate = params.features
      .filter(f => f !== 'walkway' && FEATURE_LABELS[f])
      .map(f => FEATURE_LABELS[f]);

    if (featuresToLocate.length > 0) {
      const analysisPrompt =
        `You are a landscape design analyst. Look at this landscape design image and identify where each of the following features appears.\n\n` +
        `Features to locate: ${featuresToLocate.join(', ')}.\n\n` +
        `Output ONLY a JSON array. Use normalized coordinates where (0,0) is bottom-left and (1,1) is top-right. ` +
        `Estimate a realistic footprint size in sq ft for each feature.\n` +
        `Format: [{"feature_name": "...", "relative_position": [x, y], "area_sq_ft": N}, ...]`;

      const textRes = await fetch(TEXT_API_URL, {
        method: 'POST',
        headers: GEMINI_HEADERS,
        body: JSON.stringify({
          contents: [{ parts: [{ text: analysisPrompt }, { inline_data: { mime_type: imagePart.inlineData.mimeType, data: imagePart.inlineData.data } }] }],
        }),
      });

      if (textRes.ok) {
        const textData = await textRes.json();
        const textContent = textData.candidates?.[0]?.content?.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';
        const jsonMatch = textContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try { features = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
        }
      }
    }
  }

  return { imageDataUrl, features, hardscapeZones: detectedHardscapes };
}

// ── Plan Translation: Color Mask Segmentation ────────────────────────────────

/**
 * Asks Gemini to produce a flat color segmentation mask of the concept image.
 * Each landscape zone type is painted a distinct solid color; all other pixels
 * are pure black.
 *
 * Color mapping (communicated to Gemini via the prompt):
 *   Walkway        → RED     #FF0000    Seating Area    → BLUE    #0000FF
 *   Open Lawn      → GREEN   #00FF00    Dining Area     → YELLOW  #FFFF00
 *   Water Feature  → CYAN    #00FFFF    Rock Garden     → MAGENTA #FF00FF
 *   Cooking Area   → ORANGE  #FF8000    Vegetable Garden→ AZURE   #0080FF
 *   Shade Trees    → LIME    #80FF00    Everything else → BLACK   #000000
 *
 * Mulch / blank space has no color — unmatched cells are not assigned to any
 * feature and are treated as background by the map layer.
 *
 * The caller then intersects this mask with the photo grid using
 * maskToFeatures() in planTranslationService — no text parsing, no cell-ID
 * misidentification, no grid overlay required in the image sent to Gemini.
 */
/** Full color spec per maskable feature name — matches MASK_FEATURES in planTranslationService. */
const FEATURE_COLOR_LINES: Record<string, string> = {
  'Walkway':          `  • Walkway, path, driveway, steps, or any paved / hardscape surface              → RED     rgb(255, 0,   0  ) #FF0000\n`,
  'Open Lawn':        `  • Lawn, grass, or open turf                                                      → GREEN   rgb(0,   255, 0  ) #00FF00\n`,
  'Seating Area':     `  • Seating area (benches, patio furniture, sitting space)                         → BLUE    rgb(0,   0,   255) #0000FF\n`,
  'Dining Area':      `  • Dining area (outdoor table + chairs)                                           → YELLOW  rgb(255, 255, 0  ) #FFFF00\n`,
  'Water Feature':    `  • Water feature — any area containing VISIBLE WATER: pond, fountain, stream, pool, waterfall, or wet basin. Even if rocks surround or line the water, the defining trait is the presence of water itself. Do NOT confuse with rock garden.  → CYAN    rgb(0,   255, 255) #00FFFF\n`,
  'Rock Garden':      `  • Rock garden — DRY decorative rock, gravel, or decomposed granite where ROCKS OR GRAVEL ARE THE DOMINANT VISIBLE SURFACE MATERIAL. Only paint MAGENTA if you can clearly see exposed rock/gravel covering most of the area. If the area has dense plant foliage, shrubs, flowers, or groundcover obscuring the ground, look at what is visible between the plants — if it appears to be mulch, bark, or soil (not rocks), paint BLACK instead. Do NOT paint rock garden over any area primarily covered by plant matter.  → MAGENTA rgb(255, 0,   255) #FF00FF\n`,
  'Cooking Area':     `  • Cooking area, outdoor kitchen, BBQ, or cooking station                         → ORANGE  rgb(255, 128, 0  ) #FF8000\n`,
  'Vegetable Garden': `  • Vegetable garden or raised food-growing bed (distinct from ornamental beds)    → AZURE   rgb(0,   128, 255) #0080FF\n`,
  'Shade Trees':      `  • Shade trees — for every tree whose trunk is INSIDE the green project boundary, paint LIME over the entire visible canopy (the full leafy crown as seen in the image). Include large shade trees, ornamental trees, and multi-stem trees. Do NOT paint trees outside the boundary. Do NOT paint shrubs, hedges, or groundcover — only true trees with a distinct trunk.  → LIME    rgb(128, 255, 0  ) #80FF00\n`,
};

export async function getConceptColorMask(
  conceptImageDataUrl: string,
  activeFeatureNames: string[],
): Promise<string> {
  const { mimeType, base64 } = parseDataUrl(conceptImageDataUrl);

  // Build color lines in the exact priority order supplied by the caller.
  // Gemini attends more strongly to features listed earlier, so user-requested
  // features come first, then walkway, then extras like rock garden.
  const colorLines = activeFeatureNames
    .map(name => FEATURE_COLOR_LINES[name])
    .filter(Boolean)
    .join('');

  // Distinguish user-requested features (expected in the image) from the
  // always-included extras so Gemini knows what to prioritise.
  const alwaysExtras = new Set(['Walkway', 'Rock Garden']);
  const requestedNames = activeFeatureNames.filter(n => !alwaysExtras.has(n));
  const requestedNote = requestedNames.length > 0
    ? `The user specifically requested these features — assume they ARE present in the design and identify them first: ${requestedNames.join(', ')}.\n\n`
    : '';

  const prompt =
    `You are a landscape segmentation AI. Analyze this landscape design image and produce a flat segmentation mask.\n\n` +
    `CRITICAL — PROJECT BOUNDARY: A bright green dashed line marks the project boundary on this image. ` +
    `Paint ONLY features that fall INSIDE this green boundary. ` +
    `Everything outside the green boundary must be BLACK (#000000).\n\n` +
    requestedNote +
    `Paint every pixel inside the boundary with exactly one of the following solid colors.\n` +
    `No gradients, no anti-aliasing, no blending — pure flat fills only.\n\n` +
    `Color assignments listed in priority order — when a region is ambiguous, prefer the color listed earlier:\n` +
    colorLines +
    `  • House, structures, mulch, bark, soil, planting beds, or anything not listed above → BLACK   rgb(0,   0,   0  ) #000000\n\n` +
    `IMPORTANT — PLANT COVER RULE: When an area is covered with dense plants, flowers, shrubs, or groundcover, ` +
    `look carefully at what material is visible BETWEEN or BENEATH the plants. ` +
    `If you see mulch/bark/soil between plants, paint BLACK. ` +
    `Only paint MAGENTA (rock garden) if you can clearly see exposed rock or gravel as the dominant ground surface.\n\n` +
    `Output ONLY the mask image — no text, no labels, no grid lines, no borders.\n` +
    `Every pixel must be one of the colors listed above.`;

  const res = await fetch(IMAGE_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini color mask failed: ${res.status}`);
  const data = await res.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!imagePart) throw new Error('Gemini did not return a mask image');
  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

/**
 * Asks Gemini whether the primary walkway in the concept image appears
 * geometrically straight or curved/winding.
 *
 * Considers that plants or foliage may partially obscure the path, so Gemini
 * is instructed to infer the underlying geometry from visible portions.
 * Returns true when the walkway is straight.
 */
export async function detectWalkwayStraightness(conceptImageDataUrl: string): Promise<boolean> {
  const { mimeType, base64 } = parseDataUrl(conceptImageDataUrl);

  const prompt =
    `Examine this landscape design image. Focus on the walkway or path feature.\n\n` +
    `Determine whether the primary walkway is:\n` +
    `  STRAIGHT — runs in a straight line or with right-angle turns only\n` +
    `  CURVED   — has a gentle arc, curve, or winding/meandering shape\n\n` +
    `Note: foliage or plants may partially obscure the path. Use the visible ` +
    `portions and the overall composition to infer the underlying path geometry.\n\n` +
    `Respond with ONLY valid JSON — no explanation, no markdown:\n` +
    `{"walkway": "straight"} or {"walkway": "curved"}`;

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) return false; // default to curved (smoothed) on error
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return false;
    const parsed = JSON.parse(m[0]);
    return parsed.walkway === 'straight';
  } catch {
    return false;
  }
}

/**
 * Asks Gemini to locate shade trees in the concept image.
 *
 * We use a separate text call (not the color mask) because tree canopies
 * appear high in perspective photos — above where the projected ground
 * boundary sits — making them invisible to the pre-clipped mask.
 *
 * Returns approximate tree ground positions as normalized image coordinates
 * (0,0 = top-left, 1,1 = bottom-right).
 */
export async function detectTreeTrunks(
  conceptImageDataUrl: string,
): Promise<Array<{ x: number; y: number }>> {
  const { mimeType, base64 } = parseDataUrl(conceptImageDataUrl);

  const prompt =
    `You are analyzing a landscape design image that has a labeled coordinate grid overlay.\n\n` +
    `Find EVERY tree in this image — shade trees, ornamental trees, any leafy or woody tree with a distinct trunk.\n` +
    `Do NOT include shrubs, hedges, or groundcover — only true trees.\n\n` +
    `For each tree, return the GROUND CONTACT position: the exact point on the ground directly below the centre of the trunk.\n` +
    `Rules for estimating ground contact when the trunk is partially hidden by foliage:\n` +
    `  • The ground position is always LOWER in the image than the canopy centre.\n` +
    `  • For a typical landscape photo (slight overhead angle), the trunk base is roughly\n` +
    `    60–75% of the way from the top of the canopy to the bottom of the image.\n` +
    `  • Use the visible portion of the trunk to anchor your estimate when possible.\n` +
    `  • Never place the trunk above the visible midpoint of the canopy.\n\n` +
    `Normalized coordinates: (0,0) = top-left corner, (1,1) = bottom-right corner.\n\n` +
    `Return ONLY a JSON array — no explanation, no markdown fences, no extra keys.\n` +
    `If no trees are visible, return []. Each entry must have "x" and "y" only.\n` +
    `Format: [{"x": 0.45, "y": 0.72}, {"x": 0.62, "y": 0.68}]`;

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });

  if (!res.ok) {
    console.error('[detectTreeTrunks] API error', res.status, res.statusText);
    return [];
  }
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  console.log('[detectTreeTrunks] Gemini response:', text);

  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((t: any) => {
        if (typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y };
        // Handle [[x, y], ...] format
        if (Array.isArray(t) && typeof t[0] === 'number' && typeof t[1] === 'number') return { x: t[0], y: t[1] };
        return null;
      })
      .filter((t): t is { x: number; y: number } => t !== null);
  } catch {
    return [];
  }
}

// ── Plan Translation: Feature Extraction (legacy grid-label approach) ─────────

/**
 * Step A of the plan translation pipeline.
 *
 * Sends the labeled grid concept image to Gemini and asks it to identify
 * each landscape feature along with the specific grid cells it occupies.
 *
 * @param labeledImageDataUrl - Canvas data URL from renderConceptWithGrid()
 * @returns Array of extracted features with cell coverage
 */
export async function extractFeaturesFromConcept(
  labeledImageDataUrl: string,
): Promise<ExtractedFeature[]> {
  const { mimeType, base64 } = parseDataUrl(labeledImageDataUrl);

  const prompt =
    `You are a landscape design analyst examining a concept image with a labeled coordinate grid overlay.\n\n` +
    `PROJECT BOUNDARY: A bright green dashed outline is drawn on the image marking the exact project area. ` +
    `Only identify features that are clearly within this green boundary. Ignore everything outside it.\n\n` +
    `Grid orientation (labels printed directly on the image):\n` +
    `- Columns labeled A, B, C... correspond to the grid columns as labeled — A is printed at the leftmost visible column position in the image\n` +
    `- Rows labeled 1, 2, 3... correspond to the grid rows as labeled — 1 is printed at the bottommost visible row position in the image\n` +
    `- Use ONLY the cell labels you can actually read in the image\n\n` +
    `Identify ONLY these two features inside the green project boundary and return a JSON array:\n` +
    `  1. "Walkway" — any paved path, walkway, or hardscape route\n` +
    `  2. "Open Lawn" — any grass, lawn, or open turf area\n\n` +
    `Use this format for both:\n` +
    `  { "name": "Walkway"|"Open Lawn", "type": "path"|"area", "cells": ["A1","B1",...] }\n\n` +
    `Rules:\n` +
    `- List ALL grid cells that belong to each feature — be thorough and exhaustive\n` +
    `- Use the exact names "Walkway" and "Open Lawn" — no other names\n` +
    `- ONLY include cells that are inside the green project boundary outline\n` +
    `- Use the actual cell labels shown in the image (e.g. "A1", "B3") — read them directly from the image\n` +
    `- Return ONLY a valid JSON array — no explanation, no markdown fences`;

  const res = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini feature extraction failed: ${res.status}`);

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (!arrMatch) throw new Error('Gemini did not return a valid JSON array');

  let parsed: unknown;
  try { parsed = JSON.parse(arrMatch[0]); } catch { throw new Error('Failed to parse Gemini feature JSON'); }

  if (!Array.isArray(parsed)) throw new Error('Expected JSON array from Gemini');

  return parsed as ExtractedFeature[];
}

// ── DIY final plan render ─────────────────────────────────────────────────────

export interface FinalPlanPlant {
  commonName: string;
  botanicalName: string;
  type: string;
  count: number;
}

export interface FinalPlanZone {
  toolId: string;
  label: string;
  color: string;
  vertices: [number, number][]; // [lng, lat]
  existing?: boolean;
}

export interface GenerateFinalPlanParams {
  photoDataUrl: string;
  address: string;
  yardType: string;
  style: string;
  priorities: string[];
  plants: FinalPlanPlant[];
  zones: FinalPlanZone[];
  boundaryVerts: [number, number][];
}

// Renders a top-down zone diagram to a PNG data URL.
// The diagram gives Gemini a spatial map of where each zone lives in the yard.
function createZoneDiagram(
  boundaryVerts: [number, number][],
  zones: FinalPlanZone[],
): string {
  const SIZE = 640;
  const PAD  = 40;

  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  // Convert geo [lng,lat] to meter offsets relative to centroid
  const allPts = [
    ...boundaryVerts,
    ...zones.flatMap(z => z.vertices),
  ];
  if (allPts.length === 0) return canvas.toDataURL();

  const refLng = allPts.reduce((s, p) => s + p[0], 0) / allPts.length;
  const refLat = allPts.reduce((s, p) => s + p[1], 0) / allPts.length;
  const mpdLng = 111320 * Math.cos(refLat * Math.PI / 180);
  const mpdLat = 110540;
  const toM = (lng: number, lat: number): [number, number] => [
    (lng - refLng) * mpdLng,
    (lat - refLat) * mpdLat,
  ];

  const allM = allPts.map(p => toM(p[0], p[1]));
  const mxs = allM.map(p => p[0]), mys = allM.map(p => p[1]);
  const minX = Math.min(...mxs), maxX = Math.max(...mxs);
  const minY = Math.min(...mys), maxY = Math.max(...mys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const pixPerM = Math.min((SIZE - PAD * 2) / rangeX, (SIZE - PAD * 2) / rangeY);
  const offX = (SIZE - rangeX * pixPerM) / 2;
  const offY = (SIZE - rangeY * pixPerM) / 2;

  const toPx = (lng: number, lat: number): [number, number] => {
    const [mx, my] = toM(lng, lat);
    return [
      offX + (mx - minX) * pixPerM,
      SIZE - offY - (my - minY) * pixPerM, // north = up
    ];
  };

  // Background
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Boundary fill
  if (boundaryVerts.length >= 3) {
    ctx.beginPath();
    boundaryVerts.forEach((v, i) => {
      const [px, py] = toPx(v[0], v[1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = '#2a4a2a';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Zone polygons
  const TOOL_ROLE: Record<string, string> = {
    planting_bed: 'Planting bed',
    tree:         'Tree / large shrub',
    walkway:      'Walkway',
    other:        'Hardscape',
  };

  for (const zone of zones) {
    if (zone.vertices.length < 3) continue;
    ctx.beginPath();
    zone.vertices.forEach((v, i) => {
      const [px, py] = toPx(v[0], v[1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = zone.color + 'bb';
    ctx.fill();
    ctx.strokeStyle = zone.color;
    ctx.lineWidth = zone.existing ? 1.5 : 2.5;
    if (!zone.existing) {
      ctx.setLineDash([6, 3]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Label at centroid
    const cx = zone.vertices.reduce((s, v) => s + v[0], 0) / zone.vertices.length;
    const cy = zone.vertices.reduce((s, v) => s + v[1], 0) / zone.vertices.length;
    const [lpx, lpy] = toPx(cx, cy);
    const roleLabel = TOOL_ROLE[zone.toolId] ?? zone.toolId;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(lpx - 36, lpy - 9, 72, 18);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(roleLabel.slice(0, 14), lpx, lpy);
  }

  // Legend
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, SIZE - 40, 170, 32);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Solid outline = existing  ·  Dashed = new', 14, SIZE - 24);

  return canvas.toDataURL('image/png');
}

export async function generateFinalPlanImage(params: GenerateFinalPlanParams): Promise<string> {
  const styleLabel = STYLE_LABELS[params.style] ?? params.style;
  const city = extractCity(params.address);

  const priorityLines = params.priorities
    .map(p => PRIORITY_LABELS[p] ?? p)
    .filter(Boolean)
    .map(l => `- ${l}`)
    .join('\n');

  const plantLines = params.plants
    .map(p => `- ${p.count}× ${p.commonName} (${p.botanicalName}) — ${p.type.replace(/_/g, ' ')}`)
    .join('\n');

  const zoneLines = params.zones
    .filter(z => z.toolId !== 'tree')
    .map(z => `- [${z.existing ? 'EXISTING' : 'NEW'}] ${z.label}`)
    .join('\n');

  const treeLines = params.zones
    .filter(z => z.toolId === 'tree')
    .map(z => `- [${z.existing ? 'EXISTING' : 'NEW'}] ${z.label}`)
    .join('\n');

  const prompt = `You are a professional landscape visualization artist. Transform this yard photo into a photorealistic rendering of the finished landscape design below.

You have been provided TWO images:
1. IMAGE 1 — The original yard photograph. Use this as the base scene.
2. IMAGE 2 — A top-down overhead diagram of the yard, showing every zone the user has defined (planting beds, walkways, hardscapes, trees). Each colored polygon in the diagram corresponds to a real area in the yard. Solid outlines = existing features; dashed outlines = new additions.

Use the overhead diagram to understand the EXACT spatial layout of the yard and accurately locate where each zone falls in the perspective photo before making changes.

DESIGN STYLE: ${styleLabel}
LOCATION: ${city}
YARD TYPE: ${params.yardType} yard
${priorityLines ? `DESIGN PRIORITIES:\n${priorityLines}` : ''}

ZONES FROM DIAGRAM:
${zoneLines || '(none)'}
${treeLines ? `\nTREES / LARGE SHRUBS:\n${treeLines}` : ''}

EXACT PLANTS TO PLACE:
${plantLines || '- (No specific plants — use style-appropriate choices)'}

CRITICAL RULES:
- Preserve the house facade, roof, windows, and doors exactly — do NOT alter or paint over them.
- EXISTING zones (solid outline in diagram): keep them exactly as they appear in the photo. Do not move, cover, or redesign them.
- NEW zones (dashed outline in diagram): this is where planting and construction happens. Fill these areas with the plants and materials listed.
- Planting beds: layer plants with taller species toward the back edge, groundcovers and fillers at the front.
- Each plant species listed must appear somewhere in the final image at a realistic mature size for its role.
- The result must look like a real photograph taken on a bright day — not a 3D render or illustration.
- Do not add any text, labels, watermarks, or drawn lines to the output image.`;

  const { mimeType, base64 } = parseDataUrl(params.photoDataUrl);

  // Build the overhead zone diagram and encode it
  const diagramDataUrl = createZoneDiagram(params.boundaryVerts, params.zones);
  const { base64: diagBase64 } = parseDataUrl(diagramDataUrl);

  const res = await fetch(IMAGE_API_URL, {
    method: 'POST',
    headers: GEMINI_HEADERS,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType,    data: base64     } }, // photo
          { inline_data: { mime_type: 'image/png', data: diagBase64 } }, // diagram
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!imagePart) throw new Error('No image returned from Gemini');
  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

// ── Site feature detection (boundary-aware) ───────────────────────────────────

export interface DetectedSiteFeature {
  type: 'tree' | 'hardscape' | 'structure' | 'house';
  label: string;
  vertices: [number, number][]; // [lng, lat] geographic coordinates
  confidence: number;
}

/**
 * Fetches a Google Static Maps satellite image for the boundary area, asks
 * Gemini to detect existing trees, hardscape, and structures, and returns
 * results with real geographic coordinates.
 *
 * Google Static Maps is center+zoom based. We compute the image extent using
 * standard Web Mercator (256px tile scale) so normToLngLat stays accurate.
 */

function lngLatToWorldPx(lng: number, lat: number, zoom: number): [number, number] {
  const scale = 256 * Math.pow(2, zoom);
  const x = (lng + 180) / 360 * scale;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function worldPxToLngLat(px: number, py: number, zoom: number): [number, number] {
  const scale = 256 * Math.pow(2, zoom);
  const lng = px / scale * 360 - 180;
  const n   = Math.PI - 2 * Math.PI * py / scale;
  const lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI;
  return [lng, lat];
}

export async function detectSiteFeatures(
  boundaryVerts: [number, number][],
): Promise<DetectedSiteFeature[]> {
  // Gemini is reached via the proxy when no client key is set, so only the
  // Google Maps key (which is needed to fetch the satellite tile) is required.
  if (boundaryVerts.length < 3 || !GOOGLE_MAPS_KEY) return [];

  const lngs = boundaryVerts.map(v => v[0]);
  const lats  = boundaryVerts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;

  // Choose zoom so the boundary fills ~70% of the 640×640 image.
  // Cap at 20: Google Static Maps satellite imagery is capped at zoom 20
  // in most areas; requesting 21 causes the API to silently return a zoom-20
  // image while our pixel math still assumes 21, placing every feature at
  // half-scale relative to the actual image extent.
  const IMG = 640;
  let zoom = 19;
  for (let z = 20; z >= 15; z--) {
    const [x1] = lngLatToWorldPx(minLng, centerLat, z);
    const [x2] = lngLatToWorldPx(maxLng, centerLat, z);
    const [, y1] = lngLatToWorldPx(centerLng, maxLat, z);
    const [, y2] = lngLatToWorldPx(centerLng, minLat, z);
    if ((x2 - x1) <= IMG * 0.7 && (y2 - y1) <= IMG * 0.7) { zoom = z; break; }
  }

  // Google Static Maps satellite image
  const imageryUrl =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${centerLat},${centerLng}&zoom=${zoom}&size=${IMG}x${IMG}` +
    `&maptype=satellite&key=${GOOGLE_MAPS_KEY}`;

  console.log('[detectSiteFeatures] Google Static Maps url (zoom', zoom, ')');
  let dataUrl: string;
  try {
    const res = await fetch(imageryUrl);
    if (!res.ok) {
      console.error('[detectSiteFeatures] imagery error', res.status);
      return [];
    }
    const blob = await res.blob();
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error('[detectSiteFeatures] image fetch failed', err);
    return [];
  }

  // Compute the geographic extent of the returned image
  const [cx, cy]       = lngLatToWorldPx(centerLng, centerLat, zoom);
  const [imgMinLng]    = worldPxToLngLat(cx - IMG / 2, cy,           zoom);
  const [imgMaxLng]    = worldPxToLngLat(cx + IMG / 2, cy,           zoom);
  const [, imgMaxLat]  = worldPxToLngLat(cx,           cy - IMG / 2, zoom);
  const [, imgMinLat]  = worldPxToLngLat(cx,           cy + IMG / 2, zoom);

  console.log('[detectSiteFeatures] image extent', { imgMinLng, imgMaxLng, imgMinLat, imgMaxLat, zoom });

  const normToLngLat = (nx: number, ny: number): [number, number] => [
    imgMinLng + nx * (imgMaxLng - imgMinLng),
    imgMaxLat - ny * (imgMaxLat - imgMinLat),
  ];

  // Buffer boundary by 10 ft to define the search zone
  const SEARCH_BUFFER_M = 10 * 0.3048; // 10 ft → metres
  let searchVerts: [number, number][] = boundaryVerts;
  try {
    const buffered = turf.buffer(turf.polygon([[...boundaryVerts, boundaryVerts[0]]]), SEARCH_BUFFER_M, { units: 'meters' });
    if (buffered) {
      const ring = buffered.geometry.coordinates[0] as [number, number][];
      searchVerts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
        ? ring.slice(0, -1) : ring;
    }
  } catch {}

  // Annotate image: red dashed outline = 10 ft search zone, white line = actual boundary
  const annotatedDataUrl = await new Promise<string>(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const toImgPx = (lng: number, lat: number): [number, number] => [
        (lng - imgMinLng) / (imgMaxLng - imgMinLng) * img.width,
        (imgMaxLat - lat) / (imgMaxLat - imgMinLat) * img.height,
      ];
      const tracePath = (verts: [number, number][]) => {
        ctx.beginPath();
        verts.forEach(([lng, lat], i) => {
          const [px, py] = toImgPx(lng, lat);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
      };
      // Red dashed = search zone (10 ft buffer)
      tracePath(searchVerts);
      ctx.fillStyle = 'rgba(255,68,68,0.08)'; ctx.fill();
      ctx.setLineDash([8, 5]); ctx.strokeStyle = '#FF4444'; ctx.lineWidth = 3; ctx.stroke();
      ctx.setLineDash([]);
      // White solid = actual yard boundary
      tracePath(boundaryVerts);
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2; ctx.stroke();
      const out = canvas.toDataURL('image/jpeg', 0.92);
      console.log('%c annotated', `font-size:1px;padding:150px;background:url(${out}) center/contain no-repeat`);
      resolve(out);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

  const prompt =
    `You are analyzing a satellite aerial photograph of a residential yard.\n` +
    `The WHITE line shows the exact yard boundary. The RED DASHED line extends 10 feet beyond it — this is your search zone.\n\n` +
    `Identify ALL existing features INSIDE the red dashed search zone that a landscape designer must work around. Detect:\n` +
    `  - "house": The primary house or residence building. Trace its roof/footprint outline. There should be at most one.\n` +
    `  - "tree": Individual trees or large shrubs with a visible canopy from above.\n` +
    `  - "hardscape": Any paved or impervious surface — driveway, walkway, path, patio, pool, deck, concrete, gravel.\n` +
    `  - "structure": Any secondary built structure — shed, detached garage, fence line, retaining wall, pergola.\n\n` +
    `For each feature, trace a polygon around its footprint:\n` +
    `  - House: 4–12 vertices tracing the building roofline/footprint as precisely as possible.\n` +
    `  - Trees: 8–12 vertices forming a circle around the canopy edge.\n` +
    `  - Hardscape / structures: 4–16 vertices tracing the actual shape.\n\n` +
    `Coordinates: (0,0) = top-left of image, (1,1) = bottom-right. Use normalized floats.\n\n` +
    `Return ONLY a JSON array — no markdown fences, no extra text:\n` +
    `[{"type":"house"|"tree"|"hardscape"|"structure","label":"brief label","polygon":[[x,y],...],"confidence":0.0-1.0}]\n\n` +
    `If nothing is detected inside the red dashed zone, return: []`;

  const { mimeType, base64 } = parseDataUrl(annotatedDataUrl);

  const VISION_URL = geminiUrl('gemini-3.5-flash');

  try {
    const res = await fetch(VISION_URL, {
      method: 'POST',
      headers: GEMINI_HEADERS,
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ]}],
      }),
    });
    if (!res.ok) {
      console.error('[detectSiteFeatures] Gemini error', res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const text: string = data.candidates?.[0]?.content?.parts
      ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

    console.log('[detectSiteFeatures] raw Gemini response:', text);

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('[detectSiteFeatures] no JSON array found in response');
      return [];
    }

    const VALID = new Set(['house', 'tree', 'hardscape', 'structure']);
    const raw = JSON.parse(match[0]) as any[];
    console.log('[detectSiteFeatures] raw polygons (norm coords):', raw.map((f: any) => ({ type: f.type, label: f.label, first: f.polygon?.[0] })));
    const mapped: DetectedSiteFeature[] = raw
      .filter(f => VALID.has(f.type) && Array.isArray(f.polygon) && f.polygon.length >= 3)
      .map(f => ({
        type:       f.type as DetectedSiteFeature['type'],
        label:      typeof f.label === 'string' ? f.label : String(f.type),
        vertices:   (f.polygon as any[]).map((pt: any) => normToLngLat(Number(pt[0]), Number(pt[1]))),
        confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.7,
      }));

    // Keep any feature whose footprint INTERSECTS the 10ft search zone — matches clipFeaturesToBoundary's
    // intent so a house/driveway that overlaps the boundary but is centred outside it (e.g. the yard is
    // just the front lawn) is still surfaced. A centroid-inside test dropped those before the clip saw them.
    try {
      const boundaryPoly = turf.polygon([[...boundaryVerts, boundaryVerts[0]]]);
      const buffered = turf.buffer(boundaryPoly, SEARCH_BUFFER_M, { units: 'meters' });
      if (buffered) {
        const filtered = mapped.filter(f => {
          if (f.vertices.length < 3) return false;
          try {
            return turf.booleanIntersects(turf.polygon([[...f.vertices, f.vertices[0]]]), buffered as any);
          } catch { return false; }
        });
        console.log(`[detectSiteFeatures] ${mapped.length} detected, ${filtered.length} within boundary`);
        return filtered;
      }
    } catch {}
    return mapped;
  } catch {
    return [];
  }
}
