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

- [new] **v0.2.0 Plan structure.** People (a directory with an optional link to a login); work streams, programs and projects CRUD with owners and owner-scoped guards; a team's manager becomes a Person; the `ROADMAP_EDITOR` grant; the Plan tree page; the Roadmap ranked list (dnd-kit sortable plus keyboard move up/down, an "Unranked" group).
- [new] **v0.3.0 Timeline + project view.** The shared `Timeline*` component (zoom, non-working hatching, today line, virtualisation, drag/resize with a keyboard path); milestones CRUD; `PUT /milestones/{id}/schedule` (team manager or ADMIN); the Unscheduled tray; derived project span and target band.
- [new] **v0.4.0 Dependencies.** Four types (FS/SS/FF/SF) plus lag across all three endpoint kinds; SVG arrows; cycles answer 409; red violations and a conflict list (warn only); ghost rows for external endpoints.
- [new] **v0.5.0 Team view + capacity.** Capacity periods; the weekly load strip and overload warning; team order override/reset; scheduling from the team view; a deterministic scale dataset `sample-data/plan/` (≈15 teams, 5 streams, 20 programs, 100 projects, 1,000 milestones).
- [new] **v0.6.0 Roadmap + programs timelines.** Spans derived upward; the target window by drag; drift flags; rank-vs-time flags (an inversion between projects sharing a team is a warning, otherwise info); the program pick.
- [new] **v0.7.0 Calendar + critical path.** Port Flow's `PublicHoliday*`/`WorkingCalendar`/`WorkingDayIndex`; the critical path; idle gaps per project and team.
- [new] **v0.8.0 Auto-proposal.** A server scheduler (rank + dependencies + capacity) → a diff preview → accept all or some through the batch schedule endpoint, under the same guards.
- [new] **v0.9.0 Baselines.** Named snapshots at a plan revision; an overlay and a comparison view.

## Integrations (1.x)

- [new] **Flow teams/capacity import.** Read teams and their capacity from Flow instead of typing them (Flow's `teams/` and the capacity model are the source); decide the contract with Flow first.
- [new] **Jira/Flow deviation detection.** Sync with Jira and Flow only to detect deviations from the plan (corrections stay in Astrolabe, nothing is written back). Re-port Flow's `ingest/`, `fetch/`, `jira/`, the role switch (`plugins/Role.kt`) and `EncryptedAtRest`/`Reencrypt`, plus Lettuce's WireMock stub pattern (stub port 8096).

## Engineering follow-ups

- [new] **Re-baseline the build-time budgets and coverage after v0.1.0.** Every row of `scripts/timings/budgets.json` is PROVISIONAL (carried over from Flow); record a `scripts/gates.sh all` series and the first CI medians, set the targets from them, add the first dated entry to `.claude/docs/build-times.md`, and re-measure the Kover floors (`server/build.gradle.kts`) and the vitest thresholds (`web/vite.config.ts`).
- [new] **First push and CI green on GitHub (`liveweird/astrolabe`).** Add the remote, push, watch `ci.yml` go green, dispatch `e2e.yml`; enable Dependabot security updates and vulnerability alerts (the owner's call). Tag/release `v0.1.0` only when asked (`.claude/docs/app-releases.md`).
- [new] **Fork balancing.** Port Flow's weight-balanced class order (`balancedCandidateOrder`, `server/test-weights.tsv`, `local-times.mjs test-weights`) when `server-tests` outgrows its budget and a second fork starts to pay (`.claude/docs/test-fixtures.md` "Fork balancing (not ported)").
- [new] **kotlinx-datetime compile/runtime version skew.** `kotlinx-datetime-jvm` is only transitive (via Exposed): it resolves to 0.7.1 on the compile classpath and 0.8.0 at runtime (`server/gradle.lockfile`). The repo-local `LocalDateColumn` touches only `toKotlinLocalDate`/`toJavaLocalDate`, which both carry (`LocalDateColumnTest` runs on the runtime set), so nothing breaks today; find out why the two disagree (a platform/constraint in the Exposed or Ktor graph) and align them, or pin one version with a `checkDependencyAlignment` family, the next time Exposed or the Kotlin plugin moves.
- [new] **Request body-read timeout.** Netty has none (`requestReadTimeoutSeconds` is unset), so a client can hold a request open after the route's guard by sending its body slowly; the plan writes re-guard under the `plan_state` lock so authorization no longer depends on it, but configure a body-read timeout (Netty `requestReadTimeoutSeconds`, or at the proxy) to bound slow-body requests generally.
