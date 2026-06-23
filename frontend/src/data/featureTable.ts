// ── Types ──────────────────────────────────────────────────────────────────────

export type Eligibility = 'both' | 'back_only';
export type SunPreference = 'prefer_shade_allow_sun' | 'no_preference';

export interface Dims { w: number; h: number; }

// ── Activity Areas ─────────────────────────────────────────────────────────────
// Defined zones a person actively occupies.
// Placement: slide footprint across viable regions, score by sun/door/sightline/privacy.
// Clearance is added around the footprint at fit-check time.

export interface ActivityArea {
  id:              string;
  label:           string;
  eligibility:     Eligibility;
  defaultSizeFt:   Dims;
  defaultAreaSqFt: number;
  minSizeFt:       Dims;
  clearanceFt:     number;
  sunPreference:   SunPreference;
  combinableWith:  string[];   // ids of other activity areas
  notes:           string;
}

export const ACTIVITY_AREAS: ActivityArea[] = [
  {
    id:              'seating',
    label:           'Seating area',
    eligibility:     'both',
    defaultSizeFt:   { w: 8, h: 8 },
    defaultAreaSqFt: 64,
    minSizeFt:       { w: 6, h: 6 },
    clearanceFt:     2,
    sunPreference:   'prefer_shade_allow_sun',
    combinableWith:  ['dining', 'cooking'],
    notes:           'Default sized for a small conversational set (2–4 people). Rectangular variant 6×10 also valid.',
  },
  {
    id:              'dining',
    label:           'Dining area',
    eligibility:     'back_only',
    defaultSizeFt:   { w: 16, h: 14 },
    defaultAreaSqFt: 224,
    minSizeFt:       { w: 12, h: 10 },
    clearanceFt:     2,
    sunPreference:   'prefer_shade_allow_sun',
    combinableWith:  ['seating', 'cooking'],
    notes:           'Sized for a 6–8 person table with chair pull-out clearance. If Seating + Dining both selected, evaluate combined zone first.',
  },
  {
    id:              'cooking',
    label:           'Cooking area',
    eligibility:     'back_only',
    defaultSizeFt:   { w: 5, h: 8 },
    defaultAreaSqFt: 40,
    minSizeFt:       { w: 4, h: 6 },
    clearanceFt:     3,
    sunPreference:   'no_preference',
    combinableWith:  ['dining', 'seating'],
    notes:           'Default = grill + minimal counter pad. Bias adjacent to dining if both selected. Extended variant (16×10) deferred to v1.5.',
  },
];

// ── Objects & Features ─────────────────────────────────────────────────────────
// Discrete physical items that occupy space.
// Placement: locate a spot for the item + ensure access/clearance.
// Note: shed/utility items should use an INVERTED scoring rubric — they prefer
// the lowest-scoring activity spots (shaded back corners, low-sightline edges).

export interface ObjectFeature {
  id:                     string;
  label:                  string;
  eligibility:            Eligibility;
  defaultItemSizeFt:      Dims;
  defaultFootprintSqFt:   Dims;  // item + access clearance
  minSizeFt:              Dims;
  accessClearanceFt:      string; // e.g. '2 all sides' or '2 front, 1 sides'
  placementPreference:    string;
  variants:               string;
  notes:                  string;
}

export const OBJECTS_AND_FEATURES: ObjectFeature[] = [
  {
    id:                   'water',
    label:                'Water feature',
    eligibility:          'both',
    defaultItemSizeFt:    { w: 5, h: 5 },
    defaultFootprintSqFt: { w: 9, h: 9 },
    minSizeFt:            { w: 3, h: 3 },
    accessClearanceFt:    '2 all sides',
    placementPreference:  'Visible from primary seating; near power if pumped; not in deepest shade (algae) or under heavy leaf-drop trees.',
    variants:             'Small bubbler ~3×3, medium pond ~5×5, large ~8×8',
    notes:                "Default = small/medium freestanding fountain or basin. Power proximity ignored in v1 — flag 'electrician recommended' in plan output.",
  },
  {
    id:                   'storage',
    label:                'Storage shed',
    eligibility:          'back_only',
    defaultItemSizeFt:    { w: 8, h: 6 },
    defaultFootprintSqFt: { w: 10, h: 8 },
    minSizeFt:            { w: 6, h: 4 },
    accessClearanceFt:    '2 front (door swing), 1 sides',
    placementPreference:  'Less-visible corner; flat; not blocking utility access; doors face open space.',
    variants:             'Small 6×4, standard 8×6, large 10×12',
    notes:                'Invert activity scoring rubric — score UP for low-sun, low-sightline corners. A shed in the best seating spot is a failure mode.',
  },
];

