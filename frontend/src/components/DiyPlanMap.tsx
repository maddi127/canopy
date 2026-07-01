import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';
import { buildFrontZones } from '../services/plantSelectionService';

// Read-only render of the placement plan on the same satellite map — same coordinate
// system and projection-based affine as DiyPlacementPage, minus all editing.

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const PAD = 24;
const IT = "'Inter Tight', sans-serif";

const FEATURE_COLOR: Record<string, string> = {
  house: '#C4935A', tree: '#4A8C6A', hardscape: '#B5A48B', structure: '#9A8B78',
  paving: '#A09080', garden_bed: '#7A9A5A', utility: '#8A8A7A',
};
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const VARIANT_COLOR: Record<string, string> = {
  natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B',
};
const FEATURE_MATERIAL_COLOR: Record<string, string> = {
  pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48',
};
const PATH_COLOR = '#6E7681';
const SMALL_PLANT_R = 1.25; // plants with mature radius below this render as a merged amorphous mass
const BLOB_DRAW_FT = 1.3;   // draw radius used to fuse small-plant members into one blob

interface CS { widthFt: number; heightFt: number; toXY: (lng: number, lat: number) => [number, number]; toLngLat: (x: number, y: number) => [number, number]; }
function buildCS(verts: [number, number][]): CS {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const avg = (minLat + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return {
    widthFt: (maxLng - minLng) * mLng * FT,
    heightFt: (maxLat - minLat) * mLat * FT,
    toXY: (lng, lat) => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT],
    toLngLat: (x, y) => [minLng + x / (mLng * FT), maxLat - y / (mLat * FT)],
  };
}

function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}
function hashId(id: string): number { let h = 0x811c9dc5; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function organicRingFt(cx: number, cy: number, rx: number, ry: number, id: string): [number, number][] {
  const rng = seededRng(hashId(id)), N = 9;
  const pts: [number, number][] = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2, j = 0.78 + rng() * 0.44;
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j];
  });
  const ring: [number, number][] = [], STEPS = 8;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      ring.push([u*u*u*p1[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p2[0], u*u*u*p1[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p2[1]]);
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

function pointInRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function distToPolygon(px: number, py: number, ring: [number, number][]): number {
  if (pointInRing(px, py, ring)) return 0;
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; m = Math.min(m, segDist(px, py, a[0], a[1], b[0], b[1])); }
  return m;
}
function minEdgeDist(px: number, py: number, ring: [number, number][]): number {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; m = Math.min(m, segDist(px, py, a[0], a[1], b[0], b[1])); }
  return m;
}

interface Plan { zones: any[]; beds: any[]; paths: any[]; primary: { material: string | null; variant: string | null }; }

export interface PlantMarker { id: string; x: number; y: number; r: number; kind: 'tree' | 'large_shrub' | 'shrub' | 'groundcover'; label: string; underPlanting?: boolean; color?: string; drift?: string; name?: string; }
const PLANT_KIND_COLOR: Record<string, string> = { tree: '#3d5c3a', large_shrub: '#4a7a50', shrub: '#6a9460', groundcover: '#8aa06a' };

