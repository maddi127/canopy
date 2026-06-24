import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import {
  listProjectsWithAddress,
  loadProject,
  deleteProject,
  clearLocalState,
  type ProjectWithAddress,
} from '../services/projectsService';

const DIY_START = '/diy/preferences';
const NO_ADDRESS = '__none__';

interface HomeGroup {
  key: string;
  address: string | null;
  projects: ProjectWithAddress[];
}

export default function MyProjectsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectWithAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedHome, setSelectedHome] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjectsWithAddress());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your designs.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Group projects under each home, ordered by most-recent activity.
  const homes = useMemo<HomeGroup[]>(() => {
    const byKey = new Map<string, HomeGroup>();
    const order: HomeGroup[] = [];
    for (const p of projects) {
      const key = p.address_id ?? NO_ADDRESS;
      let g = byKey.get(key);
      if (!g) {
        g = { key, address: p.address, projects: [] };
        byKey.set(key, g);
        order.push(g);
      }
      g.projects.push(p);
    }
    return order;
  }, [projects]);

  const current = homes.find((h) => h.key === selectedHome) ?? null;

  function startNew() {
    clearLocalState();
    navigate(DIY_START);
  }

  async function open(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await loadProject(id);
      navigate(DIY_START);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that design.');
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this design? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await deleteProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that design.');
    } finally {
      setBusyId(null);
    }
  }

  // If the open home has no projects left after a delete, return to the list.
  useEffect(() => {
    if (selectedHome && !homes.some((h) => h.key === selectedHome)) setSelectedHome(null);
  }, [homes, selectedHome]);

  return (
    <div className="min-h-screen bg-soil-100">
      <header className="flex items-center justify-between px-6 py-4 border-b border-soil-300/60 bg-white">
        <Logo />
        <div className="flex items-center gap-4">
          <span className="hidden sm:inline text-sm text-soil-500">{user?.email}</span>
          <button
            onClick={async () => {
              await signOut();
              navigate('/');
            }}
            className="text-sm font-medium text-soil-700 hover:text-soil-900"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {error && (
          <div className="mb-4 rounded-canopy-sm bg-error/10 px-4 py-3 text-sm text-error">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-canopy-500 border-t-transparent" />
          </div>
        ) : current ? (
          /* ── Level 2: projects for one home ───────────────────────────── */
          <>
            <button
              onClick={() => setSelectedHome(null)}
              className="mb-4 text-sm font-medium text-canopy-600 hover:underline"
            >
              ← All homes
            </button>
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-semibold text-soil-900">
                {current.address ?? 'No address yet'}
              </h1>
              <button
                onClick={startNew}
                className="rounded-canopy-sm bg-canopy-500 px-4 py-2.5 font-medium text-white transition hover:bg-canopy-600"
              >
                + New design
              </button>
            </div>
            <ul className="space-y-3">
              {current.projects.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-canopy bg-white px-5 py-4 shadow-canopy"
                >
                  <button onClick={() => open(p.id)} className="text-left flex-1 min-w-0" disabled={busyId === p.id}>
                    <p className="font-medium text-soil-900 truncate">{p.name}</p>
                    <p className="text-sm text-soil-500">updated {new Date(p.updated_at).toLocaleDateString()}</p>
                  </button>
                  <div className="flex items-center gap-3 pl-4">
                    <button
                      onClick={() => open(p.id)}
                      disabled={busyId === p.id}
                      className="rounded-canopy-sm border border-canopy-500 px-3 py-1.5 text-sm font-medium text-canopy-600 hover:bg-canopy-100 disabled:opacity-60"
                    >
                      {busyId === p.id ? 'Opening…' : 'Open'}
                    </button>
                    <button
                      onClick={() => remove(p.id)}
                      disabled={busyId === p.id}
                      className="text-sm text-soil-500 hover:text-error disabled:opacity-60"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          /* ── Level 1: homes ───────────────────────────────────────────── */
          <>
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-semibold text-soil-900">My homes</h1>
              <button
                onClick={startNew}
                className="rounded-canopy-sm bg-canopy-500 px-4 py-2.5 font-medium text-white transition hover:bg-canopy-600"
              >
                + New design
              </button>
            </div>

            {homes.length === 0 ? (
              <div className="rounded-canopy bg-white p-10 text-center shadow-canopy">
                <p className="text-soil-700 mb-4">You haven’t saved any designs yet.</p>
                <button
                  onClick={startNew}
                  className="rounded-canopy-sm bg-canopy-500 px-4 py-2.5 font-medium text-white transition hover:bg-canopy-600"
                >
                  Start your first design
                </button>
              </div>
            ) : (
              <ul className="space-y-3">
                {homes.map((h) => (
                  <li key={h.key}>
                    <button
                      onClick={() => setSelectedHome(h.key)}
                      className="flex w-full items-center justify-between rounded-canopy bg-white px-5 py-4 text-left shadow-canopy transition hover:shadow-canopy-lg"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-soil-900 truncate">
                          {h.address ?? 'No address yet'}
                        </p>
                        <p className="text-sm text-soil-500">
                          {h.projects.length} {h.projects.length === 1 ? 'design' : 'designs'}
                        </p>
                      </div>
                      <span className="pl-4 text-soil-300 text-xl">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}
