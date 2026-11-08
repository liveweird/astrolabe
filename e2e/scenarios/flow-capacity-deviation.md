# Flow capacity deviation (the Deviations page's "Capacity from Flow" section and the team page's "Capacity vs Flow" fact)

- **Spec**: [tests/flow-capacity-deviation.spec.ts](../tests/flow-capacity-deviation.spec.ts)
- **Actors**: the seed administrator (the API seeding, the connection's test and refresh, the teardown), a throwaway TEAM MANAGER login (a user with no administrator right, linked to a person who manages both world teams) who reads the pages and
  imports the capacity through the API.
- **Owns** (exclusive server-side state): ONE Flow connection (`e2e-capdev-connection-*`, base URL `E2E_FLOW_STUB_ORIGIN`, the stub's one public service token from `sample-data/flow/expected.json`, `Europe/Warsaw`, **manual only**, made through the API, tested
  once - one call of the per-IP `flow-test` bucket per worker start - and refreshed once in the beforeAll); a throwaway world (the manager login, its person, the team `e2e-capdev-team-*` linked to the stub's "E2E Flow Team" and the team `e2e-capdev-gone-*`
  linked to the stub's "Billing", both through that connection, so no other spec's connection ever meets their Flow-team uniqueness); the six capacity periods the import writes (they go with the team); and the stub's **`flow-day2` SCENARIO**, which this
  file alone flips (the stub is one process with one state). It holds the Playwright lock **`flow-stub-scenario`**, shared with `flow-sync.spec.ts` (whose figures are day one's). The beforeAll puts the scenario back to `Started` (and fails fast naming
  `flow-outage` if a walk left that one on); the afterAll resets it even after a failure; the second scenario resets it as soon as the mirror has read day two. Everything is removed through the API (the connection first - the links go with it - then the teams, the
  person and the user). **Every date is in 2047** ("E2E Flow Team": six two-week sprints from Monday 2047-01-07, ten working days each; nothing writes a holiday there). The section lists every linked team of the stack, so each page is narrowed to the spec's own team
  with the `teamId` filter and every assertion is about that team's rows (the totals badges are therefore the team's own).
- **Needs**: the compose stack with its Flow stub (`flow-stub`, `FLOW_INSECURE_ORIGINS=http://flow-stub:8080`, `FLOW_TEST_RATE_LIMIT_PER_MINUTE=30`) and `E2E_FLOW_STUB_URL` pointing at the stub of the same stack as `E2E_BASE_URL` (the spec writes the scenario state
  through it). The figures are read from `expected.json` (`e2e.preview`, `day2.capacityChanges`, `day2.gone`), never copied: day two lowers sprint 2 from 36 to 30 and raises sprint 3 from 44 to 48 man-days and drops "Billing" from Flow's document.

## Scenario: the Deviations page lists the sprints a linked team has no capacity for, and importing the capacity brings it in line

1. (Setup) The world's team is linked to "E2E Flow Team" and has no capacity period. The manager opens `/deviations?teamId=<team>`.
   - *Expected*: the "Capacity from Flow" section is there; "Data from Flow" lists the spec's connection as Current; the team's row names its Flow team and reads, as ONE line with the hidden word "Info:", "6 sprints without capacity in the plan (from 2047-01-07)"; the totals read "0 warnings" and "6 infos".
2. They open the line's disclosure (**Show the sprints**).
   - *Expected*: the table "Sprints without capacity in the plan" has a row per sprint of `expected.json` with Flow's sprint name, its dates (`2047-01-07 – 2047-01-18`, ...) and Flow's figure with two decimals (40.00, 36.00, 44.00, ...).
3. They open `/teams/<team>`.
   - *Expected*: the "Link to Flow" facts have the row "Capacity vs Flow" reading "No capacity in the plan for 6 sprints".
4. An axe scan (WCAG A/AA, `color-contrast` included) of `/deviations?teamId=<team>` with the sprints' table open, in the light scheme and again in the dark one.
   - *Expected*: zero violations in both (the page carries the scheme asked for).
5. The manager (no administrator right) previews and applies the capacity import through the API, as the modal does: the preview's ticked rows, nothing else.
   - *Expected*: the apply answers 200, creates six periods and skips none.
6. They reload `/deviations?teamId=<team>` and `/teams/<team>`.
   - *Expected*: the page is narrowed to the team, so the section says "No capacity difference matches the filters.", the team has no row, the totals read "0 warnings" and "0 infos"; the team page reads the green text "In line with Flow" (its connection is enabled and current) and no longer "No capacity in the plan".

## Scenario: after the stub's day two the imported team has more capacity than Flow for one sprint and less for another, and a team whose Flow team vanished reads gone

1. (Setup) The team's capacity is imported when the first scenario has not done it (this scenario then runs alone). The stub's `flow-day2` scenario is flipped to day two, the connection is refreshed through the API (a bounded poll on the runs API) and the stub is put back to `Started`.
2. The manager opens `/deviations?teamId=<team>`.
   - *Expected*: the team's row has exactly two lines, the WARNING first: "E2E Flow Sprint 2 (2047-01-21 – 2047-02-01): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan" with the hidden word "Warning:" and the kind "Capacity", then "E2E Flow Sprint 3
     (2047-02-04 – 2047-02-15): the plan has 44.00 man-days, Flow 48.00 — 4.00 less in the plan" with "Info:"; the totals read "1 warning" and "1 info" (every figure and name from `expected.json`).
3. They open `/deviations?teamId=<team>&severity=WARNING`.
   - *Expected*: only the warning line is left (the team's rows are narrowed, not only the team), the info line is gone and the totals read "0 infos".
4. They open `/deviations?teamId=<gone team>`.
   - *Expected*: the row names "Billing" and reads "The Flow team is no longer in Flow's document" with "Warning:" and the kind "Gone from Flow"; the totals read "1 warning" and "of which 1 team gone from Flow".
5. They open the imported team's page and then the gone team's page.
   - *Expected*: the first has the fact "Capacity vs Flow" reading "Differs from Flow for 2 sprints" and, under the facts, the list "Capacity differences from Flow" with both sentences; the second shows the panel's own "No longer in Flow" badge and no "Capacity vs Flow" fact (the comparison adds no second badge).
6. An axe scan of `/deviations?teamId=<team>` (a warning and an info) and of `/deviations?teamId=<gone team>`, each in the light and in the dark scheme.
   - *Expected*: zero violations in all four.

## Not covered here (and why)

- The "In line with Flow in the data read at T" empty state of the unfiltered section: the section lists every linked team of the stack, so another spec's (or the user's) team could be in it; the server suite and `CapacityDeviationsSection.test.tsx` pin the wording.
- A disabled, failed or stale connection, a truncated list and the filters other than `teamId` and `severity`: `CapacityDeviationViewTest` (server) and the section's unit tests.
- The ADMIN's **Refresh now** button of "Data from Flow": its run is the same `POST /integrations/sync/runs` this spec makes through the API (`refreshFlowConnectionViaApi`); the section's unit test presses it.
