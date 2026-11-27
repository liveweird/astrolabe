# Cross-team schedule proposal (the project page, in 2049)

- **Spec**: [tests/project-proposal.spec.ts](../tests/project-proposal.spec.ts)
- **Actors**: two throwaway logins seeded through the API — a project OWNER (a person who owns the project and manages no team) and the SINGLE manager of team Y; the seed
  administrator acts only through the API (seeding, and reading the stored milestones back).
- **Owns** (exclusive server-side state): its throwaway users, people, TWO teams each with ONE capacity period (from Monday 2049-01-04, 10 man-days a week, no WIP limit; team X's
  manager is a person with no login), work stream, program, project, two milestones and the link between them (unique `e2e-pp-*` names), all seeded through the API and removed by the
  afterEach through the API, the project first (its milestones and link go with it), then program, work stream, teams, people and users. Each test seeds its own world, so tests never
  share a mutable row. Every date is in **2049**, a year no spec writes a holiday in (`public-holidays` owns 2040, `critical-path` 2041, `schedule-proposal` 2042, `baselines` 2043,
  `jira-sync` 2044, `jira-import` 2045, `jira-coverage` 2046, `flow-sync` and `flow-capacity-deviation` 2047, `roadmap-proposal` 2048): the real clock is the run's `asOf`, each team's
  first capacity period starts on Monday 2049-01-04, and a proposal cannot place anything before the first day with capacity, so the dates do not depend on today. A cross-team
  proposal's scope token carries the global holiday dictionary, which `public-holidays.spec.ts` writes (2040): the file takes the Playwright lock `holiday-dictionary` with
  `public-holidays`, `schedule-proposal` and `roadmap-proposal` and never runs at the same time as they do.

**The world.** Team X and team Y (names `e2e-pp-teamx-*`, `e2e-pp-teamy-*`), each from Monday 2049-01-04 at 10 man-days a week, i.e. 2 man-days a working day. Milestones: `x1` 4 MD on team X
scheduled Tuesday 2049-03-02 to Wednesday 2049-03-03; `y1` 2 MD on team Y unscheduled; a finish-to-start link `x1 -> y1`. The run, counted by hand on the Monday-to-Friday calendar (no holiday):
team X is placed first, `x1` takes two working days from the first day with capacity, **2049-01-04 to 2049-01-05**; team Y is placed with X's PROPOSED dates as facts, so `y1` takes one day,
**2049-01-06 to 2049-01-06**; one pass, settled. The project's span (`x1` alone) is 2049-03-02 to 2049-03-03 now and 2049-01-04 to 2049-01-06 after the run: its end moves from Wednesday 03-03 to
Wednesday 01-06, exactly eight weeks, 40 working days earlier.

## Scenario: a login that manages no team previews a project proposal: the dashed bars, the new row, the sentence about the project's end, and nothing to accept

1. The project OWNER signs in and opens the project's page.
   - *Expected*: the timeline is shown, no dashed bar is drawn, and **Propose schedule** is enabled once the viewer's rights are read (everyone previews).
2. They press **Propose schedule**.
   - *Expected*: a run over the project's two teams opens after the Unscheduled tray (the heading "Schedule proposal"); a note says "This is a preview."; there is no **Accept selected**, no **Save**; **Propose again**
     and **Discard** are offered.
3. They read the timeline.
   - *Expected*: three dashed read-only bars: `x1`'s row (2049-01-04 to 2049-01-05), the appended row of `y1` marked "(new)" (2049-01-06 to 2049-01-06) and the project's summary row
     (2049-01-04 to 2049-01-06).
4. They read the section.
   - *Expected*: "If every team's moves are accepted, the project would end on 2049-01-06 instead of 2049-03-03, 40 working days earlier."; team Y's section opens with a click and lists `y1` as "Unscheduled → 2049-01-06 to
     2049-01-06, 1 working day", its checkbox disabled.
5. They press **Discard**.
   - *Expected*: the section and every dashed bar are gone; nothing was written.

## Scenario: the manager of one of the project's two teams accepts only their move: the check describes that tick, the date writes are locked meanwhile, and the other team's milestone stays

1. The SINGLE manager (team Y's) signs in, opens the project's page and presses **Propose schedule**.
   - *Expected*: the run opens with the same sentence about the project's end; **Accept selected (1)**: `y1` is ticked, team X's section is collapsed and read-only.
2. They read team Y's section.
   - *Expected*: the check answers for exactly the ticked move: `x1` stays in March, so `y1`'s row shows the red "Conflict" ("must start on 2049-03-04 or later") - a warning, not a refusal.
3. They look at the tray.
   - *Expected*: `y1`'s **Schedule** button is disabled while the proposal is open.
4. They press **Accept selected (1)**.
   - *Expected*: one request naming both run teams and team Y alone as the accepted one, with one item (`y1`); the answer holds one accepted and no skipped milestone; the note "1 scheduled" is shown and
     the section and the dashed bars are gone; the API shows `y1` on 2049-01-06 and `x1` still on 2049-03-02 to 2049-03-03.

## Scenario: the open preview has no WCAG A/AA violations

1. The OWNER signs in, opens the project's page and presses **Propose schedule**.
   - *Expected*: the preview is open with its three dashed bars.
2. An axe scan (WCAG 2.0/2.1 A and AA, the light scheme) runs over the page.
   - *Expected*: no violation.