export default function DiyPlanMap({ plan, plants = [], onPlantMove, houseCautionFt = 12, topBanner, bottomBanner, height, privacyEdges = [], onToggleEdge, highlightName = null, onPlantSelect, showFront = false }: {
  plan: Plan;
  plants?: PlantMarker[];
  onPlantMove?: (id: string, x: number, y: number) => void;
  houseCautionFt?: number;
  topBanner?: React.ReactNode;
  bottomBanner?: React.ReactNode;
  height?: string; // fixed CSS height; falls back to a 16:10 aspect ratio
  privacyEdges?: number[];                       // boundary edge indices marked for privacy
  onToggleEdge?: (edgeIndex: number) => void;    // when set, the map is in edge-marking mode
  highlightName?: string | null;                 // species to highlight (others dimmed)
  onPlantSelect?: (name: string | null) => void; // fired when a plant is clicked (or empty space → null)
  showFront?: boolean;                            // overlay the detected "front" zone (no tall plants)
}) {
  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });
  const edgeMode = !!onToggleEdge;
  const interactive = !!onPlantMove || edgeMode || !!onPlantSelect;
  const [tip, setTip] = useState<{ x: number; y: number; name: string } | null>(null);

  // Same source data as the placement page.
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { return {}; } }, []);
  const boundary: [number, number][] = useMemo(() => saved.boundary ?? [], [saved]);
  const existing: ConfirmedFeature[] = useMemo(() => saved.confirmedFeatures ?? [], [saved]);

  const cs = useMemo<CS | null>(() => boundary.length >= 3 ? buildCS(boundary) : null, [boundary]);
  const boundaryFt = useMemo<[number, number][]>(() => cs ? boundary.map(v => cs.toXY(v[0], v[1])) : [], [cs, boundary]);
  const obstacleFt = useMemo<[number, number][][]>(() => {
    if (!cs) return [];
    return existing.filter(f => f.keep && f.vertices.length >= 3 && (f.type === 'house' || f.type === 'hardscape'))
      .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][]);
  }, [cs, existing]);
  const houseFt = useMemo<[number, number][][]>(() => {
    if (!cs) return [];
    return existing.filter(f => f.keep && f.vertices.length >= 3 && f.type === 'house')
      .map(f => f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][]);
  }, [cs, existing]);
  // Per-bed "no tall plants" zones (front of each bed + shallow strips), for the overlay.
  const frontZones = useMemo(() => (showFront && boundary.length >= 3) ? buildFrontZones(boundary, existing, plan as any) : null, [showFront, boundary, existing, plan]);
  // Existing tree canopies (ft) — for spacing guidance against new plants.
  const existingTreesFt = useMemo<{ cx: number; cy: number; r: number }[]>(() => {
    if (!cs) return [];
    return existing.filter(f => f.keep && f.type === 'tree' && f.vertices.length >= 3).map(f => {
      const ring = f.vertices.map(v => cs.toXY(v[0], v[1])) as [number, number][];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < ring.length; i++) { const j = (i + 1) % ring.length; a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]; cx += ring[i][0]; cy += ring[i][1]; }
      return { cx: cx / ring.length, cy: cy / ring.length, r: Math.sqrt(Math.abs(a / 2) / Math.PI) };
    });
  }, [cs, existing]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlayRef = useRef<google.maps.OverlayView | null>(null);
  const csRef = useRef<CS | null>(null);
  useEffect(() => { csRef.current = cs; }, [cs]);

  const [cssSize, setCssSize] = useState({ w: 760, h: 460 });
  const fitScale = useMemo(() => cs ? Math.min((cssSize.w - PAD * 2) / cs.widthFt, (cssSize.h - PAD * 2) / cs.heightFt) : 5, [cs, cssSize]);

  const [mapAffine, setMapAffine] = useState<{ scale: number; ox: number; oy: number } | null>(null);
  const recomputeAffine = useCallback(() => {
    const ov = overlayRef.current, c = csRef.current;
    if (!ov || !c) return;
    const proj = ov.getProjection?.();
    if (!proj) return;
    const toPt = (xFt: number, yFt: number) => { const [lng, lat] = c.toLngLat(xFt, yFt); return proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng)); };
    const a = toPt(0, 0), bx = toPt(c.widthFt, 0), by = toPt(0, c.heightFt);
    if (!a || !bx || !by) return;
    const sx = Math.hypot(bx.x - a.x, bx.y - a.y) / Math.max(c.widthFt, 1e-6);
    const sy = Math.hypot(by.x - a.x, by.y - a.y) / Math.max(c.heightFt, 1e-6);
    const scale = (sx + sy) / 2;
    setMapAffine(prev => prev && Math.abs(prev.scale - scale) < 0.002 && Math.abs(prev.ox - a.x) < 0.5 && Math.abs(prev.oy - a.y) < 0.5 ? prev : { scale, ox: a.x, oy: a.y });
  }, []);

  const scale = mapAffine ? mapAffine.scale : fitScale;
  const ftToPx = useCallback((xFt: number, yFt: number): [number, number] => {
    if (mapAffine) return [mapAffine.ox + xFt * mapAffine.scale, mapAffine.oy + yFt * mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt * fitScale) / 2, oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [ox + xFt * fitScale, oy + yFt * fitScale];
  }, [mapAffine, cs, fitScale, cssSize]);
  const pxToFt = useCallback((cx: number, cy: number): [number, number] => {
    if (mapAffine) return [(cx - mapAffine.ox) / mapAffine.scale, (cy - mapAffine.oy) / mapAffine.scale];
    if (!cs) return [0, 0];
    const ox = (cssSize.w - cs.widthFt * fitScale) / 2, oy = (cssSize.h - cs.heightFt * fitScale) / 2;
    return [(cx - ox) / fitScale, (cy - oy) / fitScale];
  }, [mapAffine, cs, fitScale, cssSize]);

  const mapView = useMemo(() => {
    if (boundary.length < 3) return { center: { lat: 39.74, lng: -104.99 }, zoom: 20 };
    const lngs = boundary.map(v => v[0]), lats = boundary.map(v => v[1]);
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const zoom = Math.log2(156543.03392 * Math.cos(centerLat * Math.PI / 180) * fitScale * 3.28084);
    return { center: { lat: centerLat, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 }, zoom: Math.min(Math.max(zoom, 1), 22.9) };
  }, [boundary, fitScale]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => { const { width, height } = e.contentRect; setCssSize({ w: Math.floor(width), h: Math.floor(height) }); });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => { const m = mapRef.current; if (m && boundary.length >= 3) { m.setCenter(mapView.center); m.setZoom(mapView.zoom); } }, [mapView, boundary]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cs) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize.w, cssSize.h);

    const fillRing = (ring: [number, number][], fill: string, stroke: string | null, lw: number, alpha: number) => {
      if (ring.length < 2) return;
      ctx.beginPath();
      ring.forEach(([x, y], i) => { const [px, py] = ftToPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.closePath();
      ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.fill();
      ctx.globalAlpha = 1;
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    };

    const primaryColor = plan.primary.variant ? VARIANT_COLOR[plan.primary.variant] : (plan.primary.material ? MATERIAL_COLOR[plan.primary.material] : null);
    // ground cover across the whole yard; features/obstacles paint over it
    if (primaryColor && boundaryFt.length >= 3) fillRing(boundaryFt, primaryColor, null, 0, 0.82);
    // lawn → beds → features
    plan.zones.filter(z => z.key === 'lawn').forEach(z => fillRing(ringForShape(z), MATERIAL_COLOR.lawn, MATERIAL_COLOR.lawn, 1, 0.9));
    plan.beds.filter(b => b.material !== 'lawn').forEach(b => { const c = b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material]; fillRing(ringForShape(b), c, c, 1, 0.92); });
    plan.zones.filter(z => z.key !== 'lawn').forEach(z => { const c = z.material ? (FEATURE_MATERIAL_COLOR[z.material] || z.color) : z.color; fillRing(ringForShape(z), c, c, 1, 0.92); });
    // walkways to scale
    plan.paths.forEach(p => {
      if ((p.pts || []).length < 2) return;
      ctx.beginPath();
      p.pts.forEach((pt: [number, number], i: number) => { const [px, py] = ftToPx(pt[0], pt[1]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.strokeStyle = PATH_COLOR; ctx.lineWidth = Math.max(2, (p.widthFt || 3) * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    });
    // existing structures stay visible on top
    obstacleFt.forEach(o => fillRing(o, '#C9C3B4', '#A8A294', 1.5, 0.85));

    // ── Labels ────────────────────────────────────────────────────────────────
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const pill = (text: string, cx: number, cy: number) => {
      ctx.font = `600 11px ${IT}`;
      const tw = ctx.measureText(text).width, w = tw + 12, h = 16;
      ctx.beginPath();
      if ((ctx as any).roundRect) (ctx as any).roundRect(cx - w / 2, cy - h / 2, w, h, 4); else ctx.rect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = 'rgba(42,42,38,0.85)'; ctx.fill();
      ctx.fillStyle = '#efe9db'; ctx.fillText(text, cx, cy);
    };
    const label = (text: string, cx: number, cy: number, fitW: number, fitH: number) => {
      if (!text) return;
      ctx.font = `600 12px ${IT}`;
      const tw = ctx.measureText(text).width;
      if (tw + 12 < fitW && fitH > 18) {
        ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 3;
        ctx.fillText(text, cx, cy);
        ctx.shadowBlur = 0;
      } else {
        pill(text, cx, cy - fitH / 2 - 9); // too small to fit inside → just above it
      }
    };
    const labelRing = (ring: [number, number][], text: string) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
      const [cx, cy] = ftToPx((minX + maxX) / 2, (minY + maxY) / 2);
      label(text, cx, cy, (maxX - minX) * scale, (maxY - minY) * scale);
    };
    plan.zones.forEach(z => labelRing(ringForShape(z), z.label || (z.key === 'lawn' ? 'Lawn' : z.key)));
    plan.beds.filter(b => b.material !== 'lawn').forEach(b => labelRing(ringForShape(b), b.label));
    plan.paths.forEach(p => {
      if ((p.pts || []).length < 2) return;
      const mid = p.pts[Math.floor(p.pts.length / 2)];
      const [cx, cy] = ftToPx(mid[0], mid[1]);
      label(p.label, cx, cy, 0, (p.widthFt || 3) * scale); // walkways are thin → label sits just outside
    });

    // Project boundary — label every side with its length.
    const dimPill = (text: string, cx: number, cy: number) => {
      ctx.font = `600 10px ${IT}`;
      const tw = ctx.measureText(text).width, w = tw + 10, h = 14;
      ctx.beginPath();
      if ((ctx as any).roundRect) (ctx as any).roundRect(cx - w / 2, cy - h / 2, w, h, 3); else ctx.rect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
      ctx.fillStyle = '#2A2A26'; ctx.fillText(text, cx, cy);
    };
    for (let i = 0; i < boundaryFt.length; i++) {
      const a = boundaryFt[i], b = boundaryFt[(i + 1) % boundaryFt.length];
      const lenFt = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (lenFt < 2) continue;
      const [mx, my] = ftToPx((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      dimPill(`${Math.round(lenFt)} ft`, mx, my);
    }

    // ── Privacy edges ───────────────────────────────────────────────────────────
    if (boundaryFt.length >= 3 && (privacyEdges.length || edgeMode)) {
      for (let i = 0; i < boundaryFt.length; i++) {
        const a = boundaryFt[i], b = boundaryFt[(i + 1) % boundaryFt.length];
        const [ax, ay] = ftToPx(a[0], a[1]), [bx, by] = ftToPx(b[0], b[1]);
        const sel = privacyEdges.includes(i);
        if (sel) {
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          ctx.strokeStyle = '#2F6B4F'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
          ctx.font = `600 11px ${IT}`;
          const t = '🔒 Privacy', w = ctx.measureText(t).width + 12;
          const cxp = (ax + bx) / 2, cyp = (ay + by) / 2;
          ctx.beginPath(); if ((ctx as any).roundRect) (ctx as any).roundRect(cxp - w / 2, cyp - 8, w, 16, 4); else ctx.rect(cxp - w / 2, cyp - 8, w, 16);
          ctx.fillStyle = '#2F6B4F'; ctx.fill(); ctx.fillStyle = '#eef3ee'; ctx.fillText(t, cxp, cyp);
        } else if (edgeMode) {
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          ctx.setLineDash([7, 5]); ctx.strokeStyle = 'rgba(47,107,79,0.6)'; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }

    // ── Foundation plant placement (interactive) ───────────────────────────────
    if (interactive) {
      // Existing tree canopies (faint) so spacing is visible.
      existingTreesFt.forEach(t => {
        const [px, py] = ftToPx(t.cx, t.cy);
        ctx.beginPath(); ctx.arc(px, py, Math.max(6, t.r * scale), 0, Math.PI * 2);
        ctx.globalAlpha = 0.18; ctx.fillStyle = '#4A8C6A'; ctx.fill(); ctx.globalAlpha = 1;
      });
      // Structures get a caution outline — keep big plants off them (utility lines, meters).
      obstacleFt.forEach(o => { ctx.beginPath(); o.forEach(([x, y], i) => { const [px, py] = ftToPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.setLineDash([6, 4]); ctx.strokeStyle = '#C77B2B'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); });
    }

    // ── "Low plants only" zones (front of each bed + shallow strips like a parkstrip) ──
    if (frontZones) {
      ctx.fillStyle = 'rgba(199,123,43,0.20)';
      for (const c of frontZones.cells) {
        const [px1, py1] = ftToPx(c.x, c.y), [px2, py2] = ftToPx(c.x + c.w, c.y + c.w);
        const x = Math.min(px1, px2), y = Math.min(py1, py2);
        ctx.fillRect(x - 0.5, y - 0.5, Math.abs(px2 - px1) + 1, Math.abs(py2 - py1) + 1);
      }
    }

    const issues = (m: PlantMarker): boolean => {
      if (boundaryFt.length >= 3 && minEdgeDist(m.x, m.y, boundaryFt) < m.r - 0.5) return true; // canopy crosses the property line
      for (const o of obstacleFt) if (distToPolygon(m.x, m.y, o) < houseCautionFt) return true; // too close to the house (utilities)
      return false;
    };
    // Render each drift as a soft blob (overlapping member canopies, one fill), in its species colour.
    const byDrift = new Map<string, PlantMarker[]>();
    for (const m of plants) { const k = m.drift || m.id; const g = byDrift.get(k) || []; g.push(m); byDrift.set(k, g); }
    for (const members of byDrift.values()) {
      const color = members[0].color || PLANT_KIND_COLOR[members[0].kind] || '#6a9460';
      const hot = highlightName != null && members[0].name === highlightName;
      const dim = highlightName != null && !hot;
      // Small plants (< SMALL_PLANT_R) merge into one amorphous mass instead of tiny dots.
      const small = members[0].r < SMALL_PLANT_R;
      ctx.beginPath();
      for (const m of members) { const [px, py] = ftToPx(m.x, m.y); const r = Math.max(2, (small ? Math.max(m.r, BLOB_DRAW_FT) : m.r) * scale); ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2); }
      ctx.globalAlpha = dim ? 0.16 : hot ? 0.9 : 0.62; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
      if (hot) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke(); }
    }
    // Flag any plant with a problem (rare — placement keeps them legal).
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#C77B2B'; ctx.lineWidth = 2.5;
    for (const m of plants) if (issues(m)) { const [px, py] = ftToPx(m.x, m.y); ctx.beginPath(); ctx.arc(px, py, Math.max(2, m.r * scale), 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
    // Name pill for a clicked plant (only while that species is the active highlight).
    if (tip && tip.name === highlightName) { const [px, py] = ftToPx(tip.x, tip.y); pill(tip.name, px, py - 14); }
  }, [cs, ftToPx, scale, boundaryFt, obstacleFt, plan, cssSize, interactive, plants, existingTreesFt, houseCautionFt, privacyEdges, edgeMode, highlightName, tip, showFront, frontZones]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssSize.w * dpr);
    canvas.height = Math.floor(cssSize.h * dpr);
    canvas.style.width = cssSize.w + 'px';
    canvas.style.height = cssSize.h + 'px';
    draw();
  }, [cssSize, draw]);
  useEffect(() => { draw(); }, [draw, mapAffine]);

  // Drag a plant marker (interactive mode only).
  const dragRef = useRef<string | null>(null);
  const downRef = useRef<{ x: number; y: number; name: string } | null>(null); // plant hit on mousedown (for click detection)
  const downPxRef = useRef<[number, number] | null>(null);
  const movedRef = useRef(false);
  const getPos = (e: React.MouseEvent): [number, number] => { const r = canvasRef.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onDown = (e: React.MouseEvent) => {
    const [mx, my] = getPos(e);
    if (onToggleEdge) { // edge-marking mode: toggle the nearest boundary edge
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < boundaryFt.length; i++) {
        const a = boundaryFt[i], b = boundaryFt[(i + 1) % boundaryFt.length];
        const [ax, ay] = ftToPx(a[0], a[1]), [bx, by] = ftToPx(b[0], b[1]);
        const d = segDist(mx, my, ax, ay, bx, by);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0 && bestD <= 16) onToggleEdge(bestI);
      return;
    }
    if (!onPlantMove && !onPlantSelect) return;
    movedRef.current = false; downRef.current = null; downPxRef.current = [mx, my];
    for (let i = plants.length - 1; i >= 0; i--) {
      const m = plants[i]; const [px, py] = ftToPx(m.x, m.y);
      if (Math.hypot(mx - px, my - py) <= Math.max(14, m.r * scale)) {
        dragRef.current = m.id; downRef.current = { x: m.x, y: m.y, name: m.name || '' }; return;
      }
    }
  };
  const onMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const [mx, my] = getPos(e);
    if (downPxRef.current && Math.hypot(mx - downPxRef.current[0], my - downPxRef.current[1]) > 4) movedRef.current = true;
    if (!onPlantMove) return;
    const [fx, fy] = pxToFt(mx, my);
    const m = plants.find(p => p.id === dragRef.current);
    if (boundaryFt.length >= 3) {
      if (!pointInRing(fx, fy, boundaryFt)) return;                  // center inside the yard
      if (m && minEdgeDist(fx, fy, boundaryFt) < m.r) return;        // canopy must stay fully inside the boundary
    }
    onPlantMove(dragRef.current, fx, fy);
  };
  const onUp = () => {
    if (!movedRef.current) { // a click, not a drag → select / show name
      const hit = downRef.current;
      if (hit && hit.name) { setTip({ x: hit.x, y: hit.y, name: hit.name }); onPlantSelect?.(hit.name); }
      else { setTip(null); onPlantSelect?.(null); }
    }
    dragRef.current = null; downRef.current = null;
  };
  const onLeave = () => { dragRef.current = null; downRef.current = null; };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: height || undefined, aspectRatio: height ? undefined : '16 / 10', borderRadius: 12, overflow: 'hidden', background: '#1a1a1a' }}>
      {isLoaded && (
        <GoogleMap
          mapContainerStyle={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          center={mapView.center}
          zoom={mapView.zoom}
          options={{ mapTypeId: 'satellite', disableDefaultUI: true, gestureHandling: 'none', clickableIcons: false, draggable: false, disableDoubleClickZoom: true, scrollwheel: false, zoomControl: false, keyboardShortcuts: false }}
          onLoad={map => {
            mapRef.current = map;
            const ov = new google.maps.OverlayView();
            ov.onAdd = () => {}; ov.onRemove = () => {};
            ov.draw = () => { recomputeAffine(); };
            ov.setMap(map);
            overlayRef.current = ov;
          }}
        >
          {boundary.length >= 3 && (
            <Polygon paths={[...boundary, boundary[0]].map(v => ({ lat: v[1], lng: v[0] }))}
              options={{ fillColor: '#2F6B4F', fillOpacity: 0, strokeColor: '#FFFFFF', strokeWeight: 2, strokeOpacity: 1, clickable: false }} />
          )}
          {existing.filter(f => f.keep && f.vertices.length >= 3 && f.type === 'tree').map((feat, i) => (
            <Polygon key={`tree-${i}`} paths={feat.vertices.map(v => ({ lat: v[1], lng: v[0] }))}
              options={{ fillColor: FEATURE_COLOR.tree, fillOpacity: 0.4, strokeColor: FEATURE_COLOR.tree, strokeWeight: 2, strokeOpacity: 1, clickable: false }} />
          ))}
        </GoogleMap>
      )}
      <canvas ref={canvasRef}
        onMouseDown={interactive ? onDown : undefined}
        onMouseMove={interactive ? onMove : undefined}
        onMouseUp={interactive ? onUp : undefined}
        onMouseLeave={interactive ? onLeave : undefined}
        style={{ display: 'block', position: 'absolute', inset: 0, pointerEvents: interactive ? 'auto' : 'none', cursor: edgeMode ? 'crosshair' : (onPlantMove ? 'grab' : 'default'), background: 'transparent' }} />
      {topBanner && (
        <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10, maxWidth: 'calc(100% - 28px)', pointerEvents: 'none' }}>
          {topBanner}
        </div>
      )}
      {bottomBanner && (
        <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10, maxWidth: 'calc(100% - 28px)', pointerEvents: 'none' }}>
          {bottomBanner}
        </div>
      )}
    </div>
  );
}
