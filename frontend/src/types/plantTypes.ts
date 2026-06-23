/**
 * Plant Selection and Placement Pipeline — types
 */

import type { PlanZoneType, SurfaceTreatment } from './planTypes';

// ── Plant record (spec schema) ────────────────────────────────────────────────

export type PlantType =
  | 'deciduous_tree'
  | 'evergreen_tree'
  | 'shrub'
  | 'perennial'
  | 'ornamental_grass'
  | 'cactus_or_succulent'
  | 'groundcover';

export type PlantUse =
  | 'foundation'
  | 'filler'
  | 'perimeter'
  | 'groundcover'
  | 'tree'
  | 'privacy';

export type BloomSeason = 'spring' | 'early_summer' | 'late_summer' | 'fall' | 'winter';
export type SunRequirement = 'full_sun' | 'part_sun' | 'full_shade';
export type WaterNeed = 'very_low' | 'low' | 'moderate';
export type DesignStyle = 'modern' | 'traditional' | 'whimsical' | 'desert';
export type PlantAttribute = 'low_maintenance' | 'kid_pet_friendly' | 'pollinator_friendly' | 'edible';

// ── Unified spec: size bucket and design role ─────────────────────────────────
// Size drives area math; role drives composition cohesion (§1.1 of Unified spec).
// These are independent axes — a 1 ft dwarf conifer is small AND an anchor.

export type PlantSizeBucket = 'solo_specimen' | 'large' | 'medium' | 'small';
export type PlantRole = 'anchor' | 'workhorse' | 'accent';

export interface PlantRecord {
  id: number;
  commonName: string;
  botanicalName: string;
  type: PlantType;
  use: PlantUse[];
  color: string | null;
  bloomSeason: BloomSeason | null;
  isEvergreen: boolean;
  matureHeightFt: number;
  matureWidthFt: number;
  minZone: number;
  maxZone: number;
  sunRequirement: SunRequirement[];
  waterNeed: WaterNeed;
  styles: DesignStyle[];
  attributes: PlantAttribute[];
  compatibleSurfaces: SurfaceTreatment[];
  sizeBucket: PlantSizeBucket;
  isAnchorCapable: boolean;
  roleCapable: PlantRole[];
  underPlanting: boolean;
}

// ── Style caps ────────────────────────────────────────────────────────────────

export interface StyleCaps {
  perZone: {
    foundationSpeciesMax: number;
    fillerSpeciesMax: number;
    perimeterSpeciesMax: number;
    totalSpeciesMax: number;
  };
  preferredDriftSize: [number, number];
  spacingMultiplier: number;
  recommendedRepeatedSpecies: number;
}

export const STYLE_CAPS: Record<DesignStyle, StyleCaps> = {
  modern: {
    perZone: { foundationSpeciesMax: 1, fillerSpeciesMax: 1, perimeterSpeciesMax: 1, totalSpeciesMax: 3 },
    preferredDriftSize: [5, 12],
    spacingMultiplier: 1.0,
    recommendedRepeatedSpecies: 2,
  },
  traditional: {
    perZone: { foundationSpeciesMax: 2, fillerSpeciesMax: 2, perimeterSpeciesMax: 2, totalSpeciesMax: 5 },
    preferredDriftSize: [3, 7],
    spacingMultiplier: 1.0,
    recommendedRepeatedSpecies: 2,
  },
  desert: {
    perZone: { foundationSpeciesMax: 2, fillerSpeciesMax: 1, perimeterSpeciesMax: 1, totalSpeciesMax: 4 },
    preferredDriftSize: [1, 5],
    spacingMultiplier: 1.5,
    recommendedRepeatedSpecies: 1,
  },
  whimsical: {
    perZone: { foundationSpeciesMax: 2, fillerSpeciesMax: 4, perimeterSpeciesMax: 3, totalSpeciesMax: 8 },
    preferredDriftSize: [2, 5],
    spacingMultiplier: 0.9,
    recommendedRepeatedSpecies: 3,
  },
};

// ── Lawn / meadow specs ───────────────────────────────────────────────────────

export interface LawnSpec {
  species: string;
  areaSqFt: number;
  note: string;
}

export interface MeadowSpec {
  mixName: string;
  areaSqFt: number;
}

// ── Phase 2: palette ──────────────────────────────────────────────────────────

export interface PlantSelection {
  plantId: number;
  role: PlantUse;
  /** No longer set by the curator — placement derives counts from zone area and drift size. */
  targetCount?: number;
  notes?: string;
}

export interface ZonePalette {
  zoneId: string;
  selections: PlantSelection[];
  rationale: string;
}

// ── Phase 3: placement ────────────────────────────────────────────────────────

export interface SubstitutionCandidate {
  plantId: number;
  /** 0–1, higher = more similar to the original. */
  similarityScore: number;
  similarityFactors: {
    colorMatch: 'exact' | 'adjacent' | 'distinct';
    bloomSeasonMatch: 'exact' | 'partial' | 'none';
    /** Ratio of mature widths (smaller/larger), 1 = identical. */
    sizeProximity: number;
    typeMatch: boolean;
  };
}

