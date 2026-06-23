import type { GroundFill, HardscapeStyle } from '../data/designTemplates';
import type { SunClass } from '../services/sunModelingService';
import type { CandidateDerivationResult } from '../services/candidateDerivationService';
import type { TemplateInstance } from '../services/templateSelectionService';
import type { ConfirmedFeature } from '../pages/DiyFeatureConfirmPage';
import type { SunCell } from '../services/sunModelingService';

// ── Primitive aliases ──────────────────────────────────────────────────────────

export type Coords = [number, number];  // [lng, lat]
export type Ring   = Coords[];          // open polygon ring (no closing vertex)

// ── Sub-types ──────────────────────────────────────────────────────────────────

export type CanopySize = 'large' | 'medium' | 'small';

export type S1WarningType =
  | 'element_skipped'
  | 'element_relaxed'
  | 'path_not_routed'
  | 'bed_dropped'
  | 'required_missing';

export type RelaxationTier = 0 | 1 | 2 | 3 | 4;

// ── Committed elements ────────────────────────────────────────────────────────

export interface S1Activity {
  id:               string;
  type:             string;   // 'seating' | 'dining' | 'cooking' | etc.
  role:             string;   // 'primary_activity' | 'secondary_activity'
  geometry:         Ring;
  areaSqFt:         number;
  integratedWithId?: string;
}

export interface S1Tree {
  id:                 string;
  role:               string;   // 'anchor_tree' | 'framing_tree' | 'specimen_plant'
  position:           Coords;
  assumedCanopySize:  CanopySize;
  canopyRadiusFt:     number;
  idealSpeciesHints:  string[];
}

export interface S1Object {
  id:       string;
  type:     string;   // 'water_feature' | 'storage_shed' | 'specimen_shrub' | etc.
  role:     string;
  geometry: Ring;
  areaSqFt: number;
}

export interface S1Zone {
  id:        string;
  type:      string;   // 'veg_zone' | 'central_axis' | 'ground_field' | 'path_artery'
  role:      string;
  geometry:  Ring;
  areaSqFt?: number;
}

export interface S1Path {
  id:       string;
  geometry: Coords[];   // polyline
  widthFt:  number;
  surface:  string;
  connects: [string, string];
}

export interface S1Bed {
  id:       string;
  source:   'foundation' | 'perimeter' | 'hardscape_edge' | 'tree_underplant' | 'veg';
  geometry: Ring;
  areaSqFt: number;
  sunClass: SunClass;
}

// ── Warnings & logs ───────────────────────────────────────────────────────────

export interface S1Warning {
  type:               S1WarningType;
  message:            string;
  relatedElementId?:  string;
}

export interface S1RelaxationEntry {
  elementId: string;
  tierUsed:  RelaxationTier;
  reason:    string;
}

export interface S1ShadeHint {
  message:          string;
  relatedElementId: string;
}

// ── User input snapshot ───────────────────────────────────────────────────────

export interface S1UserInputs {
  style?:    string;
  features:  string[];
  yardType:  'front' | 'back';
}

// ── Plan object ───────────────────────────────────────────────────────────────

export interface S1Plan {
  id:                  string;
  createdAt:           string;   // ISO 8601
  version:             number;

  templateId:          string;
  templateVersion:     number;

  userInputs:          S1UserInputs;

  activities:          S1Activity[];
  trees:               S1Tree[];
  objects:             S1Object[];
  zones:               S1Zone[];
  paths:               S1Path[];
  beds:                S1Bed[];

  groundFill:          GroundFill;
  plantingSignature:   string;
  hardscapeStyle:      HardscapeStyle;

  warnings:            S1Warning[];
  relaxationLog:       S1RelaxationEntry[];
  shadeStructureHints: S1ShadeHint[];
}

// ── Execution inputs ──────────────────────────────────────────────────────────

export interface S1ExecutionInputs {
  boundaryVerts:          [number, number][];
  features:               ConfirmedFeature[];
  sunCells:               SunCell[];
  candidates:             CandidateDerivationResult;
  templateInstance:       TemplateInstance;
  selectedFeatures:       string[];
  yardType:               'front' | 'back';
  yardAreaSqFt:           number;
  doorPoint?:             [number, number] | null;
  frontEdgeMidpoint?:     [number, number] | null;
  privacyRequiredEdgesCount?: number;
  stylePreference?:       string;
}
