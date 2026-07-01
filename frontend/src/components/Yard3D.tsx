import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

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

// Map the database's descriptive colour (foliage or bloom) to a hex tint.
const COLOR_HEX: Record<string, string> = {
  'green': '#5f8a4e', 'dark green': '#3f6b3a', 'deep green': '#3f6b3a', 'medium green': '#5f8a4e', 'light green': '#7faa5a', 'bright green': '#6fa348', 'emerald': '#3f8a55',
  'blue-green': '#5e8b7e', 'blue green': '#5e8b7e', 'gray-green': '#8a9a82', 'grey-green': '#8a9a82', 'gray green': '#8a9a82', 'silver': '#b7c0b0', 'silvery': '#b7c0b0', 'gray': '#9aa39a', 'grey': '#9aa39a',
  'gold': '#c9a227', 'golden': '#c9a227', 'yellow': '#cdb53b', 'chartreuse': '#9bbf3b', 'lime': '#9bbf3b',
  'purple': '#7a5a9e', 'violet': '#7a5a9e', 'lavender': '#9d8ec4', 'magenta': '#a85a8e',
  'blue': '#5b86a8',
  'pink': '#d98aa6', 'rose': '#d98aa6',
  'white': '#e8e6dd', 'cream': '#e3dcc4',
  'red': '#a8443a', 'crimson': '#a8443a', 'scarlet': '#a8443a',
  'burgundy': '#6e3b3b', 'maroon': '#6e3b3b', 'deep red': '#6e3b3b',
  'orange': '#cf7b3a', 'coral': '#d98a5a', 'apricot': '#d8a36a',
  'bronze': '#8a6a4a', 'copper': '#9a6a44', 'variegated': '#9bb37a',
};
function foliageColor(raw: string, evergreen: boolean): string {
  const k = (raw || '').toLowerCase().trim();
  if (COLOR_HEX[k]) return COLOR_HEX[k];
  for (const key in COLOR_HEX) if (k.includes(key)) return COLOR_HEX[key];
  return evergreen ? '#3f6b3a' : '#5f8a4e'; // sensible green fallback
}
// Lighten/darken a hex by factor f (for foliage variation within a canopy).
function shade(hex: string, f: number): string {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// Deterministic per-position RNG so a plant's procedural detail is stable across renders.
function rngFrom(x: number, y: number) {
  let s = (Math.floor(x * 131.7) ^ Math.floor(y * 97.3)) | 0 || 1;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
}

// A thin oriented cylinder between two points (for stems).
function Stem({ base, tip, thickness, color }: { base: number[]; tip: number[]; thickness: number; color: string }) {
  const { mid, quat, len } = useMemo(() => {
    const b = new THREE.Vector3(base[0], base[1], base[2]), t = new THREE.Vector3(tip[0], tip[1], tip[2]);
    const dir = t.clone().sub(b); const len = dir.length() || 0.01;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const m = b.clone().add(t).multiplyScalar(0.5);
    return { mid: [m.x, m.y, m.z] as [number, number, number], quat, len };
  }, [base, tip]);
  return <mesh position={mid} quaternion={quat}><cylinderGeometry args={[thickness, thickness, len, 4]} /><meshStandardMaterial color={color} /></mesh>;
}

// Columbine: lacy low foliage mound + thin stems holding small nodding flowers.
function Columbine({ p, cx, cy }: { p: PlantInstance; cx: number; cy: number }) {
  const x = p.x - cx, z = p.y - cy;
  const r = Math.max(0.4, p.widthFt / 2), h = Math.max(0.9, p.heightFt * 1.35);
  const base = foliageColor(p.color, false);
  const flower = (base === '#5f8a4e' || base === '#3f6b3a') ? '#c14b54' : base; // columbine flowers aren't green
  const stems = useMemo(() => {
    const rand = rngFrom(p.x, p.y), arr: { base: number[]; tip: number[] }[] = [];
    const n = Math.max(5, Math.min(9, Math.round(r * 12)));
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2, reach = r * (0.25 + rand() * 0.7), sh = h * (0.55 + rand() * 0.45);
      arr.push({ base: [(rand() - 0.5) * r * 0.3, 0.12, (rand() - 0.5) * r * 0.3], tip: [Math.cos(ang) * reach, sh, Math.sin(ang) * reach] });
    }
    return arr;
  }, [p.x, p.y, r, h]);
  const fr = Math.min(0.1, r * 0.22);
  return (
    <group position={[x, 0, z]}>
      {[0, 1, 2, 3].map(i => <mesh key={i} position={[(i - 1.5) * r * 0.32, 0.15, ((i % 2) - 0.5) * r * 0.45]} scale={[1, 0.45, 1]}><icosahedronGeometry args={[r * 0.5, 1]} /><meshStandardMaterial color="#5f8a4e" flatShading /></mesh>)}
      {stems.map((s, i) => (
        <group key={i}>
          <Stem base={s.base} tip={s.tip} thickness={0.022} color="#6a4a3a" />
          <mesh position={[s.tip[0], s.tip[1], s.tip[2]]}><sphereGeometry args={[fr, 7, 6]} /><meshStandardMaterial color={flower} flatShading /></mesh>
          <mesh position={[s.tip[0], s.tip[1] - fr, s.tip[2]]} rotation={[Math.PI, 0, 0]}><coneGeometry args={[fr * 0.85, fr * 1.5, 6]} /><meshStandardMaterial color={flower} flatShading /></mesh>
          <mesh position={[s.tip[0], s.tip[1] + fr * 0.3, s.tip[2]]}><sphereGeometry args={[fr * 0.4, 5, 4]} /><meshStandardMaterial color="#e0c24a" flatShading /></mesh>
        </group>
      ))}
    </group>
  );
}

