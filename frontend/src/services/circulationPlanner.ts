// Circulation (walkway) planner. Models the yard's circulation as a desire-line graph over the
// site-facts model (door, sidewalk, driveway, side gate, gathering zones) and routes ALL walkways
// from it deterministically — each with a human-readable `reason`. There is NO randomness here:
// nodes, edges, ordering, routing and style geometry are all fully determined by the input, so the
// same site always produces byte-identical paths.
//
// Geometry is PLAN FEET (x = east, y = SOUTH-down) — the exact frame layoutGenerator works in.
//
// AUTO-PLACE policy: realize edges whose governing anchors are 'high' OR 'medium' confidence; skip
// 'low' silently. Users delete what they don't want; we never gate a walkway behind a suggestion.

import type { PlanPath } from './layoutGenerator';
import type { SiteFacts, SiteAnchor, AnchorKind } from './siteFacts';

type Pt = [number, number];
type Box = { minX: number; minY: number; maxX: number; maxY: number };

export interface CirculationInput {
  boundaryFt: [number, number][];
  houseRing: [number, number][] | null;
  zones: any[];                 // the generator's placed zones (key/label/xFt/yFt/wFt/hFt/shape)
  existingPaths: any[];         // paths already in the plan (do not duplicate)
  facts: SiteFacts;             // from siteFacts
  style: string;                // dbStyle: traditional | modern_structured | natural_wild | desert_minimal
  yardType: 'front' | 'back';
}

// ── Small geometry helpers ─────────────────────────────────────────────────────────
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
function closeRing(r: Pt[]): Pt[] { const f = r[0], l = r[r.length - 1]; return (f && l && f[0] === l[0] && f[1] === l[1]) ? r : [...r, r[0]]; }
function centroid(r: Pt[]): Pt { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; }
function nearestOnSeg(p: Pt, a: Pt, b: Pt): { q: Pt; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const q: Pt = [a[0] + t * dx, a[1] + t * dy]; return { q, d: dist(p, q) };
}
// Nearest point on a polyline (or a single point when pts.length === 1).
function nearestOnPts(p: Pt, pts: Pt[]): { q: Pt; d: number } {
  if (!pts.length) return { q: p, d: Infinity };
  if (pts.length === 1) return { q: pts[0], d: dist(p, pts[0]) };
  let best = { q: pts[0], d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) { const r = nearestOnSeg(p, pts[i], pts[i + 1]); if (r.d < best.d) best = r; }
  return best;
}
// A SiteAnchor may carry a line, a ring, and/or a single point — collect all as polylines.
function anchorGeoms(a: SiteAnchor): Pt[][] {
  const g: Pt[][] = [];
  if (a.line && a.line.length >= 2) g.push(a.line);
  if (a.ring && a.ring.length >= 2) g.push(closeRing(a.ring));
  if (a.point) g.push([a.point]);
  return g;
}
function nearestOnAnchor(p: Pt, a: SiteAnchor): { q: Pt; d: number } {
  let best = { q: p, d: Infinity };
  for (const g of anchorGeoms(a)) { const r = nearestOnPts(p, g); if (r.d < best.d) best = r; }
  return best;
}
function nearestAcross(p: Pt, as: SiteAnchor[]): { q: Pt; d: number } {
  let best = { q: p, d: Infinity };
  for (const a of as) { const r = nearestOnAnchor(p, a); if (r.d < best.d) best = r; }
  return best;
}
function anchorsOf(f: SiteFacts, k: AnchorKind): SiteAnchor[] { return f.anchors.filter(a => a.kind === k); }
const rank = (c: string): number => (c === 'high' ? 2 : c === 'medium' ? 1 : 0);  // realize when >= 1

