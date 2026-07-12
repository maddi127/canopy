/**
 * Plan Translation Service
 *
 * Converts Gemini's cell-level feature extraction into geo-referenced GeoJSON rings.
 *
 * Pipeline:
 *   A. renderConceptWithGrid  — draw labeled grid on concept canvas → send to Gemini
 *   B. parseCellId / cellCornerToLatLng — map cell IDs to lat/lng
 *   C. traceBoundary + catmullRomClosed — smooth cell boundaries into polygons
 */

// photoGridService was removed; structural stand-in so this legacy module still type-checks.
type PhotoGridResult = any;

const genId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

// ── Public types ──────────────────────────────────────────────────────────────

export interface ExtractedFeature {
  /** Stable unique identifier assigned at extraction time. */
  id: string;
  name: string;
  type: 'area' | 'path' | 'structure' | 'tree';
  /** Grid cell IDs for area/path/structure features, e.g. ["A1", "B1", "A2"] */
  cells?: string[];
  /** For trees: single cell containing the trunk */
  trunkCell?: string;
  /** For trees: canopy radius in feet */
  canopyRadiusFt?: number;
  /** For path-type features: whether Gemini determined the path is straight
   *  (no Catmull-Rom smoothing) vs curved (full smoothing). */
  isStraight?: boolean;
}

// ── Feature identity constants ─────────────────────────────────────────────────

/** Features always included in the color mask regardless of user preferences. */
export const ALWAYS_INCLUDED_FEATURES = ['Walkway', 'Rock Garden'] as const;

/**
 * Maps user preference keys (as stored in localStorage "userPreferences") to
 * the display names used in the color mask and on the map.
 * Only features present in this map are conditionally included.
 */
export const PREF_KEY_TO_FEATURE_NAME: Record<string, string> = {
  lawn:    'Open Lawn',
  seating: 'Seating Area',
  dining:  'Dining Area',
  cooking: 'Cooking Area',
  water:   'Water Feature',
  garden:  'Vegetable Garden',
  trees:   'Shade Trees',
};

export interface GeoFeature {
  /** Links back to the source ExtractedFeature. */
  id: string;
  name: string;
  type: 'area' | 'path' | 'structure' | 'tree';
  /** Exterior ring [lng, lat][], CCW, for area/path/structure features */
  polygonRing?: [number, number][];
  /** Trunk position for trees */
  trunkLatLng?: [number, number];
  canopyRadiusFt?: number;
}

// ── Column label helpers ──────────────────────────────────────────────────────

/**
 * Shrinks an image data URL to at most maxWidth pixels wide (maintains aspect ratio).
 * Used to reduce the payload sent to Gemini for faster mask generation.
 */
