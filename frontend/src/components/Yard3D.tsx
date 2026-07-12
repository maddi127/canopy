import { useEffect, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { IllustrationEffects } from './IllustrationEffects';
import { Plant } from './Plant3D';
import { ZoneProxy } from './Furnishings3D';
import { getStreetViewInsights } from '../services/streetViewService';

// Warm off-white "paper" tone used for the iso background when illustration mode is on
// (see (B) PAPER BACKGROUND in the illustration-mode prototype).
const PAPER_BG = '#f6f1e6';
const INK_LINE = '#3a3630';

// Exposes a capture fn (fresh render → PNG data URL) to the parent via a ref.
function CaptureBridge({ exportRef }: { exportRef: React.MutableRefObject<(() => string | null) | null> }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    exportRef.current = () => {
      // Reveal the capture-only label layer for exactly one render, then hide it again so the live
      // on-screen 3D never shows labels. Purely imperative on the THREE objects — no React state.
      const labels = scene.getObjectByName('capture-labels');
      try {
        if (labels) labels.visible = true;
        gl.render(scene, camera);
        return gl.domElement.toDataURL('image/png');
      } catch { return null; }
      finally { if (labels) labels.visible = false; }
    };
    return () => { exportRef.current = null; };
  }, [exportRef, gl, scene, camera]);
  return null;
}

// ── Data (read from the same localStorage the 2D flow writes) ──────────────────────
type Ring = [number, number][];
interface Feature { type: string; keep: boolean; vertices: [number, number][]; }
interface PlantInstance { x: number; y: number; name: string; layer: string; widthFt: number; heightFt: number; type: string; evergreen: boolean; color: string; }

// Material colours — kept identical to the 2D plan (DiyPlanMap) so the 3D view matches it.
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const VARIANT_COLOR: Record<string, string> = { natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B' };
const FEATURE_MATERIAL_COLOR: Record<string, string> = { pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48' };
const PATH_COLOR = '#6E7681';
const HARDSCAPE_COLOR = '#C9C3B4';
const bedColor = (b: any): string => b.material === 'lawn' ? MATERIAL_COLOR.lawn : (b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material]) || '#8B6B4A';
const zoneColor = (z: any): string => z.key === 'lawn' ? MATERIAL_COLOR.lawn : (z.material ? (FEATURE_MATERIAL_COLOR[z.material] || z.color) : z.color) || '#B7AC9A';
const primaryColorOf = (pr: any): string => (pr?.variant ? VARIANT_COLOR[pr.variant] : (pr?.material ? MATERIAL_COLOR[pr.material] : null)) || '#8a7355';

// ── Procedural material textures (canvas-drawn, tinted to the plan colour) ──────────
const TILE_FT: Record<string, number> = { mulch: 3, rock: 2.4, gravel: 1.2, lawn: 2.5, pavers: 1.6, concrete: 4, flagstone: 2.8, brick: 1, wood: 0.7, soil: 3 };
const _texCache = new Map<string, any>();
function shadeHex(hex: string, f: number): string {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + ((1 << 24) + (c((n >> 16) & 255) << 16) + (c((n >> 8) & 255) << 8) + c(n & 255)).toString(16).slice(1);
}
function makeTexture(kind: string, base: string): any {
  const key = `${kind}|${base}`; const hit = _texCache.get(key); if (hit) return hit;
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  let s = (kind.length * 131 + base.length * 17) | 0 || 1;
  const rnd = () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
  const dot = (x: number, y: number, r: number, col: string) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  if (kind === 'mulch' || kind === 'soil') {
    for (let i = 0; i < 260; i++) { g.save(); g.translate(rnd() * S, rnd() * S); g.rotate(rnd() * Math.PI); g.fillStyle = shadeHex(base, 0.68 + rnd() * 0.6); g.fillRect(-3 - rnd() * 4, -1.3, 6 + rnd() * 9, 2.6); g.restore(); }
  } else if (kind === 'rock') {
    for (let i = 0; i < 95; i++) dot(rnd() * S, rnd() * S, 4 + rnd() * 9, shadeHex(base, 0.72 + rnd() * 0.55));
  } else if (kind === 'gravel') {
    for (let i = 0; i < 430; i++) dot(rnd() * S, rnd() * S, 1.4 + rnd() * 3, shadeHex(base, 0.68 + rnd() * 0.62));
  } else if (kind === 'lawn') {
    for (let i = 0; i < 1100; i++) { g.strokeStyle = shadeHex(base, 0.78 + rnd() * 0.5); g.lineWidth = 1; const x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 3); g.stroke(); }
  } else if (kind === 'pavers' || kind === 'flagstone') {
    for (let i = 0; i < 44; i++) dot(rnd() * S, rnd() * S, 8 + rnd() * 16, shadeHex(base, 0.93 + rnd() * 0.12));
    const t = S / 4; g.strokeStyle = shadeHex(base, 0.74); g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * t, 0); g.lineTo(i * t, S); g.stroke(); g.beginPath(); g.moveTo(0, i * t); g.lineTo(S, i * t); g.stroke(); }
  } else if (kind === 'brick') {
    const bw = S / 6, bh = S / 12; g.strokeStyle = shadeHex(base, 0.68); g.lineWidth = 2;
    for (let r = 0; r * bh < S; r++) { const off = (r % 2) * bw / 2; for (let k = -1; k * bw < S; k++) g.strokeRect(k * bw + off, r * bh, bw, bh); }
  } else if (kind === 'wood') {
    const pw = S / 5; g.strokeStyle = shadeHex(base, 0.72); g.lineWidth = 3;
    for (let i = 0; i <= 5; i++) { g.beginPath(); g.moveTo(i * pw, 0); g.lineTo(i * pw, S); g.stroke(); }
    for (let i = 0; i < 140; i++) { g.strokeStyle = shadeHex(base, 0.82 + rnd() * 0.22); g.lineWidth = 1; const x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 12 + rnd() * 34); g.stroke(); }
  } else { // concrete & default — subtle mottle
    for (let i = 0; i < 60; i++) dot(rnd() * S, rnd() * S, 7 + rnd() * 14, shadeHex(base, 0.9 + rnd() * 0.16));
  }
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
  _texCache.set(key, tex); return tex;
}
const bedKind = (b: any): string => b.material === 'lawn' ? 'lawn' : b.material === 'rock' ? ((b.variant === 'river' || b.variant === 'pea') ? 'gravel' : 'rock') : 'mulch';
const zoneKind = (z: any): string => ({ pavers: 'pavers', concrete: 'concrete', flagstone: 'flagstone', gravel: 'gravel', brick: 'brick', mulch: 'mulch' } as any)[z.material] || 'concrete';
const primaryKind = (pr: any): string => pr?.material === 'rock' ? ((pr.variant === 'river' || pr.variant === 'pea') ? 'gravel' : 'rock') : pr?.material === 'lawn' ? 'lawn' : 'mulch';
// Wall material → an existing texture kind.
const wallKind = (m?: string): string => ({ stucco: 'concrete', brick: 'brick', siding: 'wood', stone: 'rock', wood: 'wood' } as any)[m || ''] || 'concrete';

