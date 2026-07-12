import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import AddressInput from '../features/onboarding/AddressInput';
import { clearLocalState } from '../services/projectsService';

const BG = '#efe9db';
const DARK = '#1a1a16';
const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";

/**
 * Address-capture step shown before preferences for anyone who starts a plan
 * without entering an address on the homepage. Selecting an address stores it
 * (matching the homepage handler) and continues into the DIY flow.
 */
export default function AddressPage() {
  const navigate = useNavigate();

  const handleAddressSelect = useCallback(
    (address: string, lat: number, lng: number) => {
      clearLocalState();
      localStorage.setItem('initialAddress', JSON.stringify({ address, lat, lng }));
      localStorage.setItem('siteContext', JSON.stringify({ address, lat, lng }));
      navigate('/diy/preferences');
    },
    [navigate],
  );

  return (
    <div className="min-h-screen flex flex-col pt-8" style={{ backgroundColor: BG, fontFamily: IT }}>
      {/* Header — matches the preferences flow (logo top-left) */}
      <div className="flex items-center px-10">
        <Link to="/"><Logo /></Link>
      </div>

      {/* Title — same serif scale + spacing as the preferences pages */}
      <h1 style={{ fontFamily: IS, fontSize: '4rem', color: DARK, lineHeight: 1.05, fontWeight: 400, marginTop: '1.33rem', marginBottom: '1.6rem', paddingLeft: '2.5rem' }}>
        Enter your home address to start designing
      </h1>

      <div style={{ paddingLeft: '2.5rem', paddingRight: '2.5rem', maxWidth: '560px' }}>
        <div
          className="hero-address-wrapper"
          style={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'white',
            borderRadius: '100px',
            padding: '6px 6px 6px 18px',
            boxShadow: '0 4px 28px rgba(26,26,22,0.13)',
            width: '100%',
            maxWidth: '460px',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: '8px' }}>
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="#9a9485" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AddressInput onAddressSelect={handleAddressSelect} placeholder=" " />
          </div>
        </div>
      </div>

      <style>{`
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder {
          box-shadow: none !important;
          border: none !important;
          border-radius: 0 !important;
          background: transparent !important;
          min-height: unset !important;
          width: 100% !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input {
          font-family: 'Inter Tight', sans-serif !important;
          font-size: 0.88rem !important;
          color: #1a1a16 !important;
          padding: 0 4px !important;
          height: 42px !important;
          line-height: 42px !important;
          background: transparent !important;
          min-width: 0 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder input::placeholder {
          color: #a0a090 !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-search {
          display: none !important;
        }
        .hero-address-wrapper .canopy-geocoder .mapboxgl-ctrl-geocoder--button {
          background: transparent !important;
          padding: 0 8px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions {
          border-radius: 16px !important;
          box-shadow: 0 8px 28px rgba(26,26,22,0.14) !important;
          border: 1px solid rgba(26,26,22,0.08) !important;
          overflow: hidden;
          z-index: 100;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a {
          font-family: 'Inter Tight', sans-serif !important;
          font-size: 0.86rem !important;
          color: #1a1a16 !important;
          padding: 12px 18px !important;
        }
        .hero-address-wrapper .canopy-geocoder .suggestions > .active > a,
        .hero-address-wrapper .canopy-geocoder .suggestions > li > a:hover {
          background-color: #f0ece3 !important;
          color: #1a1a16 !important;
        }
      `}</style>
    </div>
  );
}
