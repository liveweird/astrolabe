# Plan (work streams, programs and projects)

- **Spec**: [tests/plan.spec.ts](../tests/plan.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); in the second test one throwaway user (the
  owner of one project, through their linked person); in the order tests a work stream's owner and a reader
- **Owns** (exclusive server-side state): its throwaway people (unique `e2e-plan-*` names), work streams,
  programs and projects (`e2e-plan-*`) and the user — all deleted by the end of the file (the plan nodes and
  people also by the afterEach, through the API, children first, when a step fails first)

## Scenario: admin builds a work stream, a program and a project, assigns owners, and deletes them bottom-up

1. The admin seeds two throwaway people through the API, signs in and opens the Plan page.
   - *Expected*: the page heading is "Plan".
2. They click **New work stream**, fill a unique name, pick the first person as **Owner**, type the start date
   `2026-01-05`, and Create.
   - *Expected*: the stream appears as a row of the Plan table under its name, with the first person as owner and "From 2026-01-05".
3. They click **New program in <the stream>** (the "+" of the stream's row), fill a name, pick the first person, and Create.
   - *Expected*: the program appears as a row whose parent is the stream.
4. They click **New project in <the program>**, fill a name, pick the second person as owner, type the target
   window `2026-02-02` to `2026-03-31`, and Create.
   - *Expected*: the project's row has the second person and "2026-02-02 – 2026-03-31".
   - They fold the work stream with its disclosure button: the program's and the project's rows are gone and the button says it is collapsed;
     after a page reload the stream is still folded (folds are remembered in the browser); opening it brings the rows back.
   - They type the project's full name into the search box: after a pause the address holds `q=<the name>`, the table shows only that project under
     its program and stream, the two ancestors as dimmed context rows (`data-context`) and the matched letters marked. After a reload the box still holds the
     text and the filter still applies; the clear button removes it and the rows return, no longer context.
5. They open the project's row menu, rename it, hand it over to the first person and extend the target window to `2026-04-15`.
   - *Expected*: Save sends one details update. The row shows the new name, the first person and "2026-02-02 – 2026-04-15".
6. They try to delete the work stream from its menu.
   - *Expected*: the server refuses (409) and the dialog says "This work stream still has programs. Delete them first."; they cancel.
7. They delete the project, then the program, then the work stream, each from its own menu after confirming.
   - *Expected*: each disappears from the page.

## Scenario: a project owner edits their project but is offered no target window and no other actions

1. The admin creates a throwaway user through the Users page and seeds, through the API, a person linked to that user,
   a second person (the "lead"), a work stream and a program owned by the lead, and two projects with a target
   window — one owned by the user's person, one by the lead. The admin signs out.
2. The user signs in and opens the Plan page.
   - *Expected*: the stream (its disclosure button says it is expanded), the program and both projects are visible; there is no **New work stream**, no **New program in …**, no
     **New project in …**, the row menus of the stream, the program and the lead's project hold only the view items (**Show only this**, **Pin**; a project only **Pin**); the user's own project's menu adds **Edit** and **Delete** (a node's owner manages it).
3. They open their project's row menu and choose Edit.
   - *Expected*: the name is editable; **Target start** and **Target end** are disabled, with the note that only an administrator, an owner
     above the project or a roadmap editor can change the target window.
4. They rename the project and Save.
   - *Expected*: the row shows the new name and the unchanged target window "2026-02-02 – 2026-03-31".
5. The admin signs back in and deletes the user (the plan nodes and people are removed through the API).

## Scenario: a work stream owner moves a project to another program and a program to another work stream; rank and milestones travel along

1. The admin creates a throwaway user through the Users page and seeds, through the API, a person linked to that user (the "owner"), a
   second person (the "lead"), a team, two work streams A and B owned by the owner, two programs under A and two projects (one with a
   milestone) under the first program, all led by the lead; the two projects are appended to the global ranking. The admin signs out.
2. The owner signs in and opens the Plan page, opens the moving project's row menu and chooses **Move to…**.
   - *Expected*: the dialog "Move project" says the project is currently in the first program; its **New program** options leave out that
     program.
3. They pick the second program and press **Move**.
   - *Expected*: the toast "Project moved"; the dialog closes; the project's row now names the second program as its parent.
4. They open the project through its name.
   - *Expected*: the page header line names the second program, the work stream A and the lead, and the milestone is still in the Unscheduled tray.
5. Back on the Plan page they open the second program's menu and choose **Move to…**, pick work stream B (work stream A is not offered) and press **Move**.
   - *Expected*: the toast "Program moved"; the program's row now names work stream B as its parent; opening the project shows
     the header line with B.
6. *Expected*: through the API, the two ranked projects are still in the same relative order (a move leaves the global ranking alone).
7. The admin signs back in and deletes the user (the plan nodes, the team and the people are removed through the API).

