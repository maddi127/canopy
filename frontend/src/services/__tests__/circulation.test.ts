// Unit test of the circulation planner's deterministic core. Builds a synthetic SiteFacts object
// directly (door, sidewalk line, driveway ring, side gate, one seating zone) — no localStorage / no
// aerial pipeline — and asserts the desire-line graph routes as designed. Follows the localStorage-
// shim + synthetic-site pattern from draftFlow.test.ts (the shim is unused here but kept for parity).
import { describe, it, expect } from 'vitest';
import { planCirculation, type CirculationInput } from '../circulationPlanner';
import type { SiteFacts } from '../siteFacts';

// ── localStorage shim (parity with draftFlow.test; planCirculation itself is pure) ──────────────
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

// ── Synthetic site (PLAN FEET, x = east, y = SOUTH-down) ─────────────────────────────────────────
// House block y∈[10,40], x∈[0,30]. Door 1ft north of the wall (in the yard). Sidewalk at the street
// (y=0). Driveway to the east. Side gate directly BEHIND the house (forces a go-around dogleg).
const HOUSE: [number, number][] = [[0, 10], [30, 10], [30, 40], [0, 40]];
function syntheticFacts(): SiteFacts {
  return {
    version: 1,
    anchors: [
      { kind: 'door', point: [15, 9], confidence: 'high', source: 'derived' },
      { kind: 'sidewalk', line: [[-10, 0], [40, 0]], confidence: 'high', source: 'aerial' },
      { kind: 'driveway', ring: [[35, 0], [50, 0], [50, 40], [35, 40]], confidence: 'high', source: 'aerial' },
      { kind: 'side_gate', point: [15, 46], confidence: 'high', source: 'streetview' },
    ],
  };
}
function makeInput(existingPaths: any[] = []): CirculationInput {
  return {
    boundaryFt: [[-15, -5], [55, -5], [55, 55], [-15, 55]],
    houseRing: HOUSE,
    zones: [{ key: 'seating', label: 'Seating', xFt: 40, yFt: 45, wFt: 9, hFt: 9, shape: 'rect' }],
    existingPaths,
    facts: syntheticFacts(),
    style: 'traditional',
    yardType: 'front',
  };
}

// Proper segment–segment intersection (used to prove a path never crosses the house outline).
function segCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;   // strict crossing only (shared endpoints / collinear touching ignored)
}
function crossesHouse(pts: number[][]): boolean {
  const ring = [...HOUSE, HOUSE[0]];
  for (let i = 0; i < pts.length - 1; i++)
    for (let j = 0; j < ring.length - 1; j++)
      if (segCross(pts[i], pts[i + 1], ring[j], ring[j + 1])) return true;
  return false;
}
function inHouse(p: number[]): boolean { return p[0] > 0 && p[0] < 30 && p[1] > 10 && p[1] < 40; }

