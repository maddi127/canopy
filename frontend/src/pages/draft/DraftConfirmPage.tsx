// Draft flow S3 — "Is this your project area?" One tap confirms the AI-proposed boundary; Adjust
// turns on vertex editing (Google's built-in polygon editor). Detected features are toggleable
// chips; the guessed entry is movable. Confirming persists diyBoundaryFinal → the draft generates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Polygon, OverlayView } from '@react-google-maps/api';
import Logo from '../../components/Logo';
import { proposeBoundary } from '../../services/boundaryProposer';
import type { ConfirmedFeature } from '../DiyFeatureConfirmPage';

const IS = "'Instrument Serif', serif";
const IT = "'Inter Tight', sans-serif";
const GOOGLE_MAPS_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY ?? '';
const FEATURE_COLOR: Record<string, string> = { house: '#C98A3A', tree: '#2F6B4F', hardscape: '#B9B2A4', structure: '#8A7B9A' };

export default function DraftConfirmPage() {
  const navigate = useNavigate();
  const { isLoaded } = useJsApiLoader({ id: 'google-map-script', googleMapsApiKey: GOOGLE_MAPS_KEY });

  const sc = useMemo(() => { try { return JSON.parse(localStorage.getItem('siteContext') || '{}'); } catch { return {}; } }, []);
  const box = useMemo<[number, number][]>(() => { try { return JSON.parse(localStorage.getItem('draftDetectionBox') || '[]'); } catch { return []; } }, []);
  const [features, setFeatures] = useState<ConfirmedFeature[]>(() => { try { return JSON.parse(localStorage.getItem('draftDetections') || '[]'); } catch { return []; } });

  const proposal = useMemo(() => (box.length >= 3 ? proposeBoundary(box, features, sc.yard_type || 'front') : null),
    // Propose ONCE from the initial detections — feature toggles shouldn't wobble the boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [box]);

  const [boundary, setBoundary] = useState<[number, number][] | null>(proposal?.boundary ?? null);
  const [doorPoint, setDoorPoint] = useState<[number, number] | null>(proposal?.doorPoint ?? null);
  const [adjusting, setAdjusting] = useState(false);
  const [movingDoor, setMovingDoor] = useState(false);
  const polyRef = useRef<google.maps.Polygon | null>(null);

  useEffect(() => { if (proposal) { setBoundary(proposal.boundary); setDoorPoint(proposal.doorPoint); } }, [proposal]);

  const center = useMemo<google.maps.LatLngLiteral>(() => {
    if (boundary?.length) return { lat: boundary.reduce((s, v) => s + v[1], 0) / boundary.length, lng: boundary.reduce((s, v) => s + v[0], 0) / boundary.length };
    if (typeof sc.lat === 'number') return { lat: sc.lat, lng: sc.lng };
    return { lat: 39.74, lng: -104.99 };
  }, [boundary, sc]);

  const readPolygon = useCallback((): [number, number][] | null => {
    const poly = polyRef.current; if (!poly) return boundary;
    const path = poly.getPath();
    const out: [number, number][] = [];
    for (let i = 0; i < path.getLength(); i++) { const p = path.getAt(i); out.push([p.lng(), p.lat()]); }
    return out.length >= 3 ? out : boundary;
  }, [boundary]);

  const toggleFeature = (id: string) => setFeatures(prev => prev.map(f => f.id === id ? { ...f, keep: !f.keep } : f));

  const confirm = () => {
    const finalBoundary = adjusting ? readPolygon() : boundary;
    if (!finalBoundary || finalBoundary.length < 3) return;
    try {
      localStorage.setItem('diyBoundaryFinal', JSON.stringify({
        boundary: finalBoundary,
        confirmedFeatures: features.filter(f => f.keep),
        doorPoint,
      }));
      if (doorPoint) localStorage.setItem('diyDoorPoint', JSON.stringify(doorPoint)); else localStorage.removeItem('diyDoorPoint');
    } catch { /* ignore */ }
    navigate('/draft/plan');
  };

  const onMapClick = (e: google.maps.MapMouseEvent) => {
    if (movingDoor && e.latLng) { setDoorPoint([e.latLng.lng(), e.latLng.lat()]); setMovingDoor(false); }
  };

  // No house detected → we can't propose responsibly; hand off to the classic draw flow.
  if (!proposal) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6" style={{ backgroundColor: '#efe9db' }}>
        <Logo />
        <h1 style={{ fontFamily: IS, fontSize: '2rem', color: '#2A2A26', fontWeight: 400, textAlign: 'center' }}>We couldn't read your yard automatically</h1>
        <p style={{ fontFamily: IT, fontSize: '0.95rem', color: '#6A6A60', maxWidth: 460, textAlign: 'center', lineHeight: 1.55 }}>
          The scan didn't find a house to anchor on. You can outline your project area by hand instead — it takes about a minute.
        </p>
        <button onClick={() => navigate('/diy/boundary')}
          className="px-7 py-3 rounded-full transition-all hover:opacity-90"
          style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.9rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
          Draw it myself →
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex" style={{ backgroundColor: '#F4F0E6', overflow: 'hidden' }}>
      {/* Left panel */}
      <div className="flex flex-col" style={{ width: 'min(420px, 38vw)', flexShrink: 0 }}>
        <div className="px-8 pt-7 pb-4"><Logo /></div>
        <div className="px-8 flex-1 overflow-y-auto">
          <h1 style={{ fontFamily: IS, fontSize: '1.9rem', color: '#2A2A26', fontWeight: 400, lineHeight: 1.1, margin: '4px 0 10px' }}>
            Is this your project area?
          </h1>
          <p style={{ fontFamily: IT, fontSize: '0.9rem', color: '#6A6A60', lineHeight: 1.55, margin: '0 0 18px' }}>
            We outlined the {sc.yard_type === 'back' ? 'back' : 'front'} yard from your scan{adjusting ? ' — drag the corners to fix it' : ''}. We also found these — tap any that are wrong:
          </p>

          <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 18 }}>
            {features.map(f => (
              <button key={f.id} onClick={() => toggleFeature(f.id)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all hover:opacity-85"
                style={{ fontFamily: IT, fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer', background: f.keep ? 'white' : 'rgba(42,42,38,0.05)', color: f.keep ? '#2A2A26' : '#9A9A92', border: '1.5px solid rgba(42,42,38,0.14)', textDecoration: f.keep ? 'none' : 'line-through' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: FEATURE_COLOR[f.type] ?? '#9A9A92', opacity: f.keep ? 1 : 0.4 }} />
                {f.label || f.type}
              </button>
            ))}
            {features.length === 0 && <span style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92' }}>No features detected — you can add them later in the editor.</span>}
          </div>

          <div className="flex flex-col gap-2" style={{ marginBottom: 18 }}>
            <button onClick={() => setAdjusting(a => !a)}
              className="py-2.5 rounded-full transition-all hover:opacity-90"
              style={{ background: adjusting ? '#2A2A26' : 'white', color: adjusting ? '#efe9db' : '#2A2A26', fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
              {adjusting ? 'Done adjusting' : 'Adjust the area'}
            </button>
            <button onClick={() => setMovingDoor(m => !m)}
              className="py-2.5 rounded-full transition-all hover:opacity-90"
              style={{ background: movingDoor ? '#F5C518' : 'white', color: '#2A2A26', fontFamily: IT, fontSize: '0.84rem', fontWeight: 500, border: '1.5px solid rgba(42,42,38,0.16)', cursor: 'pointer' }}>
              {movingDoor ? 'Click the map to place the entry…' : 'Move the main entry'}
            </button>
          </div>
        </div>

        <div className="px-8 pb-7 pt-3" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
          <button onClick={confirm}
            className="w-full py-3.5 rounded-full transition-all hover:opacity-90"
            style={{ background: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.95rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
            ✓ Yes, that's it — draft my plan
          </button>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1">
        {isLoaded && (
          <GoogleMap mapContainerStyle={{ width: '100%', height: '100%' }} center={center} zoom={20}
            onClick={onMapClick}
            options={{ mapTypeId: 'satellite', tilt: 0, disableDefaultUI: true, gestureHandling: 'greedy' }}>
            {features.filter(f => f.keep && f.vertices?.length >= 3).map(f => (
              <Polygon key={f.id}
                paths={f.vertices.map(([lng, lat]) => ({ lat, lng }))}
                options={{ fillColor: FEATURE_COLOR[f.type] ?? '#9A9A92', fillOpacity: 0.18, strokeColor: FEATURE_COLOR[f.type] ?? '#9A9A92', strokeWeight: 2, clickable: false }} />
            ))}
            {boundary && (
              <Polygon
                onLoad={p => { polyRef.current = p; }}
                paths={boundary.map(([lng, lat]) => ({ lat, lng }))}
                editable={adjusting}
                options={{ fillColor: '#2F6B4F', fillOpacity: 0.16, strokeColor: '#3ddc84', strokeWeight: 3, clickable: false, zIndex: 5 }} />
            )}
            {doorPoint && (
              <OverlayView position={{ lat: doorPoint[1], lng: doorPoint[0] }} mapPaneName={OverlayView.OVERLAY_LAYER}
                getPixelPositionOffset={() => ({ x: 0, y: 0 })}>
                <div style={{ transform: 'translate(-50%,-50%)', width: 20, height: 20, borderRadius: '50%', background: '#F5C518', border: '2.5px solid white', boxShadow: '0 1px 5px rgba(0,0,0,0.35)' }} />
              </OverlayView>
            )}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}