// Flowering shrub: irregular foliage mound dusted/clustered/spiked with flowers.
// mode: 'clusters' (lilac panicles), 'dust' (bluebeard haze), 'spikes' (fernbush plumes).
function Shrub({ p, cx, cy, foliage, flower, mode }: { p: PlantInstance; cx: number; cy: number; foliage: string; flower: string; mode: 'clusters' | 'dust' | 'spikes' }) {
  const x = p.x - cx, z = p.y - cy;
  const r = Math.max(0.5, p.widthFt / 2), h = Math.max(0.6, p.heightFt);
  const mound = useMemo(() => {
    const rnd = rngFrom(p.x + 7, p.y + 3); const arr: { pos: [number, number, number]; rad: number }[] = [];
    for (let i = 0; i < 5; i++) arr.push({ pos: [(rnd() - 0.5) * r * 0.8, h * (0.3 + rnd() * 0.35), (rnd() - 0.5) * r * 0.8], rad: r * (0.5 + rnd() * 0.32) });
    return arr;
  }, [p.x, p.y, r, h]);
  const flowers = useMemo(() => {
    const rnd = rngFrom(p.x, p.y); const arr: [number, number, number][] = [];
    const count = mode === 'dust' ? 18 : mode === 'clusters' ? 15 : 9;
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, el = 0.25 + rnd() * 0.7, rad = r * (0.62 + rnd() * 0.32);
      arr.push([Math.cos(a) * rad * (1 - el * 0.45), Math.min(h, h * (0.4 + el * 0.6)), Math.sin(a) * rad * (1 - el * 0.45)]);
    }
    return arr;
  }, [p.x, p.y, r, h, mode]);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => <mesh key={`m${i}`} castShadow position={m.pos} scale={[1, Math.min(1, h / (r * 1.6)), 1]}><icosahedronGeometry args={[m.rad, 1]} /><meshStandardMaterial color={shade(foliage, 0.84 + (i % 3) * 0.1)} flatShading /></mesh>)}
      {flowers.map((f, i) => mode === 'spikes'
        ? <mesh key={`f${i}`} position={[f[0], f[1] + Math.min(0.45, h * 0.18), f[2]]}><coneGeometry args={[Math.max(0.06, r * 0.09), Math.min(0.9, h * 0.42), 5]} /><meshStandardMaterial color={flower} flatShading /></mesh>
        : <mesh key={`f${i}`} position={f}><icosahedronGeometry args={[mode === 'clusters' ? r * 0.17 : r * 0.1, 0]} /><meshStandardMaterial color={flower} flatShading /></mesh>)}
    </group>
  );
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

