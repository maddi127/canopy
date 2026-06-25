import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader, Polygon } from '@react-google-maps/api';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';

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

interface Plan { zones: any[]; beds: any[]; paths: any[]; primary: { material: string | null; variant: string | null }; }

export default function DiyPlanMap({ plan }: { plan: Plan }) {
  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

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
  }, [cs, ftToPx, scale, boundaryFt, obstacleFt, plan, cssSize]);

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

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', aspectRatio: '16 / 10', borderRadius: 12, overflow: 'hidden', background: '#1a1a1a' }}>
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
      <canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', inset: 0, pointerEvents: 'none', background: 'transparent' }} />
    </div>
  );
}