// lat/lng → feet, matching the rest of the app (deterministic from the boundary verts).
function buildCS(verts: [number, number][]) {
  const lngs = verts.map(v => v[0]), lats = verts.map(v => v[1]);
  const minLng = Math.min(...lngs), maxLat = Math.max(...lats);
  const avg = (Math.min(...lats) + maxLat) / 2;
  const mLat = 111320, mLng = 111320 * Math.cos(avg * Math.PI / 180), FT = 3.28084;
  return (lng: number, lat: number): [number, number] => [(lng - minLng) * mLng * FT, (maxLat - lat) * mLat * FT];
}
function ringArea(r: Ring) { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(a / 2); }
function centroid(r: Ring): [number, number] { let x = 0, y = 0; for (const [px, py] of r) { x += px; y += py; } return [x / r.length, y / r.length]; }

// Lighten/darken a hex by factor f (for foliage variation within a canopy).
function shade(hex: string, f: number): string {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// Existing tree → a clustered procedural canopy.
function ExistingTree({ x, z, rad }: { x: number; z: number; rad: number }) {
  const h = rad * 2.4, cr = rad;
  let s = (Math.floor(x * 41.3) ^ Math.floor(z * 29.7)) | 1;
  const rnd = () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
  const blobs = Array.from({ length: 7 }, () => [(rnd() - 0.5) * cr, h * (0.45 + rnd() * 0.5), (rnd() - 0.5) * cr, cr * (0.5 + rnd() * 0.4), 0.8 + rnd() * 0.34] as const);
  return (
    <group position={[x, 0, z]}>
      <mesh castShadow position={[0, h * 0.22, 0]}><cylinderGeometry args={[rad * 0.1, rad * 0.15, h * 0.45, 6]} /><meshStandardMaterial color="#6b4f33" /></mesh>
      {blobs.map((b, i) => <mesh key={i} castShadow position={[b[0], b[1], b[2]]}><icosahedronGeometry args={[b[3], 1]} /><meshStandardMaterial color={shade('#5f7d53', b[4])} flatShading /></mesh>)}
    </group>
  );
}

// Build a flat (ground-plane) shape from a ring of feet, centred on (cx,cy).
function flatShape(ring: Ring, cx: number, cy: number) {
  const s = new THREE.Shape();
  // CANONICAL WORLD CONVENTION — the shape is built with shapeY = cy − fy, but these meshes are
  // rotated −π/2 about X, and that rotation maps shapeY → −worldZ. Net result: ground layers
  // RENDER at world (X, Z) = (fx − cx, fy − cy) — a pure translation of plan feet, NO mirror.
  // Every point-placed object (plants, trees, furniture, labels, roof, camera targets) must
  // therefore use Z = y − cy. Using cy − y mirrors it across the yard's E–W centreline.
  ring.forEach(([fx, fy], i) => { const X = fx - cx, Z = cy - fy; if (i) s.lineTo(X, Z); else s.moveTo(X, Z); });
  s.closePath();
  return s;
}

function Ground({ ring, cx, cy, color, y = 0, opacity = 1, kind }: { ring: Ring; cx: number; cy: number; color: string; y?: number; opacity?: number; kind?: string }) {
  const geo = useMemo(() => new THREE.ShapeGeometry(flatShape(ring, cx, cy)), [ring, cx, cy]);
  const tex = useMemo(() => kind ? makeTexture(kind, color) : null, [kind, color]);
  if (tex) { const tf = TILE_FT[kind!] || 3; tex.repeat.set(1 / tf, 1 / tf); } // ShapeGeometry UVs are in feet → world-aligned tiling
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow>
      <meshStandardMaterial color={tex ? '#ffffff' : color} map={tex || undefined} side={THREE.DoubleSide} transparent={opacity < 1} opacity={opacity} roughness={opacity < 1 ? 0.2 : 0.95} />
    </mesh>
  );
}

