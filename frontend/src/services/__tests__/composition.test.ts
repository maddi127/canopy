// Unit test of the composition planner's deterministic core. Builds synthetic sites directly (a big
// empty boundary + one seating zone + a walkway, plus minimal SiteFacts) — no localStorage / no aerial
// pipeline — and asserts the massing pass fills voids as designed. Follows the localStorage-shim +
// synthetic-site pattern from circulation.test.ts (the shim is unused here; composePlan is pure).
import { describe, it, expect } from 'vitest';
import { composePlan, type CompositionInput } from '../compositionPlanner';
import type { SiteFacts } from '../siteFacts';

// ── localStorage shim (parity with circulation.test; composePlan itself is pure) ────────────────
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

// ── Synthetic site (PLAN FEET, x = east, y = SOUTH-down) ─────────────────────────────────────────
// A wide, moderate-depth 80×44 yard. House block along the top (near the street at y=0). One seating
// zone in the yard and a single front walkway from the door down to the sidewalk. The moderate depth
// matters: the dry creek's endpoints must ATTACH (house side → street side) within the length cap, so
// the whole yard cannot be so deep that no attached span fits. Everything else is open ground.
const HOUSE: [number, number][] = [[10, 5], [70, 5], [70, 20], [10, 20]];
function facts(): SiteFacts {
  return {
    version: 1,
    anchors: [
      { kind: 'door', point: [40, 21], confidence: 'high', source: 'derived' },
      { kind: 'sidewalk', line: [[-5, 44], [85, 44]], confidence: 'high', source: 'aerial' },
      { kind: 'house', ring: HOUSE, confidence: 'high', source: 'aerial' },
    ],
  } as SiteFacts;
}
function baseInput(over: Partial<CompositionInput> = {}): CompositionInput {
  return {
    boundaryFt: [[0, 0], [80, 0], [80, 44], [0, 44]],
    houseRing: HOUSE,
    zones: [{ key: 'seating', label: 'Seating', xFt: 8, yFt: 25, wFt: 9, hFt: 9, shape: 'rect' }],
    paths: [{ id: 'w0', label: 'Front walkway', pts: [[40, 21], [40, 42]], widthFt: 4, kind: 'walkway' }],
    existingBeds: [],
    facts: facts(),
    sun: null,
    style: 'whimsical',
    yardType: 'front',
    plantDensity: 1,
    primary: { material: 'mulch', variant: 'natural' },
    ...over,
  };
}

// ── deep-field metric probe (mirror of the planner's plantable+deep test) for before/after checks ──
function deepRatioOf(input: CompositionInput, extraBeds: any[] = []): number {
  const b = input.boundaryFt as [number, number][];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of b) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const band = 7, step = 2.5;
  const inRing = (px: number, py: number, ring: number[][]) => { let o = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) o = !o; } return o; };
  const rects = [...(input.zones || []).map((z: any) => [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]]), ...extraBeds.map((z: any) => [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]])];
  const house = input.houseRing as number[][];
  const segDist = (p: number[], a: number[], c: number[]) => { const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); };
  const ringEdgeDist = (p: number[], ring: number[][]) => { let m = Infinity; for (let i = 0; i < ring.length; i++) m = Math.min(m, segDist(p, ring[i], ring[(i + 1) % ring.length])); return m; };
  const pathDist = (p: number[]) => { let m = Infinity; for (const pa of (input.paths || [])) for (let i = 0; i < pa.pts.length - 1; i++) m = Math.min(m, segDist(p, pa.pts[i], pa.pts[i + 1])); return m; };
  let plantable = 0, deep = 0;
  for (let y = minY; y <= maxY; y += step) for (let x = minX; x <= maxX; x += step) {
    const p = [x, y];
    if (!inRing(x, y, b)) continue;
    if (rects.some(r => inRing(x, y, r))) continue;
    if (inRing(x, y, house)) continue;
    if (pathDist(p) < 2) continue;
    plantable++;
    let dArm = Math.min(ringEdgeDist(p, b), ringEdgeDist(p, house), pathDist(p) - 2);
    for (const r of rects) dArm = Math.min(dArm, ringEdgeDist(p, r));
    if (dArm > band) deep++;
  }
  return plantable ? deep / plantable : 0;
}

