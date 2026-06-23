import type { Plant } from './plantDatabase';

// ── Types ──────────────────────────────────────────────────────────────────

export type PlantRole = Plant['type'];

export interface ZonePalette {
  zoneId: string;
  selections: PlantSelection[];
  rationale: string;
}

export interface PlantSelection {
  plantId: string;
  role: PlantRole;
  targetCount: number;
  notes?: string;
}

export interface ZoneInput {
  zoneId: string;
  role: 'planting_bed' | 'tree';
  areaSqFt: number;
  sun: Plant['sun'];
}

export interface StyleCap {
  speciesPerZone: number;
  speciesPerRole: Partial<Record<PlantRole, number>>;
  driftSize: Partial<Record<PlantRole, number>>;
  spacingMultiplier: number;
  recommendedRepeatedSpecies: number;
}

// ── Style caps ─────────────────────────────────────────────────────────────

export const STYLE_CAPS: Record<string, StyleCap> = {
  traditional: {
    speciesPerZone: 5,
    speciesPerRole:  { tree: 1, large_shrub: 2, foundation_shrub: 2, perimeter_shrub: 2, filler: 3 },
    driftSize:       { tree: 1, large_shrub: 2, foundation_shrub: 3, perimeter_shrub: 3, filler: 5 },
    spacingMultiplier: 1.0,
    recommendedRepeatedSpecies: 2,
  },
  modern_structured: {
    speciesPerZone: 3,
    speciesPerRole:  { tree: 1, large_shrub: 1, foundation_shrub: 2, perimeter_shrub: 1, filler: 2 },
    driftSize:       { tree: 1, large_shrub: 1, foundation_shrub: 4, perimeter_shrub: 4, filler: 9 },
    spacingMultiplier: 1.0,
    recommendedRepeatedSpecies: 2,
  },
  natural_wild: {
    speciesPerZone: 7,
    speciesPerRole:  { tree: 1, large_shrub: 2, foundation_shrub: 3, perimeter_shrub: 3, filler: 5 },
    driftSize:       { tree: 1, large_shrub: 3, foundation_shrub: 4, perimeter_shrub: 5, filler: 7 },
    spacingMultiplier: 0.9,
    recommendedRepeatedSpecies: 3,
  },
  desert_minimal: {
    speciesPerZone: 4,
    speciesPerRole:  { tree: 1, large_shrub: 1, foundation_shrub: 2, perimeter_shrub: 2, filler: 3 },
    driftSize:       { tree: 1, large_shrub: 1, foundation_shrub: 2, perimeter_shrub: 2, filler: 4 },
    spacingMultiplier: 1.5,
    recommendedRepeatedSpecies: 1,
  },
};

// ── Candidate generation ───────────────────────────────────────────────────

export function generateCandidates(
  zone: ZoneInput,
  allPlants: Plant[],
  usdaZone: number,
  style: string,
  excludes: string[],
): Plant[] {
  return allPlants.filter(p => {
    if (excludes.includes(p.id)) return false;
    if (p.min_zone > usdaZone || p.max_zone < usdaZone) return false;
    if (!p.styles.includes(style as any)) return false;
    // Tree zones only accept trees; planting beds get shrubs/fillers only (trees placed by user)
    if (zone.role === 'tree' && p.type !== 'tree') return false;
    if (zone.role === 'planting_bed' && (p.type === 'tree' || p.type === 'large_shrub')) return false;
    if (zone.role === 'planting_bed' && p.mature_width_ft > 5) return false;
    if (zone.sun !== 'adaptable' && p.sun !== 'adaptable' && p.sun !== zone.sun) return false;
    return true;
  });
}

// ── Deterministic fallback ─────────────────────────────────────────────────

export function deterministicPalette(
  zones: ZoneInput[],
  allPlants: Plant[],
  usdaZone: number,
  style: string,
  includes: string[],
  excludes: string[],
): ZonePalette[] {
  const caps = STYLE_CAPS[style] ?? STYLE_CAPS.traditional;
  const usedIds = new Set<string>();

  return zones.map(zone => {
    if (zone.role === 'tree') {
      const candidates = generateCandidates(zone, allPlants, usdaZone, style, excludes);
      const tree = candidates.find(p => includes.includes(p.id)) ?? candidates[0];
      if (!tree) return { zoneId: zone.zoneId, selections: [], rationale: 'No compatible tree found.' };
      usedIds.add(tree.id);
      return {
        zoneId: zone.zoneId,
        selections: [{ plantId: tree.id, role: 'tree', targetCount: 1 }],
        rationale: 'Single specimen tree.',
      };
    }

    const candidates = generateCandidates(zone, allPlants, usdaZone, style, excludes);
    // Preferred = user-included plants first, then others
    const preferred = candidates.filter(p => includes.includes(p.id));
    const rest = candidates.filter(p => !includes.includes(p.id));
    const pool = [...preferred, ...rest];

    const byRole = new Map<PlantRole, Plant[]>();
    for (const p of pool) {
      if (!byRole.has(p.type)) byRole.set(p.type, []);
      byRole.get(p.type)!.push(p);
    }

    const selections: PlantSelection[] = [];
    let speciesUsed = 0;

    const ROLE_ORDER: PlantRole[] = ['tree', 'large_shrub', 'foundation_shrub', 'perimeter_shrub', 'filler'];

    const fillSelections = (allowRepeats: boolean) => {
      for (const role of ROLE_ORDER) {
        if (speciesUsed >= caps.speciesPerZone) break;
        const roleCap   = caps.speciesPerRole[role] ?? 2;
        const driftSize = caps.driftSize[role] ?? 3;
        const rolePlants = byRole.get(role) ?? [];

        let picked = 0;
        for (const plant of rolePlants) {
          if (speciesUsed >= caps.speciesPerZone) break;
          if (picked >= roleCap) break;
          if (!allowRepeats && usedIds.has(plant.id) && !includes.includes(plant.id) && zones.length > 1) continue;

          const count = Math.max(1, Math.min(driftSize,
            Math.round(zone.areaSqFt / (plant.spacing_ft * plant.spacing_ft * 2.5))));
          selections.push({ plantId: plant.id, role, targetCount: count });
          usedIds.add(plant.id);
          speciesUsed++;
          picked++;
        }
      }
    };

    fillSelections(false);
    // If usedIds exhausted all candidates, retry allowing repeats across zones
    if (selections.length === 0) fillSelections(true);

    return {
      zoneId: zone.zoneId,
      selections,
      rationale: 'Selected by style and zone compatibility.',
    };
  });
}