// The ring's longest-axis midline: farthest-pair direction through the centroid, spanning the ring's
// projection extent — an approximate "centerline" for a walkway ring (mirrors siteFacts.longAxisMidline).
function longAxisMidline(ring: Pt[]): Pt[] {
  const c = centroid(ring);
  let ax = ring[0], bx = ring[0], best = -1;
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    const d = dist(ring[i], ring[j]); if (d > best) { best = d; ax = ring[i]; bx = ring[j]; }
  }
  let dx = bx[0] - ax[0], dy = bx[1] - ax[1]; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  let sMin = Infinity, sMax = -Infinity;
  for (const v of ring) { const s = (v[0] - c[0]) * dx + (v[1] - c[1]) * dy; if (s < sMin) sMin = s; if (s > sMax) sMax = s; }
  return [[c[0] + dx * sMin, c[1] + dy * sMin], [c[0] + dx * sMax, c[1] + dy * sMax]];
}
// A walkway anchor's centerline: its stored `line`, else the ring's long-axis midline, else null.
function centerlineOf(a: SiteAnchor): Pt[] | null {
  if (a.line && a.line.length >= 2) return a.line as Pt[];
  if (a.ring && a.ring.length >= 3) return longAxisMidline(a.ring as Pt[]);
  return null;
}
function dirUnit(a: Pt, b: Pt): Pt { let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; }
function polyLen(pts: Pt[]): number { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]); return s; }
// Sample a polyline every ~`step` ft (endpoints always included).
function samplePolyline(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = dist(a, b), n = Math.max(1, Math.floor(L / step));
    for (let k = 1; k <= n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// The zone-outline point on its YARD side: farthest from the house ring (fallback: farthest from the door).
function farthestEntry(zoneClosed: Pt[], houseClosed: Pt[] | null, door: Pt | null): Pt {
  const cand: Pt[] = [];
  for (let i = 0; i < zoneClosed.length - 1; i++) { const a = zoneClosed[i], b = zoneClosed[i + 1]; cand.push(a); cand.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  let best = cand[0], bd = -Infinity;
  for (const c of cand) { const d = houseClosed ? nearestOnPts(c, houseClosed).d : (door ? dist(c, door) : 0); if (d > bd) { bd = d; best = c; } }
  return best;
}

// Does segment p→q overlap the axis-aligned box? Liang–Barsky slab clip: clip t∈[0,1] to the box;
// a non-empty [t0,t1] means they intersect.
function segIntersectsBox(p: Pt, q: Pt, minX: number, minY: number, maxX: number, maxY: number): boolean {
  let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
  const clip = (pv: number, qv: number): boolean => {
    if (pv === 0) return qv >= 0;
    const r = qv / pv;
    if (pv < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (clip(-dx, p[0] - minX) && clip(dx, maxX - p[0]) && clip(-dy, p[1] - minY) && clip(dy, maxY - p[1])) return t0 <= t1;
  return false;
}
function ringBox(r: Pt[], pad = 0): Box { const xs = r.map(p => p[0]), ys = r.map(p => p[1]); return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad }; }
function zoneBox(z: any, pad = 0): Box { return { minX: z.xFt - pad, minY: z.yFt - pad, maxX: z.xFt + z.wFt + pad, maxY: z.yFt + z.hFt + pad }; }
function zoneRing(z: any): Pt[] { return [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]]; }
// The zone's ACTUAL drawn outline (approx): circle/organic zones render as (wobbly) ellipses
// inscribed in their bbox — paths targeting the bbox edge stop visibly short of the pad. 16-point
// ellipse for those; the rect ring otherwise.
function zoneOutline(z: any): Pt[] {
  if (z.shape === 'circle' || z.shape === 'organic') {
    const cx = z.xFt + z.wFt / 2, cy = z.yFt + z.hFt / 2, a = z.wFt / 2, b = z.hFt / 2;
    const pts: Pt[] = [];
    for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; pts.push([cx + a * Math.cos(t), cy + b * Math.sin(t)]); }
    return pts;
  }
  return zoneRing(z);
}
const zoneCenter = (z: any): Pt => [z.xFt + z.wFt / 2, z.yFt + z.hFt / 2];
// Tuck a boundary point slightly INSIDE the zone so the path visually meets the pad.
function pullInward(p: Pt, center: Pt, byFt: number): Pt {
  const d = dist(p, center); if (d <= byFt) return p;
  const t = byFt / d; return [p[0] + (center[0] - p[0]) * t, p[1] + (center[1] - p[1]) * t];
}
function ptInBox(p: Pt, b: Box): boolean { return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY; }
const shrink = (b: Box, e: number): Box => ({ minX: b.minX + e, minY: b.minY + e, maxX: b.maxX - e, maxY: b.maxY - e });
const segCrossesBox = (a: Pt, b: Pt, box: Box): boolean => segIntersectsBox(a, b, box.minX, box.minY, box.maxX, box.maxY);

// Route a→b AROUND a single obstacle box (already expanded for clearance). Straight when it doesn't
// cross; else the shortest single-corner dogleg whose legs stay outside the box; else the shortest
// two-corner go-around (needed when a and b sit on opposite sides of the box). Determinism: corners
// are visited in a fixed order and ties keep the first (strict <).
function goAround(a: Pt, b: Pt, box: Box): Pt[] {
  const sb = shrink(box, 0.5);                    // slight shrink so travelling to/along edges & corners doesn't "cross"
  if (!segCrossesBox(a, b, sb)) return [a, b];
  const c: Pt[] = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
  let best: Pt | null = null, bl = Infinity;
  for (const corner of c) {
    if (!segCrossesBox(a, corner, sb) && !segCrossesBox(corner, b, sb)) { const len = dist(a, corner) + dist(corner, b); if (len < bl) { bl = len; best = corner; } }
  }
  if (best) return [a, best, b];
  let pair: [Pt, Pt] | null = null, bl2 = Infinity;
  for (let i = 0; i < 4; i++) {
    const edgePair: [Pt, Pt][] = [[c[i], c[(i + 1) % 4]], [c[(i + 1) % 4], c[i]]];
    for (const [p1, p2] of edgePair) {
      if (!segCrossesBox(a, p1, sb) && !segCrossesBox(p1, p2, sb) && !segCrossesBox(p2, b, sb)) {
        const len = dist(a, p1) + dist(p1, p2) + dist(p2, b); if (len < bl2) { bl2 = len; pair = [p1, p2]; }
      }
    }
  }
  if (pair) return [a, pair[0], pair[1], b];
  return [a, b];   // give up — no rectilinear go-around found
}

// Route one edge: straight, unless it crosses the house (expanded box) or a zone bbox (expanded 2ft).
// Boxes that CONTAIN an endpoint are skipped — e.g. the door lies on the house, so house never blocks
// a path leaving the door. We route around EVERY crossing box, not just the first: each pass detours
// the first box a segment crosses, then re-checks the new segments, so a path that would cut across
// both the lawn and the water feature edges around both (up to a fixed iteration cap for termination).
function routeEdge(a: Pt, b: Pt, houseBox: Box | null, zoneBoxes: Box[]): Pt[] {
  const obs: Box[] = [];
  if (houseBox && !ptInBox(a, houseBox) && !ptInBox(b, houseBox)) obs.push(houseBox);
  for (const zb of zoneBoxes) if (!ptInBox(a, zb) && !ptInBox(b, zb)) obs.push(zb);
  if (!obs.length) return [a, b];
  let pts: Pt[] = [a, b];
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    const next: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i], e = pts[i + 1];
      let hit: Box | null = null;
      for (const box of obs) {
        if (ptInBox(s, box) || ptInBox(e, box)) continue;
        if (segCrossesBox(s, e, shrink(box, 0.5))) { hit = box; break; }
      }
      if (hit) { const seg = goAround(s, e, hit); for (let k = 1; k < seg.length; k++) next.push(seg[k]); changed = true; }
      else next.push(e);
    }
    pts = next;
    if (!changed) break;
  }
  return pts;
}