export function resizeImageForGemini(dataUrl: string, maxWidth = 512): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const W = Math.round(img.naturalWidth * scale);
      const H = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      canvas.getContext('2d')!.drawImage(img, 0, 0, W, H);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function colToLetter(col: number): string {
  let s = '';
  let n = col + 1;
  while (n > 0) {
    const c = (n - 1) % 26;
    s = String.fromCharCode(65 + c) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function letterToCol(s: string): number {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    col = col * 26 + (s.charCodeAt(i) - 64);
  }
  return col - 1;
}

export function parseCellId(id: string): { col: number; row: number } | null {
  const m = id.trim().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { col: letterToCol(m[1]), row: parseInt(m[2], 10) - 1 };
}

/**
 * Heuristic local walkway-straightness detector — no Gemini call needed.
 * A path is "straight" when its cells form a narrow band: ≤2 distinct columns
 * (vertical run) or ≤2 distinct rows (horizontal run).
 */
export function isWalkwayStraight(cellIds: string[]): boolean {
  if (cellIds.length <= 3) return true;
  const parsed = cellIds.map(parseCellId).filter((c): c is { col: number; row: number } => c !== null);
  const uniqueCols = new Set(parsed.map(c => c.col)).size;
  const uniqueRows = new Set(parsed.map(c => c.row)).size;
  return uniqueCols <= 2 || uniqueRows <= 2;
}

// ── Boundary tracing ──────────────────────────────────────────────────────────

/**
 * Given a list of grid cells, trace the outer boundary polygon in cell-corner space.
 * Returns corners as [col, row] with (0,0) = SW corner of grid.
 *
 * Uses directed-edge tracing with CCW convention (row increases northward).
 */
export function traceBoundary(cells: { col: number; row: number }[]): [number, number][] {
  if (cells.length === 0) return [];
  const cellSet = new Set(cells.map(c => `${c.col},${c.row}`));

  // Build directed edges: start → end (CCW outer boundary)
  const edges = new Map<string, [number, number]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    edges.set(`${x1},${y1}`, [x2, y2]);
  };

  for (const { col: c, row: r } of cells) {
    if (!cellSet.has(`${c + 1},${r}`)) addEdge(c + 1, r,     c + 1, r + 1); // right missing → go up
    if (!cellSet.has(`${c},${r + 1}`)) addEdge(c + 1, r + 1, c,     r + 1); // top missing → go left
    if (!cellSet.has(`${c - 1},${r}`)) addEdge(c,     r + 1, c,     r);     // left missing → go down
    if (!cellSet.has(`${c},${r - 1}`)) addEdge(c,     r,     c + 1, r);     // bottom missing → go right
  }

  if (edges.size === 0) return [];

  // Pick start point
  const firstKey = edges.keys().next().value!;
  const [sx, sy] = firstKey.split(',').map(Number);
  const polygon: [number, number][] = [];
  let cur: [number, number] = [sx, sy];

  for (let i = 0; i <= edges.size; i++) {
    polygon.push([...cur] as [number, number]);
    const next = edges.get(`${cur[0]},${cur[1]}`);
    if (!next) break;
    if (polygon.length > 1 && next[0] === sx && next[1] === sy) break;
    cur = next;
  }

  return polygon;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function removeCollinear(pts: [number, number][]): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 1e-9) result.push(b);
  }
  return result;
}

function catmullRomPoint(
  p0: [number, number], p1: [number, number],
  p2: [number, number], p3: [number, number],
  t: number,
): [number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

/** Smooth a closed polygon with Catmull-Rom spline. */
function catmullRomClosed(pts: [number, number][], samplesPerSegment = 6): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < samplesPerSegment; s++) {
      result.push(catmullRomPoint(p0, p1, p2, p3, s / samplesPerSegment));
    }
  }
  return result;
}

/** Shoelace signed area. Positive = CCW in standard (y-up) coordinates. */
function signedArea(ring: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return area / 2;
}

// ── Cell set → GeoJSON ring ───────────────────────────────────────────────────

