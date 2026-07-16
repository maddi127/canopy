// Read-only illustrative plan snapshot for the draft flow: IllustrativeSite base (house/trees/paper)
// + an overlay canvas with features, walkways, plants, and perimeter dimensions. House-up for front
// yards, house-down for back. Props-driven (no localStorage reads besides IllustrativeSite's own).
import { useMemo, useRef, useState, useLayoutEffect, useEffect } from 'react';
import IllustrativeSite from './IllustrativeSite';
import {
  buildPlantClusters, paintPlantClusters, paintSketchFeaturePoly, paintSketchGroundFill,
  paintLawnMowerArcs, paintPathEdges, paintPathBody, darkenHex, type PlantMarker, type Layer,
} from '../lib/planPainter';
import { IT } from '../lib/theme';

type Ring = [number, number][];
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

const FEATURE_MATERIAL_COLOR: Record<string, string> = { pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48' };
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const VARIANT_COLOR: Record<string, string> = { natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B' };
// Features whose surface is a built/hardscape material (matches the editor) — get a gravel texture
// when no explicit material is chosen.
const MATERIAL_FEATURES = new Set(['seating', 'dining', 'cooking', 'storage']);
const zoneTex = (z: any): string | null => z.key === 'lawn' ? 'grass' : z.key === 'water' ? 'water' : z.key === 'garden' ? 'soil' : z.material ? z.material : MATERIAL_FEATURES.has(z.key) ? 'gravel' : null;

function ringArea(r: Ring): number { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function buildCS(verts: [number, number][]) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats), minLat = Math.min(...lats);
  const avg = (minLat + maxLat) / 2, mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return { toXY: (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT] };
}
function ringForShape(s: any): Ring {
  if (s.ring && s.ring.length >= 3) return s.ring;
  const cx = s.xFt + s.wFt / 2, cy = s.yFt + s.hFt / 2, rx = s.wFt / 2, ry = s.hFt / 2;
  if (s.shape === 'circle' || s.shape === 'organic') {
    const N = 40, r: Ring = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; r.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    r.push(r[0]); return r;
  }
  return [[s.xFt, s.yFt], [s.xFt + s.wFt, s.yFt], [s.xFt + s.wFt, s.yFt + s.hFt], [s.xFt, s.yFt + s.hFt], [s.xFt, s.yFt]];
}

export default function PlanSnapshot({ plan, plants = [], height = 460, showDimensions = true, exportRef }: {
  plan: any;                       // { zones, beds, paths, boundary(ft), obstacles?, primary? }
  plants?: any[];                  // diyPlantInstances shape
  height?: number;
  showDimensions?: boolean;
  /** Receives a capture fn that composes the snapshot (base + overlay) into a PNG data URL. */
  exportRef?: React.MutableRefObject<(() => string | null) | null>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(760);
  const H = height;
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // Orientation: house wall horizontal, house up (front) / down (back) — same math as the studio.
  const site = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const yardType = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}').yard_type || ''; } catch { return ''; } }, []);
  const existing = useMemo<any[]>(() => site.confirmedFeatures ?? [], [site]);
  const cs = useMemo(() => (Array.isArray(site.boundary) && site.boundary.length >= 3) ? buildCS(site.boundary) : null, [site]);
  const houseGeom = useMemo<{ centroid: [number, number]; edgeAngle: number } | null>(() => {
    if (!cs) return null;
    let best: Ring | null = null, bestArea = 0;
    for (const f of existing) {
      if (!f.keep || f.type !== 'house' || (f.vertices?.length ?? 0) < 3) continue;
      const ring = f.vertices.map((v: [number, number]) => cs.toXY(v[0], v[1])) as Ring;
      const area = ringArea(ring);
      if (area > bestArea) { bestArea = area; best = ring; }
    }
    if (!best) return null;
    let cx = 0, cy = 0; for (const [x, y] of best) { cx += x; cy += y; } cx /= best.length; cy /= best.length;
    let edgeAngle = 0, longest = 0;
    for (let i = 0; i < best.length; i++) { const a = best[i], b = best[(i + 1) % best.length]; const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len > longest) { longest = len; edgeAngle = Math.atan2(dy, dx); } }
    return { centroid: [cx, cy], edgeAngle };
  }, [cs, existing]);

  const affine = useMemo<Affine | null>(() => {
    const boundary: Ring = plan?.boundary || []; if (boundary.length < 3) return null;
    let cx = 0, cy = 0; for (const [x, y] of boundary) { cx += x; cy += y; } cx /= boundary.length; cy /= boundary.length;
    let theta = 0;
    if (houseGeom) {
      const theta0 = -houseGeom.edgeAngle;
      const vx = houseGeom.centroid[0] - cx, vy = houseGeom.centroid[1] - cy;
      const c0 = Math.cos(theta0), s0 = Math.sin(theta0);
      const phi = Math.atan2(vx * s0 + vy * c0, vx * c0 - vy * s0);
      const target = /back/i.test(yardType) ? Math.PI / 2 : -Math.PI / 2;
      theta = theta0 + Math.round((target - phi) / (Math.PI / 2)) * (Math.PI / 2);
    }
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const rot = (x: number, y: number): [number, number] => { const qx = x - cx, qy = y - cy; return [qx * cosT - qy * sinT, qx * sinT + qy * cosT]; };
    let rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
    for (const [x, y] of boundary) { const [rx, ry] = rot(x, y); rminX = Math.min(rminX, rx); rmaxX = Math.max(rmaxX, rx); rminY = Math.min(rminY, ry); rmaxY = Math.max(rmaxY, ry); }
    const rw = (rmaxX - rminX) || 1, rh = (rmaxY - rminY) || 1, fill = 0.84;
    const s = Math.min(fill * w / rw, fill * H / rh);
    let uminX = rminX, umaxX = rmaxX, uminY = rminY, umaxY = rmaxY;
    if (cs) for (const f of existing) {
      if (!f.keep || (f.vertices?.length ?? 0) < 3) continue;
      for (const v of f.vertices) { const [rx, ry] = rot(...cs.toXY(v[0], v[1])); uminX = Math.min(uminX, rx); umaxX = Math.max(umaxX, rx); uminY = Math.min(uminY, ry); umaxY = Math.max(umaxY, ry); }
    }
    const uw = (umaxX - uminX) || 1, uh = (umaxY - uminY) || 1, k = 0.6;
    const txB = (w - s * rw) / 2 - s * rminX, tyB = (H - s * rh) / 2 - s * rminY;
    const txU = (w - s * uw) / 2 - s * uminX, tyU = (H - s * uh) / 2 - s * uminY;
    const tx = txB + (txU - txB) * k, ty = tyB + (tyU - tyB) * k;
    return { a: s * cosT, c: -s * sinT, e: tx - s * cosT * cx + s * sinT * cy, b: s * sinT, d: s * cosT, f: ty - s * sinT * cx - s * cosT * cy };
  }, [plan?.boundary, houseGeom, yardType, cs, existing, w, H]);

  useLayoutEffect(() => {
    const cv = canvasRef.current; if (!cv || !affine || !plan) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const scale = Math.hypot(affine.a, affine.b);
    const toPx = (x: number, y: number): [number, number] => [affine.a * x + affine.c * y + affine.e, affine.b * x + affine.d * y + affine.f];
    const ringPx = (r: Ring): [number, number][] => r.map(([x, y]) => toPx(x, y));
    const centroidPx = (r: Ring): [number, number] => { let x = 0, y = 0; const pr = ringPx(r); for (const [px, py] of pr) { x += px; y += py; } return [x / pr.length, y / pr.length]; };
    const tracePx = (pr: [number, number][]) => { ctx.beginPath(); pr.forEach(([px, py], i) => { if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); };

    // ── Primary open ground: colour wash + mulch/pebble tile, carved around the house/obstacles. ──
    const bdy0: Ring = plan.boundary || [];
    const pv = plan.primary?.variant as string | undefined;
    if (pv && VARIANT_COLOR[pv] && bdy0.length >= 3) {
      const kind: 'mulch' | 'pebble' = (pv === 'river' || pv === 'pea' || pv === 'lava') ? 'pebble' : 'mulch';
      const obstacles: Ring[] = cs
        ? existing.filter(f => f.keep && (f.type === 'house' || f.type === 'structure' || f.type === 'hardscape') && (f.vertices?.length ?? 0) >= 3)
            .map(f => f.vertices.map((v: [number, number]) => cs.toXY(v[0], v[1])) as Ring)
        : [];
      ctx.save();
      tracePx(ringPx(bdy0));
      for (const ob of obstacles) { const pr = ringPx(ob); ctx.moveTo(pr[0][0], pr[0][1]); for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i][0], pr[i][1]); ctx.closePath(); }
      ctx.clip('evenodd');
      paintSketchGroundFill(ctx, [ringPx(bdy0)], { color: VARIANT_COLOR[pv], kind });
      ctx.restore();
    }

    const drawZone = (z: any) => {
      const r = ringForShape(z); if (r.length < 3) return;
      const zc = z.key === 'lawn' ? MATERIAL_COLOR.lawn : z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color || '#B5A07A';
      const rings = [ringPx(r)];
      const lawnInk = z.key === 'lawn' ? darkenHex((zc.slice(0, 7) || '#8daa6a'), 0.62) : null;
      paintSketchFeaturePoly(ctx, rings, { fill: zc, stroke: zc, lineWidth: 1.5, tex: zoneTex(z), active: false, ink: lawnInk });
      if (z.key === 'lawn') {
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const [x, y] of r) { mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y); }
        paintLawnMowerArcs(ctx, rings, toPx(mnx, mny), toPx(mxx, mxy), lawnInk || 'rgba(74,92,52,0.8)');
      }
      const [cx2, cy2] = centroidPx(r);
      ctx.font = `600 11px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(247,243,234,0.95)'; ctx.strokeText(z.label || '', cx2, cy2);
      ctx.fillStyle = '#2A2A26'; ctx.fillText(z.label || '', cx2, cy2);
    };

    // Lawn (bottom) → beds → feature zones, matching the editor's paint order.
    for (const z of plan.zones || []) if (z.key === 'lawn') drawZone(z);
    for (const b of plan.beds || []) {
      const r = ringForShape(b); if (r.length < 3) continue;
      const color = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material] || '#8B6B4A';
      const tex = b.material === 'lawn' ? 'grass' : b.material === 'rock' ? 'rock' : 'mulch';
      paintSketchFeaturePoly(ctx, [ringPx(r)], { fill: color, stroke: color, lineWidth: 1, tex, active: false, ink: null });
    }
    for (const z of plan.zones || []) if (z.key !== 'lawn') drawZone(z);

    // Walkways: keep geometry + colour, add the editor's wobbly inked corridor edges.
    for (const p of plan.paths || []) {
      const pts = p.pts || []; if (pts.length < 2) continue;
      const pxPts = pts.map(([x, y]: [number, number]) => toPx(x, y)) as [number, number][];
      const wpx = Math.max(2, (p.widthFt || 3) * scale);
      // Drafted material body inside the corridor (flagstone / pavers / brick / concrete / gravel / creek).
      paintPathBody(ctx, pxPts, wpx, scale, { material: p.material, kind: p.kind, color: p.color, id: p.id });
      if (p.kind !== 'creek') paintPathEdges(ctx, pxPts, wpx);
    }

    // Plants — the full colored-pencil cluster symbology (feet coords → px via toPx), clipped to the yard.
    const markers: PlantMarker[] = [];
    for (const pl of plants) {
      if (typeof pl?.x !== 'number' || typeof pl?.y !== 'number') continue;
      markers.push({ x: pl.x, y: pl.y, rFt: (pl.widthFt || 2) / 2, color: pl.color || '#5a7a50', kind: (pl.layer || 'shrub') as Layer, name: pl.name || String(pl.layer || '') });
    }
    if (markers.length) {
      ctx.save();
      if (bdy0.length >= 3) { tracePx(ringPx(bdy0)); ctx.clip(); }
      paintPlantClusters(ctx, buildPlantClusters(markers), toPx, scale);
      ctx.restore();
    }

    if (showDimensions) {
      const bdy: Ring = plan.boundary || [];
      if (bdy.length >= 2) {
        const [gcx, gcy] = centroidPx(bdy);
        ctx.font = `600 10.5px ${IT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < bdy.length; i++) {
          const a = bdy[i], b = bdy[(i + 1) % bdy.length];
          const lenFt = Math.hypot(b[0] - a[0], b[1] - a[1]); if (lenFt < 3) continue;
          const [ax, ay] = toPx(a[0], a[1]), [bx, by] = toPx(b[0], b[1]);
          let mx = (ax + bx) / 2, my = (ay + by) / 2;
          const dx = mx - gcx, dy = my - gcy, dd = Math.hypot(dx, dy) || 1;
          mx += (dx / dd) * 15; my += (dy / dd) * 15;
          const label = `${Math.round(lenFt)} ft`;
          ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(247,243,234,0.96)'; ctx.strokeText(label, mx, my);
          ctx.fillStyle = '#5A6270'; ctx.fillText(label, mx, my);
        }
      }
    }
  }, [affine, w, H, plan, plants, showDimensions, cs, existing]);

  // Expose a capture fn: paint the paper base + both canvases (site + overlay) into one PNG.
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = () => {
      const wrap = wrapRef.current; if (!wrap) return null;
      const canvases = wrap.querySelectorAll('canvas');
      if (!canvases.length) return null;
      const out = document.createElement('canvas');
      out.width = Math.round(w * 2); out.height = Math.round(H * 2); // 2× for a crisp reference image
      const ctx = out.getContext('2d'); if (!ctx) return null;
      ctx.fillStyle = '#EFE9DA'; ctx.fillRect(0, 0, out.width, out.height);
      canvases.forEach(cv => { try { ctx.drawImage(cv, 0, 0, out.width, out.height); } catch { /* skip */ } });
      try { return out.toDataURL('image/png'); } catch { return null; }
    };
    return () => { exportRef.current = null; };
  }, [exportRef, w, H]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: H, background: '#EFE9DA', borderRadius: 12, overflow: 'hidden' }}>
      {affine && <div style={{ position: 'absolute', inset: 0 }}><IllustrativeSite width={w} height={H} animate={false} transform={affine} /></div>}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  );
}
