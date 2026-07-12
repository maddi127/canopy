// Site Facts — the single perception layer for the DIY flow.
//
// Consolidates ALL site perception (aerial detections, Street View insights, user inputs) into a
// flat list of typed `SiteAnchor`s expressed in the SAME plan-feet coordinate frame the layout
// generator uses. Placement/circulation rules then become pure functions of these facts instead of
// reaching into raw localStorage shapes and re-deriving geometry each time.
//
// Dependency-light on purpose: localStorage + streetViewService only. NO imports from pages or
// components — services importing pages has broken vitest before. Deterministic: no Math.random and
// no Date.now in geometry (a stored ISO `fetchedAt` string is only used for cache-key comparison).

import { getStreetViewInsights, type StreetInsights } from './streetViewService';

// ── Public contract (circulationPlanner codes against this — do not deviate) ──────────────────────

export type FactSource = 'aerial' | 'streetview' | 'user' | 'derived';
export type Confidence = 'high' | 'medium' | 'low';
export type AnchorKind =
  | 'door' | 'sidewalk' | 'driveway' | 'side_gate' | 'porch' | 'mailbox' | 'downspout'
  | 'fence' | 'existing_walkway' | 'existing_bed' | 'existing_tree' | 'house';

export interface SiteAnchor {
  kind: AnchorKind;
  point?: [number, number];                     // plan feet
  line?: [number, number][];                    // plan feet polyline
  ring?: [number, number][];                    // plan feet polygon
  side?: 'left' | 'right' | 'center' | null;    // viewer-at-street-facing-house, where relevant
  confidence: Confidence;
  source: FactSource;
  label?: string;
  meta?: Record<string, any>;
}
export interface SiteFacts { anchors: SiteAnchor[]; version: number }

const SITE_FACTS_VERSION = 1;
const STORE_KEY = 'diySiteFacts';

// StreetInsights is being extended (by a parallel agent) with downspouts/mailbox/porchSteps. Treat
// those as optional so this module compiles + works against BOTH the old and new cached shapes.
type ExtendedInsights = StreetInsights & {
  downspouts?: { position: 'left' | 'center' | 'right' }[];
  mailbox?: { present: boolean; side: 'left' | 'right' | 'center' | null };
  porchSteps?: { present: boolean; side: 'left' | 'right' | 'center' | null };
};

// ── localStorage helpers (never throw) ────────────────────────────────────────────────────────────

function readJSON<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; }
  catch { return null; }
}

type LngLat = [number, number];
type Ring = LngLat[];
interface RawFeature { type?: string; keep?: boolean; vertices?: Ring; label?: string; attributes?: { surfaceType?: string;[k: string]: any } }
interface BoundaryFinal { boundary?: Ring; confirmedFeatures?: RawFeature[]; doorPoint?: LngLat }

// ── Coordinate frame ──────────────────────────────────────────────────────────────────────────────
// EXACT replica of layoutGenerator.buildCS — anchored on the boundary's (minLng, maxLat) so the two
// frames are byte-identical: x = east (ft), y = SOUTH-down (ft) via (maxLat − lat). This MUST stay in
// lockstep with layoutGenerator; if that converter ever changes, change it here too.
function buildCS(verts: Ring) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats);
  const avg = (Math.min(...lats) + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT];
}

