/**
 * Types for the Plan Generation Pipeline (Phases 0–5).
 */

// ── Zone catalog ──────────────────────────────────────────────────────────────

export type PlanZoneType =
  | 'dining_patio'
  | 'lounge'
  | 'outdoor_kitchen'
  | 'cooking_area'
  | 'fire_feature'
  | 'water_feature'
  | 'pool'
  | 'lawn'
  | 'meadow'
  | 'garden_bed'
  | 'planting_bed'
  | 'perennial_bed'
  | 'vegetable_garden'
  | 'specimen_planting'
  | 'privacy_screen'
  | 'entry_garden'
  | 'shade_garden'
  | 'play_area'
  | 'storage'
  | 'walkway'
  | 'circulation_path';

// ── Local coordinate system ───────────────────────────────────────────────────

/** SW-corner origin, +x = east, +y = north, units = feet. */
export interface LocalCoordSystem {
  swLng: number;
  swLat: number;
  mpdLng: number; // meters per degree longitude at this latitude
  mpdLat: number; // meters per degree latitude (≈ 110 540)
  ft: number;     // feet per meter (3.28084)
}

// ── Phase 0: input bundle ─────────────────────────────────────────────────────

export interface SiteBundle {
  address: string;
  yardType: 'front' | 'back' | 'side' | string;
  style: string;
  designIntent: DesignIntent;
  goalPriority: string[];   // e.g. ['low_maintenance', 'curb_appeal']
  spaceUsage: string[];     // e.g. ['seating', 'dining']
  /** Open polygon ring [lng, lat][] — first ≠ last. */
  boundaryRing: [number, number][];
  feasibleRegion: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  feasibleAreaSqFt: number;
  existingFeatures: import('./existingFeature').ExistingFeature[];
  coord: LocalCoordSystem;
}

// ── Surface treatment ─────────────────────────────────────────────────────────

/** Ground-level surface treatment for a zone. Drives hasPlantCoverage and plant compatibility. */
export type SurfaceTreatment = 'turf_lawn' | 'mulch_bed' | 'gravel' | 'hardscape';

// ── Phase 1: design intent ────────────────────────────────────────────────────

/**
 * Coarse position of a feature in the concept image on a 3×3 grid.
 * "front" = closest to street; "back" = furthest from street.
 */
export type ConceptPosition =
  | 'front_left' | 'front_center' | 'front_right'
  | 'middle_left' | 'middle_center' | 'middle_right'
  | 'back_left' | 'back_center' | 'back_right'
  | 'along_front_edge' | 'along_back_edge'
  | 'along_left_edge' | 'along_right_edge'
  | 'unknown';

/** A discrete feature observed in the concept image, used as a placement preference. */
export interface ConceptFeature {
  zoneType: PlanZoneType;
  count: number;
  position: ConceptPosition;
  shape?: string;
  /**
   * Category of this feature — present when the feature exists in the original yard photo.
   * infrastructure = preserve unconditionally (trees, fences, house, driveways, etc.)
   * redesign_candidate = replace per user selection (seating, dining, lawn, beds, etc.)
   * undefined = newly added by the concept design (not in the original photo)
   */
  featureCategory?: string;
  rawObservation?: string;
}

/**
 * Compositional relationship between two features in the concept image.
 * Describes how the user's design is composed, not just where each part sits.
 */
export type RelationType =
  | 'left_of'      // A sits to the left of B (from primary viewing angle)
  | 'right_of'     // A sits to the right of B
  | 'front_of'     // A sits closer to the viewing angle than B
  | 'behind'       // A sits further from the viewing angle than B
  | 'surrounds'    // A wraps around B (e.g., planted bed surrounds water feature)
  | 'inside'       // A sits within B (e.g., chairs inside gravel pad)
  | 'adjacent_to'  // features touch or share an edge
  | 'near';        // close together, designed to be experienced together

export interface FeatureRelation {
  subject: string;        // descriptor of feature A (e.g., "tree in front_left")
  relation: RelationType;
  object: string;         // descriptor of feature B (e.g., "lounge")
}

/** A ground-cover surface area observed in the concept image. */
export interface FillerZoneObservation {
  surfaceTreatment: SurfaceTreatment;
  /** True when plants (other than turf) are growing in or over this surface. */
  hasPlantCoverage: boolean;
  position: ConceptPosition;
  noteSentence?: string;
}

/** Overall planting character extracted from the concept image. */
export interface PaletteCharacter {
  plantDensity: 'sparse' | 'moderate' | 'lush';
  colorEmphasis: string[];
  dominantTypes: string[];
  notableSpecies: string[];
}

