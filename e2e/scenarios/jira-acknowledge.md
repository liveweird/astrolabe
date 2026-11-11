# Jira acknowledgement per line (one line, a plan-side change, Acknowledge all / Withdraw all, the team manager)

- **Spec**: [tests/jira-acknowledge.spec.ts](../tests/jira-acknowledge.spec.ts)
- **Actors**: one throwaway project-owner login per test (a regular user linked to the person who owns the project), the seed administrator (seeds through the API and, in the
  second scenario, changes the plan from the side), and in the last scenario a throwaway team-manager login (a regular user linked to the person who manages the milestone's
  team and owns nothing on the project's chain)
- **Owns** (exclusive server-side state): ONE Jira connection (`e2e-jack-connection-*`, scoped to the stub's `E2E` project ONLY on a unique throwaway `stub-` site
  `https://stub-e2ejack<random>.atlassian.net`, manual only, given 0.5 man-days per story point), its bindings (a milestone to `E2E-4` or `E2E-5` per test; in the last
  one also the project to `E2E-2`) with their per-line acknowledgements, and a throwaway world per test (the logins, people, a team, a work stream, a program, a project and one
  milestone, unique `e2e-jack-*` names, every date in **2044**, which nothing writes a holiday in), all seeded and removed through the API (a test's own rows in its afterEach,
  bindings first - their acknowledgements go with them -, the connection in the afterAll). It **never flips** the stub's `jira-day2` scenario (only `jira-sync.spec.ts` does;
  `E2E-2`, `E2E-4` and `E2E-5` read the same on both days, and `E2E-6` is never bound) and needs no lock. The file runs serially (`mode: "serial"`) and spends ONE call of the
  shared Test connection bucket (the beforeAll's, per worker start of the file).

The stub's `E2E` project (`sample-data/jira/expected.json`): `E2E-2` "E2E Initiative Alpha", `E2E-4` "E2E Epic One" (Mon 2044-01-04 to Fri 01-08, 5 points), `E2E-5` "E2E Epic Two"
(Tue 2044-02-01 to Thu 02-10, 8 points, a child of `E2E-2`). At 0.5 man-days per point `E2E-4` reads 2.50 man-days and `E2E-5` 4.00. A milestone bound to `E2E-4`, scheduled
2044-01-04 to **Wed 01-13** with 3 man-days, raises THREE lines: End (a warning, "Ends 3 working days later than Jira"), Estimate ("Estimate is 3.00 man-days in the plan and 2.50
man-days in Jira") and Renamed (its name differs from "E2E Epic One"; both are infos). Each line has its own button named by the Jira key and the kind ("Acknowledge E2E-4: End"),
every button is matched by its FULL accessible name (`exact`), because "Acknowledge E2E-4: End" is a substring of "Unacknowledge E2E-4: End". With two or more open lines the row's
head also offers "Acknowledge all (N) open deviations of E2E-4", with two or more acknowledged "Withdraw all (N) acknowledged deviations of E2E-4".

## Scenario: the owner acknowledges one line of a milestone's deviations: the other lines stay open and the project page's flag names only them

1. The owner (no administrator right) reads `/deviations?projectId=<id>&all=false` (the Open list under a project scope).
   - *Expected*: one row for the milestone with the three sentences above, **Acknowledge E2E-4: End**, **…: Estimate** and **…: Renamed**, the head's **Acknowledge all (3)**, and no
     "Acknowledged by".
2. They open the project page.
   - *Expected*: the milestone's flag cell (`data-flags`) reads one warning and two infos (`1,2`) and its title carries the End sentence.
3. Back on the Open list they press **Acknowledge E2E-4: End**.
   - *Expected*: the row STAYS in the Open list (two lines are open); the End line reads "Acknowledged by …" with **Unacknowledge E2E-4: End**; **Acknowledge E2E-4: Estimate** and
     **…: Renamed** are untouched; the head now reads **Acknowledge all (2)**; there is no **Withdraw all** (one acknowledged line is not enough for a batch).
4. They open the project page again.
   - *Expected*: the same flag cell now reads no warning and two infos (`0,2`), its title names the Estimate sentence and no longer the End sentence.

## Scenario: a plan-side change to one line keeps the other acknowledged line, and moving the plan's end reopens only End

1. The owner acknowledges the End and the Estimate lines one by one.
   - *Expected*: both read "Acknowledged by …" and the head offers **Withdraw all (2)**; Renamed stays open, so the row stays in the Open list.
2. The administrator changes the milestone's estimate from 3 to 4 man-days through the API, and the owner reloads.
   - *Expected*: the row reads "Estimate is 4.00 man-days in the plan and 2.50 man-days in Jira"; the Estimate line is open again, "… · changed since", with **Acknowledge E2E-4: Estimate**;
     the End line still reads "Acknowledged by …" with no "changed since" and **Unacknowledge E2E-4: End**.
3. The owner acknowledges the Estimate line again, then the administrator moves the milestone's end to Thu 2044-01-14 through the API, and the owner reloads.
   - *Expected*: the row reads "Ends 4 working days later than Jira"; ONLY the End line is open again ("… · changed since", **Acknowledge E2E-4: End**); the re-acknowledged Estimate line
     still reads "Acknowledged by …" and **Unacknowledge E2E-4: Estimate**; Renamed was never touched (**Acknowledge E2E-4: Renamed**); the row is still listed.

## Scenario: Acknowledge all acknowledges every open line and Withdraw all reopens them

1. The owner presses **Acknowledge all (3) open deviations of E2E-4** on the Open list.
   - *Expected*: no line is open, so the row leaves the Open list.
2. They open `/deviations?projectId=<id>` (the project's own scope lists every status).
   - *Expected*: the row is listed with three "Acknowledged by …" sentences, **Unacknowledge E2E-4: End / Estimate / Renamed** and **Withdraw all (3) acknowledged deviations of E2E-4**,
     and no **Acknowledge all**.
3. They press **Withdraw all (3)**.
   - *Expected*: **Acknowledge all (3)** is back, no "Acknowledged by" is left, the three per-line **Acknowledge** buttons are back, there is no **Withdraw all**; the Open list lists
     the row again.

## Scenario: the milestone's team manager acknowledges its line and has no button on the project's row

The milestone (4 man-days, 2044-02-01 to Tue 02-15) is bound to `E2E-5` - the estimate agrees, the end is three working days later: TWO lines, End and Renamed - and the project to
`E2E-2`. The team's manager owns nothing on the project's chain.

1. The manager (no administrator right) reads `/deviations?projectId=<id>&all=false`.
   - *Expected*: the milestone's row shows the End sentence; the project's row ("E2E Initiative Alpha") lists its lines (including "Named “E2E Initiative Alpha” in Jira and “<project>”
     in the plan") and has NO button at all.
2. They press **Acknowledge E2E-5: End** on the milestone's row.
   - *Expected*: the End line reads "Acknowledged by …" with **Unacknowledge E2E-5: End**; Renamed, the only open line left, has **Acknowledge E2E-5: Renamed** and the head no longer
     offers **Acknowledge all**; the project's row still has no button.
