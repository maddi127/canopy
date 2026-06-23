/**
 * Template-Based Layout Architecture — Data Model
 *
 * Templates are authored landscape designs that get geometrically fitted to
 * a user's actual project area. They replace the LLM-driven layout proposer.
 */

import type { PlanZoneType, SurfaceTreatment } from './planTypes';
import type { DesignStyle } from './plantTypes';

// ── Shared vocabulary ─────────────────────────────────────────────────────────

/** Palette description used in template matrix and rendering fields. */
export interface TemplatePaletteCharacter {
  dominantColors?: string[];
  plantTypes?: string[];
  plantDensity?: 'sparse' | 'moderate' | 'dense' | 'lush';
}

export type YardType = 'front' | 'back' | 'side';

export type UserFeatureOption =
  | 'seating'
  | 'dining'
  | 'cooking'
  | 'water'
  | 'water_feature'
  | 'garden'
  | 'vegetable_garden'
  | 'storage'
  | 'lawn'
  | 'open_lawn'
  | 'trees'
  | 'shade_trees';

export type GoalOption =
  | 'low_maintenance'
  | 'curb_appeal'
  | 'pollinator'
  | 'kid_pet'
  | 'low_water'
  | 'privacy';

export type ShapeCharacter =
  | 'rectangular'
  | 'rounded_rectangle'
  | 'curved'
  | 'organic'
  | 'l_shaped'
  | 'circular'
  | 'oval'
  | 'crescent'
  | 'kidney'
  | 'linear'
  | 'linear_strip'
  | 'free_form_blob'
  | 'irregular_polygon';

// ── Template identity and metadata ────────────────────────────────────────────

export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  authorId?: string;

  compatibility: TemplateCompatibility;

  zones: TemplateZone[];
  matrix: TemplateMatrix;
  anchors: TemplateAnchor[];

  rendering: TemplateRendering;
  conceptGenerationHints: ConceptGenerationHints;

  tags: string[];
  popularity?: number;
  testCoverage: 'untested' | 'piloted' | 'production';
}

// ── Compatibility ─────────────────────────────────────────────────────────────

export interface TemplateCompatibility {
  yardTypes: YardType[];
  styles: DesignStyle[];
  minProjectSqFt: number;
  maxProjectSqFt: number;
  /** USDA hardiness zones (1-13). Empty = all zones. */
  hardinessZones: number[];
  requiredAspectRatio?: { min: number; max: number };
  requiredFeatures: UserFeatureOption[];
  excludedFeatures: UserFeatureOption[];
  optionalFeatures: UserFeatureOption[];
}

// ── Zones ─────────────────────────────────────────────────────────────────────

export interface TemplateZone {
  id: string;
  zoneType: PlanZoneType;
  /** Display label; falls back to zoneType if omitted. */
  label?: string;
  position: TemplatePosition;
  constraints: TemplateZoneConstraints;
  surfaceTreatment: SurfaceTreatment;
  hasPlantCoverage: boolean;
  planSourceCategory: 'user_feature' | 'circulation' | 'design_element';
  /** If set, this zone is only included when the user selected this feature. */
  fulfilsUserFeature?: UserFeatureOption;
  relations: TemplateRelation[];
}

export interface TemplatePosition {
  /** Normalized [0-1] centroid. (0,0) = SW corner, (1,1) = NE corner. */
  centroid: { x: number; y: number };
  /** Fraction of total project area this zone should occupy. */
  relativeArea: number;
  shapeTemplate: ShapeCharacter;
  /** Degrees clockwise; useful for elongated shapes. */
  rotation?: number;
}

export interface TemplateZoneConstraints {
  minAbsoluteSqFt?: number;
  maxAbsoluteSqFt?: number;
  aspectRatioRange?: { min: number; max: number };
  anchorTo?: 'house' | 'street' | 'left_edge' | 'right_edge' | 'front_edge' | 'back_edge';
  avoidsExistingInfrastructure?: boolean;
  avoidFeatures?: string[];
}

