# Import what Jira lists under a linked program or project (rooted import, empty root, project page, Plan project row, connection page, outside the root, a suggested match, axe)

- **Spec**: [tests/jira-import-children.spec.ts](../tests/jira-import-children.spec.ts)
- **Actors**: a throwaway NON-admin `USER` login per test (seeded through the API, linked to a person; the preview and the apply share a 5-a-minute bucket PER USER, so every
  test has its own login and spends at most three calls), who works in the browser; the seed administrator only seeds, links (`POST /api/v1/integrations/jira/bindings`) and tears down
  through the API. The work stream is owned by ANOTHER person: the login owns only the program (or, in the project tests, only the project). The connection-page scenario (1.15)
  signs in as a throwaway ADMINISTRATOR of its own (`apiAsThrowawayAdmin`, deleted in a `finally`), because the preview's bucket is per user and the shared administrator is never spent.
- **Owns** (exclusive server-side state): one Jira connection (`e2e-impchild-connection-*`, scoped to the stub's `IMC` project ONLY, on a unique throwaway site
  `https://stub-e2eimpchild<random>.atlassian.net`, tested once in the beforeAll through the API: Test connection shares a per-IP bucket (10 a minute by default, 30 on the e2e
  stacks) with the other Jira specs; a 429 there waits the bucket out once) and, per test, a person for the login, a person who owns the stream, a team (no manager, so the
  milestones are created unscheduled), a work stream, one program (two in the first test: an unlinked sibling the login owns too; in the suggested-match tests the program also holds ONE unlinked project named exactly "Initiative North", owned by the login), in the project tests a project (the Plan-row test also an unlinked sibling project), in the outside-the-root test a second program owned by the other person with a project linked to `IMC-2`, ONE binding
  (the program to `IMC-1` or `IMC-14`, or the project to `IMC-2`; two in the outside-the-root test) and what the import creates (the stub's own names: "IMC Initiative North/South", "IMC Epic One" ...), all with
  unique `e2e-impchild-*` names and dated **2045** where dated at all. A rooted import creates no program, so there is no global name to guard and no Playwright lock. Teardown
  is the afterEach, even after a failure: the connection's bindings, then the stream's projects (their milestones go with them), programs and the stream, then the team, the people
  and the login; the afterAll deletes the connection. The beforeAll first sweeps a crashed run's residue, found by the `e2e-impchild-` prefix and nothing else.

The stub's `IMC` project (`sample-data/jira/world.mjs`, `expected.json` `imc`; the figures below are its `byRoot`): `IMC-1` the Program "IMC Program" (the root of the first, fourth and
fifth scenarios, never a row); Initiatives `IMC-2` North (open), `IMC-3` South (Done, with `IMC-7` open under it), `IMC-4` East (Done, only done work under it) under it; Epics `IMC-5`
One and `IMC-6` Two (Done) and `IMC-10` Six (stamped 2010) under North, `IMC-7` Three under South, `IMC-8` Four (Done) under East and `IMC-9` Five straight under the Program (nowhere to
put it without a default project). `IMC-11..13` hang under another Program and are never listed by a rooted read. `IMC-14` is a Program with nothing under it. The epics' Jira team
"IMC Team" matches no team here: every milestone takes the default team.

## Scenario: a program's owner imports the projects and milestones under their linked program

1. The login opens the Plan page and the program's **Operations** menu; then the unlinked sibling's.
   - *Expected*: the linked program's menu has **Import from Jira what is listed under <program>**; the sibling's menu opens (it has its Edit item) but has no such item.
2. They choose the entry.
   - *Expected*: the dialog's note reads "Importing what Jira lists under IMC-1 into the program “<program>”: its projects and their milestones."; there is no Work stream, Jira projects or
     Default program field; **Owner of the new items** holds the program's owner; **Project for items directly under IMC-1** is offered (optional); the filter is at its defaults
     (**Leave out done items** ticked, 365 days).
3. They pick the default team and press **Preview**.
   - *Expected*: the totals read "Jira items: 5", "To create: 4", "To link: 0", "Skipped: 1" and "4 of 4 selected"; the note names the unmatched Jira team "IMC Team"; the "Left out"
     note reads "done items, and items not updated for more than 365 days"; rows exist for `IMC-2`, `IMC-3`, `IMC-5`, `IMC-7` and `IMC-3` reads "Kept as a parent of an item shown here"; none for the
     root `IMC-1`, for `IMC-4`, `IMC-6`, `IMC-8`, `IMC-10` (left out), `IMC-11..13` (not under the root) or `IMC-9` (its skipped row is redacted for a non-admin under a filter: one "Hidden" key cell).
