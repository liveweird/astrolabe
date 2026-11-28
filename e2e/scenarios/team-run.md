# Cross-team schedule proposal planned from the team page (the picker beside Propose, in 2050)

- **Spec**: [tests/team-run.spec.ts](../tests/team-run.spec.ts)
- **Actors**: ONE throwaway login seeded through the API that manages BOTH teams (through one person); the seed administrator acts only through the API (seeding, and reading the stored
  milestones back).
- **Owns** (exclusive server-side state): its throwaway user, people, TWO teams each with ONE capacity period (from Monday 2050-01-03, 10 man-days a week, no WIP limit), work stream, program,
  project, two milestones and the link between them (unique `e2e-tr-*` names), all seeded through the API and removed by the afterEach through the API, the project first (its milestones and
  link go with it), then program, work stream, teams, people and the user. Each test seeds its own world, so tests never share a mutable row. Every date is in **2050**, a year no spec
  writes a holiday in (`public-holidays` owns 2040 and the other proposal specs 2042, 2048 and 2049): the real clock is the run's `asOf`, each team's first capacity period starts on Monday
  2050-01-03, and a proposal cannot place anything before the first day with capacity, so the dates do not depend on today. A cross-team proposal's scope token carries the global holiday
  dictionary, which `public-holidays.spec.ts` writes (2040): the file takes the Playwright lock `holiday-dictionary` with `public-holidays`, `schedule-proposal`, `roadmap-proposal` and
  `project-proposal` and never runs at the same time as they do.

**The world.** Team A and team B (names `e2e-tr-teama-*`, `e2e-tr-teamb-*`), each from Monday 2050-01-03 at 10 man-days a week, i.e. 2 man-days a working day. Milestones: `a1` 4 MD on team A
scheduled Tuesday 2050-03-01 to Wednesday 2050-03-02; `b1` 2 MD on team B scheduled Thursday 2050-03-03 to Friday 2050-03-04; a finish-to-start link `a1 -> b1`, so team A's page names team B's
milestone. The run, counted by hand on the Monday-to-Friday calendar (no holiday): team A is placed first, `a1` takes two working days from the first day with capacity, **2050-01-03 to
2050-01-04**; team B is placed with A's PROPOSED dates as facts, so `b1` takes one day, the working day after, **2050-01-05 to 2050-01-05**; one pass, settled.

## Scenario: the manager of two teams plans together from one team's page: the linked team's milestone is a dimmed row with its dashed bar, and one accept schedules both teams

1. The manager signs in and opens team A's page.
   - *Expected*: beside **Propose schedule** there is the "Plan together with" picker and **Add linked teams**; no dashed bar is drawn and team B's milestone has no row.
2. They press **Add linked teams**, then **Propose schedule**.
   - *Expected*: one run over both teams is requested; the section "Schedule proposal" opens after the timeline (its heading focused and below the 56 px header) with a section per team; the picker
     is gone and Propose is disabled while the run is open.
3. They read the timeline.
   - *Expected*: two dashed read-only bars: `a1`'s (2050-01-03 to 2050-01-04, beside its current bar) and `b1`'s (2050-01-05 to 2050-01-05); team B's `b1` is a dimmed row right after `a1`'s with a
     ghost bar at its current dates (2050-03-03 to 2050-03-04, "linked to this team's work") and a link to team B.
4. They untick `b1`, then tick it again.
   - *Expected*: unticked, its dashed bar is gone (one is left) while its row stays; ticked again, both dashed bars are back and the button reads **Accept selected (2)**.
5. They press **Accept selected (2)**.
   - *Expected*: one request naming both teams as the run's teams and as the accepted ones, with the items of `a1` and `b1`; the answer holds two accepted milestones; the note "2 scheduled" is shown,
     the section, the dashed bars and `b1`'s dimmed row are gone, the mounted page shows `a1` at 2050-01-03 to 2050-01-04 and the picker is back; the API shows `a1` on 2050-01-03 to 2050-01-04 and
     `b1` on 2050-01-05.

## Scenario: left empty, the picker proposes for the team alone, as Propose always did

1. The manager signs in, opens team A's page and presses **Propose schedule** with nothing chosen.
   - *Expected*: the per-team request succeeds and the section "Proposed schedule" opens; there is no "Schedule proposal" section; one dashed bar is drawn (`a1`'s) and team B's milestone has no row.

## Scenario: the picker row wraps at 390 px: the picker, Add linked teams and Propose stay inside the window

1. The manager opens team A's page and presses **Add linked teams**.
   - *Expected*: team B is in the picker.
2. The window shrinks to 390 px wide.
   - *Expected*: **Propose schedule**, the picker and **Add linked teams** are each visible and inside the window; the page does not scroll sideways.

## Scenario: the open run on the team page has no WCAG A/AA violations

1. The manager signs in, opens team A's page, presses **Add linked teams** and **Propose schedule**.
   - *Expected*: the run is open with its two dashed bars.
2. An axe scan (WCAG 2.0/2.1 A and AA, the light scheme) runs over the page.
   - *Expected*: no violation.

## Scenario: the open run on the team page has no WCAG A/AA violations in the dark scheme

1. The same, with the browser in the dark scheme.
   - *Expected*: the page renders in the dark scheme and the run is open with its two dashed bars.
2. An axe scan runs over the page.
   - *Expected*: no violation.