// ── Plan-feet geometry helpers ──────────────────────────────────────────────────────────────────────

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
  return Math.abs(a / 2);
}
function centroid(r: Ring): [number, number] {
  let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length];
}
function pointInRing(px: number, py: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Closest point on a polygon/polyline outline to (x,y), with its distance.
function nearestOnRing(x: number, y: number, ring: Ring): { q: [number, number]; d: number } {
  let best: { q: [number, number]; d: number } = { q: [x, y], d: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const qx = a[0] + t * dx, qy = a[1] + t * dy, d = Math.hypot(x - qx, y - qy);
    if (d < best.d) best = { q: [qx, qy], d };
  }
  return best;
}
const minDistRingToRing = (a: Ring, b: Ring): number => Math.min(...a.map(p => nearestOnRing(p[0], p[1], b).d));

// Largest-footprint ring from a set (plan feet).
function largest(rings: Ring[]): Ring | null {
  if (!rings.length) return null;
  let best = rings[0], bA = ringArea(best);
  for (const r of rings) { const a = ringArea(r); if (a > bA) { bA = a; best = r; } }
  return best;
}
// The ring's longest-axis midline: farthest-pair direction through the centroid, spanning the ring's
// projection extent. An approximate "centerline" for a walkway ring.
function longAxisMidline(ring: Ring): [number, number][] {
  const c = centroid(ring);
  let ax = ring[0], bx = ring[0], best = -1;
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    const d = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
    if (d > best) { best = d; ax = ring[i]; bx = ring[j]; }
  }
  let dx = bx[0] - ax[0], dy = bx[1] - ax[1]; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  let sMin = Infinity, sMax = -Infinity;
  for (const v of ring) { const s = (v[0] - c[0]) * dx + (v[1] - c[1]) * dy; if (s < sMin) sMin = s; if (s > sMax) sMax = s; }
  return [[c[0] + dx * sMin, c[1] + dy * sMin], [c[0] + dx * sMax, c[1] + dy * sMax]];
}

// ── Bearing → plan-feet directions (MOVED verbatim from layoutGenerator's side-gate rule) ───────────
// Plan-feet frame: x = east, y = SOUTH (grows downward). A compass bearing θ maps to the unit vector
// (sin θ, −cos θ)  [N:(0,−1) up · E:(1,0) · S:(0,1) down]. B aims pano→house.
const rad = (deg: number) => deg * Math.PI / 180;
const dirOf = (deg: number): [number, number] => [Math.sin(rad(deg)), -Math.cos(rad(deg))];
// house→STREET = reverse bearing B+180 → (−sin B, cos B).
const streetDirOf = (B: number): [number, number] => dirOf(B + 180);
// Side as seen by a viewer at the street facing the house: right = B+90 → (cos B, sin B); left = B−90.
const sideDirOf = (B: number, side: 'left' | 'right' | 'center' | null): [number, number] =>
  dirOf(B + (side === 'left' ? -90 : 90));

// The boundary edge whose midpoint projects farthest along the street direction (the street-side edge).
function streetEdge(boundaryFt: Ring, streetDir: [number, number]): [[number, number], [number, number]] {
  let bestProj = -Infinity, edge: [[number, number], [number, number]] = [boundaryFt[0], boundaryFt[1]];
  for (let i = 0; i < boundaryFt.length; i++) {
    const a = boundaryFt[i], b = boundaryFt[(i + 1) % boundaryFt.length];
    const pr = ((a[0] + b[0]) / 2) * streetDir[0] + ((a[1] + b[1]) / 2) * streetDir[1];
    if (pr > bestProj) { bestProj = pr; edge = [a, b]; }
  }
  return edge;
}
// A point on `edge`, biased ~3/4 toward whichever endpoint is farther along `sideDir` (i.e. the side).
function pointOnEdgeTowardSide(edge: [[number, number], [number, number]], sideDir: [number, number]): [number, number] {
  const [a, b] = edge;
  const pa = a[0] * sideDir[0] + a[1] * sideDir[1], pb = b[0] * sideDir[0] + b[1] * sideDir[1];
  const hi = pa >= pb ? a : b, lo = pa >= pb ? b : a;
  return [hi[0] * 0.75 + lo[0] * 0.25, hi[1] * 0.75 + lo[1] * 0.25];
}

