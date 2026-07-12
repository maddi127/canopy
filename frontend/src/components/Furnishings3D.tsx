import { useMemo } from 'react';
import * as THREE from 'three';

// ── Self-contained furnishings module ───────────────────────────────────────────────
// Real-looking, low-poly outdoor furniture proxies (chairs people could sit on, a BBQ
// cart, dining sets, raised beds, a swing set) rendered in the app's flat-shaded NPR
// style. Deterministic — any per-instance variation is seeded from position, never
// Math.random. Mirrors the world-space convention used throughout Yard3D.tsx:
//   world X = x − cx,  world Z = y − cy   (zone.ring is [x,y] plan-feet verts; see the
//   canonical-convention note at flatShape in Yard3D — the ground layers' −π/2 rotation
//   means point objects must use y − cy, NOT cy − y, or they mirror across the yard)
// This file does not import anything from Yard3D.tsx — the tiny `centroid` helper is
// duplicated here on purpose so the module stays independently buildable.

type Ring = [number, number][];

// Furniture anchor for a zone ring. A plain vertex average is biased toward vertex-dense arcs
// (organic/circle shapes) and can land OUTSIDE the pad — onto whatever's next to it (the lawn).
// So: true area (shoelace) centroid first; if the ring is concave enough that even that escapes,
// fall back to the interior grid point deepest inside the polygon.
function centroid(r: Ring): [number, number] {
  // Shoelace area centroid.
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    const w = x0 * y1 - x1 * y0;
    a += w; cx += (x0 + x1) * w; cy += (y0 + y1) * w;
  }
  if (Math.abs(a) > 1e-6) {
    const p: [number, number] = [cx / (3 * a), cy / (3 * a)];
    if (pointInRing(p, r)) return p;
  }
  // Concave fallback: coarse interior grid, pick the point farthest from every edge.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of r) { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
  let best: [number, number] | null = null, bestD = -Infinity;
  for (let gi = 1; gi < 12; gi++) for (let gj = 1; gj < 12; gj++) {
    const p: [number, number] = [minX + (maxX - minX) * gi / 12, minY + (maxY - minY) * gj / 12];
    if (!pointInRing(p, r)) continue;
    let d = Infinity;
    for (let i = 0; i < r.length; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % r.length]));
    if (d > bestD) { bestD = d; best = p; }
  }
  if (best) return best;
  // Degenerate ring — vertex average is all that's left.
  let x = 0, y = 0;
  for (const [px, py] of r) { x += px; y += py; }
  return [x / r.length, y / r.length];
}
function pointInRing(pt: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Deterministic pseudo-random in [0,1) seeded from a couple of numbers (position, index).
// Cheap hash — good enough for "slightly rotate each stone" style jitter, never Math.random.
function seeded(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ── Shared palette (muted, design-palette-friendly — no saturated primaries) ────────
const WOOD = '#8a7256';        // muted warm wood (chair/table frames)
const WOOD_DARK = '#6b5642';   // darker wood (adirondack chairs, beds)
const FABRIC = '#8d8578';      // warm gray cushion fabric
const FABRIC_DARK = '#6f695f'; // shadow-side cushion fabric
const STONE = '#8a8378';       // warm gray fire pit stone
const CHARCOAL = '#2b2621';    // fire pit inner disc / grill body
const METAL = '#4b4e52';       // grill lid / wheel hubs
const LOG_BROWN = '#5a4530';
const FLAME_A = '#e8923e';
const FLAME_B = '#f2b25a';
const SOIL = '#3a2c1e';
const LEAF = '#5c7a4a';
const LEAF_DARK = '#46603a';
const UMBRELLA = '#7a8b7d'; // muted sage accent

// ── Shared module-level geometries (reused via scale where easy) ────────────────────
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const coneGeo = new THREE.ConeGeometry(1, 1, 8);
const sphereGeo = new THREE.SphereGeometry(1, 8, 6);

// ── Ground-shadow disc — a single soft dark ellipse under each furniture SET (footprint-sized),
// matching the plant shadows. Sits at local y = 0.02 (just above the pad top, which is furniture
// local 0 because Yard3D raises the whole set by the slab height); depthWrite off so it never
// z-fights. Nudged toward the implied sun (behind-left of the hero camera). One draw call each. ──
const shadowGeo = new THREE.CircleGeometry(1, 24); // faces +Z; rotated −π/2 to lie flat, up-facing
function GroundShadow({ rx, rz, opacity = 0.1 }: { rx: number; rz: number; opacity?: number }) {
  return (
    <mesh geometry={shadowGeo} rotation={[-Math.PI / 2, 0, 0]} position={[rx * 0.12, 0.02, rz * 0.1]} scale={[rx, rz, 1]}>
      <meshBasicMaterial color="#2f4a2a" transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

// ── Small reusable primitives ────────────────────────────────────────────────────────
function Box({ pos, size, rot, color }: { pos: [number, number, number]; size: [number, number, number]; rot?: [number, number, number]; color: string }) {
  return (
    <mesh geometry={boxGeo} castShadow position={pos} rotation={rot ?? [0, 0, 0]} scale={size}>
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}
function Cyl({ pos, radiusTop, radiusBottom, height, rot, color, radialSegments = 8 }: { pos: [number, number, number]; radiusTop: number; radiusBottom: number; height: number; rot?: [number, number, number]; color: string; radialSegments?: number }) {
  return (
    <mesh castShadow position={pos} rotation={rot ?? [0, 0, 0]}>
      <cylinderGeometry args={[radiusTop, radiusBottom, height, radialSegments]} />
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}
function Cone({ pos, radius, height, rot, color, radialSegments = 8 }: { pos: [number, number, number]; radius: number; height: number; rot?: [number, number, number]; color: string; radialSegments?: number }) {
  const geo = radialSegments === 8 ? coneGeo : undefined;
  return (
    <mesh castShadow position={pos} rotation={rot ?? [0, 0, 0]} scale={geo ? [radius, height, radius] : [1, 1, 1]}>
      {geo ? <primitive object={geo} attach="geometry" /> : <coneGeometry args={[radius, height, radialSegments]} />}
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}
function Sphere({ pos, radius, scaleY = 1, rot, color }: { pos: [number, number, number]; radius: number; scaleY?: number; rot?: [number, number, number]; color: string }) {
  return (
    <mesh geometry={sphereGeo} castShadow position={pos} rotation={rot ?? [0, 0, 0]} scale={[radius, radius * scaleY, radius]}>
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}

// A single chair leg set (4 thin box legs) shared by adirondack/dining/lounge chairs.
function Legs({ w, d, h, color, inset = 0.12 }: { w: number; d: number; h: number; color: string; inset?: number }) {
  const hw = w / 2 - inset, hd = d / 2 - inset;
  const pts: [number, number][] = [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]];
  return (
    <>
      {pts.map(([px, pz], i) => (
        <Box key={i} pos={[px, h / 2, pz]} size={[0.15, h, 0.15]} color={color} />
      ))}
    </>
  );
}

// ── 1. FIRE PIT ──────────────────────────────────────────────────────────────────────
// Ring of individual stone blocks, charcoal disc, 3 crossed logs, low flame, 4 adirondack
// chairs facing the pit centre.
function AdirondackChair({ pos, angle }: { pos: [number, number, number]; angle: number }) {
  // Seat ~1.4-1.5ft high, sloped slightly back; tall angled back with slats; wide flat arms.
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      {/* seat plank, slight backward slope */}
      <Box pos={[0, 1.45, 0]} rot={[0.12, 0, 0]} size={[1.9, 0.12, 1.7]} color={WOOD_DARK} />
      {/* angled back with 3 slats */}
      <group position={[0, 1.45, -0.78]} rotation={[-0.35, 0, 0]}>
        {[-0.65, 0, 0.65].map((sx, i) => (
          <Box key={i} pos={[sx, 0.9, 0]} size={[0.5, 1.8, 0.1]} color={WOOD_DARK} />
        ))}
      </group>
      {/* wide flat armrests */}
      <Box pos={[-0.95, 1.75, -0.05]} size={[0.35, 0.1, 1.6]} color={WOOD_DARK} />
      <Box pos={[0.95, 1.75, -0.05]} size={[0.35, 0.1, 1.6]} color={WOOD_DARK} />
      {/* arm support legs */}
      <Box pos={[-0.95, 1.15, 0.7]} rot={[-0.3, 0, 0]} size={[0.15, 1.2, 0.15]} color={WOOD_DARK} />
      <Box pos={[0.95, 1.15, 0.7]} rot={[-0.3, 0, 0]} size={[0.15, 1.2, 0.15]} color={WOOD_DARK} />
      {/* front legs */}
      <Box pos={[-0.8, 0.7, 0.7]} size={[0.15, 1.4, 0.15]} color={WOOD_DARK} />
      <Box pos={[0.8, 0.7, 0.7]} size={[0.15, 1.4, 0.15]} color={WOOD_DARK} />
      {/* rear legs (short, seat sits on sloped rails) */}
      <Box pos={[-0.8, 0.65, -0.7]} size={[0.15, 1.3, 0.15]} color={WOOD_DARK} />
      <Box pos={[0.8, 0.65, -0.7]} size={[0.15, 1.3, 0.15]} color={WOOD_DARK} />
    </group>
  );
}
function FirePitProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  const ringR = 2.1, chairR = 4.6, stoneCount = 9;
  const stones = useMemo(() => Array.from({ length: stoneCount }, (_, i) => {
    const a = (i / stoneCount) * Math.PI * 2;
    const jitterA = (seeded(i, 1) - 0.5) * 0.3;
    const jitterR = (seeded(i, 2) - 0.5) * 0.25;
    const r = ringR + jitterR;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, rotY: a + jitterA, s: 0.85 + seeded(i, 3) * 0.3 };
  }), []);
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={5.6} rz={5.6} opacity={0.09} />
      {/* stone ring — individual blocks, slightly rotated/jittered each, warm gray */}
      {stones.map((s, i) => (
        <Box key={i} pos={[s.x, 0.45 * s.s, s.z]} rot={[0, s.rotY, 0]} size={[0.9 * s.s, 0.9 * s.s, 0.7 * s.s]} color={STONE} />
      ))}
      {/* dark charcoal inner disc */}
      <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[ringR - 0.35, 16]} />
        <meshStandardMaterial color={CHARCOAL} flatShading />
      </mesh>
      {/* 3 crossed logs, visible ends */}
      <Cyl pos={[0, 0.55, 0]} radiusTop={0.16} radiusBottom={0.16} height={2.6} rot={[0, 0.3, Math.PI / 2 + 0.15]} color={LOG_BROWN} radialSegments={6} />
      <Cyl pos={[0, 0.62, 0]} radiusTop={0.16} radiusBottom={0.16} height={2.6} rot={[0, 0.3, -Math.PI / 2 - 0.35]} color={LOG_BROWN} radialSegments={6} />
      <Cyl pos={[0, 0.7, 0]} radiusTop={0.15} radiusBottom={0.15} height={2.3} rot={[0.2, 0.3, 0.15]} color={LOG_BROWN} radialSegments={6} />
      {/* low flame — 2-3 overlapping cones */}
      <Cone pos={[0, 0.95, 0]} radius={0.5} height={1.1} color={FLAME_A} />
      <Cone pos={[0.18, 0.85, 0.1]} radius={0.32} height={0.85} color={FLAME_B} />
      <Cone pos={[-0.2, 0.8, -0.12]} radius={0.28} height={0.7} color={FLAME_A} />
      {/* 4 adirondack chairs facing pit centre */}
      {[0, 1, 2, 3].map(i => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = Math.cos(a) * chairR, pz = Math.sin(a) * chairR;
        // face inward: chair's local -Z (back) points outward, so rotate to face centre
        const faceAngle = Math.atan2(-px, -pz);
        return <AdirondackChair key={i} pos={[px, 0, pz]} angle={faceAngle} />;
      })}
    </group>
  );
}

// ── 2. SEATING / LOUNGE ─────────────────────────────────────────────────────────────
// Outdoor sofa + 1-2 lounge chairs arranged around a low coffee table, all facing inward.
function CushionRow({ count, w, pos, seatH, color }: { count: number; w: number; pos: [number, number, number]; seatH: number; color: string }) {
  const cw = w / count;
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const px = -w / 2 + cw * (i + 0.5);
        return <Box key={i} pos={[pos[0] + px, seatH, pos[2]]} size={[cw * 0.92, 0.7, 2.1]} color={color} />;
      })}
    </>
  );
}
function SofaUnit({ pos, angle, length = 6 }: { pos: [number, number, number]; angle: number; length?: number }) {
  const cushions = Math.max(2, Math.round(length / 2));
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      {/* base frame */}
      <Box pos={[0, 0.6, 0]} size={[length, 1.1, 2.4]} color={WOOD_DARK} />
      {/* seat cushions */}
      <CushionRow count={cushions} w={length - 0.3} pos={[0, 1.3, 0.05]} seatH={1.3} color={FABRIC} />
      {/* back cushions */}
      <CushionRow count={cushions} w={length - 0.3} pos={[0, 1.95, -0.85]} seatH={1.95} color={FABRIC_DARK} />
      {/* low armrests */}
      <Box pos={[-length / 2 + 0.15, 1.35, 0]} size={[0.35, 1.1, 2.4]} color={WOOD_DARK} />
      <Box pos={[length / 2 - 0.15, 1.35, 0]} size={[0.35, 1.1, 2.4]} color={WOOD_DARK} />
    </group>
  );
}
function LoungeChair({ pos, angle }: { pos: [number, number, number]; angle: number }) {
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      <Box pos={[0, 0.6, 0]} size={[2.2, 1.1, 2.2]} color={WOOD_DARK} />
      <Box pos={[0, 1.3, 0.05]} size={[1.9, 0.7, 1.9]} color={FABRIC} />
      <Box pos={[0, 1.95, -0.75]} size={[1.9, 1.3, 0.5]} color={FABRIC_DARK} />
      <Box pos={[-0.95, 1.35, 0]} size={[0.3, 1.1, 2.2]} color={WOOD_DARK} />
      <Box pos={[0.95, 1.35, 0]} size={[0.3, 1.1, 2.2]} color={WOOD_DARK} />
    </group>
  );
}
function CoffeeTable({ pos }: { pos: [number, number, number] }) {
  return (
    <group position={pos}>
      <Box pos={[0, 1.05, 0]} size={[2.6, 0.15, 1.6]} color={WOOD} />
      {[[-1.1, -0.65], [1.1, -0.65], [-1.1, 0.65], [1.1, 0.65]].map(([px, pz], i) => (
        <Box key={i} pos={[px, 0.5, pz]} size={[0.15, 1.0, 0.15]} color={WOOD} />
      ))}
    </group>
  );
}
function SeatingProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  // L arrangement: sofa along -Z edge facing +Z, lounge chair along -X edge facing +X,
  // coffee table at the centre they both face into.
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={4.6} rz={4.0} opacity={0.1} />
      <SofaUnit pos={[0, 0, -2.6]} angle={0} length={6} />
      <LoungeChair pos={[-3.4, 0, 0.6]} angle={Math.PI / 2} />
      <LoungeChair pos={[3.4, 0, 0.6]} angle={-Math.PI / 2} />
      <CoffeeTable pos={[0, 0, 0.2]} />
    </group>
  );
}

