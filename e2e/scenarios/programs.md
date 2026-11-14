# Programs (the plan as a tree on a timeline)

- **Spec**: [tests/programs.spec.ts](../tests/programs.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the first two tests; in the third one a throwaway user with no right (the
  admin creates it through the Users page and deletes it at the end)
- **Owns** (exclusive server-side state): its throwaway person, team, work stream, two programs (A and B), three projects and their
  milestones, one project-to-project link, and the throwaway user (unique `e2e-pg-*` names), all seeded through the API and removed by the
  afterEach through the API, children first (the projects take their milestones and the link with them; the user is removed through the
  Users page). Program A holds `late` (target window 2026-03-02 to 2026-03-31, milestones 2026-03-02 to 03-06 and 04-06 to 04-10, so its span
  ends ten days after the target: one WARNING) and `early` (no window, one milestone 2026-02-02 to 02-06); program B holds `other` (target
  window and milestone both 2026-05-04 to 05-08: nothing flagged). `late` is linked to `other` by a finish-to-start project link that holds.
  The projects stay unranked, so the global ranking is never written. Every test sets the **program pick** (the browser setting
  `astrolabe.viewSettings.planning.programPick`, the one key the plan pages share) to its own programs: the compose stack may hold the loaded
  sample plan (100 projects, an unfolded grid over 80 rows virtualises), so only this spec's rows are on screen.

## Scenario: an admin reads the plan as a tree, folds programs from the keyboard, sees spans, roll-up counts and an arrow, and switches to Year zoom

1. The admin signs in, the program pick is set to programs A and B, and they open **Programs** from the Planning section of the sidebar.
   - *Expected*: the heading is "Programs"; the work stream's chevron button ("Work stream <name>") is expanded, the buttons "Program A" and
     "Program B" are collapsed and no project row is shown; the facts line reads "1 work stream", "2 programs", "3 projects" and "1 warning".
   - *Expected* (1.16): with both programs folded the project link is ONE rolled-up arrow (`data-arrow` starting `rollup:`) between the two program
     rows, not violated (`data-violated="false"`), titled "<A> → <B>, 1 link (0 violated)" (the only arrow on the page).
2. They read the summary bars and counts of the nodes.
   - *Expected*: A's bar is named "<A>, program span 2026-02-02 to 2026-04-10, read-only" (the span its two projects cover), B's
     "… 2026-05-04 to 2026-05-08", the work stream's "… work stream span 2026-02-02 to 2026-05-08"; the work stream's and A's Flags cell carry
     one warning and no info (`data-flags="1,0"`), B's carries none.
3. They press the chevron button of program A with the pointer.
   - *Expected*: A is expanded; the status region says "<A> expanded, 2 projects"; `late` has its span bar (2026-03-02 to 2026-04-10), its
     target window bar (2026-03-02 to 2026-03-31; the administrator may change it, so it is a draggable named without "read-only") and the orange drift band ("10 days past the target end") and one warning in its Flags cell;
     `early` has its span bar (2026-02-02 to 2026-02-06) and no flag. With A open and B folded the arrow now starts at `late`'s row and ends at
     B's row: still one arrow, titled "<late> → <B>, 1 link (0 violated)".
4. They focus A's chevron button and press Enter.
   - *Expected*: A is collapsed and its button still has the focus; the status says "<A> collapsed"; the project rows are gone; the one arrow
     between the two program rows is back ("<A> → <B>, 1 link (0 violated)").
5. They press Enter again (A opens), focus B's button and press Enter (B opens).
   - *Expected*: `other` is shown; exactly one arrow is drawn (`late` to `other`, the project link), not violated, and none of the page's arrows
     is a roll-up. Pressing Enter on B's button once more folds B and the arrow ends on B's row again ("<late> → <B>, 1 link (0 violated)").
6. They press **Collapse all**, then **Expand all**.
   - *Expected*: after Collapse all the work stream itself is collapsed and no program is shown; both projects stand on the work stream's row,
     so the link is inside one row and no arrow is drawn; after Expand all every project row is shown and the project arrow is back (not a roll-up).
7. The timeline is on Quarter zoom; they switch to **Year**.
   - *Expected*: at Quarter no header cell reads exactly "2026"; at Year the header shows the year.

## Scenario: the program pick set on the Programs page narrows the Roadmap after a reload, and the pick set on the Roadmap narrows the Programs page

1. The admin signs in (no pick stored) and opens **Programs**. They open the filter panel and pick program A in the **Programs** multi-select.
   - *Expected*: exactly one work stream row remains, with the button "Program A" and no "Program B".
2. They open **Roadmap** from the sidebar and reload the page.
   - *Expected*: the roadmap's grid holds exactly two project rows, `late` and `early` (A's projects, unranked): the pick is the one shared key.
3. On the Roadmap they open the filters, clear the program pick and pick program B.
   - *Expected*: the grid holds exactly one project row, `other`.
4. They open **Programs** and reload.
   - *Expected*: the button "Program B" is shown and "Program A" is not.

## Scenario: a user without any right reads the tree with read-only bars and a row menu that only opens the project

1. The admin creates a throwaway user through the Users page, seeds the plan through the API and signs out. The user signs in, the program pick
   is set to programs A and B, and they open **Programs** and press **Expand all**.
   - *Expected*: the project rows are shown; A's bar is named "<A>, program span 2026-02-02 to 2026-04-10, read-only".
2. They look for anything that could be edited.
   - *Expected*: there is no row handle; `late`'s target window is an image named "<late>, target window 2026-03-02 to 2026-03-31, read-only"
     and no bar of the page is a button.
3. They open **Operations for <late>**.
   - *Expected*: the menu offers exactly one item, **Open project <late>**.
4. The user signs out; the admin signs back in and deletes the user.

## Not covered here (and why)

- **The roll-up in part (a work stream the pick shows only partly), the plural sentences, the empty and failed loads, Expand all's announcement,
  the default open set after a refetch, the arrows leaving with a fold for a bundle link** - pinned by `Programs.test.tsx` and
  `programsTree.test.ts`; this journey drives the real browser (focus through a fold, the shared stored pick across pages and a reload, the
  arrow in the DOM, the Year header).
- **The virtual path of an expanded sample plan (~125 rows)** - a manual pass on the loaded sample plan; the grid's virtualisation is covered
  by `Timeline.test.tsx` and the roadmap's e2e on the same component.
- **Editing the target window** - the band's move, the draw and the dialog are the same project row on this page as on the Roadmap: the real-layout
  gestures run in the roadmap's scenario, this page's own write path (the tree's cache, the roll-up counts that follow a cleared drift, the refusal)
  is pinned by `Programs.window.test.tsx`.
- **Flags with real data in the axe scan** - `accessibility.spec.ts` scans the tree with the fixture program opened (drift flag icon, the bundle
  arrow of a violated milestone link), light and dark.
