import { useMemo } from 'react';
import * as THREE from 'three';

// ── Plant3D: a deterministic, species-recognizable procedural plant library ─────────────
// Self-contained (no imports from Yard3D). Recognition comes from SILHOUETTE and FLOWER FORM
// so shapes read under flat shading + ink outlines, at eye level and elevated/iso viewing.
//
// WORLD COORDINATE CONTRACT (see the canonical note at flatShape in Yard3D): a plant group
// renders at world [p.x - cx, 0, p.y - cy] — a pure translation of plan feet. (The ground
// layers LOOK like they use cy − y, but their −π/2 rotation flips it back to y − cy.)
// Getting this sign wrong mirrors every plant across the yard.
//
// SIZE CONTRACT: footprint radius r = max(0.3, widthFt/2); height h = max(0.4, heightFt).
//
// DETERMINISM: no Math.random — every render is identical via the position-seeded RNG below.

export interface PlantInstance {
  x: number; y: number; name: string; layer: string;
  widthFt: number; heightFt: number; type: string; evergreen: boolean; color: string;
}

// ── Colour pipeline (copied verbatim from Yard3D so the module is self-contained) ────────
const COLOR_HEX: Record<string, string> = {
  'green': '#7aa85e', 'dark green': '#527a48', 'deep green': '#527a48', 'medium green': '#7aa85e', 'light green': '#8cbb66', 'bright green': '#7fb552', 'emerald': '#4f9a63',
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
  return evergreen ? '#527a48' : '#7aa85e';
}
function isGreenHex(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return g >= r && g >= b;
}
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255), g = ch((pa >> 8) & 255, (pb >> 8) & 255), bl = ch(pa & 255, pb & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}
function shade(hex: string, f: number): string {
  // Widen the tint spread ~20% around neutral so flat-shaded canopies/mounds sparkle (per the
  // reference's luminous foliage) rather than reading as one solid green.
  const fe = 1 + (f - 1) * 1.2;
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * fe)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
// Lighten toward white (for flower centres / pale corollas).
function lighten(hex: string, t: number): string { return mixHex(hex, '#ffffff', t); }
// Push a colour toward its fully-saturated version (constant hue+lightness, S→1) by t, then blend.
// Used to make bloom accents pop like the reference's saturated flower clusters.
function saturate(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return hex; // grey — no hue to saturate
  const d = max - min;
  let hh = 0;
  if (max === r) hh = ((g - b) / d) % 6;
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  hh /= 6; if (hh < 0) hh += 1;
  const s = 1; // fully saturated
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh * 6) % 2) - 1)), m = l - c / 2;
  let rp = 0, gp = 0, bp = 0; const seg = hh * 6;
  if (seg < 1) { rp = c; gp = x; } else if (seg < 2) { rp = x; gp = c; } else if (seg < 3) { gp = c; bp = x; }
  else if (seg < 4) { gp = x; bp = c; } else if (seg < 5) { rp = x; bp = c; } else { rp = c; bp = x; }
  const full = '#' + ((1 << 24) + (Math.round((rp + m) * 255) << 16) + (Math.round((gp + m) * 255) << 8) + Math.round((bp + m) * 255)).toString(16).slice(1);
  return mixHex(hex, full, t);
}

// Deterministic per-position RNG so procedural detail is stable across renders.
function rngFrom(x: number, y: number) {
  let s = (Math.floor(x * 131.7) ^ Math.floor(y * 97.3)) | 0 || 1;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
}

const SMALL_PLANT_R = 1.25; // below this, small perennials render as a low merging mound

// ── SHARED module-level geometry (reused via mesh scale to keep tri counts low) ─────────
// Reusing these instead of allocating per-instance geometry keeps a 100–300 plant scene cheap.
const G_SPHERE = new THREE.SphereGeometry(1, 7, 6);      // ~70 tris
const G_SPHERE_LO = new THREE.SphereGeometry(1, 6, 5);   // ~50 tris — bloom dots / small buds
const G_CONE5 = new THREE.ConeGeometry(1, 1, 5);         // 5-radial cone (blades, spikes, petals)
const G_CONE6 = new THREE.ConeGeometry(1, 1, 6);         // 6-radial cone (conifers, panicles)
const G_CYL = new THREE.CylinderGeometry(1, 1, 1, 5);    // stems / trunks / discs
const G_CYL_DISC = new THREE.CylinderGeometry(1, 1, 1, 12); // daisy disc
const G_ICO0 = new THREE.IcosahedronGeometry(1, 0);      // 20 tris — buds / mat blobs
const G_ICO1 = new THREE.IcosahedronGeometry(1, 1);      // 80 tris — foliage blobs

