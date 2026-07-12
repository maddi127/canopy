// End-to-end test of the draft flow's deterministic core: synthetic detections → proposed boundary
// → generated draft plan → weekend build plan. Runs in Node with a localStorage shim; the async
// plant pipeline (Supabase + hardiness fetch) is exercised separately in the browser.
import { describe, it, expect, beforeEach } from 'vitest';
import { detectionBox, proposeBoundary } from '../boundaryProposer';
import { generateDraftPlan } from '../draftPlan';
import { buildWeekendPlan } from '../materialsCalculator';
import type { ConfirmedFeature } from '../../pages/DiyFeatureConfirmPage';

// ── localStorage shim ───────────────────────────────────────────────────────────
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

// ── Synthetic site: house + sidewalk + tree around a fixed lat/lng ──────────────
const LAT = 40.25, LNG = -111.65;
const mLat = 111320, mLng = 111320 * Math.cos(LAT * Math.PI / 180), FT = 3.28084;
const at = (dxFt: number, dyFt: number): [number, number] => [LNG + dxFt / (mLng * FT), LAT + dyFt / (mLat * FT)];
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];

function syntheticFeatures(): ConfirmedFeature[] {
  const mk = (type: any, label: string, vertices: [number, number][]): ConfirmedFeature =>
    ({ id: `t_${label}`, type, keep: true, source: 'detected', vertices, label, attributes: {} });
  return [
    mk('house', 'Main residence', rect(-18, -40, 18, -8)),        // house south of center
    mk('hardscape', 'Public sidewalk', rect(-40, 28, 40, 32)),    // sidewalk strip north (street side)
    mk('tree', 'Front yard tree', rect(-30, 5, -22, 13)),
  ];
}

beforeEach(() => {
  store.clear();
  localStorage.setItem('siteContext', JSON.stringify({ address: '123 Test St', lat: LAT, lng: LNG, yard_type: 'front' }));
  localStorage.setItem('userPreferences', JSON.stringify({ style: 'traditional', space_usage: ['seating', 'garden'], lawnTarget: 0.33, goal_priority: [] }));
});

describe('draft flow core', () => {
  it('proposes a sane boundary from detections', () => {
    const box = detectionBox(LAT, LNG);
    const proposal = proposeBoundary(box, syntheticFeatures(), 'front');
    expect(proposal).not.toBeNull();
    const b = proposal!.boundary;
    expect(b.length).toBe(4);
    // The proposal must sit on the sidewalk side of the house (north = larger lat).
    const houseMaxLat = Math.max(...rect(-18, -40, 18, -8).map(v => v[1]));
    const bMeanLat = b.reduce((s, v) => s + v[1], 0) / b.length;
    expect(bMeanLat).toBeGreaterThan(houseMaxLat - 1e-6);
    expect(proposal!.doorPoint).not.toBeNull();
  });

  it('generates a full draft plan and persists studio-compatible keys', () => {
    const box = detectionBox(LAT, LNG);
    const proposal = proposeBoundary(box, syntheticFeatures(), 'front')!;
    localStorage.setItem('diyBoundaryFinal', JSON.stringify({ boundary: proposal.boundary, confirmedFeatures: syntheticFeatures(), doorPoint: proposal.doorPoint }));
    localStorage.setItem('diyDoorPoint', JSON.stringify(proposal.doorPoint));

    const plan = generateDraftPlan(1);
    expect(plan).not.toBeNull();
    expect(plan!.zones.length).toBeGreaterThan(0);                        // features + lawn placed
    expect(plan!.zones.some(z => z.key === 'seating')).toBe(true);
    expect(plan!.zones.every(z => Array.isArray(z.ring) && z.ring.length >= 4)).toBe(true); // rings baked

    const stored = JSON.parse(localStorage.getItem('diyPlacementPlan')!);
    expect(stored.zones.length).toBe(plan!.zones.length);
    expect(stored.projectAreaFt).toBeGreaterThan(100);
    expect(localStorage.getItem('diyPlacementPlanSig')).toBeTruthy();     // studio will preserve

    // Determinism: same seed → identical plan.
    const again = generateDraftPlan(1);
    expect(JSON.stringify(again!.zones)).toBe(JSON.stringify(plan!.zones));
  });

  it('builds a priced weekend plan with quantities', () => {
    const box = detectionBox(LAT, LNG);
    const proposal = proposeBoundary(box, syntheticFeatures(), 'front')!;
    localStorage.setItem('diyBoundaryFinal', JSON.stringify({ boundary: proposal.boundary, confirmedFeatures: syntheticFeatures(), doorPoint: proposal.doorPoint }));
    generateDraftPlan(1);
    const stored = JSON.parse(localStorage.getItem('diyPlacementPlan')!);

    const fakePlants = [
      { x: 10, y: 10, name: 'Test Maple', layer: 'tree', widthFt: 20, heightFt: 25, type: 'deciduous tree', evergreen: false, color: '#3d5c3a' },
      { x: 14, y: 12, name: 'Test Sage', layer: 'shrub', widthFt: 3, heightFt: 3, type: 'shrub', evergreen: true, color: '#6a9460' },
    ] as any[];
    const build = buildWeekendPlan(stored, fakePlants);
    expect(build.weekends.length).toBe(3);
    expect(build.allItems.length).toBeGreaterThan(1);                     // pads/paths/plants/ground
    expect(build.totalLow).toBeGreaterThan(0);
    expect(build.totalHigh).toBeGreaterThanOrEqual(build.totalLow);
    // Plant rows carry counts.
    const maple = build.allItems.find(i => i.name === 'Test Maple');
    expect(maple?.qty).toBe('× 1');
  });
});
