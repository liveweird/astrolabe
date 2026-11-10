# Flow capacity acknowledge (the per-sprint acknowledge on the team page and the Deviations page, the Status filter, the header flag and the marked weeks)

- **Spec**: [tests/flow-capacity-acknowledge.spec.ts](../tests/flow-capacity-acknowledge.spec.ts)
- **Actors**: the seed administrator (the API seeding, the connection's test and refresh, the Deviations page scenario, the teardown), a throwaway TEAM MANAGER login (a user with no administrator right, linked to a person who manages both world teams) who imports the capacity
  through the API, acknowledges on the team page and edits a capacity period through the API.
- **Owns** (exclusive server-side state): ONE Flow connection (`e2e-capack-connection-*`, base URL `E2E_FLOW_STUB_ORIGIN`, the stub's one public service token from `sample-data/flow/expected.json`, `Europe/Warsaw`, **manual only**, made through the API, tested
  once - one call of the per-IP `flow-test` bucket per worker start - and refreshed in the beforeAll); a throwaway world (the manager login, its person, the team `e2e-capack-team-*` linked to the stub's "E2E Flow Team" and the team `e2e-capack-gone-*` linked to "Billing", both
  through that connection; a login-less owner's person, work stream, program and project holding ONE milestone of the team scheduled **2047-01-07 .. 2047-02-15**, so the team view's weekly load - and its strip - covers sprints 1-3); the six capacity periods the import writes
  (they go with the team); the acknowledgements the scenarios make (they go with the binding; each scenario starts by withdrawing every one of the world through the API, so none depends on an earlier one); and the stub's **`flow-day2` SCENARIO**, which this file flips too - the
  second flipper beside `flow-capacity-deviation.spec.ts` - under the Playwright lock **`flow-stub-scenario`** shared with both Flow specs. The beforeAll puts the scenario back to `Started` (and fails fast naming `flow-outage` if a walk left that one on), imports day one's capacity,
  flips to day two only to refresh the mirror once and resets at once; the afterAll resets it even after a failure. Everything is removed through the API (the connection first, then the plan, the teams, the people and the user). **Every date is in 2047** ("E2E Flow Team": six
  two-week sprints from Monday 2047-01-07, ten working days each; nothing writes a holiday there). The Deviations page lists every linked team of the stack, so each page is narrowed to the spec's own team with the `teamId` filter.
- **Needs**: the compose stack with its Flow stub (`flow-stub`, `FLOW_INSECURE_ORIGINS=http://flow-stub:8080`, `FLOW_TEST_RATE_LIMIT_PER_MINUTE=30`) and `E2E_FLOW_STUB_URL` pointing at the stub of the same stack as `E2E_BASE_URL`. The figures are read from `expected.json`
  (`e2e.preview`, `day2.capacityChanges`, `day2.gone`), never copied: after the day-one import (20 / 18 / 22 man-days a week for sprints 1-3) day two reads sprint 2 (`E2E Flow Sprint 2`, 2047-01-21 – 2047-02-01) as a WARNING (the plan has 36.00, Flow 30.00) and sprint 3
  (2047-02-04 – 2047-02-15) as an INFO (the plan has 44.00, Flow 48.00); "Billing" is gone.

## Scenario: the team's manager acknowledges one sprint's difference on the team page: the line reads acknowledged, the Capacity vs Flow fact counts one open difference and one acknowledged, and the header flag and the weeks strip follow

1. (Setup) Every acknowledgement of the team is withdrawn through the API. The manager opens `/teams/<team>`.
   - *Expected*: the header carries ONE flag, "Capacity differs from Flow: 2 open differences" (`data-severity="WARNING"`); the strip cells of the weeks 2047-01-21 and 2047-01-28 carry `data-flow-capacity="WARNING"` and those of 2047-02-04 and 2047-02-11 `"INFO"`, while the
     weeks 2047-01-07 and 2047-01-14 (sprint 1, in line) carry none; the "Capacity vs Flow" fact reads "Differs from Flow for 2 sprints"; the list "Capacity differences from Flow" has the WARNING line (sprint 2) and the INFO line (sprint 3), each with its Acknowledge button.
2. They open the Weekly load table (**Show the weekly figures**).
   - *Expected*: the badge "Differs from Flow" appears on four weeks: two with `data-flow-badge="WARNING"` and two with `"INFO"`.
3. They press **Acknowledge E2E Flow Sprint 3** (the INFO line).
   - *Expected*: the line reads "Acknowledged by <the manager's person> on <date>" and offers Unacknowledge; the fact reads "Differs from Flow for 1 sprint" and "1 acknowledged"; the header flag reads "Capacity differs from Flow: 1 open difference"; the two INFO weeks lose
     `data-flow-capacity`, the two WARNING weeks keep it; sprint 2's line still offers Acknowledge.
4. An axe scan (WCAG A/AA, `color-contrast` included) of `/teams/<team>` in this state, in the light scheme and again in the dark one.
   - *Expected*: zero violations in both (the page carries the scheme asked for).

## Scenario: the Deviations page lists the acknowledged sprint under Status Acknowledged only, the team gone from Flow is acknowledged too, and withdrawing reopens the line

1. (Setup) Every acknowledgement of both teams is withdrawn, then the manager acknowledges sprint 3 through the API (the fingerprint read off the view). The seed administrator opens `/deviations?teamId=<team>&all=false` (the Open list under a team scope).
   - *Expected*: the team's row has exactly one line, sprint 2's WARNING sentence, and not sprint 3's; the totals read "1 warning", "0 infos" and "1 acknowledged".
2. They choose Status **Acknowledged** in the Filters panel.
   - *Expected*: the row has exactly one line, sprint 3's sentence, "Acknowledged by", and an Unacknowledge button; sprint 2's sentence is not listed.
3. They choose Status **All**.
   - *Expected*: both lines are listed - sprint 2 with Acknowledge, sprint 3 with Unacknowledge.
4. They open `/deviations?teamId=<gone team>` and press **Acknowledge the team's own row** on the "Gone from Flow" line.
   - *Expected*: before: the totals read "1 warning"; after: the row stays listed (a team scope lists everything), reads "Acknowledged by", offers Unacknowledge, and the totals read "0 warnings" and "1 acknowledged".
5. They open `/deviations?teamId=<team>&acknowledged=true` and press **Unacknowledge E2E Flow Sprint 3**, then open the Open list again.
   - *Expected*: the row leaves the Acknowledged list; under Open both lines are back (sprint 3 offers Acknowledge), the totals read "1 warning", "1 info" and "0 acknowledged".

## Scenario: a capacity change in the plan reopens only the sprint it touches

1. (Setup) Every acknowledgement of the team is withdrawn. The manager opens `/teams/<team>` and acknowledges BOTH lines, sprint 2's then sprint 3's.
   - *Expected*: both lines read "Acknowledged by <person> on <date>"; the fact reads "No open difference" and "2 acknowledged" and never "In line with Flow"; the header has no flag; no strip cell carries `data-flow-capacity`.
2. The manager (through the API) edits the period starting 2047-02-04 (sprint 3's, written by the import) to 23 man-days a week; the page is opened again.
   - *Expected*: sprint 3's line now has the plan's new figure ("the plan has 46.00 man-days, Flow 48.00 — 2.00 less in the plan"), reads "Acknowledged on <date> by <person> · changed since" and offers Acknowledge again; sprint 2's line still reads "Acknowledged by …" with Unacknowledge; the fact reads
     "Differs from Flow for 1 sprint" and "1 acknowledged"; the header flag reads "Capacity differs from Flow: 1 open difference" with `data-severity="INFO"`; the weeks 2047-02-04 and 2047-02-11 carry `data-flow-capacity="INFO"` and the weeks of sprint 2 carry none.

## Not covered here (and why)

- Who may acknowledge (another team's manager, a stranger: 403; the 409 for a changed fingerprint; the audit events): the server's `CapacityAcknowledgeTest` and `CapacityAcknowledgeRaceTest`; the page shows no button without `can.acknowledge` (`CapacityAckCell.test.tsx`).
- The folded "sprints without capacity" line with its per-row cells, the missing-table's Acknowledgement column and the Polish wording: the web unit tests (`CapacityDeviationList.test.tsx`).
- A disabled connection (its rows list and can be acknowledged, the team view raises no flag) and a never-mirrored one: `CapacityDeviationViewTest` and `FlowFlagSourceTest` (server).