// ── Ground-shadow disc — a soft dark ellipse under every plant (biggest dimensionality win). ─
// One draw call each, flattened circle sitting just above the ground decals (y = 0.02) and below
// the plant, depthWrite:false so it never z-fights. Seeded toward the implied sun (behind-left of
// the hero camera) with a fixed small offset that reads correctly from that three-quarter angle.
const G_SHADOW = new THREE.CircleGeometry(1, 24);        // faces +Z; rotated −π/2 to lie flat, up-facing
function GroundShadow({ x, z, r, opacity }: { x: number; z: number; r: number; opacity: number }) {
  return (
    <mesh geometry={G_SHADOW} rotation={[-Math.PI / 2, 0, 0]} position={[x + r * 0.15, 0.02, z + r * 0.1]} scale={[r, r, 1]}>
      <meshBasicMaterial color="#2f4a2a" transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

// ── Hand-drawn silhouette VARIANTS ───────────────────────────────────────────────────────────
// The shared cached primitives read "modeled". We must NOT mutate them per instance (they're shared
// by scale across the whole scene), so we bake a handful of pre-wobbled CLONES once at module load:
// each vertex is pushed along its radial direction by a low-frequency smooth field — lumpy, not
// spiky. Instances pick a variant from their position seed, so canopies/mounds gain an irregular ink
// silhouette at zero per-frame cost (memory only). Watertight guarantee: the displacement is a pure
// function of vertex POSITION, so PolyhedronGeometry/ConeGeometry's duplicated seam vertices move in
// lockstep — no cracks.
function wobbleField(x: number, y: number, z: number, seed: number): number {
  return (
    Math.sin(x * 2.1 + seed * 1.7) +
    Math.sin(y * 1.9 + seed * 2.3 + 1.1) +
    Math.sin(z * 2.3 + seed * 0.9 + 2.7) +
    Math.sin((x + y - z) * 1.3 + seed * 3.1)
  ) / 4; // ≈[-1,1], varies smoothly over a unit-radius primitive → low-frequency lumps
}
function makeWobbled(base: THREE.BufferGeometry, seed: number, amp: number): THREE.BufferGeometry {
  const g = base.clone();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length() || 1;
    const d = amp * wobbleField(v.x, v.y, v.z, seed);
    pos.setXYZ(i, v.x + (v.x / len) * d, v.y + (v.y / len) * d, v.z + (v.z / len) * d);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}
// 4 canopy/mound variants (±7.5% radius) + 3 conifer/panicle-cone variants (±6%).
const G_ICO1_VAR: THREE.BufferGeometry[] = [11, 23, 37, 51].map(s => makeWobbled(G_ICO1, s, 0.075));
const G_CONE6_VAR: THREE.BufferGeometry[] = [7, 19, 31].map(s => makeWobbled(G_CONE6, s, 0.06));
function icoVar(n: number): THREE.BufferGeometry { const N = G_ICO1_VAR.length; return G_ICO1_VAR[((n % N) + N) % N]; }
function coneVar(n: number): THREE.BufferGeometry { const N = G_CONE6_VAR.length; return G_CONE6_VAR[((n % N) + N) % N]; }

// A thin oriented cylinder between two points (stems). Uses the shared G_CYL scaled/rotated.
function Stem({ base, tip, thickness, color }: { base: [number, number, number]; tip: [number, number, number]; thickness: number; color: string }) {
  const { mid, quat, len } = useMemo(() => {
    const b = new THREE.Vector3(base[0], base[1], base[2]), t = new THREE.Vector3(tip[0], tip[1], tip[2]);
    const dir = t.clone().sub(b); const len = dir.length() || 0.01;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const m = b.clone().add(t).multiplyScalar(0.5);
    return { mid: [m.x, m.y, m.z] as [number, number, number], quat, len };
  }, [base, tip]);
  return <mesh geometry={G_CYL} position={mid} quaternion={quat} scale={[thickness, len, thickness]}><meshStandardMaterial color={color} flatShading /></mesh>;
}

// ── Resolved per-plant colour state (green-hex → foliage tint; other hue → bloom accent) ─
interface Resolved { col: string; bloom: string | null; evergreen: boolean; foliage: string; }
function resolveColor(p: PlantInstance): Resolved {
  const t = (p.type || '').toLowerCase();
  const evergreen = p.evergreen || t.includes('evergreen');
  const bloomHex = /^#/.test(p.color || '') ? p.color : null;
  const baseGreen = evergreen ? '#527a48' : '#7aa85e';
  const col = bloomHex
    ? (isGreenHex(bloomHex) ? mixHex(bloomHex, baseGreen, 0.35) : baseGreen)
    : foliageColor(p.color, evergreen);
  const bloom = bloomHex && !isGreenHex(bloomHex) ? saturate(bloomHex, 0.18) : null;
  return { col, bloom, evergreen, foliage: col };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════════════

// COLUMBINE — the showcase. Low lacy blue-green basal mound + thin erect stems each topped
// with a NODDING flower: central sphere + 5 splayed petal cones + 5 backward/up-sweeping
// SPUR cones (the spurs are what make columbine read as columbine).
function Columbine({ x, z, r, h, bloom }: { x: number; z: number; r: number; h: number; bloom: string | null }) {
  const flower = bloom || saturate('#c14b54', 0.18);        // columbine flowers are never green
  const inner = lighten(flower, 0.55);       // pale corolla / cream centre
  const R = Math.max(0.4, r), H = Math.max(0.9, h * 1.35);
  const { mound, stems } = useMemo(() => {
    const rnd = rngFrom(x, z);
    const mound = Array.from({ length: 4 }, (_, i) => ({
      pos: [(i - 1.5) * R * 0.32, 0.15, ((i % 2) - 0.5) * R * 0.45] as [number, number, number],
    }));
    const n = Math.max(5, Math.min(9, Math.round(R * 12)));
    const stems = Array.from({ length: n }, () => {
      const ang = rnd() * Math.PI * 2, reach = R * (0.25 + rnd() * 0.7), sh = H * (0.62 + rnd() * 0.38);
      // per-flower nod direction (outward tilt), and a small in-plane spin for spur placement
      const nod = 0.55 + rnd() * 0.35;
      return {
        base: [(rnd() - 0.5) * R * 0.3, 0.12, (rnd() - 0.5) * R * 0.3] as [number, number, number],
        tip: [Math.cos(ang) * reach, sh, Math.sin(ang) * reach] as [number, number, number],
        ang, nod, spin: rnd() * Math.PI * 2,
      };
    });
    return { mound, stems };
  }, [x, z, R, H]);
  const fr = Math.min(0.12, R * 0.24);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={`m${i}`} position={m.pos} scale={[R * 0.5, R * 0.22, R * 0.5]}>
          <primitive object={icoVar(i)} attach="geometry" />
          <meshStandardMaterial color="#6a9a7c" flatShading />
        </mesh>
      ))}
      {stems.map((s, i) => {
        // outward horizontal direction for the nod tilt
        const ox = Math.cos(s.ang), oz = Math.sin(s.ang);
        return (
          <group key={i}>
            <Stem base={s.base} tip={s.tip} thickness={0.02} color="#6a7a4a" />
            {/* nodding flower head: tilt the whole flower group outward+down */}
            <group position={s.tip} rotation={[oz * s.nod, s.spin, -ox * s.nod]}>
              {/* central corolla */}
              <mesh scale={[fr, fr, fr]}><primitive object={G_SPHERE} attach="geometry" /><meshStandardMaterial color={inner} flatShading /></mesh>
              {/* 5 petals splayed outward and slightly down (the bell) */}
              {[0, 1, 2, 3, 4].map(k => {
                const a = (k / 5) * Math.PI * 2;
                const px = Math.cos(a) * fr * 1.15, pz = Math.sin(a) * fr * 1.15;
                return (
                  <mesh key={`p${k}`} position={[px, -fr * 0.5, pz]} rotation={[Math.cos(a) * 0.9, -a, Math.sin(a) * 0.9]} scale={[fr * 0.7, fr * 1.5, fr * 0.7]}>
                    <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
                  </mesh>
                );
              })}
              {/* 5 spurs sweeping UP and BACK behind the flower — columbine's signature */}
              {[0, 1, 2, 3, 4].map(k => {
                const a = (k / 5) * Math.PI * 2 + Math.PI / 5;
                const px = Math.cos(a) * fr * 0.55, pz = Math.sin(a) * fr * 0.55;
                return (
                  <mesh key={`s${k}`} position={[px, fr * 1.1, pz]} rotation={[Math.cos(a) * -0.5, -a, Math.sin(a) * -0.5]} scale={[fr * 0.32, fr * 1.7, fr * 0.32]}>
                    <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
                  </mesh>
                );
              })}
            </group>
          </group>
        );
      })}
    </group>
  );
}