// ── 3. COOKING / BBQ ─────────────────────────────────────────────────────────────────
// Cart-style grill: body on 4 legs (2 wheeled), domed lid with handle, side shelf,
// dark charcoal body + metallic-gray lid, plus a small prep table beside it.
function BBQGrill({ pos, angle }: { pos: [number, number, number]; angle: number }) {
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      {/* cart body */}
      <Box pos={[0, 1.5, 0]} size={[2.6, 1.4, 1.5]} color={CHARCOAL} />
      {/* legs — front 2 wheeled, rear 2 plain */}
      <Box pos={[-1.05, 0.55, -0.55]} size={[0.14, 1.1, 0.14]} color={METAL} />
      <Box pos={[1.05, 0.55, -0.55]} size={[0.14, 1.1, 0.14]} color={METAL} />
      <Box pos={[-1.05, 0.6, 0.55]} size={[0.14, 1.0, 0.14]} color={METAL} />
      <Box pos={[1.05, 0.6, 0.55]} size={[0.14, 1.0, 0.14]} color={METAL} />
      <Cyl pos={[-1.05, 0.22, 0.55]} radiusTop={0.22} radiusBottom={0.22} height={0.16} rot={[Math.PI / 2, 0, 0]} color={METAL} radialSegments={10} />
      <Cyl pos={[1.05, 0.22, 0.55]} radiusTop={0.22} radiusBottom={0.22} height={0.16} rot={[Math.PI / 2, 0, 0]} color={METAL} radialSegments={10} />
      {/* domed lid (squashed sphere) */}
      <Sphere pos={[0, 2.35, 0]} radius={1.05} scaleY={0.62} color={METAL} />
      {/* lid handle bar */}
      <Box pos={[0, 2.55, 0.78]} size={[0.9, 0.08, 0.08]} color={CHARCOAL} />
      <Box pos={[-0.4, 2.45, 0.78]} size={[0.08, 0.22, 0.08]} color={CHARCOAL} />
      <Box pos={[0.4, 2.45, 0.78]} size={[0.08, 0.22, 0.08]} color={CHARCOAL} />
      {/* side shelf slab */}
      <Box pos={[1.55, 1.55, 0]} size={[0.7, 0.1, 1.3]} color={WOOD} />
      <Box pos={[1.35, 1.15, -0.5]} size={[0.08, 0.85, 0.08]} color={METAL} />
      <Box pos={[1.35, 1.15, 0.5]} size={[0.08, 0.85, 0.08]} color={METAL} />
    </group>
  );
}
function PrepTable({ pos, angle }: { pos: [number, number, number]; angle: number }) {
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      <Box pos={[0, 1.5, 0]} size={[2.0, 0.12, 1.1]} color={WOOD} />
      <Legs w={1.9} d={1.0} h={1.45} color={WOOD_DARK} />
    </group>
  );
}
function CookingProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={3.2} rz={1.9} opacity={0.1} />
      <BBQGrill pos={[-1.4, 0, 0]} angle={Math.PI / 2} />
      <PrepTable pos={[1.6, 0, 0]} angle={Math.PI / 2} />
    </group>
  );
}

