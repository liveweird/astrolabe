# E2E (Playwright, blackbox)

Browser end-to-end tests that treat the app as a **blackbox**: they drive a real Chromium against
the whole stack (SPA + server + Flyway + Postgres) served single-origin at `http://localhost:8086`
by `docker compose`. This package is fully isolated from `web/` — it imports none of the app source
and only speaks HTTP/DOM.

## Run

```bash
cd e2e
npm install
npm run install:browsers      # one-time: download Chromium
npm test                      # reuses or starts the stack, runs specs, leaves the stack intact
```

- `global-setup.ts` starts `docker compose up -d --build` and waits for `:8086` — **unless a stack
  is already running there**, which it reuses (fast local iteration: keep `docker compose up` or a
  local `WEB_STATIC_DIR=… ./gradlew :server:run` going and just run `npm test`).
  The nightly `e2e.yml` builds the image and starts the stack in their own workflow steps first (so the
  time is attributable per step, `.claude/docs/build-times.md`), and setup then just reuses it.
  Setup never tears down services or volumes, including after a failed start or test run. Tests
  clean up only the records they own; existing demo data stays intact.
- Docker is needed only when starting the default stack. `E2E_BASE_URL` can target an already
  running stack; an unavailable custom URL fails without starting the default Compose project.
  (8086 — see `docker-compose.yaml`.)