4. They press **Import (4)** and close the dialog.
   - *Expected*: the outcome reads "Created: 4", "Linked: 0", "Scheduled: 0" (the login manages no team), "Skipped: 0"; the Plan page lists "IMC Initiative North" and "IMC Initiative South" under the
     program; the API shows North holding "IMC Epic One" and South "IMC Epic Three", both unscheduled, and the stream's programs unchanged (no program was created).
5. They open the entry again, pick the default team and press **Preview**.
   - *Expected*: "Jira items: 5", "To create: 0", "To link: 0", "Skipped: 5", "0 of 0 selected"; `IMC-2` reads "Already linked"; **Import (0)** is disabled; the plan is exactly as after step 4.

## Scenario: a linked program with nothing under it in Jira says so

1. The login opens the entry of a program linked to `IMC-14` and presses **Preview** at the defaults.
   - *Expected*: the note names `IMC-14`; the totals read "Jira items: 0"; a note says "Jira lists nothing under IMC-14 at the levels this connection maps.", "The filter may be why: go back and switch
     “Leave out done items” off or widen the days." and "If IMC-14 has child items in Jira, search Jira for parent = IMC-14."; there is no table; **Import (0)** is disabled.
2. They press **Back**, switch **Leave out done items** off, clear the days and preview again.
   - *Expected*: the first and third sentences remain, the filter sentence is gone, **Import (0)** is still disabled and the program still has no project.

## Scenario: a project's owner imports the linked project's milestones from the project page

1. The login (who owns only the project, linked to `IMC-2`) opens the project page and presses **Import from Jira…** in its header.
   - *Expected*: the note reads "Importing what Jira lists under IMC-2 into the project “<project>”: its milestones."; there is no Work stream, Jira projects, Default program, Owner or
     "Project for items directly under" field.
2. They pick the default team and press **Preview** at the defaults.
   - *Expected*: "Jira items: 1", "To create: 1"; only `IMC-5` is a row; the "Left out" note is shown.
3. They press **Back**, switch the done filter off, clear the days and preview again.
   - *Expected*: "Jira items: 3", "To create: 3"; rows for `IMC-5`, `IMC-6`, `IMC-10`; no "Left out" note.
4. They press **Import (3)** and close the dialog.
   - *Expected*: "Created: 3"; the project page shows "IMC Epic One", "IMC Epic Two" and "IMC Epic Six"; the API shows all three unscheduled (the login manages no team).

## Scenario: a project's owner starts the import from the Plan page's project row

1. The login (who owns only two projects of a program that belongs to another person: one linked to `IMC-2`, an unlinked sibling) opens the Plan page and the linked project's **Operations** menu; then the sibling's.
   - *Expected*: the linked project's menu has **Import from Jira what is listed under <project>**; the sibling's menu opens (it has its Edit item) but has no such item.
2. They choose the entry.
   - *Expected*: the note reads "Importing what Jira lists under IMC-2 into the project “<project>”: its milestones."; there is no Work stream, Jira projects, Default program, Owner or "Project for items directly under" field.
3. They pick the default team and press **Preview** at the defaults.
   - *Expected*: "Jira items: 1", "To create: 1"; only `IMC-5` is a row.
4. They press **Import (1)**, close the dialog and open the project from the Plan page.
   - *Expected*: "Created: 1", "Skipped: 0"; the project page shows "IMC Epic One"; the API shows it unscheduled under the project and nothing under the sibling project.

## Scenario: an administrator starts the import of a linked program from the connection page's list

1. A throwaway administrator opens the Jira connection's page; the list of links has the program linked to `IMC-1`.
   - *Expected*: the row has **Import from Jira what is listed under <program>** (visible text "Import from Jira…") beside Unlink.
2. They press it.
   - *Expected*: the dialog's note reads "Importing what Jira lists under IMC-1 into the program “<program>”: its projects and their milestones."; there is no Work stream or Jira projects field; **Owner of the new items** holds the program's owner.
