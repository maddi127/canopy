# Canopy data model — Users · Addresses · Projects · Designs

*Replaces the localStorage-blob `projects` table. Draft for review. Nothing implemented yet.*

## The shape

```
auth.users (email unique, Supabase-managed)
   └── addresses            one user → many addresses
         └── projects        one address → a front-yard and/or back-yard project
               └── designs   one project → many design options; one is "selected"
```

The key idea: **a Project is the physical site (a specific yard); a Design is one aesthetic take on that site.** Everything shared by every take (the boundary you drew, the trees that exist, where the front door is) lives on the Project. Everything that varies between takes (style, which features you want, the generated plan, the plants) lives on the Design. That split is what makes versioning and "edit vs. start new" fall out cleanly.

---

## Tables

### `addresses`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid → auth.users | RLS: `user_id = auth.uid()` |
| formatted_address | text | |
| lat, lng | double | geocoded |
| place_id | text null | geocoder id |
| hardiness_zone | text null | location-derived, cached here |
| created_at | timestamptz | |

**Uniqueness: `UNIQUE (user_id, formatted_address)` — per-user, NOT global.** Two different users can legitimately have the same address (client work, roommates); global uniqueness would break that. The pre-auth "looks like you already have an account" hint (`address_exists` RPC) is a *separate* concern — it's a `SECURITY DEFINER` function that can look across users without exposing rows.

### `projects` — a thin grouping (a yard at an address)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| address_id | uuid → addresses | |
| yard_type | text | `'front' \| 'back'` — groups designs of the same yard |
| status | text | `'draft' \| 'active' \| 'archived'` |
| selected_design_id | uuid → designs, null | the take they're going with |
| created_at, updated_at | timestamptz | |