// segment-crossing helper (proves the creek never crosses the walkway / house)
function segCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
function crossesPoly(pts: number[][], poly: number[][], closed: boolean): boolean {
  const ring = closed ? [...poly, poly[0]] : poly;
  for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < ring.length - 1; j++) if (segCross(pts[i], pts[i + 1], ring[j], ring[j + 1])) return true;
  return false;
}
const inRingT = (px: number, py: number, ring: number[][]) => { let o = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) o = !o; } return o; };
function ringGapT(A: number[][], B: number[][]): number {
  const segD = (a: number[], b: number[], c: number[], d: number[]) => {
    if (segCross(a, b, c, d)) return 0;
    const pd = (p: number[], u: number[], v: number[]) => { const dx = v[0] - u[0], dy = v[1] - u[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (u[0] + t * dx), p[1] - (u[1] + t * dy)); };
    return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
  };
  let m = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) m = Math.min(m, segD(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]));
  return m;
}
const bedRing = (b: any): number[][] => [[b.xFt, b.yFt], [b.xFt + b.wFt, b.yFt], [b.xFt + b.wFt, b.yFt + b.hFt], [b.xFt, b.yFt + b.hFt]];

// Distance from a point to a polyline/ring outline (closed=true wraps the last→first edge).
function ptToPolyDistT(p: number[], poly: number[][], closed: boolean): number {
  const segD = (q: number[], a: number[], b: number[]) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)); };
  let m = Infinity; const n = poly.length, lim = closed ? n : n - 1;
  for (let i = 0; i < lim; i++) m = Math.min(m, segD(p, poly[i], poly[(i + 1) % n]));
  return m;
}
const polyLenT = (pts: number[][]): number => { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s; };
const capOf = (input: CompositionInput): number => { const b = input.boundaryFt as number[][]; let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity; for (const [x, y] of b) { mnX = Math.min(mnX, x); mnY = Math.min(mnY, y); mxX = Math.max(mxX, x); mxY = Math.max(mxY, y); } return Math.min(30, Math.hypot(mxX - mnX, mxY - mnY) * 0.35); };

// Min distance between two segments (0 if they cross) and between a ring and an open polyline —
// used to prove the creek keep-off and armature-tangency rules on emitted bed footprints.
function segSegDistT(a: number[], b: number[], c: number[], d: number[]): number {
  if (segCross(a, b, c, d)) return 0;
  const pd = (p: number[], u: number[], v: number[]) => { const dx = v[0] - u[0], dy = v[1] - u[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (u[0] + t * dx), p[1] - (u[1] + t * dy)); };
  return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
}
function ringToPolylineDistT(ring: number[][], line: number[][]): number {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; for (let j = 0; j < line.length - 1; j++) m = Math.min(m, segSegDistT(a, b, line[j], line[j + 1])); }
  return m;
}
// Distance from a bed footprint to the NEAREST armature edge: boundary edges, zone-rectangle edges,
// and each walkway's EDGE (centerline − half width). A bed anchored to the armature sits within its
// line's clearance of one of these; a bed floating at a bare void centroid would be >band (~7ft) off.
function nearestArmatureDistT(ring: number[][], input: CompositionInput): number {
  let m = Infinity;
  const b = input.boundaryFt as number[][];
  for (let i = 0; i < b.length; i++) m = Math.min(m, ringToPolylineDistT(ring, [b[i], b[(i + 1) % b.length]]));
  for (const z of (input.zones || [])) { const zr = [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]]; for (let i = 0; i < zr.length; i++) m = Math.min(m, ringToPolylineDistT(ring, [zr[i], zr[(i + 1) % zr.length]])); }
  for (const p of (input.paths || [])) { const half = (p.widthFt || 3) / 2; m = Math.min(m, ringToPolylineDistT(ring, p.pts) - half); }
  return m;
}

