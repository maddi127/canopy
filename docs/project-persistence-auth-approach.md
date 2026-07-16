# Project persistence, auth flow & save UX — approach

*Covers review items 1 (plan not saved), 2 (regeneration clobbers edits), 4 (incomplete state clearing), plus re-introducing the auth flow and the Save & exit button. For review before implementation.*

## What's broken today (one paragraph)

A "project" is a snapshot of 26 enumerated localStorage keys (`DIY_STATE_KEYS` in `projectsService.ts`) — but the app writes ~40 keys, and the missing ones are the product itself: `diyPlacementPlan`, `diyPlantInstances`, the plan signature, sun map, privacy targets, street-view insights. So saving a project stores the *inputs* but not the *design*; loading one actively deletes the design. Separately: the regeneration gate compares a stored signature that is never persisted, so a reload can silently regenerate over user edits; `signOut` clears nothing (shared-browser leak); and `clearLocalState` only clears the enumerated keys, so old-design state leaks into new designs.

## Design principles

1. **The user's design is sacred.** No code path may silently destroy an edited plan. Regeneration becomes explicit whenever edits exist.
2. **One manifest.** A single module defines what "project state" is; save, load, clear, autosave, and migration all derive from it. No more drift between what's written and what's saved.
3. **Anonymous-first, account = durability.** The flow through plan-ready stays open (that's working well). An account doesn't gate access to the draft — it makes the draft *permanent*. Signup is the "claim your draft" moment.
4. **Versioned payloads, forever.** Every saved bundle carries a `schemaVersion`; loads migrate forward. We never again load an old shape into new code blind.

---

## Part A — State manifest & versioned bundle (foundation)

New module `src/services/projectState.ts`:

- **`PROJECT_MANIFEST`** — the complete list of state keys. Adds the 9 missing keys (`diyPlacementPlan`, `diyPlantInstances`, `diyPlacementPlanSig`, `diyPlacementPlanOriginal`, `diySunMap`, `diyPrivacyTargets`, `diyStreetView`, `diySiteZones`, `diyHouseAttributes`) plus a new `diyPlanEdited` flag (Part D). Drops the 7 ghost keys with no writers (`conceptFeatures`, `diyQueueIdx`, `diyDensity`, `diySystemFills`, `diyFinalConcept`, `diyRoundCount`, `diyIdentifyDone`).
- **Bundle format v1**: `{ schemaVersion: 1, savedAt, keys: { ... } }`. Loading a row without `schemaVersion` = v0 (today's raw key-map) → migrated in `applyLocalState`. Future shape changes bump the version and add a migration step — mechanical from then on.
- **Wildcard hygiene**: `clearLocalState()` and `applyLocalState()` first remove **every** key matching `/^diy/` plus the explicit non-diy names (`userPreferences`, `siteContext`, `initialAddress`, `generatedConcept`, `draft*`), *then* write the bundle. No more leaks between designs, projects, or users.
- Parse failures get logged (console.warn at minimum; Sentry later) instead of swallowed.

*Riding along:* while touching `projectsService`, add defensive `user_id` scoping to list/update/delete and export the assumed RLS policies as committed SQL (review item 16).

## Part B — Auth flow & draft adoption

The auth *placement* doesn't change (preferences → boundary → plan-ready stay open; "Refine the plan" gates on account). What changes is what happens at the gate:

1. **Signup/sign-in arriving from the flow** (`state.from` present): **adopt the local draft** — create a project row from current local state, auto-named from the address ("Draft — 123 Maple St"), set `activeProjectId`, continue to `state.from`. The user never sees a save step; their draft just becomes permanent.
2. **Sign-in with existing saved projects AND a live local draft**: adopt the draft as a *new* project (never merge, never discard), then land wherever they were headed. They can delete it from /projects later. (Open question 2 below.)
3. **Sign-in from the homepage** with no meaningful local draft: go to `/projects`.
4. **Sign-out**: flush any pending save → wildcard-clear all local state → navigate home. User B on a shared browser starts clean.

(AuthPage's visual rebuild is a separate visual-workstream item; this work only touches its post-auth behavior.)

## Part C — Save UX: autosave + Save & exit

1. **Autosave** (signed-in with `activeProjectId`): a small app-level hook polls a cheap hash of the manifest keys every ~5s; on change, debounced `updateProject` (~4s after last change), plus a flush on route change and `visibilitychange → hidden`. Polling-the-manifest beats instrumenting every `setItem` call site — zero changes to existing pages.
2. **Save indicator + Save & exit** — one compact header control on the auth-gated screens (auto-layout/placement, plants, review): "Saving… / Saved ✓", with **Save & exit** = flush + navigate to `/projects`. Reuses the existing `useSaveAndExit` / `SaveProjectButton` plumbing where it fits.
3. Anonymous users (pre-auth pages) see nothing — their state lives in localStorage as today, until adoption at signup.

## Part D — Regeneration guard (never clobber)

1. **Persist the signature** — free once it's in the manifest.
2. **New `diyPlanEdited` flag** — set on any manual mutation in the placement editor (zone move/resize/shape/material, bed draw/delete, path edit, plant swap, density change); cleared whenever a fresh generation runs.
3. **New regeneration rule** in `DiyAutoLayoutPage` + `DiyPlanReadyPage`:
   - No plan → generate.
   - Plan exists, signature matches → keep.
   - Signature mismatch, **not** edited → regenerate silently (nothing to lose).
   - Signature mismatch, **edited** → **keep the plan** and show a non-blocking chip: "Your site inputs changed — Regenerate plan?" Explicit action only.
4. **Street view is PARKED (done — implemented ahead of the rest).** Investigation showed its live payoff is thin: the only clearly user-visible consumer today is the side-gate walkway (and only when a gate is detected); the mailbox/porch beds are dormant (accent beds disabled) and the roof-type only renders on the standalone `/diy/yard-3d` page, not the main flow. Rather than build prefetch + edited-flag handling around a low-value async input, we gated it off behind a single flag `STREET_VIEW_ENABLED = false` (`streetViewService.ts`): the boundary page skips the per-session Gemini vision call, and `inputSignature` ignores any (stale) `diyStreetView` entry. This removes the whole race/clobber class for street view at near-zero cost, and also drops the up-to-8s wait on the boundary→plan transition. Re-enable = flip the flag when accent beds / 3D return to the main flow. NOTE: the signature no longer includes the `street` field, so front-yard users who had cached insights will regenerate once on their next visit (we deliberately did NOT bump `v`, keeping the blast radius to only those users; back-yard / no-SV users are unaffected). The edited-flag below is now the *sole* regeneration guard and covers all remaining triggers (manual input changes, generator-version bumps).

## Part E — Project switching (deliberately deferred choice)

Keep the single global localStorage namespace for now — with Part A's wildcard clear, switching becomes: flush → clear everything → load bundle. Correct, simple, and only one project is ever open. Per-project key prefixes (`project:<id>:…`) are the eventual multi-tab-safe model but a big refactor for little marginal value today; noted as future work.

## Part F — Concurrency (last phase)

1. `updateProject` gains optimistic concurrency: send the last-seen `updated_at`, match on it; zero rows updated → conflict → refetch + "This project was updated elsewhere" prompt.
2. A `storage`-event listener detects a second tab switching projects or rewriting plan keys → soft warning rather than silent last-writer-wins.

---

## Phasing (each independently shippable; deploy hold respected)

| Phase | Contents | Size | Value |
|---|---|---|---|
| **1** | Manifest + missing keys + versioned bundle + wildcard clear + signOut clearing (+ RLS ride-along) | Small | Save/load actually works; no cross-user leaks |
| **2** | `diyPlanEdited` + regen rule + signature stabilization | Small | Edits can never be silently destroyed |
| **3** | Draft adoption at signup + autosave + Save & exit UI | Medium | The re-introduced auth/save experience |
| **4** | Optimistic concurrency + multi-tab detection | Small-med | Hardening |

## Open questions

1. **Multiple projects per account** is the assumption (it's what /projects implies) — confirm.
2. On sign-in with an existing local draft: always **adopt as a new project** (recommended, never lose work) — or prompt the user?
3. Autosave cadence OK (~4–5s debounce)? Indicator in the editor header?
4. Anonymous drafts currently survive browser restart via localStorage — keep that behavior?
5. Auto-naming projects by address OK? ("Draft — 123 Maple St")
6. `/projects` (MyProjectsPage) is visually legacy (Tailwind tokens) — restyle it as part of Phase 3, or leave for the visual workstream?