// ── 4. DINING ────────────────────────────────────────────────────────────────────────
// Rectangular table + 4-6 chairs tucked around it, center umbrella (pole + shallow cone).
function DiningChair({ pos, angle }: { pos: [number, number, number]; angle: number }) {
  return (
    <group position={pos} rotation={[0, angle, 0]}>
      <Box pos={[0, 1.5, 0]} size={[1.3, 0.1, 1.3]} color={WOOD} />
      <Box pos={[0, 2.1, -0.6]} size={[1.2, 1.2, 0.1]} color={WOOD} />
      <Legs w={1.2} d={1.2} h={1.45} color={WOOD_DARK} />
    </group>
  );
}
function DiningTable({ length = 6, width = 3.2 }: { length?: number; width?: number }) {
  return (
    <group>
      <Box pos={[0, 2.35, 0]} size={[length, 0.15, width]} color={WOOD} />
      {[[-length / 2 + 0.3, -width / 2 + 0.3], [length / 2 - 0.3, -width / 2 + 0.3], [-length / 2 + 0.3, width / 2 - 0.3], [length / 2 - 0.3, width / 2 - 0.3]].map(([px, pz], i) => (
        <Box key={i} pos={[px, 1.15, pz]} size={[0.18, 2.3, 0.18]} color={WOOD_DARK} />
      ))}
    </group>
  );
}
function Umbrella({ pos }: { pos: [number, number, number] }) {
  return (
    <group position={pos}>
      <Cyl pos={[0, 3.5, 0]} radiusTop={0.08} radiusBottom={0.08} height={5} color={WOOD_DARK} radialSegments={8} />
      <Cone pos={[0, 6.1, 0]} radius={3.2} height={1.3} color={UMBRELLA} radialSegments={10} />
    </group>
  );
}
function DiningProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  const length = 6, width = 3.2;
  const chairs: { pos: [number, number]; angle: number }[] = [
    { pos: [-1.7, -width / 2 - 0.85], angle: 0 },
    { pos: [1.7, -width / 2 - 0.85], angle: 0 },
    { pos: [-1.7, width / 2 + 0.85], angle: Math.PI },
    { pos: [1.7, width / 2 + 0.85], angle: Math.PI },
    { pos: [-length / 2 - 0.85, 0], angle: Math.PI / 2 },
    { pos: [length / 2 + 0.85, 0], angle: -Math.PI / 2 },
  ];
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={4.2} rz={3.4} opacity={0.1} />
      <DiningTable length={length} width={width} />
      <Umbrella pos={[0, 0, 0]} />
      {chairs.map((c, i) => <DiningChair key={i} pos={[c.pos[0], 0, c.pos[1]]} angle={c.angle} />)}
    </group>
  );
}

