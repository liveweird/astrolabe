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
  (`e2e-axe-team-*`) and one API-seeded fixture plan (`e2e-axe-*`, with two milestones); `users` owns its throwaway accounts; `teams` owns its throwaway teams (unique `e2e-team-*` names), person and user; `people` owns its throwaway people (unique `e2e-person-*` names) and users; `plan` owns its throwaway people, work streams, programs, projects (unique `e2e-plan-*` names) and user; `project-view` owns its throwaway users, people, team, plan nodes and milestones (unique `e2e-pv-*` names), all seeded and removed through the API (the project first, its milestones go with it); `roadmap` owns its throwaway people, plan nodes (unique `e2e-rm-*` names) and users, and ranks only its own projects (the global ranking is shared, append-only state: assertions are about the relative order of its own rows, and a stale-revision refusal caused by another spec's plan write is retried); `i18n` owns its throwaway user (and ONLY that user's
  language — **seeded accounts must stay English**: every login applies the stored language to
  that session's UI, so a Polish seed admin would flip parallel specs mid-run); `password-reset`
  owns its throwaway account (its reset requests use unique per-run emails against the
  in-memory per-email throttle, and both tests together stay under the per-IP 5/min request
  bucket and the 10/min confirm bucket); `mfa` owns its throwaway accounts and toggles ONLY their MFA flags (the seed admin's
  MFA flag is never touched — enabling it would make every spec's login demand a code);
  `list-mutation-refresh` owns its own uniquely named users/teams, created and deleted through
  the real API — all deleted by their own spec; `telemetry` owns one throwaway user.
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
  the admin's own edit-user and user-features pages), the Plan page, the Roadmap (its fixture project ranked for the scan) and the project view (the timeline, the drift badge and the tray) with an API-seeded work stream, program, project and two milestones (light and dark), `/reset-password` and its confirm page (the form state, from a well-formed link), the not-found page, and a
  registry editor modal and the Plan project editor modal scoped to their dialogs; the app shell at a mobile width (390x844, the burger present), light and dark; the login screen and the list/form pages again in
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
- [`project-view.spec.ts`](scenarios/project-view.md) — the project view and the shared Timeline in a real browser: a project owner opens the project from the
  Plan page's name link, creates milestones (team picker, estimate) that wait in the Unscheduled tray and has no way to schedule them; the milestone's
  team manager schedules by the tray's Schedule button, the Edit schedule dialog, dnd-kit's keyboard sensor, a pointer drag of the bar, a pointer drag of
  the end handle and a pointer drop of a tray row onto the (scrolled) timeline, meets the stale-milestone notice when the admin API moved the bar, and
  unschedules; the owner reads the derived span and the drift (orange, in words) with read-only bars and no handles.
- [`roadmap.spec.ts`](scenarios/roadmap.md) — the Roadmap page: an admin grants ROADMAP_EDITOR on Users → Permissions; that
  editor ranks two API-seeded projects (Rank appends), reorders them with Move up from the keyboard (focus stays in the row),
  dnd-kit's keyboard sensor and a pointer drag, unranks one, and meets the "roadmap changed in the meantime" notice and reload when
  the plan revision moved under the open page; a plain user sees the ranked list read-only (no handles or buttons).
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
