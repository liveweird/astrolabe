# Product backlog

Updated 2026-10-31. This file tracks **outstanding work only**. Implemented behaviour and release history belong elsewhere:
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
- [new] **v0.5.0 Team view + capacity.** Capacity periods; the weekly load strip and overload warning; team order override/reset; scheduling from the team view; a deterministic scale dataset `sample-data/plan/` (≈15 teams, 5 streams, 20 programs, 100 projects, 1,000 milestones).
- [new] **v0.6.0 Roadmap + programs timelines.** Spans derived upward; the target window by drag; drift flags; rank-vs-time flags (an inversion between projects sharing a team is a warning, otherwise info); the program pick.
- [new] **v0.7.0 Calendar + critical path.** Port Flow's `PublicHoliday*`/`WorkingCalendar`/`WorkingDayIndex` (replaces `infra/time/WorkingDays.kt`, the Mon–Fri placeholder, and its closed-form working-day index that the v0.4 dependency checks use, with holidays); the critical path; idle gaps per project and team.
- [new] **v0.8.0 Auto-proposal.** A server scheduler (rank + dependencies + capacity) → a diff preview → accept all or some through the batch schedule endpoint, under the same guards.
- [new] **v0.9.0 Baselines.** Named snapshots at a plan revision; an overlay and a comparison view.

## Integrations (1.x)

- [new] **Flow teams/capacity import.** Read teams and their capacity from Flow instead of typing them (Flow's `teams/` and the capacity model are the source); decide the contract with Flow first.
- [new] **Jira/Flow deviation detection.** Sync with Jira and Flow only to detect deviations from the plan (corrections stay in Astrolabe, nothing is written back). Re-port Flow's `ingest/`, `fetch/`, `jira/`, the role switch (`plugins/Role.kt`) and `EncryptedAtRest`/`Reencrypt`, plus Lettuce's WireMock stub pattern (stub port 8096).

## Engineering follow-ups

- [new] **Edit a dependency in place.** `PUT /dependencies/{id}` for the type or lag; the cycle check re-runs without the edited edge (today: delete + add).
- [new] **Arrows follow a drag preview.** Today they redraw at drop.
- [new] **Index arrow specs by row** for the 1,000-row virtual pages (v0.5/v0.6) if the per-frame filter shows in the profile.
- [new] **A `projectId` filter on `GET /milestones`** when the predecessor picker needs scoping.
- [new] **Time-axis virtualisation of the Timeline.** Rows are virtualised; the time axis is not (one wide track per row), which is fine for a project's months but not for the multi-year v0.6 roadmap range: virtualise the header and bands horizontally, or cap the range per zoom.
- [new] **Batch schedule reuses `schedule_revision`.** The v0.8 auto-proposal accepts several moves at once through a batch schedule endpoint; keep the per-milestone staleness check of `PUT /milestones/{id}/schedule` (a 409 per milestone moved since the proposal), not a global revision compare.
- [new] **Timeline print/export.** A printable or exported (PNG/PDF) project timeline for status reports.
- [new] **Re-baseline the build-time budgets and coverage after v0.1.0.** Every row of `scripts/timings/budgets.json` is PROVISIONAL (carried over from Flow); record a `scripts/gates.sh all` series and the first CI medians, set the targets from them, add the first dated entry to `.claude/docs/build-times.md`, and re-measure the Kover floors (`server/build.gradle.kts`) and the vitest thresholds (`web/vite.config.ts`).
- [new] **Fork balancing.** Port Flow's weight-balanced class order (`balancedCandidateOrder`, `server/test-weights.tsv`, `local-times.mjs test-weights`) when `server-tests` outgrows its budget and a second fork starts to pay (`.claude/docs/test-fixtures.md` "Fork balancing (not ported)").
- [new] **kotlinx-datetime compile/runtime version skew.** `kotlinx-datetime-jvm` is only transitive (via Exposed): it resolves to 0.7.1 on the compile classpath and 0.8.0 at runtime (`server/gradle.lockfile`). The repo-local `LocalDateColumn` touches only `toKotlinLocalDate`/`toJavaLocalDate`, which both carry (`LocalDateColumnTest` runs on the runtime set), so nothing breaks today; find out why the two disagree (a platform/constraint in the Exposed or Ktor graph) and align them, or pin one version with a `checkDependencyAlignment` family, the next time Exposed or the Kotlin plugin moves.
- [new] **e2e roadmap flake under parallel plan writes.** The ranking's `expectedRevision` is the global plan revision, so every plan write by another Playwright worker (milestones, dependencies, the accessibility fixture) makes a rank PUT stale; the page retries 8 times and gives up with "the roadmap kept changing under the page". Seen as a 1-in-3 flake of `roadmap.spec.ts` ("an admin grants the roadmap editor right…") and the dark-scheme `/roadmap` accessibility scan once v0.4 added its plan-writing specs (2026-11-01). Options: a ranking-only revision (`roadmap_entries` changes) instead of the plan's; serialise the plan-writing specs; or back off between retries. Decide whether real concurrent editing at scale has the same problem first.
- [new] **Telemetry e2e after an app-only restart.** `docker compose up --build -d app` on an existing volume keeps the previous container's process LIVE (not yet stale) for a while, so `telemetry.spec.ts`'s "exactly one live process" wait (90 s) times out for its three sample-reading tests; a fresh `down -v` stack or a few minutes' wait passes. Either shorten the staleness window for a process whose successor has sampled, or let the spec accept the newest live process.
- [new] **Request body-read timeout.** Netty has none (`requestReadTimeoutSeconds` is unset), so a client can hold a request open after the route's guard by sending its body slowly; the plan writes re-guard under the `plan_state` lock so authorization no longer depends on it, but configure a body-read timeout (Netty `requestReadTimeoutSeconds`, or at the proxy) to bound slow-body requests generally.
