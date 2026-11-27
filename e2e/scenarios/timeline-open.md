# Where the Gantts open (1.37)

- **Spec**: [tests/timeline-open.spec.ts](../tests/timeline-open.spec.ts)
- **Actors**: the seed administrator (the tests) and its API context (the seeding).
- **Owns** (exclusive server-side state): its throwaway person, team, work stream, program and two projects, all unique `e2e-to-*`, seeded through the API in the beforeAll and removed in the afterAll, children first. The project "far" has one milestone of the team scheduled Monday to Friday about 14 months after the day the suite runs; the project "near" has one scheduled the week after it. The dates are relative to the run's day (no calendar year is pinned) and no holiday, capacity or ranking figure is read; the global ranking is never touched (both projects stay unranked), and the Roadmap pages are narrowed to the world's program. The Gantts' browser state (`astrolabe.viewSettings.timeline.*`) is cleared by `login`, so every test opens each Gantt for the first time.

## Scenario: the project page opens at its first bar when its work starts months after today

1. The administrator opens the page of the project whose only milestone lies about 14 months ahead.
   - *Expected*: the timeline is scrolled sideways (its scroll position is positive), the milestone's bar lies wholly inside the visible track, a small lead (under 120 px) from the sticky columns, and today's line lies left of the visible track: the first screen is not an empty grid around today.

## Scenario: the project page and the team page open with today a quarter of the way in when their work is around today

1. The administrator opens the page of the project whose milestone starts next week.
   - *Expected*: today's line is between 20 % and 30 % of the visible track from its left edge, and the header's "Today" pill lies wholly inside the visible track.
2. They open the team page (its milestones are both projects', one of them next week).
   - *Expected*: the same: today's line a quarter of the way into the visible track and the "Today" pill whole.

## Scenario: the Roadmap, in both modes, opens with the Today pill whole

1. The administrator opens the Roadmap in Prioritization mode, narrowed to the world's program.
   - *Expected*: the "Today" pill lies wholly inside the visible track (not cut at its right edge) and today's line is in the first half of it, not at the far right edge.
2. They open the Roadmap's overview mode, narrowed to the same program.
   - *Expected*: the same.

## Scenario: Scroll to today still centres today after the grid has opened

1. The administrator opens the page of the project whose milestone starts next week and presses "Scroll to today".
   - *Expected*: today's line is at the middle of the visible track (within 5 %), and the scroll position is not what it was when the page opened.