function cellsToGeoRing(
  cells: { col: number; row: number }[],
  gridResult: PhotoGridResult,
  samplesPerSegment = 6,
  smooth = true,
): [number, number][] | null {
  const boundary = traceBoundary(cells);
  if (boundary.length < 3) return null;

  const simplified = removeCollinear(boundary);
  if (simplified.length < 3) return null;

  // When smooth=false (e.g. Mulch Bed), keep the sharp cell-grid corners as-is.
  const pts = smooth ? catmullRomClosed(simplified, samplesPerSegment) : simplified;

  const ring: [number, number][] = pts
    .map(([col, row]) => gridResult.cellCornerToLatLng(col, row));

  // Ensure CCW (GeoJSON exterior ring convention)
  if (signedArea(ring) < 0) ring.reverse();

  // Close the ring
  ring.push(ring[0]);
  return ring;
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

/**
 * Draws the concept image onto a canvas with a labeled perspective-correct grid overlay.
 * Returns a JPEG data URL suitable for sending to Gemini.
 */
export function renderConceptWithGrid(
  conceptImageDataUrl: string,
  gridResult: PhotoGridResult,
  outputWidthPx = 900,
  polygonRing?: [number, number][],
  /** When true, fills everything outside the project boundary with solid black.
   *  Use this for the image sent to Gemini mask generation so it cannot paint
   *  exterior features (trees, walkway approaches from the street, etc.). */
  clipToBoundary = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { numCols, numRows, cellCornerToImagePx, projectPoint } = gridResult;
      const aspect = img.naturalWidth / img.naturalHeight;
      const W = outputWidthPx;
      const H = Math.round(W / aspect);

      const canvas = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;

      // Draw image preserving the original photo perspective.
      ctx.drawImage(img, 0, 0, W, H);

      // Grid lines
      const SAMPLES = 8;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth   = 1;

      // Constant-row lines (across columns)
      for (let r = 0; r <= numRows; r++) {
        ctx.beginPath();
        let started = false;
        for (let s = 0; s <= SAMPLES; s++) {
          const col = (s / SAMPLES) * numCols;
          const pt  = cellCornerToImagePx(col, r);
          if (!pt) continue;
          if (!started) { ctx.moveTo(pt[0] * W, pt[1] * H); started = true; }
          else ctx.lineTo(pt[0] * W, pt[1] * H);
        }
        ctx.stroke();
      }

      // Constant-column lines (across rows)
      for (let c = 0; c <= numCols; c++) {
        ctx.beginPath();
        let started = false;
        for (let s = 0; s <= SAMPLES; s++) {
          const row = (s / SAMPLES) * numRows;
          const pt  = cellCornerToImagePx(c, row);
          if (!pt) continue;
          if (!started) { ctx.moveTo(pt[0] * W, pt[1] * H); started = true; }
          else ctx.lineTo(pt[0] * W, pt[1] * H);
        }
        ctx.stroke();
      }

      // Labels
      const fontSize = Math.max(10, Math.round(Math.min(W, H) / 60));
      ctx.font         = `bold ${fontSize}px sans-serif`;
      ctx.fillStyle    = 'rgba(255,255,240,0.92)';
      ctx.shadowColor  = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur   = 3;

      const colStep = Math.max(1, Math.round(numCols / 20));
      const rowStep = Math.max(1, Math.round(numRows / 20));

      // Column labels (A, B, C...) — at south edge (row 0) midpoint of each column.
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      for (let c = 0; c < numCols; c += colStep) {
        const ptL = cellCornerToImagePx(c,     0);
        const ptR = cellCornerToImagePx(c + 1, 0);
        if (!ptL || !ptR) continue;
        const mx = (ptL[0] + ptR[0]) / 2 * W;
        const my = (ptL[1] + ptR[1]) / 2 * H;
        ctx.fillText(colToLetter(c), mx, my + 2);
      }

      // Row labels (1, 2, 3...) — at west edge (col 0) midpoint of each row.
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < numRows; r += rowStep) {
        const ptB = cellCornerToImagePx(0, r);
        const ptT = cellCornerToImagePx(0, r + 1);
        if (!ptB || !ptT) continue;
        const mx = (ptB[0] + ptT[0]) / 2 * W;
        const my = (ptB[1] + ptT[1]) / 2 * H;
        ctx.fillText(String(r + 1), mx - 4, my);
      }

      ctx.shadowBlur = 0;

      // Project boundary — bright green outline so Gemini can clearly see the
      // project area when identifying features.
      if (polygonRing && polygonRing.length >= 3) {
        const verts = polygonRing
          .map(lngLat => projectPoint(lngLat))
          .filter((pt): pt is [number, number] => pt !== null);
        if (verts.length >= 3) {
          // When clipping for mask generation: black out everything outside the
          // boundary before drawing the green line. This prevents Gemini from
          // painting mask colors on exterior features (street-side walkway
          // approach, trees whose canopies extend outside, neighbour's yard, etc).
          if (clipToBoundary) {
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width  = W;
            maskCanvas.height = H;
            const maskCtx = maskCanvas.getContext('2d')!;
            maskCtx.fillStyle = '#000000';
            maskCtx.fillRect(0, 0, W, H);
            maskCtx.globalCompositeOperation = 'destination-out';
            maskCtx.beginPath();
            verts.forEach(([nx, ny], i) => {
              i === 0 ? maskCtx.moveTo(nx * W, ny * H) : maskCtx.lineTo(nx * W, ny * H);
            });
            maskCtx.closePath();
            maskCtx.fill();
            ctx.drawImage(maskCanvas, 0, 0);
          }

          const strokeW = Math.max(3, W * 0.005);
          ctx.beginPath();
          verts.forEach(([nx, ny], i) => {
            i === 0 ? ctx.moveTo(nx * W, ny * H) : ctx.lineTo(nx * W, ny * H);
          });
          ctx.closePath();
          ctx.strokeStyle = 'rgba(22,163,74,1)';
          ctx.lineWidth   = strokeW;
          ctx.setLineDash([strokeW * 3, strokeW * 1.5]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Failed to load concept image for grid rendering'));
    img.src = conceptImageDataUrl;
  });
}

// ── Color mask → grid cell features ──────────────────────────────────────────

/**
 * Color palette for the Gemini segmentation mask.
 *
 * Design constraints (verified exhaustively):
 *   - All 10 colors are primary/secondary hues or half-intensity midpoints of
 *     the RGB cube so no two colors share the same channel values.
 *   - Minimum pairwise Chebyshev distance = 127 (Red↔Orange, Yellow↔Orange,
 *     Yellow↔Lime, Green↔Lime, Blue↔Azure, Cyan↔Azure).
 *   - Tolerance is set to 60, requiring acceptance regions to be ≥ 120 apart.
 *     All borderline pairs (min dist 127) have non-overlapping ±60 regions:
 *     e.g. Red G∈[0,60] vs Orange G∈[68,188] → gap at G=61–67. ✓
 *
 * Black (0,0,0) is reserved for house walls, structures, and non-landscape
 * areas. Cells whose center pixel is black (or matches no color within the
 * tolerance) are NOT assigned to any feature and therefore won't appear on
 * the map.
 *
 * These values MUST match the color descriptions in getConceptColorMask().
 */
const MASK_FEATURES: Array<{
  r: number; g: number; b: number;
  name: string; type: ExtractedFeature['type'];
}> = [
  // Pure RGB-cube primaries (Chebyshev distance 255 between any two)
  { r: 255, g:   0, b:   0, name: 'Walkway',        type: 'path' },
  { r:   0, g: 255, b:   0, name: 'Open Lawn',       type: 'area' },
  { r:   0, g:   0, b: 255, name: 'Seating Area',    type: 'area' },
  { r: 255, g: 255, b:   0, name: 'Dining Area',     type: 'area' },
  { r:   0, g: 255, b: 255, name: 'Water Feature',   type: 'area' },
  { r: 255, g:   0, b: 255, name: 'Rock Garden',     type: 'area' },
  // Half-intensity midpoints (min dist 127 from adjacent primaries, ✓ at tol 60)
  { r: 255, g: 128, b:   0, name: 'Cooking Area',    type: 'area' },
  { r:   0, g: 128, b: 255, name: 'Vegetable Garden', type: 'area' },
  { r: 128, g: 255, b:   0, name: 'Shade Trees',     type: 'area' },
  // Mulch / blank space is NOT a named color — unmatched cells are left
  // unassigned so the map can treat them as the default background material.
];

/**
 * Per-channel Chebyshev tolerance for color matching.
 * Set to 60 so that all 10 palette entries have non-overlapping acceptance
 * regions (verified: the tightest pairs are 127 apart → gap of 7 counts).
 */
const MASK_TOLERANCE = 60;

function nearestMaskFeature(
  r: number, g: number, b: number,
  features: typeof MASK_FEATURES = MASK_FEATURES,
) {
  let best: typeof MASK_FEATURES[0] | null = null;
  let bestDist = Infinity;
  for (const f of features) {
    const dist = Math.max(Math.abs(r - f.r), Math.abs(g - f.g), Math.abs(b - f.b));
    if (dist < bestDist && dist <= MASK_TOLERANCE) { bestDist = dist; best = f; }
  }
  return best;
}

/** Ray-casting point-in-polygon. Ring may be open or closed. */
export function pointInRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Intersects a Gemini-returned color segmentation mask with the photo grid.
 *
 * For each grid cell, samples the pixel color at the cell center in the mask
 * image and assigns the cell to the closest matching feature color. Any cell
 * inside the project boundary that was not matched to a named feature is
 * collected as "Mulch Bed" — Gemini never needs to paint it explicitly.
 *
 * This is the browser-side equivalent of an OpenCV grid-intersection script:
 * no text parsing, no cell-ID misidentification, no grid overlay needed in
 * the image sent to Gemini.
 */
export function maskToFeatures(
  maskDataUrl: string,
  gridResult: PhotoGridResult,
  polygonRing?: [number, number][],
  activeFeatureNames?: string[],
): Promise<ExtractedFeature[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      const { numCols, numRows, cellCornerToImagePx, cellCornerToLatLng } = gridResult;
      const cellsByFeature = new Map<string, { type: ExtractedFeature['type']; cells: string[] }>();
      const mulchCells: string[] = [];

      // Only match colors for features the user actually requested (plus always-included ones).
      const activeSet = activeFeatureNames ? new Set(activeFeatureNames) : null;
      const activeMaskFeatures = activeSet
        ? MASK_FEATURES.filter(f => activeSet.has(f.name))
        : MASK_FEATURES;

      // Read all pixels once — avoids per-cell getImageData overhead (which is ~1ms each)
      const pixels = ctx.getImageData(0, 0, W, H).data;

      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const pt = cellCornerToImagePx(c + 0.5, r + 0.5);
          if (!pt) continue;
          const px = Math.round(pt[0] * W);
          const py = Math.round(pt[1] * H);
          if (px < 0 || px >= W || py < 0 || py >= H) continue;

          const idx = (py * W + px) * 4;
          const feature = nearestMaskFeature(pixels[idx], pixels[idx + 1], pixels[idx + 2], activeMaskFeatures);
          const cellId = `${colToLetter(c)}${r + 1}`;

          if (polygonRing) {
            // When a boundary is provided, filter ALL cells (matched or not)
            // to only those inside it — prevents exterior Gemini paint from
            // appearing on the map (e.g. trees outside the project area).
            const [lng, lat] = cellCornerToLatLng(c + 0.5, r + 0.5);
            if (pointInRing(lng, lat, polygonRing)) {
              if (feature) {
                if (!cellsByFeature.has(feature.name)) {
                  cellsByFeature.set(feature.name, { type: feature.type, cells: [] });
                }
                cellsByFeature.get(feature.name)!.cells.push(cellId);
              } else {
                mulchCells.push(cellId);
              }
            }
          } else if (feature) {
            if (!cellsByFeature.has(feature.name)) {
              cellsByFeature.set(feature.name, { type: feature.type, cells: [] });
            }
            cellsByFeature.get(feature.name)!.cells.push(cellId);
          }
        }
      }

      const results: ExtractedFeature[] = [];
      for (const [name, { type, cells }] of cellsByFeature) {
        if (cells.length > 0) results.push({ id: genId(), name, type, cells });
      }
      if (mulchCells.length > 0) {
        results.push({ id: genId(), name: 'Mulch Bed', type: 'area', cells: mulchCells });
      }
      resolve(results);
    };
    img.onerror = () => reject(new Error('Failed to load color mask image'));
    img.src = maskDataUrl;
  });
}