// A feature pad with real thickness (ground view): a low extruded slab so it reads as a built
// paver/concrete pad at eye level and can never z-fight with the lawn running beneath it.
function ZoneSlab({ ring, cx, cy, color, kind }: { ring: Ring; cx: number; cy: number; color: string; kind?: string }) {
  const geo = useMemo(() => new THREE.ExtrudeGeometry(flatShape(ring, cx, cy), { depth: 0.3, bevelEnabled: false }), [ring, cx, cy]);
  const tex = useMemo(() => kind ? makeTexture(kind, color) : null, [kind, color]);
  if (tex) { const tf = TILE_FT[kind!] || 3; tex.repeat.set(1 / tf, 1 / tf); }
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]} receiveShadow castShadow>
      <meshStandardMaterial color={tex ? '#ffffff' : color} map={tex || undefined} roughness={0.95} />
    </mesh>
  );
}

function Building({ ring, cx, cy, height, color, kind }: { ring: Ring; cx: number; cy: number; height: number; color: string; kind?: string }) {
  const geo = useMemo(() => new THREE.ExtrudeGeometry(flatShape(ring, cx, cy), { depth: height, bevelEnabled: false }), [ring, cx, cy, height]);
  const tex = useMemo(() => kind ? makeTexture(kind, color) : null, [kind, color]);
  if (tex) { const tf = TILE_FT[kind!] || 3; tex.repeat.set(1 / tf, 1 / tf); }
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
      <meshStandardMaterial color={tex ? '#ffffff' : color} map={tex || undefined} />
    </mesh>
  );
}

// A gradient dome (ground view only) — warm pale horizon blending up to soft blue. Big
// inward-facing sphere so the empty void behind the yard reads as sky in the conditioning image.
function SkyDome({ radius, illustrate }: { radius: number; illustrate?: boolean }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256; const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    // Illustration: trend the whole sky toward the PAPER_BG tone so the world fades paper-ward
    // before the IllustrationEffects vignette finishes fading the corners to paper.
    if (illustrate) {
      grad.addColorStop(0, '#dfe1d6'); grad.addColorStop(0.62, '#ece9dc'); grad.addColorStop(1, '#f6f1e6');
    } else {
      grad.addColorStop(0, '#bcd2e2'); grad.addColorStop(0.62, '#d7e2e6'); grad.addColorStop(1, '#f3e9d8');
    }
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }, [illustrate]);
  return (
    <mesh>
      <sphereGeometry args={[radius, 24, 16]} />
      <meshBasicMaterial map={tex} side={THREE.BackSide} fog={false} depthWrite={false} />
    </mesh>
  );
}

