# Roadmap (the global project ranking, on a timeline)

- **Spec**: [tests/roadmap.spec.ts](../tests/roadmap.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); in each test one throwaway user (the roadmap editor in the first,
  a plain user in the second; the third has two, an editor who owns nothing and the projects' own owner)
- **Owns** (exclusive server-side state): its throwaway people, work streams, programs, projects, one team with two scheduled milestones
  (the third scenario; they leave with their projects) (unique `e2e-rm-*` names) and users, all deleted by the end of the file (the plan nodes and people also by the afterEach, through the API, children first,
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
     each row carries its target window as a band the editor may move (a draggable named "<name>, target window 2026-02-02 to 2026-03-31",
     no "read-only": the editor holds the right to change any project's window; the gestures are the third scenario).
3. They choose **Rank <first>** from first's row menu, then **Rank <second>** from second's.
   - *Expected*: after the first the rows are first, the divider, second (Rank appends at the end of the ranking); after the second, first then
     second and no divider (nothing is unranked any more).
4. They focus **Operations for <second>** and press Enter (the menu opens with the focus on its first item, **Move up <second>**), press ArrowDown and ArrowUp (the focus goes to **Move to top: <second>** and back) and press Enter.
   - *Expected*: the rows are second, first; keyboard focus is back on **Operations for <second>**; the screen-reader status says
     "<second> moved to position …".
   - They press Enter on the same button, Escape and at once Enter again, then Escape.
   - *Expected*: both openings put the focus on **Move down <second>** (the top row's Move up is disabled); the last Escape closes the menu and the focus is on the button.
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

## Scenario: a roadmap editor who owns nothing drags the band, draws a window, sets one from the keyboard dialog and clears it; the project's own owner reads the band read-only

1. The admin seeds, through the API: two users (an **editor**, granted ROADMAP_EDITOR and linked to no person, and an **owner**, linked to a
   person), a login-less lead person owning the work stream and program, a team and two projects owned by the owner's person: **moved** (target
   window 2026-02-02 to 2026-03-31, one milestone 2026-02-09 to 2026-03-27, so its span lies inside the window) and **bare** (no window, one
   milestone 2026-04-06 to 2026-04-24).
2. The editor signs in, sets the program pick to the seeded program and opens **Roadmap**.
   - *Expected*: moved's window is a draggable band (a button named "<moved>, target window 2026-02-02 to 2026-03-31"); moved's row has no draw
     surface, bare's row has one (the editor may set a window where there is none).
3. They press the middle of moved's span bar (the hollow bar over the band) and drag it 42 px to the left (14 days at Quarter zoom).
   - *Expected*: the page PUTs `/projects/{id}/target-window` (204) with 2026-01-19 to 2026-03-17 - the pointer went through the span to the
     window - and the band is named "…2026-01-19 to 2026-03-17"; after the refetch the row carries one warning and one info icon (the window now
     ends before the span: the server's drift flags) and the open flag panel says "Ends 10 days after the target".
4. They press the middle of bare's span bar and drag 30 px to the right.
   - *Expected*: the PUT carries a window ten days long that starts on a day of the span; bare's row has the band and no draw surface any more.
5. From the keyboard they open **Operations for <moved>**, move to **Edit target window of <moved>** and press Enter.
   - *Expected*: the dialog "Target window of <moved>" opens prefilled with 2026-01-19; they type 2026-02-02 and 2026-03-31 and press Save: the
     PUT carries that window, the dialog closes, the band follows, the focus is back on **Operations for <moved>** and the screen-reader status
     says "<moved>: target window 2026-02-02 to 2026-03-31".
6. From the keyboard they choose **Clear target window of <moved>** from the same menu.
   - *Expected*: the PUT carries both dates null, moved's row has no band and has the draw surface again, and the focus stays on the menu button.
7. The editor signs out; the owner (no grant, owner of both projects, owner of nothing above them) signs in, sets the pick and opens Roadmap.
   - *Expected*: bare's band is a read-only image (named "…, read-only"), not a button; there is no draw surface anywhere; the row menu offers
     **Open project** and no target-window item (the project's own owner may not change its window, `authorization.md`).
8. The throwaway users, people, team and plan nodes are removed through the API.

## Not covered here (and why)

- **The optimistic rollback on a non-409 failure, the 400 and 403 sentences, the refusal of a change made while a save runs, the filters
  (work stream, team, owner, flagged only) and the program pick's effect, the flag panel's sentences and "Show in timeline", the rolled-up arrows,
  Rank by dropping an unranked row above the divider, the exact PUT bodies, the empty states** - pinned by `Roadmap.test.tsx`,
  `roadmapRows.test.ts`, `roadmapOrder.test.ts` and the server's `RoadmapViewTest` and `RoadmapRankingTest`; this journey drives the real browser paths
  (focus after a menu move, the pointer drag by the handle, the stale notice).
- **The keyboard drag** - a row has none: the row menu IS the keyboard path (`timeline.md` "Row drag"), driven in step 4. dnd-kit's drag
  announcements are covered by `Timeline.test.tsx`.
- **Resizing the band by its handle, the refusal of a window change while a rank save runs (and the other way round), the 403/404/400 sentences,
  the rollback, the dialog's validation and its Clear button, the Programs page's copy of every gesture** - pinned by `Roadmap.window.test.tsx`,
  `Programs.window.test.tsx` and `targetWindowUpdate.test.ts`; the draw and the move run here against the real layout (the pointer going
  through the span bar is the part a unit test cannot show), the real handle resize is the project view's scenario.
- **Flags with real data** - the flag icons and panel are scanned with a drifting fixture project and a violated link by `accessibility.spec.ts`.
