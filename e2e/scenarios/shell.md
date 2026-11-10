# App shell chrome: the icon rail, the theme switch, the account menu's Tab and route changes

- **Spec**: [tests/shell.spec.ts](../tests/shell.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`)
- **Owns** (exclusive server-side state): nothing — both settings are DEVICE-level
  localStorage, never synced server-side (unlike the per-user language in
  [i18n.md](i18n.md))

## Scenario: the icon rail collapses and expands the navbar, remembered across reload

1. The admin signs in.
   - *Expected*: the header's "Show or hide the navigation" toggle carries `data-expanded`,
     and the sidebar shows full-label leaves (**Teams** as a text link).
2. They click the toggle.
   - *Expected*: `data-expanded` is gone (rail mode) — the same leaf is still found by its
     accessible name, now carried as an `aria-label` on an icon-only link.
3. They reload the page.
   - *Expected*: the navbar stays collapsed — the choice persists on this device.
4. They click the toggle again.
   - *Expected*: `data-expanded` returns — the navbar expands back to full labels.

## Scenario: switching the theme in the account menu updates the color scheme and persists across reload

1. The admin opens the account menu and picks **Dark** in the theme control.
   - *Expected*: `<html data-mantine-color-scheme="dark">`.
2. They reload the page.
   - *Expected*: still dark — the device cached the choice.
3. They open the account menu again and pick **Light**.
   - *Expected*: `<html data-mantine-color-scheme="light">`.

## Scenario: Tab in the open account menu closes it and moves the focus on from its trigger

1. The admin signs in, focuses the account menu button and presses Enter.
   - *Expected*: the menu is open with the focus on its first item, **English**.
2. They press Tab (menu items are not Tab stops; the arrow keys move between them).
   - *Expected*: the menu is gone and the keyboard focus has moved on — not the account button, not the document start.
3. They open the menu with the pointer and pick **Dark** among the theme items.
   - *Expected*: the menu stays open and **Dark** is marked as the chosen theme (`aria-current`).
4. They close the menu with Escape, open it again from the keyboard and press Tab.
   - *Expected*: the menu opens on **English** again with **Dark** still marked, and the Tab leaves the menu as before.

## Scenario: the document title names the page and the focus moves to the main content on navigation

1. The admin signs in.
   - *Expected*: the tab title is **Astrolabe** (the Home page collapses to the brand alone).
2. They click **Teams** in the sidebar.
   - *Expected*: the Teams heading shows and the tab title is **Teams · Astrolabe**.
3. Without touching anything else, they look at where the keyboard focus is.
   - *Expected*: the focus is on the main content area (`#main-content`), not on the sidebar link that was clicked.
4. They press **Tab**.
   - *Expected*: the focus lands on a control inside the main content area (the Teams page), not back in the sidebar.
5. They click **Home**.
   - *Expected*: the tab title is **Astrolabe** again.

## Scenario: the Home page links to the plan, the roadmap and the deviations

1. The admin signs in.
   - *Expected*: the Home page's heading "Astrolabe" (h2) shows.
2. They click **Open the plan**.
   - *Expected*: the "Plan" heading (h2) shows. They click **Home** in the sidebar and the "Astrolabe" heading is back.
3. They click **Open the roadmap**.
   - *Expected*: the "Roadmap" heading (h2) shows. They click **Home** in the sidebar and the "Astrolabe" heading is back.
4. They click **Open the deviations**.
   - *Expected*: the "Deviations" heading (h2) shows. They click **Home** in the sidebar and the "Astrolabe" heading is back. Nothing is written.

## Not covered here (and why)

- **The System (auto) option and OS-preference resolution** — needs color-scheme emulation
  control per test; the light/dark round trip already proves the control writes and the
  provider reads back the stored value.
- **Colour tokens and contrast** — pinned by `web/src/theme.test.ts`; the accessibility sweep
  (`accessibility.spec.ts`) runs `color-contrast` against the rendered (default, light) pages.
