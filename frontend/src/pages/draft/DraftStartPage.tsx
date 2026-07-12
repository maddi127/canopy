// Draft flow S1 — address in, nothing else. One field, one promise.
import { useNavigate } from 'react-router-dom';
import Logo from '../../components/Logo';
import AddressInput from '../../features/onboarding/AddressInput';

const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

export default function DraftStartPage() {
  const navigate = useNavigate();

  const handleAddressSelect = (address: string, lat: number, lng: number) => {
    try {
      const existing = (() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } })();
      localStorage.setItem('siteContext', JSON.stringify({ ...existing, address, lat, lng }));
      // A new address invalidates any prior draft state.
      ['diyBoundaryFinal', 'diyPlacementPlan', 'diyPlacementPlanOriginal', 'diyPlacementPlanSig', 'diySunMap', 'diyDoorPoint', 'diyPlantInstances', 'diyDetailsSuggested'].forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    navigate('/draft/scan');
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#efe9db' }}>
      <div className="px-10 pt-8"><Logo /></div>
      <div className="flex-1 flex flex-col items-center justify-center px-6" style={{ marginTop: '-6vh' }}>
        <h1 style={{ fontFamily: IS, fontSize: 'clamp(2.4rem, 5vw, 3.6rem)', color: '#2A2A26', fontWeight: 400, lineHeight: 1.08, textAlign: 'center', margin: 0 }}>
          See what your yard<br />could be.
        </h1>
        <p style={{ fontFamily: IT, fontSize: '1rem', color: '#6A6A60', margin: '16px 0 28px', textAlign: 'center', maxWidth: 440, lineHeight: 1.55 }}>
          Type your address and we'll draft a full landscape plan — features, materials, and plants — in about a minute.
        </p>
        <div style={{ width: 'min(480px, 90vw)' }}>
          <AddressInput onAddressSelect={handleAddressSelect} />
        </div>
        <p style={{ fontFamily: IT, fontSize: '0.75rem', color: '#A8A89C', marginTop: 18 }}>
          No account needed to see your draft.
        </p>
      </div>
    </div>
  );
}
