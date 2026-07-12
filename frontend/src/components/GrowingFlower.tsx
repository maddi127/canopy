// A looping line-drawing of a flower growing up out of the ground, in the hand-drawn style of the
// aerial plan (sketchy stroke via a turbulence filter, plan greens + a warm bloom). Draws on part by
// part — ground → stem → leaves → petals → center — holds, fades, and repeats. Pure CSS/SVG, no
// timers or randomness, so it's deterministic and runs on loop until its overlay unmounts.

// Six petals evenly around the bloom centre, each rotated to point outward.
const PETALS = Array.from({ length: 6 }, (_, i) => {
  const a = -90 + i * 60;                 // degrees, first petal points up
  const r = (a * Math.PI) / 180;
  const cx = 70 + 15 * Math.cos(r);
  const cy = 58 + 15 * Math.sin(r);
  return { cx, cy, rot: a + 90 };
});

export default function GrowingFlower({ size = 140 }: { size?: number }) {
  return (
    <svg className="gf" width={size} height={size * (160 / 140)} viewBox="0 0 140 160"
      fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <style>{`
        @keyframes gfGround { 0%,4%   { stroke-dashoffset: 100; } 16%,100% { stroke-dashoffset: 0; } }
        @keyframes gfStem   { 0%,12%  { stroke-dashoffset: 100; } 40%,100% { stroke-dashoffset: 0; } }
        @keyframes gfLeafL  { 0%,34%  { stroke-dashoffset: 100; } 50%,100% { stroke-dashoffset: 0; } }
        @keyframes gfLeafR  { 0%,44%  { stroke-dashoffset: 100; } 60%,100% { stroke-dashoffset: 0; } }
        @keyframes gfPetal  { 0%,58%  { stroke-dashoffset: 100; } 82%,100% { stroke-dashoffset: 0; } }
        @keyframes gfCenter { 0%,78%  { stroke-dashoffset: 100; } 88%,100% { stroke-dashoffset: 0; } }
        @keyframes gfFade   { 0%,88%  { opacity: 1; } 100% { opacity: 0; } }
        .gf .grp    { animation: gfFade   3.6s ease-in infinite; }
        .gf .ground { animation: gfGround 3.6s linear  infinite; }
        .gf .stem   { animation: gfStem   3.6s linear  infinite; }
        .gf .leafL  { animation: gfLeafL  3.6s linear  infinite; }
        .gf .leafR  { animation: gfLeafR  3.6s linear  infinite; }
        .gf .petal  { animation: gfPetal  3.6s linear  infinite; }
        .gf .center { animation: gfCenter 3.6s linear  infinite; }
      `}</style>
      <defs>
        <filter id="gfSketch" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="2" />
        </filter>
      </defs>
      <g className="grp" filter="url(#gfSketch)" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* Ground line + a few soil ticks */}
        <path className="ground" d="M22 138 H118 M42 143 v4 M70 144 v4 M98 143 v4"
          stroke="#2F6B4F" strokeWidth={2.6} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        {/* Stem */}
        <path className="stem" d="M70 138 C 65 116 75 96 70 71"
          stroke="#2F6B4F" strokeWidth={2.6} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        {/* Leaves */}
        <path className="leafL" d="M69 108 C 54 98 42 104 37 114 C 49 120 62 120 69 108 Z"
          stroke="#3E7D57" strokeWidth={2.4} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        <path className="leafR" d="M71 94 C 86 84 98 90 103 100 C 91 106 78 106 71 94 Z"
          stroke="#3E7D57" strokeWidth={2.4} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        {/* Bloom: petals then centre */}
        {PETALS.map((p, i) => (
          <ellipse key={i} className="petal" cx={p.cx} cy={p.cy} rx={6.5} ry={12}
            transform={`rotate(${p.rot} ${p.cx} ${p.cy})`}
            stroke="#C77C5B" strokeWidth={2.4} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
        ))}
        <circle className="center" cx={70} cy={58} r={7}
          stroke="#E0A93B" strokeWidth={2.4} pathLength={100} strokeDasharray={100} strokeDashoffset={100} />
      </g>
    </svg>
  );
}
