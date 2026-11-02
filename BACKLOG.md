# Product backlog

Updated 2026-11-02. This file tracks **outstanding work only**. Implemented behaviour and release history belong elsewhere:
- [README.md](README.md);
- the [application changelog](web/src/changelog/entries.ts);
- the topic guides under `.claude/docs/`.

Entries are proposals, not delivery commitments.

**Status tags.** Every top-level item under a `##` section opens with one tag:
- `[next]`: what comes next;
- `[todo]`: confirmed, to do;
- `[new]`: proposed, not yet confirmed. That includes the decisions only the user can take. Claude adds items as
  `[new]`, and only the user promotes them;
- `[parked]`: deliberately set aside until a trigger;
- `[blocked]`: waiting on someone or something else.

The `backlog` mod (`liveweird/claude-mods`) summarises the tags on the status line and in `/backlog`.

## Increments (the roadmap, `.claude/docs/product.md`)

Each increment gets its own plan (architect) before implementation. The domain sketch is `.claude/docs/planning-model.md`; the timeline approach is `.claude/docs/timeline.md`.

- [new] **Paged lists for work streams and programs.** Projects and milestones have them since v0.4 (the dependency pickers); the plan view is still the only read surface of work streams and programs. Add theirs per `list-endpoints.md` with their first consumer.
- [new] **Flag a milestone that lost its last working day to a holiday (D2).** The schedule PUT refuses a span with no working day, but a holiday added later leaves such a milestone with its dates (it loads nothing and splits no idle gap); mark it on the project and team pages.
- [new] **A per-link slack figure in the Dependencies table.** The Slack column is per milestone; a link's own slack (`actual - required`) is already computed server-side for the critical path.
- [new] **The critical path on the team page / the roadmap.** It rides the project view only; the team view answers `critical: false` on its links and the roadmap has no path.
- [new] **Ghost rows for chain members beyond the direct neighbours, if the Critical chain list proves insufficient.** Farther chain members are a list (names, dates, hops, slack), not timeline rows.
- [new] **A cross-team proposal run.** The v0.8 proposal places ONE team's milestones with the other teams' dates fixed (a later run after another team accepted may move milestones again: the fixed point is per team). A run over several teams (or all) in dependency order would settle in one pass; it needs an ordering of the teams and a bigger preview.
- [new] **Auto-proposal alternatives the user did not choose (v0.8 Q1b/Q6b).** A keep-what-fits mode (a scheduled milestone keeps its dates while it still fits; Q1b), a start bound from the project's target window (Q6b), proposals that persist and can be shared or compared (today a proposal is ephemeral, a page-local state). Build one only if the pure re-plan proves too noisy.
- [new] **A "pin this milestone" flag for the proposal.** The proposal uses a milestone's current dates as a tiebreak only; a manager who wants one kept where it is has no way to say so except accepting the others. A per-milestone pin (kept as a fixed milestone by the kernel) would do it.
- [new] **Link warnings for the ticked subset only.** The proposal's link check assumes every move is accepted (v0.8 default); when a manager unticks moves the red "would violate" badges still describe the all-accepted plan. Recompute the verdicts client-side for the ticked subset, or ask the server for them.
- [next] **v0.9.0 Baselines.** Named snapshots at a plan revision; an overlay and a comparison view.

## Integrations (1.x)

