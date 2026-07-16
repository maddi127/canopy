import { useNavigate } from 'react-router-dom';
import { saveActiveDesign } from '../services/activeDesign';
import { currentAddress } from '../services/designPayload';

/**
 * Saves the current DIY design to the signed-in user's account (updating the
 * active design, or creating one) and then exits to "My designs".
 * Best-effort: if the save fails it still navigates away so the user isn't stuck.
 */
export function useSaveAndExit() {
  const navigate = useNavigate();
  return async () => {
    try {
      await saveActiveDesign(currentAddress() ?? 'My design');
    } catch (err) {
      console.error('Save & exit failed:', err);
    }
    navigate('/projects');
  };
}
