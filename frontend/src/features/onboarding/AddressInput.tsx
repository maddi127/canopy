import { useRef, useEffect } from 'react';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';

interface AddressInputProps {
  onAddressSelect: (address: string, lat: number, lng: number) => void;
  placeholder?: string;
}

export default function AddressInput({ onAddressSelect, placeholder = 'Enter your home address to start designing' }: AddressInputProps) {
  const geocoderContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!geocoderContainerRef.current || !MAPBOX_TOKEN) return;

    const geocoder = new MapboxGeocoder({
      accessToken: MAPBOX_TOKEN,
      placeholder,
      countries: 'us',
    });

    geocoder.on('result', (e) => {
      console.log('Geocoder result:', e.result);
      const { center, place_name } = e.result;
      console.log('Calling onAddressSelect with:', place_name, center[1], center[0]);
      onAddressSelect(place_name, center[1], center[0]);
    });

    geocoderContainerRef.current.appendChild(geocoder.onAdd());

    return () => {
      geocoder.onRemove();
    };
  }, [onAddressSelect, placeholder]);

  return (
    <div>
      <div ref={geocoderContainerRef} className="canopy-geocoder"></div>

      <style>{`
        .canopy-geocoder .mapboxgl-ctrl-geocoder {
          max-width: 100%;
          width: 100%;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          border-radius: 12px;
          border: 2px solid #E5E7EB;
          font-size: 18px;
          min-height: 60px;
        }
        
        .canopy-geocoder .mapboxgl-ctrl-geocoder input {
          font-family: 'Outfit', sans-serif;
          color: #1F2937;
          padding: 0 24px;
          font-size: 18px;
          height: 60px;
          line-height: 60px;
        }
        
        .canopy-geocoder .mapboxgl-ctrl-geocoder input::placeholder {
          color: #9CA3AF;
        }
        
        .canopy-geocoder .mapboxgl-ctrl-geocoder input:focus {
          outline: none;
          border-color: #2F6B4F;
        }
        
        /* Hide the magnifying glass icon */
        .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-search {
          display: none;
        }
        
        /* Hide the loading spinner */
        .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-loading {
          display: none;
        }
        
        /* Style the clear button */
        .canopy-geocoder .mapboxgl-ctrl-geocoder--button {
          background-color: transparent;
          padding: 0 24px;
        }
        
        .canopy-geocoder .mapboxgl-ctrl-geocoder--icon-close {
          fill: #6B7280;
          width: 20px;
          height: 20px;
        }
        
        /* Suggestions dropdown */
        .canopy-geocoder .suggestions-wrapper {
          margin-top: 8px;
        }
        
        .canopy-geocoder .suggestions {
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
          border: 1px solid #E5E7EB;
        }
        
        .canopy-geocoder .suggestions > li > a {
          padding: 14px 20px;
          font-family: 'Outfit', sans-serif;
          font-size: 16px;
          color: #1F2937;
        }
        
        .canopy-geocoder .suggestions > .active > a {
          background-color: #E7F2EC;
          color: #2F6B4F;
        }
      `}</style>
    </div>
  );
}