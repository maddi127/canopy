import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Logo from '../components/Logo';
import AddressInput from '../features/onboarding/AddressInput';

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
      localStorage.setItem('initialAddress', JSON.stringify({ address, lat, lng }));
      localStorage.setItem('siteContext', JSON.stringify({ address, lat, lng }));
      localStorage.removeItem('generatedConcept');
      localStorage.removeItem('conceptFeatures');
      navigate('/diy/preferences');
    },
    [navigate],
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: BG,
        fontFamily: IT,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <Link to="/" style={{ marginBottom: '40px' }}>
        <Logo />
      </Link>

      <h1
        style={{
          fontFamily: IS,
          fontSize: 'clamp(2.2rem, 4vw, 3.2rem)',
          color: DARK,
          lineHeight: 1.1,
          fontWeight: 400,
          textAlign: 'center',
          margin: '0 0 28px',
        }}
      >
        Where are we planting?
      </h1>

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
          <AddressInput onAddressSelect={handleAddressSelect} />
        </div>
      </div>

      <p style={{ fontFamily: IT, fontSize: '0.85rem', color: '#8a8a7a', marginTop: '16px' }}>
        Select your address to continue.
      </p>

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
