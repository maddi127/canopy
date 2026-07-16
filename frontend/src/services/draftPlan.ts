// Draft flow: one call that turns a confirmed site (boundary + features + preferences) into a full
// draft plan — sun analysis, rule-based feature layout, and baked geometry — persisted to the SAME
// localStorage keys the classic /diy flow uses, so the studio (/diy/auto-layout), review, and 3D
// pages all work on the draft unchanged. Deterministic per seed.
import { generateLayout } from './layoutGenerator';
import { sunMapForSite, type SunMap } from './sunAnalysis';
import { inputSignature } from '../lib/planSignature';
import { snapshotPlanInputs } from '../lib/planInputs';
import { GENERATOR_VERSION } from './designPayload';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

export type Ring = [number, number][];

// Minimal ring baker for generator zones (rect / circle / organic-approx). The studio re-bakes its
// own richer rings on open; these are for plant placement avoidance + the draft snapshot.
export function bakeRing(shape: string, xFt: number, yFt: number, wFt: number, hFt: number): Ring {
  const cx = xFt + wFt / 2, cy = yFt + hFt / 2, rx = wFt / 2, ry = hFt / 2;
  if (shape === 'circle' || shape === 'organic') {
    const N = shape === 'circle' ? 40 : 24;
    const r: Ring = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    r.push(r[0]);
    return r;
  }
  return [[xFt, yFt], [xFt + wFt, yFt], [xFt + wFt, yFt + hFt], [xFt, yFt + hFt], [xFt, yFt]];
}

export interface DraftPlan {
  zones: any[];
  beds: any[];
  paths: any[];
  primary: { material: string | null; variant: string | null };
  boundary: Ring;          // feet
  boundaryLngLat: [number, number][];
  sunMap: SunMap | null;
}

interface CS { toXY: (lng: number, lat: number) => [number, number]; widthFt: number; heightFt: number; }
export function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), minLat = Math.min(...lats), maxLng = Math.max(...lngs);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return {
    widthFt: (maxLng - minLng) * mLng * FT,
    heightFt: (maxLat - minLat) * mLat * FT,
    toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
  };
}

export function generateDraftPlan(seed = 1): DraftPlan | null {
  let saved: any = {}, prefs: any = {}, sc: any = {};
  try { saved = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { /* none */ }
  try { prefs = JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { /* none */ }
  try { sc = JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { /* none */ }
  const boundary: [number, number][] = saved.boundary || [];
  const existing: ConfirmedFeature[] = saved.confirmedFeatures || [];
  if (boundary.length < 3) return null;

  // Sun analysis — persisted for the studio's sun layer + plant sun-matching.
  let sun: SunMap | null = null;
  try {
    sun = sunMapForSite(boundary, existing);
    if (sun) localStorage.setItem('diySunMap', JSON.stringify(sun)); else localStorage.removeItem('diySunMap');
  } catch { /* none */ }

  const door = (() => { try { return JSON.parse(localStorage.getItem('diyDoorPoint') || 'null') || undefined; } catch { return undefined; } })();
  const plan = generateLayout({ boundary, existing, prefs, seed, door, sun, yardType: sc.yard_type });
  if (!plan) return null;

  // Bake rings so downstream consumers (plant placement, snapshot, review) have geometry.
  // Guard: never let a plan ship with two lawn zones (duplicates broke the editor's per-feature
  // review keys once) — keep the largest if the generator/preservation seam ever stacks them.
  const rawZones = (() => {
    const lawns = plan.zones.filter(z => z.key === 'lawn');
    if (lawns.length <= 1) return plan.zones;
    const keep = lawns.reduce((a, b) => (a.wFt * a.hFt >= b.wFt * b.hFt ? a : b));
    return plan.zones.filter(z => z.key !== 'lawn' || z === keep);
  })();
  const zones = rawZones.map(z => ({ ...z, ring: bakeRing(z.shape, z.xFt, z.yFt, z.wFt, z.hFt) }));
  // Bake rings for beds too (composition planner emits accent beds with shape/xFt/yFt/wFt/hFt), the
  // same way zones get rings, so downstream renderers (review, 3D) have geometry without re-deriving.
  const beds = (plan.beds || []).map((b: any) =>
    (b && typeof b.xFt === 'number' && typeof b.shape === 'string')
      ? { ...b, ring: bakeRing(b.shape, b.xFt, b.yFt, b.wFt, b.hFt) }
      : b);
  const cs = buildCS(boundary);
  const boundaryFt = boundary.map(v => cs.toXY(v[0], v[1])) as Ring;

  // Persist in the studio's format (+ signature so /diy/auto-layout PRESERVES rather than regenerates).
  const stored = {
    zones, beds, paths: plan.paths, primary: plan.primary, focalSlots: plan.focalSlots ?? [],
    boundary: boundaryFt,
    obstacles: existing.filter(f => f.keep && f.type !== 'tree' && (f.vertices?.length ?? 0) >= 3).map(f => f.vertices.map(v => cs.toXY(v[0], v[1]))),
    projectAreaFt: Math.round(Math.abs(boundaryFt.reduce((s, p, i) => { const q = boundaryFt[(i + 1) % boundaryFt.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2)),
    address: sc.address || '',
  };
  try {
    const json = JSON.stringify(stored);
    localStorage.setItem('diyPlacementPlan', json);
    localStorage.setItem('diyPlacementPlanOriginal', json);
    localStorage.setItem('diyPlacementPlanSig', inputSignature());
    localStorage.setItem('diyPlanGeneratorVersion', GENERATOR_VERSION); // pin the version this plan was generated with
    snapshotPlanInputs(); // baseline for "return to my previous draft" (RegenPrompt discard)
  } catch { /* quota */ }

  return { zones, beds, paths: plan.paths, primary: plan.primary, boundary: boundaryFt, boundaryLngLat: boundary, sunMap: sun };
}
