# The Teams page's load figures (every team's overloaded and over-WIP weeks; the Team load page until 1.32)

- **Spec**: [tests/team-load.spec.ts](../tests/team-load.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, one team (no manager) with one capacity period from Monday 2027-04-05 of 1 man-day a week, a work stream, program, project and ONE milestone of 10 man-days on that team scheduled 2027-04-05 to 2027-04-09 (unique `e2e-load-*` names), all seeded through the API in the test and removed through the API in the afterEach (the project first, then program, work stream, team - its capacity period goes with it -, person), even after a failure. April 2027 on purpose: 10 man-days against 1 a week is overloaded whatever a holiday did to that week, and a near year keeps the team page's timeline short. It writes no ranking, no holiday and no connection, and needs no lock. The plan is shared by four workers, so a plan-wide figure is only ever asserted present, never as a value. The Teams page lists at most 200 teams; a full run holds far fewer at once (the teams are made and deleted per spec), and the first step narrows to the overloaded ones anyway.

> Since 1.32 the page is `/teams` (Team load was folded into it); the first scenario opens the retired address `/team-load` to pin the redirect. Since
> 1.36 the page has no weeks table of its own ("Weeks with a warning" and "Include past weeks" are gone): the week-count badges of a row link to the team
> page's weekly load table (`?load=overloaded|wip|nocapacity`: the first week of the badge's kind is marked), which lists every week, so the April 2027 world does not expire.

## Scenario: the Teams page lists a team with an overloaded week, and its name opens the team page that says the same

1. The administrator signs in and opens `/team-load?warning=overloaded`.
   - *Expected*: the address becomes `/teams?warning=overloaded`; the heading (h2) "Teams"; the spec's team is exactly one row of the table "Teams", with the badge "1 week overloaded" and its row menu "Operations for <team>"; the group "The teams in figures" shows a count of teams, a count of teams with an overloaded week and the plan-wide "N not scheduled yet" (each present, never a value).
2. They open the filter panel, choose "Every team" in the Show select, then click the team's name in the table "Teams".
   - *Expected*: the address has no `warning`; the team page's heading (h2) is the team's name and its "Team facts" group reads "1 week overloaded".

## Scenario: clicking a team's overloaded badge opens its page with the weekly load table open, focused and on the overloaded week

1. The administrator signs in, opens `/teams?warning=overloaded` and clicks, in the spec's team row, the link "1 week overloaded: open the weekly load of team <team>" (the badge).
   - *Expected*: the team page's heading (h2) is the team's name.
2. They read the page without clicking anything.
   - *Expected*: the table "Weekly load of the team" is visible already (its button reads "Hide the weekly figures", `aria-expanded=true`), its scroll region holds the keyboard focus and is in the viewport (the Flow section above it has landed by then), and the address has no `load` parameter (dropped with a `replace`); the table has exactly one row "W14 · 2027-04-05" with one badge matching `Overloaded · +N.NN MD` (a pattern: a holiday in that week would change the capacity, never the week or the load), and that row is marked (`aria-current="true"`) and in the viewport. The link's address is `?load=overloaded`: the badge names the kind of week it counts.

## Scenario: the Teams page shows every warning badge whole at 1440 px and does not scroll sideways at 390 px

Same own world as the first scenario (one team with a "1 week overloaded" week).

1. The administrator signs in at 1440 x 900 and opens `/teams`.
   - *Expected*: the spec's team row reads "1 week overloaded", the badge being a link named "1 week overloaded: open the weekly load of team <team>"; across the whole table (the plan is shared, so every badge, not only the spec's own) no badge label is cut off (its `scrollWidth` is no more than its `clientWidth`).
2. The window becomes 390 x 844.
   - *Expected*: the document is no wider than the window (the table scrolls inside its own box).

## Not covered here (and why)

- The values of `totals`, the WIP badge, the "weeks without capacity" badge, the "Not scheduled" link and the `truncated` line: four workers share the plan or the case needs another capacity setup; vitest and `TeamLoadViewTest` pin them.
- The 2,000-week budget of the document and its order by date (`TeamLoadKernelsTest`, `TeamLoadViewTest`; the web no longer reads the listed weeks).
- The WIP and "without capacity" badge links, the arrival's focus rules (once, a read still running or failed, a team with no week listed) and the Polish names: another capacity setup, or states a real browser cannot hold still; vitest pins them (`Teams.load.test.tsx`, `useWeeklyLoadArrival.test.tsx`, `TeamDetails.weeklyLoad.test.tsx`).
- Home's two capacity badge links (vitest pins the hrefs) and the Polish text (vitest).