describe('circulation planner', () => {
  it('routes a front walkway from the door to the sidewalk, with a reason', () => {
    const out = planCirculation(makeInput());
    const fw = out.find(p => p.label === 'Front walkway');
    expect(fw).toBeTruthy();
    expect(fw!.reason).toBeTruthy();
    expect(fw!.kind).toBe('walkway');
    // Endpoints are the door and the sidewalk access point.
    expect(fw!.pts[0]).toEqual([15, 9]);
    expect(fw!.pts[fw!.pts.length - 1]).toEqual([15, 0]);
  });

  it('routes a side-gate path that never crosses the house ring', () => {
    const out = planCirculation(makeInput());
    const sg = out.find(p => p.label === 'Path to side gate');
    expect(sg).toBeTruthy();
    expect(sg!.reason).toMatch(/side gate/i);
    expect(crossesHouse(sg!.pts)).toBe(false);
    expect(sg!.pts.some(inHouse)).toBe(false);
    expect(sg!.pts.length).toBeGreaterThan(2);   // a straight line would cut through the house → it doglegged
  });

  it('is deterministic — byte-identical across two runs', () => {
    const a = JSON.stringify(planCirculation(makeInput()));
    const b = JSON.stringify(planCirculation(makeInput()));
    expect(a).toBe(b);
  });

  it('does not duplicate paths when re-run on its own output', () => {
    const first = planCirculation(makeInput());
    expect(first.length).toBeGreaterThan(0);
    const second = planCirculation(makeInput(first));   // feed the realized paths back in as existing
    const firstLabels = new Set(first.map(p => p.label));
    expect(second.every(p => !firstLabels.has(p.label))).toBe(true);
    expect(second.length).toBe(0);
  });

  // (5) The user marked their existing front walkway, but it stops 12ft short of the door (points AT
  // it though). We must NOT draw a full new "Front walkway" beside it — only a short CONNECTOR to the door.
  it('extends an existing walkway to the door with a connector instead of a duplicate front walkway', () => {
    // Deeper front yard: house y∈[30,60]. Door 1ft north of the wall. Existing walkway runs up the
    // centre from the sidewalk (y=0) but stops at y=17 — 12ft short of the door at y=29.
    const HOUSE5: [number, number][] = [[0, 30], [30, 30], [30, 60], [0, 60]];
    const input: CirculationInput = {
      boundaryFt: [[-15, -5], [45, -5], [45, 70], [-15, 70]],
      houseRing: HOUSE5,
      zones: [],
      existingPaths: [],
      facts: {
        version: 1,
        anchors: [
          { kind: 'door', point: [15, 29], confidence: 'high', source: 'derived' },
          { kind: 'sidewalk', line: [[-10, 0], [40, 0]], confidence: 'high', source: 'aerial' },
          { kind: 'existing_walkway', line: [[15, 0], [15, 17]], confidence: 'high', source: 'aerial', label: 'Walkway' },
        ],
      } as SiteFacts,
      style: 'traditional',
      yardType: 'front',
    };
    const out = planCirculation(input);
    // No full front walkway — the existing one already serves the door.
    expect(out.find(p => p.label === 'Front walkway')).toBeFalsy();
    // Exactly a connector, short (~12ft gap), pointing from the walkway end to the door.
    const conn = out.find(p => p.label === 'Front walkway connector');
    expect(conn).toBeTruthy();
    expect(conn!.reason).toMatch(/existing walkway/i);
    expect(conn!.pts[conn!.pts.length - 1]).toEqual([15, 29]);   // ends at the door
    const len = conn!.pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - conn!.pts[i - 1][0], p[1] - conn!.pts[i - 1][1]) : 0, 0);
    expect(len).toBeLessThanOrEqual(14);
  });

  // (6) A gathering-zone path must originate on the walkway network (never the door node) and swing
  // into the yard — never within 5ft of the house ring.
  it('routes a gathering-zone path off the network (not the door) keeping clear of the house', () => {
    const HOUSE6: [number, number][] = [[0, 30], [30, 30], [30, 60], [0, 60]];
    const DOOR6: [number, number] = [15, 29];
    const houseRingClosed = [...HOUSE6, HOUSE6[0]];
    const input: CirculationInput = {
      boundaryFt: [[-15, -5], [65, -5], [65, 70], [-15, 70]],
      houseRing: HOUSE6,
      zones: [{ key: 'seating', label: 'Seating', xFt: 40, yFt: 15, wFt: 10, hFt: 10, shape: 'rect' }],
      existingPaths: [],
      facts: {
        version: 1,
        anchors: [
          { kind: 'door', point: DOOR6, confidence: 'high', source: 'derived' },
          { kind: 'sidewalk', line: [[-10, 0], [40, 0]], confidence: 'high', source: 'aerial' },
        ],
      } as SiteFacts,
      style: 'traditional',
      yardType: 'front',
    };
    const out = planCirculation(input);
    const g = out.find(p => p.label === 'Path to Seating');
    expect(g).toBeTruthy();
    // Does not originate at the door node.
    expect(g!.pts[0]).not.toEqual(DOOR6);
    expect(g!.pts.some(p => p[0] === DOOR6[0] && p[1] === DOOR6[1])).toBe(false);
    // Never comes within 5ft of the house ring (sample densely along the path).
    const nearRing = (p: number[]): number => {
      let m = Infinity;
      for (let i = 0; i < houseRingClosed.length - 1; i++) {
        const a = houseRingClosed[i], b = houseRingClosed[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        m = Math.min(m, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
      }
      return m;
    };
    for (let i = 0; i < g!.pts.length - 1; i++) {
      const a = g!.pts[i], b = g!.pts[i + 1], steps = 20;
      for (let k = 0; k <= steps; k++) { const t = k / steps; expect(nearRing([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])).toBeGreaterThan(5); }
    }
  });
});
