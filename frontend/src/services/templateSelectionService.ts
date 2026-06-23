import type { DesignTemplate, GroundFill, TemplateElement } from '../data/designTemplates';
import { DESIGN_TEMPLATES } from '../data/designTemplates';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SelectionInputs {
  stylePreference?:           string;    // 'modern' | 'whimsical' | 'desert' | 'traditional' | undefined
  selectedFeatures:           string[];  // feature ids from preferences flow
  yardAreaSqFt:               number;
  privacyRequiredEdgesCount?: number;    // 0–4, from survey
}

export interface ResolvedElement extends TemplateElement {
  active: boolean;
}

export interface TemplateScore {
  template:      DesignTemplate;
  styleScore:    number;
  coverageScore: number;
  sizeScore:     number;
  total:         number;
  filteredOut:   false;
}

export interface FilteredOut {
  template:    DesignTemplate;
  filteredOut: true;
  reason:      string;
}

export interface SelectionTrace {
  scored:      (TemplateScore | FilteredOut)[];
  winner:      DesignTemplate;
  usedFallback: boolean;
  reason:      string;
}

export interface TemplateInstance {
  template:    DesignTemplate;
  elements:    ResolvedElement[];
  groundFill:  GroundFill;
  trace:       SelectionTrace;
}

// ── Ground fill resolution ─────────────────────────────────────────────────────

