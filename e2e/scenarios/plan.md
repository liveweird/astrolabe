# Plan (work streams, programs and projects)

- **Spec**: [tests/plan.spec.ts](../tests/plan.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); in the second test one throwaway user (the
  owner of one project, through their linked person)
- **Owns** (exclusive server-side state): its throwaway people (unique `e2e-plan-*` names), work streams,
  programs and projects (`e2e-plan-*`) and the user — all deleted by the end of the file (the plan nodes and
  people also by the afterEach, through the API, children first, when a step fails first)

## Scenario: admin builds a work stream, a program and a project, assigns owners, and deletes them bottom-up

1. The admin seeds two throwaway people through the API, signs in and opens the Plan page.
   - *Expected*: the page heading is "Plan".
2. They click **New work stream**, fill a unique name, pick the first person as **Owner**, type the start date
   `2026-01-05`, and Create.
   - *Expected*: the stream appears under its name as a section heading, with "Owner: <the first person> · From 2026-01-05".
3. They click **New program in <the stream>**, fill a name, pick the first person, and Create.
   - *Expected*: the program appears as a heading inside the stream.
4. They click **New project in <the program>**, fill a name, pick the second person as owner, type the target
   window `2026-02-02` to `2026-03-31`, and Create.
   - *Expected*: the program's projects table has a row with the project, the second person and "2026-02-02 – 2026-03-31".
5. They open the project's row menu, Edit it, rename it and hand it over to the first person (clearing the owner and picking again), and Save.
   - *Expected*: the row shows the new name and the first person, and the target window is unchanged.
6. They try to delete the work stream from its menu.
   - *Expected*: the server refuses (409) and the dialog says "This work stream still has programs. Delete them first."; they cancel.
7. They delete the project, then the program, then the work stream, each from its own menu after confirming.
   - *Expected*: each disappears from the page.

## Scenario: a project owner edits their project but is offered no target window and no other actions

1. The admin creates a throwaway user through the Users page and seeds, through the API, a person linked to that user,
   a second person (the "lead"), a work stream and a program owned by the lead, and two projects with a target
   window — one owned by the user's person, one by the lead. The admin signs out.
2. The user signs in and opens the Plan page.
   - *Expected*: the stream, the program and both projects are visible; there is no **New work stream**, no **New program in …**, no
     **New project in …**, no row menu on the stream, the program or the lead's project; the user's own project has a row menu.
3. They open their project's row menu and choose Edit.
   - *Expected*: the name is editable; **Target start** and **Target end** are disabled, with the note that only an administrator, an owner
     above the project or a roadmap editor can change the target window.
4. They rename the project and Save.
   - *Expected*: the row shows the new name and the unchanged target window "2026-02-02 – 2026-03-31".
5. The admin signs back in and deletes the user (the plan nodes and people are removed through the API).

## Not covered here (and why)

- **Validation, name clashes, the roadmap editor's window-only modal, the two-PUT save and the close/reopen actions** — pinned by
  `Plan.test.tsx`, `planForm.test.ts` and the server's `PlanStructureTest`; the journeys drive the happy paths and the
  role-dependent visibility only.
- **A stream owner or program owner creating below their node** — the same `can` flags drive it; the server matrix is in
  `PlanStructureTest` and the SPA's flag-gating in `Plan.test.tsx`.
