import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MapGL, { Source, Layer, NavigationControl, type MapRef } from 'react-map-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import Logo from '../components/Logo';
import { PLANTS, type Plant } from '../features/planting/plantDatabase';
import { curatePalettes, STYLE_CAPS, type ZonePalette, type ZoneInput } from '../features/planting/paletteCurator';
import { placePlantingBed, placeTreeZone, instancesToGeoJSON } from '../features/planting/geometricPlacement';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
const IT = "'Inter Tight', sans-serif";
const IS = "'Instrument Serif', serif";

// ── Plant type grouping ────────────────────────────────────────────────────────

const PLANT_TYPE_ORDER: Plant['type'][] = ['tree', 'large_shrub', 'foundation_shrub', 'perimeter_shrub', 'filler'];

const PLANT_TYPE_LABELS: Record<Plant['type'], string> = {
  tree:             'Trees',
  large_shrub:      'Large Shrubs',
  foundation_shrub: 'Foundation Shrubs',
  perimeter_shrub:  'Perimeter Shrubs',
  filler:           'Groundcovers & Fillers',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// Golden-angle hue spacing for perceptually distinct per-plant colors
function plantColor(index: number): string {
  const hue = (index * 137.508) % 360;
  const sat = 58 + (index % 3) * 8;
  const lit = 44 + (index % 2) * 9;
  return `hsl(${Math.round(hue)}, ${sat}%, ${lit}%)`;
}

function getSimilarPlants(plant: Plant, currentIds: string[], zone: number): Plant[] {
  return PLANTS
    .filter(p => p.type === plant.type && p.id !== plant.id && !currentIds.includes(p.id) && p.min_zone <= zone && p.max_zone >= zone)
    .slice(0, 3);
}

// ── Curated lists ──────────────────────────────────────────────────────────────

const CURATED_LISTS = [
  { id: 'low_maint',  label: 'Low-maintenance',   filter: (p: Plant) => p.priorities.includes('low_maintenance') },
  { id: 'pollinator', label: 'Pollinator',         filter: (p: Plant) => p.priorities.includes('pollinator') },
  { id: 'cottage',    label: 'Cottage garden',     filter: (p: Plant) => p.styles.includes('natural_wild') },
  { id: 'desert',     label: 'Desert & drought',   filter: (p: Plant) => p.styles.includes('desert_minimal') },
  { id: 'modern',     label: 'Modern & structural', filter: (p: Plant) => p.styles.includes('modern_structured') },
  { id: 'low_water',  label: 'Low water',          filter: (p: Plant) => p.priorities.includes('low_water') },
];

// ── Main component ─────────────────────────────────────────────────────────────

type PanelTab = 'plan' | 'catalog';

export default function DiyRefinePage() {
  const navigate = useNavigate();
  const mapRef   = useRef<MapRef>(null);

  const sc    = (() => { try { return JSON.parse(localStorage.getItem('siteContext')     || '{}'); } catch { return {}; } })();
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } })();
  const zone  = sc.usda_zone ?? 6;
  const style = prefs.style ?? 'traditional';

  // ── Boundary / zones from DiyBoundaryPage ─────────────────────────────────
  const { boundaryVerts, featureZones } = useMemo(() => {
    try {
      const bd = JSON.parse(localStorage.getItem('diyBoundary') || '{}');
      return {
        boundaryVerts: (bd.ring ?? []) as [number, number][],
        featureZones:  (bd.featureZones ?? []) as { id: string; toolId: string; label: string; color: string; vertices: [number,number][]; existing?: boolean }[],
      };
    } catch { return { boundaryVerts: [], featureZones: [] }; }
  }, []);

  // ── Sun model from DiyBoundaryPage ────────────────────────────────────────
  type SunCellData = { lng: number; lat: number; hoursPerDay: number };
  type PlantSun = 'full_sun' | 'part_shade' | 'full_shade' | 'adaptable';
  const sunCells = useMemo((): SunCellData[] => {
    try { return (JSON.parse(localStorage.getItem('diySunModel') || 'null') as any)?.cells ?? []; } catch { return []; }
  }, []);

  const sunForZone = useCallback((verts: [number, number][]): PlantSun => {
    if (sunCells.length === 0 || verts.length < 3) return 'adaptable';
    let total = 0, count = 0;
    for (const cell of sunCells) {
      // ray-casting pip
      let inside = false;
      for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const [xi, yi] = verts[i]; const [xj, yj] = verts[j];
        if ((yi > cell.lat) !== (yj > cell.lat) && cell.lng < ((xj - xi) * (cell.lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      if (inside) { total += cell.hoursPerDay; count++; }
    }
    if (count === 0) return 'adaptable';
    const avg = total / count;
    if (avg >= 6) return 'full_sun';
    if (avg >= 2) return 'part_shade';
    return 'full_shade';
  }, [sunCells]);

  const mapCenter = useMemo((): [number, number] => {
    if (boundaryVerts.length >= 2) {
      try {
        const bbox = turf.bbox(turf.lineString(boundaryVerts));
        return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      } catch {}
    }
    return [sc.lng ?? -104.99, sc.lat ?? 39.74];
  }, [boundaryVerts, sc]);

  // ── Plant includes/excludes (user overrides) ──────────────────────────────
  const [plantIncludes, setPlantIncludes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('diyPlantIncludes') || '[]'); } catch { return []; }
  });
  const [plantExcludes, setPlantExcludes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('diyPlantExcludes') || '[]'); } catch { return []; }
  });

  // ── Palette curation (Phase 2) ─────────────────────────────────────────────
  const [palettes,  setPalettes]  = useState<ZonePalette[]>([]);
  const [curating,  setCurating]  = useState(false);

  // ZoneInputs derived from featureZones, with sun classification from sun model
  const zoneInputs = useMemo((): ZoneInput[] => {
    return featureZones
      .filter(z => (z.toolId === 'planting_bed' || (z.toolId === 'tree' && z.existing === false)) && z.vertices.length >= 3)
      .map(z => {
        const poly = turf.polygon([[...z.vertices, z.vertices[0]]]);
        const areaSqFt = turf.area(poly) * 10.7639;
        return { zoneId: z.id ?? z.label, role: z.toolId as ZoneInput['role'], areaSqFt, sun: sunForZone(z.vertices) };
      });
  }, [featureZones, sunForZone]);

  useEffect(() => {
    if (zoneInputs.length === 0) return;
    setCurating(true);
    const prefs2 = (() => { try { return JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch { return {}; } })();
    curatePalettes({
      zones: zoneInputs,
      allPlants: PLANTS,
      usdaZone: zone,
      style,
      priorities: prefs2.goal_priority ?? [],
      includes: plantIncludes,
      excludes: plantExcludes,
    }).then(result => {
      setPalettes(result);
      setCurating(false);
    });
  }, [zoneInputs, zone, style, plantIncludes, plantExcludes]); // eslint-disable-line react-hooks/exhaustive-deps

  // allCurrentPlants — plants that appear in any palette (for the sidebar list)
  const allCurrentPlants = useMemo(() => {
    const seen = new Map<string, { plant: Plant; mine: boolean }>();
    for (const p of palettes) {
      for (const s of p.selections) {
        if (seen.has(s.plantId)) continue;
        const plant = PLANTS.find(pl => pl.id === s.plantId);
        if (plant) seen.set(s.plantId, { plant, mine: plantIncludes.includes(s.plantId) });
      }
    }
    // Also include any user-added plants not yet in a palette
    for (const id of plantIncludes) {
      if (!seen.has(id)) {
        const plant = PLANTS.find(pl => pl.id === id);
        if (plant) seen.set(id, { plant, mine: true });
      }
    }
    return [...seen.values()];
  }, [palettes, plantIncludes]);

  const addPlant = (id: string) => {
    setPlantIncludes(prev => {
      const next = prev.includes(id) ? prev : [...prev, id];
      localStorage.setItem('diyPlantIncludes', JSON.stringify(next));
      return next;
    });
    setPlantExcludes(prev => {
      const next = prev.filter(x => x !== id);
      localStorage.setItem('diyPlantExcludes', JSON.stringify(next));
      return next;
    });
  };

  const removePlant = (id: string) => {
    setPlantIncludes(prev => { const n = prev.filter(x => x !== id); localStorage.setItem('diyPlantIncludes', JSON.stringify(n)); return n; });
    setPlantExcludes(prev => { const n = prev.includes(id) ? prev : [...prev, id]; localStorage.setItem('diyPlantExcludes', JSON.stringify(n)); return n; });
  };

  // ── UI state ───────────────────────────────────────────────────────────────
  const [tab,              setTab]            = useState<PanelTab>('plan');
  const [plantSearch,      setPlantSearch]    = useState('');
  const [expandedId,       setExpandedId]     = useState<string | null>(null);
  const [highlightedId,    setHighlightedId]  = useState<string | null>(null);
  const [debugZones,       setDebugZones]     = useState(false);
  const [catalogSearch,    setCatalogSearch]  = useState('');
  const [catalogFilter,    setCatalogFilter]  = useState('all');
  const [catalogList,      setCatalogList]    = useState<string | null>(null);

  // ── GeoJSON ────────────────────────────────────────────────────────────────
  const boundaryGeoJSON = useMemo(() => {
    if (boundaryVerts.length < 3) return null;
    const ring = [...boundaryVerts, boundaryVerts[0]];
    return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } };
  }, [boundaryVerts]);

  const zonesGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: featureZones.filter(z => z.vertices.length >= 3).map(z => ({
      type: 'Feature' as const,
      properties: { color: z.color },
      geometry: { type: 'Polygon' as const, coordinates: [[...z.vertices, z.vertices[0]]] },
    })),
  }), [featureZones]);

  // Stable per-plant color — index in allCurrentPlants drives golden-angle hue
  const colorForId = useMemo(() => {
    const m = new Map<string, string>();
    allCurrentPlants.forEach(({ plant }, i) => m.set(plant.id, plantColor(i)));
    return m;
  }, [allCurrentPlants]);

  // Obstacle-subtracted planting beds — obstacles are any non-planting, non-tree zones
  const clippedPlantingBeds = useMemo(() => {
    const obstaclePolys = featureZones
      .filter(z => z.toolId !== 'planting_bed' && z.toolId !== 'tree' && z.vertices.length >= 3)
      .flatMap(z => { try { return [turf.polygon([[...z.vertices, z.vertices[0]]])]; } catch { return []; } });

    return featureZones
      .filter(z => z.toolId === 'planting_bed' && z.vertices.length >= 3)
      .flatMap(z => {
        let current: any;
        try { current = turf.polygon([[...z.vertices, z.vertices[0]]]); } catch { return []; }
        for (const obs of obstaclePolys) {
          try { const diff = turf.difference(current, obs); if (!diff) return []; current = diff; } catch {}
        }
        return [{ zoneId: z.id ?? z.label, geom: current }];
      });
  }, [featureZones]);

  const plantingBedsGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: clippedPlantingBeds.map(({ geom }) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: geom.geometry,
    })),
  }), [clippedPlantingBeds]);

  // Phase 3: geometric placement — runs sync once palettes are ready
  const plantCirclesGeoJSON = useMemo(() => {
    if (palettes.length === 0) return { type: 'FeatureCollection' as const, features: [] };
    const caps = STYLE_CAPS[style] ?? STYLE_CAPS.traditional;
    const zoneMap = new Map(featureZones.map(z => [z.id ?? z.label, z]));
    const clippedMap = new Map(clippedPlantingBeds.map(b => [b.zoneId, b.geom]));
    const instances = palettes.flatMap(palette => {
      const zone2 = zoneMap.get(palette.zoneId);
      if (!zone2 || zone2.vertices.length < 3) return [];
      if (zone2.toolId === 'tree') {
        const poly = turf.polygon([[...zone2.vertices, zone2.vertices[0]]]);
        const treeId = palette.selections[0]?.plantId;
        if (!treeId) return [];
        const inst = placeTreeZone(poly, treeId, colorForId);
        return inst ? [inst] : [];
      }
      const clippedGeom = clippedMap.get(palette.zoneId);
      if (!clippedGeom) return [];
      if (clippedGeom.geometry.type === 'MultiPolygon') {
        return (clippedGeom.geometry.coordinates as any[][]).flatMap((coords: any) =>
          placePlantingBed(palette, turf.polygon(coords), caps, colorForId)
        );
      }
      return placePlantingBed(palette, clippedGeom, caps, colorForId);
    });
    return instancesToGeoJSON(instances);
  }, [palettes, featureZones, style, colorForId, clippedPlantingBeds]);

  // Count per plant id — derived from actual rendered instances, not targetCount
  const countByPlantId = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of (plantCirclesGeoJSON as any).features) {
      const id = f.properties?.id;
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [plantCirclesGeoJSON]);

  const highlightCirclesGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: plantCirclesGeoJSON.features.filter(
      (f: any) => f.properties?.id === highlightedId,
    ),
  }), [plantCirclesGeoJSON, highlightedId]);

  // ── Catalog filtering ──────────────────────────────────────────────────────
  const catalogPlants = useMemo(() => {
    let list = PLANTS.filter(p => p.min_zone <= zone && p.max_zone >= zone);
    if (catalogList) {
      const cl = CURATED_LISTS.find(c => c.id === catalogList);
      if (cl) list = list.filter(cl.filter);
    } else {
      if (catalogFilter === 'tree')        list = list.filter(p => p.type === 'tree');
      if (catalogFilter === 'shrub')       list = list.filter(p => p.type.includes('shrub'));
      if (catalogFilter === 'groundcover') list = list.filter(p => p.type === 'filler');
      if (catalogFilter === 'pollinator')  list = list.filter(p => p.priorities.includes('pollinator'));
      if (catalogFilter === 'low_water')   list = list.filter(p => p.priorities.includes('low_water'));
    }
    if (catalogSearch.trim()) {
      const q = catalogSearch.toLowerCase();
      list = list.filter(p => p.common_name.toLowerCase().includes(q) || p.botanical_name.toLowerCase().includes(q));
    }
    return list;
  }, [catalogFilter, catalogList, catalogSearch, zone]);

  const handleContinue = () => {
    localStorage.setItem('diyPlantIncludes', JSON.stringify(plantIncludes));
    localStorage.setItem('diyPlantExcludes', JSON.stringify(plantExcludes));
    localStorage.setItem('diyPalettes', JSON.stringify(palettes));
    navigate('/diy/render');
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: '#efe9db', overflow: 'hidden' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-10 py-4 flex-shrink-0">
        <Logo />
        <div className="flex items-center gap-3">
          <h1 style={{ fontFamily: IS, fontSize: '1.5rem', color: '#2A2A26', fontWeight: 400, margin: 0 }}>Choose your plants.</h1>
          {curating && (
            <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#9A9A92', fontStyle: 'italic' }}>curating palette…</span>
          )}
        </div>
      </div>

      {/* Body: 50/50 split */}
      <div className="flex flex-1 overflow-hidden px-10 pb-16 gap-5">

        {/* ── Left: plant panel ── */}
        <div className="flex flex-col overflow-hidden" style={{ width: '50%', flexShrink: 0 }}>

          {/* Tabs */}
          <div className="flex flex-shrink-0 mb-3" style={{ borderBottom: '1.5px solid rgba(26,26,22,0.1)' }}>
            {([['plan', `My plan (${allCurrentPlants.length})`], ['catalog', 'Catalog']] as [PanelTab, string][]).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)}
                className="py-2.5 px-1 mr-5 transition-all"
                style={{
                  fontFamily: IT, fontSize: '0.82rem', fontWeight: tab === t ? 600 : 500,
                  color: tab === t ? '#2A2A26' : '#9A9A92',
                  background: 'none', border: 'none',
                  borderBottom: tab === t ? '2px solid #2A2A26' : '2px solid transparent',
                  cursor: 'pointer', marginBottom: -1,
                }}>
                {label}
              </button>
            ))}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto pr-1">

            {/* ── My Plan tab ── */}
            {tab === 'plan' && (
              <div className="flex flex-col gap-4">

                {/* Search to add */}
                <div className="relative">
                  <input value={plantSearch} onChange={e => setPlantSearch(e.target.value)}
                    placeholder="Search plants to add…"
                    className="w-full px-3.5 py-2.5 rounded-xl focus:outline-none"
                    style={{ backgroundColor: '#F4EAD2', fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', border: '1px solid rgba(26,26,22,0.1)' }} />
                  {plantSearch && (
                    <button onClick={() => setPlantSearch('')}
                      style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#B0B0A6', fontSize: '0.85rem', lineHeight: 1 }}>
                      ✕
                    </button>
                  )}
                </div>

                {/* Search results */}
                {plantSearch && (() => {
                  const q = plantSearch.toLowerCase();
                  const results = PLANTS.filter(p =>
                    (p.common_name.toLowerCase().includes(q) || p.botanical_name.toLowerCase().includes(q)) &&
                    p.min_zone <= zone && p.max_zone >= zone
                  ).slice(0, 8);
                  return (
                    <div className="flex flex-col gap-1">
                      {results.length === 0 && (
                        <p style={{ fontFamily: IT, fontSize: '0.8rem', color: '#9A9A92', textAlign: 'center', margin: '8px 0' }}>No plants found.</p>
                      )}
                      {results.map(p => {
                        const already = allCurrentPlants.some(x => x.plant.id === p.id);
                        return (
                          <button key={p.id}
                            onClick={() => { if (!already) { addPlant(p.id); setPlantSearch(''); } }}
                            disabled={already}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all hover:opacity-80 disabled:opacity-55"
                            style={{ background: 'rgba(244,234,210,0.8)', border: 'none', cursor: already ? 'default' : 'pointer' }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: colorForId.get(p.id) ?? '#9A9A92', flexShrink: 0 }} />
                            <span style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', flex: 1 }}>{p.common_name}</span>
                            <span style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', flexShrink: 0 }}>
                              {already ? '✓ in plan' : PLANT_TYPE_LABELS[p.type]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Grouped plant list */}
                {!plantSearch && (
                  <>
                    {allCurrentPlants.length === 0 && (
                      <div className="rounded-2xl p-6 text-center" style={{ backgroundColor: '#F4EAD2' }}>
                        <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', lineHeight: 1.6, margin: 0 }}>
                          No plants yet. Search above or browse the Catalog tab.
                        </p>
                      </div>
                    )}
                    {PLANT_TYPE_ORDER.map(typeKey => {
                      const group = allCurrentPlants.filter(({ plant }) => plant.type === typeKey);
                      if (group.length === 0) return null;
                      const currentIds = allCurrentPlants.map(x => x.plant.id);
                      return (
                        <div key={typeKey} className="flex flex-col gap-1.5">
                          <span style={{ fontFamily: IT, fontSize: '0.68rem', letterSpacing: '0.1em', color: '#9A9A92', fontWeight: 600 }}>
                            {PLANT_TYPE_LABELS[typeKey].toUpperCase()} ({group.length})
                          </span>
                          {group.map(({ plant, mine }) => {
                            const count    = countByPlantId.get(plant.id) ?? 1;
                            const expanded = expandedId === plant.id;
                            const similars = getSimilarPlants(plant, currentIds, zone);
                            return (
                              <PlantRowWithSwap key={plant.id}
                                plant={plant} mine={mine} count={count} expanded={expanded}
                                highlighted={highlightedId === plant.id}
                                color={colorForId.get(plant.id) ?? '#9A9A92'}
                                onHighlight={() => setHighlightedId(h => h === plant.id ? null : plant.id)}
                                onToggle={() => setExpandedId(expanded ? null : plant.id)}
                                onRemove={() => { removePlant(plant.id); if (expanded) setExpandedId(null); setHighlightedId(h => h === plant.id ? null : h); }}
                                onSwap={newId => { removePlant(plant.id); addPlant(newId); setExpandedId(null); setHighlightedId(null); }}
                                similars={similars}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {/* ── Catalog tab ── */}
            {tab === 'catalog' && (
              <div className="flex flex-col gap-3">
                <input value={catalogSearch} onChange={e => { setCatalogSearch(e.target.value); setCatalogList(null); }}
                  placeholder="Search all plants…"
                  className="w-full px-3.5 py-2.5 rounded-xl focus:outline-none"
                  style={{ backgroundColor: '#F4EAD2', fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', border: '1px solid rgba(26,26,22,0.1)' }} />

                {!catalogSearch && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { id: 'all', label: 'All' }, { id: 'tree', label: 'Trees' },
                        { id: 'shrub', label: 'Shrubs' }, { id: 'groundcover', label: 'Groundcovers' },
                        { id: 'pollinator', label: 'Pollinator' }, { id: 'low_water', label: 'Low water' },
                      ].map(f => (
                        <button key={f.id} onClick={() => { setCatalogFilter(f.id); setCatalogList(null); }}
                          className="px-2.5 py-1 rounded-full transition-all"
                          style={{ backgroundColor: catalogFilter === f.id && !catalogList ? '#2A2A26' : 'rgba(244,234,210,0.9)', color: catalogFilter === f.id && !catalogList ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.72rem', border: 'none', cursor: 'pointer' }}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {CURATED_LISTS.map(c => (
                        <button key={c.id} onClick={() => { setCatalogList(c.id); setCatalogFilter('all'); }}
                          className="px-2.5 py-1 rounded-full transition-all"
                          style={{ backgroundColor: catalogList === c.id ? '#2A2A26' : 'rgba(244,234,210,0.9)', color: catalogList === c.id ? '#efe9db' : '#6A6A60', fontFamily: IT, fontSize: '0.72rem', border: 'none', cursor: 'pointer' }}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {catalogPlants.map(p => (
                    <PlantCard key={p.id} plant={p}
                      added={allCurrentPlants.some(x => x.plant.id === p.id)}
                      onAdd={() => addPlant(p.id)} />
                  ))}
                  {catalogPlants.length === 0 && (
                    <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#9A9A92', textAlign: 'center', marginTop: 16 }}>No plants match.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: map ── */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full rounded-2xl overflow-hidden relative">
            <MapGL ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              mapStyle="mapbox://styles/mapbox/satellite-streets-v12"
              initialViewState={{ longitude: mapCenter[0], latitude: mapCenter[1], zoom: 19 }}
              style={{ width: '100%', height: '100%' }}
            >
              <NavigationControl position="top-right" />

              {/* Boundary */}
              {boundaryGeoJSON && (
                <Source id="boundary" type="geojson" data={boundaryGeoJSON as any}>
                  <Layer id="boundary-fill" type="fill" paint={{ 'fill-color': '#2F6B4F', 'fill-opacity': 0.08 }} />
                  <Layer id="boundary-line" type="line" paint={{ 'line-color': '#FFFFFF', 'line-width': 2 }} />
                </Source>
              )}

              {/* Feature zones */}
              {zonesGeoJSON.features.length > 0 && (
                <Source id="zones" type="geojson" data={zonesGeoJSON as any}>
                  <Layer id="zones-fill" type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 }} />
                  <Layer id="zones-line" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5 }} />
                </Source>
              )}

              {debugZones ? (
                /* Debug: shade planting beds in red, hide plants */
                plantingBedsGeoJSON.features.length > 0 && (
                  <Source id="planting-beds-debug" type="geojson" data={plantingBedsGeoJSON as any}>
                    <Layer id="beds-debug-fill" type="fill" paint={{ 'fill-color': '#E03030', 'fill-opacity': 0.55 }} />
                    <Layer id="beds-debug-line" type="line" paint={{ 'line-color': '#FF4040', 'line-width': 2 }} />
                  </Source>
                )
              ) : (
                <>
                  {/* Plant circles — to-scale diameter */}
                  {plantCirclesGeoJSON.features.length > 0 && (
                    <Source id="plants" type="geojson" data={plantCirclesGeoJSON as any}>
                      <Layer id="plants-fill"   type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': highlightedId ? 0.15 : 0.55 }} />
                      <Layer id="plants-stroke" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': highlightedId ? 0.3 : 0.85 }} />
                    </Source>
                  )}
                  {/* Highlighted plant circles */}
                  {highlightedId && highlightCirclesGeoJSON.features.length > 0 && (
                    <Source id="highlight" type="geojson" data={highlightCirclesGeoJSON as any}>
                      <Layer id="highlight-fill"   type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.85 }} />
                      <Layer id="highlight-stroke" type="line" paint={{ 'line-color': '#FFFFFF', 'line-width': 2.5, 'line-opacity': 1 }} />
                    </Source>
                  )}
                </>
              )}
            </MapGL>

            {/* Debug / normal toggle */}
            <button
              onClick={() => setDebugZones(d => !d)}
              className="absolute top-3 left-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all hover:opacity-90"
              style={{ backgroundColor: debugZones ? '#E03030' : 'rgba(20,20,18,0.6)', backdropFilter: 'blur(6px)', border: 'none', cursor: 'pointer', zIndex: 10 }}>
              <span style={{ fontFamily: IT, fontSize: '0.7rem', color: 'white', fontWeight: 500 }}>
                {debugZones ? '● planting areas' : '○ show planting areas'}
              </span>
            </button>

            {/* Legend — one entry per plant species */}
            {!debugZones && allCurrentPlants.length > 0 && (
              <div className="absolute bottom-4 left-4 rounded-xl px-3 py-2.5 flex flex-col gap-1.5"
                style={{ backgroundColor: 'rgba(20,20,18,0.72)', backdropFilter: 'blur(8px)', maxHeight: '40vh', overflowY: 'auto' }}>
                {allCurrentPlants.slice(0, 20).map(({ plant }, i) => {
                  const isHl = highlightedId === plant.id;
                  return (
                    <button key={plant.id}
                      onClick={() => setHighlightedId(isHl ? null : plant.id)}
                      className="flex items-center gap-2 text-left transition-all hover:opacity-90"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0',
                        opacity: highlightedId && !isHl ? 0.4 : 1 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: plantColor(i),
                        flexShrink: 0, outline: isHl ? '2px solid white' : 'none', outlineOffset: 1 }} />
                      <span style={{ fontFamily: IT, fontSize: '0.68rem', color: 'rgba(255,255,255,0.85)',
                        whiteSpace: 'nowrap', fontWeight: isHl ? 700 : 400 }}>{plant.common_name}</span>
                    </button>
                  );
                })}
                {allCurrentPlants.length > 20 && (
                  <span style={{ fontFamily: IT, fontSize: '0.62rem', color: 'rgba(255,255,255,0.4)' }}>+{allCurrentPlants.length - 20} more</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <button onClick={() => navigate(-1)}
        className="fixed bottom-6 left-10 hover:opacity-70 transition-all"
        style={{ fontFamily: IT, fontSize: '0.85rem', color: '#7A7A73', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
        ← back
      </button>
      <button onClick={handleContinue}
        className="fixed bottom-6 right-10 flex items-center gap-2 px-7 py-3.5 rounded-full transition-all hover:opacity-90"
        style={{ backgroundColor: '#2F6B4F', color: 'white', fontFamily: IT, fontSize: '0.88rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
        Generate final render →
      </button>
    </div>
  );
}

// ── Helper components ──────────────────────────────────────────────────────────

function PlantRowWithSwap({
  plant, mine, count, expanded, highlighted, onToggle, onRemove, onSwap, onHighlight, similars, color,
}: {
  plant: Plant; mine: boolean; count: number; expanded: boolean; highlighted: boolean;
  onToggle: () => void; onRemove: () => void; onHighlight: () => void;
  onSwap: (id: string) => void; similars: Plant[]; color: string;
}) {
  return (
    <div className="rounded-xl overflow-hidden"
      onClick={onHighlight}
      style={{ backgroundColor: 'rgba(244,234,210,0.75)', cursor: 'pointer',
        border: highlighted ? `1.5px solid ${color}` : expanded ? '1.5px solid rgba(42,42,38,0.15)' : '1.5px solid transparent',
        boxShadow: highlighted ? `0 0 0 2px ${color}30` : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s' }}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: color + '28', border: `1.5px solid ${color}60`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: IS, fontSize: '0.62rem', color }}>{plant.common_name[0]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p style={{ fontFamily: IT, fontSize: '0.8rem', color: '#2A2A26', fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plant.common_name}</p>
          {!mine && <p style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6', margin: 0 }}>suggested</p>}
        </div>
        <span style={{ fontFamily: IT, fontSize: '0.72rem', color: '#6A6A60', flexShrink: 0 }}>×{count}</span>
        {similars.length > 0 && (
          <button onClick={e => { e.stopPropagation(); onToggle(); }}
            style={{ fontFamily: IT, fontSize: '0.7rem', color: '#9A9A92', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', flexShrink: 0 }}>
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onRemove(); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#C0B8AC', fontSize: '1rem', lineHeight: 1, flexShrink: 0, padding: 0 }}>
          ×
        </button>
      </div>
      {expanded && similars.length > 0 && (
        <div className="flex flex-col gap-1 px-3 pb-3" style={{ borderTop: '1px solid rgba(42,42,38,0.08)' }}>
          <span style={{ fontFamily: IT, fontSize: '0.65rem', color: '#B0B0A6', letterSpacing: '0.08em', paddingTop: 8, display: 'block' }}>SWAP WITH</span>
          {similars.map(s => (
            <div key={s.id} className="flex items-center gap-2.5 py-1.5">
              <div style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: 'rgba(42,42,38,0.12)', border: '1.5px solid rgba(42,42,38,0.22)', flexShrink: 0 }} />
              <div className="flex-1 min-w-0">
                <p style={{ fontFamily: IT, fontSize: '0.76rem', color: '#2A2A26', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.common_name}</p>
                <p style={{ fontFamily: IT, fontSize: '0.62rem', color: '#9A9A92', margin: 0, fontStyle: 'italic' }}>{s.botanical_name}</p>
              </div>
              <button onClick={() => onSwap(s.id)}
                className="flex-shrink-0 px-2.5 py-1 rounded-full hover:opacity-80 transition-all"
                style={{ backgroundColor: '#2A2A26', color: '#efe9db', fontFamily: IT, fontSize: '0.7rem', fontWeight: 500, border: 'none', cursor: 'pointer' }}>
                swap
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlantCard({ plant, added, onAdd }: { plant: Plant; added: boolean; onAdd: () => void }) {
  const color = plantColor(PLANTS.indexOf(plant));
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-2.5"
      style={{ backgroundColor: 'rgba(244,234,210,0.7)', border: '1px solid rgba(26,26,22,0.07)' }}>
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 44, height: 44, backgroundColor: color + '20' }}>
          <span style={{ fontFamily: IS, fontStyle: 'italic', fontSize: '1.2rem', color }}>{plant.common_name[0]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p style={{ fontFamily: IT, fontSize: '0.82rem', color: '#2A2A26', fontWeight: 600, margin: 0 }}>{plant.common_name}</p>
          <p style={{ fontFamily: IT, fontSize: '0.68rem', color: '#9A9A92', fontStyle: 'italic', margin: 0 }}>{plant.botanical_name}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {[
          `Zone ${plant.min_zone}–${plant.max_zone}`,
          plant.sun.replace('_', ' '),
          `${plant.mature_height_ft}' tall`,
          ...(plant.priorities.includes('low_maintenance') ? ['low maint.'] : []),
          ...(plant.priorities.includes('pollinator') ? ['pollinator'] : []),
        ].map(tag => (
          <span key={tag} className="px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'rgba(26,26,22,0.07)', fontFamily: IT, fontSize: '0.66rem', color: '#6A6A60' }}>
            {tag}
          </span>
        ))}
      </div>
      <button onClick={onAdd} disabled={added}
        className="w-full py-2 rounded-full transition-all hover:opacity-80 disabled:opacity-60"
        style={{
          backgroundColor: added ? 'rgba(47,107,79,0.12)' : '#2A2A26',
          color: added ? '#2F6B4F' : '#efe9db',
          fontFamily: IT, fontSize: '0.76rem', fontWeight: 500,
          border: added ? '1.5px solid rgba(47,107,79,0.3)' : 'none',
          cursor: added ? 'default' : 'pointer',
        }}>
        {added ? '✓ In your plan' : '+ Add to plan'}
      </button>
    </div>
  );
}
