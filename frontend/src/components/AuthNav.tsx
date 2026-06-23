import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/** Lightweight top-right auth affordance, shown on the landing page. */
export default function AuthNav() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Only on the landing page; other screens have their own headers.
  if (location.pathname !== '/' || loading) return null;

  return (
    <div className="fixed top-4 right-5 z-50">
      {user ? (
        <Link
          to="/projects"
          className="rounded-canopy-sm bg-white/80 px-4 py-2 text-sm font-medium text-canopy-600 shadow-canopy backdrop-blur hover:bg-white"
        >
          My designs
        </Link>
      ) : (
        <Link
          to="/auth"
          className="rounded-canopy-sm bg-white/80 px-4 py-2 text-sm font-medium text-canopy-600 shadow-canopy backdrop-blur hover:bg-white"
        >
          Sign in
        </Link>
      )}
    </div>
  );
}
