# The Gantts' hideable columns and "Scroll to today" (1.34)

- **Spec**: [tests/timeline-columns.spec.ts](../tests/timeline-columns.spec.ts)
- **Actors**: the seed administrator (the tests) and its API context (the seeding).
- **Owns** (exclusive server-side state): its throwaway person, team, work stream, program, project and one milestone of the team scheduled 2027-06-07..11, all unique `e2e-tc-*`, seeded through the API in the beforeAll and removed in the afterAll, children first. No figure is pinned (no holiday, capacity or ranking figure is read), so no far-off year and no lock; the global ranking is never touched (the project stays unranked), and the Roadmap pages are narrowed to the world's program and read by their headers only. The choices are browser state (`astrolabe.viewSettings.timeline.columns.<page>`), not server state: every test has a fresh browser context and `login` clears its storage, so no test inherits another's.

## Scenario: the project page hides its extra columns, brings one back from the menu and remembers the choice

1. The administrator opens the project page.
   - *Expected*: the Milestone timeline's headers are Milestone, Team, Estimate, Operations; "Hide columns" is expanded.
2. They measure the Team and Estimate headers, the Operations header's right edge, the bar's left edge and the scroll position, and press "Hide columns".
   - *Expected*: only Milestone and Operations remain; the button reads "Show columns" and is collapsed; the scroll position is unchanged; the Operations header's right edge and the bar's left edge have both moved left by the measured width of the two hidden headers.
3. They open "Choose columns".
   - *Expected*: the menu offers Team and Estimate, both unticked (it shows what is drawn).
4. They tick Team.
   - *Expected*: the menu stays open with Team ticked; the "Choose columns" chevron reads "1 hidden" and is named "Choose columns · 1 hidden" (Estimate is not drawn; with both hidden it read "2 hidden"); the Team header is back and Estimate is not; the headers are Milestone, Team, Operations; the toggle reads "Hide columns" again. Escape closes the menu.
5. They reload the page.
   - *Expected*: the headers are still Milestone, Team, Operations.
6. They press "Hide columns", then "Show columns".
   - *Expected*: first only Milestone and Operations, then Milestone, Team, Operations: the pick survived the collapse.

## Scenario: the keyboard steps over the hidden columns

1. The administrator opens the project page and presses "Hide columns".
   - *Expected*: the headers are Milestone and Operations.
2. They focus the milestone's row header and press ArrowRight.
   - *Expected*: focus is on the row's "Operations for <milestone>" button (no dead stop where Team and Estimate were).
3. They press ArrowRight again.
   - *Expected*: focus is on the milestone's bar.
4. They press ArrowLeft.
   - *Expected*: focus is back on the Operations button.

## Scenario: the team page and the Roadmap's two modes each keep their own choice

1. The administrator opens the team page, the Roadmap in Prioritization mode and in overview mode (both narrowed to the world's program), one after another, and presses "Hide columns" on each.
   - *Expected*: each starts with everything shown (team page: Milestone, Project, Estimate, Operations; Prioritization: #, Project, Flags, Operations; overview: Work stream, program, project, Flags, Operations), and after the press only the page's fixed columns stay: Milestone and Operations; #, Project and Operations (the rank and the project name are never hidden); the name and Operations. The pages opened later are unaffected by the earlier presses.
2. They open the project page.
   - *Expected*: all four headers are shown (its own key was never written).
3. They open the three hidden pages again.
   - *Expected*: each still has its own choice (the team page's toggle reads "Show columns").

## Scenario: Scroll to today brings today back into view

1. The administrator opens the project page (today's date is months before the milestone) and scrolls the timeline to its far end.
   - *Expected*: the scroll position is positive and the today line lies left of the visible track (behind the sticky left columns).
2. They press "Scroll to today".
   - *Expected*: the today line lies within the visible track, between the Operations header's right edge and the scroller's right edge.

## Scenario: the columns menu and a collapsed timeline pass axe in light and dark

1. On the project page, in the light scheme, the administrator opens "Choose columns" and an axe scan (WCAG A/AA) runs; they close the menu with Escape, press "Hide columns" and scan again; they press "Show columns".
   - *Expected*: no violation in either scan.
2. The same in the dark scheme (`emulateMedia`, the page's `auto` scheme follows it; the scheme is asserted on the page first).
   - *Expected*: no violation in either scan.