// ── Staleness key ─────────────────────────────────────────────────────────────────────────────────
// Small stable hash of (boundary length + first coord, doorPoint, streetView fetchedAt). Returns null
// when there is no usable boundary (→ getSiteFacts returns null). Rebuild happens when this differs.
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
function staleKey(): string | null {
  const bf = readJSON<BoundaryFinal>('diyBoundaryFinal');
  const boundary = bf?.boundary;
  if (!Array.isArray(boundary) || boundary.length < 3) return null;
  const door = readJSON<LngLat>('diyDoorPoint') ?? bf?.doorPoint ?? null;
  const sv = readJSON<{ result?: { fetchedAt?: string } }>('diyStreetView');
  const first = boundary[0];
  const composed = `${boundary.length}|${first?.[0]},${first?.[1]}|${JSON.stringify(door)}|${sv?.result?.fetchedAt ?? ''}`;
  return fnv(composed);
}

// ── Build ─────────────────────────────────────────────────────────────────────────────────────────

/** Reads localStorage, reconciles all perception into typed plan-feet anchors, persists to
 *  `diySiteFacts`, and returns the facts. Never throws — bad/missing inputs → fewer anchors. */
export function buildSiteFacts(): SiteFacts {
  const facts: SiteFacts = { anchors: [], version: SITE_FACTS_VERSION };
  try {
    const bf = readJSON<BoundaryFinal>('diyBoundaryFinal');
    const boundary = bf?.boundary;
    if (!Array.isArray(boundary) || boundary.length < 3) { persist(facts); return facts; }

    const cs = buildCS(boundary);
    const boundaryFt = boundary.map(v => cs(v[0], v[1])) as Ring;
    const yardC = centroid(boundaryFt);
    const anchors = facts.anchors;

    // ── AERIAL ANCHORS (from kept confirmedFeatures) ──────────────────────────────────────────────
    const houseRings: Ring[] = [];
    let aerialDriveway: SiteAnchor | null = null;
    for (const f of bf?.confirmedFeatures ?? []) {
      if (!f || f.keep === false || !Array.isArray(f.vertices) || f.vertices.length < 3) continue;
      const ring = f.vertices.map(v => cs(v[0], v[1])) as Ring;
      const type = String(f.type ?? '');
      const label = String(f.label ?? '');
      const surf = String(f.attributes?.surfaceType ?? '');
      const text = `${label} ${surf}`.toLowerCase();

      if (type === 'house') {
        houseRings.push(ring);
        anchors.push({ kind: 'house', ring, confidence: 'high', source: 'aerial', label: label || 'House' });
      } else if (type === 'tree') {
        const c = centroid(ring);
        const radius = ring.reduce((s, v) => s + Math.hypot(v[0] - c[0], v[1] - c[1]), 0) / ring.length;
        anchors.push({ kind: 'existing_tree', point: c, ring, confidence: 'high', source: 'aerial', label: label || 'Tree', meta: { radius } });
      } else if (type === 'bed' || /\bbed\b/.test(text)) {
        anchors.push({ kind: 'existing_bed', ring, confidence: 'high', source: 'aerial', label: label || 'Planting bed' });
      } else if (type === 'hardscape') {
        if (text.includes('driveway')) {
          const a: SiteAnchor = { kind: 'driveway', ring, confidence: 'high', source: 'aerial', label: label || 'Driveway' };
          anchors.push(a);
          if (!aerialDriveway || ringArea(ring) > ringArea(aerialDriveway.ring!)) aerialDriveway = a;
        } else if (text.includes('walkway') || text.includes('sidewalk') || text.includes('path')) {
          const nearsBoundary = minDistRingToRing(ring, boundaryFt) < 4; // touches/nears the property line
          if (text.includes('sidewalk') || nearsBoundary) {
            anchors.push({ kind: 'sidewalk', ring, confidence: 'high', source: 'aerial', label: label || 'Sidewalk' });
          } else {
            anchors.push({ kind: 'existing_walkway', ring, line: longAxisMidline(ring), confidence: 'high', source: 'aerial', label: label || 'Walkway' });
          }
        }
        // Other hardscape (patios/decks) has no circulation AnchorKind — intentionally not emitted.
      }
    }

    // ── USER ANCHORS ──────────────────────────────────────────────────────────────────────────────
    const doorLL = readJSON<LngLat>('diyDoorPoint') ?? bf?.doorPoint ?? null;
    let doorFt: [number, number] | null = null;
    if (Array.isArray(doorLL) && doorLL.length === 2 && typeof doorLL[0] === 'number' && typeof doorLL[1] === 'number') {
      doorFt = cs(doorLL[0], doorLL[1]);
      anchors.push({ kind: 'door', point: doorFt, confidence: 'high', source: 'user', label: 'Front door' });
    }

    // ── STREET VIEW ANCHORS (front yards only; insights present) ──────────────────────────────────
    const site = readJSON<{ yard_type?: string }>('siteContext');
    const sv = readJSON<{ result?: { heading?: number } }>('diyStreetView');
    const B = sv?.result?.heading;
    const insights = getStreetViewInsights() as ExtendedInsights | null;
    const houseRing = largest(houseRings);

    if (site?.yard_type === 'front' && insights && typeof B === 'number') {
      const streetDir = streetDirOf(B);

      // side_gate — extreme house vertex on the gate side + 4ft·sideDir + 3ft·streetDir. Clamp: if the
      // anchor lands outside the boundary, still emit it but drop confidence to 'low'.
      const gate = insights.sideGate;
      if (gate?.present && (gate.side === 'left' || gate.side === 'right') && houseRing) {
        const sideDir = sideDirOf(B, gate.side);
        let ext = houseRing[0], extProj = -Infinity;
        for (const v of houseRing) { const pr = v[0] * sideDir[0] + v[1] * sideDir[1]; if (pr > extProj) { extProj = pr; ext = v; } }
        const point: [number, number] = [ext[0] + sideDir[0] * 4 + streetDir[0] * 3, ext[1] + sideDir[1] * 4 + streetDir[1] * 3];
        const inside = pointInRing(point[0], point[1], boundaryFt);
        anchors.push({ kind: 'side_gate', point, side: gate.side, confidence: inside ? 'medium' : 'low', source: 'streetview', label: 'Side gate', meta: { clamped: !inside } });
      }

      // porch — a point offset from the door toward the street.
      const porchPresent = insights.frontPorch?.present || insights.porchSteps?.present;
      if (porchPresent && doorFt) {
        const point: [number, number] = [doorFt[0] + streetDir[0] * 6, doorFt[1] + streetDir[1] * 6];
        anchors.push({ kind: 'porch', point, side: insights.porchSteps?.side ?? null, confidence: 'medium', source: 'streetview', label: 'Front porch' });
      }

      // mailbox — a point on the street-side boundary edge, biased toward its side.
      if (insights.mailbox?.present) {
        const side = insights.mailbox.side ?? null;
        const edge = streetEdge(boundaryFt, streetDir);
        const point = side ? pointOnEdgeTowardSide(edge, sideDirOf(B, side)) : [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2] as [number, number];
        anchors.push({ kind: 'mailbox', point, side, confidence: 'medium', source: 'streetview', label: 'Mailbox' });
      }

      // downspout(s) — points along the house's street-facing wall at left/center/right thirds.
      if (houseRing && Array.isArray(insights.downspouts) && insights.downspouts.length) {
        // Street-facing wall = house edge whose midpoint projects farthest along streetDir.
        let bestPr = -Infinity, wall: [[number, number], [number, number]] = [houseRing[0], houseRing[1]];
        for (let i = 0; i < houseRing.length; i++) {
          const a = houseRing[i], b = houseRing[(i + 1) % houseRing.length];
          const pr = ((a[0] + b[0]) / 2) * streetDir[0] + ((a[1] + b[1]) / 2) * streetDir[1];
          if (pr > bestPr) { bestPr = pr; wall = [a, b]; }
        }
        // Order the wall left→right as a street-facing viewer sees it (right = higher rightDir proj).
        const rightDir = sideDirOf(B, 'right');
        let [lw, rw] = wall;
        if (lw[0] * rightDir[0] + lw[1] * rightDir[1] > rw[0] * rightDir[0] + rw[1] * rightDir[1]) { const t = lw; lw = rw; rw = t; }
        const at = (t: number): [number, number] => [lw[0] + (rw[0] - lw[0]) * t, lw[1] + (rw[1] - lw[1]) * t];
        const third: Record<'left' | 'center' | 'right', number> = { left: 1 / 6, center: 1 / 2, right: 5 / 6 };
        for (const d of insights.downspouts) {
          const pos = d?.position;
          if (pos !== 'left' && pos !== 'center' && pos !== 'right') continue;
          anchors.push({ kind: 'downspout', point: at(third[pos]), side: pos, confidence: 'medium', source: 'streetview', label: 'Downspout', meta: { position: pos } });
        }
      }

      // fence — presence only (no usable geometry): a metadata-carrying anchor, no line/ring.
      if (insights.fence?.present) {
        anchors.push({ kind: 'fence', confidence: 'medium', source: 'streetview', label: 'Fence', meta: { present: true, material: insights.fence.material ?? null } });
      }

      // driveway (Street View side) + RECONCILIATION with any aerial driveway ring.
      const dw = insights.driveway;
      if (dw?.present && (dw.side === 'left' || dw.side === 'right')) {
        const sideDir = sideDirOf(B, dw.side);
        if (aerialDriveway && aerialDriveway.ring) {
          // Agree iff the aerial ring's centroid sits on the Street-View side relative to yard centre.
          const c = centroid(aerialDriveway.ring);
          const agreed = (c[0] - yardC[0]) * sideDir[0] + (c[1] - yardC[1]) * sideDir[1] > 0;
          if (agreed) {
            aerialDriveway.confidence = 'high';
            aerialDriveway.source = 'derived';
            aerialDriveway.meta = { ...(aerialDriveway.meta ?? {}), agreed: true, side: dw.side };
          } else {
            // Disagree → downgrade the ring, keep both (also emit the Street-View-derived point).
            aerialDriveway.confidence = 'medium';
            aerialDriveway.meta = { ...(aerialDriveway.meta ?? {}), agreed: false };
            anchors.push({ kind: 'driveway', point: pointOnEdgeTowardSide(streetEdge(boundaryFt, streetDir), sideDir), side: dw.side, confidence: 'medium', source: 'streetview', label: 'Driveway' });
          }
        } else {
          // No aerial driveway ring → derive a point at the street edge on that side.
          anchors.push({ kind: 'driveway', point: pointOnEdgeTowardSide(streetEdge(boundaryFt, streetDir), sideDir), side: dw.side, confidence: 'medium', source: 'streetview', label: 'Driveway' });
        }
      }
    }
  } catch { /* any perception failure → return whatever anchors we built; never throw */ }

  persist(facts);
  return facts;
}

function persist(facts: SiteFacts): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ facts, key: staleKey() })); }
  catch { /* quota / unavailable — non-fatal */ }
}

/** Persisted facts, REBUILT when the staleness key differs. Null when there is no boundary. */
export function getSiteFacts(): SiteFacts | null {
  const key = staleKey();
  if (key === null) return null;                 // no usable boundary yet
  const persisted = readJSON<{ facts?: SiteFacts; key?: string }>(STORE_KEY);
  if (persisted?.facts && persisted.key === key) return persisted.facts;
  return buildSiteFacts();
}

/** All anchors of a given kind. */
export function factsOf(facts: SiteFacts, kind: AnchorKind): SiteAnchor[] {
  return facts.anchors.filter(a => a.kind === kind);
}
