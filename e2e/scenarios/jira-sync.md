# Jira sync (connect, map, link, deviations, unlink, gone, flags, acknowledge)

- **Spec**: [tests/jira-sync.spec.ts](../tests/jira-sync.spec.ts)
- **Actors**: the seed administrator (creates, tests and maps connections in the UI, acts through the API to seed and to link, and presses Refresh now in a
  browser of its own); one throwaway project-owner login per linking test, seeded through the API (a regular user with no administrator right, linked to
  the person who owns the project)
- **Owns** (exclusive server-side state): its Jira connections (unique `e2e-jira-*` names, each scoped to the stub's `E2E` project ONLY - any scope the stub does not list
  falls through to the stub's 401 catch-all - and each given a unique throwaway site `https://stub-e2ejira<random>.atlassian.net`, which the server routes to the stub (the `stub-` prefix is
  the rule: any other site would reach Atlassian), so no binding of another spec or of the user's own connections ever meets one of these: a Jira item is bound once per site), their bindings,
  and a throwaway world per linking test (the owner login, people, a team, a work stream, a program, a project and milestones, unique `e2e-jira-*` names,
  every date in **2044**, which nothing writes a holiday in: 2044-01-04 is a Monday, so the working-day figures below hold). Everything is removed by the
  spec through the API (a test's own rows in its afterEach, the connections the first scenario created and the linking tests share, in the afterAll; a connection's delete unlinks its
  bindings). **It alone flips the stub's `jira-day2` WireMock scenario** (`PUT $E2E_JIRA_STUB_URL/__admin/scenarios/jira-day2/state`, default
  `http://localhost:8096`; the stub is one process with one scenario state): the beforeAll starts it at `Started` and the afterAll puts it back to `Started`
  even after a failure. The file runs serially (`mode: "serial"`) and the parallel pool never runs two copies of it. Test connection and Peek share a
  per-IP bucket (10 a minute by default, 30 on the e2e stacks), so the file spends five calls: the first scenario's connection (created in the UI, tested once, and kept for the third scenario to map
  and peek through; run alone, the third seeds and tests its own), the second's ad-hoc probe, the one connection the linking scenarios share (tested once, in the
  beforeAll, and given 0.5 man-days per story point through the API), and the third scenario's two peeks. Under `retries` (CI: 2) a retried serial group starts again
  from the first scenario and spends the bucket again. The three scenarios that show a result table also scan it with axe (WCAG A/AA), at no extra call.

The stub's `E2E` project (`sample-data/jira/expected.json`, key `e2e`): E2E-1 a Program, E2E-2 and E2E-3 Initiatives, E2E-4..E2E-10 Epics, every date in 2044.
`E2E-4` "E2E Epic One" runs Mon 2044-01-04 to Fri 2044-01-08. `E2E-6` "E2E Epic Three" runs Sun 2044-02-14 to Thu 2044-02-18 and is deleted on day 2. The refused
token is `wrong-token`. A run takes seconds and the page's Refresh now starts it: nothing here sleeps, every wait is on what the page shows.

## Scenario: admin creates a Jira connection, tests it and sees every probe green

1. The administrator opens `/integrations/jira`, presses **New connection** and fills the name, the site (a unique throwaway tenant URL), the account email, the
   API token (`e2e-jira-token`) and the one project key `E2E` (typed, Enter), and presses **Create**.
   - *Expected*: the POST answers 201 and the page lands on `/integrations/jira/<id>` under the connection's name; the facts say "A token is stored", list `E2E`
     and read "Never tested".
2. They press **Test connection**.
   - *Expected*: the status line reads "Test passed. OK: n of n." with n the same twice; the result table has an "OK" badge on `tenant_info`, `myself`,
     `issuetype`, `search`, `field`, `projects` and `project:E2E` and no "Failed" badge; the cloud id is shown, a gray note says the test was answered by the built-in development Jira stub, not by
     Atlassian, and the facts' site wears the "Development stub" badge and the last test reads "Passed".
3. They wait for the "Connection created" toast to go.
   - *Expected*: an axe scan of the whole page, with the green result table, reports zero violations.

## Scenario: a wrong token shows the failed probes with their scope hints

1. The administrator opens the New connection dialog, fills a unique site, an email, the token `wrong-token` and the key `E2E`, and presses the dialog's own
   **Test connection** (an ad-hoc probe: nothing is saved).
   - *Expected*: the status line reads "Test failed. Required probes that failed: n of n."; the `myself` row is "Failed" with the status 401, "Jira refused the
     credentials" and "needs scope: read:jira-user"; the `issuetype`, `search`, `field` and `projects` rows carry "needs scope: read:issue-type:jira",
     "read:jql:jira", "read:field:jira" and "read:project:jira"; the unauthenticated `tenant_info` row is still "OK".
2. An axe scan scoped to the open dialog.
   - *Expected*: zero violations - the red failure state included.