// ── LLM curation ──────────────────────────────────────────────────────────

const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
// Direct to Google in dev (key present), else via the server-side proxy.
const TEXT_URL = GEMINI_KEY
  ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
  : `/.netlify/functions/gemini?model=gemini-2.0-flash`;
// Gemini is reachable in prod (via proxy) or in dev when a key is set;
// otherwise fall back to the deterministic palette below.
const GEMINI_AVAILABLE = Boolean(GEMINI_KEY) || import.meta.env.PROD;

export async function curatePalettes(params: {
  zones: ZoneInput[];
  allPlants: Plant[];
  usdaZone: number;
  style: string;
  priorities: string[];
  includes: string[];
  excludes: string[];
}): Promise<ZonePalette[]> {
  const { zones, allPlants, usdaZone, style, priorities, includes, excludes } = params;

  if (zones.length === 0) return [];
  if (!GEMINI_AVAILABLE) {
    return deterministicPalette(zones, allPlants, usdaZone, style, includes, excludes);
  }

  const caps = STYLE_CAPS[style] ?? STYLE_CAPS.traditional;

  const candidateSets: Record<string, object[]> = {};
  for (const zone of zones) {
    candidateSets[zone.zoneId] = generateCandidates(zone, allPlants, usdaZone, style, excludes).map(p => ({
      plantId: p.id,
      common_name: p.common_name,
      type: p.type,
      mature_width_ft: p.mature_width_ft,
      mature_height_ft: p.mature_height_ft,
      sun: p.sun,
      spacing_ft: p.spacing_ft,
      styles: p.styles,
      priorities: p.priorities,
    }));
  }

  const prompt = `You are a planting designer. Select species from the candidate lists for each zone.
You may NOT select species not in the provided candidates.

DESIGN INTENT:
- Style: ${style}
- USDA Zone: ${usdaZone}
- Priorities: ${priorities.join(', ') || 'none specified'}
- User-preferred plants (prioritize these if compatible): ${includes.join(', ') || 'none'}

STYLE CAPS (hard constraints — not suggestions):
${JSON.stringify(caps, null, 2)}

ZONES:
${JSON.stringify(zones, null, 2)}

CANDIDATE PLANTS PER ZONE:
${JSON.stringify(candidateSets, null, 2)}

RULES:
- Respect speciesPerZone and speciesPerRole caps as absolute limits.
- Use driftSize as the targetCount per species (adjust down only if the zone is too small).
- Stagger bloom seasons across zones for year-round interest.
- Repeat ${caps.recommendedRepeatedSpecies} species across multiple zones to create rhythm.
- Tree zones get exactly 1 tree (no other types).
- Vary the palette — avoid using the same plant in every zone.
- Write a one-sentence rationale per zone.

OUTPUT: JSON array only. No markdown. No explanation outside the array.
Schema:
[
  {
    "zoneId": "string",
    "selections": [{ "plantId": "string", "role": "string", "targetCount": number }],
    "rationale": "string"
  }
]`;

  try {
    const res = await fetch(TEXT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35 },
      }),
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts
      ?.filter((p: any) => p.text).map((p: any) => p.text).join('') ?? '';

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');

    const parsed: ZonePalette[] = JSON.parse(match[0]);

    // Validate: strip any plantId not in the candidate set
    for (const palette of parsed) {
      const validIds = new Set(
        (candidateSets[palette.zoneId] ?? []).map((c: any) => c.plantId)
      );
      palette.selections = (palette.selections ?? []).filter(s => validIds.has(s.plantId) && s.targetCount > 0);
    }

    // Backfill any zones the LLM omitted
    const returnedIds = new Set(parsed.map(p => p.zoneId));
    const missing = zones.filter(z => !returnedIds.has(z.zoneId));
    if (missing.length > 0) {
      const fallbacks = deterministicPalette(missing, allPlants, usdaZone, style, includes, excludes);
      return [...parsed, ...fallbacks];
    }

    return parsed;
  } catch {
    return deterministicPalette(zones, allPlants, usdaZone, style, includes, excludes);
  }
}