3. They pick the default team and press **Preview** at the defaults.
   - *Expected*: "Jira items: 5", "To create: 4", "To link: 0", "Skipped: 1"; `IMC-9` is shown with its key and "Nowhere to put it" (an administrator's skipped rows are not redacted); no "Hidden" key cell.
4. They close the dialog without importing.
   - *Expected*: the program has no project.

## Scenario: items under a project that is linked in another program are skipped and the rest of the preview stays

1. The login owns the linked root program (`IMC-1`) only; a second program of the same work stream, owned by another person, has a project linked to `IMC-2`. The login opens the program's import, picks the default team and presses **Preview** at the defaults.
   - *Expected*: the preview answers (before 1.15 it was refused with a 403 naming the other project): "Jira items: 5", "To create: 2", "To link: 0", "Skipped: 3", "2 of 2 selected"; `IMC-2` reads "Already linked to <the other project>."; `IMC-3` and `IMC-7` read Create; `IMC-5` and `IMC-9` are redacted (two "Hidden" key cells, a filter is on), one with "It belongs under a project of another program …" and the other with "Nowhere to put it …".
2. They press **Import (2)** and close the dialog.
   - *Expected*: "Created: 2", "Linked: 0", "Skipped: 0"; the root program holds "IMC Initiative South" with "IMC Epic Three" unscheduled; the other program's project still has no milestone.

## Scenario: the import from a linked program has no WCAG A/AA violations

1. The login opens the dialog from the linked program's menu (light scheme) and scans it with axe at the scope step, empty and with the default team picked, then previews and scans the preview.
   - *Expected*: no A/AA violations at any of the three points (the scope step with its `role="note"` line, the preview with the "Kept as a parent" row). Nothing is imported.

## Scenario: the import from a linked program has no WCAG A/AA violations in the dark scheme

1. The same walk with the browser in the dark colour scheme.
   - *Expected*: the scheme really is dark; no A/AA violations at the three points.

## Scenario: a renamed item is offered as a link to the unlinked plan project, and linking it adds no duplicate

1. The login (who owns the linked root program `IMC-1` and its one unlinked project "Initiative North") opens the program's import from the Plan page, picks the default team and presses **Preview** at the defaults.
   - *Expected*: "Jira items: 5", "To create: 4", "To link: 0", "Skipped: 1"; the `IMC-2` row reads Create and "Looks like “Initiative North” in the plan, which is not linked yet" with **Link instead: IMC-2 to Initiative North**; it is the only row with a suggestion; a note says "1 item looks like a plan item that is not linked yet." and, because the filter is on, "Items the filter left out are not considered."; **Possible matches only** is off; the plan still holds only "Initiative North" (the preview changed nothing).
2. They untick `IMC-7`, then press **Link instead** on `IMC-2`.
   - *Expected*: "3 of 4 selected"; the row says "Will be linked to “Initiative North” after the next preview"; a note says "1 change to the matches is waiting. Preview again to see what the import would do."; **Import** is disabled; the totals are still the first preview's.
3. They press **Preview again** in the banner.
   - *Expected*: the banner is gone; "Jira items: 5", "To create: 3", "To link: 1", "Skipped: 1"; `IMC-2` reads "Linked to a plan item with a different name, as you confirmed" with **Create instead: IMC-2 as a new item**; `IMC-5` reads "Under Initiative North"; `IMC-7` is still unticked ("3 of 4 selected") and `IMC-2` is ticked; Import is enabled; the plan is still unchanged.
4. They tick `IMC-7` again, press **Import (4)** and close the dialog.
   - *Expected*: "Created: 3", "Linked: 1", "Skipped: 0"; the Plan page lists "Initiative North" and "IMC Initiative South" under the program and NO "IMC Initiative North"; the API shows "Initiative North" holding "IMC Epic One" and South holding "IMC Epic Three", both unscheduled.

## Scenario: the import preview with a possible match has no WCAG A/AA violations

1. The login opens the same program's import (light scheme), picks the default team, previews and scans the preview with the suggestion; then presses **Link instead** and scans again with the banner and the pending row.
   - *Expected*: no A/AA violations at either point. Nothing is imported.

## Scenario: the import preview with a possible match has no WCAG A/AA violations in the dark scheme

1. The same walk with the browser in the dark colour scheme.
   - *Expected*: the scheme really is dark; no A/AA violations at either point.