// ── A single procedural plant ──────────────────────────────────────────────────────
const SMALL_PLANT_R = 1.25; // below this, render as a low amorphous mound (merges into a mass)
function Plant({ p, cx, cy }: { p: PlantInstance; cx: number; cy: number }) {
  const x = p.x - cx, z = p.y - cy;
  const r = Math.max(0.3, p.widthFt / 2), h = Math.max(0.4, p.heightFt);
  const t = (p.type || '').toLowerCase();
  const col = foliageColor(p.color, p.evergreen || t.includes('evergreen'));
  const name = (p.name || '').toLowerCase();
  // Small plants → a low, slightly-inflated mound; neighbours overlap into a continuous mass.
  if (r < SMALL_PLANT_R) {
    const br = Math.max(r, 1.3);
    return <mesh castShadow position={[x, Math.min(h, br) * 0.45, z]} scale={[1, Math.min(1, h / (br * 1.4)), 1]}><icosahedronGeometry args={[br, 1]} /><meshStandardMaterial color={col} flatShading /></mesh>;
  }
  // Reference-matched species models (colours sampled from the user's photos).
  if (name.includes('columbine')) return <Columbine p={p} cx={cx} cy={cy} />;
  if (name.includes('fernbush')) return <Shrub p={p} cx={cx} cy={cy} foliage="#9aa98c" flower="#efe7d2" mode="spikes" />;
  if (name.includes('lilac')) return <Shrub p={p} cx={cx} cy={cy} foliage="#5f7f4e" flower="#9b4f93" mode="clusters" />;
  if (name.includes('bluebeard') || name.includes('caryopteris')) return <Shrub p={p} cx={cx} cy={cy} foliage="#6f8a5e" flower="#7a86c8" mode="dust" />;
  const isTree = t.includes('tree') || p.layer === 'tree';
  if (isTree) {
    const evergreen = p.evergreen || t.includes('evergreen');
    const trunkH = h * 0.4, canopyH = h - trunkH, cr = Math.max(r, canopyH / 2);
    const rnd = rngFrom(p.x * 1.7 + 3, p.y * 1.3 + 5);
    const blobs: [number, number, number, number, number][] = [];
    const nb = evergreen ? 3 : 7;
    for (let i = 0; i < nb; i++) blobs.push([(rnd() - 0.5) * cr, trunkH + canopyH * (0.2 + rnd() * 0.65), (rnd() - 0.5) * cr, cr * (0.48 + rnd() * 0.4), 0.8 + rnd() * 0.36]);
    return (
      <group position={[x, 0, z]}>
        <mesh castShadow position={[0, trunkH / 2, 0]}><cylinderGeometry args={[Math.max(0.12, r * 0.09), Math.max(0.2, r * 0.15), trunkH, 6]} /><meshStandardMaterial color="#6b4f33" /></mesh>
        {evergreen
          ? blobs.map((b, i) => <mesh key={i} castShadow position={[b[0] * 0.4, b[1], b[2] * 0.4]}><coneGeometry args={[cr * (0.7 - i * 0.18), canopyH * 0.6, 9]} /><meshStandardMaterial color={shade(col, b[4])} flatShading /></mesh>)
          : blobs.map((b, i) => <mesh key={i} castShadow position={[b[0], b[1], b[2]]}><icosahedronGeometry args={[b[3], 1]} /><meshStandardMaterial color={shade(col, b[4])} flatShading /></mesh>)}
      </group>
    );
  }
  if (t.includes('cactus') || t.includes('succulent')) {
    return (
      <mesh castShadow position={[x, h / 2, z]}>
        <cylinderGeometry args={[r * 0.55, r * 0.7, h, 7]} />
        <meshStandardMaterial color={col} flatShading />
      </mesh>
    );
  }
  // shrubs / perennials / grasses / groundcover → a mound (squashed sphere)
  return (
    <mesh castShadow position={[x, Math.min(h, r) / 2, z]} scale={[1, Math.min(1, h / (r * 2)), 1]}>
      <icosahedronGeometry args={[r, 1]} />
      <meshStandardMaterial color={col} flatShading />
    </mesh>
  );
}