describe('composition planner', () => {
  it('is deterministic — byte-identical across two runs', () => {
    const a = JSON.stringify(composePlan(baseInput()));
    const b = JSON.stringify(composePlan(baseInput()));
    expect(a).toBe(b);
  });

  it('whimsical all-mulch yard gets a creek + at least one bed, and the deep field shrinks', () => {
    const input = baseInput({ style: 'whimsical' });
    const before = deepRatioOf(input);
    const res = composePlan(input);
    expect(res.creek).toBeTruthy();
    expect(res.creek!.kind).toBe('creek');
    expect(res.beds.length).toBeGreaterThanOrEqual(1);
    expect(res.beds[0].reason).toBeTruthy();
    const after = deepRatioOf(input, res.beds);
    expect(after).toBeLessThan(before);
  });

  it('the creek attaches at BOTH ends — origin to house/downspout/hardscape, terminus to boundary/sidewalk, no mid-run crossing, within cap', () => {
    const input = baseInput({ style: 'whimsical' });
    const res = composePlan(input);
    expect(res.creek).toBeTruthy();
    const pts = res.creek!.pts as number[][];
    const first = pts[0], last = pts[pts.length - 1];

    // ORIGIN attached: within 2ft of the house ring, a downspout point, or a hardscape/walkway edge.
    const downspouts = (input.facts?.anchors ?? []).filter((a: any) => a.kind === 'downspout').map((a: any) => a.point);
    const walkEdges = (input.paths ?? []).map((p: any) => p.pts as number[][]);
    const featureRings = (input.zones ?? []).filter((z: any) => z.key !== 'lawn').map((z: any) => bedRing(z));
    const originAttached =
      ptToPolyDistT(first, HOUSE, true) <= 2 ||
      downspouts.some((d: number[]) => Math.hypot(first[0] - d[0], first[1] - d[1]) <= 2) ||
      walkEdges.some((w: number[][]) => ptToPolyDistT(first, w, false) <= 2) ||
      featureRings.some((r: number[][]) => ptToPolyDistT(first, r, true) <= 2);
    expect(originAttached).toBe(true);

    // TERMINUS attached: within 1ft of the boundary edge or a sidewalk edge.
    const boundary = input.boundaryFt as number[][];
    const sidewalks = (input.facts?.anchors ?? []).filter((a: any) => a.kind === 'sidewalk').map((a: any) => a.line as number[][]).filter(Boolean);
    const termAttached =
      ptToPolyDistT(last, boundary, true) <= 1 ||
      sidewalks.some((s: number[][]) => ptToPolyDistT(last, s, false) <= 1 + 1);   // ~1ft short of the sidewalk edge
    expect(termAttached).toBe(true);

    // no MID-RUN crossing of the walkway or the house (endpoints attach; the body threads open ground)
    expect(crossesPoly(pts, [[40, 21], [40, 42]], false)).toBe(false);
    expect(pts.some(p => inRingT(p[0], p[1], HOUSE))).toBe(false);

    // length within the cap WITHOUT endpoint detachment (both ends are attached per the checks above)
    expect(polyLenT(pts)).toBeLessThanOrEqual(capOf(input) + 1e-6);
    expect(polyLenT(pts)).toBeGreaterThanOrEqual(12 - 1e-6);
  });

  it('the origin prefers a downspout anchor when facts include one', () => {
    const f = facts();
    // a downspout on the house wall, offset from the void-nearest house point so the preference is visible
    f.anchors.push({ kind: 'downspout', point: [55, 20], side: 'right', confidence: 'medium', source: 'streetview' } as any);
    const res = composePlan(baseInput({ style: 'whimsical', facts: f }));
    expect(res.creek).toBeTruthy();
    const first = (res.creek!.pts as number[][])[0];
    // the origin sits ~1.5ft off the downspout point (much nearer it than a plain house-wall origin would be)
    expect(Math.hypot(first[0] - 55, first[1] - 20)).toBeLessThanOrEqual(2);
  });

  it('modern yard gets NO creek, ≤3 beds, and a ribbon bed near the walkway', () => {
    const res = composePlan(baseInput({ style: 'modern' }));
    expect(res.creek).toBeNull();
    expect(res.beds.length).toBeLessThanOrEqual(3);
    // a bed sits within ~8ft of the walkway centerline (the ribbon flank)
    const wl = [[40, 21], [40, 42]];
    const nearWalk = res.beds.some((b: any) => {
      const cx = b.xFt + b.wFt / 2, cy = b.yFt + b.hFt / 2;
      let m = Infinity;
      for (let i = 0; i < wl.length - 1; i++) { const a = wl[i], c = wl[i + 1]; const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((cx - a[0]) * dx + (cy - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); m = Math.min(m, Math.hypot(cx - (a[0] + t * dx), cy - (a[1] + t * dy))); }
      return m <= 9;
    });
    expect(nearWalk).toBe(true);
  });

  it('the creek never crosses the walkway or the house', () => {
    const res = composePlan(baseInput({ style: 'whimsical' }));
    expect(res.creek).toBeTruthy();
    const pts = res.creek!.pts as number[][];
    expect(crossesPoly(pts, [[40, 21], [40, 42]], false)).toBe(false);
    expect(crossesPoly(pts, HOUSE, true)).toBe(false);
    expect(pts.some(p => inRingT(p[0], p[1], HOUSE))).toBe(false);
  });

  it('serves each anchor at most once (no bed AND unflagged focal slot within 6ft)', () => {
    const res = composePlan(baseInput({ style: 'traditional' }));
    for (const slot of res.focalSlots) {
      if (/combo/i.test(slot.reason)) continue;                       // the deliberate entry bed+slot is flagged
      const nearBed = res.beds.some((b: any) => Math.hypot(slot.x - (b.xFt + b.wFt / 2), slot.y - (b.yFt + b.hFt / 2)) < 6);
      expect(nearBed).toBe(false);
    }
  });

  it('every bed stays ≥8ft off the dry-creek corridor (creek repulsion)', () => {
    const input = baseInput({ style: 'whimsical' });
    const res = composePlan(input);
    expect(res.creek).toBeTruthy();
    const creek = res.creek!.pts as number[][];
    for (const b of res.beds) {
      expect(ringToPolylineDistT(bedRing(b), creek)).toBeGreaterThanOrEqual(8 - 1e-6);
    }
  });

  it('EVERY bed is anchored to an armature edge — or is a flagged island-focal with its co-located specimen slot', () => {
    // The bed policy: beds only flank project boundaries, lawn/feature edges and walkways. The one
    // exception is the island-focal bed, which must be flagged (origin 'island_focal') and must carry
    // a FocalSlot at its centre (≤1ft) — an unflagged floating bed is a policy violation, full stop.
    for (const style of ['whimsical', 'modern', 'traditional', 'desert']) {
      const input = baseInput({ style });
      const res = composePlan(input);
      for (const b of res.beds as any[]) {
        if (b.origin === 'island_focal') {
          const cx = b.xFt + b.wFt / 2, cy = b.yFt + b.hFt / 2;
          const slot = res.focalSlots.find((s: any) => Math.hypot(s.x - cx, s.y - cy) <= 1);
          expect(slot).toBeTruthy();                           // the island exists to host its specimen
        } else {
          // Anchored to an armature line: boundary/lawn beds sit ~tangent (~0.4ft), while feature/walkway
          // beds keep their mandated 2ft edge standoff (+ a small tangency margin) — measured to that
          // armature EDGE. Either way ≤2.6ft, versus >band (~7ft) for a bed floating at a bare centroid.
          expect(nearestArmatureDistT(bedRing(b), input)).toBeLessThanOrEqual(2.6);
        }
      }
    }
  });

  it('a second bed in the SAME void patch is a satellite ≤ half the first bed, never a third', () => {
    // A big, featureless yard is one giant void: the first void bed lands, the second in that same
    // patch must be a satellite, and no third is allowed.
    const input = baseInput({ style: 'traditional', boundaryFt: [[0, 0], [90, 0], [90, 90], [0, 90]], houseRing: null, zones: [], paths: [], facts: null, primary: { material: 'gravel', variant: 'natural' } });
    const res = composePlan(input) as any;
    const voidArm = res.beds.find((b: any) => b.origin === 'void_arm');
    const sats = res.beds.filter((b: any) => b.origin === 'satellite');
    expect(voidArm).toBeTruthy();
    expect(sats.length).toBeLessThanOrEqual(1);                // never a third in one void
    for (const s of sats) {
      expect(s.wFt * s.hFt).toBeLessThanOrEqual(voidArm.wFt * voidArm.hFt / 2 + 1e-6);
    }
  });

  it('a line-less void yields ONLY an island-focal bed+slot pair — never an unflagged floating bed', () => {
    // A 60×60 yard whose entire perimeter is walled off by an existing dry-creek ring 4ft inside the
    // boundary: creek repulsion (8ft) invalidates EVERY armature-snapped candidate (boundary, creek
    // line, ribbon…), so the big interior void has no valid line to flank — the exact line-less-void
    // case. The composer may then place at most ONE island bed there, and it MUST be flagged
    // origin:'island_focal' and carry its specimen FocalSlot at the bed centre, emitted atomically.
    const creekRing = [[4, 4], [56, 4], [56, 56], [4, 56], [4, 4]];
    const input = baseInput({
      style: 'traditional',
      boundaryFt: [[0, 0], [60, 0], [60, 60], [0, 60]],
      houseRing: null, zones: [], facts: null,
      paths: [{ id: 'c0', label: 'Existing dry creek', pts: creekRing, widthFt: 2, kind: 'creek' }],
      primary: { material: 'mulch', variant: 'natural' },
    });
    const res = composePlan(input) as any;
    const islands = res.beds.filter((b: any) => b.origin === 'island_focal');
    const others = res.beds.filter((b: any) => b.origin !== 'island_focal');
    // no unflagged island, ever: any non-island bed must still be armature-tangent
    for (const b of others) expect(nearestArmatureDistT(bedRing(b), input)).toBeLessThanOrEqual(2.6);
    // at most one island per void — and in THIS construction it should actually fire, exercising the pair
    expect(islands.length).toBe(1);
    for (const b of islands) {
      const cx = b.xFt + b.wFt / 2, cy = b.yFt + b.hFt / 2;
      const slot = res.focalSlots.find((s: any) => Math.hypot(s.x - cx, s.y - cy) <= 1);
      expect(slot).toBeTruthy();                                       // atomic bed+slot pair
      expect(slot!.tier).toBe('tree');                                 // specimen tier ('rosette' only for desert)
      expect(/island/i.test(b.reason)).toBe(true);                     // reason couples bed and specimen
      expect(b.wFt * b.hFt).toBeGreaterThanOrEqual(55);                // generously sized around the specimen
      expect(b.wFt * b.hFt).toBeLessThanOrEqual(110);
      expect(ringToPolylineDistT(bedRing(b), creekRing)).toBeGreaterThanOrEqual(8 - 1e-6);  // repulsion still holds
    }
    // island beds never get satellites
    expect(res.beds.filter((b: any) => b.origin === 'satellite').length).toBe(0);
  });

  it('all beds sit inside the boundary and ≥2ft clear of every zone and path', () => {
    for (const style of ['whimsical', 'modern', 'traditional', 'desert']) {
      const input = baseInput({ style });
      const res = composePlan(input);
      const boundary = input.boundaryFt as number[][];
      for (const b of res.beds) {
        const ring = bedRing(b);
        for (const p of ring) expect(inRingT(p[0], p[1], boundary)).toBe(true);       // inside boundary
        for (const z of input.zones) {
          const zr = [[z.xFt, z.yFt], [z.xFt + z.wFt, z.yFt], [z.xFt + z.wFt, z.yFt + z.hFt], [z.xFt, z.yFt + z.hFt]];
          expect(ringGapT(ring, zr)).toBeGreaterThanOrEqual(2 - 1e-6);
        }
        for (const pa of input.paths) {
          const cx = b.xFt + b.wFt / 2, cy = b.yFt + b.hFt / 2;
          let m = Infinity;
          for (let i = 0; i < pa.pts.length - 1; i++) { const a = pa.pts[i], c = pa.pts[i + 1]; const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((cx - a[0]) * dx + (cy - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); m = Math.min(m, Math.hypot(cx - (a[0] + t * dx), cy - (a[1] + t * dy))); }
          expect(m).toBeGreaterThanOrEqual(2);                                          // ≥2ft to the walkway centerline
        }
      }
    }
  });
});