type Style = 'modern' | 'traditional' | 'natural' | 'desert';
function normStyle(s: string): Style {
  const k = (s || '').toLowerCase();
  if (k.includes('modern')) return 'modern';
  if (k.includes('desert')) return 'desert';
  if (k.includes('wild') || k.includes('natural') || k.includes('whimsical')) return 'natural';
  return 'traditional';
}

// STYLE GEOMETRY. modern → orthogonal (snap a dogleg corner to a 90° L). traditional/natural → one
// gentle midpoint bow on straight runs (perpendicular offset min(3ft, 12% length), toward the yard
// centroid). desert → straight. All deterministic.
function applyStyle(pts: Pt[], style: Style, yardC: Pt, obstacles: Box[] = []): { pts: Pt[]; winding: boolean } {
  if ((style === 'traditional' || style === 'natural') && pts.length === 2) {
    const a = pts[0], b = pts[1], len = dist(a, b);
    if (len > 4) {
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, px = -uy, py = ux;
      const off = Math.min(3, 0.12 * len);
      const plus: Pt = [mid[0] + px * off, mid[1] + py * off];
      const minus: Pt = [mid[0] - px * off, mid[1] - py * off];
      // Prefer bowing toward the yard centroid (the classic look) — but NEVER arc the path into a zone.
      // The lawn sits at the centroid, so the naive centroid-bow would curve the walkway straight into
      // it; bow the OTHER way if that side is clear, else keep it straight (edge the lawn, don't bisect).
      // Zones already containing an endpoint are ignored (a path legitimately meeting a zone's edge).
      const relevant = obstacles.filter(box => !ptInBox(a, box) && !ptInBox(b, box));
      const bowsInto = (m: Pt) => relevant.some(box => ptInBox(m, box) || segCrossesBox(a, m, box) || segCrossesBox(m, b, box));
      const toward = dist(plus, yardC) <= dist(minus, yardC) ? plus : minus;
      const away = toward === plus ? minus : plus;
      const bow = !bowsInto(toward) ? toward : (!bowsInto(away) ? away : null);
      if (bow) return { pts: [a, bow, b], winding: true };
      return { pts, winding: false };   // both offsets would enter a zone → keep it straight
    }
  }
  if (style === 'modern' && pts.length === 3) {
    const a = pts[0], b = pts[2], corner = pts[1];
    const o1: Pt = [b[0], a[1]], o2: Pt = [a[0], b[1]];
    const orth = dist(o1, corner) <= dist(o2, corner) ? o1 : o2;            // snap the dogleg to the nearer right-angle
    return { pts: [a, orth, b], winding: false };
  }
  return { pts, winding: false };
}