// Simple hip roof (ground view only) over a house footprint. Builds a low ridge along the
// footprint's longest edge with overhanging eaves — silhouette only; Gemini repaints it.
function HipRoof({ ring, cx, cy, wallTop, style, roofType, roofColorHex }: { ring: Ring; cx: number; cy: number; wallTop: number; style?: string; roofType?: 'gable' | 'hip' | 'flat' | null; roofColorHex?: string | null }) {
  // Shape precedence: an explicit Street View roofType wins over the style heuristic.
  //   'flat' → thin parapet cap · 'hip'/'gable' → hip prism · (none) → 'modern' style ⇒ parapet.
  const parapet = roofType ? roofType === 'flat' : style === 'modern';
  // Colour: a validated hex from Street View overrides the default shingle tone.
  const roofColor = (typeof roofColorHex === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(roofColorHex)) ? roofColorHex : '#4a453e';
  const { geo, pos } = useMemo(() => {
    // Centre the ring on the footprint centroid, in local (X, Z) plane.
    const [fx, fy] = centroid(ring);
    const local = ring.map(([px, py]) => [px - fx, py - fy] as [number, number]);
    // Longest edge → ridge axis; build an axis-aligned oriented bbox around it.
    let bestLen = -1, ang = 0;
    for (let i = 0; i < local.length; i++) {
      const a = local[i], b = local[(i + 1) % local.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L > bestLen) { bestLen = L; ang = Math.atan2(dy, dx); }
    }
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [px, py] of local) {
      const u = px * ca - py * sa, v = px * sa + py * ca;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const OVER = 1; // eave overhang (ft)
    const hu = (maxU - minU) / 2 + OVER, hv = (maxV - minV) / 2 + OVER; // half-extents (U=ridge, V=slope)
    const midU = (minU + maxU) / 2, midV = (minV + maxV) / 2;
    const rise = parapet ? 0.5 : 6; // parapet → thin cap; else hip prism
    // 6 verts: 4 eave corners + 2 ridge ends (ridge runs along U, inset on V), built in the
    // UV frame around the bbox centre. WORLD CONVENTION (see flatShape): point objects sit at
    // (x − cx, y − cy) — a pure translation of plan feet, no reflection. So UV→world is just
    // the +ang rotation baked into the verts: (u,v) → (u·cos − v·sin, u·sin + v·cos) as (X, Z).
    const ridgeInset = parapet ? 0 : Math.min(hv, hu) * 0.55;
    const cA = Math.cos(ang), sA = Math.sin(ang);
    const uv: [number, number, number][] = [
      [-hu, 0, -hv], [hu, 0, -hv], [hu, 0, hv], [-hu, 0, hv], // eaves (y=0)
      [-hu + ridgeInset, rise, 0], [hu - ridgeInset, rise, 0], // ridge ends (y=rise)
    ];
    const verts = new Float32Array(uv.flatMap(([u, y, v]) => {
      const u2 = u + midU, v2 = v + midV;
      return [u2 * cA - v2 * sA, y, u2 * sA + v2 * cA];
    }));
    const idx = [
      0, 1, 4, 1, 5, 4, 1, 2, 5, 2, 3, 5, // long slopes + one hip end
      2, 0, 4, 4, 5, 2, 3, 0, 4, // remaining hip triangles (double-sided material covers winding)
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return { geo: g, pos: [fx - cx, wallTop, fy - cy] as [number, number, number] };
  }, [ring, cx, cy, wallTop, parapet]);
  return (
    <mesh geometry={geo} position={pos} castShadow receiveShadow>
      <meshStandardMaterial color={roofColor} side={THREE.DoubleSide} flatShading />
    </mesh>
  );
}

// ── Capture-only text labels ────────────────────────────────────────────────────────
// Sprites drawn on a CanvasTexture (bold white on a dark pill). They live in a group that
// is hidden on-screen and only made visible during the capture render (see CaptureBridge),
// so Gemini can read the object identities burned into the conditioning image. drei's <Html>
// is a DOM overlay and would NOT appear in toDataURL — hence Sprite + CanvasTexture.
const _labelCache = new Map<string, { texture: any; aspect: number }>();
function labelSprite(text: string): { texture: any; aspect: number } {
  const hit = _labelCache.get(text); if (hit) return hit;
  const SCALE = 4, FS = 44 * SCALE, PAD = 24 * SCALE, RAD = 18 * SCALE;
  const meas = document.createElement('canvas').getContext('2d')!;
  meas.font = `bold ${FS}px system-ui, -apple-system, Helvetica, Arial, sans-serif`;
  const tw = meas.measureText(text).width;
  const w = Math.ceil(tw + PAD * 2), h = Math.ceil(FS + PAD * 1.4);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')!;
  // rounded dark pill
  g.fillStyle = 'rgba(20,22,18,0.85)';
  g.beginPath();
  g.moveTo(RAD, 0); g.lineTo(w - RAD, 0); g.arcTo(w, 0, w, RAD, RAD);
  g.lineTo(w, h - RAD); g.arcTo(w, h, w - RAD, h, RAD);
  g.lineTo(RAD, h); g.arcTo(0, h, 0, h - RAD, RAD);
  g.lineTo(0, RAD); g.arcTo(0, 0, RAD, 0, RAD);
  g.closePath(); g.fill();
  // bold white text
  g.font = `bold ${FS}px system-ui, -apple-system, Helvetica, Arial, sans-serif`;
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + FS * 0.02);
  const texture = new THREE.CanvasTexture(c); texture.anisotropy = 4; texture.needsUpdate = true;
  const out = { texture, aspect: w / h };
  _labelCache.set(text, out); return out;
}
// A billboard sprite sized in world feet (height clamped for legibility, width from text aspect).
function CaptureLabel({ text, pos, size }: { text: string; pos: [number, number, number]; size: number }) {
  const { texture, aspect } = useMemo(() => labelSprite(text), [text]);
  const hFt = Math.max(2.2, size * 0.035);
  const wFt = hFt * aspect;
  return (
    <sprite position={pos} scale={[wFt, hFt, 1]}>
      <spriteMaterial map={texture} depthTest={false} depthWrite={false} transparent />
    </sprite>
  );
}

