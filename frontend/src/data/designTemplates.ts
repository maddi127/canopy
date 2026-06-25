// ── Types ──────────────────────────────────────────────────────────────────────

export interface TemplateElement {
  role:       string;
  rule:       string;
  count?:     number | string;  // e.g. 1, "0-2", "2 or 4"
  condition?: string;           // e.g. "user_picked: cooking", "yard_area_sf > 2000"
}

export interface BedPattern {
  shape_language: string;  // e.g. 'linear_geometric', 'curving_organic', 'no_continuous_beds'
  edge_treatment: string;
  foundation:     string;  // width/style instruction
  perimeter:      string;
}

export interface HardscapeStyle {
  surface_default:  string;
  path_geometry:    string;
  edge_treatment:   string;
  activity_pad?:    string;
  ground_default?:  string;
}

export interface FeatureSet {
  required:     string[];  // feature ids from featureTable.ts
  optional:     string[];
  incompatible: string[];
}

export interface YardSizePref {
  min_sf:   number;
  ideal_sf: number;
  max_sf:   number;
}

export type GroundFill =
  | 'lawn'
  | 'gravel'
  | 'decomposed_granite'
  | 'mulch'
  | 'planted_groundcover';

export interface DesignTemplate {
  id:                   string;
  name:                 string;
  version:              number;
  style_tags:           string[];  // 'modern' | 'whimsical' | 'desert' | 'traditional'
  features:             FeatureSet;
  yard_size_pref:       YardSizePref;
  elements:             TemplateElement[];
  bed_pattern:          BedPattern;
  hardscape_style:      HardscapeStyle;
  planting_signature:   string;
  default_ground_fill:  GroundFill;
  is_fallback?:         boolean;
}

// ── Templates ──────────────────────────────────────────────────────────────────

