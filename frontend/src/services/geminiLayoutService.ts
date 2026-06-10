/**
 * Gemini Spatial Layout Service
 *
 * Replaces the code-based rules engine with a vision-language model.
 * Steps:
 *   1. Build a composite reference image: satellite tile + polygon/house/obstacle overlays + 10 ft grid
 *   2. Prompt Gemini to act as a Landscape Architect and return grid-coord JSON
 *   3. Convert grid coordinates back to [lng, lat] and map to PlacedFeature[]
 */

import { PlacedFeature, PlantingBed, ExistingTree, ExistingHardscape } from './rulesEngine';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const MAPBOX_TOKEN   = import.meta.env.VITE_MAPBOX_TOKEN   || '';
const VISION_MODEL   = 'gemini-3-flash-preview';

// ── Feature metadata ──────────────────────────────────────────────────────────

const DEFS: Record<string, { label: string; areaSqFt: number; color: string }> = {
  cooking: { label: 'Cooking Area',  areaSqFt:  45, color: '#E76F51' },
  dining:  { label: 'Dining Area',   areaSqFt: 120, color: '#E9C46A' },
  storage: { label: 'Storage Shed',  areaSqFt:  80, color: '#A0522D' },
  seating: { label: 'Seating Area',  areaSqFt: 100, color: '#F4A261' },
  garden:  { label: 'Veggie Garden', areaSqFt: 100, color: '#52B788' },
  water:   { label: 'Water Feature', areaSqFt:  25, color: '#5DA9E9' },
  trees:   { label: 'Shade Tree',    areaSqFt:   5, color: '#2D6A4F' },
  lawn:    { label: 'Open Lawn',     areaSqFt: 100, color: '#6FBF73' },
};

// ── Public types ──────────────────────────────────────────────────────────────

export interface GeminiLayoutParams {
  polygonRing: [number, number][];
  houseFootprint?: { geometry: { coordinates: [number, number][][] } } | null;
  sunPeakHours?: number | null;
  requestedFeatures: string[];
  existingTrees?: ExistingTree[];
  existingHardscapes?: ExistingHardscape[];
  style?: string | null;
  yardType?: string | null;
}

// ── Coordinate system ─────────────────────────────────────────────────────────

interface CoordSystem {
  swLng: number; swLat: number;
  MPD_LNG: number; MPD_LAT: number; FT: number;
  toFt(p: [number, number]): [number, number];
  toLngLat(p: [number, number]): [number, number];
}

function makeCoordSystem(polygonRing: [number, number][]): CoordSystem {
  const lngs  = polygonRing.map(p => p[0]);
  const lats  = polygonRing.map(p => p[1]);
  const swLng = Math.min(...lngs), swLat = Math.min(...lats);
  const refLat = (swLat + Math.max(...lats)) / 2;
  const MPD_LNG = 111320 * Math.cos(refLat * Math.PI / 180);
  const MPD_LAT = 110540;
  const FT = 3.28084;
  return {
    swLng, swLat, MPD_LNG, MPD_LAT, FT,
    toFt:     ([lng, lat]) => [(lng - swLng) * MPD_LNG * FT, (lat - swLat) * MPD_LAT * FT],
    toLngLat: ([x,   y  ]) => [swLng + x / FT / MPD_LNG,    swLat + y / FT / MPD_LAT   ],
  };
}

// ── Grid helpers ──────────────────────────────────────────────────────────────