// ── 5. RAISED GARDEN BEDS ────────────────────────────────────────────────────────────
// Planked beds (4 side planks + corner posts), dark soil top, rows of tiny plant tufts.
function PlantTuft({ pos, seedX, seedZ }: { pos: [number, number, number]; seedX: number; seedZ: number }) {
  const isSphere = seeded(seedX, seedZ) > 0.5;
  const h = 0.35 + seeded(seedX + 1, seedZ) * 0.25;
  const color = seeded(seedX, seedZ + 2) > 0.5 ? LEAF : LEAF_DARK;
  return isSphere
    ? <Sphere pos={[pos[0], pos[1] + h * 0.5, pos[2]]} radius={h * 0.55} color={color} />
    : <Cone pos={[pos[0], pos[1] + h * 0.5, pos[2]]} radius={h * 0.4} height={h} color={color} radialSegments={6} />;
}
function RaisedBed({ pos, w = 6, d = 3 }: { pos: [number, number, number]; w?: number; d?: number }) {
  const wallH = 1.0, wallT = 0.15;
  const rows = 2, cols = 4;
  const plants = useMemo(() => {
    const out: { x: number; z: number; sx: number; sz: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -w / 2 + 0.9 + c * ((w - 1.8) / (cols - 1));
        const z = -d / 2 + 0.7 + r * ((d - 1.4) / Math.max(1, rows - 1));
        out.push({ x, z, sx: pos[0] + x, sz: pos[2] + z });
      }
    }
    return out;
  }, [w, d, pos[0], pos[2]]);
  return (
    <group position={pos}>
      {/* 4 side planks */}
      <Box pos={[0, wallH / 2, -d / 2 + wallT / 2]} size={[w, wallH, wallT]} color={WOOD} />
      <Box pos={[0, wallH / 2, d / 2 - wallT / 2]} size={[w, wallH, wallT]} color={WOOD} />
      <Box pos={[-w / 2 + wallT / 2, wallH / 2, 0]} size={[wallT, wallH, d]} color={WOOD} />
      <Box pos={[w / 2 - wallT / 2, wallH / 2, 0]} size={[wallT, wallH, d]} color={WOOD} />
      {/* corner posts, visible above the planks */}
      {[[-w / 2 + wallT, -d / 2 + wallT], [w / 2 - wallT, -d / 2 + wallT], [-w / 2 + wallT, d / 2 - wallT], [w / 2 - wallT, d / 2 - wallT]].map(([px, pz], i) => (
        <Box key={i} pos={[px, wallH / 2 + 0.08, pz]} size={[0.22, wallH + 0.16, 0.22]} color={WOOD_DARK} />
      ))}
      {/* dark soil top slab */}
      <mesh position={[0, wallH - 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w - wallT * 2, d - wallT * 2]} />
        <meshStandardMaterial color={SOIL} flatShading />
      </mesh>
      {/* plant tufts */}
      {plants.map((p, i) => <PlantTuft key={i} pos={[p.x, wallH, p.z]} seedX={p.sx * 3.1 + i} seedZ={p.sz * 2.7} />)}
    </group>
  );
}
function GardenBedProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={3.4} rz={3.6} opacity={0.1} />
      <RaisedBed pos={[0, 0, -1.8]} />
      <RaisedBed pos={[0, 0, 1.8]} />
    </group>
  );
}

