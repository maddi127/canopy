import { useMemo, useRef, useState, useLayoutEffect, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import IllustrativeSite from '../components/IllustrativeSite';

const BG = '#efe9db';
const DARK = '#2A2A26';
const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

// ── Label / color maps (mirrors DiyPlacementPage) ───────────────────────────────
const FEATURE_MATERIAL_LABEL: Record<string, string> = {
  pavers: 'Pavers', concrete: 'Concrete', flagstone: 'Flagstone', mulch: 'Mulch', gravel: 'Gravel', brick: 'Brick',
};
const FEATURE_MATERIAL_COLOR: Record<string, string> = {
  pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48',
};
const VARIANT_LABEL: Record<string, string> = {
  natural: 'Natural', brown: 'Brown', black: 'Black', river: 'River rocks', pea: 'Pea gravel', lava: 'Lava rock',
};
const VARIANT_COLOR: Record<string, string> = {
  natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B',
};
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const PATH_COLOR = '#6E7681';
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// ── Geometry helpers (all coords already in feet) ───────────────────────────────
function ringArea(verts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    a += verts[i][0] * verts[j][1] - verts[j][0] * verts[i][1];
  }
  return Math.abs(a / 2);
}
function zoneArea(z: any): number {
  if (z.verts && z.verts.length >= 3) return ringArea(z.verts);
  if (z.shape === 'circle') return (Math.PI / 4) * (z.wFt || 0) * (z.hFt || 0);
  return (z.wFt || 0) * (z.hFt || 0);
}
function pathLength(pts: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Shape ring (ft). Prefer the baked ring from placement, else recompute from raw fields
// so the plan still draws if the stored geometry predates ring baking.
function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function organicRingFt(cx: number, cy: number, rx: number, ry: number, id: string): [number, number][] {
  const rng = seededRng(hashId(id));
  const N = 9;
  const pts: [number, number][] = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const j = 0.78 + rng() * 0.44;
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j];
  });
  const ring: [number, number][] = [];
  const STEPS = 8;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      ring.push([
        u*u*u*p1[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p2[0],
        u*u*u*p1[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p2[1],
      ]);
    }
  }
  ring.push(ring[0]);
  return ring;
}
function ringForShape(s: any): [number, number][] {
  if (s.ring && s.ring.length >= 3) return s.ring;
  if (s.verts && s.verts.length >= 3) { const r = s.verts.map((v: [number, number]) => [v[0], v[1]] as [number, number]); r.push([s.verts[0][0], s.verts[0][1]]); return r; }
  const cx = s.xFt + s.wFt / 2, cy = s.yFt + s.hFt / 2, rx = s.wFt / 2, ry = s.hFt / 2;
  if (s.shape === 'circle') { const N = 44, r: [number, number][] = []; for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } r.push(r[0]); return r; }
  if (s.shape === 'organic') return organicRingFt(cx, cy, rx, ry, s.id);
  return [[s.xFt, s.yFt], [s.xFt + s.wFt, s.yFt], [s.xFt + s.wFt, s.yFt + s.hFt], [s.xFt, s.yFt + s.hFt], [s.xFt, s.yFt]];
}

interface Plan {
  zones: any[];
  beds: any[];
  paths: any[];
  primary: { material: string | null; variant: string | null };
  boundary: [number, number][];
  obstacles: [number, number][][];
  projectAreaFt: number;
  primaryGroundAreaFt: number;
  address: string;
}

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

// Lat/lng → feet, matching the placement page's coordinate system.
function buildCSReview(verts: [number, number][]) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return { toXY: (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT] };
}

