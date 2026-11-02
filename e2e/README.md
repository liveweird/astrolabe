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
  (`e2e-axe-team-*`, with one capacity period carrying a WIP limit of 1) and one API-seeded fixture plan (`e2e-axe-*`, with two milestones in one project, a second project linked as a violated predecessor and a chain project whose zero-slack links feed the critical path) and, for the open-schedule-proposal scans, a second team pair with its own plan (`e2e-axe-prop-*`, dated in 2042); `users` owns its throwaway accounts; `teams` owns its throwaway teams (unique `e2e-team-*` names), person and user; `people` owns its throwaway people (unique `e2e-person-*` names) and users; `plan` owns its throwaway people, team, work streams, programs, projects (unique `e2e-plan-*` names) and users; `project-view` owns its throwaway users, people, team, plan nodes and milestones (unique `e2e-pv-*` names), all seeded and removed through the API (the project first, its milestones go with it); `dependencies` owns its throwaway users, people, team, two projects with a milestone each and the links between them (unique `e2e-dep-*` names), all seeded and removed through the API (the projects first, their milestones and links go with them); `team-view` owns its throwaway users, people, team (with its capacity periods and its order) and plan nodes (unique `e2e-tv-*` names), all seeded and removed through the API (the project first, its milestones go with it; the team's order has its own revision, so an order write never depends on another spec's plan writes); `roadmap` owns its throwaway people, plan nodes, one team with scheduled milestones (the target-window test; they leave with their projects) (unique `e2e-rm-*` names) and users, and ranks only its own projects (the global ranking is shared, append-only state: its page is narrowed to its own program by the program pick, a browser setting, assertions are about the relative order of its own rows, and a stale-revision refusal caused by another spec's ranking write or the delete of a ranked project is retried); `programs` owns its throwaway people, team, work stream, two programs, three projects with scheduled milestones, one project link (unique `e2e-pg-*` names) and users, all seeded and removed through the API (the users through the Users page), never writes the global ranking, and narrows its pages to its own programs with the program pick (a browser setting); `public-holidays` owns **every holiday dated 2040** (the dictionary is global; see the far-off-year rule below), its throwaway reader user and the calendar test's throwaway plan nodes (unique `e2e-hol-*` names); `critical-path` owns its throwaway owner user, people, two teams, work stream, program, three projects with their milestones and links (unique `e2e-cp-*` names), all dated in 2041; `schedule-proposal` owns its throwaway owner and manager users, people, a team with one capacity period, work stream, program, project, three milestones and a link (unique `e2e-sp-*` names), all dated in 2042, seeded per test and removed through the API (the project first), so its tests never share a row; `i18n` owns its throwaway user (and ONLY that user's
  language — **seeded accounts must stay English**: every login applies the stored language to
  that session's UI, so a Polish seed admin would flip parallel specs mid-run); `password-reset`
  owns its throwaway account (its reset requests use unique per-run emails against the
  in-memory per-email throttle, and both tests together stay under the per-IP 5/min request
  bucket and the 10/min confirm bucket); `mfa` owns its throwaway accounts and toggles ONLY their MFA flags (the seed admin's
  MFA flag is never touched — enabling it would make every spec's login demand a code);
  `list-mutation-refresh` owns its own uniquely named users/teams, created and deleted through
  the real API — all deleted by their own spec; `telemetry` owns one throwaway user.
- **The holiday dictionary is global, and its year is owned.** A public holiday applies to every team's calendar, so adding one changes the
  working-day figures (a dependency's "needs" date, slack, idle gaps, weekly load) of every plan that has a day in its year, and bumps the plan
  revision (no client write is staled by it). Therefore **only `public-holidays.spec.ts` writes holidays, and only in 2040**: it sweeps
  every 2040 holiday before its first test and again in its afterAll, and the calendar-in-the-views test lives in the same file (a file's tests
  run serially). A spec that needs the calendar - or must be sure no holiday touches its figures - uses **its own far-off year**: `critical-path`
  seeds everything in **2041** and `schedule-proposal` in **2042** (nothing ever writes a holiday in either; `schedule-proposal` needs a year the team's first capacity period can start in, because a proposal cannot place anything before the first day with capacity, which pins its dates whatever today is), while `dependencies` and `team-view` keep 2027 and `accessibility` 2026
  (no spec writes a holiday in those years either). A new spec that needs a holiday takes the next unused year (2043, ...), records it in its
  scenario's **Owns** line and sweeps by date; the Polish preset is only ever applied to such a year. The far-off years are 2040, 2041 and 2042
  (not 2085+): a project or team timeline's range always includes today, so a year far ahead stretches every timeline spec to decades of
  header day cells. **Precondition of the figure-pinning specs:** the stack under test must hold no public holiday on the days they pin
  (`dependencies`: 2027-01-25..02-12; `team-view`: February 2027) nor in 2040 or 2041 outside `public-holidays`' own rows; the Polish
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
  running it at another time. (The donor project's shared read-only fixture and dispatch-order projects were
  dropped with its data sources; re-port them with the first domain that needs them.)

## What's covered

**Each spec's full design lives in its scenario file under [`scenarios/`](scenarios/README.md)** —
versioned natural-language test-design artifacts (actors, owned state, numbered steps, expected
outcomes). **A new or behaviorally changed test lands with its scenario file and its line below in
the same commit** — this list is the coverage map, the scenario file is the design.

- [`accessibility.spec.ts`](scenarios/accessibility.md) — axe WCAG A/AA smoke: login + the
  authenticated list/form pages (`/`, `/teams`, `/people`, `/users`, `/users/new`, `/feature-flags`,
  `/change-password`, `/changelog`), the detail pages of an API-seeded fixture team (its team page,
  the admin's own edit-user and user-features pages), the Plan page, the Roadmap (a timeline: its fixture projects ranked for the scan, the flag panel open), the Programs tree (the fixture program opened: chevron buttons, summary bars, project rows, the bundle arrow; the program pick narrows it to the fixture) and the team page with an open schedule proposal (the dashed proposal bars, the Proposed schedule section's checkboxes, badges and links column; light and dark; its own 2042 world) and the project view (the timeline, the drift badge and the tray) with an API-seeded work stream, program, project and two milestones (light and dark) and again with the Critical path toggle on (the Slack column, the Critical chain table; light and dark), the Public holidays page (`/public-holidays` among the list pages), `/reset-password` and its confirm page (the form state, from a well-formed link), the not-found page, and a
  registry editor modal, the Plan project editor modal and the Plan "Move to…" modal (with its open options) scoped to their dialogs; the app shell at a mobile width (390x844, the burger present), light and dark; the login screen and the list/form pages again in
  the DARK scheme (`colorScheme: "dark"`, which the `auto` default follows); `color-contrast` included
  (the theme's tokens are AA-tested in `web/src/theme.test.ts`).
- [`auth.spec.ts`](scenarios/auth.md) — login / logout / invalid credentials / guarded deep link with query and hash;
  explicit sign-out from a non-home protected page returns the next sign-in to Home,
  including while server revocation is delayed.
- [`shell.spec.ts`](scenarios/shell.md) — the app shell chrome: the icon rail collapses/expands
  the navbar and remembers the choice across reload; the account menu's theme control switches
  the color scheme and persists it.
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
  the stored value), and the admin's English flips it back; seeded accounts stay English.
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
  details page reads "Manager: …") → delete from the list;
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