// ── 6. PLAY (swing set) ─────────────────────────────────────────────────────────────
// A-frame legs at both ends, top beam, 2 swings (rope cylinders + seat slabs).
function AFrame({ pos }: { pos: [number, number, number] }) {
  return (
    <group position={pos}>
      <Box pos={[0, 3, 1]} rot={[0.38, 0, 0]} size={[0.22, 6.6, 0.22]} color={WOOD} />
      <Box pos={[0, 3, -1]} rot={[-0.38, 0, 0]} size={[0.22, 6.6, 0.22]} color={WOOD} />
      {/* cross brace for stability read */}
      <Box pos={[0, 2.2, 0]} size={[0.16, 0.16, 2.3]} color={WOOD_DARK} />
    </group>
  );
}
function Swing({ pos }: { pos: [number, number, number] }) {
  return (
    <group position={pos}>
      <Cyl pos={[-0.35, 4.7, 0]} radiusTop={0.05} radiusBottom={0.05} height={2.6} color={WOOD_DARK} radialSegments={6} />
      <Cyl pos={[0.35, 4.7, 0]} radiusTop={0.05} radiusBottom={0.05} height={2.6} color={WOOD_DARK} radialSegments={6} />
      <Box pos={[0, 3.4, 0]} size={[0.9, 0.1, 0.5]} color={UMBRELLA} />
    </group>
  );
}
function PlayProxy({ cx0, cz0 }: { cx0: number; cz0: number }) {
  return (
    <group position={[cx0, 0, cz0]}>
      <GroundShadow rx={3.7} rz={1.7} opacity={0.1} />
      <AFrame pos={[-3, 0, 0]} />
      <AFrame pos={[3, 0, 0]} />
      {/* top beam spanning both A-frames */}
      <Box pos={[0, 6, 0]} size={[6.3, 0.24, 0.24]} color={WOOD} />
      <Swing pos={[-1.2, 0, 0]} />
      <Swing pos={[1.2, 0, 0]} />
    </group>
  );
}

