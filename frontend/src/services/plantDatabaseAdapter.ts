/**
 * Plant Database Adapter
 *
 * Normalizes the existing Plant[] (plantDatabase.ts legacy schema) into
 * PlantRecord[] (spec schema). This runs once on load; downstream code
 * only touches PlantRecord.
 */

import { PLANTS } from '../features/planting/plantDatabase';
import type {
  PlantRecord, PlantType, PlantUse, SunRequirement, WaterNeed, DesignStyle, PlantAttribute,
  PlantRole,
} from '../types/plantTypes';
import type { SurfaceTreatment } from '../types/planTypes';

// ── Style key mapping ─────────────────────────────────────────────────────────

const STYLE_MAP: Record<string, DesignStyle> = {
  modern_structured: 'modern',
  natural_wild:      'whimsical',
  desert_minimal:    'desert',
  traditional:       'traditional',
};

// ── Type mapping ──────────────────────────────────────────────────────────────

function mapType(legacyType: string, heightFt: number, widthFt: number): PlantType {
  switch (legacyType) {
    case 'tree':             return 'deciduous_tree';
    case 'large_shrub':      return 'shrub';
    case 'foundation_shrub': return 'shrub';
    case 'perimeter_shrub':  return 'shrub';
    case 'filler':
      if (heightFt <= 0.5) return 'groundcover';
      if (widthFt >= heightFt * 3) return 'groundcover'; // very spreading
      return 'perennial';
    default:                 return 'perennial';
  }
}

// ── Use mapping ───────────────────────────────────────────────────────────────

function mapUse(legacyType: string, priorities: string[], heightFt: number, widthFt: number): PlantUse[] {
  const uses: PlantUse[] = [];

  switch (legacyType) {
    case 'tree':
      uses.push('tree');
      break;
    case 'large_shrub':
      uses.push('foundation');
      break;
    case 'foundation_shrub':
      uses.push('foundation');
      break;
    case 'perimeter_shrub':
      uses.push('perimeter');
      break;
    case 'filler':
      if (heightFt <= 0.5 || widthFt >= heightFt * 3) uses.push('groundcover');
      else uses.push('filler');
      break;
    default:
      uses.push('filler');
  }

  if (priorities.includes('privacy') && !uses.includes('privacy')) uses.push('privacy');
  return uses;
}

// ── Sun mapping ───────────────────────────────────────────────────────────────

function mapSun(legacySun: string): SunRequirement[] {
  switch (legacySun) {
    case 'full_sun':  return ['full_sun'];
    case 'part_shade': return ['part_sun'];
    case 'full_shade': return ['full_shade'];
    case 'adaptable':  return ['full_sun', 'part_sun', 'full_shade'];
    default:           return ['full_sun', 'part_sun'];
  }
}

// ── Water need inference ──────────────────────────────────────────────────────

function mapWater(priorities: string[]): WaterNeed {
  if (priorities.includes('low_water')) return 'very_low';
  if (priorities.includes('low_maintenance')) return 'low';
  return 'moderate';
}

// ── Attribute mapping ─────────────────────────────────────────────────────────

function mapAttributes(priorities: string[]): PlantAttribute[] {
  const attrs: PlantAttribute[] = [];
  if (priorities.includes('low_maintenance')) attrs.push('low_maintenance');
  if (priorities.includes('pollinator'))      attrs.push('pollinator_friendly');
  if (priorities.includes('kid_pet'))         attrs.push('kid_pet_friendly');
  return attrs;
}

// ── Role capability derivation ────────────────────────────────────────────────

function deriveRoleCapable(plant: typeof PLANTS[0]): PlantRole[] {
  if (plant.is_anchor_capable) return ['anchor', 'workhorse'];
  if (plant.type === 'filler' && plant.mature_width_ft < 1) return ['accent'];
  if (plant.mature_width_ft < 1.5 && plant.mature_height_ft < 1) return ['accent'];
  if (plant.mature_width_ft < 2) return ['workhorse', 'accent'];
  return ['workhorse'];
}

// ── Compatible surfaces ───────────────────────────────────────────────────────

function mapCompatibleSurfaces(plant: typeof PLANTS[0]): SurfaceTreatment[] {
  const surfaces = new Set<SurfaceTreatment>(['mulch_bed']);

  if (plant.type === 'tree') {
    surfaces.add('turf_lawn');
    surfaces.add('gravel');
    return [...surfaces];
  }

  // Xeric/low-water plants are gravel-compatible
  if (plant.priorities.includes('low_water') || plant.styles.includes('desert_minimal')) {
    surfaces.add('gravel');
  }

  // Very low-growing spreaders can edge into lawn areas
  const h = plant.mature_height_ft;
  const w = plant.mature_width_ft;
  if (h <= 0.5 || w >= h * 3) surfaces.add('turf_lawn');

  return [...surfaces];
}

// ── Adapter ───────────────────────────────────────────────────────────────────

function adaptPlant(plant: typeof PLANTS[0], index: number): PlantRecord {
  return {
    id: index + 1,
    commonName: plant.common_name,
    botanicalName: plant.botanical_name,
    type: mapType(plant.type, plant.mature_height_ft, plant.mature_width_ft),
    use: mapUse(plant.type, plant.priorities, plant.mature_height_ft, plant.mature_width_ft),
    color: null,        // not in legacy schema
    bloomSeason: null,  // not in legacy schema
    isEvergreen: false, // not in legacy schema
    matureHeightFt: plant.mature_height_ft,
    matureWidthFt: plant.mature_width_ft,
    minZone: plant.min_zone,
    maxZone: plant.max_zone,
    sunRequirement: mapSun(plant.sun),
    waterNeed: mapWater(plant.priorities),
    styles: plant.styles.map(s => STYLE_MAP[s]).filter(Boolean) as DesignStyle[],
    attributes: mapAttributes(plant.priorities),
    compatibleSurfaces: mapCompatibleSurfaces(plant),
    sizeBucket: plant.size_bucket,
    isAnchorCapable: plant.is_anchor_capable,
    roleCapable: deriveRoleCapable(plant),
    underPlanting: ['deciduous_tree', 'evergreen_tree'].includes(
      mapType(plant.type, plant.mature_height_ft, plant.mature_width_ft)
    ),
  };
}

let _cache: PlantRecord[] | null = null;

export function getPlantDatabase(): PlantRecord[] {
  if (!_cache) _cache = PLANTS.map(adaptPlant);
  return _cache;
}
