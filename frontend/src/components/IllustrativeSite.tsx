import { useRef, useEffect, useLayoutEffect } from 'react';
// Draw before paint so the static base never flashes blank on mount (avoids a jump at the hand-off).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const IT = "'Inter', system-ui, sans-serif";
const HAND = "'Caveat', cursive";
function cleanLabel(type: string, label: string): string {
  if (type === 'house') return 'House';
  const tail = (label || '').includes('—') ? (label.split('—').pop() || '').trim() : (label || '').trim();
  if (tail && !/^hardscape$/i.test(tail)) return tail.charAt(0).toUpperCase() + tail.slice(1);
  return type === 'structure' ? 'Structure' : 'Paving';
}

// Soft, illustrative top-down render of the SITE (boundary, house, existing hardscape/structures,
// existing trees) — drawn from diyBoundaryFinal. Animates the plan "drawing in": the boundary
// traces, the ground fills, structures fade in, then trees pop. Reusable as a static base later
// (pass animate={false}). Pure canvas, no Google Maps.

type Ring = [number, number][];
interface Feature { type: string; keep: boolean; vertices: [number, number][]; }

function buildCS(verts: Ring) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats);
  const avg = (Math.min(...lats) + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT];
}
function ringArea(r: Ring) { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function centroid(r: Ring): [number, number] { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }
function rng(seed: number) { let s = seed | 1; return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; }; }
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
function shade(hex: string, f: number) { const n = parseInt(hex.slice(1), 16); const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f))); return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`; }

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
export default function IllustrativeSite({ width, height, animate = true, durationMs = 2600, onComplete, transform, startTransform, finishOrientation, bare = false }: { width: number; height: number; animate?: boolean; durationMs?: number; onComplete?: () => void; transform?: Affine; startTransform?: Affine; finishOrientation?: { yardType?: string; holdMs?: number; rotateMs?: number }; bare?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(false);

  useIsoLayoutEffect(() => {
    const canvas = canvasRef.current; if (!canvas || width < 2 || height < 2) return;
    let bf: any = {}; try { bf = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}'); } catch { /* none */ }
    const boundary: Ring = bf.boundary || [];
    if (boundary.length < 3) { onComplete?.(); return; }
    const cs = buildCS(boundary);
    const boundaryFt = boundary.map(v => cs(v[0], v[1])) as Ring;
    const feats: Feature[] = bf.confirmedFeatures || [];
    const toRing = (f: Feature) => f.vertices.map(v => cs(v[0], v[1])) as Ring;
    const houses = feats.filter(f => f.keep && f.type === 'house' && f.vertices.length >= 3).map(f => { const ring = toRing(f); return { ring, c: centroid(ring), label: cleanLabel('house', (f as any).label) }; });
    const builds = feats.filter(f => f.keep && (f.type === 'hardscape' || f.type === 'structure') && f.vertices.length >= 3).map(f => { const ring = toRing(f); return { ring, c: centroid(ring), color: f.type === 'structure' ? '#cdc7b8' : '#d6d1c4', label: cleanLabel(f.type, (f as any).label) }; });
    const trees = feats.filter(f => f.keep && f.type === 'tree' && f.vertices.length >= 3).map(f => { const r = toRing(f); const [tx, ty] = centroid(r); return { x: tx, y: ty, rad: Math.sqrt(ringArea(r) / Math.PI) }; });

    // Centered fit at a given rotation (about the boundary centroid) and fill fraction — produces
    // an affine matrix px = [a·x + c·y + e, b·x + d·y + f]. fill 0.8 ≈ the static north-up fit;
    // 0.9 matches the auto-layout editor's house-oriented fit (so we can rotate seamlessly into it).
    let bcx = 0, bcy = 0; for (const [x, y] of boundaryFt) { bcx += x; bcy += y; } bcx /= boundaryFt.length; bcy /= boundaryFt.length;
    const matrixFor = (theta: number, fill: number): Affine => {
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const rot = (x: number, y: number): [number, number] => { const qx = x - bcx, qy = y - bcy; return [qx * cosT - qy * sinT, qx * sinT + qy * cosT]; };
      // Boundary rotated bbox → scale (fills ~`fill` of the view) + boundary-centered translation.
      let rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
      for (const [x, y] of boundaryFt) { const [rx, ry] = rot(x, y); if (rx < rminX) rminX = rx; if (rx > rmaxX) rmaxX = rx; if (ry < rminY) rminY = ry; if (ry > rmaxY) rmaxY = ry; }
      const rw = (rmaxX - rminX) || 1, rh = (rmaxY - rminY) || 1;
      const s = Math.min(fill * width / rw, fill * height / rh);
      const txB = (width - s * rw) / 2 - s * rminX, tyB = (height - s * rh) / 2 - s * rminY;
      // Visual-mass rotated bbox (boundary + house + hardscape + trees) → blend 60% toward it so the
      // framing matches the auto-layout editor exactly (no jump on the hand-off).
      let uminX = rminX, umaxX = rmaxX, uminY = rminY, umaxY = rmaxY;
      const acc = (x: number, y: number) => { const [rx, ry] = rot(x, y); if (rx < uminX) uminX = rx; if (rx > umaxX) umaxX = rx; if (ry < uminY) uminY = ry; if (ry > umaxY) umaxY = ry; };
      for (const h of houses) for (const [x, y] of h.ring) acc(x, y);
      for (const b of builds) for (const [x, y] of b.ring) acc(x, y);
      for (const t of trees) { acc(t.x - t.rad, t.y - t.rad); acc(t.x + t.rad, t.y + t.rad); }
      const uw = (umaxX - uminX) || 1, uh = (umaxY - uminY) || 1, k = 0.6;
      const txU = (width - s * uw) / 2 - s * uminX, tyU = (height - s * uh) / 2 - s * uminY;
      const tx = txB + (txU - txB) * k, ty = tyB + (tyU - tyB) * k;
      return { a: s * cosT, c: -s * sinT, e: tx - s * cosT * bcx + s * sinT * bcy, b: s * sinT, d: s * cosT, f: ty - s * sinT * bcx - s * cosT * bcy };
    };

    // Final house-oriented rotation (longest wall horizontal, house on the correct side by yard type).
    const thetaEnd = (() => {
      if (!finishOrientation || !houses.length) return 0;
      let best = houses[0].ring, bestA = 0;
      for (const h of houses) { const a = ringArea(h.ring); if (a > bestA) { bestA = a; best = h.ring; } }
      let ea = 0, ll = 0;
      for (let i = 0; i < best.length; i++) { const a = best[i], b = best[(i + 1) % best.length]; const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len > ll) { ll = len; ea = Math.atan2(dy, dx); } }
      const hc = centroid(best), theta0 = -ea, vx = hc[0] - bcx, vy = hc[1] - bcy, c0 = Math.cos(theta0), s0 = Math.sin(theta0);
      const phi = Math.atan2(vx * s0 + vy * c0, vx * c0 - vy * s0);
      const target = /back/i.test(finishOrientation.yardType || '') ? Math.PI / 2 : -Math.PI / 2;
      return theta0 + Math.round((target - phi) / (Math.PI / 2)) * (Math.PI / 2);
    })();

    let curM: Affine = transform || startTransform || matrixFor(0, 0.8);
    const px = (x: number, y: number): [number, number] => [curM.a * x + curM.c * y + curM.e, curM.b * x + curM.d * y + curM.f];
    const scaleOf = () => Math.hypot(curM.a, curM.b); // uniform px-per-foot, for sizing

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const toPxRing = (ring: Ring) => ring.map(v => px(v[0], v[1])) as [number, number][];

    // ── Hand-drawn primitives ──────────────────────────────────────────────────
    // A wobbly closed path through px points. Seeded so the jitter is identical every frame
    // (no shimmer during the rotate animation). Quadratic segments give a loose ink-pen feel.
    const roughPath = (pts: [number, number][], jit: number, seed: number) => {
      const rr = rng(seed); const j = () => (rr() * 2 - 1) * jit; const n = pts.length;
      const sx = pts[0][0] + j(), sy = pts[0][1] + j();
      ctx.beginPath(); ctx.moveTo(sx, sy);
      for (let i = 1; i <= n; i++) {
        const a = pts[(i - 1) % n], b = pts[i % n];
        const mx = (a[0] + b[0]) / 2 + j() * 1.4, my = (a[1] + b[1]) / 2 + j() * 1.4;
        const ex = i === n ? sx : b[0] + j(), ey = i === n ? sy : b[1] + j();
        ctx.quadraticCurveTo(mx, my, ex, ey);
      }
      ctx.closePath();
    };
    // Watercolor wash + uneven blot + sketchy double ink outline.
    const wash = (pts: [number, number][], fillHex: string, alpha: number, seed: number, ink = 'rgba(74,68,54,0.6)', lw = 1.4, shadow = true) => {
      if (shadow) { ctx.save(); ctx.translate(2, 3); roughPath(pts, 1.1, seed); ctx.globalAlpha = 0.1 * alpha; ctx.fillStyle = '#3a352a'; ctx.fill(); ctx.restore(); }
      ctx.save(); ctx.globalAlpha = alpha; roughPath(pts, 1.1, seed); ctx.fillStyle = fillHex; ctx.fill(); ctx.restore();
      ctx.save(); ctx.globalAlpha = alpha * 0.16; roughPath(pts, 2.6, seed + 3); ctx.fillStyle = shade(fillHex, 0.86); ctx.fill(); ctx.restore();
      ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      roughPath(pts, 1.3, seed + 11); ctx.globalAlpha = alpha * 0.8; ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke();
      roughPath(pts, 2.4, seed + 21); ctx.globalAlpha = alpha * 0.32; ctx.lineWidth = lw * 0.85; ctx.stroke();
      ctx.restore();
    };
    // Pencil hatch clipped to a shape (diagonal graphite shading, like the placed features).
    const hatchShape = (pts: [number, number][], color: string, d: number, jit: number, seed: number, alpha: number, cross = false) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const w = maxX - minX;
      ctx.save(); roughPath(pts, 0.8, seed); ctx.clip();
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.lineCap = 'round';
      const draw = (slope: number, s2: number) => { const rr = rng(s2); const j = () => (rr() * 2 - 1) * jit; for (let b = minY - w; b <= maxY; b += d) { ctx.beginPath(); ctx.moveTo(minX - 2, b + j()); ctx.lineTo(maxX + 2, b + slope * w + j()); ctx.stroke(); } };
      draw(1, seed + 5); if (cross) draw(-1, seed + 9);
      ctx.restore();
    };
    // House: paper fill, bold sketchy outline, diagonal pencil hatch so it reads as a building.
    const house = (h: { ring: Ring; c: [number, number] }, alpha: number, seed: number) => {
      const pts = toPxRing(h.ring);
      wash(pts, '#efe9dd', alpha, seed, 'rgba(60,52,40,0.8)', 2.1);
      hatchShape(pts, 'rgba(74,64,50,0.28)', 9, 1.1, seed, alpha * 0.6);
    };
    // Boundary: sketchy double ink line, traced up to fraction f of its perimeter.
    const tracedBoundary = (f: number) => {
      const pts = boundaryFt.map(v => px(v[0], v[1])); pts.push(pts[0]);
      let total = 0; const segs: number[] = []; for (let i = 0; i < pts.length - 1; i++) { const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); segs.push(d); total += d; }
      const target = total * f; let acc = 0; const poly: [number, number][] = [pts[0]];
      for (let i = 0; i < segs.length; i++) {
        if (acc + segs[i] <= target) { poly.push(pts[i + 1]); acc += segs[i]; }
        else { const t = (target - acc) / segs[i]; poly.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]); break; }
      }
      const pass = (jit: number, seed: number, col: string, w: number, al: number) => {
        const rr = rng(seed); const j = () => (rr() * 2 - 1) * jit;
        ctx.beginPath(); poly.forEach((pt, i) => { const x = pt[0] + j(), y = pt[1] + j(); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.globalAlpha = al; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      };
      ctx.save(); pass(1.3, 31, '#6f6552', 2.3, 0.85); pass(2.3, 47, '#8a7f68', 1.4, 0.4); ctx.restore();
    };
    const labelText = (text: string, c: [number, number], alpha: number, seed: number) => {
      const [cx, cy] = px(c[0], c[1]); const rr = rng(seed); const rot = (rr() * 2 - 1) * 0.035;
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx, cy); ctx.rotate(rot);
      ctx.font = `600 18px ${HAND}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(247,243,234,0.92)'; ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
      ctx.fillStyle = '#40392e'; ctx.fillText(text, 0, 0); ctx.restore();
    };
    // Tree: loose wobbly canopy with a defined ink edge (so it reads as a tree, not a smudge),
    // translucent fill so anything beneath stays visible, plus scribbled foliage texture.
    const tree = (t: { x: number; y: number; rad: number }, grow: number, seed: number) => {
      const [cx, cy] = px(t.x, t.y); const R = Math.max(8, t.rad * scaleOf()) * grow;
      const rr = rng(seed); const N = 11; const ring: [number, number][] = [];
      for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2, rad = R * (0.8 + rr() * 0.34); ring.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
      const green = '#7fa15f';
      ctx.save(); ctx.translate(R * 0.1, R * 0.14); roughPath(ring, 1.5, seed + 1); ctx.globalAlpha = 0.08; ctx.fillStyle = '#384028'; ctx.fill(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.4; roughPath(ring, 1.4, seed + 2); ctx.fillStyle = green; ctx.fill(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.15; roughPath(ring, 2.7, seed + 5); ctx.fillStyle = shade(green, 0.8); ctx.fill(); ctx.restore();
      ctx.save(); roughPath(ring, 1.2, seed + 7); ctx.globalAlpha = 0.5; ctx.strokeStyle = 'rgba(55,75,42,0.6)'; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.32; ctx.strokeStyle = 'rgba(60,85,48,0.55)'; ctx.lineWidth = 1; ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) { const a = rr() * Math.PI * 2, d = rr() * R * 0.45, bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d, br = R * (0.18 + rr() * 0.22); ctx.beginPath(); ctx.arc(bx, by, br, a, a + 1.6 + rr()); ctx.stroke(); }
      ctx.restore();
    };

    const drawAt = (p: number) => {
      ctx.clearRect(0, 0, width, height);
      const bPts = toPxRing(boundaryFt);
      const groundA = clamp01((p - 0.05) / 0.3);
      // `bare` (auto-layout, on graph paper): skip the lot ground fill, inner shadow and boundary
      // outline so the grid shows through — only the house, hardscape and trees are drawn.
      if (!bare && groundA > 0) {
        ctx.save(); roughPath(bPts, 1.0, 2); ctx.globalAlpha = groundA; ctx.fillStyle = '#E7E1CE'; ctx.fill(); ctx.restore();
        // soft inner shadow → the lot reads as a contained board, distinct from the matte outside.
        ctx.save(); roughPath(bPts, 1.0, 2); ctx.clip(); roughPath(bPts, 1.0, 2);
        ctx.globalAlpha = groundA; ctx.strokeStyle = 'rgba(120,108,86,0.16)'; ctx.lineWidth = 16; ctx.stroke(); ctx.restore();
      }
      tracedBoundary(clamp01(p / 0.32));
      const featA = clamp01((p - 0.34) / 0.24);
      if (featA > 0) {
        builds.forEach((b, i) => { const bp = toPxRing(b.ring); wash(bp, b.color, featA, i * 53 + 13, 'rgba(86,80,66,0.5)', 1.2); hatchShape(bp, 'rgba(78,72,60,0.24)', 10, 1.1, i * 53 + 20, featA * 0.55, true); });
        houses.forEach((h, i) => house(h, featA, i * 131 + 9));
        const labA = clamp01((p - 0.5) / 0.2);
        if (labA > 0) { houses.forEach((h, i) => labelText(h.label, h.c, labA, i * 7 + 3)); builds.forEach((b, i) => labelText(b.label, b.c, labA, i * 23 + 5)); }
      }
      trees.forEach((t, i) => { const ts = 0.56 + (trees.length ? i / trees.length : 0) * 0.4; const tp = clamp01((p - ts) / 0.16); if (tp > 0) tree(t, tp, i * 911 + 7); });
    };

    if (!animate) {
      drawAt(1); onComplete?.();
      // Repaint once the hand-lettering font finishes loading (canvas text won't re-flow on its own).
      try { (document as any).fonts?.ready?.then(() => { try { drawAt(1); } catch { /* unmounted */ } }); } catch { /* no font API */ }
      return;
    }

    // Start aligned to the live map (startTransform = the map's px-per-foot projection), or the
    // plain north-up fit. Phase 3 zooms + rotates from there to the placement orientation by
    // interpolating a rotate-about-centroid + scale + pan (so it tracks the same yard the whole way).
    const easeInOut = (p: number) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const startM: Affine = startTransform || matrixFor(0, 0.8);
    const endM: Affine = matrixFor(thetaEnd, 0.8);
    const applyM = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    const [scx0, scy0] = applyM(startM, bcx, bcy);
    const [scx1, scy1] = applyM(endM, bcx, bcy);
    const s0 = Math.hypot(startM.a, startM.b), s1 = Math.hypot(endM.a, endM.b);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const transAffine = (e: number): Affine => {
      const theta = thetaEnd * e, sc = lerp(s0, s1, e);
      const a = sc * Math.cos(theta), b = sc * Math.sin(theta), c = -sc * Math.sin(theta), d = sc * Math.cos(theta);
      const cx = lerp(scx0, scx1, e), cy = lerp(scy0, scy1, e);
      return { a, b, c, d, e: cx - (a * bcx + c * bcy), f: cy - (b * bcx + d * bcy) };
    };
    const holdMs = finishOrientation?.holdMs ?? 500;
    const rotateMs = finishOrientation?.rotateMs ?? 950;
    let raf = 0, start = 0;
    const frame = (ts: number) => {
      if (!start) start = ts;
      const t = ts - start;
      if (t < durationMs) {                                   // Phase 1: draw the plan in, aligned to the map
        curM = transform || startM;
        drawAt(clamp01(t / durationMs));
        raf = requestAnimationFrame(frame); return;
      }
      if (!finishOrientation) {                               // No transition requested — done after draw-in
        curM = transform || startM; drawAt(1);
        if (!doneRef.current) { doneRef.current = true; onComplete?.(); }
        return;
      }
      if (t < durationMs + holdMs) {                          // Phase 2: hold a beat
        curM = startM; drawAt(1);
        raf = requestAnimationFrame(frame); return;
      }
      const rp = (t - durationMs - holdMs) / rotateMs;        // Phase 3: zoom + rotate into placement
      if (rp < 1) {
        curM = transAffine(easeInOut(clamp01(rp)));
        drawAt(1);
        raf = requestAnimationFrame(frame); return;
      }
      curM = endM; drawAt(1);
      if (!doneRef.current) { doneRef.current = true; onComplete?.(); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [width, height, animate, durationMs, transform?.a, transform?.b, transform?.c, transform?.d, transform?.e, transform?.f, startTransform?.a, startTransform?.b, startTransform?.e, startTransform?.f, finishOrientation?.yardType, finishOrientation?.holdMs, finishOrientation?.rotateMs, bare]);

  return <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />;
}
