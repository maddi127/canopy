import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import GrowingFlower from '../components/GrowingFlower';
import PlanSnapshot from '../components/PlanSnapshot';
import { useAuth } from '../context/AuthContext';
import {
  listAddresses,
  listProjectsWithDesigns,
  deleteDesign,
  updateDesign,
  setSelectedDesign,
} from '../services/db';
import { loadDesign } from '../services/activeDesign';
import { clearAllDesignState } from '../services/designPayload';
import { IS, IT, PAGE_BG } from '../lib/theme';

const DIY_START = '/diy/preferences';

// Brand tokens (inline-style idiom shared across the DIY flow pages).
const BG = '#efe9db';
const DARK = '#2A2A26';
const MUTED = '#6A6A60';
const FAINT = '#9A9A92';
const GREEN = '#2F6B4F';
const CARD_SHADOW = '0 4px 24px rgba(26,26,22,0.08)';
const THUMB_H = 138;

interface DesignItem {
  id: string;
  name: string | null;
  updated_at: string;
  status: string;
  project_id: string;
  plan: any;
  plants: any[];
}
interface ProjectGroup {
  id: string;
  yard_type: string;
  selected_design_id: string | null;
  designs: DesignItem[]; // all designs incl. archived; filtered at render time
}
interface AddressGroup {
  key: string;
  address: string | null;
  projects: ProjectGroup[];
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// "front" → "Front yard", "back" → "Back yard", "side" → "Side yard".
// If the value already reads like a yard label, leave it capitalized as-is.
function yardLabel(yardType: string): string {
  const t = (yardType || '').trim();
  if (!t) return 'Yard';
  if (t.toLowerCase() === 'back') return 'Backyard';   // "backyard" is one word; "front yard" stays two
  if (/yard/i.test(t)) return cap(t);
  return `${cap(t)} yard`;
}

function designTitle(name: string | null, address: string | null): string {
  if (name && name.trim()) return name.trim();
  if (address && address.trim()) return address.trim();
  return 'Untitled design';
}

function relativeUpdated(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const day = 86_400_000;
  const diff = Date.now() - then;
  if (diff < 0) return 'Updated just now';
  if (diff < day) return 'Updated today';
  if (diff < 2 * day) return 'Updated yesterday';
  const days = Math.floor(diff / day);
  if (days < 7) return `Updated ${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `Updated ${w} week${w > 1 ? 's' : ''} ago`;
  }
  return `Updated ${new Date(iso).toLocaleDateString()}`;
}

// A plan only renders if it has a boundary ring with ≥3 points (PlanSnapshot needs it
// for the affine fit); anything less shows the muted placeholder instead.
function hasRenderablePlan(plan: any): boolean {
  return Boolean(plan && Array.isArray(plan.boundary) && plan.boundary.length >= 3);
}

// PlanSnapshot is canvas-heavy and fed arbitrary stored geometry; if a malformed plan
// throws during render, contain it to this one tile instead of blanking the whole page.
class ThumbBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ThumbPlaceholder({ label }: { label: string }) {
  return (
    <div
      style={{
        height: THUMB_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'repeating-linear-gradient(45deg,#efe9da,#efe9da 10px,#e8e1d1 10px,#e8e1d1 20px)',
        color: FAINT,
        fontFamily: IT,
        fontSize: '0.78rem',
      }}
    >
      {label}
    </div>
  );
}

function DesignThumbnail({ plan, plants }: { plan: any; plants: any[] }) {
  const wrap = (child: ReactNode) => (
    <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 12, background: '#EFE9DA' }}>
      {child}
    </div>
  );
  if (!hasRenderablePlan(plan)) return wrap(<ThumbPlaceholder label="No plan yet" />);
  return wrap(
    <ThumbBoundary fallback={<ThumbPlaceholder label="Preview unavailable" />}>
      <PlanSnapshot plan={plan} plants={plants} height={THUMB_H} showDimensions={false} />
    </ThumbBoundary>,
  );
}

export default function MyProjectsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [groups, setGroups] = useState<AddressGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      // Addresses give us the home labels (and homes with no designs yet); the
      // projects+designs query gives us every design grouped under its project.
      const [addresses, projects] = await Promise.all([listAddresses(), listProjectsWithDesigns()]);
      const byAddress = new Map<string, AddressGroup>();
      for (const a of addresses) {
        byAddress.set(a.id, { key: a.id, address: a.formatted_address, projects: [] });
      }
      for (const p of projects) {
        if (p.designs.length === 0) continue; // no designs at all → nothing to show under this yard
        let g = byAddress.get(p.address_id);
        if (!g) {
          g = { key: p.address_id, address: null, projects: [] };
          byAddress.set(p.address_id, g);
        }
        const designs: DesignItem[] = [...p.designs]
          .map((d) => ({
            id: d.id,
            name: d.name,
            updated_at: d.updated_at,
            status: d.status,
            project_id: p.id,
            plan: d.plan,
            plants: Array.isArray(d.plant_instances) ? (d.plant_instances as any[]) : [],
          }))
          .sort((x, y) => y.updated_at.localeCompare(x.updated_at));
        g.projects.push({
          id: p.id,
          yard_type: p.yard_type,
          selected_design_id: p.selected_design_id,
          designs,
        });
      }
      // Keep only addresses that actually have designs to present, ordered front→back for tidiness.
      const list = [...byAddress.values()].filter((g) => g.projects.length > 0);
      for (const g of list) {
        g.projects.sort((a, b) => a.yard_type.localeCompare(b.yard_type));
      }
      setGroups(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your designs.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function startNew() {
    clearAllDesignState();
    navigate(DIY_START);
  }

  async function open(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await loadDesign(id);
      navigate(DIY_START);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that design.');
      setBusyId(null);
    }
  }

  async function remove(d: DesignItem) {
    setMenuOpenId(null);
    if (!window.confirm('Delete this design permanently? This cannot be undone.')) return;
    setBusyId(d.id);
    try {
      await deleteDesign(d.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that design.');
    } finally {
      setBusyId(null);
    }
  }

  async function makeSelected(d: DesignItem) {
    setMenuOpenId(null);
    setBusyId(d.id);
    try {
      await setSelectedDesign(d.project_id, d.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the selected design.');
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(d: DesignItem, status: 'archived' | 'draft') {
    setMenuOpenId(null);
    setBusyId(d.id);
    try {
      await updateDesign(d.id, { status });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that design.');
    } finally {
      setBusyId(null);
    }
  }

  function beginRename(d: DesignItem) {
    setMenuOpenId(null);
    setEditingId(d.id);
    setEditingName(d.name ?? '');
  }

  async function commitRename(d: DesignItem) {
    const next = editingName.trim();
    setEditingId(null);
    if (next === (d.name ?? '').trim()) return; // unchanged
    setBusyId(d.id);
    try {
      await updateDesign(d.id, { name: next || null });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename that design.');
    } finally {
      setBusyId(null);
    }
  }

  const primaryBtn: React.CSSProperties = {
    fontFamily: IT,
    fontSize: '0.92rem',
    fontWeight: 500,
    color: BG,
    background: DARK,
    border: 'none',
    borderRadius: 999,
    padding: '13px 24px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const isEmpty = !loading && groups.length === 0;

  // Render-time archived filtering: hide archived designs unless the toggle is on,
  // and drop any project/address left with nothing visible.
  const archivedCount = groups.reduce(
    (n, g) => n + g.projects.reduce((m, p) => m + p.designs.filter((d) => d.status === 'archived').length, 0),
    0,
  );
  const visibleGroups: AddressGroup[] = groups
    .map((g) => ({
      ...g,
      projects: g.projects
        .map((p) => ({
          ...p,
          designs: showArchived ? p.designs : p.designs.filter((d) => d.status !== 'archived'),
        }))
        .filter((p) => p.designs.length > 0),
    }))
    .filter((g) => g.projects.length > 0);

  return (
    <div style={{ minHeight: '100vh', background: PAGE_BG, fontFamily: IT }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ padding: '2rem 2.5rem 0' }}>
        <Link to="/" aria-label="Home" style={{ textDecoration: 'none' }}>
          <Logo />
        </Link>
        <div className="flex items-center" style={{ gap: 18 }}>
          {user?.email && (
            <span className="hidden sm:inline" style={{ fontFamily: IT, fontSize: '0.85rem', color: FAINT }}>
              {user.email}
            </span>
          )}
          <button
            onClick={async () => {
              await signOut();
              navigate('/');
            }}
            style={{
              fontFamily: IT,
              fontSize: '0.85rem',
              fontWeight: 500,
              color: MUTED,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Title + primary CTA */}
      <div
        className="flex items-end justify-between"
        style={{ flexWrap: 'wrap', gap: 16, margin: '1.6rem 0 1.8rem', padding: '0 2.5rem' }}
      >
        <h1 style={{ fontFamily: IS, fontSize: '3.4rem', color: DARK, fontWeight: 400, lineHeight: 1.05, margin: 0 }}>
          Your designs
        </h1>
        {!loading && !isEmpty && (
          <button onClick={startNew} style={primaryBtn}>
            ＋ New design
          </button>
        )}
      </div>

      <div style={{ maxWidth: 880, margin: '0 auto', padding: '0 2.5rem 5rem' }}>
        {error && (
          <div
            style={{
              marginBottom: 18,
              borderRadius: 14,
              background: 'rgba(178,58,42,0.08)',
              color: '#9A3B2E',
              fontFamily: IT,
              fontSize: '0.88rem',
              padding: '12px 16px',
            }}
          >
            {error}
          </div>
        )}

        {/* Show-archived toggle (global) — only when there is something archived to reveal. */}
        {!loading && !isEmpty && archivedCount > 0 && (
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => setShowArchived((v) => !v)}
              style={{
                fontFamily: IT,
                fontSize: '0.82rem',
                fontWeight: 500,
                color: MUTED,
                background: 'rgba(42,42,38,0.05)',
                border: 'none',
                borderRadius: 999,
                padding: '7px 15px',
                cursor: 'pointer',
              }}
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center" style={{ gap: 12, padding: '4rem 0' }}>
            <GrowingFlower size={120} />
            <p style={{ fontFamily: IT, fontSize: '0.9rem', color: MUTED, margin: 0 }}>Loading your designs…</p>
          </div>
        ) : isEmpty ? (
          <div
            style={{
              background: 'white',
              borderRadius: 20,
              boxShadow: CARD_SHADOW,
              padding: '3rem 2rem',
              textAlign: 'center',
            }}
          >
            <div className="flex justify-center" style={{ marginBottom: 8 }}>
              <GrowingFlower size={120} />
            </div>
            <h2 style={{ fontFamily: IS, fontSize: '1.9rem', color: DARK, fontWeight: 400, margin: '0 0 8px' }}>
              You haven't designed anything yet
            </h2>
            <p style={{ fontFamily: IT, fontSize: '0.95rem', color: MUTED, margin: '0 0 22px' }}>
              Start with your address and we'll help you plan your yard.
            </p>
            <button onClick={startNew} style={primaryBtn}>
              Design a new yard
            </button>
          </div>
        ) : visibleGroups.length === 0 ? (
          <p style={{ fontFamily: IT, fontSize: '0.92rem', color: MUTED }}>
            Every design here is archived. Use “Show archived” above to see them.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
            {visibleGroups.map((g) => (
              <section key={g.key}>
                {/* Address heading */}
                <h2
                  style={{
                    fontFamily: IS,
                    fontSize: '1.7rem',
                    color: DARK,
                    fontWeight: 400,
                    lineHeight: 1.15,
                    margin: '0 0 18px',
                  }}
                >
                  {g.address ?? 'No address yet'}
                </h2>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  {g.projects.map((p) => (
                    <div key={p.id}>
                      {/* Yard-type pill */}
                      <span
                        style={{
                          display: 'inline-block',
                          fontFamily: IT,
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: GREEN,
                          background: 'rgba(47,107,79,0.1)',
                          borderRadius: 999,
                          padding: '5px 13px',
                          marginBottom: 12,
                        }}
                      >
                        {yardLabel(p.yard_type)}
                      </span>

                      {/* Designs grid */}
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                          gap: 14,
                        }}
                      >
                        {p.designs.map((d) => {
                          const selected = p.selected_design_id === d.id;
                          const archived = d.status === 'archived';
                          const busy = busyId === d.id;
                          const editing = editingId === d.id;
                          const menuOpen = menuOpenId === d.id;
                          return (
                            <div
                              key={d.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => !busy && !editing && open(d.id)}
                              onKeyDown={(e) => {
                                if ((e.key === 'Enter' || e.key === ' ') && !busy && !editing) {
                                  e.preventDefault();
                                  open(d.id);
                                }
                              }}
                              style={{
                                position: 'relative',
                                background: 'white',
                                borderRadius: 16,
                                boxShadow: CARD_SHADOW,
                                padding: 14,
                                cursor: busy || editing ? 'default' : 'pointer',
                                opacity: busy ? 0.5 : archived ? 0.62 : 1,
                                transition: 'box-shadow 0.15s ease, transform 0.15s ease',
                                display: 'flex',
                                flexDirection: 'column',
                              }}
                            >
                              {/* Thumbnail preview */}
                              <DesignThumbnail plan={d.plan} plants={d.plants} />

                              {/* Overflow menu trigger */}
                              <button
                                aria-label="Design options"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!busy) setMenuOpenId(menuOpen ? null : d.id);
                                }}
                                disabled={busy}
                                style={{
                                  position: 'absolute',
                                  top: 22,
                                  right: 22,
                                  width: 28,
                                  height: 28,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '1.05rem',
                                  lineHeight: 1,
                                  color: DARK,
                                  background: 'rgba(255,255,255,0.9)',
                                  border: 'none',
                                  borderRadius: 999,
                                  boxShadow: '0 1px 4px rgba(26,26,22,0.15)',
                                  cursor: busy ? 'default' : 'pointer',
                                }}
                              >
                                ⋯
                              </button>

                              {menuOpen && (
                                <>
                                  {/* click-away overlay */}
                                  <div
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMenuOpenId(null);
                                    }}
                                    style={{ position: 'fixed', inset: 0, zIndex: 20 }}
                                  />
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      position: 'absolute',
                                      top: 52,
                                      right: 14,
                                      zIndex: 21,
                                      minWidth: 168,
                                      background: 'white',
                                      borderRadius: 12,
                                      boxShadow: '0 8px 28px rgba(26,26,22,0.18)',
                                      padding: 6,
                                      display: 'flex',
                                      flexDirection: 'column',
                                    }}
                                  >
                                    <MenuItem label="Rename" onClick={() => beginRename(d)} />
                                    {!selected && !archived && (
                                      <MenuItem label="Make selected" onClick={() => makeSelected(d)} />
                                    )}
                                    {archived ? (
                                      <MenuItem label="Unarchive" onClick={() => setStatus(d, 'draft')} />
                                    ) : (
                                      <MenuItem label="Archive" onClick={() => setStatus(d, 'archived')} />
                                    )}
                                    <MenuItem label="Delete" danger onClick={() => remove(d)} />
                                  </div>
                                </>
                              )}

                              {/* Title + status pills */}
                              <div style={{ paddingRight: 30 }}>
                                {editing ? (
                                  <input
                                    autoFocus
                                    value={editingName}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    onBlur={() => commitRename(d)}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === 'Enter') commitRename(d);
                                      if (e.key === 'Escape') setEditingId(null);
                                    }}
                                    placeholder={designTitle(null, g.address)}
                                    style={{
                                      width: '100%',
                                      fontFamily: IT,
                                      fontSize: '1rem',
                                      fontWeight: 600,
                                      color: DARK,
                                      background: BG,
                                      border: `1px solid ${GREEN}`,
                                      borderRadius: 8,
                                      padding: '5px 8px',
                                      outline: 'none',
                                    }}
                                  />
                                ) : (
                                  <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                                    <span style={{ fontFamily: IT, fontSize: '1rem', fontWeight: 600, color: DARK }}>
                                      {designTitle(d.name, g.address)}
                                    </span>
                                    {selected && (
                                      <span
                                        style={{
                                          fontFamily: IT,
                                          fontSize: '0.66rem',
                                          fontWeight: 600,
                                          letterSpacing: '0.04em',
                                          textTransform: 'uppercase',
                                          color: BG,
                                          background: GREEN,
                                          borderRadius: 999,
                                          padding: '3px 9px',
                                        }}
                                      >
                                        Selected
                                      </span>
                                    )}
                                    {archived && (
                                      <span
                                        style={{
                                          fontFamily: IT,
                                          fontSize: '0.66rem',
                                          fontWeight: 600,
                                          letterSpacing: '0.04em',
                                          textTransform: 'uppercase',
                                          color: MUTED,
                                          background: 'rgba(42,42,38,0.08)',
                                          borderRadius: 999,
                                          padding: '3px 9px',
                                        }}
                                      >
                                        Archived
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              <p style={{ fontFamily: IT, fontSize: '0.8rem', color: FAINT, margin: '10px 0 0' }}>
                                {busy ? 'Working…' : relativeUpdated(d.updated_at)}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        textAlign: 'left',
        fontFamily: IT,
        fontSize: '0.88rem',
        fontWeight: 500,
        color: danger ? '#9A3B2E' : DARK,
        background: 'none',
        border: 'none',
        borderRadius: 8,
        padding: '9px 11px',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(42,42,38,0.05)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
    >
      {label}
    </button>
  );
}