// Read-only illustrative plan for the review page: the hand-drawn IllustrativeSite base + an overlay
// canvas drawing the placed features / beds / walkways / plants, plus perimeter dimensions.
function ReviewPlan({ plan }: { plan: Plan }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(760);
  const H = 460, P = 48;
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const plants = useMemo<any[]>(() => { try { return JSON.parse(localStorage.getItem('diyPlantInstances') || '[]'); } catch { return []; } }, []);

  // Site context (for house orientation + yard side) — same source as the placement page.
  const site = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const yardType = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').yard_type || ''; } catch { return ''; } }, []);
  const existing = useMemo<any[]>(() => site.confirmedFeatures ?? [], [site]);
  const cs = useMemo(() => (Array.isArray(site.boundary) && site.boundary.length >= 3) ? buildCSReview(site.boundary) : null, [site]);
  // Largest house footprint (feet): centroid + longest-wall angle, to orient the plan.
  const houseGeom = useMemo<{ centroid: [number, number]; edgeAngle: number } | null>(() => {
    if (!cs) return null;
    let best: [number, number][] | null = null, bestArea = 0;
    for (const f of existing) {
      if (!f.keep || f.type !== 'house' || (f.vertices?.length ?? 0) < 3) continue;
      const ring = f.vertices.map((v: [number, number]) => cs.toXY(v[0], v[1])) as [number, number][];
      const area = ringArea(ring);
      if (area > bestArea) { bestArea = area; best = ring; }
    }
    if (!best) return null;
    let cx = 0, cy = 0; for (const [x, y] of best) { cx += x; cy += y; } cx /= best.length; cy /= best.length;
    let edgeAngle = 0, longest = 0;
    for (let i = 0; i < best.length; i++) { const a = best[i], b = best[(i + 1) % best.length]; const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len > longest) { longest = len; edgeAngle = Math.atan2(dy, dx); } }
    return { centroid: [cx, cy], edgeAngle };
  }, [cs, existing]);

  // Match the placement page's orientation: rotate so the house wall is horizontal and the house
  // sits at the top (front yards) or bottom (back yards), then fit ~80% with a 60% visual-mass blend.
  const affine = useMemo<Affine | null>(() => {
    const boundary = plan.boundary; if (boundary.length < 3) return null;
    let cx = 0, cy = 0; for (const [x, y] of boundary) { cx += x; cy += y; } cx /= boundary.length; cy /= boundary.length;
    let theta = 0;
    if (houseGeom) {
      const theta0 = -houseGeom.edgeAngle;
      const vx = houseGeom.centroid[0] - cx, vy = houseGeom.centroid[1] - cy;
      const c0 = Math.cos(theta0), s0 = Math.sin(theta0);
      const phi = Math.atan2(vx * s0 + vy * c0, vx * c0 - vy * s0);
      const target = /back/i.test(yardType) ? Math.PI / 2 : -Math.PI / 2; // back → bottom, else top
      theta = theta0 + Math.round((target - phi) / (Math.PI / 2)) * (Math.PI / 2);
    }
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const rot = (x: number, y: number): [number, number] => { const qx = x - cx, qy = y - cy; return [qx * cosT - qy * sinT, qx * sinT + qy * cosT]; };
    let rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
    for (const [x, y] of boundary) { const [rx, ry] = rot(x, y); if (rx < rminX) rminX = rx; if (rx > rmaxX) rmaxX = rx; if (ry < rminY) rminY = ry; if (ry > rmaxY) rmaxY = ry; }
    const rw = (rmaxX - rminX) || 1, rh = (rmaxY - rminY) || 1, fill = 0.86;
    const s = Math.min(fill * w / rw, fill * H / rh);
    let uminX = rminX, umaxX = rmaxX, uminY = rminY, umaxY = rmaxY;
    if (cs) for (const f of existing) {
      if (!f.keep || (f.vertices?.length ?? 0) < 3) continue;
      for (const v of f.vertices) { const [rx, ry] = rot(...cs.toXY(v[0], v[1])); if (rx < uminX) uminX = rx; if (rx > umaxX) umaxX = rx; if (ry < uminY) uminY = ry; if (ry > umaxY) umaxY = ry; }
    }
    const uw = (umaxX - uminX) || 1, uh = (umaxY - uminY) || 1, k = 0.6;
    const txB = (w - s * rw) / 2 - s * rminX, tyB = (H - s * rh) / 2 - s * rminY;
    const txU = (w - s * uw) / 2 - s * uminX, tyU = (H - s * uh) / 2 - s * uminY;
    const tx = txB + (txU - txB) * k, ty = tyB + (tyU - tyB) * k;
    return { a: s * cosT, c: -s * sinT, e: tx - s * cosT * cx + s * sinT * cy, b: s * sinT, d: s * cosT, f: ty - s * sinT * cx - s * cosT * cy };
  }, [plan.boundary, houseGeom, yardType, cs, existing, w]);

  useLayoutEffect(() => {
    const cv = canvasRef.current; if (!cv || !affine) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const scale = Math.hypot(affine.a, affine.b); // uniform scale (rotation-aware)
    const toPx = (x: number, y: number): [number, number] => [affine.a * x + affine.c * y + affine.e, affine.b * x + affine.d * y + affine.f];
    const ring = (r: [number, number][]) => { ctx.beginPath(); r.forEach(([x, y], i) => { const [px, py] = toPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); };
    const centroid = (r: [number, number][]): [number, number] => { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; };

    // Features + lawns.
    for (const z of plan.zones) {
      const r = ringForShape(z); if (r.length < 3) continue;
      const color = z.key === 'lawn' ? MATERIAL_COLOR.lawn : z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color || '#B5A07A';
      ring(r); ctx.fillStyle = color + 'D9'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
      const [cx, cy] = centroid(r.map(([x, y]) => toPx(x, y)));
      ctx.font = `600 11px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(247,243,234,0.95)'; ctx.strokeText(z.label || '', cx, cy);
      ctx.fillStyle = '#2A2A26'; ctx.fillText(z.label || '', cx, cy);
    }
    // Beds.
    for (const b of plan.beds) {
      const r = ringForShape(b); if (r.length < 3) continue;
      const color = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material] || '#8B6B4A';
      ring(r); ctx.fillStyle = color + 'B0'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
    }
    // Walkways / dry creek beds.
    for (const p of plan.paths) {
      const pts = p.pts || []; if (pts.length < 2) continue;
      ctx.beginPath(); pts.forEach(([x, y]: [number, number], i: number) => { const [px, py] = toPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.strokeStyle = p.color || PATH_COLOR; ctx.lineWidth = Math.max(2, (p.widthFt || 3) * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
    }
    // Plants (ordered groundcover → tree so overstory sits on top).
    const orderRank: Record<string, number> = { groundcover: 0, shrub: 1, large_shrub: 2, tree: 3 };
    for (const pl of [...plants].sort((a, b) => (orderRank[a.layer] ?? 0) - (orderRank[b.layer] ?? 0))) {
      const [px, py] = toPx(pl.x, pl.y);
      const rPx = Math.max(pl.layer === 'groundcover' ? 2.5 : 4, ((pl.widthFt || 2) / 2) * scale);
      const color = pl.color || '#5a7a50';
      ctx.beginPath(); ctx.arc(px, py, rPx, 0, Math.PI * 2); ctx.fillStyle = color + (pl.layer === 'groundcover' ? '9C' : 'CC'); ctx.fill();
      ctx.lineWidth = pl.layer === 'tree' ? 1.6 : 1.1; ctx.strokeStyle = color; ctx.stroke();
      if (pl.layer === 'tree') { ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fillStyle = '#5a4632'; ctx.fill(); }
    }
    // Perimeter dimensions — length of each boundary edge, offset outward from the yard centre.
    const bdy = plan.boundary; if (bdy.length >= 2) {
      const [gcx, gcy] = centroid(bdy.map(([x, y]) => toPx(x, y)));
      ctx.font = `600 10.5px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < bdy.length; i++) {
        const a = bdy[i], b = bdy[(i + 1) % bdy.length];
        const lenFt = Math.hypot(b[0] - a[0], b[1] - a[1]); if (lenFt < 3) continue;
        const [ax, ay] = toPx(a[0], a[1]), [bx, by] = toPx(b[0], b[1]);
        let mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = mx - gcx, dy = my - gcy, d = Math.hypot(dx, dy) || 1;
        mx += (dx / d) * 15; my += (dy / d) * 15;
        const label = `${Math.round(lenFt)} ft`;
        ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(247,243,234,0.96)'; ctx.strokeText(label, mx, my);
        ctx.fillStyle = '#5A6270'; ctx.fillText(label, mx, my);
      }
    }
  }, [affine, w, plan, plants]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: H, background: '#EFE9DA', borderRadius: 12, overflow: 'hidden' }}>
      {affine && <div style={{ position: 'absolute', inset: 0 }}><IllustrativeSite width={w} height={H} animate={false} transform={affine} /></div>}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  );
}

