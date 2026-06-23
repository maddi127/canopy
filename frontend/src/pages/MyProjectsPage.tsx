import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import {
  listProjects,
  loadProject,
  deleteProject,
  clearLocalState,
  type ProjectSummary,
} from '../services/projectsService';

const DIY_START = '/diy/preferences';

export default function MyProjectsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your projects.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

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
      setError(err instanceof Error ? err.message : 'Could not open that project.');
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await deleteProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that project.');
    } finally {
      setBusyId(null);
    }
  }

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
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-soil-900">My designs</h1>
          <button
            onClick={startNew}
            className="rounded-canopy-sm bg-canopy-500 px-4 py-2.5 font-medium text-white transition hover:bg-canopy-600"
          >
            + New design
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-canopy-sm bg-error/10 px-4 py-3 text-sm text-error">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-canopy-500 border-t-transparent" />
          </div>
        ) : projects.length === 0 ? (
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
            {projects.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-canopy bg-white px-5 py-4 shadow-canopy"
              >
                <button onClick={() => open(p.id)} className="text-left flex-1 min-w-0" disabled={busyId === p.id}>
                  <p className="font-medium text-soil-900 truncate">{p.name}</p>
                  <p className="text-sm text-soil-500 truncate">
                    {p.address ?? 'No address'} · updated{' '}
                    {new Date(p.updated_at).toLocaleDateString()}
                  </p>
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
        )}
      </main>
    </div>
  );
}