// ── Public entry point ───────────────────────────────────────────────────────────────
// Picks a furnishing set for a zone by key/label; returns null if none matches or the
// zone bbox is too small for the furniture footprint (+1ft clearance, same gate as before).
export function ZoneProxy({ zone, cx, cy }: { zone: any; cx: number; cy: number }) {
  const [fcx, fcy] = centroid(zone.ring);
  const cx0 = fcx - cx, cz0 = fcy - cy; // world Z = y − cy (ground layers render with this after their −π/2 rotation)
  // zone bbox in feet
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of zone.ring) { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
  const bw = maxX - minX, bh = maxY - minY;
  const key = `${zone.key ?? ''} ${zone.label ?? ''}`.toLowerCase();
  const fits = (fw: number, fh: number) => (bw >= fw + 1 && bh >= fh + 1);
  // Cooking/BBQ is checked before the generic fire regex so a zone explicitly labelled
  // for grilling ("outdoor kitchen", "bbq", "grill") gets the grill cart, while a plain
  // "fire" zone still gets the fire pit + adirondack chairs.
  if (/cook|bbq|grill|kitchen/.test(key) && fits(6, 4)) return <CookingProxy cx0={cx0} cz0={cz0} />;
  if (/fire|cooking/.test(key) && fits(11, 11)) return <FirePitProxy cx0={cx0} cz0={cz0} />;
  if (/seat|patio|lounge|gather/.test(key) && fits(8, 8)) return <SeatingProxy cx0={cx0} cz0={cz0} />;
  if (/dining|dine|eat/.test(key) && fits(8, 8)) return <DiningProxy cx0={cx0} cz0={cz0} />;
  if (/veg|garden bed|garden|raised/.test(key) && fits(6, 7)) return <GardenBedProxy cx0={cx0} cz0={cz0} />;
  if (/play/.test(key) && fits(7, 3)) return <PlayProxy cx0={cx0} cz0={cz0} />;
  return null;
}