export function planCirculation(input: CirculationInput): PlanPath[] {
  const { boundaryFt, houseRing, zones, existingPaths, facts, yardType } = input;
  const style = normStyle(input.style);
  const yardC = boundaryFt.length ? centroid(boundaryFt) : [0, 0] as Pt;
  const houseBox = (houseRing && houseRing.length >= 3) ? ringBox(houseRing, 3) : null;     // primary edges (a/b/c) may approach the house
  const houseBox6 = (houseRing && houseRing.length >= 3) ? ringBox(houseRing, 6) : null;    // secondary (gathering) edges swing into the yard
  const houseRingClosed = (houseRing && houseRing.length >= 3) ? closeRing(houseRing as Pt[]) : null;

  // Growing "realized network" of walkway polylines (existing plan paths + everything we add).
  const network: Pt[][] = [];
  for (const p of existingPaths || []) if (Array.isArray(p?.pts) && p.pts.length >= 2) network.push(p.pts as Pt[]);
  const distToNetwork = (p: Pt): number => { let m = Infinity; for (const poly of network) { const r = nearestOnPts(p, poly); if (r.d < m) m = r.d; } return m; };
  const bothNear = (a: Pt, b: Pt): boolean => distToNetwork(a) <= 4 && distToNetwork(b) <= 4;   // dedupe: both ends already on the network

  // Material: match the existing front walkway (from an existing_walkway anchor's meta, else an
  // existing walkway plan path) when one exists, else the per-style default.
  const ewAnchors = anchorsOf(facts, 'existing_walkway');
  const ewMat = ewAnchors.map(a => a.meta?.material).find(m => typeof m === 'string') as string | undefined;
  const fwPath = (existingPaths || []).find((p: any) => /walkway/i.test(p?.label || '') || p?.kind === 'walkway');
  const defMat = style === 'modern' ? 'concrete' : style === 'desert' ? 'gravel' : 'flagstone';
  const material = ewMat || (fwPath?.material as string) || defMat;

  const doorA = anchorsOf(facts, 'door')[0];
  const door: Pt | null = doorA?.point ?? null;
  const sidewalks = anchorsOf(facts, 'sidewalk');
  const driveways = anchorsOf(facts, 'driveway');

  // ── Private-walkway anchors = existing_walkway + "walkway-ish" sidewalk anchors: ones whose long
  // axis runs roughly PERPENDICULAR to the street (private front walks the aerial mislabeled as
  // 'sidewalk'), NOT the public street-parallel sidewalk. Street direction = the longest sidewalk's axis.
  let streetDir: Pt | null = null, streetLen = -1;
  for (const s of sidewalks) { const cl = centerlineOf(s); if (!cl) continue; const L = dist(cl[0], cl[cl.length - 1]); if (L > streetLen) { streetLen = L; streetDir = dirUnit(cl[0], cl[cl.length - 1]); } }
  const walkwayish = sidewalks.filter(s => { const cl = centerlineOf(s); if (!cl || !streetDir) return false; const u = dirUnit(cl[0], cl[cl.length - 1]); return Math.abs(u[0] * streetDir[0] + u[1] * streetDir[1]) < 0.5; });
  const privateWalks: SiteAnchor[] = [...ewAnchors, ...walkwayish];
  const overlapGeoms: Pt[][] = [];
  for (const a of privateWalks) for (const g of anchorGeoms(a)) overlapGeoms.push(g);
  // Overlap guard: a NEW path that mostly (>50% of its ~3ft samples) hugs an existing private walkway
  // duplicates something the user already has → drop it. (The public street-parallel sidewalk is
  // excluded, since a front walkway legitimately meets it at one end.) Samples within the first 8ft
  // of the path are EXEMPT — paths that legitimately originate ON a walkway (side-gate, gathering
  // branches) would otherwise fail the test purely because of where they start.
  const overlapsExisting = (pts: Pt[]): boolean => {
    if (!overlapGeoms.length) return false;
    const samples = samplePolyline(pts, 3);
    let near = 0, eligible = 0, arc = 0;
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) arc += dist(samples[i - 1], samples[i]);
      if (arc <= 8) continue;                                  // origin-adjacent — exempt
      eligible++;
      let d = Infinity; for (const g of overlapGeoms) { const r = nearestOnPts(samples[i], g); if (r.d < d) d = r.d; }
      if (d <= 6) near++;
    }
    if (eligible < 3) return false;                            // too short to judge — connectors are fine
    return near > eligible * 0.5;
  };

  const out: PlanPath[] = [];
  let idn = 0;
  const realize = (spec: { key: string; label: string; reason: string; a: Pt; b: Pt; primary: boolean; ignoreZone?: any; widthOverride?: number; materialOverride?: string; houseBoxOverride?: Box | null; skipGuard?: boolean }): boolean => {
    const zoneBoxes = (zones || []).filter(z => z !== spec.ignoreZone).map(z => zoneBox(z, 2));
    const hb = spec.houseBoxOverride !== undefined ? spec.houseBoxOverride : houseBox;
    const routed = routeEdge(spec.a, spec.b, hb, zoneBoxes);
    const styled = applyStyle(routed, style, yardC, hb ? [hb, ...zoneBoxes] : zoneBoxes);
    if (!spec.skipGuard && overlapsExisting(styled.pts)) return false;   // duplicates an existing private walkway
    out.push({ id: `circ_${spec.key}_${idn++}`, label: spec.label, startId: 'auto', endId: 'auto', pts: styled.pts, style: styled.winding ? 'winding' : 'straight', material: spec.materialOverride ?? material, widthFt: spec.widthOverride ?? (spec.primary ? 4 : 3), kind: 'walkway', reason: spec.reason });
    network.push(styled.pts);
    return true;
  };

  // ── Serve-test: does an existing private walkway already POINT AT the door? Take its centerline,
  // find the END nearer the door, extend that end's outward direction, and check whether the door is
  // within ~8ft laterally of that extended line AND within ~20ft of the end. If so the walkway serves
  // the door: gap>4ft → emit a short CONNECTOR (end→door); gap≤4ft → nothing. When served, edge (a)
  // must NOT place a full new front walkway (and, for symmetry, edge (b) still runs its overlap guard).
  let doorServed = false;
  if (door) {
    for (const a of privateWalks) {                     // deterministic: first serving walkway wins
      const cl = centerlineOf(a);
      if (!cl) continue;
      const i0 = dist(cl[0], door) <= dist(cl[cl.length - 1], door) ? 0 : cl.length - 1;   // end nearer the door
      const end = cl[i0];
      const adj = cl[i0 === 0 ? 1 : cl.length - 2];      // neighbour → outward direction at that end
      const dir = dirUnit(adj, end);
      const vx = door[0] - end[0], vy = door[1] - end[1];
      const along = vx * dir[0] + vy * dir[1];           // projection along the extended centerline
      const lat = Math.abs(vx * -dir[1] + vy * dir[0]);  // perpendicular (lateral) offset from that line
      const gap = Math.hypot(vx, vy);                    // end → door
      if (along >= -2 && lat <= 8 && gap <= 20) {
        doorServed = true;
        if (gap > 4) {
          const mat = (typeof a.meta?.material === 'string' ? a.meta!.material : material) as string;
          const w = typeof a.meta?.width === 'number' ? a.meta!.width : 4;
          realize({ key: 'connector', label: 'Front walkway connector', reason: 'Extends your existing walkway to the front door', a: end, b: door, primary: true, widthOverride: w, materialOverride: mat, skipGuard: true });
        }
        break;
      }
    }
  }

  // ── (a) door ↔ sidewalk — the front walkway (only when NO existing walkway serves the door) ──────
  if (door && doorA && rank(doorA.confidence) >= 1 && sidewalks.length && !doorServed && distToNetwork(door) >= 6) {
    const near = nearestAcross(door, sidewalks);
    const swConf = Math.max(...sidewalks.map(s => rank(s.confidence)));
    if (near.d < Infinity && swConf >= 1 && !bothNear(door, near.q))
      realize({ key: 'front', label: 'Front walkway', reason: 'Connects your front door to the sidewalk', a: door, b: near.q, primary: true });
  }

  // Min distance from an anchor's geometry to any existing walkway (anchor or network).
  const anchorNearWalkways = (a: SiteAnchor): number => {
    let m = Infinity;
    for (const g of anchorGeoms(a)) for (const p of g) {
      if (ewAnchors.length) { const r = nearestAcross(p, ewAnchors); if (r.d < m) m = r.d; }
      const dn = distToNetwork(p); if (dn < m) m = dn;
    }
    return m;
  };

  // ── (b) door ↔ driveway (overlap guard drops it if it duplicates an existing walkway) ────────────
  if (door && doorA && rank(doorA.confidence) >= 1 && driveways.length) {
    const near = nearestAcross(door, driveways);
    const dvConf = Math.max(...driveways.map(d => rank(d.confidence)));
    const dvNear = Math.min(...driveways.map(anchorNearWalkways));            // skip if driveway already touches/near a walkway
    if (near.d < Infinity && dvConf >= 1 && dvNear >= 6 && !bothNear(door, near.q))
      realize({ key: 'driveway', label: 'Driveway path', reason: 'Links the door to your driveway', a: door, b: near.q, primary: true });
  }

  // ── (c) sidewalk-or-front-walkway ↔ side gate (front yards; subsumes the old side-gate rule) ──
  if (yardType === 'front') {
    const gate = anchorsOf(facts, 'side_gate').find(g => g.point && rank(g.confidence) >= 1);
    if (gate?.point) {
      let start: Pt | null = null;
      if (sidewalks.length) { const r = nearestAcross(gate.point, sidewalks); if (r.d < Infinity) start = r.q; }   // prefer the street side
      if (!start) { let m = Infinity; for (const poly of network) { const r = nearestOnPts(gate.point, poly); if (r.d < m) { m = r.d; start = r.q; } } }
      if (start && !bothNear(start, gate.point))
        realize({ key: 'sidegate', label: 'Path to side gate', reason: 'Path to the side gate we spotted in Street View', a: start, b: gate.point, primary: false });
    }
  }

  // ── (d) walkway network (EXCLUDING the door node) ↔ each gathering zone (zone > 4ft from any walkway) ──
  const GATHER = new Set(['seating', 'dining', 'cooking', 'fire', 'garden']);
  const hard = [...ewAnchors, ...driveways, ...sidewalks];
  const gz = (zones || []).filter(z => GATHER.has(z.key)).slice().sort((a, b) => String(a.label).localeCompare(String(b.label)));
  for (const z of gz) {
    // Branch off the realized network OR the user's marked walkway/driveway/sidewalk FEATURES —
    // a plan whose only walkways are marked features (no plan paths) must still get gathering paths.
    if (!network.length && !hard.length) break;                              // truly nothing to branch off
    const closed = closeRing(zoneOutline(z));   // the DRAWN outline (ellipse for circle/organic), not the bbox
    // Distance from the zone EDGE (sampled, not just corners) to the nearest walkway/hardscape.
    const edgeSamples = samplePolyline(closed, 2);
    let dHard = Infinity, hopFrom: Pt | null = null, hopTo: Pt | null = null;
    for (const p of edgeSamples) {
      for (const poly of network) { const r = nearestOnPts(p, poly); if (r.d < dHard) { dHard = r.d; hopFrom = r.q; hopTo = p; } }
      if (hard.length) { const r = nearestAcross(p, hard); if (r.d < dHard) { dHard = r.d; hopFrom = r.q; hopTo = p; } }
    }
    if (dHard < 1.5) continue;                                               // touches the walkway — step straight on
    if (dHard <= 5) {
      // One stone's worth of gap (≲2 steps): still a pathway — just a very short one. Same label
      // and kind as a full path so it lists/edits/deletes identically; only the reason differs.
      if (hopFrom && hopTo && !bothNear(hopFrom, hopTo))
        realize({ key: 'gather', label: `Path to ${z.label}`, reason: `A short step from your walkway to the ${String(z.label).toLowerCase()} area`, a: hopFrom, b: pullInward(hopTo, zoneCenter(z), 1), primary: false, ignoreZone: z, houseBoxOverride: houseBox6, skipGuard: true });
      continue;
    }
    // Enter on the zone's YARD side (farthest from the house), not the door-facing side — EXCEPT a
    // veggie garden, which is utilitarian: reach the edge NEAREST the walkway (its natural entrance)
    // rather than routing the path across the whole bed to the far side. `hopTo` is that nearest edge
    // point (computed above against the network + hardscape).
    const entry = (z.key === 'garden' && hopTo) ? hopTo : farthestEntry(closed, houseRingClosed, door);
    // Candidate origins: nearest points on realized/existing walkway geometry + the sidewalk access
    // point — but NEVER the door node. Pick the origin minimising routed length (with 6ft house clearance).
    const cands: Pt[] = [];
    for (const poly of network) cands.push(nearestOnPts(entry, poly).q);
    for (const h of hard) { const r = nearestOnAnchor(entry, h); if (r.d < Infinity) cands.push(r.q); }   // marked walkways/driveways/sidewalks are valid origins
    if (sidewalks.length) { const r = nearestAcross(door ?? entry, sidewalks); if (r.d < Infinity) cands.push(r.q); }
    const zoneBoxes = (zones || []).filter(zz => zz !== z).map(zz => zoneBox(zz, 2));
    let start: Pt | null = null, bestLen = Infinity;
    for (const c of cands) {
      if (door && dist(c, door) <= 2) continue;                              // exclude the door node
      const len = polyLen(routeEdge(c, entry, houseBox6, zoneBoxes));
      if (len < bestLen) { bestLen = len; start = c; }
    }
    if (start && !bothNear(start, entry))
      realize({ key: 'gather', label: `Path to ${z.label}`, reason: `Reaches the ${String(z.label).toLowerCase()} area`, a: start, b: pullInward(entry, zoneCenter(z), 1), primary: false, ignoreZone: z, houseBoxOverride: houseBox6 });
  }

  return out;
}
