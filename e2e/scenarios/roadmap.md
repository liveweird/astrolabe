# Roadmap (the global project ranking, on a timeline)

- **Spec**: [tests/roadmap.spec.ts](../tests/roadmap.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); in each test one throwaway user (the roadmap editor in the first,
  a plain user in the second)
- **Owns** (exclusive server-side state): its throwaway people, work streams, programs and projects (unique `e2e-rm-*` names)
  and users, all deleted by the end of the file (the plan nodes and people also by the afterEach, through the API, children first,
  when a step fails first; deleting a project also removes it from the ranking). The ranking itself is ONE global list shared with
  every other spec's plan writes: this file ranks only its own projects, asserts only the relative order of its own rows, and
  retries a ranking change that the server refuses as stale (another spec wrote the ranking meanwhile; plan writes elsewhere no longer stale it).
  The page lists EVERY project, so each test sets the **program pick** (the browser setting
  `astrolabe.viewSettings.planning.programPick`, the one key the plan pages share) to its own program before opening the page: only its own rows
  (and the "Unranked" divider) are on screen, whatever other specs or a loaded sample plan hold, and the grid stays on its plain (non-virtual) path.

## Scenario: an admin grants the roadmap editor right; the editor ranks two projects from the row menu, moves and drags them, unranks by drag, and meets the stale notice

1. The admin signs in, creates a throwaway user through the Users page and seeds, through the API, a person, a work stream, a
   program and two projects ("first" and "second", each with a target window 2026-02-02 to 2026-03-31). They open Users, filter to the throwaway
   user, choose **Permissions for <user>** from the row menu, switch **Roadmap editor** on and Save. They sign out.
   - *Expected*: the Permissions page opens with the switch off; Save returns to the Users list.
2. The throwaway user signs in, the program pick is set to the seeded program, and they open **Roadmap** from the Planning section of the sidebar.
   - *Expected*: the page heading is "Roadmap" with a "Timeline" section; the rows are the "Unranked" divider, then first and second;
     each row carries its target window as a read-only band (an image named "<name>, target window 2026-02-02 to 2026-03-31, read-only").
3. They choose **Rank <first>** from first's row menu, then **Rank <second>** from second's.
   - *Expected*: after the first the rows are first, the divider, second (Rank appends at the end of the ranking); after the second, first then
     second and no divider (nothing is unranked any more).
4. They focus **Operations for <second>**, press Enter (the menu opens), focus **Move up <second>** and press Enter.
   - *Expected*: the rows are second, first; keyboard focus is back on **Operations for <second>**; the screen-reader status says
     "<second> moved to position …".
5. They drag <first> by its row handle with the pointer onto the upper half of second's row.
   - *Expected*: the rows are first, second (a ranking change saved by the row drag).
6. They choose **Unrank <second>** from its row menu.
   - *Expected*: the rows are first, the divider, second.
7. They drag <first> by its handle onto the lower half of second's row, which is below the divider.
   - *Expected*: first is unranked: the rows are the divider, first, second (unranked rows are by name); the status says "<first> removed from the ranking".
8. They choose **Rank <second>** from its menu.
   - *Expected*: the rows are second, the divider, first.
9. The ranking changes under the open page: the admin's API rewrites the ranking (same list, so the ranking's revision moves). The user
   chooses **Rank <first>**.
   - *Expected*: the server answers 409; the page says "The roadmap changed in the meantime", reloads, and first is still under the divider.
10. They choose **Rank <first>** again.
    - *Expected*: the change goes through; the rows are second, first.
11. The user signs out; the admin signs back in and deletes the user (the plan nodes and people are removed through the API).

## Scenario: a user without the roadmap right reads the ranked rows with no handle and no ranking item in the menu

1. The admin creates a throwaway user through the Users page and seeds, through the API, a person, a work stream, a program and three
   projects; two of them are ranked through the API (first, second), the third is not. They sign out.
2. The user signs in, the program pick is set to the seeded program, and they open **Roadmap** from the sidebar.
   - *Expected*: the rows are first, second, the "Unranked" divider, third; first carries its target window as a read-only band; the page says
     everyone can read the ranking.
   - *Expected*: there is no row handle anywhere, and no bar of the page is a button that could be picked up.
3. They open **Operations for <first>**, then **Operations for <third>**.
   - *Expected*: each menu offers **Open project <name>** and no Move, Rank or Unrank item.
4. The user signs out; the admin signs back in and deletes the user.

## Not covered here (and why)

- **The optimistic rollback on a non-409 failure, the 400 and 403 sentences, the refusal of a change made while a save runs, the filters
  (work stream, team, owner, flagged only) and the program pick's effect, the flag panel's sentences and "Show in timeline", the rolled-up arrows,
  Rank by dropping an unranked row above the divider, the exact PUT bodies, the empty states** - pinned by `Roadmap.test.tsx`,
  `roadmapRows.test.ts`, `roadmapOrder.test.ts` and the server's `RoadmapViewTest` and `RoadmapRankingTest`; this journey drives the real browser paths
  (focus after a menu move, the pointer drag by the handle, the stale notice).
- **The keyboard drag** - a row has none: the row menu IS the keyboard path (`timeline.md` "Row drag"), driven in step 4. dnd-kit's drag
  announcements are covered by `Timeline.test.tsx`.
- **Editing the target window** - the bands are read-only on this page until the window gestures land (a later commit of v0.6).
- **Flags with real data** - the flag icons and panel are scanned with a drifting fixture project and a violated link by `accessibility.spec.ts`.
