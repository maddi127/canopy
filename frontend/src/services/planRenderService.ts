// Plan → photorealistic rendering via Gemini. Sends the aerial plan drawing (with dimension
// labels) as the spatial reference, plus a map key tying every bloom colour on the plan to its
// species (name, mature size, and the DB's descriptive field), the features/materials, and the
// design style — and asks for a ground-level, human-eye visualization of that exact layout.
import { supabase } from '../lib/supabase';

const GEMINI_API_KEY = (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
// Same routing as geminiService: direct in dev (client key set), Netlify proxy in production.
const IMAGE_API_URL = GEMINI_API_KEY
  ? `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`
  : `/.netlify/functions/gemini?model=${IMAGE_MODEL}`;

const STYLE_LABELS: Record<string, string> = {
  natural_wild: 'whimsical wildflower-cottage garden',
  modern_structured: 'modern, minimalist, structured landscape',
  desert_minimal: 'desert xeriscape with drought-tolerant planting',
  traditional: 'traditional, classic, polished landscape',
};

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('Expected a base64 data URL');
  return { mimeType: m[1], base64: m[2] };
}

// Shared Gemini image-generation call: turns a text prompt + ordered image data-URLs into a single
// returned image data-URL. Used by both renderPlanImage (restyle) and refinePlanImage (correction).
async function generateImage(prompt: string, imageDataUrls: string[]): Promise<string> {
  const imageParts = imageDataUrls.map(url => {
    const p = parseDataUrl(url);
    return { inline_data: { mime_type: p.mimeType, data: p.base64 } };
  });
  const body = {
    contents: [{ parts: [{ text: prompt }, ...imageParts] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const res = await fetch(IMAGE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!imagePart) throw new Error('No image returned from Gemini');
  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

const read = (k: string): any => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };

// The map key: species per bloom colour (from placed instances) + feature/material entries.
async function buildMapKey(): Promise<string> {
  const plan = read('diyPlacementPlan') ?? {};
  const instances: any[] = read('diyPlantInstances') ?? [];
  const lines: string[] = [];

  // Features (pads, lawn) + ground materials.
  for (const z of plan.zones ?? []) {
    if (z.key === 'lawn') lines.push(`- The soft green organic area labeled "Lawn" is real grass lawn, ~${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft.`);
    else lines.push(`- The "${z.label}" area is a ${z.material ?? 'paved'} ${String(z.label).toLowerCase()}, ~${Math.round(z.wFt)} × ${Math.round(z.hFt)} ft.`);
  }
  if (plan.primary?.material) lines.push(`- All remaining open planting ground is dressed in ${plan.primary.variant ?? ''} ${plan.primary.material}.`.replace(/\s+/g, ' '));
  for (const b of plan.beds ?? []) lines.push(`- A separate ${b.material ?? 'mulch'} planting bed (~${Math.round(b.wFt)} × ${Math.round(b.hFt)} ft).`);
  for (const p of plan.paths ?? []) {
    lines.push(p.kind === 'creek'
      ? `- The narrow winding line is a dry creek bed of river rock, ~${p.widthFt} ft wide.`
      : `- The "${p.label ?? 'walkway'}" line is a ${p.material ?? 'flagstone'} walkway, ~${p.widthFt} ft wide.`);
  }

  // Plants: group instances by species, pull the descriptive field from the plant database.
  if (instances.length) {
    const byName = new Map<string, { color: string; count: number; wFt: number; hFt: number }>();
    for (const p of instances) {
      const cur = byName.get(p.name);
      if (cur) cur.count++;
      else byName.set(p.name, { color: p.color, count: 1, wFt: Math.round(p.widthFt), hFt: Math.round(p.heightFt) });
    }
    let dbRows: any[] = [];
    try {
      const { data } = await supabase
        .from('plant_database')
        .select('common_name, botanical_name, attributes');
      dbRows = data ?? [];
    } catch { /* legend still works without descriptions */ }
    const rowFor = (name: string) => dbRows.find(r => r.common_name === name || r.botanical_name === name);
    lines.push('- Planting key — each coloured dot cluster on the plan is one plant, rendered at its mature size:');
    for (const [name, v] of byName) {
      const row = rowFor(name);
      const desc = (row?.attributes ?? '').toString().trim();
      lines.push(`   • ${v.color} dots (×${v.count}): ${name}${row?.botanical_name && row.botanical_name !== name ? ` (${row.botanical_name})` : ''} — matures to ~${v.wFt} ft wide × ${v.hFt} ft tall${desc ? `; ${desc}` : ''}.`);
    }
  }
  return lines.join('\n');
}

// A short, hard "TRUE SCALE" block derived from the plan's real-world feet. The boundary is stored
// as an array of [x, y] points in feet (see DiyPlacementPage → diyPlacementPlan.boundary); we take
// its bounding box as the overall yard footprint. If boundary is missing we fall back to the total
// project area. The largest obstacle bbox is a best-effort read of the house footprint.
function buildScaleBlock(): string {
  const plan = read('diyPlacementPlan') ?? {};
  const bboxOf = (pts: any[]): { w: number; h: number } | null => {
    if (!Array.isArray(pts) || pts.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const x = Array.isArray(p) ? p[0] : p?.x;
      const y = Array.isArray(p) ? p[1] : p?.y;
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
  };

  const parts: string[] = [];
  const yardBox = bboxOf(plan.boundary);
  if (yardBox && yardBox.w > 0 && yardBox.h > 0) {
    parts.push(`The overall yard measures about ${yardBox.w} ft wide × ${yardBox.h} ft deep.`);
  } else if (typeof plan.projectAreaFt === 'number' && plan.projectAreaFt > 0) {
    parts.push(`The overall yard covers about ${Math.round(plan.projectAreaFt)} sq ft of ground.`);
  }

  // House footprint — best effort: the largest of the stored obstacle polygons.
  const obstacles: any[] = Array.isArray(plan.obstacles) ? plan.obstacles : [];
  let houseBox: { w: number; h: number } | null = null, houseArea = 0;
  for (const o of obstacles) {
    const b = bboxOf(o);
    if (b && b.w * b.h > houseArea) { houseArea = b.w * b.h; houseBox = b; }
  }
  if (houseBox && houseBox.w > 0 && houseBox.h > 0) {
    parts.push(`The house wall facing the yard spans roughly ${houseBox.w} ft, with a footprint about ${houseBox.w} × ${houseBox.h} ft.`);
  }

  if (!parts.length) return '';
  return `\nTRUE SCALE (measured from the plan):\n- ${parts.join('\n- ')}\n- Everything in frame must be consistent with these measurements. Render each plant at its stated mature size, people at true human height, and furniture at real dimensions. Do not scale anything up for drama or crop the yard tighter than its real proportions.`;
}

/**
 * Generate a ground-level photorealistic rendering of the current plan.
 * @param refs.perspectivePng eye-level 3D massing render (camera/structure reference) — optional
 * @param refs.planPng        the aerial plan drawing WITH dimension labels (layout/scale reference)
 */
export async function renderPlanImage(refs: { perspectivePng?: string | null; planPng: string }): Promise<string> {
  const sc = read('siteContext') ?? {};
  const prefs = read('userPreferences') ?? {};
  const styleLabel = STYLE_LABELS[prefs.style] ?? 'professionally designed residential landscape';
  const yard = sc.yard_type === 'back' ? 'back yard' : 'front yard';
  const mapKey = await buildMapKey();
  const scaleBlock = buildScaleBlock();
  const hasPerspective = !!refs.perspectivePng;

  const prompt = hasPerspective ? `Restyle the attached 3D render (IMAGE 1) into a photorealistic photograph of a residential ${yard}. This is an image-to-image transformation: every object stays exactly where it is, at exactly its size and orientation — you are changing materials, lighting, and realism, never the layout. Do not recompose, do not re-imagine, do not "improve" the arrangement. The goal is a beautiful photograph of THIS exact render, not an invented scene.

SPATIAL FIDELITY (obey these before anything else):
- Match IMAGE 1's camera exactly: same eye height, position, direction, and field of view. Keep its composition, geometry, and the position, size, and orientation of every object.
- Preserve the relative positions, spacing, and footprint sizes of every feature area, walkway, bed, house, and plant. Do not move, add, or remove anything that is in IMAGE 1.
- The extruded gray building in IMAGE 1 is the home — render a realistic house consistent with an ordinary American residence, at exactly that position, size, and orientation.
- Do NOT add structures, pergolas, gazebos, fences, walls, water features, signage, or any hardscape that is not present in IMAGE 1. Do not change the geometry.

LABELS IN IMAGE 1 (read them, then erase them):
- IMAGE 1 contains white text labels on dark pills naming every feature area, walkway, the house, and each plant species at its exact location. These labels tell you WHAT to render at each spot — render the labeled feature/walkway/house there, and render each labeled plant as its keyed species (see the planting key below) at that exact position and mature size.
- The labels are conditioning only. REMOVE every label, pill, and piece of floating text. The final photograph must contain NO text, letters, numbers, watermarks, or signage of any kind.

FURNITURE PROXIES IN IMAGE 1 (realize them in place):
- IMAGE 1 contains simple blocky placeholder furniture already positioned inside feature zones: a fire-pit ring with a flame proxy, sofa/chair/table blocks, raised garden beds, and a swing frame.
- Realize each placeholder as a real object of the SAME kind at exactly that position, size, and orientation: the fire-pit ring becomes a real fire pit with a live flame and warm glow; the sofa/chair/table blocks become matching outdoor furniture; the raised-bed blocks become tidy planted raised garden beds; the swing frame becomes a real swing. Do NOT add furniture anywhere a placeholder does not already exist.

SCALE REFERENCE:
- IMAGE 2 is the top-down plan of the same design with edge measurements in feet; use it ONLY to confirm real-world scale. All layout and composition come from IMAGE 1.
${mapKey}
${scaleBlock}

MOOD & STYLE (apply this mood without moving, adding, or removing any object; styling never overrides the geometry above):
- Style: a ${styleLabel}, healthy and established, its beds layered and lush and full. Photorealistic magazine-quality landscape photography — accurate materials (mulch, rock, pavers, stone read as themselves), soft warm shadows, believable textures.
- Light it at golden hour sliding into early dusk: a low warm sun or its afterglow, a deep blue-hour sky overhead, long soft shadows, and a warm-vs-cool contrast between the glowing lights on the ground and the cool dusk sky. The house has a few softly lit windows spilling warm light into the yard, and blooms glow in the low light.
- Scatter subtle warm path lights or small lanterns along the walkways. String lights suspended overhead are welcome ONLY above a seating/gathering area if one exists — otherwise none.
- Include at most one or two people casually relaxing, at correct human scale (~5.5–6 ft), and ONLY within a seating/gathering area if one exists. If no such area exists, include no people.
- Output a single high-quality photograph with no text whatsoever.` : `Create a premium landscape-design magazine photograph of a residential ${yard} — the kind of full-frame "after" image a high-end design studio would publish. The image must precisely reflect the spatial layout, proportions, and scale defined in the attached plan — a beautiful photograph of THIS exact plan, not an imagined one.

HOW TO READ THE MAP:
- The attached image is a top-down landscape plan of a ${yard}. The labeled edge measurements give real-world scale in feet.
- The building footprint labeled "House" is the home — render a realistic house consistent with an ordinary American residence; keep its position, orientation, and proportions exactly as drawn.
${mapKey}
${scaleBlock}

CAMERA:
- Eye level (~5.5 ft), standing ${sc.yard_type === 'back' ? 'at the rear of the yard looking toward the back of the house' : 'at the street edge looking toward the front of the house'}.
- Full-frame landscape photograph, eye-level and level horizon, with gentle depth and crisp, in-focus foreground foliage — the whole layout stays readable, like a professional landscape-design "after" photo.

STRICT SPATIAL CONSTRAINTS:
- Preserve the relative positions, spacing, and footprint sizes of every feature, walkway, bed, and plant.
- Each coloured plant shape on the plan becomes its keyed species (see the planting key above), rendered at that exact spot and mature size — keep every silhouette where it stands.
- Do NOT add structures, pergolas, gazebos, fences, walls, water features, or any hardscape that is not in the plan. Do not invent signage or text. Do not change the geometry.

STYLE & EXECUTION:
- Style: a ${styleLabel}, healthy and established, its beds layered and lush and full at golden-hour/dusk. Photorealistic magazine-quality landscape photography: accurate materials (mulch, rock, pavers, stone read as themselves), soft warm shadows, believable textures, blooms glowing in the low light. Shoot it at golden hour sliding into early dusk: a low warm sun or its afterglow, a deep blue-hour sky overhead, long soft shadows, and a warm-vs-cool contrast between the glowing ground lights and the cool dusk sky. The house has a few softly lit windows spilling warm light into the yard.
- FURNISH the plan's existing features true to their function — never add new features, only dress the ones already keyed above: a seating or patio feature gets an appropriate outdoor furniture set; a dining feature gets a table and chairs; a fire-pit feature gets a real lit fire with live flame and warm glow; a veggie/garden feature gets tidy raised-bed dressing. Furniture and dressing are styling, not new structures.
- LIGHTING as styling (not features): scatter subtle warm path lights or small lanterns along the walkways. String lights suspended overhead are welcome ONLY above a seating/gathering feature if one exists — otherwise none.
- PEOPLE: include at most one or two people casually relaxing, at correct human scale (~5.5–6 ft), and ONLY within a seating/gathering feature if one exists. If no such feature exists, include no people.
- Output a single high-quality photograph.`;

  // IMAGE 1 = perspective render (when present), IMAGE 2 = dimensioned plan.
  const imageDataUrls = refs.perspectivePng ? [refs.perspectivePng, refs.planPng] : [refs.planPng];
  return generateImage(prompt, imageDataUrls);
}

/**
 * Corrective second pass: nudge a generated photo back onto the ground-truth layout.
 * @param refs.photoPng       the photorealistic render produced by renderPlanImage (IMAGE 1)
 * @param refs.perspectivePng the authoritative 3D massing render from the same camera (IMAGE 2)
 */
export async function refinePlanImage(refs: { photoPng: string; perspectivePng?: string | null }): Promise<string> {
  if (!refs.perspectivePng) throw new Error('refine requires a perspective reference');

  const prompt = `IMAGE 1 is a photorealistic rendering of a landscape design. IMAGE 2 is the authoritative 3D layout render of the same design from the same camera position and angle — in IMAGE 2, white text labels name each object (feature areas, walkways, the house, and each plant species at its location) and simple blocky placeholders mark where furniture belongs (fire-pit ring with flame, sofa/chair/table blocks, raised garden beds, swing frame).

Compare the two images and output a CORRECTED version of IMAGE 1. IMAGE 2 is the ground truth for layout: move, resize, add, or remove objects in IMAGE 1 so that every feature area, walkway, plant mass, house, and furniture piece sits exactly where IMAGE 2 places it, at IMAGE 2's size and orientation. Realize each blocky placeholder in IMAGE 2 as a real object of that kind at that exact spot. Render each labeled plant as the correct species at its labeled location.

Preserve IMAGE 1's photographic style, lighting, mood, materials, and golden-hour/dusk atmosphere — you are only correcting geometry and placement, not restyling. Remove any text, labels, pills, numbers, or floating captions; the corrected image must contain no text whatsoever. Output a single photograph.`;

  // IMAGE 1 = the generated photo, IMAGE 2 = the ground-truth massing render.
  return generateImage(prompt, [refs.photoPng, refs.perspectivePng]);
}
