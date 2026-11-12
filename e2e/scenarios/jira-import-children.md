# Import what Jira lists under a linked program or project (rooted import, empty root, project page, axe)

- **Spec**: [tests/jira-import-children.spec.ts](../tests/jira-import-children.spec.ts)
- **Actors**: a throwaway NON-admin `USER` login per test (seeded through the API, linked to a person; the preview and the apply share a 5-a-minute bucket PER USER, so every
  test has its own login and spends at most three calls), who works in the browser; the seed administrator only seeds, links (`POST /api/v1/integrations/jira/bindings`) and tears down
  through the API. The work stream is owned by ANOTHER person: the login owns only the program (or, in the project test, only the project).
- **Owns** (exclusive server-side state): one Jira connection (`e2e-impchild-connection-*`, scoped to the stub's `IMC` project ONLY, on a unique throwaway site
  `https://stub-e2eimpchild<random>.atlassian.net`, tested once in the beforeAll through the API: Test connection shares a per-IP bucket (10 a minute by default, 30 on the e2e
  stacks) with the other Jira specs; a 429 there waits the bucket out once) and, per test, a person for the login, a person who owns the stream, a team (no manager, so the
  milestones are created unscheduled), a work stream, one program (two in the first test: an unlinked sibling the login owns too), in the project test a project, ONE binding
  (the program to `IMC-1` or `IMC-14`, or the project to `IMC-2`) and what the import creates (the stub's own names: "IMC Initiative North/South", "IMC Epic One" ...), all with
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

## Scenario: the import from a linked program has no WCAG A/AA violations

1. The login opens the dialog from the linked program's menu (light scheme) and scans it with axe at the scope step, empty and with the default team picked, then previews and scans the preview.
   - *Expected*: no A/AA violations at any of the three points (the scope step with its `role="note"` line, the preview with the "Kept as a parent" row). Nothing is imported.

## Scenario: the import from a linked program has no WCAG A/AA violations in the dark scheme

1. The same walk with the browser in the dark colour scheme.
   - *Expected*: the scheme really is dark; no A/AA violations at the three points.
