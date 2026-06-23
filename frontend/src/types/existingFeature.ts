/**
 * Core types for existing features in the yard.
 * These are features the user marks on the satellite map after drawing their project boundary.
 */

// Zone types the layout pipeline understands.
// Mirrors zone-rules-unified.ts when that file exists.
export type ZoneType =
  | 'dining_patio'
  | 'lounge'
  | 'lawn'
  | 'garden_bed'
  | 'vegetable_garden'
  | 'pool'
  | 'water_feature'
  | 'fire_feature'
  | 'play_area'
  | 'storage'
  | 'water_garden';

export type ExistingFeatureType = 'tree' | 'structure' | 'patio' | 'walkway' | 'other';

export type FeatureGeometry =
  | { kind: 'point';      coordinates: [number, number] }        // [lng, lat] WGS84
  | { kind: 'polygon';    coordinates: [number, number][] }      // closed ring, WGS84
  | { kind: 'linestring'; coordinates: [number, number][] };     // open path, WGS84

/**
 * The resolved role of an 'other' feature.
 * Set by label resolution; not directly chosen by the user (but user can override).
 */
export type OtherFeatureRole =
  | { kind: 'equivalent_zone'; zoneType: ZoneType; confidence: 'high' | 'medium' | 'low' }
  | { kind: 'obstacle_only' }
  | { kind: 'unknown' };

/**
 * A single existing feature in the yard.
 * Downstream consumers (feasible region, layout pipeline) read this shape.
 */
export interface ExistingFeature {
  id: string;
  projectId: string;
  type: ExistingFeatureType;
  geometry: FeatureGeometry;

  // Type-specific parameters
  protectionRadiusFeet?: number;               // trees only; default 8
  widthFeet?: number;                          // walkways only; default 3
  bufferFeet?: number;                         // optional clearance override

  // Display + 'other' semantics
  label?: string;                              // display name; required for 'other'
  role?: OtherFeatureRole;                     // only set when type === 'other'

  // Optional connectivity (walkways)
  connectsTo?: ('house' | 'boundary' | 'gate')[];

  source: 'user_marked' | 'auto_detected_confirmed' | 'auto_detected_pending';
  createdAt: string;
  updatedAt: string;
}

/** Derived record for the layout pipeline — features that count as already-placed zones. */
export interface ExistingZone {
  id: string;
  zoneType: ZoneType;
  footprint: GeoJSON.Polygon;
  centroid: [number, number];
  source: 'patio' | 'other_classified';
  userLabel?: string;
}
