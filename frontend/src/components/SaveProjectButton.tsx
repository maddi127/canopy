import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getActiveProjectId, saveCurrentProject, updateProject } from '../services/projectsService';

/**
 * Floating "Save design" control shown during the DIY flow. Saves the current
 * localStorage state to the signed-in user's account — updating the active
 * project if one is loaded, otherwise creating a new one.
 */
export default function SaveProjectButton() {
  const { user } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Only relevant while designing, and only for signed-in users.
  if (!user || !location.pathname.startsWith('/diy/')) return null;

  async function handleSave() {
    setStatus('saving');
    try {
      const activeId = getActiveProjectId();
      if (activeId) {
        await updateProject(activeId);
      } else {
        const name = window.prompt('Name this design', 'My landscape design');
        if (name === null) {
          setStatus('idle');
          return;
        }
        await saveCurrentProject(name);
      }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  }

  const label =
    status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : status === 'error' ? 'Save failed' : 'Save design';

  return (
    <button
      onClick={handleSave}
      disabled={status === 'saving'}
      className="fixed bottom-5 right-5 z-50 rounded-canopy-sm bg-canopy-500 px-4 py-2.5 text-sm font-medium text-white shadow-canopy-lg transition hover:bg-canopy-600 disabled:opacity-70"
    >
      {label}
    </button>
  );
}