// Foliage mound helper — a few overlapping squashed blobs used by many archetypes.
function moundBlobs(x: number, z: number, r: number, h: number, count: number, foliage: string) {
  const rnd = rngFrom(x + 7, z + 3);
  return Array.from({ length: count }, (_, i) => ({
    key: `m${i}`,
    pos: [(rnd() - 0.5) * r * 0.8, h * (0.28 + rnd() * 0.35), (rnd() - 0.5) * r * 0.8] as [number, number, number],
    rad: r * (0.5 + rnd() * 0.3),
    tint: shade(foliage, 0.84 + (i % 3) * 0.1),
    squash: Math.min(1, h / (r * 1.6)),
  }));
}

// SPIKE BLOOMERS (lavender/salvia/veronica/liatris/penstemon/catmint/russian sage…):
// compact mound + many upright thin flower spikes.
function SpikePlant({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const flower = bloom || saturate('#7a5a9e', 0.18);
  const spikes = useMemo(() => {
    const rnd = rngFrom(x, z);
    const n = Math.max(7, Math.min(16, Math.round(r * 14)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * (0.15 + rnd() * 0.6);
      const sh = h * (0.55 + rnd() * 0.5), lean = (rnd() - 0.5) * 0.35;
      return { pos: [Math.cos(a) * rad, h * 0.35, Math.sin(a) * rad] as [number, number, number], sh, lean, ang: a };
    });
  }, [x, z, r, h]);
  const mound = useMemo(() => moundBlobs(x, z, r, h * 0.7, 4, foliage), [x, z, r, h, foliage]);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={m.key} position={[m.pos[0], m.pos[1] * 0.6, m.pos[2]]} scale={[m.rad, m.rad * m.squash * 0.8, m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {spikes.map((s, i) => (
        <mesh key={i} position={[s.pos[0], s.pos[1] + s.sh / 2, s.pos[2]]}
          rotation={[Math.sin(s.ang) * s.lean, 0, -Math.cos(s.ang) * s.lean]}
          scale={[Math.max(0.05, r * 0.1), s.sh, Math.max(0.05, r * 0.1)]}>
          <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// DAISY-FORM (coneflower/echinacea/daisy/rudbeckia/aster/coreopsis…):
// mound + stems topped with a flat disc + darker centre button.
function DaisyPlant({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const petal = bloom || saturate('#cdb53b', 0.18);
  const button = shade(petal, 0.5);
  const heads = useMemo(() => {
    const rnd = rngFrom(x, z);
    const n = Math.max(4, Math.min(10, Math.round(r * 8)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * (0.2 + rnd() * 0.65);
      const sh = h * (0.6 + rnd() * 0.4);
      return { base: [Math.cos(a) * rad, 0.1, Math.sin(a) * rad] as [number, number, number], sh };
    });
  }, [x, z, r, h]);
  const mound = useMemo(() => moundBlobs(x, z, r, h * 0.55, 3, foliage), [x, z, r, h, foliage]);
  const dr = Math.max(0.12, r * 0.22);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={m.key} position={[m.pos[0], m.pos[1] * 0.5, m.pos[2]]} scale={[m.rad, m.rad * 0.5, m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {heads.map((hd, i) => {
        const ty = hd.base[1] + hd.sh;
        return (
          <group key={i}>
            <Stem base={hd.base} tip={[hd.base[0], ty, hd.base[2]]} thickness={0.02} color="#5f7a3e" />
            <mesh position={[hd.base[0], ty, hd.base[2]]} scale={[dr, dr * 0.22, dr]}>
              <primitive object={G_CYL_DISC} attach="geometry" /><meshStandardMaterial color={petal} flatShading />
            </mesh>
            <mesh position={[hd.base[0], ty + dr * 0.14, hd.base[2]]} scale={[dr * 0.42, dr * 0.3, dr * 0.42]}>
              <primitive object={G_SPHERE_LO} attach="geometry" /><meshStandardMaterial color={button} flatShading />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// MOPHEAD CLUSTERS (hydrangea/viburnum/snowball): rounded shrub + several large bloom spheres.
function Mophead({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const flower = bloom || '#d7dbe0';
  const mound = useMemo(() => moundBlobs(x, z, r, h, 5, foliage), [x, z, r, h, foliage]);
  const blooms = useMemo(() => {
    const rnd = rngFrom(x + 2, z + 9);
    const n = Math.max(3, Math.min(6, Math.round(r * 3)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * (0.35 + rnd() * 0.4);
      return { pos: [Math.cos(a) * rad, h * (0.55 + rnd() * 0.35), Math.sin(a) * rad] as [number, number, number], rad: r * (0.26 + rnd() * 0.12) };
    });
  }, [x, z, r, h]);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={m.key} castShadow position={m.pos} scale={[m.rad, m.rad * m.squash, m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {blooms.map((b, i) => (
        <mesh key={i} position={b.pos} scale={[b.rad, b.rad * 0.9, b.rad]}>
          <primitive object={icoVar(Math.round(x * 5 - z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade(flower, 0.94 + (i % 2) * 0.08)} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// PANICLES (lilac/butterfly bush/buddleja/crape): vase-shaped shrub + upright cone panicles.
function Panicle({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const flower = bloom || saturate('#9b4f93', 0.18);
  const mound = useMemo(() => {
    // vase shape: blobs biased upward and outward
    const rnd = rngFrom(x + 7, z + 3);
    return Array.from({ length: 5 }, (_, i) => ({
      key: `m${i}`,
      pos: [(rnd() - 0.5) * r * 0.9, h * (0.35 + rnd() * 0.4), (rnd() - 0.5) * r * 0.9] as [number, number, number],
      rad: r * (0.45 + rnd() * 0.3), tint: shade(foliage, 0.84 + (i % 3) * 0.1),
    }));
  }, [x, z, r, h, foliage]);
  const panicles = useMemo(() => {
    const rnd = rngFrom(x, z);
    const n = Math.max(6, Math.min(12, Math.round(r * 10)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * (0.3 + rnd() * 0.55), lean = (rnd() - 0.5) * 0.3;
      return { pos: [Math.cos(a) * rad, h * (0.7 + rnd() * 0.2), Math.sin(a) * rad] as [number, number, number], len: h * (0.28 + rnd() * 0.22), lean, ang: a };
    });
  }, [x, z, r, h]);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={m.key} castShadow position={m.pos} scale={[m.rad, m.rad, m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {panicles.map((pn, i) => (
        <mesh key={i} position={[pn.pos[0], pn.pos[1] + pn.len / 2, pn.pos[2]]}
          rotation={[Math.sin(pn.ang) * pn.lean, 0, -Math.cos(pn.ang) * pn.lean]}
          scale={[Math.max(0.08, r * 0.16), pn.len, Math.max(0.08, r * 0.16)]}>
          <primitive object={coneVar(i)} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// ROSES: rounded shrub dotted with many small cup blooms across the surface.
function RoseShrub({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const flower = bloom || saturate('#d98aa6', 0.18);
  const mound = useMemo(() => moundBlobs(x, z, r, h, 5, foliage), [x, z, r, h, foliage]);
  const blooms = useMemo(() => {
    const rnd = rngFrom(x * 3.1 + 11, z * 2.7 + 5);
    const n = Math.max(8, Math.min(18, Math.round(r * 12)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, el = 0.2 + rnd() * 0.7, rad = r * (0.55 + rnd() * 0.35);
      return { pos: [Math.cos(a) * rad * (1 - el * 0.4), Math.min(h, h * (0.4 + el * 0.6)), Math.sin(a) * rad * (1 - el * 0.4)] as [number, number, number] };
    });
  }, [x, z, r, h]);
  const br = Math.max(0.12, r * 0.13);
  return (
    <group position={[x, 0, z]}>
      {mound.map((m, i) => (
        <mesh key={m.key} castShadow position={m.pos} scale={[m.rad, m.rad * m.squash, m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {blooms.map((b, i) => (
        <mesh key={i} position={b.pos} scale={[br, br, br]}>
          <primitive object={G_SPHERE_LO} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// ORNAMENTAL GRASSES: dense arching fountain of thin curved blades + a few seed-head plumes.
function GrassFountain({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const plume = bloom || '#cdb98a'; // tan/wheat
  const blades = useMemo(() => {
    const rnd = rngFrom(x, z);
    const n = Math.max(9, Math.min(14, Math.round(r * 10)));
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
      const arch = 0.3 + rnd() * 0.35; // outward arching
      const bh = h * (0.8 + rnd() * 0.35);
      return { a, arch, bh, tint: shade(foliage, 0.86 + rnd() * 0.3) };
    });
  }, [x, z, r, h, foliage]);
  const plumes = useMemo(() => {
    const rnd = rngFrom(x + 5, z + 8);
    const n = Math.max(2, Math.min(5, Math.round(r * 3)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * rnd() * 0.4;
      return { pos: [Math.cos(a) * rad, 0.05, Math.sin(a) * rad] as [number, number, number], ph: h * (1.05 + rnd() * 0.3) };
    });
  }, [x, z, r, h]);
  return (
    <group position={[x, 0, z]}>
      {blades.map((bl, i) => (
        <mesh key={i} castShadow position={[Math.cos(bl.a) * r * 0.3, bl.bh * 0.5, Math.sin(bl.a) * r * 0.3]}
          rotation={[Math.sin(bl.a) * bl.arch, 0, -Math.cos(bl.a) * bl.arch]}
          scale={[Math.max(0.05, r * 0.09), bl.bh, Math.max(0.05, r * 0.09)]}>
          <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={bl.tint} flatShading />
        </mesh>
      ))}
      {plumes.map((pl, i) => (
        <group key={i} position={pl.pos}>
          <Stem base={[0, 0, 0]} tip={[0, pl.ph, 0]} thickness={0.03} color={shade(foliage, 1.05)} />
          <mesh position={[0, pl.ph, 0]} scale={[Math.max(0.06, r * 0.1), pl.ph * 0.22, Math.max(0.06, r * 0.1)]}>
            <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={plume} flatShading />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ROSETTES (yucca/agave/hesperaloe/sotol/dasylirion; cactus/succulent): stiff leaning blades
// all around + 1–2 tall flower stalks with small bloom clusters up the stalk.
function Rosette({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const flower = bloom || saturate('#d98a5a', 0.18);
  const rnd = useMemo(() => rngFrom(x * 2.1 + 1, z * 1.9 + 4), [x, z]);
  const { blades, stalks } = useMemo(() => {
    const gen = rngFrom(x * 2.1 + 1, z * 1.9 + 4);
    const n = 7 + Math.floor(gen() * 4);
    const blades = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + gen() * 0.4;
      const lean = 0.35 + gen() * 0.3;
      return { a, lean, tint: shade(foliage, 0.85 + gen() * 0.3) };
    });
    const stalks = bloom ? [0.3, -0.25].map(off => ({ off })) : [];
    return { blades, stalks };
  }, [x, z, foliage, bloom]);
  return (
    <group position={[x, 0, z]}>
      {blades.map((b, i) => (
        <mesh key={i} castShadow position={[Math.cos(b.a) * r * 0.25, h * 0.45, Math.sin(b.a) * r * 0.25]}
          rotation={[Math.sin(b.a) * b.lean, 0, -Math.cos(b.a) * b.lean]}
          scale={[r * 0.14, h * 0.95, r * 0.14]}>
          <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={b.tint} flatShading />
        </mesh>
      ))}
      {stalks.map((st, i) => {
        const buds = 3;
        return (
          <group key={`st${i}`} position={[st.off * r, 0, -st.off * r * 0.6]}>
            <Stem base={[0, 0, 0]} tip={[0, h * 1.5, 0]} thickness={0.05} color="#7a6a4a" />
            {Array.from({ length: buds }, (_, k) => {
              const yy = h * (0.85 + k * 0.28);
              const side = (k % 2 ? 1 : -1) * r * 0.12;
              return (
                <mesh key={k} position={[side, yy, 0]} scale={[r * 0.13, r * 0.13, r * 0.13]}>
                  <primitive object={G_SPHERE_LO} attach="geometry" /><meshStandardMaterial color={flower} flatShading />
                </mesh>
              );
            })}
          </group>
        );
      })}
      {/* consume rnd so its seed differs deterministically if reused elsewhere */}
      {void rnd}
    </group>
  );
}

// TIGHT EVERGREENS (boxwood/holly/privet/hedge): dense near-geometric globe.
function TightGlobe({ x, z, r, h, foliage }: { x: number; z: number; r: number; h: number; foliage: string }) {
  const squash = Math.min(1.1, h / (r * 1.4));
  const bumps = useMemo(() => {
    const rnd = rngFrom(x + 4, z + 6);
    return Array.from({ length: 4 }, () => {
      const a = rnd() * Math.PI * 2, el = rnd() * Math.PI * 0.5;
      const rr = r * 0.85;
      return { pos: [Math.cos(a) * rr * Math.cos(el), r * squash * (0.5 + Math.sin(el) * 0.5), Math.sin(a) * rr * Math.cos(el)] as [number, number, number], rad: r * (0.28 + rnd() * 0.12), tint: shade(foliage, 0.9 + rnd() * 0.16) };
    });
  }, [x, z, r, h, foliage, squash]);
  return (
    <group position={[x, 0, z]}>
      <mesh castShadow position={[0, r * squash * 0.9, 0]} scale={[r, r * squash, r]}>
        <primitive object={icoVar(Math.round(x * 3 + z * 7))} attach="geometry" /><meshStandardMaterial color={foliage} flatShading />
      </mesh>
      {bumps.map((b, i) => (
        <mesh key={i} position={b.pos} scale={[b.rad, b.rad, b.rad]}>
          <primitive object={G_ICO0} attach="geometry" /><meshStandardMaterial color={b.tint} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// SPREADERS / GROUNDCOVER (creeping/carpet/mat/thyme/sedum/ice plant/phlox; layer groundcover):
// a wide LOW irregular mat of overlapping flattened blobs + many tiny bloom dots (drifts).
function Groundcover({ x, z, r, h, foliage, bloom }: { x: number; z: number; r: number; h: number; foliage: string; bloom: string | null }) {
  const mat = useMemo(() => {
    const rnd = rngFrom(x + 1, z + 2);
    const n = Math.max(4, Math.min(8, Math.round(r * 3)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * rnd() * 0.7;
      return { pos: [Math.cos(a) * rad, h * 0.2, Math.sin(a) * rad] as [number, number, number], rad: r * (0.45 + rnd() * 0.4), tint: shade(foliage, 0.88 + rnd() * 0.24) };
    });
  }, [x, z, r, h, foliage]);
  const dots = useMemo(() => {
    if (!bloom) return [];
    const rnd = rngFrom(x * 3.1 + 11, z * 2.7 + 5);
    const n = Math.max(8, Math.min(20, Math.round(r * 12)));
    return Array.from({ length: n }, () => {
      const a = rnd() * Math.PI * 2, rad = r * rnd() * 0.85;
      return { pos: [Math.cos(a) * rad, h * (0.28 + rnd() * 0.2), Math.sin(a) * rad] as [number, number, number] };
    });
  }, [x, z, r, h, bloom]);
  const dr = Math.max(0.08, r * 0.07);
  return (
    <group position={[x, 0, z]}>
      {mat.map((m, i) => (
        <mesh key={`mat${i}`} position={m.pos} scale={[m.rad, Math.max(0.08, h * 0.5), m.rad]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7) + i)} attach="geometry" /><meshStandardMaterial color={m.tint} flatShading />
        </mesh>
      ))}
      {dots.map((d, i) => (
        <mesh key={`d${i}`} position={d.pos} scale={[dr, dr, dr]}>
          <primitive object={G_SPHERE_LO} attach="geometry" /><meshStandardMaterial color={bloom!} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// FERNS: arching fronds (flattened tapered cones splayed from centre).
function Fern({ x, z, r, h, foliage }: { x: number; z: number; r: number; h: number; foliage: string }) {
  const fronds = useMemo(() => {
    const rnd = rngFrom(x, z);
    const n = Math.max(7, Math.min(12, Math.round(r * 9)));
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.4;
      const arch = 0.5 + rnd() * 0.35, fh = h * (0.85 + rnd() * 0.3);
      return { a, arch, fh, tint: shade(foliage, 0.86 + rnd() * 0.28) };
    });
  }, [x, z, r, h, foliage]);
  return (
    <group position={[x, 0, z]}>
      {fronds.map((f, i) => (
        <mesh key={i} castShadow position={[Math.cos(f.a) * r * 0.25, f.fh * 0.45, Math.sin(f.a) * r * 0.25]}
          rotation={[Math.sin(f.a) * f.arch, -f.a, -Math.cos(f.a) * f.arch]}
          scale={[r * 0.22, f.fh, r * 0.06]}>
          <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={f.tint} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// ── TREES ───────────────────────────────────────────────────────────────────────────────
type TreeForm = 'conifer' | 'birch' | 'bloomer' | 'columnar' | 'weeping' | 'deciduous';

function Tree({ x, z, r, h, form, col, bloom }: { x: number; z: number; r: number; h: number; form: TreeForm; col: string; bloom: string | null }) {
  const trunkH = h * 0.4, canopyH = h - trunkH, cr = Math.max(r, canopyH / 2);

  if (form === 'conifer') {
    const tiers = useMemo(() => {
      const gen = rngFrom(x * 1.7 + 3, z * 1.3 + 5);
      return [0, 1, 2, 3].map(() => ({ jx: (gen() - 0.5) * cr * 0.15, jz: (gen() - 0.5) * cr * 0.15, tint: 0.82 + gen() * 0.28 }));
    }, [x, z, cr]);
    return (
      <group position={[x, 0, z]}>
        <mesh castShadow position={[0, trunkH * 0.4, 0]} scale={[Math.max(0.12, r * 0.1), trunkH * 0.8, Math.max(0.12, r * 0.1)]}>
          <primitive object={G_CYL} attach="geometry" /><meshStandardMaterial color="#6b4f33" flatShading />
        </mesh>
        {tiers.map((t, i) => {
          const frac = 1 - i * 0.22;
          const yy = trunkH * 0.6 + canopyH * (i / tiers.length) * 0.95;
          return (
            <mesh key={i} castShadow position={[t.jx, yy + (canopyH * 0.5) / tiers.length, t.jz]} scale={[cr * frac, canopyH * 0.5, cr * frac]}>
              <primitive object={coneVar(Math.round(x * 5 + z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade(col, t.tint)} flatShading />
            </mesh>
          );
        })}
      </group>
    );
  }

  if (form === 'birch') {
    const { trunks, blobs } = useMemo(() => {
      const gen = rngFrom(x * 1.7 + 3, z * 1.3 + 5);
      const nt = 1 + Math.floor(gen() * 3);
      const trunks = Array.from({ length: nt }, (_, i) => ({ off: (i - (nt - 1) / 2) * r * 0.5, lean: (gen() - 0.5) * 0.1 }));
      const blobs = Array.from({ length: 5 }, () => [(gen() - 0.5) * cr, trunkH + canopyH * (0.3 + gen() * 0.6), (gen() - 0.5) * cr, cr * (0.42 + gen() * 0.32), 0.9 + gen() * 0.3] as const);
      return { trunks, blobs };
    }, [x, z, cr]);
    return (
      <group position={[x, 0, z]}>
        {trunks.map((t, i) => (
          <group key={`t${i}`}>
            <mesh castShadow position={[t.off, h * 0.5, 0]} rotation={[0, 0, t.lean]} scale={[Math.max(0.08, r * 0.06), h, Math.max(0.08, r * 0.06)]}>
              <primitive object={G_CYL} attach="geometry" /><meshStandardMaterial color="#e8e6dd" flatShading />
            </mesh>
            {/* dark flecks */}
            {[0.3, 0.55, 0.75].map((fy, k) => (
              <mesh key={k} position={[t.off + t.lean * h * (0.5 - fy), h * fy, r * 0.06]} scale={[r * 0.05, r * 0.03, r * 0.02]}>
                <primitive object={G_ICO0} attach="geometry" /><meshStandardMaterial color="#3a352e" flatShading />
              </mesh>
            ))}
          </group>
        ))}
        {blobs.map((b, i) => (
          <mesh key={i} castShadow position={[b[0], b[1], b[2]]} scale={[b[3], b[3] * 0.9, b[3]]}>
            <primitive object={icoVar(Math.round(x * 5 + z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade('#8fae66', b[4])} flatShading />
          </mesh>
        ))}
      </group>
    );
  }

  if (form === 'columnar') {
    const blobs = useMemo(() => {
      const gen = rngFrom(x * 1.7 + 3, z * 1.3 + 5);
      return Array.from({ length: 5 }, (_, i) => [(gen() - 0.5) * cr * 0.5, trunkH + canopyH * (0.15 + i * 0.18), (gen() - 0.5) * cr * 0.5, cr * (0.5 + gen() * 0.18), 0.82 + gen() * 0.28] as const);
    }, [x, z, cr]);
    return (
      <group position={[x, 0, z]}>
        <mesh castShadow position={[0, trunkH * 0.5, 0]} scale={[Math.max(0.1, r * 0.08), trunkH, Math.max(0.1, r * 0.08)]}>
          <primitive object={G_CYL} attach="geometry" /><meshStandardMaterial color="#6b4f33" flatShading />
        </mesh>
        {blobs.map((b, i) => (
          <mesh key={i} castShadow position={[b[0], b[1], b[2]]} scale={[b[3] * 0.55, canopyH * 0.34, b[3] * 0.55]}>
            <primitive object={icoVar(Math.round(x * 5 + z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade(col, b[4])} flatShading />
          </mesh>
        ))}
      </group>
    );
  }

  if (form === 'weeping') {
    const { canopy, drapes } = useMemo(() => {
      const gen = rngFrom(x * 1.7 + 3, z * 1.3 + 5);
      const canopy = Array.from({ length: 4 }, () => [(gen() - 0.5) * cr, trunkH + canopyH * (0.6 + gen() * 0.3), (gen() - 0.5) * cr, cr * (0.5 + gen() * 0.3), 0.85 + gen() * 0.25] as const);
      const nd = 7;
      const drapes = Array.from({ length: nd }, (_, i) => {
        const a = (i / nd) * Math.PI * 2 + gen() * 0.3, rad = cr * (0.6 + gen() * 0.3);
        return { pos: [Math.cos(a) * rad, trunkH + canopyH * 0.45, Math.sin(a) * rad] as [number, number, number], len: canopyH * (0.4 + gen() * 0.3), tint: 0.82 + gen() * 0.24 };
      });
      return { canopy, drapes };
    }, [x, z, cr]);
    return (
      <group position={[x, 0, z]}>
        <mesh castShadow position={[0, trunkH * 0.5, 0]} scale={[Math.max(0.12, r * 0.09), trunkH, Math.max(0.12, r * 0.09)]}>
          <primitive object={G_CYL} attach="geometry" /><meshStandardMaterial color="#6b4f33" flatShading />
        </mesh>
        {canopy.map((b, i) => (
          <mesh key={`c${i}`} castShadow position={[b[0], b[1], b[2]]} scale={[b[3], b[3] * 0.8, b[3]]}>
            <primitive object={icoVar(Math.round(x * 5 + z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade(col, b[4])} flatShading />
          </mesh>
        ))}
        {drapes.map((d, i) => (
          <mesh key={`d${i}`} position={[d.pos[0], d.pos[1] - d.len / 2, d.pos[2]]} scale={[cr * 0.14, d.len, cr * 0.14]}>
            <primitive object={G_CONE5} attach="geometry" /><meshStandardMaterial color={shade(col, d.tint)} flatShading />
          </mesh>
        ))}
      </group>
    );
  }

  // bloomer & default deciduous: trunk + 2–3 forking branches + layered blob canopy.
  const { branches, blobs } = useMemo(() => {
    const gen = rngFrom(x * 1.7 + 3, z * 1.3 + 5);
    const nb = 2 + Math.floor(gen() * 2);
    const branches = Array.from({ length: nb }, () => {
      const a = gen() * Math.PI * 2, spread = r * (0.3 + gen() * 0.3);
      return { tip: [Math.cos(a) * spread, trunkH + canopyH * 0.35, Math.sin(a) * spread] as [number, number, number], ang: a };
    });
    const blobs = Array.from({ length: 7 }, () => [(gen() - 0.5) * cr, trunkH + canopyH * (0.25 + gen() * 0.65), (gen() - 0.5) * cr, cr * (0.48 + gen() * 0.4), 0.8 + gen() * 0.36] as const);
    return { branches, blobs };
  }, [x, z, cr]);
  return (
    <group position={[x, 0, z]}>
      <mesh castShadow position={[0, trunkH * 0.5, 0]} scale={[Math.max(0.12, r * 0.09), trunkH, Math.max(0.2, r * 0.15)]}>
        <primitive object={G_CYL} attach="geometry" /><meshStandardMaterial color="#6b4f33" flatShading />
      </mesh>
      {branches.map((b, i) => (
        <Stem key={`br${i}`} base={[0, trunkH * 0.75, 0]} tip={b.tip} thickness={Math.max(0.06, r * 0.05)} color="#6b4f33" />
      ))}
      {blobs.map((b, i) => {
        // bloomer: blend heavily toward the bloom colour (a tree in flower)
        const base = form === 'bloomer' && bloom
          ? mixHex(col, bloom, 0.6)
          : (bloom && i % 3 === 0 ? mixHex(col, bloom, 0.55) : col);
        return (
          <mesh key={i} castShadow position={[b[0], b[1], b[2]]} scale={[b[3], b[3] * 0.95, b[3]]}>
            <primitive object={icoVar(Math.round(x * 5 + z * 3) + i)} attach="geometry" /><meshStandardMaterial color={shade(base, b[4])} flatShading />
          </mesh>
        );
      })}
    </group>
  );
}

// ── Small-plant fallback mound (merges into a drift) + generic shrub mound ───────────────
function bloomDotsFor(x: number, z: number, bloom: string | null, n: number, bodyR: number, baseY: number) {
  if (!bloom) return null;
  const rnd = rngFrom(x * 3.1 + 11, z * 2.7 + 5);
  return Array.from({ length: n }, (_, i) => {
    const a = rnd() * Math.PI * 2, d = rnd() * bodyR * 0.7;
    const s = Math.max(0.14, bodyR * 0.11);
    return (
      <mesh key={`bl${i}`} position={[Math.cos(a) * d, baseY + bodyR * 0.35 + rnd() * bodyR * 0.3, Math.sin(a) * d]} scale={[s, s, s]}>
        <primitive object={G_SPHERE_LO} attach="geometry" /><meshStandardMaterial color={bloom} flatShading />
      </mesh>
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  DISPATCH — most specific first
// ═══════════════════════════════════════════════════════════════════════════════════════
export function Plant({ p, cx, cy }: { p: PlantInstance; cx: number; cy: number }) {
  const x = p.x - cx, z = p.y - cy; // world Z = y − cy — matches the RENDERED ground layers (their −π/2 rotation flips the shape's cy−y back). cy−y here mirrors every plant across the yard.
  const r = Math.max(0.3, p.widthFt / 2), h = Math.max(0.4, p.heightFt);
  const t = (p.type || '').toLowerCase();
  const name = (p.name || '').toLowerCase();
  const layer = (p.layer || '').toLowerCase();
  const { col, bloom, foliage } = resolveColor(p);

  const isColumbine = /columbine|aquilegia/.test(name);
  // TREES (form keyword). Trees dispatch before the small-mound cutoff so a small nursery
  // caliper tree still reads as a tree. (Columbine wins over the tree check below.)
  const isTree = !isColumbine && ((t.includes('tree') || layer === 'tree')
    || /spruce|pine|fir|juniper|cedar|arborvitae|birch|aspen|crabapple|cherry|redbud|serviceberry|magnolia|columnar|fastigiate|poplar|sky pencil|weeping|willow|maple|oak|elm|linden|hackberry|honeylocust/.test(name));

  // Archetype dispatch (most specific first) → the plant BODY element. Wrapped below with a shared
  // ground-shadow blob so every archetype gains dimensionality without touching each one.
  const body = (() => {
    // COLUMBINE — the showcase; wins over the small-plant merge so it always reads as columbine.
    if (isColumbine) return <Columbine x={x} z={z} r={r} h={h} bloom={bloom} />;

    if (isTree) {
      let form: TreeForm = 'deciduous';
      if (/spruce|pine|fir|juniper|cedar|arborvitae/.test(name)) form = 'conifer';
      else if (/birch|aspen/.test(name)) form = 'birch';
      else if (/crabapple|cherry|redbud|serviceberry|plum|magnolia/.test(name)) form = 'bloomer';
      else if (/columnar|fastigiate|poplar|sky pencil/.test(name)) form = 'columnar';
      else if (/weeping|willow/.test(name)) form = 'weeping';
      else if (p.evergreen || t.includes('evergreen')) form = 'conifer';
      return <Tree x={x} z={z} r={r} h={h} form={form} col={col} bloom={bloom} />;
    }

    // Species archetypes (most specific first), before the generic small-plant merge so these
    // keep their identity even at small footprints.
    if (/lavender|salvia|veronica|liatris|penstemon|hyssop|catmint|nepeta|russian sage|perovskia/.test(name)) return <SpikePlant x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/coneflower|echinacea|daisy|blanket|gaillardia|rudbeckia|black-eyed|black eyed|aster|coreopsis/.test(name)) return <DaisyPlant x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/hydrangea|viburnum|snowball/.test(name)) return <Mophead x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/lilac|butterfly bush|buddleja|crape/.test(name)) return <Panicle x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/rose/.test(name)) return <RoseShrub x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/grass|muhly|carex|festuca|miscanthus|sedge|fountain|feather reed|blue oat/.test(name)) return <GrassFountain x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (t.includes('cactus') || t.includes('succulent') || /yucca|agave|hesperaloe|sotol|dasylirion/.test(name)) return <Rosette x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;
    if (/boxwood|holly|privet|hedge/.test(name)) return <TightGlobe x={x} z={z} r={r} h={h} foliage={col} />;
    if (/fern/.test(name)) return <Fern x={x} z={z} r={r} h={h} foliage={foliage} />;
    if (layer === 'groundcover' || /creeping|carpet|\bmat\b|thyme|sedum|ice plant|phlox/.test(name)) return <Groundcover x={x} z={z} r={r} h={h} foliage={foliage} bloom={bloom} />;

    // Small unmatched perennials → a low merging mound (drifts). Matches today's behavior.
    if (r < SMALL_PLANT_R) {
      const br = Math.max(r, 1.3);
      const baseY = Math.min(h, br) * 0.45;
      return (
        <group position={[x, 0, z]}>
          <mesh castShadow position={[0, baseY, 0]} scale={[br, br * Math.min(1, h / (br * 1.4)), br]}>
            <primitive object={icoVar(Math.round(x * 3 + z * 7))} attach="geometry" /><meshStandardMaterial color={col} flatShading />
          </mesh>
          {bloomDotsFor(x, z, bloom, 3, br, baseY)}
        </group>
      );
    }

    // FALLBACK: generic shrub / perennial mound + bloom dots (matches today's default).
    const baseY = Math.min(h, r) / 2;
    return (
      <group position={[x, 0, z]}>
        <mesh castShadow position={[0, baseY, 0]} scale={[r, r * Math.min(1, h / (r * 2)), r]}>
          <primitive object={icoVar(Math.round(x * 3 + z * 7))} attach="geometry" /><meshStandardMaterial color={col} flatShading />
        </mesh>
        {bloomDotsFor(x, z, bloom, 6, r, baseY)}
      </group>
    );
  })();

  // GROUND SHADOW — one soft blob per plant, sized per instance. Trees get a larger, softer blob.
  const shadowR = (isTree ? 1.0 : 0.85) * r;
  const shadowOp = isTree ? 0.08 : 0.10;
  return (
    <group>
      <GroundShadow x={x} z={z} r={shadowR} opacity={shadowOp} />
      {body}
    </group>
  );
}

export default Plant;
