// The combined boundary → placement design flow, as one linear sequence of steps. Both
// DiyBoundaryPage and the illustrative DiyPlacementPage read from this so the "Step X of N"
// label and the progress bar reflect TOTAL progress through the design, not per-page progress.
export const DESIGN_STEPS = ['boundary', 'door', 'identify', 'features', 'details', 'plants'] as const;
export type DesignStep = typeof DESIGN_STEPS[number];

export const DESIGN_STEP_TITLE: Record<DesignStep, string> = {
  boundary:  'Draw your project area',
  door:      'Mark your main entry',
  identify:  'Confirm existing features',
  features:  'Place your features',
  details:   'Fill in the details',
  plants:    'Choose your plants',
};

// Global 1-based step number + total + percent-complete for a given step id.
export function designProgress(stepId: string | null | undefined): { num: number; total: number; pct: number } {
  const total = DESIGN_STEPS.length;
  const i = Math.max(0, DESIGN_STEPS.indexOf((stepId ?? 'boundary') as DesignStep));
  return { num: i + 1, total, pct: ((i + 1) / total) * 100 };
}
