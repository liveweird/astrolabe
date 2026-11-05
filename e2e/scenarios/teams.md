# Teams (the flat-teams registry)

- **Spec**: [tests/teams.spec.ts](../tests/teams.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`); one throwaway person (seeded through
  the API) in the first test, one throwaway team (seeded through the API) in the second and one throwaway user in the third
- **Owns** (exclusive server-side state): its throwaway teams (unique `e2e-team-*` /
  `e2e-ro-team-*` / `e2e-esc-team-*` names), person (`e2e-person-*`) and user — all deleted by the end of the file

## Scenario: admin creates a team, renames it, assigns its manager, and deletes it

1. The admin signs in and seeds a throwaway person (a name and an email) through the API.
2. On the Teams page they click **New team**, fill a unique name and a description, and Create.
   - *Expected*: the app lands on the new team's page — its name as the heading, "No manager".
3. They click **Edit**, change the name, and Save.
   - *Expected*: the heading shows the new name.
4. They click **Edit** again, search the **Manager** picker for the throwaway person, pick them (the option reads "name (email)"), and Save.
   - *Expected*: the details page reads "Manager: <the person's name>".
5. Back on the Teams list they filter by the new name and delete the team from its row menu.
   - *Expected*: the row is gone and the keyboard focus is on the page's "Teams" heading (not on the document start); the throwaway person is removed afterwards through the API.

## Scenario: dismissing a delete, edit or new-team dialog with Escape returns the focus to what opened it

1. The admin signs in and seeds a throwaway team through the API, then opens the Teams page and filters by its name.
2. With the keyboard only, they focus the row's **Operations for <name>** button, press Enter, move to **Delete <name>** and press Enter.
   - *Expected*: the confirmation dialog opens.
3. They press Escape.
   - *Expected*: the dialog closes and the keyboard focus is back on the row's **Operations for <name>** button (not on the document start).
4. With the keyboard only again, they press Enter on that button, move to **Edit <name>**, press Enter, and then Escape.
   - *Expected*: the editor dialog opens and closes, and the keyboard focus is back on the row's **Operations for <name>** button.
5. They press Enter on **New team**, and then Escape.
   - *Expected*: the dialog opens and closes, and the keyboard focus is back on **New team**; the team is removed afterwards through the API.

## Scenario: Tab in an open row menu closes it and moves on from its kebab; Shift+Tab comes back to the kebab

1. The admin signs in and seeds two throwaway teams (a shared unique prefix) through the API, then opens the Teams page and filters by the prefix.
2. With the keyboard only, they focus the first row's **Operations for <name>** button, and press Enter.
   - *Expected*: the row menu is open with the focus on its first item, **Edit <name>**.
3. They press Tab.
   - *Expected*: the menu is gone; the keyboard focus is on a later control of the page — not the kebab, not the document start, not inside a menu.
4. They press Shift+Tab.
   - *Expected*: the focus is back on the first row's **Operations for <name>** button.
5. They open the menu again and press Shift+Tab.
   - *Expected*: the menu is gone and the focus is on an earlier control (not the kebab, not the document start); the teams are removed afterwards through the API.

## Scenario: a regular user sees the read-only teams list

1. The admin creates a throwaway user and a throwaway team, then signs out.
2. The user signs in and opens the Teams page, filtering by the team's name.
   - *Expected*: the team is listed as a link; there is no **New team** button and no row menu.
3. They open the team.
   - *Expected*: the team page renders with its name as the heading and without the **Edit** button.
4. The admin signs back in and deletes the team and the user.

## Not covered here (and why)

- **Validation and conflicts (empty name, duplicate name, unknown manager)** — pinned by the
  server's `TeamTest` and the SPA's `Teams.test.tsx`/`TeamDetails.test.tsx`; the journey drives
  the happy path only.
