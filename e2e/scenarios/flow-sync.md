# Flow sync (connection, mirror, team link, capacity import, roster)

- **Spec**: [tests/flow-sync.spec.ts](../tests/flow-sync.spec.ts)
- **Actors**: the seed administrator (the first scenario, in the browser; the API seeding and teardown), a throwaway TEAM MANAGER login (a user with no administrator right, linked to a person who manages the world's team) for the second and
  third scenarios, and a throwaway VIEWER login (no right on the team) who reads the roster in the third.
- **Owns** (exclusive server-side state): two Flow connections (unique `e2e-flow-*` names, base URL `E2E_FLOW_STUB_ORIGIN` - default `http://flow-stub:8080`, the address the app reaches the stub at - with the stub's one public service token
  read from `sample-data/flow/expected.json`, time zone `Europe/Warsaw`, **manual only** - `pollIntervalMinutes: null`, so the scheduler never touches them): `e2e-flow-shared-*`, made through the API in the beforeAll, tested once (one call of the per-IP
  `flow-test` bucket) and refreshed once (awaited by a bounded poll on the runs API), and `e2e-flow-ui-*`, made in the first scenario's modal, tested there (the second call) and refreshed there; the link of the world's team to the stub's "E2E Flow Team"
  through the shared connection; the six capacity periods the import writes (they go with the team); and a throwaway world of its own - the manager login, the viewer login, the manager's person and the team `e2e-flow-team-*`, unique
  `e2e-flow-*` names, **every date in 2047** (the stub's "E2E Flow Team": six two-week sprints from Monday 2047-01-07, which nothing writes a holiday in). Everything is seeded and removed through the API (the connections first - their link goes
  with them - then the team, the person and the users) in the beforeAll/afterAll, the afterAll even after a failed beforeAll or test. The `flow-test` tally of the file is **2 per worker start** (the beforeAll's and the first scenario's), of the 30 a minute
  the e2e stacks allow (`FLOW_TEST_RATE_LIMIT_PER_MINUTE`); a 429 in the beforeAll waits the minute out once. The file runs serially: the third scenario reuses the link the second made (or makes its own through the API when it runs alone).
  It **never flips a scenario of the stub** (`flow-day2`, `flow-outage`): the beforeAll reads the stub's admin API (`E2E_FLOW_STUB_URL`, default `http://localhost:8097`) and fails fast, naming the scenario, if one is not at `Started`. It never presses "Link all
  suggested" (that would link the demo plan's teams), needs no lock, and the connection polls nothing.
- **Needs**: the compose stack with its Flow stub (the 1.5.0 images: `flow-stub` on the compose network, `FLOW_INSECURE_ORIGINS=http://flow-stub:8080`, `FLOW_TEST_RATE_LIMIT_PER_MINUTE=30`) and `E2E_FLOW_STUB_URL` pointing at the stub of the same stack as
  `E2E_BASE_URL`. The stub's "E2E Flow Team" (`sample-data/flow/expected.json` `e2e`): sprints 90001..90006 "E2E Flow Sprint 1".."6" from Mon 2047-01-07, each ten working days, 40 / 36 / 44 / 40 / 38 / 42 man-days = 20.00 / 18.00 / 22.00 / 20.00 / 19.00 / 21.00 a
  week; four current members "Stub Quebec One".."Four" and the former "Stub Quebec Former" (a membership from 2025-01-06 to 2026-03-31 in Warsaw's zone); 5 membership rows, 6 sprints. The figures the spec asserts are read from that file, never copied.

## Scenario: admin creates a Flow connection, tests it and refreshes the observed teams

1. The administrator opens `/integrations/flow` and presses **New connection**; the dialog "New Flow connection" opens. They fill Name (unique `e2e-flow-ui-*`), Base URL (the stub's origin) and the Service token (the stub's), see Time zone pre-filled with `Europe/Warsaw`, tick
   **Manual only (no polling)** and press Create.
   - *Expected*: the create answers 201 and the page lands on `/integrations/flow/<id>` with the connection's name as its heading; the facts read "A token is stored", `Europe/Warsaw` and "Never tested".
2. They press **Test connection**.
   - *Expected*: the status region says "Test passed. OK: 2 of 2."; the result table shows "Service token" and "Teams document" both OK, none Failed; the page says "Flow's document · teams: 19 · sprints: 523" (the stub's totals from `expected.json`); the facts
     read "Passed". An axe scan of the page (WCAG A/AA, `color-contrast` included) reports zero violations.
3. Before any refresh the Teams section says "Refresh the connection first" (a test writes no mirror). They press **Refresh now**.
   - *Expected*: the runs table shows a "Succeeded" run; the Teams section lists the stub's teams ("Flow teams: 19 · linked: 0 · with a suggestion: n").
4. They read the rows of "E2E Flow Team" and "Legacy Mainframe".
   - *Expected*: "E2E Flow Team" shows its 5 memberships and 6 sprints (the figures of `expected.json`), "No team of this name", and no Link button; "Legacy Mainframe" likewise has no suggestion and no button.

## Scenario: a team manager links the team to its Flow team, previews the capacity import and applies it

1. The team's manager (no administrator right) opens `/teams/<id>`: the "Flow" section reads "Not linked to a Flow team" and offers **Link to Flow team…**.
   - *Expected*: the button is there for the manager (the panel's `can.link`).
2. They press it. In the dialog "Link to a Flow team" they pick the shared connection in **Flow connection** (the choices come from the team's panel: the registry itself is ADMIN-only), then "E2E Flow Team" in **Flow team**, and press **Link**.
   - *Expected*: the link answers 201 and the dialog closes; the "Link to Flow" facts name "E2E Flow Team" and the connection.
3. They press **Import capacity…**; the dialog "Import capacity from Flow" opens with the preview.
   - *Expected*: six rows "E2E Flow Sprint 1".."6", each with its dates (the first `2047-01-07 – 2047-01-18`, the stub's `start` and `end`), 10 working days, the sprint total in Flow (40 / 36 / 44 / 40 / 38 / 42) and the **Man-days per week** 20.00 / 18.00 / 22.00 / 20.00 / 19.00 /
     21.00, the action "Create" and the row ticked; the summary reads "Selected: 6 · to create: 6 · to update: 0 · to remove: 0". An axe scan scoped to the dialog reports zero violations.
4. They press **Import**.
   - *Expected*: the import answers 200 and the outcome note reads "6 created"; the plan is read again and every row now says "Unchanged" with nothing left selected ("Selected: 0").
5. They close the dialog with Escape and read the capacity table ("Capacity periods of the team").
   - *Expected*: six rows, one per sprint start (`2047-01-07`, `01-21`, `02-04`, `02-18`, `03-04`, `03-18`), each with the gray **Flow** badge titled with its sprint's name and the figure 20 / 18 / 22 / 20 / 19 / 21 man-days per week.

## Scenario: the roster panel shows Flow's current and former members, and unlinking removes it

1. (Setup) If the second scenario did not run, the link is made through the API.
2. A viewer (a login with no right on the team) opens `/teams/<id>`.
   - *Expected*: the roster table "Current members of the Flow team" is there (everyone signed in reads it); there is no **Unlink** and no **Import capacity…** button.
3. The team's manager opens the page.
   - *Expected*: the "Roster" heading and the current members table list exactly the four current members, and "Stub Quebec Former" is not among them; the former table is not shown until the disclosure is opened.
4. They press the disclosure ("1 former member").
   - *Expected*: the table "Former members of the Flow team" lists "Stub Quebec Former" from 2025-01-06 to 2026-03-31 (the instants of `expected.json` in Europe/Warsaw); an "Observed (UTC)" line is shown.
5. They press **Unlink** and confirm in the dialog "Unlink the Flow team?" (it names "E2E Flow Team").
   - *Expected*: the delete answers 204; the section reads "Not linked to a Flow team" again, the current-members table and the Roster heading are gone, the panel's `binding` is null through the API, and the team still holds the same number of capacity periods
     (what was imported stays).

## Not covered here (and why)

- The stub's scenarios (`flow-day2`, `flow-outage`): nothing in 1.5 reads a changed document through the browser; the server suite (`FlowRunTest`) does. 1.6's deviation scenario is the first e2e flip.
- A revoked token, "Link all suggested" and a polled run: the first two are server-tested (`FlowRunWireTest`, `FlowTeamBindingTest`); "Link all suggested" would link the demo plan's teams.
- A re-import after Flow's figures change, a hand-entered period beside an import and the removals list: the kernel and apply suites (`CapacityImportKernelsTest`, `CapacityImportApplyTest`) pin them.