- [new] **Flow teams/capacity import.** Read teams and their capacity from Flow instead of typing them (Flow's `teams/` and the capacity model are the source); decide the contract with Flow first.
- [new] **Jira/Flow deviation detection.** Sync with Jira and Flow only to detect deviations from the plan (corrections stay in Astrolabe, nothing is written back). Re-port Flow's `ingest/`, `fetch/`, `jira/`, the role switch (`plugins/Role.kt`) and `EncryptedAtRest`/`Reencrypt`, plus Lettuce's WireMock stub pattern (stub port 8096).

## Engineering follow-ups

- [new] **Measure the project view at the `upstream` cap.** On the regenerated sample plan (2026-11-02) the deepest chain is 5 hops and the largest `upstream[]` 39 entries: p50 ~17-18 ms, p95 ~18-20 ms, 15.6 KB, well inside the C10 budget (p50 <= 30 ms, p95 <= 45 ms, <= 120 KB); a plan whose `upstream` reaches the 100-row cap (or a critical chain longer than that) is still unmeasured.
- [new] **A sample reload over existing holidays fails.** `--reset` never removes holidays, and the loader schedules milestones before it applies the preset, so on a stack that already holds the Polish holidays a milestone whose whole span falls on holidays (e.g. offsets landing on 24-25 Dec) is refused with 400 "must cover at least one working day" mid-load. Apply the preset before scheduling, or skip/shift such spans, or document clearing the dictionary first.
- [new] **An apply-only mode for `--polish-holidays` on an already-loaded stack.** The loader applies the preset only as the last step of a full load; an existing sample plan cannot get the holidays without re-running it.
- [new] **Arrows follow a drag preview.** Today they redraw at drop.
- [next] **Slim the schedule proposal's `dependencies[]`.** On the sample plan's Platform team the proposal answers 170,731 B uncompressed (275 moves ≈ 63 KB, 184 link rows ≈ 99 KB, two resolved endpoint blocks being 68 % of each link row) against the original 150 KB budget, raised to 250 KB in v0.8 (`timeline.md` "Measured figures (v0.8)"). Send the endpoint ids (and the AFTER dates only for moved ends) and let the page join names from the team view it already holds.
- [next] **Table hover tint contrast.** The theme-wide `Table` `highlightOnHover` (`web/src/theme.ts`) tints the row under the pointer (`#f1f3f5` light, `#3b3b3b` dark); dimmed text on the dark tint is 4.44:1 and small red-8/red-5 text about 4.0:1, below AA. The Proposed schedule table (v0.8) turns the tint off; audit the other tables (an axe scan with a hovered row) and pick a tint that clears AA for dimmed and status text, or drop the theme default.
- [new] **Arrows between proposed bars in the schedule-proposal preview.** The team page's preview (v0.8) draws the dependency arrows on the CURRENT bars only and none ends on a proposal bar; the table's Links column carries the after-check. Draw the links between the proposed spans (a milestone with a second bar takes its arrow ends from the proposal bar, red when the proposal's check is `VIOLATED`) once the preview proves hard to read without them.
- [new] **Index arrow specs by row** for the virtual pages (the team page up to ~270 rows, the roadmap ~100 and the expanded programs tree ~125) if the per-frame filter shows in the profile; at those sizes the scroll holds the 60 Hz cap with the arrows on (v0.6 measurement, `timeline.md`).
- [new] **A `projectId` filter on `GET /milestones`** when the predecessor picker needs scoping.
- [new] **Time-axis virtualisation of the Timeline.** Rows are virtualised; the time axis is not (one wide track per row, and the header's per-day cells). Measured on the sample plan: the widest page is the v0.5 team page at week zoom (the largest team: a 14,308 px track, 511 days, 69 load-strip weeks, p50 16.7 ms / p95 ~18.5 ms per frame, 2,807 DOM nodes); the v0.6 roadmap and programs pages are far narrower (Quarter, the default: 2,466 px, Month 4,872 px, Year 1,826 px; p50 16.6 ms / p95 18.1-18.9 ms at every zoom, ~1,400 DOM nodes), because their zooms are coarser and their range is the plan's spans, not a team's weeks. So the v0.6 premise (a multi-year roadmap range) did not need it; revisit only if a page opens a track far beyond ~15,000 px (a longer plan, or week zoom on a plan page): virtualise the header and bands horizontally, or cap the range per zoom.
- [next] **Auto-proposal accept: detect team-scoped changes since the proposal (other milestones of the team, capacity, links) and warn or re-propose.** The batch's per-milestone STALE check only sees the milestones in the batch, so a drag of another milestone of the team, a capacity or a link change after the proposal goes unnoticed and the accepted moves can overload a week (shown as a warning on the team view afterwards); see `planning-model.md` "The auto-proposal".
- [new] **Timeline print/export.** A printable or exported (PNG/PDF) project timeline for status reports.
- [new] **Re-baseline the build-time budgets and coverage after v0.1.0.** Every row of `scripts/timings/budgets.json` is PROVISIONAL (carried over from Flow); record a `scripts/gates.sh all` series and the first CI medians, set the targets from them, add the first dated entry to `.claude/docs/build-times.md`, and re-measure the Kover floors (`server/build.gradle.kts`) and the vitest thresholds (`web/vite.config.ts`).
- [new] **Fork balancing.** Port Flow's weight-balanced class order (`balancedCandidateOrder`, `server/test-weights.tsv`, `local-times.mjs test-weights`) when `server-tests` outgrows its budget and a second fork starts to pay (`.claude/docs/test-fixtures.md` "Fork balancing (not ported)").
- [new] **kotlinx-datetime compile/runtime version skew.** `kotlinx-datetime-jvm` is only transitive (via Exposed): it resolves to 0.7.1 on the compile classpath and 0.8.0 at runtime (`server/gradle.lockfile`). The repo-local `LocalDateColumn` touches only `toKotlinLocalDate`/`toJavaLocalDate`, which both carry (`LocalDateColumnTest` runs on the runtime set), so nothing breaks today; find out why the two disagree (a platform/constraint in the Exposed or Ktor graph) and align them, or pin one version with a `checkDependencyAlignment` family, the next time Exposed or the Kotlin plugin moves.
- [new] **Re-arm the Netty read timeout per request.** Ktor's `KtorReadTimeoutHandler` fires once per connection, so a connection that idled past `requestReadTimeoutSeconds` once is never cut again (`security.md` "Slow requests", pinned by `RequestReadTimeoutTest`). Fix: a `main` that calls `EngineMain.createServer(args)` and sets `engine.configuration.channelPipelineConfig` to swap `readTimeout` for a repeating `ReadTimeoutHandler` plus a tail handler that swallows the `ReadTimeoutException` (also silences the Netty tail WARN). It needs `mainClass` changed in `server/build.gradle.kts` (and the AppCDS class list regenerated, `CdsClassListTest`), and it must first be checked that a `channelPipelineConfig` set after `createServer` is honoured; or enforce `client_body_timeout` at an ingress.
- [new] **View revisions as ETags must cover the non-plan writes.** A team rename, a person rename, a `ROADMAP_EDITOR` grant or a person's login-link change alter what the plan/project/team/roadmap/programs views return (names, `can` flags) without bumping the plan revision (people and teams are not plan state). Harmless while the revision only guards writes; the first view ETag (`ResponseValidators`) must fold these in.
- [new] **Program-level rolled-up arrows.** The roadmap and programs pages draw one arrow per project pair (and each direct project link); a collapsed program or work stream draws none. Roll the links up one more level so a folded tree still shows what depends on what.
- [new] **A severity filter on the flag panel.** The roadmap's flag panel lists every flag of the visible rows (208 warnings and 52 infos on the sample plan); warnings only / infos only would shorten it without hiding the row icons.
- [new] **Reconsider the inversion rule if the flag panel grows.** The rule raises one flag per adjacent pair per team (184 on the sample plan; all pairs would be 1,038); if it changes to all pairs, the panel becomes a report and needs grouping or paging first.