/**
 * Slim intent record. Each field earns its place:
 *   userStyle        — primary signal: palette, plant filtering, shape character.
 *   hardscapeRatio   — sanity check on zone composition (from concept image or 0.25 fallback).
 *   dominantColors   — vibe input for the plant curator.
 *   feelDescription  — load-bearing aesthetic summary; the curator's main brief.
 *   conceptFeatures  — observed features with counts and coarse positions (empty for fallback).
 *   fillerZones      — surface treatment observations for ground-cover areas (empty for fallback).
 *   paletteCharacter — planting density, color emphasis, dominant types, notable species.
 *   source           — flags whether data came from concept extraction or preferences fallback.
 */
export interface DesignIntent {
  userStyle: 'traditional' | 'modern' | 'desert' | 'whimsical';
  hardscapeRatio: number;
  dominantColors: string[];
  feelDescription: string;
  conceptFeatures: ConceptFeature[];
  featureRelations: FeatureRelation[];
  fillerZones: FillerZoneObservation[];
  paletteCharacter: PaletteCharacter;
  source: 'concept_extraction' | 'preferences_fallback';
}

// ── Phase 2: zone requests ────────────────────────────────────────────────────

export interface ZoneRequest {
  id: string;
  zoneType: PlanZoneType;
  label: string;
  minSqFt: number;
  maxSqFt: number;
  priority: number; // 1 = highest
  anchor: 'house' | 'boundary' | 'path' | 'none';
  requiredAdjacentTo: string[];  // zone request ids
  avoidAdjacentTo: string[];     // zone request ids
  sunRequirement: 'full' | 'partial' | 'shade' | 'any';
  reason: string;
  /** Coarse placement preference derived from the concept image. Strong but not a hard constraint. */
  preferredPosition?: ConceptPosition;
  /** Shape character observed in the concept image. Proposer prefers this over style defaults. */
  conceptShape?: string;
}

// ── Phase 3: proposed zones ───────────────────────────────────────────────────

/**
 * Whether a zone was placed by the LLM proposer or computed geometrically
 * as the fill (negative space after all discrete zones are subtracted).
 */
export type ZonePlacementSource = 'discrete' | 'fill';

/**
 * A zone returned by the LLM layout proposer (discrete) or computed by
 * Phase 4.5 fill subtraction (fill).
 * All coordinates in local feet, SW-corner origin.
 */
export interface ProposedZone {
  id: string;
  requestId: string;
  zoneType: PlanZoneType;
  label: string;
  /** Closed polygon ring in local feet [x, y][]. Empty for fill zones (use footprintLngLat). */
  footprintFt: [number, number][];
  areaSqFt: number;
  centroidFt: [number, number];
  /** Derived from centroidFt via toLngLat — added during validation. */
  centroidLngLat?: [number, number];
  /** Full polygon ring in [lng, lat][] — derived during validation, or set directly for fill zones. */
  footprintLngLat?: [number, number][];
  /** 'discrete' = LLM-placed; 'fill' = computed from leftover feasible area. Defaults to 'discrete'. */
  placementSource?: ZonePlacementSource;
  /** Surface treatment for fill zones; undefined for discrete zones. */
  surfaceTreatment?: SurfaceTreatment;
  /** False means no plants are placed (surface treatment only). Undefined = true (plants placed). */
  hasPlantCoverage?: boolean;
  /** Design rationale produced by the proposer. Observability only — not used for placement. */
  rationale?: string;
}

// ── Phase 4: validation ───────────────────────────────────────────────────────

export type ViolationSeverity = 'error' | 'warning' | 'info';

export interface ValidationViolation {
  severity: ViolationSeverity;
  zoneId?: string;
  rule: string;
  message: string;
}

// ── Phase 5: validated plan ───────────────────────────────────────────────────

export interface ValidatedPlan {
  id: string;
  zones: ProposedZone[];
  violations: ValidationViolation[];
  score: number;        // 0–100
  feasibleAreaSqFt: number;
  usedSqFt: number;
  createdAt: string;
}

// ── Progress reporting ────────────────────────────────────────────────────────

export type PlanGenPhase =
  | 'bundling'
  | 'expanding'
  | 'proposing'
  | 'validating'
  | 'repairing'
  | 'filling'
  | 'scoring'
  | 'palette'
  | 'done'
  | 'error';

export interface PlanGenProgress {
  phase: PlanGenPhase;
  message: string;
  attempt?: number;
  maxAttempts?: number;
}