function Scene({ houseAttrs, ground = false, hero = false, fittedDist = 60, camDir = [0, 1], illustration = false }: { houseAttrs?: { stories?: number; material?: string; color?: string; style?: string }; ground?: boolean; hero?: boolean; fittedDist?: number; camDir?: [number, number]; illustration?: boolean }) {
  // 'hero' = the static illustration render (elevated three-quarter, Bower&Branch-style): uses the
  // ground view's DIMENSIONAL contents (roof, slabs, furniture) but floats on paper — no sky, no
  // apron, no controls, no capture labels — and the built environment goes pale LINE-ART so the
  // landscape owns all the color.
  const groundish = ground || hero;
  // Illustration mode applies wherever it's requested — iso (yard-3d) and ground (plan-ready).
  const illustrate = illustration;
  const data = useMemo(() => {
    const read = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
    const bf = read('diyBoundaryFinal');
    const plan = read('diyPlacementPlan');
    let instances: PlantInstance[] = [];
    try { instances = JSON.parse(localStorage.getItem('diyPlantInstances') || '[]'); } catch { /* none */ }
    const boundary: [number, number][] = bf.boundary || [];
    if (boundary.length < 3) return null;
    const cs = buildCS(boundary);
    const boundaryFt = boundary.map(v => cs(v[0], v[1])) as Ring;
    const [cx, cy] = centroid(boundaryFt);
    const feats: Feature[] = bf.confirmedFeatures || [];
    const toRing = (f: Feature) => f.vertices.map(v => cs(v[0], v[1])) as Ring;
    const houses = feats.filter(f => f.keep && f.type === 'house' && f.vertices.length >= 3).map(toRing);
    const structures = feats.filter(f => f.keep && f.type === 'structure' && f.vertices.length >= 3).map(toRing);
    const hardscapes = feats.filter(f => f.keep && f.type === 'hardscape' && f.vertices.length >= 3).map(toRing);
    const exTrees = feats.filter(f => f.keep && f.type === 'tree' && f.vertices.length >= 3).map(f => { const r = toRing(f); const [tx, ty] = centroid(r); return { x: tx, y: ty, rad: Math.sqrt(ringArea(r) / Math.PI) }; });
    const ringOf = (s: any): Ring | null => (s.ring && s.ring.length >= 3) ? s.ring : null;
    const beds = (plan.beds || []).map((b: any) => ({ ring: ringOf(b), color: bedColor(b), kind: bedKind(b) })).filter((b: any) => b.ring);
    const zones = (plan.zones || []).map((z: any) => ({ ring: ringOf(z), color: zoneColor(z), kind: zoneKind(z), lawn: z.key === 'lawn', water: /water|pool|pond|spa/i.test(`${z.key || ''} ${z.label || ''}`), key: z.key || '', label: z.label || '' })).filter((z: any) => z.ring);
    const paths = (plan.paths || []).filter((p: any) => (p.pts || []).length >= 2);
    const primaryColor = primaryColorOf(plan.primary);
    const primaryKindV = primaryKind(plan.primary);
    const size = Math.max(...boundaryFt.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 2;
    // Street View roof facts (front yards only; null when absent) drive the roof shape + colour.
    const svHouse = getStreetViewInsights()?.house ?? null;
    const roofType = svHouse?.roofType ?? null;
    const roofColorHex = svHouse?.roofColorHex ?? null;
    return { boundaryFt, cx, cy, houses, structures, hardscapes, exTrees, beds, zones, paths, instances, size, primaryColor, primaryKindV, roofType, roofColorHex };
  }, []);
  // "Plan card" — a thin base the whole yard sits on, for the floating-diorama look.
  const baseGeo = useMemo(() => data ? new THREE.ExtrudeGeometry(flatShape(data.boundaryFt, data.cx, data.cy), { depth: 1.4, bevelEnabled: false }) : null, [data]);

  if (!data) return null;
  const { boundaryFt, cx, cy, houses, structures, hardscapes, exTrees, beds, zones, paths, instances, size, primaryColor, primaryKindV, roofType, roofColorHex } = data;

  // path strips → flat gray quads per segment
  const pathQuads: Ring[] = [];
  for (const p of paths) {
    const w = (p.widthFt || 3) / 2;
    for (let i = 0; i < p.pts.length - 1; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * w, ny = dx / len * w;
      pathQuads.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
    }
  }

  // ── Capture label inventory (ground view only). Anchors reuse the exact feet→world mapping
  //    used everywhere else: X = fx - cx, Z = fy - cy. Skip any anchor we can't compute. ──
  const captureLabels = useMemo(() => {
    if (!ground) return [] as { key: string; text: string; pos: [number, number, number] }[];
    const out: { key: string; text: string; pos: [number, number, number] }[] = [];
    // (a) feature zones — label at the centroid, floated above the yard.
    zones.forEach((z: any, i: number) => {
      const text = (z.label || (z.lawn ? 'LAWN' : z.key) || 'FEATURE').toUpperCase();
      const [fcx, fcy] = centroid(z.ring);
      out.push({ key: `zl${i}`, text, pos: [fcx - cx, z.lawn ? 4 : 5.5, fcy - cy] });
    });
    // (b) paths — WALKWAY / DRY CREEK above the polyline midpoint.
    paths.forEach((p: any, i: number) => {
      const pts = p.pts || []; if (pts.length < 2) return;
      const mid = pts[Math.floor(pts.length / 2)];
      if (!mid) return;
      out.push({ key: `pl${i}`, text: p.kind === 'creek' ? 'DRY CREEK' : 'WALKWAY', pos: [mid[0] - cx, 3, mid[1] - cy] });
    });
    // (c) plant species — one label per distinct species, above the LARGEST instance, top-10 by count.
    const byName = new Map<string, { count: number; best: PlantInstance; r: number }>();
    for (const p of instances) {
      const nm = (p.name || '').trim(); if (!nm) continue;
      const r = Math.max(0.3, (p.widthFt || 0) / 2);
      const e = byName.get(nm);
      if (!e) byName.set(nm, { count: 1, best: p, r });
      else { e.count++; if (r > e.r) { e.r = r; e.best = p; } }
    }
    [...byName.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10).forEach(([nm, e], i) => {
      const p = e.best;
      out.push({ key: `sl${i}`, text: nm.toUpperCase(), pos: [p.x - cx, Math.max(0.4, p.heightFt || 0) + 2.5, p.y - cy] });
    });
    // (d) house — above the roof ridge (wall top + ~8 ft).
    houses.forEach((r: Ring, i: number) => {
      const [hx, hy] = centroid(r);
      const wallTop = Math.max(1, houseAttrs?.stories || 1) * 10;
      out.push({ key: `hl${i}`, text: 'HOUSE', pos: [hx - cx, wallTop + 8, hy - cy] });
    });
    return out;
  }, [ground, zones, paths, instances, houses, cx, cy, houseAttrs]);

  // ── Ground-view sun: behind & to the left of the initial camera, elevated ~40°, warm — so
  //    the yard is front-lit from the viewer's POV with soft long shadows. Iso keeps its fixed sun.
  const sun = useMemo(() => {
    if (!groundish) return { pos: [size * 0.55, size * 1.25, size * 0.5] as [number, number, number], color: '#ffffff', intensity: 1.05 };
    let cdx = camDir[0], cdz = camDir[1]; const cl = Math.hypot(cdx, cdz) || 1; cdx /= cl; cdz /= cl; // camera→origin is -camDir
    // "Behind the camera" = along +camDir; "to the left" = rotate that 90° (screen-left).
    const leftX = -cdz, leftZ = cdx; // left of the forward (toward-house) direction
    const bx = cdx * 0.7 + leftX * 0.7, bz = cdz * 0.7 + leftZ * 0.7; // behind + left blend
    const bl = Math.hypot(bx, bz) || 1;
    const horiz = size * 1.1, height = size * 1.1; // ~40° elevation
    return { pos: [(bx / bl) * horiz, height, (bz / bl) * horiz] as [number, number, number], color: '#ffe8c8', intensity: 1.15 };
  }, [ground, camDir, size]);

  return (
    <>
      {/* Even fill + a directional sun that casts the plan's shadows. Illustration mode (iso only)
          cranks the ambient/hemi fill and drops the sun way down with shadows off, so surfaces
          read as flat watercolor panels instead of photoreal shading — see (C) FLAT WATERCOLOR
          FILLS in the illustration-mode prototype. */}
      <ambientLight intensity={illustrate ? 1.05 : 0.62} />
      <hemisphereLight args={['#ffffff', '#c7cdbb', illustrate ? 0.85 : 0.55]} />
      <directionalLight
        position={sun.pos} intensity={illustrate ? 0.28 : sun.intensity} color={sun.color} castShadow={!illustrate}
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-size} shadow-camera-right={size} shadow-camera-top={size} shadow-camera-bottom={-size}
        shadow-camera-near={1} shadow-camera-far={size * 5} shadow-bias={-0.0004}
      />

      {/* Ground view only: gradient sky dome + a big neutral ground apron so the yard sits in a
          continuous landscape (hides the diorama slab edge) instead of on a floating card. */}
      {ground && <SkyDome radius={Math.max(size * 10, fittedDist * 3)} illustrate={illustrate} />}
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
          <circleGeometry args={[size * 8, 48]} />
          {/* Illustration: mute the apron toward paper (keeps a hint of sage) so it reads as page. */}
          <meshStandardMaterial color={illustrate ? '#c8d0b0' : '#8ea86f'} roughness={0.98} />
        </mesh>
      )}

      {/* plan card */}
      {baseGeo && <mesh geometry={baseGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.41, 0]} receiveShadow><meshStandardMaterial color="#ECE8DC" /></mesh>}

      {/* base ground = primary planting material */}
      <Ground ring={boundaryFt} cx={cx} cy={cy} color={primaryColor} kind={primaryKindV} y={0} />
      {beds.map((b: any, i: number) => <Ground key={`bed${i}`} ring={b.ring} cx={cx} cy={cy} color={b.color} kind={b.kind} y={groundish ? 0.1 : 0.02} />)}
      {/* Lawn sits just below feature zones so features cleanly occlude it (it's a base region
          that overlaps them — moving a feature out reveals the lawn beneath, no re-carve needed).
          GROUND VIEW: the lawn runs UNDER feature pads, and coplanar decals (4mm apart) z-fight at
          eye-level grazing angles — the lawn shimmers through and furniture "sits on grass". So at
          eye level, feature pads render as raised SLABS (real paver-pad thickness) and the decal
          layers get real depth separation. The iso diorama keeps its flat decals. */}
      {zones.map((z: any, i: number) => z.water
        ? <Ground key={`zone${i}`} ring={z.ring} cx={cx} cy={cy} color="#5fa8c8" y={groundish ? 0.14 : 0.06} opacity={0.82} />
        : groundish && !z.lawn
          ? <ZoneSlab key={`zone${i}`} ring={z.ring} cx={cx} cy={cy} color={z.color} kind={z.kind} />
          : <Ground key={`zone${i}`} ring={z.ring} cx={cx} cy={cy} color={z.color} kind={z.kind} y={z.lawn ? 0.015 : 0.03} />)}
      {pathQuads.map((q, i) => <Ground key={`path${i}`} ring={q} cx={cx} cy={cy} color={PATH_COLOR} kind="pavers" y={groundish ? 0.18 : 0.04} />)}

      {/* structures — house height/material/colour from house attributes (manual or detected) */}
      {houses.map((r, i) => <Building key={`h${i}`} ring={r} cx={cx} cy={cy} height={Math.max(1, houseAttrs?.stories || 1) * 10} color={hero ? '#f3f1ea' : (houseAttrs?.color || '#d2cdc0')} kind={hero ? undefined : wallKind(houseAttrs?.material)} />)}
      {/* Ground view only: a simple roof gives houses a correct silhouette at eye level
          (flat ExtrudeGeometry looks roofless). 'modern' → thin parapet cap; else a hip roof. */}
      {groundish && houses.map((r, i) => <HipRoof key={`roof${i}`} ring={r} cx={cx} cy={cy} wallTop={Math.max(1, houseAttrs?.stories || 1) * 10} style={houseAttrs?.style} roofType={roofType} roofColorHex={hero ? '#dcd9d0' : roofColorHex} />)}
      {structures.map((r, i) => <Building key={`s${i}`} ring={r} cx={cx} cy={cy} height={9} color={hero ? '#efede6' : '#c8c2b4'} />)}
      {hardscapes.map((r, i) => <Ground key={`hs${i}`} ring={r} cx={cx} cy={cy} color={hero ? '#f0eee9' : HARDSCAPE_COLOR} kind={hero ? undefined : 'concrete'} y={groundish ? 0.22 : 0.05} />)}

      {/* existing trees */}
      {/* world Z = y − cy (see the canonical-convention note at flatShape) */}
      {exTrees.map((t: any, i: number) => <ExistingTree key={`et${i}`} x={t.x - cx} z={t.y - cy} rad={t.rad} />)}

      {/* designed plants */}
      {instances.map((p, i) => <Plant key={`p${i}`} p={p} cx={cx} cy={cy} />)}

      {/* Ground view only: furniture proxies so positions come from our geometry, not the model. */}
      {/* raised by the slab height so furniture stands ON the pad, not sunk into it */}
      {groundish && <group position={[0, 0.3, 0]}>{zones.map((z: any, i: number) => <ZoneProxy key={`zp${i}`} zone={z} cx={cx} cy={cy} />)}</group>}

      {/* Ground view only: capture-only text labels — hidden on-screen, shown during capture (see
          CaptureBridge) so Gemini can read the object identities burned into the conditioning image. */}
      {ground && (
        <group name="capture-labels" visible={false}>
          {captureLabels.map(l => <CaptureLabel key={l.key} text={l.text} pos={l.pos} size={size} />)}
        </group>
      )}

      {!hero && <OrbitControls
        target={ground ? (() => { const hc = houses.length ? centroid(houses[0]) : [cx, cy]; return [hc[0] - cx, 6, hc[1] - cy] as [number, number, number]; })() : [0, 0, 0]}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={ground ? fittedDist * 0.35 : size * 0.25}
        maxDistance={ground ? fittedDist * 2 : size * 2.5}
      />}

      {/* Illustration mode (iso only): ink outlines + gentle desaturate/warm grade — (A) INK
          OUTLINES and (D) COLOR GRADE in the illustration-mode prototype. Mounted last so the
          post pass sees the fully-built scene. */}
      {illustrate && <IllustrationEffects />}
    </>
  );
}