export function resolveGroundFill(
  template: DesignTemplate,
  selectedFeatures: string[],
): GroundFill {
  return selectedFeatures.includes('open_lawn') ? 'lawn' : template.default_ground_fill;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const WEIGHTS = { style: 0.60, coverage: 0.25, size: 0.15 } as const;
const TIEBREAK_EPSILON = 0.05;
const ACTIVITY_IDS = new Set(['seating', 'dining', 'cooking']);

// ── Condition evaluation ───────────────────────────────────────────────────────

function evalCondition(condition: string | undefined, inputs: SelectionInputs): boolean {
  if (!condition) return true;

  const c = condition.trim();

  // user_picked: X [OR Y ...]
  const pickedMatch = c.match(/^user_picked:\s*(.+)$/i);
  if (pickedMatch) {
    const ids = pickedMatch[1].split(/\s+OR\s+/i).map(s => s.trim());
    return ids.some(id => inputs.selectedFeatures.includes(id));
  }

  // user has multiple activities  (phrased various ways)
  if (/multiple activities/i.test(c) || /user has multiple/i.test(c)) {
    const count = inputs.selectedFeatures.filter(f => ACTIVITY_IDS.has(f)).length;
    return count >= 2;
  }

  // yard_area_sf > N
  const areaMatch = c.match(/yard_area_sf\s*>\s*(\d+)/i);
  if (areaMatch) {
    return inputs.yardAreaSqFt > Number(areaMatch[1]);
  }

  // privacy_required_edges_count > N
  const privacyMatch = c.match(/privacy_required_edges_count\s*>\s*(\d+)/i);
  if (privacyMatch) {
    return (inputs.privacyRequiredEdgesCount ?? 0) > Number(privacyMatch[1]);
  }

  return true;
}

// ── Score components ───────────────────────────────────────────────────────────

function styleMatchScore(template: DesignTemplate, inputs: SelectionInputs): number {
  if (!inputs.stylePreference) return 0.5;
  return template.style_tags.includes(inputs.stylePreference) ? 1.0 : 0.0;
}

function coverageScore(template: DesignTemplate, inputs: SelectionInputs): number {
  const nonRequired = inputs.selectedFeatures.filter(
    f => !template.features.required.includes(f),
  );
  if (nonRequired.length === 0) return 1.0;
  const matched = nonRequired.filter(f => template.features.optional.includes(f)).length;
  return matched / nonRequired.length;
}

function sizeScore(template: DesignTemplate, inputs: SelectionInputs): number {
  const { min_sf, ideal_sf, max_sf } = template.yard_size_pref;
  const area = inputs.yardAreaSqFt;
  if (area <= min_sf || area >= max_sf) return 0.0;
  if (area <= ideal_sf) {
    return (area - min_sf) / (ideal_sf - min_sf);
  }
  return (max_sf - area) / (max_sf - ideal_sf);
}

// ── Filter ─────────────────────────────────────────────────────────────────────

function passesFilter(
  template: DesignTemplate,
  inputs: SelectionInputs,
): { passes: true } | { passes: false; reason: string } {
  // Incompatible overlap → reject
  const incompatHit = inputs.selectedFeatures.find(f =>
    template.features.incompatible.includes(f),
  );
  if (incompatHit) {
    return { passes: false, reason: `incompatible feature: ${incompatHit}` };
  }

  // Missing required → reject
  const missingReq = template.features.required.find(
    f => !inputs.selectedFeatures.includes(f),
  );
  if (missingReq) {
    return { passes: false, reason: `missing required feature: ${missingReq}` };
  }

  return { passes: true };
}

// ── Element resolution ─────────────────────────────────────────────────────────

function resolveElements(template: DesignTemplate, inputs: SelectionInputs): ResolvedElement[] {
  return template.elements.map(el => ({
    ...el,
    active: evalCondition(el.condition, inputs),
  }));
}

// ── Reason builder ─────────────────────────────────────────────────────────────

function buildReason(
  winner: DesignTemplate,
  score: TemplateScore,
  usedFallback: boolean,
  inputs: SelectionInputs,
): string {
  if (usedFallback) {
    return `No templates passed filters; selected fallback (${winner.id}).`;
  }

  const parts: string[] = [];

  if (inputs.stylePreference && winner.style_tags.includes(inputs.stylePreference)) {
    parts.push(`style match (${inputs.stylePreference})`);
  }

  const covered = inputs.selectedFeatures.filter(f =>
    winner.features.optional.includes(f) || winner.features.required.includes(f),
  );
  if (covered.length > 0) {
    parts.push(`covers selected features: ${covered.join(', ')}`);
  }

  const { min_sf, ideal_sf, max_sf } = winner.yard_size_pref;
  parts.push(`yard ${inputs.yardAreaSqFt} sf fits range ${min_sf}–${max_sf} sf (ideal ${ideal_sf} sf)`);

  parts.push(
    `scores — style:${score.styleScore.toFixed(2)} coverage:${score.coverageScore.toFixed(2)} size:${score.sizeScore.toFixed(2)} total:${score.total.toFixed(3)}`,
  );

  return parts.join('; ');
}

// ── Main export ────────────────────────────────────────────────────────────────

export function selectTemplate(inputs: SelectionInputs): TemplateInstance {
  const nonFallback = DESIGN_TEMPLATES.filter(t => !t.is_fallback);
  const fallback    = DESIGN_TEMPLATES.find(t => t.is_fallback);

  const allScored: (TemplateScore | FilteredOut)[] = [];

  let eligible: TemplateScore[] = [];

  for (const t of nonFallback) {
    const check = passesFilter(t, inputs);
    if (!check.passes) {
      allScored.push({ template: t, filteredOut: true, reason: check.reason });
      continue;
    }

    const s: TemplateScore = {
      template:      t,
      styleScore:    styleMatchScore(t, inputs),
      coverageScore: coverageScore(t, inputs),
      sizeScore:     sizeScore(t, inputs),
      get total() {
        return (
          this.styleScore    * WEIGHTS.style    +
          this.coverageScore * WEIGHTS.coverage +
          this.sizeScore     * WEIGHTS.size
        );
      },
      filteredOut: false,
    };

    allScored.push(s);
    eligible.push(s);
  }

  let usedFallback = false;

  // If nothing passed filters, use fallback
  if (eligible.length === 0 && fallback) {
    usedFallback = true;
    const fs: TemplateScore = {
      template:      fallback,
      styleScore:    styleMatchScore(fallback, inputs),
      coverageScore: coverageScore(fallback, inputs),
      sizeScore:     sizeScore(fallback, inputs),
      get total() {
        return (
          this.styleScore    * WEIGHTS.style    +
          this.coverageScore * WEIGHTS.coverage +
          this.sizeScore     * WEIGHTS.size
        );
      },
      filteredOut: false,
    };
    eligible = [fs];
  }

  // Sort: total desc; break ties within TIEBREAK_EPSILON by coverage desc; then insertion order
  eligible.sort((a, b) => {
    const diff = b.total - a.total;
    if (Math.abs(diff) > TIEBREAK_EPSILON) return diff;
    return b.coverageScore - a.coverageScore;
    // insertion order preserved by Array.prototype.sort stability
  });

  const winner       = eligible[0].template;
  const winnerScore  = eligible[0];

  const reason = buildReason(winner, winnerScore, usedFallback, inputs);

  const trace: SelectionTrace = {
    scored:      allScored,
    winner,
    usedFallback,
    reason,
  };

  return {
    template:   winner,
    elements:   resolveElements(winner, inputs),
    groundFill: resolveGroundFill(winner, inputs.selectedFeatures),
    trace,
  };
}
