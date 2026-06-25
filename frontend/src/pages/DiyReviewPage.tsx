import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import DiyPlanMap from '../components/DiyPlanMap';

const BG = '#efe9db';
const DARK = '#2A2A26';
const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

// ── Label / color maps (mirrors DiyPlacementPage) ───────────────────────────────
const FEATURE_MATERIAL_LABEL: Record<string, string> = {
  pavers: 'Pavers', concrete: 'Concrete', flagstone: 'Flagstone', mulch: 'Mulch', gravel: 'Gravel', brick: 'Brick',
};
const FEATURE_MATERIAL_COLOR: Record<string, string> = {
  pavers: '#B7AC9A', concrete: '#C2BEB5', flagstone: '#A7A096', mulch: '#8B6B4A', gravel: '#B4AC9B', brick: '#9E5E48',
};
const VARIANT_LABEL: Record<string, string> = {
  natural: 'Natural', brown: 'Brown', black: 'Black', river: 'River rocks', pea: 'Pea gravel', lava: 'Lava rock',
};
const VARIANT_COLOR: Record<string, string> = {
  natural: '#C7B083', brown: '#A6743F', black: '#4A443C', river: '#A3A69D', pea: '#C3BBA6', lava: '#8A574B',
};
const MATERIAL_COLOR: Record<string, string> = { mulch: '#8B6B4A', rock: '#9A9A8C', lawn: '#8DAA6A' };
const PATH_COLOR = '#6E7681';
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// ── Geometry helpers (all coords already in feet) ───────────────────────────────
function ringArea(verts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    a += verts[i][0] * verts[j][1] - verts[j][0] * verts[i][1];
  }
  return Math.abs(a / 2);
}
function zoneArea(z: any): number {
  if (z.verts && z.verts.length >= 3) return ringArea(z.verts);
  if (z.shape === 'circle') return (Math.PI / 4) * (z.wFt || 0) * (z.hFt || 0);
  return (z.wFt || 0) * (z.hFt || 0);
}
function pathLength(pts: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Shape ring (ft). Prefer the baked ring from placement, else recompute from raw fields
// so the plan still draws if the stored geometry predates ring baking.
function seededRng(seed: number) {
  let s = seed | 0;
  return () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff; };
}
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function organicRingFt(cx: number, cy: number, rx: number, ry: number, id: string): [number, number][] {
  const rng = seededRng(hashId(id));
  const N = 9;
  const pts: [number, number][] = Array.from({ length: N }, (_, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const j = 0.78 + rng() * 0.44;
    return [cx + Math.cos(angle) * rx * j, cy + Math.sin(angle) * ry * j];
  });
  const ring: [number, number][] = [];
  const STEPS = 8;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      ring.push([
        u*u*u*p1[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p2[0],
        u*u*u*p1[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p2[1],
      ]);
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

interface Plan {
  zones: any[];
  beds: any[];
  paths: any[];
  primary: { material: string | null; variant: string | null };
  boundary: [number, number][];
  obstacles: [number, number][][];
  projectAreaFt: number;
  primaryGroundAreaFt: number;
  address: string;
}

export default function DiyReviewPage() {
  const navigate = useNavigate();

  const plan = useMemo<Plan>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('diyPlacementPlan') || '{}');
      return { zones: p.zones || [], beds: p.beds || [], paths: p.paths || [], primary: p.primary || { material: null, variant: null }, boundary: p.boundary || [], obstacles: p.obstacles || [], projectAreaFt: p.projectAreaFt || 0, primaryGroundAreaFt: p.primaryGroundAreaFt || 0, address: p.address || '' };
    } catch {
      return { zones: [], beds: [], paths: [], primary: { material: null, variant: null }, boundary: [], obstacles: [], projectAreaFt: 0, primaryGroundAreaFt: 0, address: '' };
    }
  }, []);

  const features = plan.zones.filter(z => z.key !== 'lawn');
  const lawns    = plan.zones.filter(z => z.key === 'lawn');
  const beds     = plan.beds.filter(b => b.material !== 'lawn');

  const primaryLabel = plan.primary.variant
    ? `${VARIANT_LABEL[plan.primary.variant] || cap(plan.primary.variant)} ${plan.primary.material || ''}`.trim()
    : plan.primary.material ? cap(plan.primary.material) : null;
  const primaryColor = plan.primary.variant ? VARIANT_COLOR[plan.primary.variant] : (plan.primary.material ? MATERIAL_COLOR[plan.primary.material] : '#ccc');

  // The open ground — everything not carved out by features, secondary beds, walkways
  // or existing structures — is treated as one plantable bed of the primary material.
  const bedAreaOf = (b: any) => b.ring && b.ring.length >= 3 ? ringArea(b.ring) : (b.verts && b.verts.length >= 3 ? ringArea(b.verts) : (b.wFt || 0) * (b.hFt || 0));
  // Total project area minus everything that sits on top of the open ground.
  const projectArea  = plan.projectAreaFt || (plan.boundary.length >= 3 ? ringArea(plan.boundary) : 0);
  const usedByZones  = plan.zones.reduce((s, z) => s + (z.ring ? ringArea(z.ring) : zoneArea(z)), 0);
  const usedByBeds   = beds.reduce((s, b) => s + bedAreaOf(b), 0);
  const usedByPaths  = plan.paths.reduce((s, p) => s + pathLength(p.pts || []) * (p.widthFt || 0), 0);
  const usedByObs    = (plan.obstacles || []).reduce((s, o) => s + (o.length >= 3 ? ringArea(o) : 0), 0);
  // Prefer the exact clipped value from placement; fall back to the summed estimate.
  const primaryArea  = plan.primaryGroundAreaFt || Math.max(0, projectArea - usedByZones - usedByBeds - usedByPaths - usedByObs);
  const matLabel = (material: string, variant: string | null) => `${cap(material)}${variant ? ` · ${VARIANT_LABEL[variant] || cap(variant)}` : ''}`;

  const bedRows: { id: string; label: string; type: string; color: string; mat: string; area: number; note?: string }[] = [
    // The primary ground cover = the open plantable area, shown whenever a primary material is chosen.
    ...(plan.primary.material
      ? [{ id: '__primary', label: 'Open planting area', type: 'planted', color: primaryColor, mat: matLabel(plan.primary.material, plan.primary.variant), area: primaryArea }]
      : []),
    ...beds.map(b => ({ id: b.id, label: b.label, type: b.type, color: b.variant ? VARIANT_COLOR[b.variant] : MATERIAL_COLOR[b.material], mat: matLabel(b.material, b.variant), area: bedAreaOf(b) })),
  ];

  const Swatch = ({ color, round }: { color: string; round?: boolean }) => (
    <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: round ? '50%' : 3, background: color, flexShrink: 0, verticalAlign: 'middle', marginRight: 8 }} />
  );

  const sectionTitle = (t: string) => (
    <h2 style={{ fontFamily: IT, fontSize: '0.72rem', fontWeight: 700, color: '#8A8A7E', letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 10px' }}>{t}</h2>
  );

  // Shared column widths so Features / Beds / Walkways tables line up.
  const COLS = { name: '28%', type: '16%', mat: '22%', size: '18%', area: '16%' };
  const dash = <span style={{ color: '#B5B5AA' }}>—</span>;
  const th: React.CSSProperties = { fontFamily: IT, fontSize: '0.66rem', fontWeight: 700, color: '#9A9A8E', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'left', padding: '0 12px 8px 0' };
  const td: React.CSSProperties = { fontFamily: IT, fontSize: '0.9rem', color: DARK, padding: '9px 12px 9px 0', borderTop: '1px solid rgba(42,42,38,0.08)', verticalAlign: 'middle' };

  const card: React.CSSProperties = { background: 'white', borderRadius: 18, padding: '22px 24px', boxShadow: '0 2px 14px rgba(42,42,38,0.06)', marginBottom: 18 };

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: IT }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          .review-page { background: white !important; }
          .review-card { box-shadow: none !important; border: 1px solid rgba(42,42,38,0.12); }
        }
      `}</style>

      {/* Coming-soon banner */}
      <div style={{ background: '#2F6B4F', color: '#eef3ee', textAlign: 'center', padding: '9px 16px', fontFamily: IT, fontSize: '0.86rem', fontWeight: 500, letterSpacing: '0.01em' }}>
        Coming soon: plant selection and placement
      </div>

      <div className="review-page" style={{ maxWidth: 820, margin: '0 auto', padding: '32px 28px 80px' }}>
        {/* Header */}
        <div className="flex items-start justify-between" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
          <div>
            <Logo />
            <h1 style={{ fontFamily: IS, fontSize: '2.4rem', color: DARK, fontWeight: 400, lineHeight: 1.05, margin: '14px 0 4px' }}>Your plan summary</h1>
            {plan.address && <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#7A7A6E', margin: 0 }}>{plan.address}</p>}
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <button onClick={() => navigate('/diy/placement')}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#7A7A73', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 4px' }}>
              ← Edit plan
            </button>
            <button onClick={() => window.print()}
              style={{ fontFamily: IT, fontSize: '0.85rem', fontWeight: 500, color: '#efe9db', background: DARK, border: 'none', cursor: 'pointer', padding: '10px 20px', borderRadius: 999 }}>
              Print / Save as PDF
            </button>
          </div>
        </div>

        {/* Plan view — the same satellite map as placement, read-only */}
        <div className="review-card" style={{ ...card, padding: 10 }}>
          <DiyPlanMap plan={plan} />
        </div>

        {/* Features */}
        {(features.length > 0 || lawns.length > 0) && (
        <div className="review-card" style={card}>
          {sectionTitle(`Features (${features.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Feature</th><th style={{ ...th, width: COLS.type }}></th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {features.map(z => {
                  const matColor = z.material ? FEATURE_MATERIAL_COLOR[z.material] : z.color;
                  const size = (z.verts && z.verts.length >= 3) || !(z.wFt > 0 && z.hFt > 0) ? dash : `${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft`;
                  return (
                    <tr key={z.id}>
                      <td style={td}><Swatch color={matColor} round={z.shape === 'circle'} />{z.label}</td>
                      <td style={td}></td>
                      <td style={td}>{z.material ? FEATURE_MATERIAL_LABEL[z.material] : dash}</td>
                      <td style={td}>{size}</td>
                      <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(zoneArea(z)).toLocaleString()} sq ft</td>
                    </tr>
                  );
                })}
                {lawns.map(z => (
                  <tr key={z.id}>
                    <td style={td}><Swatch color={MATERIAL_COLOR.lawn} round={z.shape === 'circle'} />{z.label || 'Lawn'}</td>
                    <td style={td}></td>
                    <td style={td}><span style={{ color: '#B5B5AA' }}>Grass</span></td>
                    <td style={td}>{(z.verts && z.verts.length >= 3) || !(z.wFt > 0 && z.hFt > 0) ? dash : `${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft`}</td>
                    <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(zoneArea(z)).toLocaleString()} sq ft</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {/* Planting beds — the open primary-material area plus any secondary beds */}
        {bedRows.length > 0 && (
        <div className="review-card" style={card}>
          {sectionTitle(`Planting beds (${bedRows.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Bed</th><th style={{ ...th, width: COLS.type }}>Type</th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {bedRows.map(b => (
                  <tr key={b.id}>
                    <td style={td}><Swatch color={b.color} />{b.label}</td>
                    <td style={td}>{b.type === 'planted' ? 'Planted' : 'Unplanted'}</td>
                    <td style={td}>{b.mat}</td>
                    <td style={td}>{dash}</td>
                    <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(b.area).toLocaleString()} sq ft</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {/* Walkways */}
        {plan.paths.length > 0 && (
        <div className="review-card" style={card}>
          {sectionTitle(`Walkways (${plan.paths.length})`)}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead><tr><th style={{ ...th, width: COLS.name }}>Walkway</th><th style={{ ...th, width: COLS.type }}>Style</th><th style={{ ...th, width: COLS.mat }}>Material</th><th style={{ ...th, width: COLS.size }}>Size</th><th style={{ ...th, width: COLS.area, textAlign: 'right', paddingRight: 0 }}>Area</th></tr></thead>
              <tbody>
                {plan.paths.map(p => {
                  const len = pathLength(p.pts || []);
                  return (
                    <tr key={p.id}>
                      <td style={td}><Swatch color={PATH_COLOR} />{p.label}</td>
                      <td style={td}>{cap(p.style)}</td>
                      <td style={td}>{p.material ? cap(p.material) : dash}</td>
                      <td style={td}>{Math.round(len)} × {p.widthFt} ft</td>
                      <td style={{ ...td, textAlign: 'right', paddingRight: 0, fontWeight: 600 }}>{Math.round(len * (p.widthFt || 0)).toLocaleString()} sq ft</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        )}

        <p style={{ fontFamily: IT, fontSize: '0.75rem', color: '#A8A89C', textAlign: 'center', marginTop: 8 }}>
          Areas are approximate footprints based on your layout.
        </p>
      </div>
    </div>
  );
}