export interface TemplateRelation {
  type: 'adjacent_to' | 'surrounds' | 'inside' | 'between' | 'aligned_with';
  targetZoneId: string;
  axisHint?: string;
}

// ── Matrix (the planting fill) ────────────────────────────────────────────────

export interface TemplateMatrix {
  surfaceTreatment: SurfaceTreatment;
  hasPlantCoverage: boolean;
  paletteCharacter: TemplatePaletteCharacter;
  fillBehavior: {
    fillsFullProject: boolean;
    /** Matrix pieces smaller than this (sq ft) are dropped. */
    minMatrixSqFt: number;
    /** Adjacent pieces closer than this (ft) are merged. */
    mergeThreshold: number;
  };
}

// ── Anchors ───────────────────────────────────────────────────────────────────

export interface TemplateAnchor {
  id: string;
  type: 'specimen_tree' | 'feature_slot' | 'edge_treatment';
  position: {
    centroid: { x: number; y: number };
    /** How far the anchor can shift from its default position, as a fraction of project size. */
    flexibilityRange: number;
    requiredAlignment?: {
      axis: 'x' | 'y';
      range: { min: number; max: number };
    };
  };
  fulfillment: {
    userFeature?: UserFeatureOption;
    existingFeatureType?: 'tree' | 'walkway' | 'fence' | 'structure';
    isRequired: boolean;
    fallbackBehavior: 'omit_zone' | 'use_default_position' | 'fail';
  };
  /** IDs of zones whose positions depend on this anchor. */
  affectsZones: string[];
}

// ── Rendering preferences ─────────────────────────────────────────────────────

export interface TemplateRendering {
  boundarySmoothness: 'minimal' | 'moderate' | 'strong';
  edgeStyle: 'sharp' | 'soft' | 'organic';
  palettePreferences: TemplatePaletteCharacter;
}

// ── Concept generation hints ──────────────────────────────────────────────────

export interface ConceptGenerationHints {
  /** Injected into the image-gen prompt to describe the design's character. */
  promptSeed: string;
  /** Verbal description of the layout's composition for the concept-gen LLM. */
  compositionDescription: string;
  cameraDirection?: 'street_view' | 'three_quarter' | 'eye_level';
}

// ── Selection / scoring outputs ───────────────────────────────────────────────

export interface TemplateScore {
  template: LayoutTemplate;
  score: number;
}

export interface TemplateSelectionResult {
  /** Exactly 1-3 templates; fewer only if library is too sparse. */
  selected: LayoutTemplate[];
  allScored: TemplateScore[];
}

// ── Stored per-project metadata ───────────────────────────────────────────────

export interface TemplateGeneratedConcept {
  templateId: string;
  imageDataUrl: string;
  generatedAt: string;
}

export interface TemplateProjectMetadata {
  selectedTemplateId: string | null;
  topTemplateIds: string[];
  generatedConcepts: TemplateGeneratedConcept[];
}

// ── Template fitting output ───────────────────────────────────────────────────

export interface FittedZone {
  id: string;
  templateZoneId: string;
  zoneType: PlanZoneType;
  label: string;
  /** Closed polygon ring in local feet [x, y][]. */
  footprintFt: [number, number][];
  areaSqFt: number;
  centroidFt: [number, number];
  surfaceTreatment: SurfaceTreatment;
  hasPlantCoverage: boolean;
  isMatrix: boolean;
  paletteCharacter?: TemplatePaletteCharacter;
}

// ── User preferences shape ────────────────────────────────────────────────────
// (matches what PreferencesGoalsPage writes to localStorage)

export interface UserPreferences {
  style: string;
  goal_priority: GoalOption[];
  not_important: GoalOption[];
  space_usage: UserFeatureOption[];
  yardType?: YardType;
  hardinessZone?: number;
  estimatedSqFt?: number;
}
