# Every entity name is a link (1.31)

- **Spec**: [tests/entity-links.spec.ts](../tests/entity-links.spec.ts)
- **Actors**: the seed administrator (every test but the user's), one throwaway regular user (a login with no person), and in the user test two throwaway administrators (`apiAsThrowawayAdmin`) that take a baseline each; the seed administrator acts through the API for seeding.
- **Owns** (exclusive server-side state): its throwaway people (a lead, a project owner, a team manager), team, two work streams (one is the decoy the narrowing must leave out) with a program each, three projects (two in the program under test, one decoy) and two milestones scheduled 2027-05-03..07 and 2027-05-10..14 with a finish-to-start link between them (so no figure depends on a holiday: no far-off year, no lock), all unique `e2e-el-*`, seeded through the API in the beforeAll and removed in the afterAll, children first; in the user test also its person (linked to one of the two administrators) and two baselines, removed in that test's finally. The tests only navigate: nothing is written by a click, and the global ranking is never touched (the projects stay unranked).

## Scenario: from the Plan tree a work stream or program name opens the Roadmap overview narrowed to it, a project name its page and an owner name their page

1. The administrator opens the Plan page and presses the work stream's name link ("Open work stream <name>").
   - *Expected*: the address is `/roadmap?mode=overview&workStreamId=<id>`; the page says "Work stream: <name>", shows the stream's program and its project, and none of the decoy stream's program.
2. Back on the Plan, they press the program's name link.
   - *Expected*: the address is `/roadmap?mode=overview&programId=<id>`; the program is in the overview and the decoy stream's program is not.
3. Back on the Plan, they press the project's name link.
   - *Expected*: the project's page, its heading the project name.
4. Back on the Plan, they press the project row's owner link ("Open person <name>").
   - *Expected*: `/people/<id>`, its heading the person's name.

## Scenario: on the project page a milestone of another project opens that project with its row marked, and the team, program, work stream and owner names go where they say

1. The administrator opens the project that has a link from another project's milestone and presses that milestone's name in the Dependencies table ("Open milestone <name>").
   - *Expected*: the other project's page; the milestone's timeline row header is marked (`aria-current`) and focused, and the address is the project's own (`?milestone=` was dropped).
2. They reopen the first project and press the team name in the timeline's Team column.
   - *Expected*: `/teams/<id>`, its heading the team name.
3. They reopen it and press the header's program name, then (reopened) the work stream name.
   - *Expected*: the overview narrowed by `programId`, then by `workStreamId` ("Work stream: <name>").
4. They reopen it and press the owner's name in the header.
   - *Expected*: the person's page.

## Scenario: on the team page a milestone name opens its project with the row marked and the manager name opens their page

1. The administrator opens the team's page and presses a milestone's name in the timeline.
   - *Expected*: the milestone's project, the row header marked and focused, the address without `?milestone=`.
2. They reopen the team page and press the manager's name.
   - *Expected*: the person's page, its heading the manager's name.

## Scenario: a regular user follows the names to the plan, the project and the team, and a baseline author is a link to their person only when the login has one

1. Two throwaway administrators take a baseline each through the API; one of them is linked to a person (so its author is that person's name and `personId` is set), the other to none.
2. The regular user signs in and opens the Plan page, the project page and the team page.
   - *Expected*: the work stream, project, program, team, milestone and manager names are links ("Open ...").
3. They open Baselines.
   - *Expected*: the unlinked author's login name is plain text (no "Open person" or "Open user" link in its row, none anywhere on the page); the linked author's row has "Open person <name>", which leads to `/people/<id>` with the person's name as heading.

## Scenario: on the Roadmap a project row menu offers Open program, and Enter on it opens that program in the overview

1. The administrator opens the Roadmap in Prioritization mode with the program in the address, focuses the project row's "Operations for <project>" button and presses Enter.
   - *Expected*: the menu opens.
2. They press ArrowDown until "Open program <name>" is focused, then Enter.
   - *Expected*: the address is `/roadmap?mode=overview&programId=<id>`; the program is in the overview, the decoy stream's program is not.