export interface PlantInstance {
  id: string;
  /** Current plant — may differ from originalPlantId after a user substitution. */
  plantId: number;
  /** Local feet from SW corner of boundary. */
  position: [number, number];
  rotation: number;
  scale: number;
  /** Precomputed similar alternatives. Populated after the planting pipeline. */
  substitutionCandidates: SubstitutionCandidate[];
  /** True when plantId !== originalPlantId (user has swapped this instance). */
  isSubstituted: boolean;
  /** plantId as assigned by the pipeline — used for reset. */
  originalPlantId: number;
}

// ── Substitution log & edit session ──────────────────────────────────────────

export interface PlantSubstitution {
  id: string;
  plantedPlanId: string;
  /** The zone where the substitution was initiated. */
  zoneId: string;
  /** All zones where the swap was applied. */
  affectedZones: string[];
  fromPlantId: number;
  toPlantId: number;
  appliedAt: string;
  undoneAt?: string;
}

export interface SubstitutionStackEntry {
  substitutionId: string;
  /** Instance IDs that were changed — needed to revert on undo. */
  affectedInstanceIds: string[];
  fromPlantId: number;
  toPlantId: number;
}

export interface EditSession {
  id: string;
  plantedPlanId: string;
  startedAt: string;
  finalizedAt?: string;
  undoStack: SubstitutionStackEntry[];
}

// ── Phase 4: planted plan ─────────────────────────────────────────────────────

export interface PopulatedZone {
  zoneId: string;
  zoneType: PlanZoneType;
  palette: ZonePalette;
  plantInstances: PlantInstance[];
  lawnSpec?: LawnSpec;
  meadowSpec?: MeadowSpec;
  rationale: string;
}

export interface SkippedZone {
  zoneId: string;
  zoneType: PlanZoneType;
  reason: 'hardscape' | 'user_curated' | 'unplantable_geometry';
}

export interface RelaxationLog {
  zoneId: string;
  filterRelaxed: 'style' | 'pollinator_friendly' | 'low_maintenance' | 'kid_pet_friendly' | 'water_need';
  reason: string;
}

export interface PlantedPlan {
  id: string;
  projectId: string;
  validatedPlanId: string;
  zonesPopulated: PopulatedZone[];
  zonesSkipped: SkippedZone[];
  generation: {
    palettesSource: 'llm_curator' | 'deterministic_ranker' | 'user_palette';
    totalLatencyMs: number;
    relaxationsApplied: RelaxationLog[];
  };
  createdAt: string;
}

// ── Phase 5: plant palette (pre-selection) ────────────────────────────────────

export interface TreeSlot {
  slotId: string;
  positionDescription?: string;
  selectedPlantId: number;
  alternatives: SubstitutionCandidate[];
}

export interface SpeciesSelection {
  plantId: number;
  role: PlantUse;
  /** Total plants of this species across the whole project. Derived from planted area × density. */
  targetTotalCount: number;
  alternatives: SubstitutionCandidate[];
}

export interface PlantPalette {
  projectId: string;
  trees: TreeSlot[];
  speciesPalette: SpeciesSelection[];
  derivedAt: string;
  source: 'system_default' | 'user_finalized';
}

// ── Plant list rollup ─────────────────────────────────────────────────────────

export interface PlantListEntry {
  plantId: number;
  commonName: string;
  botanicalName: string;
  totalCount: number;
  zonesUsed: string[];
}

export function rollUpPlantList(plan: PlantedPlan, db: PlantRecord[]): PlantListEntry[] {
  const map = new Map<number, PlantListEntry>();
  const dbById = new Map(db.map(p => [p.id, p]));

  for (const zone of plan.zonesPopulated) {
    for (const inst of zone.plantInstances) {
      const rec = dbById.get(inst.plantId);
      if (!rec) continue;
      const entry = map.get(inst.plantId) ?? {
        plantId: inst.plantId,
        commonName: rec.commonName,
        botanicalName: rec.botanicalName,
        totalCount: 0,
        zonesUsed: [],
      };
      entry.totalCount++;
      if (!entry.zonesUsed.includes(zone.zoneId)) entry.zonesUsed.push(zone.zoneId);
      map.set(inst.plantId, entry);
    }
  }

  return [...map.values()].sort((a, b) => b.totalCount - a.totalCount);
}

// ── Candidate sets (Phase 1 output) ──────────────────────────────────────────

export interface ZoneCandidates {
  zoneId: string;
  zoneType: PlanZoneType;
  areaSqFt: number;
  sunExposure: SunRequirement;
  foundation: PlantRecord[];
  filler: PlantRecord[];
  perimeter: PlantRecord[];
  relaxationsApplied: RelaxationLog[];
}
