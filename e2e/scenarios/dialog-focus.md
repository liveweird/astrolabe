# Dialog focus (the `useDialogFocus` sweep)

- **Spec**: [tests/dialog-focus.spec.ts](../tests/dialog-focus.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); every test signs in on its own
- **Owns** (exclusive server-side state): one API-seeded fixture shared by the tests, created in the beforeAll and deleted in the afterAll
  (reverse order): a person (`e2e-dlg-person-*`), a user (`e2e-dlg-user-*`), a team (`e2e-dlg-team-*`), a work stream, a program and a project
  (`e2e-dlg-stream-*`, `-program-*`, `-project-*`). Nothing is dated (no year, no holiday). The tests only open a dialog and dismiss it with Escape, so they
  write nothing and add no row to any shared list.

One shape for every scenario below: the administrator opens a page, puts the keyboard focus on the control that opens a dialog (a plain button, or for
Users the row's kebab and its menu item) and presses Enter.

- *Expected* (on open): the dialog is visible and the focus is INSIDE it (this also proves the focus left the opener, so the next check is not true by default).
- Escape closes the dialog.
  - *Expected* (on close): the dialog is gone and the focus is back on the opener (the button, or the row's kebab), not on `body`.

The dialogs are mounted already open (`{editor && <XModal opened />}`), so Mantine records no opener for its own focus return: each owner page's
`useDialogFocus(...)` call is the only thing that puts the focus back. Each scenario therefore fails if its owner drops the call. (Teams, the template
owner, is pinned by `teams.spec.ts`.) A page with several `useDialogFocus` calls is pinned through ONE of them; the others (Plan's move and Jira import,
ProjectView's and TeamDetails' schedule dialogs, the Jira/Flow pages) are not covered here.

## Scenario: Plan: the New work stream dialog takes the focus in and gives it back to its button

1. On `/plan` the **New work stream** button is focused and Enter opens its dialog; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **New work stream**.

## Scenario: ProjectView: the New milestone dialog takes the focus in and gives it back to its button

1. On `/projects/:id` of the fixture project the **New milestone** button is focused and Enter opens its dialog; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **New milestone**.

## Scenario: TeamDetails: the team editor takes the focus in and gives it back to the Edit button

1. On `/teams/:id` of the fixture team the **Edit** button is focused and Enter opens the team editor; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **Edit**.

## Scenario: TeamCapacity: the Add period dialog takes the focus in and gives it back to its button

1. On the same team page the **Add period** button of the Capacity section is focused and Enter opens the period dialog; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **Add period**.

## Scenario: People: the New person dialog takes the focus in and gives it back to its button

1. On `/people` the **New person** button is focused and Enter opens its dialog; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **New person**.

## Scenario: PersonDetails: the person editor takes the focus in and gives it back to the Edit button

1. On `/people/:id` of the fixture person the **Edit** button is focused and Enter opens the person editor; Escape dismisses it.
   - *Expected*: the focus is inside the dialog, then back on **Edit**.

## Scenario: Baselines: the Take baseline dialog takes the focus in and gives it back to its button

1. On `/baselines` the **Take baseline** button is focused and Enter opens its dialog; Escape dismisses it (no baseline is taken).
   - *Expected*: the focus is inside the dialog, then back on **Take baseline**.

## Scenario: Users: the reset-password confirmation takes the focus in and gives it back to the row's kebab

1. On `/users` the administrator filters by the fixture user's name and waits for the filtered answer. They focus the row's **Operations for <name>** kebab,
   press Enter, focus the **Reset password for <name>** menu item and press Enter; Escape dismisses the confirmation (no password is reset).
   - *Expected*: the focus is inside the dialog, then back on the kebab (its menu item left the DOM with its menu, so only the owner's hook knows where to go).