## Scenario: a pinned program stays in reach while a search runs, pins and folds survive a reload, and Show only this leads back by the breadcrumb

1. The admin seeds, through the API, a person, a work stream and two programs under it, each with one project. They sign in and open the Plan page.
2. They open the first program's row menu and choose **Pin: <the program>**.
   - *Expected*: a "Pinned" section appears above the table with that program and its project; the program's tree row carries the pin marker; the focus is on the row's menu button.
3. They fold the program in the pinned section.
   - *Expected*: its project row leaves the pinned section; the tree still lists the project (the two folds are separate).
4. They type the other program's project name into the search box.
   - *Expected*: after a pause the address holds `q=<the name>`; the tree shows that project; the pinned program is no longer in the tree but is still in the pinned section, in the viewport.
5. They reload the page.
   - *Expected*: the search box holds the text, the pin is still there and its fold is still folded. Clearing the search removes `q` from the address.
6. They open the other program's menu and choose **Show only this: <the program>**.
   - *Expected*: the address holds `programId=<its id>`; the table is that program and its project only; the breadcrumb shows "All work streams" and a link to the work stream; the pinned section is unchanged.
7. They follow "All work streams".
   - *Expected*: `programId` leaves the address and the tree shows the plan again.
8. They press **Unpin: <the program> (pinned)** in the pinned section.
   - *Expected*: the section is gone and the focus is on the program's row menu button in the tree.

## Scenario: a work stream owner re-orders its programs by a drag and from the row menu; the Programs page and an admin read the same order; a reader has no grip

1. The admin creates two throwaway users, the owner of a work stream (through a linked person) and a reader with no person, and seeds, through the API, that stream with three programs (A, B, C by name) and a project under each (the Programs page's rows are read by their fold buttons, which only a program with projects has).
2. The reader opens the Plan page.
   - *Expected*: the programs are in name order (A, B, C) and no row of the table has a grip.
3. The owner signs in and opens the Plan page.
   - *Expected*: each program row has a grip; the work stream's row has none (ordering streams is the administrator's right) and the project's row has none (a project is never re-arranged).
4. They press the grip of program A and drag it, with the pointer, onto the lower half of program C's block (its project's row, the last row under C).
   - *Expected*: the page saves the stream's program order (a 200) and the programs are B, C, A (A's project travelled with it).
5. With the keyboard they focus A's menu button, press Enter and use the arrow keys to **Move up: A** (the menu opens on **Show only this**; **Move down** is disabled on the last row), then Enter.
   - *Expected*: the programs are B, A, C; the focus is back on A's menu button; the status region says "<A> moved to position 2 of 3".
6. They open the Programs page, narrowed to the three programs.
   - *Expected*: its program rows are B, A, C.
7. The admin signs in and opens the Plan page.
   - *Expected*: the same order, B, A, C. The admin deletes the two users (the plan nodes and people are removed through the API).

## Scenario: an admin moves one of its own work streams above the other from the row menu; a closed work stream stays last

1. The admin seeds, through the API, a person and three work streams: two open (named so that "first" sorts before "second") and one closed. They sign in and open the Plan page.
   - *Expected*: the two open streams each have a grip; by name the first is above the second, and the closed stream is below both.
2. They choose **Move up: <the second stream>** from its row menu until it is above the first (each step is one place among the open streams; other tests' streams may sit between them, and a step that meets another worker's change is answered with the stale notice and simply goes again).
   - *Expected*: every step is a 200, the stale 409, or a 400 (another worker deleted its own stream meanwhile, so the full list names a stream that is gone; a delete bumps no order revision) and nothing else; the second stream ends above the first and the closed stream is still below both. After a reload the order is the same.

## Not covered here (and why)

- **The stale and failure branches of a re-arrangement, the Move items' ends and gating, the off state under a filter, the announcements of a drag and a dropped row outside its list** — pinned by `Plan.order.test.tsx` and `planOrder.test.ts` (the pointer drag itself needs a layout, so only a browser proves it: the first order test); the second test meets the stale notice by chance, never by design.

- **The move dialog's error branches (409/400/403/404), the no-target state and the keyboard path** — pinned by `PlanMove.test.tsx`; the journey drives
  the two happy-path moves and the unchanged ranking.
- **The order of pins, the fold of the whole section, a pin of a deleted node and the focus moving to a neighbouring pin** — pinned by `Plan.pins.test.tsx`, `Plan.focus.test.tsx` and `planPins.test.ts`.
- **Validation, name clashes, the roadmap editor's window-only modal and the close/reopen actions** — pinned by
  `Plan.test.tsx`, `planForm.test.ts` and the server's `PlanStructureTest`; the journeys drive the happy paths and the
  role-dependent visibility only.
- **A stream owner or program owner creating below their node** — the same `can` flags drive it; the server matrix is in
  `PlanStructureTest` and the SPA's flag-gating in `Plan.test.tsx`.