export default function DiyReviewPage() {
  const navigate = useNavigate();

  const plan = useMemo<Plan>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
      return { zones: p.zones || [], beds: p.beds || [], paths: p.paths || [], primary: p.primary || { material: null, variant: null }, boundary: p.boundary || [], obstacles: p.obstacles || [], projectAreaFt: p.projectAreaFt || 0, primaryGroundAreaFt: p.primaryGroundAreaFt || 0, address: p.address || '' };
    } catch {
      return { zones: [], beds: [], paths: [], primary: { material: null, variant: null }, boundary: [], obstacles: [], projectAreaFt: 0, primaryGroundAreaFt: 0, address: '' };
    }
  }, []);

  const features = plan.zones.filter(z => z.key !== 'lawn');
  const lawns    = plan.zones.filter(z => z.key === 'lawn');
  const beds     = plan.beds.filter(b => b.material !== 'lawn');

  const primaryLabel = plan.primary.variant
    ? `${VARIANT_LABEL[plan.primary.variant] || cap(plan.primary.variant)} ${plan.primary.material || ''}`.trim()
    : plan.primary.material ? cap(plan.primary.material) : null;
  const primaryColor = plan.primary.variant ? VARIANT_COLOR[plan.primary.variant] : (plan.primary.material ? MATERIAL_COLOR[plan.primary.material] : '#ccc');

  // The open ground — everything not carved out by features, secondary beds, walkways
  // or existing structures — is treated as one plantable bed of the primary material.
  const bedAreaOf = (b: any) => b.ring && b.ring.length >= 3 ? ringArea(b.ring) : (b.verts && b.verts.length >= 3 ? ringArea(b.verts) : (b.wFt || 0) * (b.hFt || 0));
  // Total project area minus everything that sits on top of the open ground.
  const projectArea  = plan.projectAreaFt || (plan.boundary.length >= 3 ? ringArea(plan.boundary) : 0);
  const usedByZones  = plan.zones.reduce((s, z) => s + (z.ring ? ringArea(z.ring) : zoneArea(z)), 0);
  const usedByBeds   = beds.reduce((s, b) => s + bedAreaOf(b), 0);
  const usedByPaths  = plan.paths.reduce((s, p) => s + pathLength(p.pts || []) * (p.widthFt || 0), 0);
  const usedByObs    = (plan.obstacles || []).reduce((s, o) => s + (o.length >= 3 ? ringArea(o) : 0), 0);
  // Prefer the exact clipped value from placement; fall back to the summed estimate.
  const primaryArea  = plan.primaryGroundAreaFt || Math.max(0, projectArea - usedByZones - usedByBeds - usedByPaths - usedByObs);
  const matLabel = (material: string, variant: string | null) => `${cap(material)}${variant ? ` · ${VARIANT_LABEL[variant] || cap(variant)}` : ''}`;

  const bedRows: { id: string; label: string; type: string; color: string; mat: string; area: number; note?: string }[] = [
    // The primary ground cover = the open plantable area, shown whenever a primary material is chosen.
    ...(plan.primary.material
      ? [{ id: '__primary', label: 'Open planting area', type: 'planted', color: primaryColor, mat: matLabel(plan.primary.material, plan.primary.variant), area: primaryArea }]
      : []),
    ...beds.map(b => ({ id: b.id, label: b.label, type: b.type, color: b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material], mat: matLabel(b.material, b.variant), area: bedAreaOf(b) })),
  ];

  // Plants placed on the plan (grouped by species, from the plants step).
  const plantRows = useMemo(() => {
    let inst: any[] = [];
    try { inst = JSON.parse(localStorage.getItem('diyPlantInstances') || '[]'); } catch { /* none */ }
    const LAYER_LABEL: Record<string, string> = { tree: 'Tree', large_shrub: 'Large shrub', shrub: 'Shrub', groundcover: 'Groundcover' };
    const byName = new Map<string, { name: string; layer: string; color: string; count: number }>();
    for (const p of inst) {
      const key = p.name || 'Plant';
      const cur = byName.get(key);
      if (cur) cur.count++;
      else byName.set(key, { name: key, layer: p.layer, color: p.color || '#5a7a50', count: 1 });
    }
    const rank: Record<string, number> = { tree: 0, large_shrub: 1, shrub: 2, groundcover: 3 };
    return [...byName.values()]
      .map(r => ({ ...r, typeLabel: LAYER_LABEL[r.layer] || 'Plant' }))
      .sort((a, b) => (rank[a.layer] ?? 9) - (rank[b.layer] ?? 9) || b.count - a.count);
  }, []);

  const Swatch = ({ color, round }: { color: string; round?: boolean }) => (
    <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: round ? '50%' : 3, background: color, flexShrink: 0, verticalAlign: 'middle', marginRight: 8 }} />
  );

  const sectionTitle = (t: string) => (
    <h2 style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, color: '#8A8A7E', letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 10px' }}>{t}</h2>
  );

  // Shared column widths so Features / Beds / Walkways tables line up.
  const COLS = { name: '28%', type: '16%', mat: '22%', size: '18%', area: '16%' };
  const dash = <span style={{ color: '#B5B5AA' }}>—</span>;
  const th: React.CSSProperties = { fontFamily: IT, fontSize: '0.66rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'left', padding: '0 12px 8px 0' };
  const td: React.CSSProperties = { fontFamily: IT, fontSize: '0.9rem', color: DARK, padding: '9px 12px 9px 0', borderTop: '1px solid rgba(42,42,38,0.08)', verticalAlign: 'middle' };

  const card: React.CSSProperties = { background: 'white', borderRadius: 18, padding: '22px 24px', boxShadow: '0 2px 14px rgba(42,42,38,0.06)', marginBottom: 18 };

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: IT }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          .review-page { background: white !important; }
          .review-card { box-shadow: none !important; border: 1px solid rgba(42,42,38,0.12); }
        }
      `}</style>

      <div className="review-page" style={{ maxWidth: 820, margin: '0 auto', padding: '32px 28px 80px' }}>
        {/* Header */}
        <div className="flex items-start justify-between" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
          <div>
            <Logo />
            <h1 style={{ fontFamily: IS, fontSize: '2.4rem', color: DARK, fontWeight: 400, lineHeight: 1.05, margin: '14px 0 4px' }}>Your plan summary</h1>
            {plan.address && <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#7A7A6E', margin: 0 }}>{plan.address}</p>}
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <button onClick={() => navigate('/diy/auto-layout', { state: { step: 'plants' } })}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#7A7A73', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 4px' }}>
              ← Edit plan
            </button>
            <button onClick={() => window.print()}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#efe9db', background: DARK, border: 'none', cursor: 'pointer', padding: '10px 20px', borderRadius: 999 }}>
              Print / Save as PDF
            </button>
          </div>
        </div>

        {/* Plan view — the illustrative plan, read-only, with perimeter dimensions */}
        <div className="review-card" style={{ ...card, padding: 10 }}>
          <ReviewPlan plan={plan} />
        </div>

        {/* Features */}
        {(features.length > 0 || lawns.length > 0) && (
        <div className="review-card" style={card}>
          {sectionTitle(`Features (${features.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Feature</th><th style={{ ...th, width: COLS.type }}></th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {features.map(z => {
                  const matColor = z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color;
                  const size = (z.verts && z.verts.length >= 3) || !(z.wFt > 0 && z.hFt > 0) ? dash : `${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft`;
                  return (
                    <tr key={z.id}>
                      <td style={td}><Swatch color={matColor} round={z.shape === 'circle'} />{z.label}</td>
                      <td style={td}></td>
                      <td style={td}>{z.material ? FEATURE_MATERIAL_LABEL[z.material] : dash}</td>
                      <td style={td}>{size}</td>
                      <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(zoneArea(z)).toLocaleString()} sq ft</td>
                    </tr>
                  );
                })}
                {lawns.map(z => (
                  <tr key={z.id}>
                    <td style={td}><Swatch color={MATERIAL_COLOR.lawn} round={z.shape === 'circle'} />{z.label || 'Lawn'}</td>
                    <td style={td}></td>
                    <td style={td}><span style={{ color: '#B5B5AA' }}>Grass</span></td>
                    <td style={td}>{(z.verts && z.verts.length >= 3) || !(z.wFt > 0 && z.hFt > 0) ? dash : `${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft`}</td>
                    <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(zoneArea(z)).toLocaleString()} sq ft</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {/* Planting beds — the open primary-material area plus any secondary beds */}
        {bedRows.length > 0 && (
        <div className="review-card" style={card}>
          {sectionTitle(`Planting beds (${bedRows.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Bed</th><th style={{ ...th, width: COLS.type }}>Type</th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {bedRows.map(b => (
                  <tr key={b.id}>
                    <td style={td}><Swatch color={b.color} />{b.label}</td>
                    <td style={td}>{b.type === 'planted' ? 'Planted' : 'Unplanted'}</td>
                    <td style={td}>{b.mat}</td>
                    <td style={td}>{dash}</td>
                    <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(b.area).toLocaleString()} sq ft</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {/* Walkways */}
        {plan.paths.length > 0 && (
        <div className="review-card" style={card}>
          {sectionTitle(`Walkways (${plan.paths.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Walkway</th><th style={{ ...th, width: COLS.type }}>Style</th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {plan.paths.map(p => {
                  const len = pathLength(p.pts || []);
                  return (
                    <tr key={p.id}>
                      <td style={td}><Swatch color={PATH_COLOR} />{p.label}</td>
                      <td style={td}>{cap(p.style)}</td>
                      <td style={td}>{p.material ? cap(p.material) : dash}</td>
                      <td style={td}>{Math.round(len)} × {p.widthFt} ft</td>
                      <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(len * (p.widthFt || 0)).toLocaleString()} sq ft</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        )}

        {/* Plants */}
        {plantRows.length > 0 && (
        <div className="review-card" style={card}>
          {sectionTitle(`Plants (${plantRows.length} ${plantRows.length === 1 ? 'species' : 'species'})`)}
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead><tr><th style={{ ...th, width: '52%' }}>Plant</th><th style={{ ...th, width: '30%' }}>Type</th><th style={{ ...th, width: '18%', textAlign: 'right', paddingRight: 0 }}>Qty</th></tr></thead>
            <tbody>
              {plantRows.map(p => (
                <tr key={p.name}>
                  <td style={td}><Swatch color={p.color} round />{p.name}</td>
                  <td style={td}>{p.typeLabel}</td>
                  <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}

        <p style={{ fontFamily: IT, fontSize: '0.75rem', color: '#A8A89C', textAlign: 'center', marginTop: 8 }}>
          Areas are approximate footprints based on your layout.
        </p>

        <div className="no-print" style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 28 }}>
          <button onClick={() => navigate('/diy/yard-3d')}
            style={{ fontFamily: IT, fontSize: '0.95rem', fontWeight: 500, color: DARK, background: 'white', border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer', padding: '13px 26px', borderRadius: 999 }}>
            View in 3D ↗
          </button>
          <button onClick={() => window.print()}
            style={{ fontFamily: IT, fontSize: '0.95rem', fontWeight: 500, color: '#efe9db', background: DARK, border: 'none', cursor: 'pointer', padding: '13px 30px', borderRadius: 999 }}>
            Print / Save as PDF
          </button>
        </div>
      </div>
    </div>
  );
}
