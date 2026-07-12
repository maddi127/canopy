import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/supabase', () => ({ supabase: {} }));
import { placePlan } from '../plantSelectionService';

// Regression: auto-layout zones (incl. lawn) are saved shape-only (xFt/wFt…, no baked ring).
// They must still be obstacles — plants may not land on lawn.
describe('shape-only lawn zone blocks planting', () => {
  it('places no plant centre inside the lawn rect', () => {
    const boundary: [number, number][] = [[0, 0], [60, 0], [60, 60], [0, 60]];
    const lawn = { id: 'lawn1', key: 'lawn', shape: 'rect', xFt: 15, yFt: 15, wFt: 30, hFt: 20 };
    const instances = Array.from({ length: 40 }, (_, i) => ({
      id: `gc-${i}`, layer: 'groundcover' as const, r: 1.5, under: false, drift: `d${Math.floor(i / 5)}`, tall: false,
    }));
    const pos = placePlan({ boundary, existing: [], plan: { zones: [lawn], beds: [], paths: [] }, instances });
    const placed = Object.values(pos);
    expect(placed.length).toBeGreaterThan(0);
    for (const p of placed) {
      const inside = p.x > 15 && p.x < 45 && p.y > 15 && p.y < 35;
      expect(inside).toBe(false);
    }
  });
});

// Modern style: massing 'row' lines a drift's members up along the nearest armature
// (here: the square boundary's edges — axis-aligned), instead of an organic cluster.
describe("massing: 'row' places drift members linearly", () => {
  it('members of one drift are collinear and evenly spaced', () => {
    const boundary: [number, number][] = [[0, 0], [60, 0], [60, 60], [0, 60]];
    const instances = Array.from({ length: 5 }, (_, i) => ({
      id: `sh-${i}`, layer: 'shrub' as const, r: 2, under: false, drift: 'row1', tall: false,
    }));
    const pos = placePlan({ boundary, existing: [], plan: {}, instances, massing: 'row' });
    const pts = Object.values(pos);
    expect(pts.length).toBe(5);
    // Collinear: max perpendicular deviation from the best-fit line through first/last ≤ 0.1 ft.
    const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
    const a = sorted[0], b = sorted[sorted.length - 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    for (const p of sorted) {
      const dev = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
      expect(dev).toBeLessThan(0.1);
    }
    // Even rhythm: consecutive gaps all equal the row step (2r·0.85 = 3.4 ft).
    for (let i = 1; i < sorted.length; i++) {
      const gap = Math.hypot(sorted[i].x - sorted[i - 1].x, sorted[i].y - sorted[i - 1].y);
      expect(gap).toBeCloseTo(3.4, 1);
    }
  });
});