- `E2E_JIRA_STUB_URL` (default `http://localhost:8096`, the compose stack's `jira-stub`: WireMock over the sample Jira dataset) is the admin API
  `jira-sync.spec.ts` flips the `jira-day2` scenario through (`PUT /__admin/scenarios/jira-day2/state`; the app itself reaches the stub as `jira-stub:8080`
  over the compose network, so this URL is only the spec's own handle on it). Point it at the stub of the same stack as `E2E_BASE_URL` when that one is not
  the default. Without a stub the Jira spec's beforeAll fails (it resets the scenario first).
- `E2E_FLOW_STUB_URL` (default `http://localhost:8097`, the compose stack's `flow-stub`: WireMock over the sample Flow dataset) is the admin API `flow-sync.spec.ts` READS in its beforeAll to prove the stub's `flow-day2` and `flow-outage` scenarios are at `Started` (day one's figures are what it asserts; it fails fast naming the scenario otherwise) and `flow-capacity-deviation.spec.ts` WRITES to flip `flow-day2` (`PUT /__admin/scenarios/flow-day2/state`, reset in its beforeAll and afterAll; the lock `flow-stub-scenario` keeps the two files apart). `E2E_FLOW_STUB_ORIGIN` (default `http://flow-stub:8080`) is the address the APP reaches that stub at, the base URL of every connection these specs create: the compose network name, listed in the app's `FLOW_INSECURE_ORIGINS`. Point the first at the stub of the same stack as `E2E_BASE_URL` when that one is not the default. The specs read the stub's token, totals and "E2E Flow Team" figures from `sample-data/flow/expected.json` in the checkout.
- `jira-polling.spec.ts` needs the stack's **scheduler** on (the compose default, `SYNC_SCHEDULER_ENABLED=true`: a tick every 60 s, the first 10 s after start): it waits up to two minutes for a scheduled
  run of a connection it made. Against a stack that runs with `SYNC_SCHEDULER_ENABLED=false` its first and third scenarios fail by design (no run ever comes).
- `E2E_MAILPIT_URL` (default `http://localhost:8029`, the compose stack's Mailpit) is the catcher the two email specs
  (`mfa.spec.ts`, `password-reset.spec.ts`) read; point it at the Mailpit of the same stack as `E2E_BASE_URL` when that one is
  not the default (an isolated compose project has its own Mailpit port). Reading another stack's catcher makes those two specs fail (or skip).

Docker-free gates ride every spec change — run them before merging, like the web
package's lint/knip:

```bash
npm run typecheck             # tsc --noEmit — Playwright only TRANSPILES TS, it never checks it
npm run check:scenarios       # spec ↔ scenario parity: files exist, test() titles == headings
npm run test:setup            # stack reuse/start/failure paths preserve services and data
```

`check:scenarios` enforces the same-commit rule below mechanically (both directions, orphan
files included); `accessibility.spec.ts` is its registered skip — the parameterized-title
carve-out in [`scenarios/README.md`](scenarios/README.md).

## Parallel execution

The suite runs on **4 workers by default** (`E2E_WORKERS` overrides; the `e2e.yml` `workflow_dispatch` form has a `workers` input for A/B runs; `E2E_WORKERS=1` restores
fully-serial behavior). The serial unit is the **spec file** (`fullyParallel: false` — a file's
tests may be order-dependent); different files run concurrently. That is only sound because
**every spec file owns its server-side state exclusively** — the standing rulebook that any new or
edited spec must satisfy:

- Each spec's scenario file declares its **Owns** line (exclusive server-side state; "nothing —
  read-only" when applicable). Today: `auth`, `changelog` and `shell` (device-local
  localStorage only) are read-only; `accessibility` owns one API-seeded fixture team
  (`e2e-axe-team-*`, with one capacity period carrying a WIP limit of 1) and one API-seeded fixture plan (`e2e-axe-*`, with two milestones in one project, a second project linked as a violated predecessor and a chain project whose zero-slack links feed the critical path) and, for the open-schedule-proposal scans, a second team pair with its own plan (`e2e-axe-prop-*`, dated in 2042; seeded twice, once by that describe and once by the detail-pages block for the hovered-row scan) and, for the baseline scans, a third world of its own with one throwaway baseline (`e2e-axe-bl-*`, dated in 2026, taken in the describe's beforeAll after the plan nodes exist, the plan then re-planned under it, soft-deleted in its afterAll) and, for the Jira page scans, a fourth world of its own (`e2e-axe-jira-*`, dated in 2044: a plan, one milestone, one manual-only Jira connection scoped to the stub's `E2E` project on a unique throwaway site, run once manually in the beforeAll (its status reads Current), and one binding to the stub's `E2E-4` that the acknowledged-item scan acknowledges and withdraws again in a `finally`, deleted in its afterAll with the connection first) and, for the Flow page scans, a fifth world of its own (`e2e-axe-flow-*`: a team linked to the stub's "Axe Flow Team" and one manual-only Flow connection to the stub, tested once through the API - one call of the `flow-test` bucket - and read once in the beforeAll, deleted in its afterAll with the connection first); `users` owns its throwaway accounts; `teams` owns its throwaway teams (unique `e2e-team-*` / `e2e-esc-team-*` names), person and user; `people` owns its throwaway people (unique `e2e-person-*` names) and users; `plan` owns its throwaway people, team, work streams, programs, projects (unique `e2e-plan-*` names) and users; `project-view` owns its throwaway users, people, team, plan nodes and milestones (unique `e2e-pv-*` names), all seeded and removed through the API (the project first, its milestones go with it); `dependencies` owns its throwaway users, people, team, two projects with a milestone each and the links between them (unique `e2e-dep-*` names), all seeded and removed through the API (the projects first, their milestones and links go with them); `team-view` owns its throwaway users, people, team (with its capacity periods and its order) and plan nodes (unique `e2e-tv-*` names), all seeded and removed through the API (the project first, its milestones go with it; the team's order has its own revision, so an order write never depends on another spec's plan writes); `roadmap` owns its throwaway people, plan nodes, one team with scheduled milestones (the target-window test; they leave with their projects) (unique `e2e-rm-*` names) and users, and ranks only its own projects (the global ranking is shared, append-only state: its page is narrowed to its own program by the program pick, a browser setting, assertions are about the relative order of its own rows, and a stale-revision refusal caused by another spec's ranking write or the delete of a ranked project is retried); `programs` owns its throwaway people, team, work stream, two programs, three projects with scheduled milestones, one project link (unique `e2e-pg-*` names) and users, all seeded and removed through the API (the users through the Users page), never writes the global ranking, and narrows its pages to its own programs with the program pick (a browser setting); `public-holidays` owns **every holiday dated 2040** (the dictionary is global; see the far-off-year rule below), its throwaway reader user and the calendar test's throwaway plan nodes (unique `e2e-hol-*` names); `critical-path` owns its throwaway owner user, people, two teams, work stream, program, three projects with their milestones and links (unique `e2e-cp-*` names), all dated in 2041; `schedule-proposal` owns its throwaway owner and manager users, people, a team with one capacity period, work stream, program, project, three milestones and a link (unique `e2e-sp-*` names), all dated in 2042, seeded per test and removed through the API (the project first), so its tests never share a row; `baselines` owns its throwaway owner and manager users, people, a team, work stream, program, project and milestones (unique `e2e-bl-*` names), all dated in 2043, and its throwaway **baselines** (unique `e2e-bl-*` names, each test takes its own and soft-deletes it first, the only delete there is: the frozen rows stay, by design) - baselines are plan-wide shared state (each a copy of the whole plan, at most 100 active), so no assertion counts rows or assumes the list is empty or holds only these, and the browser-stored pick is per browser context, so it never reaches another spec; `i18n` owns its throwaway user (and ONLY that user's
  language — **seeded accounts must stay English**: every login applies the stored language to
  that session's UI, so a Polish seed admin would flip parallel specs mid-run); `password-reset`
  owns its throwaway account (its reset requests use unique per-run emails against the
  in-memory per-email throttle, and both tests together stay under the per-IP 5/min request
  bucket and the 10/min confirm bucket); `mfa` owns its throwaway accounts and toggles ONLY their MFA flags (the seed admin's
  MFA flag is never touched — enabling it would make every spec's login demand a code);
  `list-mutation-refresh` owns its own uniquely named users/teams, created and deleted through
  the real API — all deleted by their own spec; `telemetry` owns one throwaway user; `jira-sync` owns its Jira connections (unique `e2e-jira-*` names, each scoped to the stub's `E2E` project ONLY - a scope the stub does not list (it answers `E2E`, the five work-stream keys, those plus `E2E`, `IMP` and `COV` in every shape, and each of the five work-stream keys alone for the typed full read only) hits its misleading 401 catch-all, `IMP` is the import spec's and `COV` the coverage spec's - on a unique throwaway site, so a Jira item is bound once per site and no other spec's or the user's own connection ever meets one of its bindings), their bindings and, per linking test, its project-owner login, people, team, work stream, program, project and milestones (unique `e2e-jira-*` names, all dated in **2044**), all seeded and removed through the API (the connection first: its bindings go with it, then the project and the rest), and it **alone flips the stub's `jira-day2` scenario** (the stub is one process with one state; its fifth and sixth scenarios both do, one after the other): `test.describe.configure({ mode: "serial" })`, the beforeAll resets the scenario to `Started`, and the afterAll resets it even after a failure. The sixth scenario's world also links its project to the stub's `E2E-2` (a project-level binding beside the milestone's `E2E-6`) and narrows the roadmap to its own program with the program pick. Test connection and Peek share a per-IP bucket across the whole suite (10 a minute by default, 30 on the e2e stacks: `JIRA_TEST_RATE_LIMIT_PER_MINUTE` in `docker-compose.yaml` and `k8s/local/front-door.yaml`), so the Jira spec spends five calls (one more per retry of its serial group: CI runs with `retries: 2`, which spends the bucket again) and the accessibility Jira describe one, and `jira-import` one per worker start of its file plus one for its five-key preview test's own connection, and `jira-polling` and `jira-coverage` one per worker start of their file (a failed test restarts the worker and runs its beforeAll again, so the calls are per start, not per run; a clean run of the five Jira files spends 5 + 1 + 2 + 1 + 1 = 10 of the 30 a minute (all of the default 10, which is why the e2e stacks raise it), and each restart of `jira-sync`'s group spends its five again), and no accessibility scan presses either; the Jira spec scans the result tables it shows (Test connection green and failed, Peek) with axe itself, at no extra call. `jira-polling` owns two Jira connections (`e2e-poll-scheduled-*`, polled every 5 minutes and tested once per worker start of its file, and `e2e-poll-manual-*`, manual only and never tested), each scoped to the stub's `E2E` project on a unique throwaway site; it binds nothing, creates no plan node and dates nothing (so no year and no holiday), never flips the stub, and relies on the stack's scheduler (it waits up to two minutes for a scheduled run of its connection, and its connections run for nothing, calling Jira for no bound item); `jira-import` owns one Jira connection (`e2e-import-connection-*`, scoped to the stub's `IMP` project on a unique throwaway site, tested once per worker start of the file through the API in its beforeAll: one more call of that bucket, and a 429 there waits the minute out once) and, per test, a throwaway ADMINISTRATOR login (the import's preview and apply share a 5-a-minute bucket per USER), a person, a team and a work stream (unique `e2e-import-*` names) and what the import creates under that stream with **the stub's own names** ("IMP Program", "IMP Initiative Alpha/Beta", the epics), all dated **2045**; program names are global and the stub's `IMP` is one shared fixture, so it is the only spec that may import `IMP` (Playwright lock `jira-import-stub`), it never applies into an existing work stream, removes its tree in the afterEach (bindings, projects, programs, stream, team, person, login) even after a failure, and its beforeAll sweeps a crashed run's `e2e-import-*` connections and work-stream trees but refuses to touch an "IMP Program" under any other work stream (it fails fast, naming it); `jira-coverage` owns one Jira connection (`e2e-cov-connection-*`, scoped to the stub's `COV` project ONLY on a unique throwaway site, manual only, tested once per worker start of the file through the API in its beforeAll: one more call of that bucket, and a 429 there waits the minute out once), its three bindings (the project to `COV-2`, two milestones to `COV-3` and `COV-4`; `COV-5` and `COV-10` are never bound), its runs (one in the beforeAll, one in the last test) and one throwaway world (a person, a team, a work stream, a program, the project `e2e-cov-project-*` and three milestones, unique `e2e-cov-*` names, all dated **2046**), all seeded and removed through the API (the bindings first, then the connection, then the project and the rest), even after a failure; it acts as the seed administrator, never flips the stub (`COV` is untouched by day 2) and needs no lock. `flow-sync` owns two Flow connections (unique `e2e-flow-*` names, both manual only, pointed at the Flow stub as `E2E_FLOW_STUB_ORIGIN` with the stub's token from `sample-data/flow/expected.json`: `e2e-flow-shared-*`, made through the API in the beforeAll, tested and refreshed there, and `e2e-flow-ui-*`, made in the first scenario's modal, tested and refreshed there), the link of its team to the stub's "E2E Flow Team", the six capacity periods the import writes (they go with the team) and a throwaway world (a team-manager login, a viewer login, the manager's person and the team `e2e-flow-team-*`, all dated in **2047**), all seeded and removed through the API (the connections first - their link goes with them - then the team and the rest); it never flips the stub's `flow-day2` / `flow-outage` scenarios (it reads them and fails fast if a walk left one flipped), never presses "Link all suggested" (that would link the demo plan's teams) and holds the Playwright lock `flow-stub-scenario` (below). `flow-capacity-deviation` owns one Flow connection (`e2e-capdev-connection-*`, manual only, made through the API, tested and refreshed in the beforeAll: one more call of the `flow-test` bucket per worker start of its file, so a clean run of the three Flow files spends 2 + 1 + 1 = 4 of the 30 a minute), the team `e2e-capdev-team-*` linked to the stub's "E2E Flow Team" and the team `e2e-capdev-gone-*` linked to the stub's "Billing" (both on that connection, so no other spec's link is ever met), a team-manager login and its person (unique `e2e-capdev-*` names), the six capacity periods the import writes (they go with the team) and, all dated in **2047** (shared with `flow-sync`; nothing writes a holiday there), **alone flips the stub's `flow-day2` scenario**: the beforeAll puts it back to `Started` and fails fast naming `flow-outage` if a walk left that one on, the second scenario resets it as soon as its connection's mirror has read day two and the afterAll resets it even after a failure; everything is removed through the API (the connection first). The Deviations page lists every linked team of the stack, so it narrows each page to its own team with the `teamId` filter. **The `flow-test` bucket** (Test connection on a Flow connection) is its own per-IP bucket, apart from Jira's (10 a minute by default, 30 on the e2e stacks: `FLOW_TEST_RATE_LIMIT_PER_MINUTE` in `docker-compose.yaml` and `k8s/local/front-door.yaml`): `flow-sync` spends two per worker start of its file (the beforeAll's API test and the first scenario's UI test; a failed test restarts the worker and runs the beforeAll again) the accessibility Flow describe one and `flow-capacity-deviation` one, so a clean run spends 4 of the 30 a minute.
- **The holiday dictionary is global, and its year is owned.** A public holiday applies to every team's calendar, so adding one changes the
  working-day figures (a dependency's "needs" date, slack, idle gaps, weekly load) of every plan that has a day in its year, and bumps the plan
  revision (no client write is staled by it). Therefore **only `public-holidays.spec.ts` writes holidays, and only in 2040**: it sweeps
  every 2040 holiday before its first test and again in its afterAll, and the calendar-in-the-views test lives in the same file (a file's tests
  run serially). A holiday write also changes a schedule proposal's scope hash (the team's plan, capacity, links AND the holidays), so a write while a proposal is open stales its accept (409 `stale-scope`): `public-holidays` and `schedule-proposal` therefore share the Playwright lock `holiday-dictionary` (`test.describe.configure({ lock })`; the lock is held by the whole file's run, since a file is one job, and every other spec keeps running in parallel). A spec that only reads the calendar needs no lock unless it compares a scope hash. A spec that needs the calendar - or must be sure no holiday touches its figures - uses **its own far-off year**: `critical-path`
  seeds everything in **2041** and `schedule-proposal` in **2042** and `baselines` in **2043** and `jira-sync` in **2044** (the stub's `E2E` project is dated there too) and `jira-coverage` in **2046** (the stub's `COV` project is dated there; 2046-03-05 is a Monday; nothing writes a holiday in it) and `flow-sync` in **2047** (the Flow stub's "E2E Flow Team" is dated there: six two-week sprints from Monday 2047-01-07; nothing writes a holiday in it, so each sprint has ten working days) and `jira-import` in **2045** (the stub's `IMP` project is dated there; `IMP-4` ends on 2045-01-06, Polish Epiphany, harmless because no spec loads 2045 holidays; it writes no holiday; nothing ever writes a holiday in any of them; `schedule-proposal` needs a year the team's first capacity period can start in, because a proposal cannot place anything before the first day with capacity, which pins its dates whatever today is), while `dependencies` and `team-view` keep 2027 and `accessibility` 2026
  (no spec writes a holiday in those years either). A new spec that needs a holiday takes the next unused year (2048, ...), records it in its
  scenario's **Owns** line and sweeps by date; the Polish preset is only ever applied to such a year. The far-off years are 2040, 2041, 2042, 2043, 2044, 2045, 2046 and 2047
  (not 2085+; `jira-polling` dates nothing, so it takes no year): a project or team timeline's range always includes today, so a year far ahead stretches every timeline spec to decades of
  header day cells. **Precondition of the figure-pinning specs:** the stack under test must hold no public holiday on the days they pin
  (`dependencies`: 2027-01-25..02-12; `team-view`: February 2027) nor in 2040, 2041, 2042, 2043, 2044, 2045, 2046 or 2047 outside `public-holidays`' own rows; the Polish
  preset of the sample plan's years (about 2025-2028) has no day in those windows, so it is harmless, but a hand-added holiday there
  would shift their figures. This is a rule, not a guard: a fail-fast check on 2026/2027 would trip on that preset.
- **The Teams registry is shared, append-only state.** Several specs create teams concurrently
  (`teams`, `accessibility`, `list-mutation-refresh`), so a spec only ever appends and removes its
  OWN uniquely named `e2e-*` rows, never edits or deletes another's or a shared seed — and every
  list assertion is anchored on a name filter, never on an unfiltered total or row count.
- Seeded accounts are never mutated. The seed admin (`admin@astrolabe.local`) is a shared
  read-mostly actor: specs sign in as it but must not change its password, roles, or state — a
  future spec that needs a mutated account creates a throwaway.
- E2e-created entities carry a sweepable marker — every e2e-created entity's name and
  every e2e-created user's email contains `e2e`, and nothing that must SURVIVE runs is ever
  named that way. Each spec deletes its own state, so the rule is currently satisfied by
  self-cleanup; add a `sweep-residue` global-setup pass if aborted runs start leaving
  residue that self-cleanup misses.
- Artifacts must be unique-named and list asserts filter- or sort-anchored — never bare page-1
  assumptions. A future spec minting globally-visible state (banners, org-wide notifications)
  runs in its own dependent project phase, not in the parallel pool.
- When a future spec owns a synced connection or edits global settings, give it a Playwright lock
  (`test.describe.configure({ lock })`) against the specs that read the affected figures, rather than
  running it at another time. The first lock is `holiday-dictionary` (`public-holidays`, `schedule-proposal`, above); the second is `jira-import-stub` (`jira-import` alone: no other spec imports the stub's `IMP` project, so all it does is serialise `--repeat-each` copies of that file, which would race on the global "IMP Program" name); the third is `flow-stub-scenario` (`flow-sync` and `flow-capacity-deviation`: the second flips the stub's `flow-day2` scenario, the first asserts day one's figures of the same "E2E Flow Team", so they take turns; `accessibility`'s Flow describe uses "Axe Flow Team", which day two leaves alone, and needs no lock); a lock is held by a spec's whole run. (`jira-sync` owns synced connections and flips the stub, yet needs no lock: it runs serially, and every other spec's
  figures are independent of the stub's scenario state - the only other Jira scans, in `accessibility`, bind `E2E-4`, which exists in both states.) **The compose demo connection polls.** The stack's own demo Jira connection (if the user keeps one) polls every 15 minutes since 1.3, while every connection these specs create is manual-only (`pollIntervalMinutes: null`, so the scheduler never touches it) except `jira-polling`'s one polled connection, which has no bindings. A scheduled run of the demo connection that coincides with `jira-sync.spec.ts`'s `jira-day2` flip (a matter of seconds) would read the demo's linked items as gone until its next poll; it flags them on the timelines meanwhile and self-heals. Outbound permits (2) are shared by the stack, so a bind that meets a scheduled run may queue a few seconds. (The donor project's shared read-only fixture and dispatch-order projects were
  dropped with its data sources; re-port them with the first domain that needs them.)

## What's covered

**Each spec's full design lives in its scenario file under [`scenarios/`](scenarios/README.md)** —
versioned natural-language test-design artifacts (actors, owned state, numbered steps, expected
outcomes). **A new or behaviorally changed test lands with its scenario file and its line below in
the same commit** — this list is the coverage map, the scenario file is the design.

- [`accessibility.spec.ts`](scenarios/accessibility.md) — axe WCAG A/AA smoke: login + the
  authenticated list/form pages (`/`, `/teams`, `/people`, `/users`, `/users/new`, `/feature-flags`,
  `/change-password`, `/changelog`), the detail pages of an API-seeded fixture team (its team page,
  the admin's own edit-user and user-features pages), the Plan page, the Roadmap (a timeline: its fixture projects ranked for the scan, the flag panel open), the Programs tree (the fixture program opened: chevron buttons, summary bars, project rows, the bundle arrow; the program pick narrows it to the fixture) the team page with an open schedule proposal (the dashed proposal bars, the Proposed schedule section's checkboxes, badges and links column; light and dark; its own 2042 world) and the baselines (`/baselines` with a row, `/baselines/:id`, and the team page with a baseline picked: the shadow bars, the appended rows, the open Movement table with its orange "Later" badge; light and dark; its own world and baseline) and the same overlays on `/roadmap`, `/programs` and `/projects/:id` with a baseline picked, and the OPEN row menus of the Teams list, the Baselines list and the roadmap timeline (the menu dropdown is a portal'd `role="menu"` that exists only while open; light and dark), a row-hover scan of the Users, Dependencies, Weekly load and Proposed schedule tables (the theme-owned hover tint; light and dark) and the project view (the timeline, the drift badge and the tray) with an API-seeded work stream, program, project and two milestones (light and dark) and again with the Critical path toggle on (the Slack column, the Critical chain table; light and dark), the Public holidays page (`/public-holidays` among the list pages), `/reset-password` and its confirm page (the form state, from a well-formed link), the not-found page, and a
  registry editor modal, the Plan project editor modal and the Plan "Move to…" modal (with its open options) scoped to their dialogs; the app shell at a mobile width (390x844, the burger present), light and dark; the login screen and the list/form pages again in
  the DARK scheme (`colorScheme: "dark"`, which the `auto` default follows); `color-contrast` included
  (the theme's tokens are AA-tested in `web/src/theme.test.ts`).
  The Jira pages (v1.1, a describe of their own, light and dark): `/integrations/jira` with the fixture connection's row, `/integrations/jira/:id` with every section filled (facts and runs,
  discovery report, mapping form, Peek, the Links table), `/deviations` with a deviating row, the connection editor modal (new and edit) and the bind dialog; no scan here presses Test connection or Peek (`jira-sync.spec.ts` axe-scans their result tables itself). 1.3 adds, light and dark and on the same world: the connection page with the status facts (Current, filled by one manual run), the editor's **Polling** controls (manual only ticked with the number disabled, then the interval's refusal), the project page with its **Flags** column and a dashed Jira bar, the roadmap with a Jira entry in the open flag panel, `/deviations` with the Acknowledge button and the status badges and again with an acknowledged item (withdrawn in a `finally`), and the telemetry panel's Sync section.
  The Flow pages (1.5, a describe of their own, light and dark): `/integrations/flow` with the fixture connection's row (Passed, its zone), `/integrations/flow/:id` with the facts and the one run (Current, Succeeded) and the Teams section filled (the stub's teams, the fixture team linked to "Axe Flow Team" with its Unlink button), and `/teams/:id` with the Flow section (the link facts, **Import capacity…**, the current members table and the former members' table opened); no scan presses Test connection.
- [`auth.spec.ts`](scenarios/auth.md) — login / logout / invalid credentials / guarded deep link with query and hash;
  explicit sign-out from a non-home protected page returns the next sign-in to Home,
  including while server revocation is delayed.
- [`shell.spec.ts`](scenarios/shell.md) — the app shell chrome: the icon rail collapses/expands
  the navbar and remembers the choice across reload; the account menu's theme control switches
  the color scheme and persists it; the tab title names the page ("Teams · Astrolabe", the brand alone on Home) and a navigation moves the focus to `#main-content` so the next Tab lands inside the page; Tab in the open account menu moves between its controls and, past the last one, closes the menu and moves on.
- [`telemetry.spec.ts`](scenarios/telemetry.md) — the ADMIN telemetry panel (Astrolabe's own vital signs): after the sampler's first sample (awaited through the
  API) the admin opens it from the account menu and reads Memory (the compose app's 512 MB container limit and the share of it) and Storage (the database size); the open panel and its expanded sections survive a
  reload and close with their own button; a regular user has no menu item and a hand-stored open flag shows nothing; an axe scan of the panel with every section open.
- [`changelog.spec.ts`](scenarios/changelog.md) — the what's-new dot on a fresh device
  leads to the changelog via the version stamp and clears once read (no language switching
  — it runs as the seed admin; see `i18n.spec.ts`).
- [`critical-path.spec.ts`](scenarios/critical-path.md) — the critical path and the idle gaps, in 2041: a project owner of P, which depends on a chain X -> Y -> P
  (finish-to-start, no spare day), turns the **Critical path** toggle on - the zero-slack bar and the neighbouring ghost row y1 carry `data-critical`, the one arrow is
  critical, the Dependencies row gets the gray badge, the Slack column reads "0 critical path" / "10 working days" - and finds in the **Critical chain** list the member
  beyond the neighbour (x1, two hops, its project and dates, no row on the timeline; y1 is not listed - it is a ghost row); the toggle survives a reload and, off, takes
  every trace away. A five-working-day hole in P's schedule shows as the hatched idle band, the "1 idle gap" badge and the Idle gaps table, on the project page and on the
  page of P's team.
- [`schedule-proposal.spec.ts`](scenarios/schedule-proposal.md) — the schedule proposal on the team page, in 2042 (the team's first capacity period starts Monday 2042-01-06, 10 MD/week,
  WIP limit 2; milestones a 4 MD and b 6 MD unscheduled, c 2 MD in March, a link b -> c): the team's manager presses **Propose schedule** and reads the dashed bars, the strip's proposed
  week (9 of 10 MD) and the table (b 2042-01-06..13 hoisted ahead of c, a 01-06..09 beside it, c 01-14..15 "34 working days earlier"), then **Accept selected (3)** - the milestones become
  bars and the tray empties ("3 scheduled" note); a second run unticks b and accepts the other two (b stays in the tray); a third has the administrator reschedule a
  under the open proposal, and the accept skips it ("2 scheduled · 1 skipped: rescheduled in the meantime") while the others land; the project owner has no Propose button. Each test seeds its own team.
- [`list-mutation-refresh.spec.ts`](scenarios/list-mutation-refresh.md) — held first
  filter-response for Users or Teams cannot restore a deleted row; a held Feature Flags
  response cannot undo a successful toggle.
- [`i18n.spec.ts`](scenarios/i18n.md) — the synced per-user language: a throwaway user
  switches to Polish, the choice survives a reload AND a wiped-device re-login (served from
  the stored value; the tab title follows in Polish), and the admin's English flips it back; seeded accounts stay English.
- [`mfa.spec.ts`](scenarios/mfa.md) — email MFA + the flags surfaces: the /feature-flags
  row switch and per-user editor round-trip a throwaway user's MFA flag; an MFA-enabled
  account signs in using the fully revealed generated password and the emailed 6-digit code
  via Mailpit (skips itself without it).
- [`people.spec.ts`](scenarios/people.md) — the people directory: create through the modal (name,
  email) → link a throwaway login from the Login picker and rename → the list shows the login's
  email → delete from the row; a regular user's read-only list and person page (emails visible, no
  New person, no row menu, no Edit button).
- [`plan.spec.ts`](scenarios/plan.md) — the Plan page: an admin builds work stream → program → project
  through the modals (owners picked from the people directory, a target window), hands the project over,
  sees the delete refused while a parent has children, then deletes bottom-up; a project owner sees the
  whole plan but actions only on their own project, edits it, and finds the target window disabled.
  A work stream owner moves a project to another program and a program to another work stream ("Move to…"); the milestones travel along, the project view names the new parents and the global ranking is untouched.
- [`public-holidays.spec.ts`](scenarios/public-holidays.md) — the public-holiday dictionary, in 2040 (the only year this spec writes): an administrator adds a holiday and finds
  it under the year picker, meets the duplicate-date message, applies the Polish preset (14 rows; applying it again adds none) and deletes a row behind its confirmation; a
  regular user reads the list with no add strip, preset button or delete (axe scans for both); and a holiday added on the Monday after a finish moves a dependency's "needs"
  date by a working day and names the week-zoom header day cell, deleting it restores both. The year is shared state: `--repeat-each` copies of the file race on it (run it with `E2E_WORKERS=1`).
- [`project-view.spec.ts`](scenarios/project-view.md) — the project view and the shared Timeline in a real browser: a project owner opens the project from the
  Plan page's name link, creates milestones (team picker, estimate) that wait in the Unscheduled tray and has no way to schedule them; the milestone's
  team manager schedules by the tray's Schedule button, the Edit schedule dialog, dnd-kit's keyboard sensor, a pointer drag of the bar, a pointer drag of
  the end handle and a pointer drop of a tray row onto the (scrolled) timeline, meets the stale-milestone notice when the admin API moved the bar, and
  unschedules; the owner reads the derived span and the drift (orange, in words) with read-only bars and no handles.
- [`dependencies.spec.ts`](scenarios/dependencies.md) — dependencies on the project view: a project owner adds a finish-to-start link from a milestone of
  another project through the Add dependency dialog (successor select, searchable predecessor picker), sees the ghost row with its link to the other
  project and the gray arrow, and is refused a reverse link that would close a cycle (the path named in the dialog); the team's manager moves the
  successor ahead of its predecessor and reads the conflict (red arrow, "1 conflict" badge, the Dependencies row "Violated · 10 working days short" with
  what it needs, the bar's name); the owner deletes the link from the table and the ghost row, the arrow and the conflict go; the owner edits a link in
  place (row menu Edit…, the dialog with read-only ends): Start → Start with a lag of 6 flips the row to "Violated · 1 working day short, needs
  2027-02-09", a lag of 5 restores OK. A 14-option Predecessor list (more than the 220 px option list shows) is driven by keyboard - arrow down past the visible area, Enter picks - and its open listbox passes an axe scan (the listbox is the scroller, `theme.ts` `withScrollArea: false`).
- [`team-view.spec.ts`](scenarios/team-view.md) — the team page `/teams/:id` (schedule, order and capacity on the shared Timeline): the team's manager
  adds a capacity period dated on a Wednesday with a WIP limit of 1, schedules two milestones from the page (the tray row's Edit schedule dialog, the tray's
  Schedule button) and reads the overloaded week (the strip cell's `data-overloaded`, the orange "1 week overloaded" badge, the weekly table's prorated
  capacity 4.80 and "Overloaded · +5.20 MD") and then the WIP warning (`data-wip-exceeded`, "1 week over WIP limit", peak 2); moves a milestone to the bottom
  from its row menu (the team's own order revision, the "Custom order" badge, the live-region sentence) and resets the order; drags a row below another by
  its pointer handle (the insertion line's slot, Escape cancels with dnd-kit's announcement, a release saves the new order and announces the drop); the
  project owner, who is not the manager, reads the page with read-only bars and none of the controls.
- [`roadmap.spec.ts`](scenarios/roadmap.md) — the Roadmap page (a timeline: a row per project in rank order, the "Unranked" divider, the target
  window as a band): an admin grants ROADMAP_EDITOR on Users → Permissions; that editor (the program pick narrows the page to the spec's own
  program) ranks two API-seeded projects from the row menu (Rank appends), moves one up from the keyboard (the menu button keeps focus, the status says
  it), drags a row by its pointer handle inside the ranking and below the divider (= Unrank), unranks from the menu, and meets the "roadmap changed in the
  meantime" notice and reload when the ranking revision moved under the open page; a plain user reads the rows with no handle, read-only bars and no
  ranking item in the row menu. The target window (one test, an API-seeded ROADMAP_EDITOR who owns nothing): the editor drags the band by pressing on
  the span bar over it (the pointer goes through the span, and the server's drift flag appears in the panel), draws a window across a row that has
  none, sets one from the keyboard through the row menu's "Edit target window…" dialog (focus returns to the menu button) and clears it from the menu;
  the project's own owner, without a grant, reads the band read-only and gets no window item in the menu. The ranking is shared state and `--repeat-each`
  copies of the file race on it: its change helper retries stale answers up to 30 times (run it with `E2E_WORKERS=1` to take the contention away).
- [`baselines.spec.ts`](scenarios/baselines.md) — baselines (v0.9), in 2043: the administrator takes a baseline on `/baselines` (Take baseline → the row), the plan moves under it (a milestone
  five working days later, a new one), and the team's manager picks it in the team page's **Baseline** picker and reads two shadow bars (`data-tone="baseline"`, the moved one named "5 working
  days later (start and end)"), the Movement table (Start +5, End +5, "Later"; the new milestone "New"; the unchanged one only with "Changed only" off); the comparison page `/baselines/:id`, read by
  the project owner, lists the project's own movement ("start 5 working days later, end 3 working days later", counts "1 end later, 1 new, 1 removed") and its moved, new and removed milestone rows;
  a reader sees the list with no Take baseline button and no row menu and opens the comparison; the administrator renames a baseline (the picker of a page that had it picked reads the new name) and
  deletes it behind its confirmation (the page falls back to None, no shadow bar). Baselines are shared state: every assertion is anchored on the spec's own rows, none counts.
- [`jira-sync.spec.ts`](scenarios/jira-sync.md) — the Jira sync (v1.1) against the compose stack's Jira stub (WireMock on `E2E_JIRA_STUB_URL`) and its isolated `E2E` project, dated 2044: the administrator creates a
  connection in the modal (a unique throwaway site, scoped to `E2E`), lands on its page and tests it - every probe green, none failed, the result saying it was answered by the development stub and the facts wearing the "Development stub" badge (the result table axe-scanned); a wrong token (`wrong-token`) in the modal's own ad-hoc test shows the failed
  probes with the status 401, "Jira refused the credentials" and each probe's scope hint, while `tenant_info` stays green (the red state axe-scanned in the dialog); the administrator reads the discovery report (60 fields, 7 issue types, the Target start/end,
  Team and Parent Link marker lines) and the default levels (Epic/Initiative/Program), declares 0.5 man-days per point, saves the mapping and peeks `E2E-4` through it (Milestone, 2044-01-04..2044-01-08, exactly "5 Story points", the result axe-scanned), then re-maps the end to the Due date and the same Peek reads no end; a project owner (no administrator right) links a milestone to `E2E-4` from its row menu (the dialog's connections come from the
  Deviations view), follows the chip to the Deviations page (the connection "Never refreshed", no Refresh button for them), and after an administrator's Refresh now in another browser (the item's `observedAt` strictly grew) reads "Ends 3 working days
  later than Jira" with both sides' dates (plan 2044-01-04..2044-01-13, Jira ..01-08) and, at 0.5 man-days per point, "Estimate is 3.00 man-days in the plan and 2.50 man-days in Jira"; the owner unlinks the milestone behind its confirmation and the row leaves the page, then the stub's `jira-day2` scenario deletes
  `E2E-6` and, after the next refresh, the other linked milestone reads "Gone from Jira" (the warning, the stale mark, "1 gone from Jira"). A sixth scenario (1.3) binds a milestone to `E2E-6` and its project to `E2E-2`: the project owner reads the Flags column, the key link, the flag and the dashed Jira bar on the project page and "1 milestone deviates from Jira" and "Jira E2E-2: Ends 3 working days later than Jira" on the roadmap, acknowledges the milestone's deviation (the row leaves the Open list, the Acknowledged status lists it, the flag and the roll-up entry go while the bar stays), and after the stub's day 2 deletes `E2E-6` the item is open again as "Gone from Jira" with "changed since" and the flag is back. This file alone flips the stub scenario (serial; reset in beforeAll and afterAll, and right after the refresh that shows "Gone").
- [`jira-polling.spec.ts`](scenarios/jira-polling.md) — Jira polling (v1.3), against the stack's scheduler (a tick every 60 s) and the stub's `E2E` project, on two connections of its own that bind nothing: a tested
  connection with an interval of 5 minutes is run by the scheduler within two minutes (a **Scheduled** run, "Succeeded", the facts read **Current**, "next poll in n min" and a dated last success), and an untested manual-only connection
  has no run and reads **Never synced** and **Manual only** (a TESTED manual-only one would cost a second Test connection call: the server's scheduler tests pin that it stays unpolled); the administrator sets the interval in the editor (3 is refused with "… from 5 to 1440", 20 round-trips), ticks **Manual only (no polling)** (the number disabled; the facts and
  the registry's Status column say "manual only") and restores the interval, after which a NEW scheduled run appears (the edit made it due at once: polling resumes); and the telemetry panel's **Sync** section lists both connections with their state, last success and polling. The one Test connection call it spends (like every Jira file's, through the shared `testJiraConnectionViaApi` helper, which waits a 429 out once) is
  counted in the bucket tally above.
- [`jira-import.spec.ts`](scenarios/jira-import.md) — import from Jira (v1.2) against the stub's isolated `IMP` project, dated 2045, into a throwaway work stream: a throwaway administrator opens the connection page's **Import from Jira…** modal, picks the stream, owner and default team, and previews (9 Jira items, 8 to create, 1 skipped: IMP-8 has nowhere to go; IMP-6 undated, IMP-7's name cut), imports (created 8 = 1 program + 2 projects + 5 milestones, 4 scheduled), finds the 8 links on the connection page and the milestones dated 2045 in the project views, and a second preview of the same scope offers nothing ("0 of 0 selected", Import disabled); unticking a parent (IMP-2) leaves its children (IMP-4, IMP-5) "Not imported" with the reason, the count on **Import (n)** drops and ticking a child brings the parent back; a skipped row's reason names the fix and a default project makes IMP-8 importable; and the modal's three steps (Scope empty and filled, Preview, Outcome) pass axe, light and dark, as does a five-key preview of about 1,100 rows (the virtualised table, top and mid-scroll; previewed only, never imported). It owns the stub's `IMP` project (lock `jira-import-stub`).
- [`jira-coverage.spec.ts`](scenarios/jira-coverage.md) — Jira coverage (v1.4) against the stub's isolated `COV` project, dated 2046, on one connection of its own bound to a project (`COV-2`) and two milestones (`COV-3`: 4 children, 2 done, 13 points; `COV-4`: 2 children, both done, 5 points), refreshed once: the project page's Flags cells carry the roll-up chip after the key and the flags (`2/4 · 13 pt`, `2/2 · 5 pt`, the sentence as the accessible name, an unlinked milestone's cell empty, no cell clipped in the widened column; axe light and dark); the Deviations page lists, on the project's row, the open Jira epic the plan lacks (`COV-5`: "1 Jira item is not in the plan") and the plan milestone Jira lacks ("1 plan item is not linked to Jira"), and on `COV-4`'s the children all done ("All 2 child issues are done in Jira while the plan ends 2046-03-23"), names the done, unbound `COV-10` nowhere (axe light and dark) and the roadmap's flag panel says the same; acknowledging the project's row silences the roadmap entry, leaves the other rows open, and a second run reopens nothing.
- [`flow-sync.spec.ts`](scenarios/flow-sync.md) — the Flow sync (v1.5) against the compose stack's Flow stub (`E2E_FLOW_STUB_ORIGIN` for the app, `E2E_FLOW_STUB_URL` for the spec's read of the scenario states) and its "E2E Flow Team", dated 2047: the administrator creates a connection in the modal (the stub's origin and token, `Europe/Warsaw` pre-filled, manual only), lands on its page, tests it ("Test passed. OK: 2 of 2.", "Flow's document · teams: 19 · sprints: 523", the result axe-scanned), refreshes it and reads the Teams section (the team rows with their membership and sprint counts; "E2E Flow Team" and "Legacy Mainframe" without a suggestion or a Link button); the team's MANAGER (no administrator right) links the team to "E2E Flow Team" from the team page (the dialog offers the connections the panel lists), previews **Import capacity…** (six rows with the stub's dates, working days, sprint totals and 20.00 / 18.00 / 22.00 / 20.00 / 19.00 / 21.00 man-days per week, the dialog axe-scanned), applies it ("6 created", every row then "Unchanged") and finds six Flow-badged capacity periods; and the roster panel lists the four current members to a viewer with no right on the team (no Unlink, no Import) and to the manager, the former member behind its disclosure with the dates in Warsaw's zone, until the manager unlinks it behind its confirmation (the imported periods stay). It never flips a stub scenario (it takes the lock `flow-stub-scenario` against the one spec that does).
- [`flow-capacity-deviation.spec.ts`](scenarios/flow-capacity-deviation.md) — the capacity deviation (v1.6) against the Flow stub and its "E2E Flow Team", dated 2047, on a connection and two teams of its own (one linked to "E2E Flow Team", one to "Billing"): with no capacity period the Deviations page's **Capacity from Flow** section (narrowed to the team with `teamId`) folds the team's sprints into one line ("6 sprints without capacity in the plan (from 2047-01-07)", "6 infos"), its disclosure lists each sprint with Flow's name, dates and figure, and the team page's **Capacity vs Flow** fact reads "No capacity in the plan for 6 sprints" (the page axe-scanned, light and dark); the team's manager (no administrator right) imports the capacity through the API and the section no longer lists the team while the team page reads "In line with Flow"; after the stub's `flow-day2` (flipped here, refreshed through the API, reset at once) the imported team reads a WARNING for the sprint Flow lowered ("E2E Flow Sprint 2 (2047-01-21 – 2047-02-01): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan") and an INFO for the one it raised ("… 44.00 man-days, Flow 48.00 — 4.00 less in the plan"), `severity=WARNING` in the URL drops the info line, the team page reads "Differs from Flow for 2 sprints", and the team linked to "Billing" reads "The Flow team is no longer in Flow's document" ("of which 1 team gone from Flow"); axe on both, light and dark. It alone flips `flow-day2` (lock `flow-stub-scenario`, shared with `flow-sync`).
- [`programs.spec.ts`](scenarios/programs.md) — the Programs page (the plan as a collapsible tree on the timeline: work stream → program → project): an admin reads
  the work stream open and its programs folded, a program's bar as the span its projects cover and the roll-up count of its projects' flags, opens a program with
  the pointer (the status says it) and folds it from the keyboard (the chevron button keeps focus), sees the one arrow between two shown project rows appear and
  leave with the fold, uses Expand all / Collapse all and switches to Year zoom (the year header); the program pick set on this page narrows the Roadmap after a
  reload and the one set on the Roadmap narrows this page (one shared stored key); a user without any right reads the tree with read-only bars and a row menu that
  only opens the project.
- [`password-reset.spec.ts`](scenarios/password-reset.md) — the forgot-password flow:
  neutral confirmation + per-email throttle; the emailed single-use link opened through the
  compose stack's Mailpit keeps the old password until the new one is set, then ends the old
  session and works once (skips itself without Mailpit).
- [`teams.spec.ts`](scenarios/teams.md) — the flat-teams registry: create through the modal →
  rename → assign an API-seeded person as the team's manager (the Manager picker; the
  details page reads "Manager: …") → delete from the list (the focus lands on the "Teams" heading);
  dismissing a row's delete dialog, then its edit dialog, with Escape returns the focus to the row's menu button, and a plain button's dialog to that button; Tab in an open row menu closes it and moves on from the kebab, Shift+Tab goes back (and out of a menu backwards);
  a regular user's read-only list and team page (no New team, no row menu, no Edit button).
- [`users.spec.ts`](scenarios/users.md) — the account lifecycle: create via the one-time
  password reveal → the new user's limited view + self password change (which signs the device out with its
  notice) → promotion → deletion → the dead login; own-row protections on the admin's row; a second scenario
  where an admin's demotion (roles refresh, still signed in) and deletion (signed out with the notice) reach a
  signed-in user on their next request.

Specs log in with the seeded admin (`admin@astrolabe.local`, password `changeme`), and use unique
content where they create any — so they don't depend on a clean database or absolute counts.

### Logging in

`createUserViaUi()` waits for the one-time password reveal to render before reading the
password. A click on Show password alone is not evidence that the mask has been replaced.
Every journey that creates a user through this shared helper inherits that synchronization.

`helpers.login()` signs in **without the form** (build-times.md WHY 37): the real `POST /api/v1/login` through the page's request context, the
session written to `localStorage` under the `astrolabe.auth.*` keys the SPA itself persists (`storeSession` in `web/src/api/session.ts`), then one
load of `/` — the tokens, the revocation blocklist and any per-request credential check are the server's own, nothing is forged or reused
across tests (`signOut` revokes the pair, so a session is minted per call). It takes the seed admin by default or any account's credentials
(a throwaway regular user reads the app as one), and falls back to the real form when the login is refused, answers a challenge (MFA) or the
shell does not accept the session. `helpers.loginViaForm()` is the real form (clearing any leftover `astrolabe.auth.*` localStorage session
first — while one exists, `RedirectIfAuthed` bounces `/login` away and the form never renders): use it where the credential, the form or
the language riding the login response IS the subject — `users` (the first sign-in with the revealed password), `password-reset` (the
new password), `i18n` (the Polish throwaway and the English admin after it), `auth` and `mfa` (which drive the form inline). Development
stacks lift the per-IP login bucket (`security.rateLimit.loginPerMinute`, 1000/min in development vs 10/min in production), so neither
path is throttled.

## Deliberately not covered

- **Login lockout (429)** — five failed logins would lock the seed admin for 15 minutes in the
  shared database and poison the rest of the run. Covered by the server's login-throttle tests (server).
- **Token refresh / expiry (clock-driven)** — real expiry needs clock control; covered by server
  tests (`RefreshTest`) and the `web/src/api/api.test.ts` unit tests. (Browser-side refresh behavior via `page.route` fault injection is a candidate for a future `error-handling.spec.ts`.)
- **The authz matrix** — covered by the server tests (`GuardsTest`, `AnonymousAccessTest`); E2E
  asserts only user-visible consequences.
- **Dark-mode rendering** — the palette is theme-owned (`web/src/theme.ts`); `shell.spec.ts`
  asserts the color-scheme attribute switches and persists, and the two accessibility specs scan the
  page sets in the dark scheme (contrast), but no e2e asserts rendered colors, and there is no
  visual-regression suite.
- **Responsive / cross-browser / visual automation** — the suite deliberately runs a single
  **Desktop Chrome (chromium) project** only, with no mobile project or screenshot comparison;
  layout relies on Mantine semantics plus the role/label-based locators every spec uses.
  Accessibility gets the `accessibility.spec.ts` axe smoke.

Reports/artifacts land in `playwright-report/` and `test-results/` (git-ignored).
