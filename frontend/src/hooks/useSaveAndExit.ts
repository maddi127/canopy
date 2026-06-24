import { useNavigate } from 'react-router-dom';
import {
  getActiveProjectId,
  saveCurrentProject,
  updateProject,
  currentAddress,
} from '../services/projectsService';

/**
 * Saves the current DIY design to the signed-in user's account (creating a new
 * project, or updating the active one) and then exits to "My designs".
 * Best-effort: if the save fails it still navigates away so the user isn't stuck.
 */
export function useSaveAndExit() {
  const navigate = useNavigate();
  return async () => {
    try {
      const activeId = getActiveProjectId();
      if (activeId) await updateProject(activeId);
      else await saveCurrentProject(currentAddress() ?? 'My design');
    } catch (err) {
      console.error('Save & exit failed:', err);
    }
    navigate('/projects');
  };
}
