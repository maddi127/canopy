import { useRef, useEffect, useLayoutEffect } from 'react';
import { sketchStroke, sketchRing, scallopPath, graphGrid, hatchPattern } from '../lib/sketch';
import { HAND, INK } from '../lib/theme';
// Draw before paint so the static base never flashes blank on mount (avoids a jump at the hand-off).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
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
export default function IllustrativeSite({ width, height, animate = true, durationMs = 2600, onComplete, transform, startTransform, finishOrientation, bare = false, elevation = false }: { width: number; height: number; animate?: boolean; durationMs?: number; onComplete?: () => void; transform?: Affine; startTransform?: Affine; finishOrientation?: { yardType?: string; holdMs?: number; rotateMs?: number }; bare?: boolean; elevation?: boolean }) {
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
      // Paper fill + graphite hatch stay; the outline gets the crisp wobbly-ink treatment.
      wash(pts, '#efe9dd', alpha, seed, 'rgba(0,0,0,0)', 0, true);
      hatchShape(pts, 'rgba(74,64,50,0.28)', 9, 1.1, seed, alpha * 0.6);
      ctx.save(); ctx.globalAlpha = alpha;
      sketchRing(ctx, pts, { seed: seed + 61, color: '#3c3428', width: 2.1, wobble: 1.1, passes: 2, alpha: 0.85 });
      ctx.restore();
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
      // Wobbly pressure-varied ink line, closed once the full perimeter has traced.
      const done = f >= 0.999;
      ctx.save();
      sketchStroke(ctx, poly, { seed: 31, color: '#6f6552', width: 2.3, wobble: 1.2, passes: 2, alpha: 0.72, overshoot: done ? 0 : 3, closed: done });
      sketchStroke(ctx, poly, { seed: 47, color: '#8a7f68', width: 1.3, wobble: 2.1, passes: 1, alpha: 0.4, overshoot: done ? 0 : 3, closed: done });
      ctx.restore();
    };
    const labelText = (text: string, c: [number, number], alpha: number, seed: number) => {
      const [cx, cy] = px(c[0], c[1]); const rr = rng(seed); const rot = (rr() * 2 - 1) * 0.035;
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx, cy); ctx.rotate(rot);
      ctx.font = `600 18px ${HAND}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(247,243,234,0.92)'; ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
      ctx.fillStyle = INK; ctx.fillText(text, 0, 0); ctx.restore();
    };
    // Tree: loose wobbly canopy with a defined ink edge (so it reads as a tree, not a smudge),
    // translucent fill so anything beneath stays visible, plus scribbled foliage texture.
    const tree = (t: { x: number; y: number; rad: number }, grow: number, seed: number) => {
      const [cx, cy] = px(t.x, t.y); const R = Math.max(8, t.rad * scaleOf()) * grow;
      const green = '#7fa15f';
      // Scalloped cloud canopy (translucent, so anything beneath stays visible).
      const canopy = scallopPath(cx, cy, R, { seed });
      ctx.save(); ctx.translate(R * 0.1, R * 0.14); ctx.globalAlpha = 0.08; ctx.fillStyle = '#384028'; ctx.fill(canopy); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = green; ctx.fill(canopy); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.15; ctx.fillStyle = shade(green, 0.8); ctx.fill(scallopPath(cx - R * 0.14, cy - R * 0.14, R * 0.66, { seed: seed + 5 })); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.55; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(55,75,42,0.7)'; ctx.stroke(canopy); ctx.restore();
      // 2–3 interior branch squiggles radiating from the centre.
      const rr = rng(seed + 13);
      const nb = 2 + Math.round(rr());
      for (let i = 0; i < nb; i++) {
        const a = rr() * Math.PI * 2, len = R * (0.4 + rr() * 0.3), bend = (rr() * 2 - 1) * len * 0.22;
        const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
        const mx = cx + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, my = cy + Math.sin(a) * len * 0.5 + Math.cos(a) * bend;
        sketchStroke(ctx, [[cx, cy], [mx, my], [ex, ey]], { seed: seed + i * 29 + 3, color: 'rgba(70,90,50,0.5)', width: 1.1, wobble: 0.7, passes: 1, overshoot: 0 });
      }
    };

    // ── Elevation ("illustration view") primitives — the plan is tilted (squashed y) upstream via
    // the transform; heights are drawn as pure screen-up offsets at the ground plane's x-scale. ──
    const doorPt: [number, number] | null = Array.isArray(bf.doorPoint) && bf.doorPoint.length === 2 ? cs(bf.doorPoint[0], bf.doorPoint[1]) : null;
    const houseElev = (h: { ring: Ring; c: [number, number] }, seed: number) => {
      const g = toPxRing(h.ring);
      const s = scaleOf();
      const wallH = 9 * s;
      const t = g.map(([x, y]) => [x, y - wallH]) as [number, number][];
      let cgx = 0, cgy = 0; for (const [x, y] of g) { cgx += x; cgy += y; } cgx /= g.length; cgy /= g.length;
      // Ground shadow so the building sits on the page.
      ctx.save(); ctx.translate(3, 4); roughPath(g, 1.2, seed + 1); ctx.globalAlpha = 0.12; ctx.fillStyle = '#3a352a'; ctx.fill(); ctx.restore();
      // Viewer-facing walls (edges on the lower half of the footprint), lit from the left.
      const visible: { g0: [number, number]; g1: [number, number]; t0: [number, number]; t1: [number, number]; mid: number }[] = [];
      for (let i = 0; i < g.length; i++) {
        const j = (i + 1) % g.length;
        const my = (g[i][1] + g[j][1]) / 2;
        if (my >= cgy - 0.5) visible.push({ g0: g[i], g1: g[j], t0: t[i], t1: t[j], mid: my });
      }
      visible.sort((a, b) => a.mid - b.mid); // farther walls first
      for (const wq of visible) {
        const pts: [number, number][] = [wq.g0, wq.g1, wq.t1, wq.t0];
        const lean = wq.g1[0] - wq.g0[0]; // west-ish faces slightly darker
        ctx.save(); roughPath(pts, 0.9, seed + Math.round(wq.g0[0])); ctx.globalAlpha = 0.96; ctx.fillStyle = lean >= 0 ? '#F2EDE1' : '#E4DECF'; ctx.fill();
        ctx.globalAlpha = 0.75; ctx.strokeStyle = 'rgba(60,52,40,0.75)'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
        // Facade details: door on the wall nearest the marked entry, windows on long walls.
        const wlen = Math.hypot(wq.g1[0] - wq.g0[0], wq.g1[1] - wq.g0[1]);
        const ux = (wq.g1[0] - wq.g0[0]) / (wlen || 1), uy = (wq.g1[1] - wq.g0[1]) / (wlen || 1);
        const rect = (fr: number, wFt: number, hFt: number, baseLift: number, fill: string) => {
          const w2 = (wFt * s) / 2, hh = hFt * s;
          const bx = wq.g0[0] + ux * wlen * fr, by = wq.g0[1] + uy * wlen * fr - baseLift * s;
          const p2: [number, number][] = [[bx - ux * w2, by - uy * w2], [bx + ux * w2, by + uy * w2], [bx + ux * w2, by + uy * w2 - hh], [bx - ux * w2, by - uy * w2 - hh]];
          ctx.save(); roughPath(p2, 0.6, seed + Math.round(bx)); ctx.globalAlpha = 0.95; ctx.fillStyle = fill; ctx.fill();
          ctx.globalAlpha = 0.6; ctx.strokeStyle = 'rgba(60,52,40,0.7)'; ctx.lineWidth = 1.1; ctx.stroke(); ctx.restore();
        };
        let doorFr = -1;
        if (doorPt) {
          const dpx = px(doorPt[0], doorPt[1]);
          const vx = dpx[0] - wq.g0[0], vy = dpx[1] - wq.g0[1];
          const along = (vx * ux + vy * uy) / (wlen || 1);
          const perp = Math.abs(vx * -uy + vy * ux);
          if (along > 0.05 && along < 0.95 && perp < 14) { doorFr = along; rect(along, 3.4, 7, 0, '#8A6F52'); }
        }
        if (wlen > 14 * s) {
          for (const fr of [0.26, 0.74]) {
            if (doorFr > 0 && Math.abs(fr - doorFr) < 0.18) continue;
            rect(fr, 3, 3.2, 3.4, '#CBD6D0');
          }
        }
      }
      // Roof: the footprint raised by the wall height — washed, hatched, inked.
      wash(t, '#DCD5C3', 1, seed + 4, 'rgba(60,52,40,0.8)', 2);
      hatchShape(t, 'rgba(74,64,50,0.25)', 9, 1.1, seed + 6, 0.55);
    };
    const treeElev = (tr: { x: number; y: number; rad: number }, seed: number) => {
      const [bx, by] = px(tr.x, tr.y);
      const s = scaleOf();
      const R = Math.max(9, tr.rad * s);
      const trunkH = R * 1.35;
      // Ground shadow (squashed ellipse).
      ctx.save(); ctx.globalAlpha = 0.1; ctx.beginPath(); ctx.ellipse(bx + R * 0.12, by + R * 0.08, R * 0.85, R * 0.32, 0, 0, Math.PI * 2); ctx.fillStyle = '#33402a'; ctx.fill(); ctx.restore();
      // Trunk.
      ctx.save(); ctx.strokeStyle = '#7A5B3E'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, R * 0.14);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + R * 0.05, by - trunkH); ctx.stroke(); ctx.restore();
      // Canopy — same loose wobbly style as the plan trees, raised to the top of the trunk.
      const cy2 = by - trunkH - R * 0.35;
      const rr2 = rng(seed); const N = 11; const ring: [number, number][] = [];
      for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2, rad = R * (0.82 + rr2() * 0.32); ring.push([bx + Math.cos(a) * rad, cy2 + Math.sin(a) * rad * 0.92]); }
      const green = '#8AA968';
      ctx.save(); ctx.globalAlpha = 0.9; roughPath(ring, 1.4, seed + 2); ctx.fillStyle = green; ctx.fill(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.5; roughPath(ring.map(([x, y]) => [x - R * 0.18, y - R * 0.18]) as [number, number][], 2.2, seed + 5); ctx.fillStyle = '#B4CC8F'; ctx.fill(); ctx.restore();
      ctx.save(); roughPath(ring, 1.2, seed + 7); ctx.globalAlpha = 0.6; ctx.strokeStyle = 'rgba(55,75,42,0.65)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.3; ctx.strokeStyle = 'rgba(60,85,48,0.55)'; ctx.lineWidth = 1; ctx.lineCap = 'round';
      for (let i = 0; i < 6; i++) { const a = rr2() * Math.PI * 2, d = rr2() * R * 0.4; ctx.beginPath(); ctx.arc(bx + Math.cos(a) * d, cy2 + Math.sin(a) * d, R * (0.16 + rr2() * 0.2), a, a + 1.5 + rr2()); ctx.stroke(); }
      ctx.restore();
    };

    const drawAt = (p: number) => {
      ctx.clearRect(0, 0, width, height);
      // Faint drafting graph grid, under everything (over the paper), aligned to the
      // feet transform so it rotates with the plan — heavier every 25 ft.
      graphGrid(ctx, width, height, scaleOf(), { origin: px(0, 0), angle: Math.atan2(curM.b, curM.a) });
      const bPts = toPxRing(boundaryFt);
      const groundA = clamp01((p - 0.05) / 0.3);
      // `bare` (auto-layout, on graph paper): skip the lot ground fill, inner shadow and boundary
      // outline so the grid shows through — only the house, hardscape and trees are drawn.
      if (!bare && groundA > 0) {
        ctx.save(); roughPath(bPts, 1.0, 2); ctx.globalAlpha = groundA; ctx.fillStyle = '#E7E1CE'; ctx.fill(); ctx.restore();
        // Drawn-earth texture: a light mulch/soil fleck tile so the base ground reads as hand-drawn
        // paper-with-tooth rather than a flat vector fill.
        ctx.save(); roughPath(bPts, 1.0, 2); ctx.clip();
        const gp = ctx.createPattern(hatchPattern('#c7b48f', 'mulch', 2), 'repeat');
        if (gp) { ctx.globalAlpha = groundA * 0.32; ctx.fillStyle = gp; ctx.fillRect(0, 0, width, height); }
        ctx.restore();
        // soft inner shadow → the lot reads as a contained board, distinct from the matte outside.
        ctx.save(); roughPath(bPts, 1.0, 2); ctx.clip(); roughPath(bPts, 1.0, 2);
        ctx.globalAlpha = groundA; ctx.strokeStyle = 'rgba(120,108,86,0.16)'; ctx.lineWidth = 16; ctx.stroke(); ctx.restore();
      }
      tracedBoundary(clamp01(p / 0.32));
      if (elevation) {
        // Illustration view: flat paving first, then houses + trees as STANDING objects, painted
        // back-to-front by their base position so nearer things overlap farther ones correctly.
        builds.forEach((b, i) => { const bp = toPxRing(b.ring); wash(bp, b.color, 1, i * 53 + 13, 'rgba(86,80,66,0.5)', 1.2); hatchShape(bp, 'rgba(78,72,60,0.24)', 10, 1.1, i * 53 + 20, 0.55, true); });
        builds.forEach((b, i) => labelText(b.label, b.c, 1, i * 23 + 5));
        const standing: { baseY: number; draw: () => void }[] = [
          ...houses.map((h, i) => ({ baseY: Math.max(...toPxRing(h.ring).map(pt => pt[1])), draw: () => houseElev(h, i * 131 + 9) })),
          ...trees.map((t, i) => ({ baseY: px(t.x, t.y)[1], draw: () => treeElev(t, i * 911 + 7) })),
        ];
        standing.sort((a, b) => a.baseY - b.baseY);
        standing.forEach(s => s.draw());
        return;
      }
      const featA = clamp01((p - 0.34) / 0.24);
      if (featA > 0) {
        builds.forEach((b, i) => {
          const bp = toPxRing(b.ring);
          wash(bp, b.color, featA, i * 53 + 13, 'rgba(0,0,0,0)', 0);
          hatchShape(bp, 'rgba(78,72,60,0.24)', 10, 1.1, i * 53 + 20, featA * 0.55, true);
          ctx.save(); ctx.globalAlpha = featA; sketchRing(ctx, bp, { seed: i * 53 + 71, color: '#565042', width: 1.4, wobble: 1.0, passes: 2, alpha: 0.8 }); ctx.restore();
        });
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
  }, [width, height, animate, durationMs, transform?.a, transform?.b, transform?.c, transform?.d, transform?.e, transform?.f, startTransform?.a, startTransform?.b, startTransform?.e, startTransform?.f, finishOrientation?.yardType, finishOrientation?.holdMs, finishOrientation?.rotateMs, bare, elevation]);

  return <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />;
}