3. They press **Cancel**.
   - *Expected*: the dialog closes; the scenario created no connection; the token is in no text of the result table and in none of the Jira connections list.

## Scenario: admin maps the levels and fields and peeks an issue through the mapping

1. The administrator opens the page of the connection the first scenario created and tested (nothing is mapped on it; run alone, a connection seeded through the API
   and tested once).
   - *Expected*: the Mapping section's discovery report reads "On the site: 60 fields and 7 issue types, read … UTC.", the hierarchy levels, and a line for the
     assumption markers the defaults rest on: Target start `customfield_10022`, Target end `customfield_10023`, the Team field `customfield_10001` and the
     legacy Parent Link field.
2. They read the mapping form, which says nothing is saved yet.
   - *Expected*: the defaults the site's hierarchy gives - milestone "Level 1 — Epic", project "Level 2 — Initiative", program "Level 3 — Program".
3. They enter 0.5 man-days per unit (the stub's epics carry twice the plan's man-days as Story Points) and press **Save mapping**.
   - *Expected*: the form says "This is the saved mapping." and reopens on 0.5; the facts' Field mapping reads "Saved".
4. They Peek `e2e-4`.
   - *Expected*: the Peek result reads Key E2E-4, Summary "E2E Epic One", Type "Epic", Plan level "Milestone", Start 2044-01-04, End 2044-01-08 and an estimate
     of exactly "5 Story points" (Jira's own figure: the 0.5 conversion shows on the Deviations page, scenarios 4 and 5). After the "Mapping saved" toast has gone, an axe
     scan of the whole page, with the Peek result, reports zero violations.
5. They map the milestone's **End** to "Due date — duedate" (which the stub's E2E epic does not carry), save, and Peek again.
   - *Expected*: the earlier result disappears with the save (a result belongs to the mapping it was read under); the new one still reads Start 2044-01-04 and now
     End "—": the same issue, read through the other mapping.

## Scenario: an owner links a milestone to a Jira epic and the Deviations page shows its end three working days later after a refresh

The title's "later" is the plan's: Jira's end is the earlier one. The milestone is scheduled Mon 2044-01-04 to **Wed 2044-01-13** against `E2E-4`'s Fri 2044-01-08, and
the page's sentence is "Ends 3 working days later than Jira" (Mon 01-11, Tue 01-12, Wed 01-13; the weekend 01-09/01-10 does not count - an end on Wed 01-12 would
read "2"). The stub's own figure for its E2E data (`endLaterWorkingDays: 3`) is Jira's end against the plan's, the other way round.

1. The project owner (no administrator right) opens the project page and, from the milestone's row menu, **Link to Jira…**; they pick the connection (the dialog's
   connections come from the Deviations view, since the registry is for administrators), type `E2E-4` and press **Link**.
   - *Expected*: the POST answers 201 and the dialog closes; the facts line's Jira group reads "1 milestone linked to Jira"; the row menu now offers "Unlink from Jira:
     E2E-4".
2. They follow the group's deviation count to the Deviations page (`/deviations?projectId=<id>`).
   - *Expected*: the connection's row in "Data from Jira" reads "Never refreshed" and has no Refresh now button for this user.
3. The bind wrote the item's first reading itself, so the row would read the same before and after a refresh. The spec therefore reads the Deviations view's `observedAt` of
   the item (when the server last read it from Jira) through the API, as the administrator.
4. The administrator, in a browser of their own, opens the same page and presses **Refresh now: <connection>**.
   - *Expected*: the connection's row reports "Succeeded" (the page re-reads by itself while the run goes; no fixed wait), and the item's `observedAt` is strictly greater
     than at step 3.
5. The owner reloads the Deviations page.
   - *Expected*: the connection's row is "Succeeded" and no longer says no refresh has finished; the milestone's row (one) shows E2E-4 "E2E Epic One", "Plan 2044-01-04 →
     2044-01-13", "Jira 2044-01-04 → 2044-01-08", "Ends 3 working days later than Jira" and, the connection declaring 0.5 man-days per point against `E2E-4`'s 5 points,
     "Estimate is 3.00 man-days in the plan and 2.50 man-days in Jira".

## Scenario: unlinking the milestone removes its deviation, and a deleted Jira item reads as gone

1. Two milestones of one project are linked to the connection through the API: `moved` (Mon 2044-01-04 to Wed 2044-01-13) to `E2E-4`, `kept` (Sun 2044-02-14 to Thu
   2044-02-18, the days of `E2E-6`) to `E2E-6`. The project owner opens `/deviations?projectId=<id>`.
   - *Expected*: `moved` reads "Ends 3 working days later than Jira"; `kept` has the same dates on both sides and no working-day sentence.
2. The owner opens the project page and, from `moved`'s row menu, chooses **Unlink from Jira: E2E-4** and confirms.
   - *Expected*: the confirmation names the milestone and E2E-4 and says nothing changes in Jira; the dialog closes.
