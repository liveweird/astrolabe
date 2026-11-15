# Team load (every team's overloaded and over-WIP weeks)

- **Spec**: [tests/team-load.spec.ts](../tests/team-load.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, one team (no manager) with one capacity period from Monday 2027-04-05 of 1 man-day a week, a work stream, program, project and ONE milestone of 10 man-days on that team scheduled 2027-04-05 to 2027-04-09 (unique `e2e-load-*` names), all seeded through the API in the test and removed through the API in the afterEach (the project first, then program, work stream, team - its capacity period goes with it -, person), even after a failure. April 2027 on purpose: 10 man-days against 1 a week is overloaded whatever a holiday did to that week, and a near year keeps the team page's timeline short. It writes no ranking, no holiday and no connection, and needs no lock. The plan is shared by four workers, so a plan-wide figure is only ever asserted present, never as a value. The page lists at most 200 teams; a full run holds far fewer at once (the teams are made and deleted per spec), and the first step narrows to the overloaded ones anyway.

## Scenario: the Team load page lists a team with an overloaded week, and its name opens the team page that says the same

1. The administrator signs in and opens `/team-load?warning=overloaded`.
   - *Expected*: the heading (h2) "Team load"; the spec's team is exactly one row, with the badge "1 week overloaded"; the group "Team load in figures" shows a count of teams and a count of teams with an overloaded week (each present, never a value).
2. They open the filter panel, choose "Every team" in the Show select, then click the team's name in the teams table ("Load of every team").
   - *Expected*: the address has no `warning`; the team page's heading (h2) is the team's name and its "Team facts" group reads "1 week overloaded".

## Scenario: the Team load page lists the team's overloaded week with how far it is over, and the team's page shows the same week

1. The administrator signs in and opens `/team-load?warning=overloaded`.
   - *Expected*: the heading (h3) "Weeks with a warning" and, in the table "Weeks with a warning, by team", exactly one row that links to the spec's team (the plan is shared, so the rows are narrowed to the team's link before anything is read): the week "W14 · 2027-04-05", the load "10.00" and one badge matching `Overloaded · +N.NN MD` (a pattern: a holiday in that week would change the capacity, never the week or the load).
2. They click the team's name in that row and open "Show the weekly figures" on the team's page.
   - *Expected*: the team page's heading (h2) is the team's name, and the table "Weekly load of the team" has exactly one row "W14 · 2027-04-05" carrying the same badge text as step 1.

## Not covered here (and why)

- The values of `totals`, the WIP badge, the "weeks without capacity" badge, the "Not scheduled" link and the `truncated` line: four workers share the plan or the case needs another capacity setup; vitest and `TeamLoadViewTest` pin them.
- The weeks table's budget and its cut line ("Not every week is listed: the list stops after N weeks, team by team, so a later team may show fewer weeks or none."), a week over the WIP limit and the filter's effect on the listed weeks: a cut needs thousands of warning weeks, the WIP case another capacity setup, and four workers share the plan; vitest and `TeamLoadViewTest` pin them.
- Home's two capacity badge links (vitest pins the hrefs) and the Polish text (vitest).
