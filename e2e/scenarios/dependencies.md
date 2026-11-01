# Dependencies (links between milestones and projects on the project view)

- **Spec**: [tests/dependencies.spec.ts](../tests/dependencies.spec.ts)
- **Actors**: two throwaway logins seeded through the API - a project OWNER (the person who owns the program, so both projects) and a
  team MANAGER (the manager of the milestones' team, owning nothing); the seed administrator acts only through the API (seeding, the
  milestones' dates, and the link the second scenario starts from)
- **Owns** (exclusive server-side state): its throwaway users, people, team, work stream, program, two projects A and B and their
  milestones a1 (A, scheduled 2027-02-01 to 2027-02-05) and b1 (B, scheduled 2027-02-08 to 2027-02-12) and the links between them (unique
  `e2e-dep-*` names), all seeded through the API and removed by the afterEach through the API, the projects first (their milestones
  and links go with them), then program, work stream, team, people and users. b1 starts the working day after a1 ends, so a
  finish-to-start link a1 -> b1 with no lag holds. The plan revision is shared with every other spec's plan writes: nothing here
  asserts a revision.

## Scenario: a project owner links a milestone to a milestone of another project, sees the ghost row and the arrow, and a cycle is refused

1. The project owner signs in and opens project B.
   - *Expected*: the Dependencies section says "No dependencies yet"; the timeline has no arrow.
2. They press **Add dependency**, choose b1 as the Successor, leave the predecessor kind on Milestone, search a1 by name in the
   Predecessor picker and pick "a1 · A" (the option names the milestone's project), keep **Finish → Start (FS)** and the lag of 0, and
   press **Save**.
   - *Expected*: the POST answers 201 and the dialog closes; the Dependencies table has a row for a1 (the predecessor, with its
     project) that reads **OK**; the timeline has a dimmed ghost row "A › a1" whose link (named "A › a1 - open project A") leads to `/projects/<A>`; there is
     exactly one arrow and it is not violated; the facts line shows no conflicts.
3. They open project A, press **Add dependency**, choose a1 as the Successor, search b1 and pick "b1 · B", and **Save**.
   - *Expected*: the POST answers 409; the dialog stays open and its alert says "This link would close a cycle through:" and names a1
     and b1; they Cancel and the table still has exactly the one link.

## Scenario: the team's manager moves the successor before its predecessor and reads the conflict; the owner deletes the link

1. The administrator links a1 -> b1 (finish-to-start, no lag) through the API. The team's manager (not an owner of anything) signs in
   and opens project B.
   - *Expected*: the one arrow is not violated.
2. From b1's row menu they choose **Edit schedule of b1**, enter 2027-01-25 to 2027-01-29 and **Save**.
   - *Expected*: after the view refreshes, the arrow is violated (red); the facts line shows "1 conflict"; the table row reads
     "Violated · 10 working days short" and "needs 2027-02-08 · is 2027-01-25"; the b1 bar's accessible name ends with "1 conflict";
     the manager's row has no operations menu (only the successor's project chain deletes).
3. The project owner signs in, opens project B (still showing the conflict), and chooses **Delete** from the link's row menu and
   confirms.
   - *Expected*: the DELETE answers 204; the table says "No dependencies yet"; no arrow, no ghost row (the link to A's project is
     gone) and no conflicts in the facts line.

## Not covered here (and why)

- **The pointer and keyboard gestures of the timeline** (drag, resize, the keyboard sensor) - unchanged, owned by
  [project-view.md](project-view.md); the arrows follow the committed dates, so nothing here drags.
- **A project owner who owns only the predecessor's project** (403 on create and delete) and the other server rights - the server
  suite pins the matrix (`DependencyTest`); the UI only reads the view's `can` flags.
- **The other three dependency types, a lag, a project as an endpoint** - covered by the unit and page tests (`dependencyForm`,
  `projectDependencies`, `ProjectView`) and the server's check kernel.
