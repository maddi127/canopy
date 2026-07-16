import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import Logo from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { addressExists, currentAddress } from '../services/projectsService';
import { collectActiveDesign } from '../services/designPayload';
import { getActiveDesignId, saveActiveDesign } from '../services/activeDesign';
import { IS, IT, INK, INK_SOFT, GREEN, PAGE_BG, CARD_BG, RADIUS, RADIUS_SM, SHADOW_LG, ctaPrimary } from '../lib/theme';

type Mode = 'signin' | 'signup';

/**
 * Re-introduced-auth moment: an anonymous user built a draft (address + boundary/
 * plan) entirely in localStorage, then authenticated from the flow. Turn that
 * local draft into address → project → design rows.
 *
 * Adopt ONLY when there's a real draft (collectActiveDesign is non-null) AND it
 * hasn't already been adopted (no active design id). A plain homepage sign-in with
 * no draft skips. Best-effort: a failed save never traps the user on this page —
 * we log and let the redirect proceed.
 */
async function adoptDraftIfAny(): Promise<void> {
  try {
    if (collectActiveDesign() !== null && getActiveDesignId() === null) {
      await saveActiveDesign();
    }
  } catch (err) {
    console.warn('Draft adoption failed after auth; continuing without saving.', err);
  }
}

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/projects';

  // Default to sign-up; if the address we're working on is already in the DB,
  // it's likely a returning user, so flip to sign-in.
  const [mode, setMode] = useState<Mode>('signup');

  useEffect(() => {
    const addr = currentAddress();
    if (!addr) return;
    let active = true;
    addressExists(addr).then((exists) => {
      if (active && exists) setMode('signin');
    });
    return () => {
      active = false;
    };
  }, []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        await adoptDraftIfAny();
        navigate(redirectTo, { replace: true });
      } else {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) {
          // No session yet (email confirmation on) — nothing to adopt against;
          // adoption happens on the subsequent confirmed sign-in.
          setNotice('Check your email to confirm your account, then sign in.');
          setMode('signin');
        } else {
          await adoptDraftIfAny();
          navigate(redirectTo, { replace: true });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const labelStyle: React.CSSProperties = { fontFamily: IT, fontSize: '0.78rem', fontWeight: 600, color: INK_SOFT, marginBottom: 6, display: 'block' };
  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: IT, fontSize: '0.95rem', color: INK, background: '#FFFFFF',
    border: '1.5px solid rgba(42,42,38,0.16)', borderRadius: RADIUS_SM, padding: '0.7rem 0.9rem', outline: 'none',
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ background: PAGE_BG }}>
      <style>{`.auth-input:focus{border-color:${GREEN};box-shadow:0 0 0 3px ${GREEN}22;}`}</style>

      <Link to="/" style={{ marginBottom: '2rem' }}>
        <Logo />
      </Link>

      <div style={{ width: '100%', maxWidth: 420, background: CARD_BG, borderRadius: RADIUS, boxShadow: SHADOW_LG, padding: '2.5rem' }}>
        <h1 style={{ fontFamily: IS, fontSize: '2.4rem', fontWeight: 400, color: INK, lineHeight: 1.1, margin: 0 }}>
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p style={{ fontFamily: IT, fontSize: '0.95rem', color: INK_SOFT, margin: '0.6rem 0 1.6rem', lineHeight: 1.5 }}>
          {mode === 'signin'
            ? 'Sign in to access your saved designs.'
            : 'Sign up to save and revisit your landscape designs.'}
        </p>

        {!isSupabaseConfigured && (
          <div style={{ marginBottom: '1rem', borderRadius: RADIUS_SM, background: 'rgba(232,162,60,0.12)', padding: '0.75rem 1rem', fontFamily: IT, fontSize: '0.85rem', color: '#9A6A2A', lineHeight: 1.5 }}>
            Supabase isn’t configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: '1rem' }}>
          <div>
            <label htmlFor="email" style={labelStyle}>Email</label>
            <input id="email" className="auth-input" type="email" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} />
          </div>

          <div>
            <label htmlFor="password" style={labelStyle}>Password</label>
            <input id="password" className="auth-input" type="password" required minLength={6}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={inputStyle} />
          </div>

          {error && <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#D65C5C', margin: 0 }}>{error}</p>}
          {notice && <p style={{ fontFamily: IT, fontSize: '0.85rem', color: GREEN, margin: 0 }}>{notice}</p>}

          <button type="submit" disabled={busy} className="transition-all hover:opacity-90"
            style={{ ...ctaPrimary, width: '100%', marginTop: '0.25rem', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p style={{ fontFamily: IT, fontSize: '0.85rem', color: INK_SOFT, textAlign: 'center', margin: '1.5rem 0 0' }}>
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: IT, fontSize: '0.85rem', fontWeight: 600, color: GREEN }}>
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