export const DESIGN_TEMPLATES: DesignTemplate[] = [

  // ── Modern ────────────────────────────────────────────────────────────────────

  {
    id: 'modern_foundation_border',
    name: 'Modern Foundation Border',
    version: 1,
    style_tags: ['modern'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'water_feature', 'open_lawn'],
      incompatible: ['vegetable_garden'],
    },
    yard_size_pref: { min_sf: 400, ideal_sf: 1200, max_sf: 3000 },
    elements: [
      { role: 'primary_activity',   rule: 'Best-scoring seating or dining candidate. Rectangular footprint aligned with house wall. Hardscape pad, clean edges.' },
      { role: 'secondary_activity', rule: 'If cooking selected: adjacent to primary on the side opposite the house, sharing one edge.', condition: 'user_picked: cooking' },
      { role: 'anchor_tree',        rule: 'One specimen tree placed to frame primary sightline. Refined single-trunk form.', count: 1 },
      { role: 'framing_tree',       rule: 'Up to 2 additional trees if yard >2000 sf.', count: '0-2', condition: 'yard_area_sf > 2000' },
      { role: 'water_feature',      rule: 'If selected: at terminus of primary sightline, in line with anchor tree.', condition: 'user_picked: water_feature' },
      { role: 'foundation_bed',     rule: 'Activate. Crisp linear edges, full template width (4 ft).' },
      { role: 'perimeter_bed',      rule: 'Activate only along non-front edges, narrow band (2 ft).' },
    ],
    bed_pattern: {
      shape_language: 'linear_geometric',
      edge_treatment: 'crisp_clean',
      foundation:     'full_width',
      perimeter:      'narrow_non_front',
    },
    hardscape_style: {
      surface_default: 'large_format_pavers',
      path_geometry:   'straight_runs',
      edge_treatment:  'metal_or_concrete',
    },
    planting_signature:  'modern_minimal',
    default_ground_fill: 'gravel',
  },

  {
    id: 'modern_courtyard',
    name: 'Modern Courtyard',
    version: 1,
    style_tags: ['modern'],
    features: {
      required:     ['seating'],
      optional:     ['dining', 'cooking', 'shade_trees', 'water_feature', 'open_lawn'],
      incompatible: ['vegetable_garden'],
    },
    yard_size_pref: { min_sf: 1000, ideal_sf: 2500, max_sf: 6000 },
    elements: [
      { role: 'primary_activity',   rule: 'Seating placed centrally in the largest open region, NOT against the house. Square or near-square. Hardscape paver field.' },
      { role: 'secondary_activity', rule: 'If dining or cooking: integrate into the same hardscape pad, extending the primary footprint.', condition: 'user_picked: dining OR cooking' },
      { role: 'anchor_tree',        rule: 'One large specimen tree adjacent to primary_activity, offset to one side (not centered) for partial shade.', count: 1 },
      { role: 'framing_tree',       rule: '2-3 trees positioned at corners or along edges facing the house, enclosing the courtyard.', count: '2-3' },
      { role: 'water_feature',      rule: 'If selected: a partial enclosure element (raised basin or wall fountain) beside the primary activity zone when one exists, otherwise a focal point on the main sightline from the house.', condition: 'user_picked: water_feature' },
      { role: 'foundation_bed',     rule: 'Activate, narrow (3 ft). Courtyard is the focal point, not the house edge.' },
      { role: 'perimeter_bed',      rule: 'Activate full perimeter. Beds wrap inward toward the central hardscape.' },
    ],
    bed_pattern: {
      shape_language: 'linear_geometric',
      edge_treatment: 'crisp_clean',
      foundation:     'narrow',
      perimeter:      'full_wrap',
    },
    hardscape_style: {
      surface_default: 'large_format_pavers',
      path_geometry:   'straight_runs',
      edge_treatment:  'metal_or_concrete',
    },
    planting_signature:  'modern_minimal',
    default_ground_fill: 'gravel',
  },

  {
    id: 'modern_minimalist',
    name: 'Modern Minimalist',
    version: 1,
    style_tags: ['modern'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'shade_trees', 'open_lawn'],
      incompatible: ['vegetable_garden', 'cooking', 'water_feature', 'storage_shed'],
    },
    yard_size_pref: { min_sf: 600, ideal_sf: 1500, max_sf: 4000 },
    elements: [
      { role: 'primary_activity',   rule: 'If seating or dining: minimal hardscape pad, smaller than default footprint. Negative space is the design statement.' },
      { role: 'anchor_tree',        rule: 'Single specimen tree. Architectural form (multi-stem, sculptural). Placement is itself a focal point.', count: 1 },
      { role: 'foundation_bed',     rule: 'Activate at minimum width (2 ft). Most space is lawn or gravel.' },
      { role: 'perimeter_bed',      rule: 'Do not activate. Lawn or gravel to the property edge.' },
      { role: 'screening_planting', rule: 'Linear screening only where direct neighbor sightlines exist. Single species, repeated.', condition: 'privacy_required_edges_count > 0' },
    ],
    bed_pattern: {
      shape_language: 'linear_geometric',
      edge_treatment: 'crisp_clean',
      foundation:     'minimum',
      perimeter:      'none',
    },
    hardscape_style: {
      surface_default: 'concrete_or_large_pavers',
      path_geometry:   'minimal',
      edge_treatment:  'flush',
    },
    planting_signature:  'modern_minimal',
    default_ground_fill: 'gravel',
  },

  // ── Whimsical ─────────────────────────────────────────────────────────────────

  {
    id: 'whimsical_cottage_border',
    name: 'Cottage Mixed Border',
    version: 1,
    style_tags: ['whimsical'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'shade_trees', 'vegetable_garden', 'water_feature', 'open_lawn', 'cooking', 'storage_shed'],
      incompatible: [],
    },
    yard_size_pref: { min_sf: 800, ideal_sf: 2200, max_sf: 5000 },
    elements: [
      { role: 'primary_activity', rule: 'Seating or dining near the house, tucked into planting on at least two sides. Hardscape soft (gravel, brick, or flagstone with planted joints).' },
      { role: 'anchor_tree',      rule: 'Small ornamental tree, flowering preferred. Placed at the back of a primary bed, not freestanding.', count: 1 },
      { role: 'framing_tree',     rule: '1-2 additional small/medium trees integrated into perimeter beds.', count: '1-2' },
      { role: 'specimen_shrub',   rule: '2-3 large structural shrubs distributed through beds as anchors among the abundance.', count: '2-3' },
      { role: 'water_feature',    rule: 'If selected: tucked into a bed, partially visible (a peek-through moment).', condition: 'user_picked: water_feature' },
      { role: 'foundation_bed',   rule: 'Activate at maximum width (6 ft+). Curving inner edge.' },
      { role: 'perimeter_bed',    rule: 'Activate full perimeter at deep width (4-5 ft). Curving inner edge so lawn reads as an organic shape.' },
    ],
    bed_pattern: {
      shape_language: 'curving_organic',
      edge_treatment: 'soft_natural',
      foundation:     'wide',
      perimeter:      'deep_curving',
    },
    hardscape_style: {
      surface_default: 'flagstone_or_brick',
      path_geometry:   'gentle_curves',
      edge_treatment:  'soft_or_none',
    },
    planting_signature:  'whimsical_layered',
    default_ground_fill: 'planted_groundcover',
  },

  {
    id: 'whimsical_hidden_path',
    name: 'Hidden Garden Path',
    version: 1,
    style_tags: ['whimsical'],
    features: {
      required:     ['seating'],
      optional:     ['water_feature', 'shade_trees', 'vegetable_garden'],
      incompatible: ['open_lawn', 'cooking'],
    },
    yard_size_pref: { min_sf: 400, ideal_sf: 1000, max_sf: 2500 },
    elements: [
      { role: 'primary_activity',  rule: 'Seating placed deep in the yard, away from the house — a destination. Small footprint, intimate scale. Gravel or stepping-stone surface.' },
      { role: 'path_artery',       rule: 'Winding path from back door to primary_activity, NOT straight. Passes through bed areas with planting brushing both sides.' },
      { role: 'specimen_shrub',    rule: 'Structural shrubs along the path creating moments of enclosure and reveal.', count: '3-5' },
      { role: 'anchor_tree',       rule: 'Small ornamental tree near primary_activity, providing the destination canopy.', count: 1 },
      { role: 'water_feature',     rule: 'If selected: along the path, encountered before reaching the destination.', condition: 'user_picked: water_feature' },
      { role: 'vegetable_garden',  rule: 'If selected: tucked beside the path, productive but visually integrated.', condition: 'user_picked: vegetable_garden' },
      { role: 'foundation_bed',    rule: 'Activate, narrow (3 ft). Foundation is not the focus.' },
      { role: 'perimeter_bed',     rule: 'Activate wide, irregular. Lawn shrinks to path; beds dominate.' },
    ],
    bed_pattern: {
      shape_language: 'curving_organic',
      edge_treatment: 'soft_natural',
      foundation:     'narrow',
      perimeter:      'dominant_irregular',
    },
    hardscape_style: {
      surface_default: 'gravel_or_stepping_stones',
      path_geometry:   'curving',
      edge_treatment:  'soft_natural',
    },
    planting_signature:  'whimsical_layered',
    default_ground_fill: 'planted_groundcover',
  },

  {
    id: 'whimsical_eclectic_abundance',
    name: 'Eclectic Abundance',
    version: 1,
    style_tags: ['whimsical'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'vegetable_garden', 'water_feature', 'open_lawn', 'storage_shed'],
      incompatible: [],
    },
    yard_size_pref: { min_sf: 600, ideal_sf: 1800, max_sf: 4000 },
    elements: [
      { role: 'primary_activity', rule: 'Seating or dining placed where the user spends most time, surrounded by planting. Mixed-material surface (gravel + flagstone OK).' },
      { role: 'anchor_tree',      rule: 'Ornamental tree (flowering or unusual form) placed for character, not formal framing.', count: 1 },
      { role: 'framing_tree',     rule: '1-2 additional trees with deliberate variety (not matching the anchor).', count: '1-2' },
      { role: 'specimen_shrub',   rule: 'Multiple structural shrubs with varied form, scattered to create surprise moments.', count: '3-6' },
      { role: 'water_feature',    rule: 'If selected: distinctive and visible — not subtle. Salvaged or artisanal style.', condition: 'user_picked: water_feature' },
      { role: 'vegetable_garden', rule: 'If selected: integrated into ornamental beds (not a separate veg zone).', condition: 'user_picked: vegetable_garden' },
      { role: 'foundation_bed',   rule: 'Activate wide. Mixed planting palette — color-forward.' },
      { role: 'perimeter_bed',    rule: 'Activate wide, irregular widths to create varied depth.' },
    ],
    bed_pattern: {
      shape_language: 'irregular_organic',
      edge_treatment: 'varied_soft',
      foundation:     'wide_varied',
      perimeter:      'wide_irregular',
    },
    hardscape_style: {
      surface_default: 'mixed_materials',
      path_geometry:   'curving',
      edge_treatment:  'varied',
    },
    planting_signature:  'whimsical_layered',
    default_ground_fill: 'planted_groundcover',
  },

  // ── Desert ────────────────────────────────────────────────────────────────────

  {
    id: 'desert_scatter',
    name: 'Desert Scatter',
    version: 1,
    style_tags: ['desert'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'water_feature', 'storage_shed'],
      incompatible: ['open_lawn', 'vegetable_garden'],
    },
    yard_size_pref: { min_sf: 400, ideal_sf: 1500, max_sf: 5000 },
    elements: [
      { role: 'ground_field',    rule: 'Decomposed granite (DG) or gravel covers the entire yard except hardscape pads and discrete planting zones. No lawn, no continuous beds.' },
      { role: 'primary_activity', rule: 'Seating or dining on a hardscape pad (concrete, large pavers, or stained slab). Place where afternoon shade is achievable from anchor_tree.' },
      { role: 'anchor_tree',     rule: 'Native desert canopy (palo verde, mesquite, desert willow, ironwood). Position to shade primary_activity in afternoon — design survival depends on this.', count: 1 },
      { role: 'framing_tree',    rule: '1-2 additional desert canopy trees, grouped naturalistically (cluster of 2 OR one offset).', count: '1-2' },
      { role: 'specimen_plant',  rule: 'Architectural desert specimens scattered through the DG field — agave, yucca, ocotillo, barrel cactus, golden barrel. Each is an individual focal point with negative space around it.', count: '5-9' },
      { role: 'specimen_shrub',  rule: 'Smaller mounding desert shrubs (brittlebush, salvia, dalea) used sparingly as softer counterpoint to architectural specimens.', count: '3-5' },
      { role: 'water_feature',   rule: 'If selected: architectural basin or rill in stone or concrete. Sound-focused. Near primary_activity.', condition: 'user_picked: water_feature' },
    ],
    bed_pattern: {
      shape_language: 'no_continuous_beds',
      edge_treatment: 'individual_specimens',
      foundation:     'specimen_grouping_near_house',
      perimeter:      'specimen_grouping_along_edges',
    },
    hardscape_style: {
      surface_default: 'decomposed_granite_field',
      activity_pad:    'concrete_or_large_pavers',
      path_geometry:   'informal_through_dg',
      edge_treatment:  'steel_or_stone_or_none',
    },
    planting_signature:  'desert_sparse',
    default_ground_fill: 'decomposed_granite',
  },

  {
    id: 'desert_courtyard',
    name: 'Desert Courtyard',
    version: 1,
    style_tags: ['desert'],
    features: {
      required:     ['seating'],
      optional:     ['dining', 'cooking', 'shade_trees', 'water_feature'],
      incompatible: ['open_lawn', 'vegetable_garden', 'storage_shed'],
    },
    yard_size_pref: { min_sf: 1000, ideal_sf: 2500, max_sf: 6000 },
    elements: [
      { role: 'primary_activity',     rule: 'Seating placed centrally in the largest open region. Generous hardscape pad (paver field or stained concrete). This is the room.' },
      { role: 'secondary_activity',   rule: 'If dining or cooking: integrate into the primary pad, extending it.', condition: 'user_picked: dining OR cooking' },
      { role: 'shade_structure_hint', rule: 'The courtyard implies overhead shade — note in the plan that a ramada, pergola, or shade sail is strongly recommended over primary_activity. Do not commit a structure (out of v1 scope); flag the recommendation in the deliverable.' },
      { role: 'anchor_tree',          rule: 'Large native desert canopy tree adjacent to primary_activity, providing afternoon shade. Mesquite, palo verde, or sissoo.', count: 1 },
      { role: 'framing_tree',         rule: '2-3 trees positioned at corners or along edges, enclosing the courtyard.', count: '2-3' },
      { role: 'specimen_plant',       rule: 'Architectural specimens (agave, yucca) at the perimeter of the hardscape pad as transition elements.', count: '3-6' },
      { role: 'ground_field',         rule: 'DG fills space between the central pad and perimeter; no continuous beds.' },
      { role: 'water_feature',        rule: 'If selected: architectural basin or wall fountain beside the primary activity zone if present, otherwise a focal point visible from the house. Sound (cooling) and visual.', condition: 'user_picked: water_feature' },
    ],
    bed_pattern: {
      shape_language: 'no_continuous_beds',
      edge_treatment: 'individual_specimens',
      foundation:     'specimen_grouping_near_house',
      perimeter:      'specimen_grouping_along_edges',
    },
    hardscape_style: {
      surface_default: 'paver_or_stained_concrete',
      ground_default:  'decomposed_granite',
      path_geometry:   'straight_or_minimal',
      edge_treatment:  'stone_or_steel',
    },
    planting_signature:  'desert_sparse',
    default_ground_fill: 'decomposed_granite',
  },

  {
    id: 'desert_minimalist',
    name: 'Desert Minimalist',
    version: 1,
    style_tags: ['desert'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'shade_trees', 'water_feature'],
      incompatible: ['open_lawn', 'vegetable_garden', 'cooking', 'storage_shed'],
    },
    yard_size_pref: { min_sf: 300, ideal_sf: 1200, max_sf: 3000 },
    elements: [
      { role: 'primary_activity', rule: 'If seating or dining: minimal hardscape pad, smaller than default. Surrounded by negative space.' },
      { role: 'anchor_tree',      rule: 'Single sculptural desert tree (multi-trunk palo verde or large mesquite). The tree is the centerpiece.', count: 1 },
      { role: 'specimen_plant',   rule: '2-4 architectural specimens (single agave, single barrel, single ocotillo) placed with significant negative space between each.', count: '2-4' },
      { role: 'ground_field',     rule: 'DG covers the entire yard. No shrub layer, no understory planting.' },
      { role: 'water_feature',    rule: 'If selected: a single architectural element (basin, rill). Stark, simple form.', condition: 'user_picked: water_feature' },
    ],
    bed_pattern: {
      shape_language: 'no_beds',
      edge_treatment: 'individual_specimens',
      foundation:     'specimen_grouping_minimal',
      perimeter:      'none',
    },
    hardscape_style: {
      surface_default: 'decomposed_granite',
      activity_pad:    'concrete_or_large_pavers',
      path_geometry:   'minimal',
      edge_treatment:  'flush',
    },
    planting_signature:  'desert_sparse',
    default_ground_fill: 'decomposed_granite',
  },

  // ── Traditional ───────────────────────────────────────────────────────────────

  {
    id: 'traditional_formal_symmetric',
    name: 'Formal Symmetric',
    version: 1,
    style_tags: ['traditional'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'shade_trees', 'water_feature', 'open_lawn'],
      incompatible: ['cooking', 'vegetable_garden', 'storage_shed'],
    },
    yard_size_pref: { min_sf: 1200, ideal_sf: 3000, max_sf: 7000 },
    elements: [
      { role: 'central_axis',    rule: 'Define a primary axis from the back door (or main viewing window) running into the yard. All other elements arrange symmetrically about this axis.' },
      { role: 'focal_point',     rule: 'At the terminus of the central axis: water feature if selected, otherwise a specimen tree or sculptural shrub.', count: 1 },
      { role: 'primary_activity', rule: 'Centered on the axis OR symmetric to one side with mirror element on the other. Rectangular geometric footprint.' },
      { role: 'framing_tree',    rule: 'Trees placed in matched pairs flanking the axis — same species, same form, same distance from axis.', count: '2 or 4' },
      { role: 'foundation_bed',  rule: 'Activate, geometric (rectangular) edges. Bilateral symmetry about the axis.' },
      { role: 'perimeter_bed',   rule: 'Activate as matched mirror beds. Identical shape and planting palette on each side.' },
    ],
    bed_pattern: {
      shape_language: 'rectangular_symmetric',
      edge_treatment: 'crisp_clean',
      foundation:     'geometric',
      perimeter:      'mirrored',
    },
    hardscape_style: {
      surface_default: 'cut_stone_or_brick',
      path_geometry:   'axial_straight',
      edge_treatment:  'stone_or_brick',
    },
    planting_signature:  'formal_repeated',
    default_ground_fill: 'mulch',
  },

  {
    id: 'traditional_classic_suburban',
    name: 'Classic Suburban',
    version: 1,
    style_tags: ['traditional'],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'open_lawn', 'storage_shed', 'water_feature'],
      incompatible: [],
    },
    yard_size_pref: { min_sf: 600, ideal_sf: 1800, max_sf: 5000 },
    elements: [
      { role: 'primary_activity',   rule: 'Seating or dining on a simple hardscape pad near the house — comfortable proportions, not overdesigned.' },
      { role: 'secondary_activity', rule: 'If cooking selected: adjacent to primary, accessible from house.', condition: 'user_picked: cooking' },
      { role: 'anchor_tree',        rule: 'Single canopy shade tree placed to anchor the yard, often providing afternoon shade for primary_activity.', count: 1 },
      { role: 'framing_tree',       rule: '1-2 additional trees along property edges.', count: '1-2' },
      { role: 'foundation_bed',     rule: 'Activate at moderate width (4 ft). Layered planting, conventional structure (tall-at-back).' },
      { role: 'perimeter_bed',      rule: 'Activate as moderate band along non-front edges (3 ft). Lawn dominates the open area.' },
      { role: 'storage_shed',       rule: 'If selected: along non-active fence line, accessible but not focal.', condition: 'user_picked: storage_shed' },
    ],
    bed_pattern: {
      shape_language: 'gentle_curves',
      edge_treatment: 'soft_natural',
      foundation:     'moderate',
      perimeter:      'moderate_non_front',
    },
    hardscape_style: {
      surface_default: 'paver_or_flagstone',
      path_geometry:   'gentle_curves',
      edge_treatment:  'soft_or_stone',
    },
    planting_signature:  'traditional_layered',
    default_ground_fill: 'mulch',
  },

  {
    id: 'traditional_productive_farmhouse',
    name: 'Productive Farmhouse',
    version: 1,
    style_tags: ['traditional'],
    features: {
      required:     ['vegetable_garden'],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'water_feature', 'open_lawn', 'storage_shed'],
      incompatible: [],
    },
    yard_size_pref: { min_sf: 1200, ideal_sf: 3000, max_sf: 8000 },
    elements: [
      { role: 'veg_zone',          rule: 'Dedicated raised-bed area in the sunniest part of the yard, organized in a clear grid (matching or paired beds). Mulch or gravel paths between.' },
      { role: 'primary_activity',  rule: 'Seating or dining placed adjacent to or overlooking veg_zone — productive yard is the view.' },
      { role: 'cooking_area',      rule: 'If selected: placed between primary_activity and veg_zone, integrating outdoor cooking with the garden.', condition: 'user_picked: cooking' },
      { role: 'storage_shed',      rule: 'If selected: near veg_zone for tool access, not hidden in a far corner.', condition: 'user_picked: storage_shed' },
      { role: 'anchor_tree',       rule: 'Fruit tree preferred — apple, pear, or stone fruit. Positioned at veg_zone edge or yard anchor.', count: 1 },
      { role: 'framing_tree',      rule: '1-2 additional fruit or canopy trees.', count: '1-2' },
      { role: 'foundation_bed',    rule: 'Activate. Mixed productive + ornamental (herbs, edible flowers).' },
      { role: 'perimeter_bed',     rule: 'Activate where not displaced by veg_zone. Pollinator-friendly mix.' },
    ],
    bed_pattern: {
      shape_language: 'rectangular_relaxed',
      edge_treatment: 'soft_natural',
      foundation:     'mixed_productive',
      perimeter:      'pollinator_mix',
    },
    hardscape_style: {
      surface_default: 'gravel_or_decomposed_granite',
      path_geometry:   'grid_or_informal',
      edge_treatment:  'wood_or_stone',
    },
    planting_signature:  'farmhouse_productive',
    default_ground_fill: 'mulch',
  },

  // ── Fallback ──────────────────────────────────────────────────────────────────

  {
    id: 'fallback_generic',
    name: 'Fallback Generic',
    version: 1,
    style_tags: [],
    features: {
      required:     [],
      optional:     ['seating', 'dining', 'cooking', 'shade_trees', 'vegetable_garden', 'water_feature', 'open_lawn', 'storage_shed'],
      incompatible: [],
    },
    yard_size_pref: { min_sf: 0, ideal_sf: 1500, max_sf: 999999 },
    elements: [
      { role: 'primary_activity',   rule: 'Best-scoring candidate, default footprint, hardscape pad.' },
      { role: 'secondary_activity', rule: 'Any additional activities placed individually at next-best candidates.', condition: 'user has multiple activities' },
      { role: 'anchor_tree',        rule: 'One canopy tree at best site location.', count: 1 },
      { role: 'framing_tree',       rule: '1-2 additional trees if yard area >2000 sf.', count: '0-2', condition: 'yard_area_sf > 2000' },
      { role: 'foundation_bed',     rule: 'Activate at default width (4 ft).' },
      { role: 'perimeter_bed',      rule: 'Activate along non-front edges at default width (3 ft).' },
      { role: 'screening_planting', rule: 'Linear screening along edges with direct neighbor sightlines.', condition: 'privacy_required_edges_count > 0' },
    ],
    bed_pattern: {
      shape_language: 'gentle_curves',
      edge_treatment: 'soft_natural',
      foundation:     'default',
      perimeter:      'default_non_front',
    },
    hardscape_style: {
      surface_default: 'paver',
      path_geometry:   'gentle_curves',
      edge_treatment:  'stone_or_concrete',
    },
    planting_signature:  'mixed_general',
    default_ground_fill: 'mulch',
    is_fallback:         true,
  },

];

// ── Lookup helpers ─────────────────────────────────────────────────────────────

export const DESIGN_TEMPLATE_BY_ID = Object.fromEntries(
  DESIGN_TEMPLATES.map(t => [t.id, t])
);

export const DESIGN_TEMPLATES_BY_STYLE = DESIGN_TEMPLATES.reduce<Record<string, DesignTemplate[]>>(
  (acc, t) => {
    for (const tag of t.style_tags) {
      (acc[tag] ??= []).push(t);
    }
    return acc;
  },
  {},
);
