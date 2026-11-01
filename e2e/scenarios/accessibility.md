# Accessibility smoke (axe, WCAG A/AA)

- **Spec**: [tests/accessibility.spec.ts](../tests/accessibility.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) for the authenticated pages; an
  anonymous visitor for the login screen
- **Owns** (exclusive server-side state): one fixture team (with one capacity period, a WIP limit of 1, deleted with the team) and one fixture plan (a person, a work
  stream, a program and a project with two milestones - one scheduled past the project's target end, one
  left in the Unscheduled tray - plus a second project with one scheduled milestone that is linked as the fixture milestone's
  violated predecessor, plus a chain project of two back-to-back milestones (2026-01-26..30 and 2026-02-02..06) linked c0 -> c1 -> the
  fixture milestone with no spare day, so the fixture project has zero-slack links; unique `e2e-axe-*` names), created through the API before the
  detail-page block and deleted after it (the projects first: their milestones and links go with them); the list/form pages and the login screen are read-only

This is the registered template-title exception (see README.md): one `test()` per page is
generated from a list, so a single scenario section stands in for each list.

## Scenario: login screen has no WCAG A/AA violations

1. An anonymous visitor opens `/login` and waits for the sign-in form.
   - *Expected*: an axe scan (WCAG 2.0/2.1 A+AA, `color-contrast` included) reports zero
     violations.

## Scenario: `<path>` has no WCAG A/AA violations

1. The admin signs in, opens `<path>`, and waits for its heading.
   - *Expected*: an axe scan (same tags) reports zero violations.

The list covers the Home page, the Teams list, the People list, the Users list and its create form, the
ADMIN feature-flags screen, Change password, the Changelog and the Public holidays page (the current year's table or its empty state;
the page with a full table is scanned by `public-holidays.spec.ts`) — see
`tests/accessibility.spec.ts`'s `AUTHED_PAGES` list for the current set.

The detail-page block also scans `/plan` with the fixture plan rendered (a work stream, a program and a
project row, light and dark) and the project editor modal (dates, the target-window fieldset and the owner
picker) scoped to its dialog. It also scans `/roadmap` with the fixture project and the linked project ranked (the timeline grid with its row handles and menus, the drift flag icon, the bundle arrow of the violated milestone link) and the flag
panel open (its table of severities, project links and "Show in timeline" buttons), light and dark; the projects are ranked through the API for the scan and unranked again afterwards.
It scans `/programs` with the fixture program opened (the chevron buttons with `aria-expanded`, the summary bars and roll-up counts, the project rows with their bars, the drift flag icon and row menus, the bundle arrow of the violated milestone link), light and dark; the program pick narrows the page to the fixture program (the stack may hold the sample plan).
It scans the project view `/projects/:id` with the fixture project rendered (the timeline grid with an editable bar, the target-window band,
the orange drift badge, a violated dependency - the red arrow, the ghost row, the red "1 conflict" badge and the Dependencies table - and the Unscheduled tray, light and dark),
the same page again with the **Critical path toggle on** (the flag is stored in the browser before the page loads; the pressed toggle, the Slack column with a critical row and a ghost row's dash, the emphasised bars and the heavier arrow, the gray "Critical path" badge and the Critical chain table naming the chain member beyond the neighbour; light and dark; the fixture's chain project makes the links zero-slack, so the Dependencies table has three rows there),
the milestone editor modal (team picker, estimate) and the dependency editor modal (successor, kind toggle, predecessor picker, type, lag; plus the picker's open option list) scoped to their dialogs.
It scans the team view `/teams/:id` of the fixture team (the sticky weekly load strip with an overloaded column and the dashed WIP chip, the orange "weeks overloaded" and "weeks over WIP limit" badges and the red conflict badge on the facts line, the Capacity table with its limit, the expanded Weekly load table with its status badges, the arrows; light and dark) and the capacity period modal (date, man-days, WIP limit) scoped to its dialog.
It also scans the Plan page's "Move to…" modal (the grouped program select) scoped to its dialog, and its open option list; the fixture plan has a second program so the select has a target.

## Scenario: `<path>` has no WCAG A/AA violations in the dark scheme

1. The browser context emulates the dark colour scheme (Playwright `colorScheme: "dark"`; the
   app's `auto` default follows it). The admin signs in, opens `<path>` (the same list as above)
   and waits for its heading.
   - *Expected*: `<html>` carries `data-mantine-color-scheme="dark"` — the scan really runs in the
     dark palette — and an axe scan (same tags, `color-contrast` included) reports zero violations.

## Scenario: login screen has no WCAG A/AA violations in the dark scheme

1. An anonymous visitor with the dark scheme emulated opens `/login` and waits for the sign-in form.
   - *Expected*: the dark scheme is on `<html>` and the axe scan reports zero violations.

## Scenario: the app shell at a mobile width has no WCAG A/AA violations

1. The browser viewport is 390x844. The admin signs in, opens `/` and waits for the Home heading.
   - *Expected*: the header's burger is visible with the accessible name "Toggle navigation" (it is
     the only control that opens the nav drawer at this width), `<html>` carries the light scheme
     and an axe scan (same tags, `color-contrast` included) reports zero violations.

## Scenario: the app shell at a mobile width has no WCAG A/AA violations in the dark scheme

1. The same at 390x844 with the dark scheme emulated.
   - *Expected*: the burger is visible by name, `<html>` carries the dark scheme and the axe scan
     reports zero violations.

## Not covered here (and why)

- **Interactive journeys mid-flight** (the one-time password reveal, a confirm mid-transition)
  — those need the journey that produces them; covered by their own journey specs where
  reachable through the ordinary flow.
- **The opened mobile nav drawer** — only the closed shell (header + page) is scanned at the phone
  width; the drawer's slide-in transition makes contrast measurement racy.
- **Modals and detail pages in the dark scheme** — the dark pass covers the page sets above and the
  Plan page with rows, not the overlays or the fixture team's detail pages.
- **Colour tokens themselves** — the ratios are pinned in `web/src/theme.test.ts`; axe here
  verifies the rendered pages honour them.