/**
 * Finds the grid cell whose projected center is nearest to the given
 * normalized image position (0–1, top-left origin).
 * Used to map Gemini-returned trunk coordinates to a grid cell ID.
 *
 * O(1) fast path: uses inverseProjectPoint → cellAtLatLng.
 * Falls back to O(N×M) linear scan only if the inverse transform fails.
 */
export function imagePointToCell(
  normX: number,
  normY: number,
  gridResult: PhotoGridResult,
): { col: number; row: number } | null {
  // Fast path: invert the image projection to get world coords, then O(1) cell lookup.
  const lngLat = gridResult.inverseProjectPoint([normX, normY]);
  if (lngLat) return gridResult.cellAtLatLng(lngLat[0], lngLat[1]);

  // Fallback for degenerate transforms (should be extremely rare).
  const { numCols, numRows, cellCornerToImagePx } = gridResult;
  let best: { col: number; row: number } | null = null;
  let bestDist = Infinity;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const pt = cellCornerToImagePx(c + 0.5, r + 0.5);
      if (!pt) continue;
      const dist = Math.hypot(pt[0] - normX, pt[1] - normY);
      if (dist < bestDist) { bestDist = dist; best = { col: c, row: r }; }
    }
  }
  return best;
}

/**
 * Processes a Gemini color mask where tree canopies are painted LIME (128, 255, 0).
 *
 * Pipeline:
 *   1. Sample each grid cell center in the mask image.
 *   2. Collect cells matching the LIME tree-canopy color (within MASK_TOLERANCE).
 *   3. Split into 4-connected components — one component per distinct tree.
 *   4. Compute the centroid cell of each component as the approximate trunk position.
 *   5. Apply the project boundary filter to the centroid.
 *
 * Returns one ExtractedFeature (type 'tree') per detected tree.
 *
 * Using the IMAGE API color mask (rather than asking the TEXT API for coordinates)
 * is more reliable because Gemini excels at painting regions — the centroid of
 * the painted canopy cluster naturally lands close to the trunk ground position.
 */