export default function Yard3D({ houseAttrs, view = 'iso', exportRef, illustration = false }: {
  houseAttrs?: { stories?: number; material?: string; color?: string; style?: string };
  /** 'iso' = floating diorama; 'ground' = eye-level facing the house; 'hero' = the STATIC
   *  illustration render — elevated three-quarter, house at the back, no controls, paper page. */
  view?: 'iso' | 'ground' | 'hero';
  /** Receives a capture fn returning the current view as a PNG data URL. */
  exportRef?: React.MutableRefObject<(() => string | null) | null>;
  /** Illustration (hand-drawn NPR) styling — works on all views (hero forces it on). */
  illustration?: boolean;
}) {
  const geom = useMemo(() => {
    const FOV = 52; // vertical fov (deg) — kept in sync with the Canvas below
    try {
      const bf = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      const b: [number, number][] = bf.boundary || [];
      if (b.length < 3) return { size: 60, cam: [0, 5.5, 60] as [number, number, number], fitted: 60, heroCam: [0, 45, 65] as [number, number, number], heroTarget: [0, 3, 0] as [number, number, number] };
      const cs = buildCS(b); const ft = b.map(v => cs(v[0], v[1])) as Ring; const [cx, cy] = centroid(ft);
      const size = Math.max(20, Math.max(...ft.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 2);
      // Ground camera: eye level at the yard edge OPPOSITE the house, looking toward it —
      // the classic "standing at the street" viewpoint (works for back yards too: opposite side).
      const houses = (bf.confirmedFeatures || []).filter((f: any) => f.keep && f.type === 'house' && (f.vertices?.length ?? 0) >= 3);
      let dirX = 0, dirZ = 1;
      if (houses.length) {
        const hr = houses[0].vertices.map((v: [number, number]) => cs(v[0], v[1])) as Ring;
        const [hx, hy] = centroid(hr);
        const wx = hx - cx, wz = hy - cy; const L = Math.hypot(wx, wz) || 1;
        dirX = -wx / L; dirZ = -wz / L; // away from the house
      }
      // ── Auto-fit: place the camera so the boundary's bounding sphere (incl. house height)
      //    fits within the fov. Only the horizontal distance grows; eye height stays human. ──
      const houseTop = Math.max(1, houseAttrs?.stories || 1) * 10;
      // Bounding sphere: horizontal radius = size/2 (max reach from centroid), plus half the
      // vertical extent so a tall house near the top of frame isn't clipped.
      const sphereR = Math.hypot(size / 2, houseTop / 2) * 1.12; // ~12% margin
      const vFov = FOV * Math.PI / 180;
      // Horizontal fov from the canvas aspect (assume ~16:10 when unknown).
      const aspect = 16 / 10;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const fov = Math.min(vFov, hFov); // tighter constraint governs the fit distance
      const fitted = Math.max(size * 0.4, sphereR / Math.sin(fov / 2));
      // Keep eye at 5.5ft; only let it rise (to ≤9ft) if the fit distance is huge (very deep yard).
      const eyeY = Math.min(9, 5.5 + Math.max(0, fitted - size * 1.4) * 0.02);
      const cam: [number, number, number] = [dirX * fitted, eyeY, dirZ * fitted];
      // ── HERO camera: elevated three-quarter (Bower&Branch composition) — same "opposite the
      //    house" azimuth, ~35° elevation, fov 45, auto-fit; gaze pulled slightly houseward so
      //    the house sits at the back of frame and the yard fans toward the viewer. ──
      const HERO_ELEV = 35 * Math.PI / 180, HERO_FOV = 45 * Math.PI / 180;
      const hHFov = 2 * Math.atan(Math.tan(HERO_FOV / 2) * aspect);
      const heroDist = Math.max(size * 0.6, (sphereR * 1.08) / Math.sin(Math.min(HERO_FOV, hHFov) / 2));
      const hh = heroDist * Math.cos(HERO_ELEV);
      const heroCam: [number, number, number] = [dirX * hh, heroDist * Math.sin(HERO_ELEV), dirZ * hh];
      // Local house centroid (world frame X = x−cx, Z = y−cy) for the gaze target.
      let hcX = 0, hcZ = 0;
      if (houses.length) { const hr2 = houses[0].vertices.map((v: [number, number]) => cs(v[0], v[1])) as Ring; const [hx2, hy2] = centroid(hr2); hcX = hx2 - cx; hcZ = hy2 - cy; }
      const heroTarget: [number, number, number] = [hcX * 0.3, houseTop * 0.25, hcZ * 0.3];
      return { size, cam, fitted, heroCam, heroTarget };
    } catch { return { size: 60, cam: [0, 5.5, 60] as [number, number, number], fitted: 60, heroCam: [0, 45, 65] as [number, number, number], heroTarget: [0, 3, 0] as [number, number, number] }; }
  }, [houseAttrs]);
  const { size, cam, fitted, heroCam, heroTarget } = geom;
  const d = size * 2;
  return view === 'hero' ? (
    // STATIC illustration render — elevated three-quarter on a paper page, no controls, no sky.
    // Consumers capture this via exportRef and show the resulting PNG; this canvas itself is
    // typically mounted offscreen and unmounted after capture.
    <Canvas shadows gl={{ preserveDrawingBuffer: true }}
      camera={{ position: heroCam, fov: 45, near: 0.5, far: Math.max(d, fitted) * 8 }}
      onCreated={({ camera }) => { camera.lookAt(heroTarget[0], heroTarget[1], heroTarget[2]); camera.updateProjectionMatrix(); }}
      style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={[PAPER_BG]} />
      <Scene houseAttrs={houseAttrs} hero fittedDist={fitted} camDir={[heroCam[0], heroCam[2]]} illustration />
      {exportRef && <CaptureBridge exportRef={exportRef} />}
    </Canvas>
  ) : view === 'ground' ? (
    // Eye-level perspective — the massing reference for the photorealistic render.
    <Canvas shadows gl={{ preserveDrawingBuffer: true }}
      camera={{ position: cam, fov: 52, near: 0.5, far: Math.max(d, fitted) * 6 }} style={{ width: '100%', height: '100%' }}>
      <Scene houseAttrs={houseAttrs} ground fittedDist={fitted} camDir={[cam[0], cam[2]]} illustration={illustration} />
      {exportRef && <CaptureBridge exportRef={exportRef} />}
    </Canvas>
  ) : (
    // Orthographic + a true-isometric direction ([1,1,1]) = the landscaping-plan look.
    <Canvas shadows gl={exportRef ? { preserveDrawingBuffer: true } : undefined}
      orthographic camera={{ position: [d, d, d], zoom: Math.max(2.5, 560 / size), near: 0.1, far: d * 6 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={[illustration ? PAPER_BG : '#EEF0E9']} />
      <Scene houseAttrs={houseAttrs} illustration={illustration} />
      {exportRef && <CaptureBridge exportRef={exportRef} />}
    </Canvas>
  );
}
