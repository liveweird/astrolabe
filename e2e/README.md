# E2E (Playwright, blackbox)

Owns: how to run the suite against a named stack, the parallel state-ownership rulebook and the coverage map. Not here: each spec's actors, owned state and steps (`e2e/scenarios/<spec>.md`; the format is `e2e/scenarios/README.md`); how the worlds are seeded (`test-fixtures.md` "The e2e worlds"); the stub ports and the CI jobs (`ci.md`); gate times (`build-times.md`).

## Rules

- The tests treat the app as a **blackbox**: a real Chromium against the whole stack (SPA + server + Flyway + Postgres) served single-origin, **a stack you started and named** (see "Run"). The package is fully isolated from `web/`: it imports none of the app source and only speaks HTTP/DOM.
- **Playwright runs only against a stack somebody named.** The suite starts, builds, stops and tears down nothing, and never removes a service or a volume. Tests clean up only the records they own; existing data stays intact.
- **A new or behaviorally changed test lands with its scenario file and its line in "What's covered" in the same commit.** The scenario file is the design, the line is the coverage map. `npm run check:scenarios` enforces the parity mechanically (both directions, orphan files included); `accessibility.spec.ts` is its registered skip.
- **Every spec file owns its server-side state exclusively.** The serial unit is the spec file; different files run concurrently. Each spec's scenario file declares its **Owns** line ("nothing — read-only" when applicable); a new or edited spec satisfies the rulebook in "Parallel execution".
- Artifacts are unique-named, and list asserts are filter- or sort-anchored, never bare page-1 assumptions. A plan-wide figure is asserted as present, never as a value: four workers share the plan.
- Every e2e-created entity's name and every e2e-created user's email contains `e2e`, and nothing that must SURVIVE runs is ever named that way. Each spec deletes its own state, so the rule is satisfied by self-cleanup; add a `sweep-residue` global-setup pass if aborted runs start leaving residue that self-cleanup misses.
- **Seeded accounts are never mutated.** The seed admin (`admin@astrolabe.local`) is a shared read-mostly actor: specs sign in as it but must not change its password, roles, language or state; a spec that needs a mutated account creates a throwaway. Seeded accounts must stay English: every login applies the stored language to that session's UI, so a Polish seed admin would flip parallel specs mid-run. `mfa` never touches the seed admin's MFA flag (enabling it would make every spec's login demand a code).
- **The Teams registry is shared, append-only state.** Several specs create teams concurrently (`teams`, `accessibility`, `list-mutation-refresh`), so a spec only ever appends and removes its OWN uniquely named `e2e-*` rows, never edits or deletes another's or a shared seed.
- **Only `public-holidays.spec.ts` writes holidays, and only in 2040.** A spec that needs the calendar, or must be sure no holiday touches its figures, uses its own far-off year and records it in its scenario's Owns line (the table in "The holiday dictionary and the far-off years").
- A spec that owns a synced connection or edits global settings gets a Playwright lock (`test.describe.configure({ lock })`) against the specs that read the affected figures, rather than running at another time. A lock is held by a spec's whole run.
- A spec that asks for a sync run (through the API or by pressing the button) does it as a throwaway administrator of its own, `apiAsThrowawayAdmin(prefix)`, and adds its line to the tally in "Rate buckets shared by the suite".
- A future spec minting globally-visible state (banners, org-wide notifications) runs in its own dependent project phase, not in the parallel pool.
- Specs log in with the seeded admin or a throwaway through `helpers.login()`; `helpers.loginViaForm()` only where the form, the credential or the language riding the login response IS the subject ("Logging in").

## Run

**Playwright runs only against a stack somebody named.** The suite writes rows through the API of the stack it is given (users, teams,
plans, Jira and Flow connections) and flips the scenarios of its two stubs, so it never guesses a stack: `http://localhost:8086` is this
repository's default compose project, a working stack with your data, and nothing here falls back to it. Start a throwaway stack yourself
(its own compose project name and host ports, torn down by you afterwards), then name its four addresses:

```bash
cd e2e
npm install
npm run install:browsers      # one-time: download Chromium
export E2E_BASE_URL=http://localhost:<app> E2E_MAILPIT_URL=http://localhost:<mailpit> \
       E2E_JIRA_STUB_URL=http://localhost:<jira-stub> E2E_FLOW_STUB_URL=http://localhost:<flow-stub>
npm test                      # checks the named stack answers, runs the specs, leaves the stack intact
```

- All four variables are required, each an absolute `http(s)` URL (`target.ts` is the one reader of them; no other file under `e2e/`
  holds a host URL). With one missing, blank or malformed, `global-setup.ts` refuses to run before it makes a single request and names
  each variable at fault. When the app named by `E2E_BASE_URL` does not answer `/api/v1/ready`, it fails with "not ready: start that
  stack first". **The suite starts, builds, stops and tears down nothing** (no `docker` command lives in `stack.ts` or `global-setup.ts`),
  and it never removes a service or a volume. Tests clean up only the records they own; existing data stays intact.
- The nightly `e2e.yml` builds the image and starts the stack in their own workflow steps (so the time is attributable per step,
  `.claude/docs/build-times.md`) and sets the four variables to that stack's published ports (8086, 8029, 8096, 8097).
- `E2E_JIRA_STUB_URL` (the stack's `jira-stub`: WireMock over the sample Jira dataset; the compose default is host port 8096) is the admin API
  `jira-sync.spec.ts` flips the `jira-day2` scenario through (`PUT /__admin/scenarios/jira-day2/state`; the app itself reaches the stub as `jira-stub:8080`
  over the compose network, so this URL is only the spec's own handle on it). Name the stub of the same stack as `E2E_BASE_URL`. Without a stub the
  Jira spec's beforeAll fails (it resets the scenario first).
- `E2E_FLOW_STUB_URL` (the stack's `flow-stub`: WireMock over the sample Flow dataset; the compose default is host port 8097) is the admin API:
  - `flow-sync.spec.ts` READS it in its beforeAll to prove the stub's `flow-day2` and `flow-outage` scenarios are at `Started` (day one's figures are what it asserts; it fails fast naming the scenario otherwise).
  - `flow-capacity-deviation.spec.ts` and `flow-capacity-acknowledge.spec.ts` WRITE to flip `flow-day2` (`PUT /__admin/scenarios/flow-day2/state`, reset in their beforeAll and afterAll; the lock `flow-stub-scenario` keeps the three files apart).
  - Name the Flow stub of the same stack as `E2E_BASE_URL`. The specs read the stub's token, totals and "E2E Flow Team" figures from `sample-data/flow/expected.json` in the checkout.
- `E2E_FLOW_STUB_ORIGIN` (default `http://flow-stub:8080`) is the address the APP reaches that stub at, the base URL of every connection these specs create: the compose network name, listed in the app's `FLOW_INSECURE_ORIGINS`.
- `jira-polling.spec.ts` needs the stack's **scheduler** on (the compose default, `SYNC_SCHEDULER_ENABLED=true`: a tick every 60 s, the first 10 s after start): it waits up to two minutes for a scheduled
  run of a connection it made. Against a stack that runs with `SYNC_SCHEDULER_ENABLED=false` its first and third scenarios fail by design (no run ever comes).
- `E2E_MAILPIT_URL` (the stack's Mailpit; the compose default is host port 8029) is the catcher the two email specs
  (`mfa.spec.ts`, `password-reset.spec.ts`) read; name the Mailpit of the same stack as `E2E_BASE_URL` (an isolated compose
  project has its own Mailpit port). Global setup checks its messages endpoint and fails when it is unreachable. A reachable catcher
  from another stack still fails the email journeys because the expected messages never arrive.

Docker-free gates ride every spec change — run them before merging, like the web
package's lint/knip:

```bash
npm run typecheck             # tsc --noEmit — Playwright only TRANSPILES TS, it never checks it
npm run check:scenarios       # spec ↔ scenario parity: files exist, test() titles == headings
npm run test:setup            # the refusal without a named stack, the readiness check, the source pins
```

`check:scenarios` enforces the same-commit rule mechanically (both directions, orphan
files included); `accessibility.spec.ts` is its registered skip — the parameterized-title
carve-out in [`scenarios/README.md`](scenarios/README.md).

Reports/artifacts land in `playwright-report/` and `test-results/` (git-ignored). In CI the config also writes `test-results/results.json`, which `scripts/flaky-summary.mjs` turns into the nightly's list of tests that needed a retry.

## Parallel execution

The suite runs on **4 workers by default** (`E2E_WORKERS` overrides; the `e2e.yml` `workflow_dispatch` form has a `workers` input for A/B runs; `E2E_WORKERS=1` restores
fully-serial behavior). The serial unit is the **spec file** (`fullyParallel: false` — a file's
tests may be order-dependent); different files run concurrently. That is only sound because every spec file owns its server-side state exclusively (Rules).
`--repeat-each` copies of `roadmap.spec.ts` race on the one global ranking, which other specs append to as well (its change helper retries a stale answer up to 30 times): run it with `E2E_WORKERS=1`. Copies of `public-holidays` and `jira-import` take turns on their locks (below).

### The holiday dictionary and the far-off years

- A public holiday applies to every team's calendar, so adding one changes the working-day figures (a dependency's "needs" date, slack, idle gaps, weekly load) of every plan that has a day in its year, and bumps the plan
  revision (no client write is staled by it).
- `public-holidays.spec.ts` sweeps every 2040 holiday before its first test and again in its afterAll; the calendar-in-the-views test lives in the same file (a file's tests run serially). The Polish preset is only ever applied to such a year.
- A holiday write also changes a schedule proposal's scope token (its holidays part), so a write while a proposal is open can stale its accept (409 `stale-scope`, only when the write changes an accepted date).
  `public-holidays`, `schedule-proposal` and `cross-team-proposal` therefore share the lock `holiday-dictionary`. A spec that only reads the calendar needs no lock unless it compares a scope hash.
- A project or team timeline's range always includes today, so a year far ahead stretches every timeline spec to decades of header day cells: the far-off years stay below 2085. A new spec that needs a holiday takes the next unused year (2049, ...), records it in its scenario's **Owns** line and sweeps by date.

| Year | Years other specs must not write holidays in, and who dates a world there |
|---|---|
| 2040 | `public-holidays` (the only writer of holidays) |
| 2041 | `critical-path` |
| 2042 | `schedule-proposal`; `accessibility`'s open-proposal world |
| 2043 | `baselines` |
| 2044 | `jira-sync`, `jira-acknowledge`; `accessibility`'s Jira world (the stub's `E2E` project is dated there) |
| 2045 | `jira-import`, `jira-import-children` (the stub's `IMP`, `IMF` and `IMC` projects are dated there) |
| 2046 | `jira-coverage` (the stub's `COV` project; 2046-03-05 is a Monday) |
| 2047 | `flow-sync`, `flow-capacity-deviation`, `flow-capacity-acknowledge` (the stub's "E2E Flow Team": six two-week sprints from Monday 2047-01-07, ten working days each) |
| 2048 | `cross-team-proposal` (two teams from Monday 2048-01-06) |
| 2027 | `dependencies`, `team-view` |
| 2026 | `accessibility` |
| none | `jira-polling` and `dialog-focus` date nothing |

Nothing writes a holiday in any year but 2040. **Precondition of the figure-pinning specs:** the stack under test must hold no public holiday on the days they pin
(`dependencies`: 2027-01-25..02-12; `team-view`: February 2027) nor in 2040 to 2048 outside `public-holidays`' own rows; the Polish
preset of the sample plan's years (about 2025-2028) has no day in those windows, so it is harmless, but a hand-added holiday there
would shift their figures. This is a rule, not a guard: a fail-fast check on 2026/2027 would trip on that preset.

### Locks and stub scenarios

| Lock | Held by | Why |
|---|---|---|
| `holiday-dictionary` | `public-holidays`, `schedule-proposal`, `cross-team-proposal` | a holiday write can stale an open proposal's accept (above) |
| `jira-import-stub` | `jira-import` alone | no other spec imports the stub's `IMP` project; it only serialises `--repeat-each` copies, which would race on the global "IMP Program" name |
| `flow-stub-scenario` | `flow-sync`, `flow-capacity-deviation`, `flow-capacity-acknowledge` | the second and third flip the stub's `flow-day2` (and reset it; the third flips it again in its last scenario, to day one and back to day two), the first asserts day one's figures of the same "E2E Flow Team", so the three files take turns |

- `accessibility`'s Flow describe uses "Axe Flow Team", which day two leaves alone, and needs no lock.
- The stub is one process with one scenario state. `jira-sync` alone flips `jira-day2` (`test.describe.configure({ mode: "serial" })`; the beforeAll resets the scenario to `Started`, the afterAll resets it even after a failure) and needs no lock:
  every other spec's figures are independent of the stub's scenario state. The only other specs that bind the `E2E` project, `accessibility`'s Jira scans and `jira-acknowledge`, bind `E2E-4`, `E2E-5` and `E2E-2`, which exist in both states and read the same; `E2E-6` (deleted) and `E2E-10` (moved to `OUT-6`) are `jira-sync`'s alone.
- Every connection these specs create is manual-only (`pollIntervalMinutes: null`, so the scheduler never touches it) except `jira-polling`'s one polled connection, which has no bindings.
  A polling connection of the stack's own that runs during `jira-sync.spec.ts`'s flip would read its linked items as gone until its next poll; it flags them on the timelines meanwhile and self-heals.
  Outbound permits (2) are shared by the stack, so a bind that meets a scheduled run may queue a few seconds.
- Each Jira connection a spec creates is scoped to the stub's `E2E`, `IMP`, `IMF`, `IMC` or `COV` project only (or, in `jira-import`'s five-key preview test, to the five work-stream keys), on a unique throwaway `stub-` site, so a Jira item is bound once per site and no other spec's connection ever meets one of its bindings.

### Rate buckets shared by the suite

- **Jira Test connection and Peek** share one per-IP bucket across the whole suite (10 a minute by default, 30 on the e2e stacks: `JIRA_TEST_RATE_LIMIT_PER_MINUTE` in `docker-compose.yaml` and `k8s/local/front-door.yaml`).
  The calls are per worker start of a file, not per run: a failed test restarts the worker and runs its beforeAll again, and `testJiraConnectionViaApi` waits a 429 out once. Calls per start: `jira-sync` 6 (a retried serial group starts again and spends its six again: CI runs with `retries: 2`),
  `jira-import` 4 (the file's connection, the five-key preview test's, one for each of its two `IMF` tests), `accessibility` 1 (the Jira describe), `jira-import-children` 1, `jira-polling` 1, `jira-coverage` 1, `jira-acknowledge` 1:
  a clean run of the seven spends 15 of the 30 a minute (more than the default 10, which is why the e2e stacks raise it). No accessibility scan presses either button; `jira-sync` axe-scans the result tables it shows at no extra call.
- **The `flow-test` bucket** (Test connection on a Flow connection) is its own per-IP bucket, apart from Jira's (10 a minute by default, 30 on the e2e stacks: `FLOW_TEST_RATE_LIMIT_PER_MINUTE` in `docker-compose.yaml` and `k8s/local/front-door.yaml`).
  Per worker start: `flow-sync` 2 (the beforeAll's API test and the first scenario's UI test), `accessibility`'s Flow describe 1, `flow-capacity-deviation` 1, `flow-capacity-acknowledge` 1, so a clean run spends 5 of the 30 a minute.
- **The `sync-run` bucket** (Refresh now, `POST /integrations/sync/runs`, Jira and Flow together) is a per-USER bucket of 10 a minute, so a run asked by a spec is counted against the account that asks.
  The seed administrator is shared by every file and a full run makes about 15 manual runs, so a spec that asks for a run through the API (`refreshJiraConnectionViaApi`, `refreshFlowConnectionViaApi`) or by pressing the button as an administrator does it as an administrator of its own:
  `apiAsThrowawayAdmin(prefix)` (a unique `ADMIN` user, signed in, with its credentials for a browser `login` and a `dispose()` that deletes it), made in the file's beforeAll and disposed in its afterAll.
  The tally, per account, each well under 10 even when a restarted worker runs its beforeAll again: `jira-coverage` 2 (the beforeAll's and the third scenario's), `jira-sync` 3 (the three `refreshAsAdmin` presses, in the throwaway's browser),
  `flow-sync` 1 API run (its one button press, the first scenario's, stays the seed administrator's: 1), `flow-capacity-deviation` 2 (the beforeAll's and the second scenario's),
  `flow-capacity-acknowledge` 4 (the beforeAll's two, day one's read and day two's, and the same two in the last scenario), `accessibility` 1 per describe that asks (Jira pages, Flow pages).
  A new spec that asks for a run adds its line here.

## What's covered

One line a spec: what it proves. The design (actors, owned state, numbered steps) is the spec's scenario file under [`scenarios/`](scenarios/README.md).

### Accounts, shell and shared chrome

- [`accessibility.spec.ts`](scenarios/accessibility.md) — axe WCAG A/AA scans (`color-contrast` included) of the login screen and every authenticated list, form and detail page, the open menus and dialogs, the timeline overlays (proposal, baseline, critical path, the team page's critical chain) and the Jira and Flow pages, in light and dark and at a mobile width; each describe on an API-seeded world of its own.
- [`auth.spec.ts`](scenarios/auth.md) — login, logout, invalid credentials and a guarded deep link with query and hash; an explicit sign-out from a non-home protected page returns the next sign-in to Home, also while server revocation is delayed.
- [`shell.spec.ts`](scenarios/shell.md) — the icon rail collapses and expands the navbar and remembers it across a reload; the account menu's theme items switch and persist the color scheme; the tab title names the page and a navigation moves the focus to `#main-content`; Tab closes the open account menu; Home's three links reach their pages; the deploy notice shows once a newer build is served, survives a navigation and goes after Reload.
- [`changelog.spec.ts`](scenarios/changelog.md) — the what's-new dot on a fresh device leads to the changelog via the version stamp and clears once read.
- [`i18n.spec.ts`](scenarios/i18n.md) — the synced per-user language: a throwaway user switches to Polish, the choice survives a reload and a wiped-device re-login (the tab title follows), and the admin's English flips it back.
- [`mfa.spec.ts`](scenarios/mfa.md) — the `/feature-flags` row switch and per-user editor round-trip a throwaway user's MFA flag; an MFA-enabled account signs in with the revealed generated password and the emailed 6-digit code via Mailpit.
- [`password-reset.spec.ts`](scenarios/password-reset.md) — the forgot-password flow covers neutral confirmation and per-email throttle. The emailed single-use link keeps the old password until the new one is set, then ends the old session and works once.
- [`users.spec.ts`](scenarios/users.md) — the account lifecycle: create via the one-time password reveal, the new user's limited view and self password change, promotion, deletion, the dead login; own-row protections; an admin's demotion and deletion reach a signed-in user on their next request; the "Also create a linked person" switch creates a person for the plan's owner picker.
- [`people.spec.ts`](scenarios/people.md) — the people directory: create through the modal, link a login from the picker and rename, the list shows the login's email, delete from the row; a regular user's read-only list and person page.
- [`teams.spec.ts`](scenarios/teams.md) — the flat-teams registry: create, rename, assign a manager, delete (the focus lands on the "Teams" heading); Escape on a row's dialogs returns the focus to the row's menu button, Tab in an open row menu moves on from the kebab; a regular user's read-only list and team page; an admin gives a team a colour and its milestone bar and Team-cell swatch on the project page carry it.
- [`telemetry.spec.ts`](scenarios/telemetry.md) — the ADMIN telemetry panel: after the sampler's first sample the admin opens it from the account menu and reads Memory and Storage; the open panel and its sections survive a reload; a regular user has no menu item; an axe scan with every section open.
- [`list-mutation-refresh.spec.ts`](scenarios/list-mutation-refresh.md) — a held first filter-response for Users or Teams cannot restore a deleted row; a held Feature Flags response cannot undo a successful toggle.
- [`dialog-focus.spec.ts`](scenarios/dialog-focus.md) — the `useDialogFocus` sweep, one dialog per owner page that is not Teams (Plan, ProjectView, TeamDetails, TeamCapacity, People, PersonDetails, Baselines, Users): Enter on the opener focuses inside the dialog, Escape returns the focus to the opener. It writes nothing.

### The plan and its lists

- [`plan.spec.ts`](scenarios/plan.md) — the Plan page, one tree table: an admin builds work stream, program and project through the modals, hands the project over, folds a stream (remembered across a reload), searches by name (kept in the address, ancestors shown as context rows), pins a program (kept in the browser, in reach during a search) and narrows the table with Show only this, sees a delete refused while a parent has children; a project owner acts only on their own project; a work stream owner moves a project and a program with "Move to…", the ranking untouched.
  An owner re-orders its programs by a real drag and from the row menu (the focus stays on the menu button; a reader has no grip; the Programs page and an admin read the same order); an admin moves one of its own work streams above another, a closed one staying last.
- [`home.spec.ts`](scenarios/home.md) — Home: the owner of a project reads "Yours" (own project and a second owner's project, team, program and work stream, each with its figures and flags), passes axe, follows the links to the Milestones and Roadmap pages with the filters set; a login linked to no person reads the not-linked note; "Only what I own myself" narrows the rows and survives a reload.
- [`milestones.spec.ts`](scenarios/milestones.md) — the Milestones page: pick the spec's team and read its three milestones, filter "Not scheduled" (kept in the address and after a reload), pick a project in the Project select, and a project name opens the project page; the Rank column sorts by the project's rank with unranked projects last both ways (it appends two projects to the global ranking), and the work stream and program filters narrow the list from the address and drop a program outside a newly picked work stream.
- [`team-load.spec.ts`](scenarios/team-load.md) — the Team load page: `?warning=overloaded` lists the overloaded team and "Every team" drops the filter; the "Weeks with a warning, by team" row matches the team page's weekly table; "Include past weeks" brings an earlier overloaded week back.
- [`dependency-list.spec.ts`](scenarios/dependency-list.md) — the Dependencies page: a project's links with the violated one first, the Status filter, the project link; the page is reached from the Roadmap row menu, the team page and Home; an owner edits a link's type and deletes it from the list, a login linked to no person has no operations column; an owner adds a link from the page's "Add dependency" dialog (the successor's project picker lists only the projects they manage; the list, the filter and the focus afterwards), and a login linked to no person has no such button.
- [`view-revalidation.spec.ts`](scenarios/view-revalidation.md) — the view reads revalidate: an API rename shows on the next in-app open of the team page (the kept tag meets a `200`), and a later open is answered `304` with the new name still shown and no load-failure alert.
- [`public-holidays.spec.ts`](scenarios/public-holidays.md) — the public-holiday dictionary, in 2040: add, the duplicate-date message, the Polish preset (14 rows, again adds none), delete behind a confirmation; a regular user has no add strip, preset or delete; a holiday moves a dependency's "needs" date by a working day and deleting it restores it.

### Timelines and scheduling

- [`project-view.spec.ts`](scenarios/project-view.md) — the project view on the shared Timeline: an owner creates milestones that wait in the Unscheduled tray and cannot schedule them; the team's manager schedules by the Schedule button, the Edit schedule dialog, the keyboard sensor and pointer drags of the bar, the end handle and a tray row, meets the stale-milestone notice, and unschedules; the owner reads the derived span and drift with read-only bars.
- [`dependencies.spec.ts`](scenarios/dependencies.md) — dependencies on the project view: an owner adds a finish-to-start link through the dialog and is refused a cycle; the manager's move makes a conflict (red arrow, badge, "Violated" row); the owner edits a link in place (type and lag) and deletes it; a 14-option Predecessor list is driven by keyboard and passes axe.
- [`team-view.spec.ts`](scenarios/team-view.md) — the team page: the manager adds a capacity period with a WIP limit, schedules two milestones, reads the overloaded week and the WIP warning, moves a milestone to the bottom from its row menu and resets the order, drags a row by its pointer handle; the project owner reads read-only bars and none of the controls.
- [`roadmap.spec.ts`](scenarios/roadmap.md) — the Roadmap: a ROADMAP_EDITOR ranks, moves, drags below the "Unranked" divider and unranks, and meets the "changed in the meantime" notice; a plain user has no handle or ranking item; the target-window band is dragged, drawn, set from the keyboard and cleared; the URL filters (`flagged`, `unranked`, `severity`) and the remembered program pick.
- [`programs.spec.ts`](scenarios/programs.md) — the Programs tree: work stream open and programs folded, span bars with roll-up flags, open and fold by pointer and keyboard, the project link as ONE arrow between the rows that stand for its projects, Expand/Collapse all and Year zoom; the program pick is shared with the Roadmap and can be set in the address.
- [`critical-path.spec.ts`](scenarios/critical-path.md) — the critical path and idle gaps, in 2041: the toggle marks the zero-slack bars and arrows, fills the Slack column and the Critical chain list, survives a reload and, off, takes every trace away; the idle band and its table; the same on the team page, where the whole chain through the team's work (the other team's milestones, two links away too) is dimmed rows with critical arrows and a text table, asked for only while the toggle is on, on the Roadmap ("Show critical path to this project") and on the Programs page.
- [`schedule-proposal.spec.ts`](scenarios/schedule-proposal.md) — the schedule proposal on the team page, in 2042: the manager proposes and reads the dashed bars, the strip and the table, accepts a selection (or a subset) and an accept skips a milestone rescheduled in the meantime; the project owner has no Propose; a pinned milestone is untouched.
- [`cross-team-proposal.spec.ts`](scenarios/cross-team-proposal.md) — the cross-team proposal on `/schedule-proposals`, in 2048: a manager of two teams proposes, reads the sections and the dates a link forces, and accepts across teams; unticking x1 turns y1's Links cell into the red "Conflict"; a manager of one team is offered that team only; the project owner meets the empty state; a saved proposal is opened by a manager of another team, who has no Accept, and accepted from its page by the manager of both teams, after which it reads as changed.
- [`baselines.spec.ts`](scenarios/baselines.md) — baselines, in 2043: take one on `/baselines`, re-plan under it, pick it on the team page (shadow bars, the Movement table), read the comparison page as the project owner, compare two baselines with **Compare against**; a reader has no Take button; rename and delete behind a confirmation; a link added and a capacity period cut after one are listed in the comparison's Links and Capacity sections, and the project page marks the link "New since the baseline".

### Jira

- [`jira-sync.spec.ts`](scenarios/jira-sync.md) — the Jira sync against the stub's `E2E` project, in 2044: create and test a connection (every probe green, the failed state with a wrong token), the discovery report, the mapping and Peek; an owner links a milestone and reads the deviation after a Refresh now; `jira-day2` shows "Gone from Jira" and "Moved out of scope"; Flags, roll-ups and Acknowledge all; the dashed Jira row of an unscheduled milestone and "Schedule on Jira's dates"; the stale chip.
- [`jira-acknowledge.spec.ts`](scenarios/jira-acknowledge.md) — the per-line Jira acknowledgement, in 2044: an owner acknowledges one deviation line and the row, the other lines and the flag cell keep their state; a plan-side change reopens only its line ("changed since"); Acknowledge all and Withdraw all; a team manager acknowledges the milestone's line while a project row shows no button.
- [`jira-polling.spec.ts`](scenarios/jira-polling.md) — Jira polling against the stack's scheduler: a tested connection with a 5-minute interval gets a Scheduled run within two minutes; an untested manual-only connection never syncs; the editor refuses 3 minutes, round-trips 20 and ticks manual-only, after which a new scheduled run appears; the telemetry panel's Sync section lists both.
- [`jira-import.spec.ts`](scenarios/jira-import.md) — import from Jira against the stub's `IMP` and `IMF` projects, in 2045: preview, owners per row, import, the links and the dated tree, a second preview offering nothing, parent/child ticking, skipped-row reasons, the import filter, the preview search with Tick shown, the modal's steps and a five-key preview under axe, and a non-admin work-stream owner importing from the Plan page.
- [`jira-import-children.spec.ts`](scenarios/jira-import-children.md) — import what Jira lists under a linked program or project, against the stub's `IMC` project, in 2045, as a non-admin owner of only that node: the menu item only for a linked node, the preview, the import, an empty root, the connection page's list, the outside-the-root skip and the suggested match (Link instead, Preview again); axe on the dialog.
- [`jira-coverage.spec.ts`](scenarios/jira-coverage.md) — Jira coverage against the stub's `COV` project, in 2046: the roll-up chips in the Flags column, the Deviations page's "not in the plan", "not linked to Jira" and "all child issues done" lines, acknowledging the project row silences the Roadmap entry, and the connection page's Coverage table counts per mapped level.

### Flow

- [`flow-sync.spec.ts`](scenarios/flow-sync.md) — the Flow sync against the stub's "E2E Flow Team", in 2047: create, test and refresh a connection and read its Teams section; the team's manager links the team, previews **Import capacity…** (six rows), applies it and finds six Flow-badged periods; the roster panel to a viewer and the manager, and Unlink behind a confirmation.
- [`flow-capacity-deviation.spec.ts`](scenarios/flow-capacity-deviation.md) — the capacity deviation, in 2047: a team with no capacity folds its sprints into one line; after the manager's import the section no longer lists it; after the stub's `flow-day2` a WARNING and an INFO sprint, the severity filter, and a team gone from Flow's document; the team page's "Capacity vs Flow" fact; axe.
- [`flow-capacity-acknowledge.spec.ts`](scenarios/flow-capacity-acknowledge.md) — the per-sprint acknowledge of the capacity deviation, in 2047: the team page's flag, marked weeks, fact and Acknowledge, Acknowledge all and Withdraw all; the Deviations section under Open, Acknowledged and All; an edited capacity period reopens its line; the project's Flow capacity flag on the Roadmap and Programs pages.

## Logging in

Specs log in with the seeded admin (`admin@astrolabe.local`, password `changeme`), and use unique
content where they create any — so they don't depend on a clean database or absolute counts.

`createUserViaUi()` waits for the one-time password reveal to render before reading the
password. A click on Show password alone is not evidence that the mask has been replaced.
Every journey that creates a user through this shared helper inherits that synchronization.

`helpers.login()` signs in **without the form** (`build-times.md` WHY 37): the real `POST /api/v1/login` through the page's request context, the
session written to `localStorage` under the `astrolabe.auth.*` keys the SPA itself persists (`storeSession` in `web/src/api/session.ts`), then one
load of `/` — the tokens, the revocation blocklist and any per-request credential check are the server's own, nothing is forged or reused
across tests (`signOut` revokes the pair, so a session is minted per call). It takes the seed admin by default or any account's credentials
(a throwaway regular user reads the app as one), and falls back to the real form when the login is refused, answers a challenge (MFA) or the
shell does not accept the session.

`helpers.loginViaForm()` is the real form (clearing any leftover `astrolabe.auth.*` localStorage session
first — while one exists, `RedirectIfAuthed` bounces `/login` away and the form never renders): use it where the credential, the form or
the language riding the login response IS the subject — `users` (the first sign-in with the revealed password), `password-reset` (the
new password), `i18n` (the Polish throwaway and the English admin after it), `auth` and `mfa` (which drive the form inline). Development
stacks lift the per-IP login bucket (`security.rateLimit.loginPerMinute`, 1000/min in development vs 10/min in production), so neither
path is throttled.

## Deliberately not covered

- **Login lockout (429)** — five failed logins would lock the seed admin for 15 minutes in the
  shared database and poison the rest of the run. Covered by the server's login-throttle tests (server).
- **Token refresh / expiry (clock-driven)** — real expiry needs clock control; covered by server
  tests (`RefreshTest`) and the `web/src/api/api.test.ts` unit tests. Browser-side refresh behavior via `page.route` fault injection is a candidate for a future `error-handling.spec.ts`.
- **The authz matrix** — covered by the server tests (`GuardsTest`, `AnonymousAccessTest`); E2E
  asserts only user-visible consequences.
- **Dark-mode rendering** — the palette is theme-owned (`web/src/theme.ts`); `shell.spec.ts`
  asserts the color-scheme attribute switches and persists, and `accessibility.spec.ts` scans the
  page sets in the dark scheme (contrast), but no e2e asserts rendered colors, and there is no
  visual-regression suite.
- **Responsive / cross-browser / visual automation** — the suite deliberately runs a single
  **Desktop Chrome (chromium) project** only, with no mobile project or screenshot comparison;
  layout relies on Mantine semantics plus the role/label-based locators every spec uses.
  Accessibility gets the `accessibility.spec.ts` axe smoke.