3. They open the Deviations page again.
   - *Expected*: `kept` is listed, `moved` is not: its deviation went with the link.
4. `kept`'s row does not say "Gone from Jira" yet. The stub moves to day 2 (E2E-6 deleted); the administrator, in a browser of their own, presses **Refresh now:
   <connection>** and waits for `kept`'s row to show "Gone from Jira". The stub goes back to day 1 at once (in a `finally`), before anything else is read.
5. The owner reloads the page.
   - *Expected*: `kept`'s row shows E2E-6, the badge "Gone from Jira", the warning "Gone" with "Deleted in Jira (or no longer visible to the connection's
     account)" (the run's probe of E2E-6 got the stub's 404) and its "Data as of" cell ends in "· stale" (what a row shows is what was last read); the totals read "1 gone from
     Jira".
6. The afterAll puts the stub back to `Started` once more, as the backstop.
   - *Expected*: nothing of this test's state remains - the connection (and with it the bindings), the plan rows and the logins are deleted.

## Scenario: the owner's milestone deviation shows as a flag and a Jira bar on the project page and on the roadmap; acknowledging it clears the flag, and the Jira item's deletion brings it back

The sixth scenario of the serial group, and the second user of the `jira-day2` flip. Its world (the usual per-test one, dated 2044): one milestone scheduled Sun
2044-02-14 to **Tue 2044-02-23** and linked (through the API, as the setup) to `E2E-6` (Sun 02-14 to Thu 02-18: three working days later, Fri 19, Mon 22, Tue 23), and its project linked
to `E2E-2` "E2E Initiative Alpha" (2044-01-04 to 02-18, `E2E-6`'s own parent in Jira, so there is no parent mismatch), whose dates the project's derived span misses at both ends.
It spends no Test connection call (the shared `linking` connection is already tested). Since 1.4 the `E2E-2` project binding also raises an `UNLINKED_IN_JIRA` warning (the open epics `E2E-4` and `E2E-5` under it that no milestone is linked to).

1. The project owner (no administrator right) opens the project page.
   - *Expected*: a **Flags** column; the milestone row's key link "E2E-6 (opens in Jira)" and its flag icon, whose label reads "Jira E2E-6: Ends 3 working days later than
     Jira"; the toolbar's **Jira dates** toggle is on (`aria-pressed`, on by default) and exactly one dashed `[data-tone="jira"]` bar is drawn.
2. They open the roadmap, narrowed to the world's own program (the program pick is a browser setting), and press **Show the N flags**.
   - *Expected*: the **Jira dates** toggle is on; the flag table reads "1 milestone deviates from Jira" and "Jira E2E-2: Ends 3 working days later than Jira" for the
     project; the project's own dashed Jira bar is drawn (one `[data-tone="jira"]`).
3. They open `/deviations?projectId=<id>&all=false` (the Open list under a project scope), see the milestone's row ("Ends 3 working days later than Jira") and press **Acknowledge
   all (3) open deviations of E2E-6** (since 1.12 each line has its own button - End, Estimate and Renamed here - and the batch button takes the three together; buttons are
   matched by their FULL accessible name, because "Acknowledge E2E-6: End" is a substring of "Unacknowledge E2E-6: End").
   - *Expected*: the row leaves the Open list. They open Filters and choose Status **Acknowledged**: the row is back, "Acknowledged by …", with **Unacknowledge E2E-6: End** and
     **Withdraw all (3) acknowledged deviations of E2E-6**.
4. They open the project page and the roadmap again.
   - *Expected*: the key link stays, the flag icon is gone (no `data-flags` for the row), the Jira bar stays (it shows Jira's dates, not the deviation); the roadmap's flag
     table still has the project's "Jira E2E-2" sentence and no longer says "deviates from Jira".
5. The stub moves to day 2 (`E2E-6` deleted); the administrator, in a browser of their own, presses **Refresh now: <connection>** on the Deviations page and waits for the
   milestone's row to show "Gone from Jira". The stub goes back to day 1 at once (in a `finally`).
6. The owner opens the Open list again (`&all=false`).
   - *Expected*: the milestone is listed again, "Gone from Jira", now as ONE line: a gone item raises GONE alone, so the End, Estimate and Renamed lines (and their stamps) are no longer
     listed, and the GONE line was never acknowledged - it is open, its acknowledgement block does not say "· changed since" (that marks a stored stamp whose line changed) and
     **Acknowledge E2E-6: Gone** is offered; the project page's row has its flag icon back (the "gone" sentence), and the roadmap's flag table says "1 milestone deviates from Jira" again.
7. The afterEach removes the bindings and the world; the afterAll puts the stub back to `Started`, as the backstop.

## Not covered here (and why)

- A passing run on a disabled connection, a failing run and the stale banners: the Deviations page's own unit tests; the stub offers no failing site for this
  project beyond the wrong token.