The Project is just a folder: "my front yard at 123 Main, and the design options I've tried." All the substance — scope, site, aesthetics, output — lives on the Design (see "Where the boundary lives"). **`yard_type` is an open set** (`front`/`back` today, `side`/etc. later — a lookup or a plain text/check that's easy to extend, not a hardcoded two-value enum), with **`UNIQUE (address_id, yard_type)`**: one project per yard type per address. Different scopes within a yard are sibling *designs*, not new projects.

### `designs` — one take: its scope, site, aesthetics, and output
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid → projects | |
| name | text | auto-named ("Whole yard — modern"), user-renamable |
| **boundary** | jsonb | the project-area ring for THIS take (whole yard, or a part) |
| **existing_features** | jsonb | detected house/trees/hardscape + keep flags, scoped to this boundary |
| **door_point** | jsonb null | main entry |
| **sun_map** | jsonb null | derived from boundary + existing features |
| **preferences** | jsonb | style, desired program (seating/dining/garden…), lawn amount, goals |
| **plan** | jsonb | generated + edited layout (zones/beds/paths) |
| **plant_instances** | jsonb | placed plants |
| **generator_version** | text | e.g. `'g20'` — pinned per design (this is the versioning fix) |
| edited_at | timestamptz null | set on any manual edit; null = untouched since generation |
| status | text | `'draft' \| 'archived'` (selection tracked by `projects.selected_design_id`) |
| created_at, updated_at | timestamptz | |

**Inheritance:** a new design copies its source design's `boundary` + `existing_features` (+ door, sun), so a style exploration on the *same* area needs no redraw. **Redrawing the boundary always re-runs detection** for the new area (simpler than clipping inherited features — decided).

**RLS: denormalize `user_id` onto all three tables** (addresses, projects, designs) so every policy is a trivial `user_id = auth.uid()` — no join-in-policy, no perf cliff. `ON DELETE CASCADE` down the chain; a trigger (or the app) keeps the child's `user_id` in sync with its parent on insert.

> **Naming caveat:** "features" is overloaded today. On the Project it's **`existing_features`** (detected house/trees — site facts). On the Design's preferences it's the **desired program** (do I want a veggie garden / seating?). Rename in code to keep these straight.

---

## Your two questions, answered

### 1. Where do the boundary & existing features live? → **Design.** (Revised — your part-vs-whole case decides it.)

I first leaned Project, arguing the boundary is a "physical fact of the site." But that's wrong: the drawn boundary isn't the *lot* — it's the **scope you chose to design**, and "landscape the whole yard vs. just the walkway strip" is precisely a design decision you'd want to try both ways and compare. Those are two *takes on the same yard* → two **designs**, not two projects. So the boundary (and the detection it scopes) belongs on the **Design**:

- Same-yard explorations (modern vs. traditional over the *same* area) share a boundary via copy-on-create inheritance — no redraw, no re-detection.
- Part-vs-whole explorations get *different* boundaries as sibling designs under one project — compare them, pick the `selected` one — without duplicating the address or spawning parallel projects.
- The truly location-only fact, **hardiness zone, lives on the Address** (it's pure lat/lng); nothing genuinely boundary-independent is left to strand on the Project, which is why the Project collapses to a thin grouping.

**So (revised):** Project = grouping (address + yard_type) · Design = boundary + existing features + door + sun + preferences + plan + plants.

### 2. "Edit this design or start a new one?" → **Yes — and it *replaces* the whole silent-regeneration problem.**

This is the elegant part. Regeneration stops being something the app decides via a hidden signature and becomes a choice the user makes out loud:

Because boundary now lives on the Design too, **one prompt covers every input** — style, desired features, lawn, *and* the boundary. Any of them, after a draft has been shown → **"Edit this design, or start a new one?"**
  - **Edit** → overwrite this design's inputs (prefs and/or boundary), bump its `generator_version` to latest, regenerate its plan in place. They asked for it → regenerating is expected, not a surprise. ✅
  - **New** → `INSERT` a new design in the same project, seeded from the current one (its boundary + prefs) plus their change, generate fresh. Old design untouched → compare and pick the `selected` one.

No special project-level boundary handling needed — redrawing the boundary is just another input change routed through the same prompt.

The signature machinery mostly retires: no global `v` tag forcing everyone to regenerate, no edited-flag guarding against silent clobbers, no street-view race. We *may* keep a cheap input-hash purely to decide **whether to even show the prompt** (don't nag if nothing changed) — but it never triggers regeneration on its own.

---

## How this solves versioning (the original ask)

- **`generator_version` is per design, not global.** A new design is generated with today's engine and stamped with it. An existing design keeps the version it was made with — shipping an engine improvement (`g21`) **does nothing** to existing designs; it only affects newly generated ones. New users get the best planner; existing plans are never rewritten under anyone.
- **Improvements become an explicit offer**, per design: "We've improved the planner since this design was made — regenerate?" Opt-in, never automatic.
- The current global `inputSignature` version (`g20`) and the auto-regen gates in `DiyAutoLayoutPage` / `DiyPlanReadyPage` are removed; regeneration only happens on an explicit Edit/Regenerate action.

---

## Supabase = source of truth; localStorage = working cache

- **Signed-in:** Supabase rows are canonical. localStorage holds the *active* design as a working copy; autosave writes the design row (debounced). Loading a project/design hydrates localStorage from the row.
- **Anonymous (pre-auth flow through plan-ready stays open):** everything lives in localStorage as today. **On signup, adopt the draft** — create `address → project → design` rows from local state in one transaction (this is the "claim your draft" moment). Sign-out clears local state.
- Only one design is "active" in localStorage at a time; switching designs = flush → clear → hydrate.

## Decisions (resolved)

1. **Address uniqueness → per-user** (`UNIQUE(user_id, formatted_address)`). Same physical address can recur across users (a new owner designs a yard a previous owner had) — so *not* global.
2. **Projects → `UNIQUE(address_id, yard_type)`, `yard_type` an extensible set** (front/back now; side/etc. later without a schema change). One project per yard type per address; scopes are sibling designs.
3. **Detection → always re-detect on any boundary redraw.** No feature-clipping optimization. (Inherited, un-redrawn boundaries still reuse features — no detection call.)
4. **Edit → overwrite the design's plan in place** (bump `generator_version`, regen), only when the user chooses "Edit this design." No history table; `edited_at` stamp only. Add versioning later if wanted.
5. **Selection → just `projects.selected_design_id`.** No richer design lifecycle (ordered/built) for now; `designs.status` stays minimal (`draft`/`archived`).
6. **Migration → drop the old `projects` blob table and start fresh.** Nothing to preserve.

## Relationship to the persistence doc

This **supersedes** the localStorage-blob approach in `project-persistence-auth-approach.md`: Part A (state manifest) and Part D (regeneration guard) are replaced by relational rows + per-design `generator_version` + the explicit edit-vs-new prompt. Still-valid pieces carry over: **Part B** (draft adoption at signup), **Part C** (autosave + Save & exit), **Part F** (concurrency), and clearing all `diy*` keys on sign-out.

## Phased rollout (deploy hold respected — build locally, deploy on request)

**Phase 0 — Schema & RLS (SQL for you to run in Supabase).** I write the migration: `addresses`, `projects`, `designs` with denormalized `user_id`, `UNIQUE` constraints, `ON DELETE CASCADE`, RLS policies (`user_id = auth.uid()` per table) + sync trigger; `DROP` the old `projects` table. Delivered as a reviewable `.sql` file — I can't run it against Supabase, so you apply it. Keep the pre-auth `address_exists` RPC (repoint at `addresses`).

**Phase 1 — Data layer + active-design cache.** Replace `projectsService` with typed CRUD (`addressesService`, `projectsService`, `designsService`) and one `activeDesign` module that hydrates a design row → localStorage and flushes localStorage → the row. Defines the design payload shape in one place. No UI/flow change yet; the app still works off localStorage, now backed by real rows.

**Phase 2 — Draft adoption + version stamping (non-regeneration wiring).** Anonymous flow stays in localStorage; **on signup, adopt** the local draft into `address → project → design`. Clear all `diy*` on sign-out. Stamp `generator_version` at *generation* time (so a design records the version it was actually made with). Deliberately does NOT touch regeneration/signature behavior — that pairs with the prompt in Phase 3 to avoid a confusing intermediate.

**Phase 3 — Regeneration UX + save UX (three chunks).**
- **3a (regeneration UX):** remove `inputSignature`'s silent auto-regen + drop the global `v` tag; on a post-draft input change, show a prompt — "Regenerate to match your changes, or keep the current plan?" Explicit regeneration only. `inputSignature` becomes a pure input-change detector.
- **3b (save UX):** debounced autosave + "Saving…/Saved ✓" + Save & exit against the design row (wires the `flushActiveDesign` hook that already exists).
- **3c (MyProjects):** rebuild to list addresses → projects → designs, restyled off the legacy Tailwind tokens.

**Phase 4 — Design gallery (chunked).**
- **4a — Start a new design:** the "or start a new one" half of edit-vs-new — a third RegenPrompt option (signed-in) that branches a sibling design row (old design preserved, new inputs + fresh plan in a new row).
- **4b — Gallery polish:** rename designs, set `selected`, archive, and per-design thumbnails in My Designs.
- **4c — Version-upgrade offer:** for a design on an old `generator_version`, offer "Regenerate with the improved planner."
- **4d — Compare (optional):** side-by-side view of two designs.

Each phase builds + tests green locally before the next; deploys only when you ask.