export function treeCanopyMaskToTrunks(
  maskDataUrl: string,
  gridResult: PhotoGridResult,
  polygonRing?: [number, number][],
  canopyRadiusFt = 8,
): Promise<ExtractedFeature[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);

      const { numCols, numRows, cellCornerToImagePx, cellCornerToLatLng } = gridResult;

      // Read all pixels once — avoids per-cell getImageData overhead
      const pixels = ctx.getImageData(0, 0, W, H).data;

      // LIME = rgb(128, 255, 0) — the Shade Trees mask color
      const limeCells: { col: number; row: number }[] = [];
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const pt = cellCornerToImagePx(c + 0.5, r + 0.5);
          if (!pt) continue;
          const px = Math.round(pt[0] * W);
          const py = Math.round(pt[1] * H);
          if (px < 0 || px >= W || py < 0 || py >= H) continue;
          const idx = (py * W + px) * 4;
          const dist = Math.max(Math.abs(pixels[idx] - 128), Math.abs(pixels[idx + 1] - 255), Math.abs(pixels[idx + 2] - 0));
          if (dist <= MASK_TOLERANCE) limeCells.push({ col: c, row: r });
        }
      }

      console.log('[treeCanopyMask] lime cells found:', limeCells.length);

      // One connected component = one tree canopy
      const components = connectedComponents(limeCells);
      console.log('[treeCanopyMask] tree clusters:', components.length);

      const results: ExtractedFeature[] = [];
      for (const component of components) {
        if (component.length === 0) continue;

        // Centroid of the cluster → approximate trunk ground position
        const avgCol = component.reduce((s, c) => s + c.col, 0) / component.length;
        const avgRow = component.reduce((s, c) => s + c.row, 0) / component.length;
        const col = Math.round(avgCol);
        const row = Math.round(avgRow);

        const [lng, lat] = cellCornerToLatLng(col + 0.5, row + 0.5);
        if (polygonRing && !pointInRing(lng, lat, polygonRing)) {
          console.log('[treeCanopyMask] cluster centroid outside boundary, skipping');
          continue;
        }

        const cellId = `${colToLetter(col)}${row + 1}`;
        results.push({ id: genId(), name: 'Shade Trees', type: 'tree', trunkCell: cellId, canopyRadiusFt });
      }

      console.log('[treeCanopyMask] final trees:', results);
      resolve(results);
    };
    img.onerror = () => reject(new Error('Failed to load tree canopy mask'));
    img.src = maskDataUrl;
  });
}