/** 0 → "A", 25 → "Z", 26 → "AA", etc. */
function colToLetter(col: number): string {
  let result = '';
  let n = col + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/** "A" → 0, "Z" → 25, "AA" → 26 */
function letterToCol(letter: string): number {
  let col = 0;
  for (let i = 0; i < letter.length; i++)
    col = col * 26 + (letter.toUpperCase().charCodeAt(i) - 64);
  return col - 1;
}

/**
 * Grid [letter, row] → local-ft position. Row 1 = southernmost.
 * Handles fractional column letters like "C.7" (= col C + 0.7 cells)
 * and fractional row numbers like 7.2.
 */
function gridToFt(
  letter: string, row: number | string,
  originFt: [number, number], cellFt: number,
): [number, number] {
  // Parse fractional column: "C.7" → col 2 + 0.7 = 2.7
  const dotIdx = letter.indexOf('.');
  const colFloat = dotIdx >= 0
    ? letterToCol(letter.slice(0, dotIdx)) + parseFloat('0.' + letter.slice(dotIdx + 1))
    : letterToCol(letter);

  return [
    originFt[0] + colFloat * cellFt,
    originFt[1] + (Number(row) - 1) * cellFt,
  ];
}

// ── Canvas builder ────────────────────────────────────────────────────────────

interface CanvasResult {
  dataUrl:  string;
  originFt: [number, number]; // SW grid corner in local ft
  cellFt:   number;
  cs:       CoordSystem;
}

async function buildCanvas(params: GeminiLayoutParams): Promise<CanvasResult> {
  const cs = makeCoordSystem(params.polygonRing);
  const { toFt, toLngLat } = cs;

  const localRing = params.polygonRing.map(toFt);
  const xs = localRing.map(p => p[0]), ys = localRing.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const PADDING = 20; // ft of margin around the polygon
  const cellFt  = 10; // 10 ft × 10 ft grid cells
  const originFt: [number, number] = [minX - PADDING, minY - PADDING];
  const spanW = (maxX - minX) + 2 * PADDING;
  const spanH = (maxY - minY) + 2 * PADDING;

  // Keep longest side ≤ 800 px
  const maxDim = 800;
  const aspect = spanW / spanH;
  const canvasW = aspect >= 1 ? maxDim : Math.round(maxDim * aspect);
  const canvasH = aspect >= 1 ? Math.round(maxDim / aspect) : maxDim;
  const scale   = canvasW / spanW; // px per ft

  const canvas = document.createElement('canvas');
  canvas.width = canvasW; canvas.height = canvasH;
  const ctx = canvas.getContext('2d')!;

  // ft → canvas px (y-flipped: north = top)
  const ftPx = ([x, y]: [number, number]): [number, number] => [
    (x - originFt[0]) * scale,
    canvasH - (y - originFt[1]) * scale,
  ];

  // ── Satellite tile ────────────────────────────────────────────────────────
  const centerFtX = originFt[0] + spanW / 2;
  const centerFtY = originFt[1] + spanH / 2;
  const [centerLng, centerLat] = toLngLat([centerFtX, centerFtY]);
  // Compute zoom so the span fits the canvas
  const metersPerPx = (spanW / cs.FT) / canvasW;
  const rawZoom = Math.log2(156543.03392 * Math.cos(centerLat * Math.PI / 180) / metersPerPx);
  const zoom    = Math.max(15, Math.min(21, rawZoom));

  ctx.fillStyle = '#1c2f1c';
  ctx.fillRect(0, 0, canvasW, canvasH);

  try {
    const tileUrl = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static`
      + `/${centerLng},${centerLat},${zoom}/${canvasW}x${canvasH}`
      + `?access_token=${MAPBOX_TOKEN}`;
    const resp = await fetch(tileUrl);
    if (resp.ok) {
      const blobUrl = URL.createObjectURL(await resp.blob());
      await new Promise<void>(resolve => {
        const img = new Image();
        img.onload  = () => { ctx.drawImage(img, 0, 0, canvasW, canvasH); URL.revokeObjectURL(blobUrl); resolve(); };
        img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(); };
        img.src = blobUrl;
      });
    }
  } catch { /* dark background already set */ }

  // ── Layer 4: Grid ─────────────────────────────────────────────────────────
  const cols = Math.ceil(spanW / cellFt) + 1;
  const rows = Math.ceil(spanH / cellFt) + 1;

  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth   = 0.5;
  for (let c = 0; c <= cols; c++) {
    const [px] = ftPx([originFt[0] + c * cellFt, 0]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, canvasH); ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const [, py] = ftPx([0, originFt[1] + r * cellFt]);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(canvasW, py); ctx.stroke();
  }

  // Grid axis labels
  const fontSize = Math.max(9, Math.round(cellFt * scale * 0.22));
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  for (let c = 0; c < cols; c++) {
    const [px] = ftPx([originFt[0] + (c + 0.5) * cellFt, 0]);
    ctx.fillText(colToLetter(c), px, 2);
  }
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r < rows; r++) {
    const [, py] = ftPx([0, originFt[1] + (r + 0.5) * cellFt]);
    ctx.fillText(String(r + 1), 18, py);
  }

  // ── Layer 3a: Existing hardscapes (orange — strict no-go for everything) ──
  for (const h of (params.existingHardscapes ?? [])) {
    const pts = h.ringLngLat.map(p => ftPx(toFt(p)));
    ctx.fillStyle   = 'rgba(249,115,22,0.50)';
    ctx.strokeStyle = 'rgba(234,88,12,0.95)';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.closePath(); ctx.fill(); ctx.stroke();

    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    ctx.fillStyle    = 'rgba(255,255,255,0.95)';
    ctx.font         = `bold ${Math.max(9, fontSize)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(h.label ?? 'HARDSCAPE', cx, cy);
  }

  // ── Layer 3b: Existing tree canopies (yellow circles) ────────────────────
  for (const t of (params.existingTrees ?? [])) {
    const [cx, cy] = ftPx(toFt(t.centerLngLat));
    const rPx = t.radiusFt * scale;
    ctx.fillStyle   = 'rgba(234,179,8,0.35)';
    ctx.strokeStyle = 'rgba(234,179,8,0.95)';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }

  // ── Layer 2: House footprint (blue stroke) ────────────────────────────────
  const houseCoords = params.houseFootprint?.geometry?.coordinates?.[0] as [number, number][] | undefined;
  if (houseCoords?.length) {
    const pts = houseCoords.map(p => ftPx(toFt(p)));
    ctx.fillStyle   = 'rgba(59,130,246,0.20)';
    ctx.strokeStyle = 'rgba(59,130,246,0.95)';
    ctx.lineWidth   = 3;
    ctx.beginPath();
    pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.closePath(); ctx.fill(); ctx.stroke();

    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    ctx.fillStyle    = 'rgba(255,255,255,0.90)';
    ctx.font         = `bold ${Math.max(10, fontSize)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HOUSE', cx, cy);
  }

  // ── Layer 1: Project polygon (red stroke) ─────────────────────────────────
  ctx.strokeStyle = 'rgba(239,68,68,0.95)';
  ctx.lineWidth   = 3;
  ctx.beginPath();
  localRing.map(ftPx).forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
  ctx.closePath(); ctx.stroke();

  return { dataUrl: canvas.toDataURL('image/png'), originFt, cellFt, cs };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

const FEATURE_RULES: [string, string][] = [
  ['cooking', '5–15 ft from the BLUE house edge'],
  ['dining',  'Adjacent to cooking; fallback to 5–15 ft from house'],
  ['storage', 'Near a corner; 3–16 ft from the RED property line; maximize distance from house'],
  ['seating', '15–25 ft from house edge'],
  ['garden',  'Far from house; choose sunniest open area (clear of house shadow)'],
  ['water',   'Adjacent to seating; fallback to yard center'],
  ['trees',   '10–20 ft from house; ≥10 ft gap from existing YELLOW canopy edges'],
  ['lawn',    ''], // filled dynamically
];

function buildLawnRule(style: string | null | undefined, yardType: string | null | undefined): string {
  const isModern = style === 'modern_structured';
  const isWild   = style === 'natural_wild' || style === 'desert_minimal';
  const isFront  = !yardType || yardType === 'front';
  const pct      = isWild ? (isFront ? '25%' : '50%') : (isFront ? '50%' : '75%');
  const shape    = isModern
    ? 'Draw as a strict rectangle or square — use exactly 4 right-angle corners'
    : 'Draw as an organic, free-form shape with ≥8 vertices and gently curved, irregular edges — avoid straight lines';
  return `Fill the largest open void; target ~${pct} of total project area. ${shape}. Other features and beds may run directly into its edge — no buffer required`;
}

function buildPrompt(params: GeminiLayoutParams): string {
  const { style, yardType, requestedFeatures: wanted } = params;

  const orderedRules = FEATURE_RULES
    .filter(([type]) => wanted.includes(type))
    .map(([type, rule], i) => {
      const r = type === 'lawn' ? buildLawnRule(style, yardType) : rule;
      return `${i + 1}. ${type}: ${r}`;
    });

  return `You are a professional Landscape Architect. You have been given a satellite aerial image with an alphanumeric grid overlay.

Image legend:
- RED polygon    : project property boundary — ALL placed vertices MUST stay inside this
- BLUE polygon   : house footprint — no features may overlap this
- YELLOW circles : existing tree canopies — planting beds and seating areas MAY be placed beneath or adjacent to these; new shade trees must maintain ≥10 ft clearance from their edges
- ORANGE polygons: existing hardscapes (driveways, walkways, patios) — ABSOLUTE NO-GO ZONE; NO feature of any kind may overlap or touch these
- WHITE grid     : each cell = 10 ft × 10 ft
    Columns: A (west/left) → right
    Rows:    1 (south/bottom) → up

Project context: style="${style ?? 'traditional'}", yard="${yardType ?? 'front'}"

Place the following features in strict priority order (lock placed space before proceeding):
${orderedRules.join('\n')}

Constraints (strictly enforced):
- Every polygon vertex must be inside the RED project boundary
- Minimum 1 ft gap between placed features (exception: shade trees MAY overlap lawn and planting beds)
- ORANGE hardscapes: zero tolerance — no feature vertex may touch or overlap them
- BLUE house: no features may overlap it
- New shade trees only: ≥10 ft clearance from YELLOW canopy edges (planting beds and seating may coexist with existing trees)
- Shade trees have a 20 ft canopy radius — place the tree center accordingly and ensure it stays inside the project boundary

Planting material note:
- Wood mulch is the default ground cover everywhere between features — you do NOT need to draw wood mulch beds
- Only include a planting_bed in the output if it uses rock/gravel material (drainage strips, accent paths, etc.)
- Rock/gravel beds must be ≤25% of the total non-feature area

Return ONLY valid JSON — no markdown, no explanation — matching exactly this schema:
{
  "features": [
    {
      "id": "<feature_type>_1",
      "feature_type": "<one of: ${wanted.join(' | ')}>",
      "polygon": [["<col_letter>", <row_number>], ...]
    }
  ],
  "planting_beds": [
    {
      "id": "bed_1",
      "material": "river_rock",
      "polygon": [["<col_letter>", <row_number>], ...]
    }
  ]
}
Note: planting_beds array should be empty ([]) unless you are placing rock/gravel zones.`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function ringAreaFt(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a) / 2;
}

function centroid(ring: [number, number][]): [number, number] {
  return [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];
}

function parseResponse(
  text: string,
  originFt: [number, number],
  cellFt: number,
  cs: CoordSystem,
): { features: PlacedFeature[]; plantingBeds: PlantingBed[] } {
  console.log('[GeminiLayout] raw response:', text);

  // Extract the first complete JSON object — handles trailing text or extra content
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in Gemini response');
  const clean  = text.slice(start, end + 1);
  const parsed = JSON.parse(clean);
  console.log('[GeminiLayout] parsed:', parsed);

  // Coerce [letter, row] — Gemini sometimes returns row as a string
  const toFtCoord = ([letter, row]: [string, string | number]): [number, number] =>
    gridToFt(letter, Number(row), originFt, cellFt);

  const features: PlacedFeature[] = (parsed.features ?? [])
    .filter((f: any) => {
      // Accept feature_type or type as the key
      const ft = f.feature_type ?? f.type;
      const ok = ft && DEFS[ft] && Array.isArray(f.polygon) && f.polygon.length >= 3;
      if (!ok) console.warn('[GeminiLayout] skipping invalid feature:', f);
      return ok;
    })
    .map((f: any): PlacedFeature => {
      const ft      = f.feature_type ?? f.type;
      const def     = DEFS[ft];
      const ringFt  = (f.polygon as [string, string | number][]).map(toFtCoord);
      const area    = ringAreaFt(ringFt);
      // Trees are always rendered as circles with a fixed 20 ft canopy radius
      const isTree  = ft === 'trees';
      const ringLng = isTree ? undefined : ringFt.map(p => cs.toLngLat(p));
      const treeR   = 20; // ft
      return {
        type:     ft,
        label:    def.label,
        center:   cs.toLngLat(centroid(ringFt)),
        radiusFt: isTree ? treeR : Math.sqrt(Math.max(1, area) / Math.PI),
        areaSqFt: isTree ? Math.round(Math.PI * treeR * treeR) : Math.round(area),
        color:    def.color,
        ...(ringLng ? { polygon: ringLng } : {}),
      };
    });

  console.log('[GeminiLayout] placed features:', features);

  const plantingBeds: PlantingBed[] = (parsed.planting_beds ?? [])
    .filter((b: any) => Array.isArray(b.polygon) && b.polygon.length >= 3)
    .map((b: any): PlantingBed => ({
      type:       'island',
      label:      'Planting Bed',
      ringLngLat: (b.polygon as [string, string | number][]).map(p => cs.toLngLat(toFtCoord(p))),
      tag:        'Mulch_Bed',
    }));

  return { features, plantingBeds };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runGeminiLayout(
  params: GeminiLayoutParams,
): Promise<{ features: PlacedFeature[]; plantingBeds: PlantingBed[] }> {
  if (!params.polygonRing || params.polygonRing.length < 3)
    return { features: [], plantingBeds: [] };

  const { dataUrl, originFt, cellFt, cs } = await buildCanvas(params);
  const base64 = dataUrl.split(',')[1];

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: base64 } },
        { text: buildPrompt(params) },
      ],
    }],
    generationConfig: {
      temperature:      0.2,
      responseMimeType: 'application/json',
    },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Empty response from Gemini layout service');

  return parseResponse(text, originFt, cellFt, cs);
}