// ── Allocations ────────────────────────────────────────────────────────────────
// Quantities of space, not single placed footprints.
// Sized by rule or user input; location is leftover or rule-driven.

export interface Allocation {
  id:              string;
  label:           string;
  eligibility:     Eligibility;
  sizingModel:     string;
  defaultSize:     string;
  minimumViable:   string;
  placementModel:  string;
  constraints:     string;
  notes:           string;
}

export const ALLOCATIONS: Allocation[] = [
  {
    id:             'garden',
    label:          'Vegetable garden',
    eligibility:    'both',
    sizingModel:    'Per-bed footprint; bed count from user input or default',
    defaultSize:    '2 beds × (10 × 4 ft) = 80 sq ft',
    minimumViable:  '1 bed × (6 × 3 ft) = 18 sq ft',
    placementModel: 'Sun-driven — sunniest viable open area; back yard preferred but not required if front has the only sun.',
    constraints:    'Min 6 hrs growing-season sun; flat; near hose bib if known.',
    notes:          "Raised beds tile naturally — grow to N beds based on 'how much do you want to grow' answer. v1 default = 2 beds.",
  },
  {
    id:             'lawn',
    label:          'Open lawn',
    eligibility:    'both',
    sizingModel:    'Residual — leftover after all other features are placed',
    defaultSize:    'Whatever remains',
    minimumViable:  '200 sq ft (below this it is a turf strip, not usable lawn)',
    placementModel: 'Implicit — any plantable cell not claimed by activities, beds, or features defaults to lawn IF user selected this feature.',
    constraints:    'If user did NOT select lawn, residual becomes additional planting bed area instead.',
    notes:          "Tri-state: explicitly wanted / explicitly not wanted / not specified (defaults to small amount). Picking 'open lawn' suppresses aggressive bed expansion.",
  },
  {
    id:             'trees',
    label:          'Shade trees',
    eligibility:    'both',
    sizingModel:    'Per-tree footprint × count',
    defaultSize:    '2–3 trees at mature canopy (~25 ft diameter each)',
    minimumViable:  '1 tree',
    placementModel: 'Anchor/framing rules: clear of structures, frame sightlines, shade hot-side exposure of activities.',
    constraints:    'Mature canopy clearances; not over utilities; not shading sun-dependent zones (veg garden, seating in cool climates).',
    notes:          "Templates always place trees. User selecting 'shade trees' means MORE or BIGGER — bump count by 1–2 over template default, or upgrade canopy size. Not a trigger to place trees at all.",
  },
];

// ── Lookup helpers ─────────────────────────────────────────────────────────────

export const ACTIVITY_AREA_BY_ID = Object.fromEntries(ACTIVITY_AREAS.map(a => [a.id, a]));
export const OBJECT_FEATURE_BY_ID = Object.fromEntries(OBJECTS_AND_FEATURES.map(o => [o.id, o]));
export const ALLOCATION_BY_ID = Object.fromEntries(ALLOCATIONS.map(a => [a.id, a]));

// All preference feature ids mapped to their table + entry, for the placement engine
export type FeatureTableEntry =
  | { kind: 'activity';   entry: ActivityArea   }
  | { kind: 'object';     entry: ObjectFeature  }
  | { kind: 'allocation'; entry: Allocation     };

const _all: [string, FeatureTableEntry][] = [
  ...ACTIVITY_AREAS.map(e => [e.id, { kind: 'activity' as const,   entry: e }] as [string, FeatureTableEntry]),
  ...OBJECTS_AND_FEATURES.map(e => [e.id, { kind: 'object' as const,    entry: e }] as [string, FeatureTableEntry]),
  ...ALLOCATIONS.map(e => [e.id, { kind: 'allocation' as const, entry: e }] as [string, FeatureTableEntry]),
];
export const FEATURE_TABLE: Record<string, FeatureTableEntry> = Object.fromEntries(_all);