// ── Connected-component splitting ─────────────────────────────────────────────

/**
 * Splits a flat cell list into groups of 4-connected cells (sharing an edge).
 * Each group gets its own boundary polygon in translateFeaturesToGeo so that
 * features with multiple disconnected blobs (e.g. two trees, a walkway with a
 * sampled gap) all appear on the map rather than only the first blob.
 */
function connectedComponents(
  cells: { col: number; row: number }[],
): { col: number; row: number }[][] {
  const cellSet = new Set(cells.map(c => `${c.col},${c.row}`));
  const visited = new Set<string>();
  const components: { col: number; row: number }[][] = [];

  for (const cell of cells) {
    const key = `${cell.col},${cell.row}`;
    if (visited.has(key)) continue;

    const component: { col: number; row: number }[] = [];
    // Use a stack (DFS) instead of a queue (BFS) — Array.shift() is O(N),
    // Array.pop() is O(1), so BFS here is accidentally O(N²).
    const stack: { col: number; row: number }[] = [cell];
    visited.add(key);

    while (stack.length > 0) {
      const { col, row } = stack.pop()!;
      component.push({ col, row });
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nk = `${col + dc},${row + dr}`;
        if (cellSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          stack.push({ col: col + dc, row: row + dr });
        }
      }
    }
    components.push(component);
  }
  return components;
}

