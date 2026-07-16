// Unit test for the localStorage ⇄ relational-row mapping (Phase 1 data layer).
// Runs in Node with a localStorage shim that supports length/key() so the
// wildcard clear can be exercised.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectActiveDesign,
  applyDesign,
  clearAllDesignState,
  currentAddress,
  GENERATOR_VERSION,
} from '../designPayload';

// ── localStorage shim (Map-backed, ordered, with length/key) ────────────────────
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};

const BOUNDARY = [[-111.65, 40.25], [-111.649, 40.25], [-111.649, 40.251]];
const FEATURES = [{ id: 'h1', type: 'house', keep: true }];
const PLAN = { zones: [{ key: 'seating', x: 10, y: 12 }], projectAreaFt: 1200 };
const PLANTS = [{ name: 'Salvia', x: -111.6495, y: 40.2505 }];

function seedFullFlowState() {
  store.clear();
  localStorage.setItem('siteContext', JSON.stringify({ address: '123 Test St', lat: 40.25, lng: -111.65, yard_type: 'front' }));
  localStorage.setItem('initialAddress', JSON.stringify({ address: '123 Test St', lat: 40.25, lng: -111.65 }));
  localStorage.setItem('userPreferences', JSON.stringify({ style: 'modern', space_usage: ['seating'], lawnTarget: 0.3, yard_type: 'front' }));
  localStorage.setItem('diyBoundaryFinal', JSON.stringify({ boundary: BOUNDARY, confirmedFeatures: FEATURES, doorPoint: [-111.6498, 40.2502] }));
  localStorage.setItem('diyDoorPoint', JSON.stringify([-111.6498, 40.2502]));
  localStorage.setItem('diySunMap', JSON.stringify({ shade: 0.4 }));
  localStorage.setItem('diyPlacementPlan', JSON.stringify(PLAN));
  localStorage.setItem('diyPlantInstances', JSON.stringify(PLANTS));
}

beforeEach(seedFullFlowState);

describe('collectActiveDesign', () => {
  it('splits localStorage into address/project/design row shapes', () => {
    const payload = collectActiveDesign();
    expect(payload).not.toBeNull();
    const { address, project, design } = payload!;
    expect(address.formatted_address).toBe('123 Test St');
    expect(address.lat).toBe(40.25);
    expect(project.yard_type).toBe('front');
    expect(design.boundary).toEqual(BOUNDARY);
    expect(design.existing_features).toEqual(FEATURES);
    expect(design.plan).toEqual(PLAN);
    expect(design.plant_instances).toEqual(PLANTS);
    expect(design.generator_version).toBe(GENERATOR_VERSION);
    // yard_type is stripped from preferences (it lives on the project).
    expect((design.preferences as any).yard_type).toBeUndefined();
    expect((design.preferences as any).style).toBe('modern');
  });

  it('returns null when there is no address', () => {
    store.clear();
    localStorage.setItem('diyPlacementPlan', JSON.stringify(PLAN));
    expect(collectActiveDesign()).toBeNull();
  });

  it('returns null when there is neither a boundary nor a plan', () => {
    store.clear();
    localStorage.setItem('siteContext', JSON.stringify({ address: '123 Test St', lat: 40.25, lng: -111.65 }));
    localStorage.setItem('userPreferences', JSON.stringify({ style: 'modern' }));
    expect(collectActiveDesign()).toBeNull();
  });
});

describe('applyDesign (roundtrip)', () => {
  it('rehydrates the flow keys a fresh load can read', () => {
    const payload = collectActiveDesign()!;
    clearAllDesignState();
    // Everything is gone after the wildcard clear.
    expect(localStorage.getItem('diyBoundaryFinal')).toBeNull();
    expect(localStorage.getItem('userPreferences')).toBeNull();

    applyDesign(payload);
    const bf = JSON.parse(localStorage.getItem('diyBoundaryFinal')!);
    expect(bf.boundary).toEqual(BOUNDARY);
    expect(bf.confirmedFeatures).toEqual(FEATURES);
    const prefs = JSON.parse(localStorage.getItem('userPreferences')!);
    expect(prefs.style).toBe('modern');
    expect(prefs.yard_type).toBe('front'); // merged back from the project
    expect(JSON.parse(localStorage.getItem('diyPlacementPlan')!)).toEqual(PLAN);
    expect(JSON.parse(localStorage.getItem('diyPlantInstances')!)).toEqual(PLANTS);
    expect(currentAddress()).toBe('123 Test St');
  });
});

describe('clearAllDesignState', () => {
  it('removes all diy*/draft* keys plus explicit flow keys', () => {
    localStorage.setItem('draftDetections', '[]');
    localStorage.setItem('diyAnythingElse', '1');
    localStorage.setItem('sb-auth-token', 'keep-me'); // auth session must survive
    clearAllDesignState();
    expect(localStorage.getItem('diyBoundaryFinal')).toBeNull();
    expect(localStorage.getItem('diyAnythingElse')).toBeNull();
    expect(localStorage.getItem('draftDetections')).toBeNull();
    expect(localStorage.getItem('userPreferences')).toBeNull();
    expect(localStorage.getItem('siteContext')).toBeNull();
    expect(localStorage.getItem('sb-auth-token')).toBe('keep-me');
  });
});