// Build a flat (ground-plane) shape from a ring of feet, centred on (cx,cy).
function flatShape(ring: Ring, cx: number, cy: number) {
  const s = new THREE.Shape();
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

function Scene({ houseAttrs }: { houseAttrs?: { stories?: number; material?: string; color?: string; style?: string } }) {
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
    const zones = (plan.zones || []).map((z: any) => ({ ring: ringOf(z), color: zoneColor(z), kind: zoneKind(z), lawn: z.key === 'lawn', water: /water|pool|pond|spa/i.test(`${z.key || ''} ${z.label || ''}`) })).filter((z: any) => z.ring);
    const paths = (plan.paths || []).filter((p: any) => (p.pts || []).length >= 2);
    const primaryColor = primaryColorOf(plan.primary);
    const primaryKindV = primaryKind(plan.primary);
    const size = Math.max(...boundaryFt.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 2;
    return { boundaryFt, cx, cy, houses, structures, hardscapes, exTrees, beds, zones, paths, instances, size, primaryColor, primaryKindV };
  }, []);
  // "Plan card" — a thin base the whole yard sits on, for the floating-diorama look.
  const baseGeo = useMemo(() => data ? new THREE.ExtrudeGeometry(flatShape(data.boundaryFt, data.cx, data.cy), { depth: 1.4, bevelEnabled: false }) : null, [data]);

  if (!data) return null;
  const { boundaryFt, cx, cy, houses, structures, hardscapes, exTrees, beds, zones, paths, instances, size, primaryColor, primaryKindV } = data;

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

  return (
    <>
      {/* Even fill + a soft directional sun that casts the plan's shadows */}
      <ambientLight intensity={0.62} />
      <hemisphereLight args={['#ffffff', '#c7cdbb', 0.55]} />
      <directionalLight
        position={[size * 0.55, size * 1.25, size * 0.5]} intensity={1.05} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-size} shadow-camera-right={size} shadow-camera-top={size} shadow-camera-bottom={-size}
        shadow-camera-near={1} shadow-camera-far={size * 5} shadow-bias={-0.0004}
      />

      {/* plan card */}
      {baseGeo && <mesh geometry={baseGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.41, 0]} receiveShadow><meshStandardMaterial color="#ECE8DC" /></mesh>}

      {/* base ground = primary planting material */}
      <Ground ring={boundaryFt} cx={cx} cy={cy} color={primaryColor} kind={primaryKindV} y={0} />
      {beds.map((b: any, i: number) => <Ground key={`bed${i}`} ring={b.ring} cx={cx} cy={cy} color={b.color} kind={b.kind} y={0.02} />)}
      {/* Lawn sits just below feature zones so features cleanly occlude it (it's a base region
          that overlaps them — moving a feature out reveals the lawn beneath, no re-carve needed). */}
      {zones.map((z: any, i: number) => z.water
        ? <Ground key={`zone${i}`} ring={z.ring} cx={cx} cy={cy} color="#5fa8c8" y={0.06} opacity={0.82} />
        : <Ground key={`zone${i}`} ring={z.ring} cx={cx} cy={cy} color={z.color} kind={z.kind} y={z.lawn ? 0.015 : 0.03} />)}
      {pathQuads.map((q, i) => <Ground key={`path${i}`} ring={q} cx={cx} cy={cy} color={PATH_COLOR} kind="pavers" y={0.04} />)}

      {/* structures — house height/material/colour from house attributes (manual or detected) */}
      {houses.map((r, i) => <Building key={`h${i}`} ring={r} cx={cx} cy={cy} height={Math.max(1, houseAttrs?.stories || 1) * 10} color={houseAttrs?.color || '#d2cdc0'} kind={wallKind(houseAttrs?.material)} />)}
      {structures.map((r, i) => <Building key={`s${i}`} ring={r} cx={cx} cy={cy} height={9} color="#c8c2b4" />)}
      {hardscapes.map((r, i) => <Ground key={`hs${i}`} ring={r} cx={cx} cy={cy} color={HARDSCAPE_COLOR} kind="concrete" y={0.05} />)}

      {/* existing trees */}
      {exTrees.map((t: any, i: number) => <ExistingTree key={`et${i}`} x={t.x - cx} z={t.y - cy} rad={t.rad} />)}

      {/* designed plants */}
      {instances.map((p, i) => <Plant key={`p${i}`} p={p} cx={cx} cy={cy} />)}

      <OrbitControls target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.05} minDistance={size * 0.25} maxDistance={size * 2.5} />
    </>
  );
}

export default function Yard3D({ houseAttrs }: { houseAttrs?: { stories?: number; material?: string; color?: string; style?: string } }) {
  const size = useMemo(() => {
    try {
      const bf = JSON.parse(localStorage.getItem('diyBoundaryFinal') || '{}');
      const b: [number, number][] = bf.boundary || [];
      if (b.length < 3) return 60;
      const cs = buildCS(b); const ft = b.map(v => cs(v[0], v[1])) as Ring; const [cx, cy] = centroid(ft);
      return Math.max(20, Math.max(...ft.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 2);
    } catch { return 60; }
  }, []);
  const d = size * 2;
  // Orthographic + a true-isometric direction ([1,1,1]) = the landscaping-plan look.
  return (
    <Canvas shadows orthographic camera={{ position: [d, d, d], zoom: Math.max(2.5, 560 / size), near: 0.1, far: d * 6 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#EEF0E9']} />
      <Scene houseAttrs={houseAttrs} />
    </Canvas>
  );
}