// ── Main translation export ───────────────────────────────────────────────────

/** Convert Gemini's extracted features to geo-referenced GeoFeature objects. */
export function translateFeaturesToGeo(
  features: ExtractedFeature[],
  gridResult: PhotoGridResult,
): GeoFeature[] {
  const geoFeatures: GeoFeature[] = [];

  for (const feature of features) {
    if (feature.type === 'tree') {
      const cellId = feature.trunkCell;
      if (!cellId) continue;
      const parsed = parseCellId(cellId);
      if (!parsed) continue;
      const trunkLatLng = gridResult.cellCornerToLatLng(parsed.col + 0.5, parsed.row + 0.5);
      geoFeatures.push({
        id: feature.id,
        name: feature.name,
        type: 'tree',
        trunkLatLng,
        canopyRadiusFt: feature.canopyRadiusFt ?? 6,
      });
      continue;
    }

    // Area / path / structure
    const cellIds = feature.cells ?? [];
    if (cellIds.length === 0) continue;

    const cells = cellIds
      .map(id => parseCellId(id))
      .filter((c): c is { col: number; row: number } => c !== null);
    if (cells.length === 0) continue;

    const samplesPerSegment = feature.type === 'path' && feature.isStraight ? 1 : 6;
    // Mulch Bed is background fill — keep sharp cell-grid edges, no smoothing.
    const smooth = feature.name !== 'Mulch Bed';

    // Split into connected components so each disconnected blob (e.g. two
    // separate tree canopies, a walkway with a sampled gap) gets its own
    // polygon rather than only the first blob being traced.
    const components = connectedComponents(cells);
    for (const component of components) {
      const polygonRing = cellsToGeoRing(component, gridResult, samplesPerSegment, smooth);
      if (!polygonRing) continue;
      geoFeatures.push({
        id: feature.id,
        name: feature.name,
        type: feature.type,
        polygonRing,
      });
    }
  }

  return geoFeatures;
}
