# Accessibility smoke (axe, WCAG A/AA)

- **Spec**: [tests/accessibility.spec.ts](../tests/accessibility.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) for the authenticated pages; an
  anonymous visitor for the login screen
- **Owns** (exclusive server-side state): one fixture team (with one capacity period, a WIP limit of 1, deleted with the team) and one fixture plan (a person, a work
  stream, a program and a project with two milestones - one scheduled past the project's target end, one
  left in the Unscheduled tray - plus a second project with one scheduled milestone that is linked as the fixture milestone's
  violated predecessor, plus a chain project of two back-to-back milestones (2026-01-26..30 and 2026-02-02..06) linked c0 -> c1 -> the
  fixture milestone with no spare day, so the fixture project has zero-slack links; unique `e2e-axe-*` names), created through the API before the
  detail-page block and deleted after it (the projects first: their milestones and links go with them); the list/form pages and the login screen are read-only; plus, for the open-schedule-proposal scan, its own team pair (the proposed team with one capacity period from 2042-01-06, 10 MD/week, WIP limit 2; and a second team), a person, work stream, program, project, four milestones and two links (unique `e2e-axe-prop-*` names, all dated in 2042), created in that describe's beforeAll and deleted in its afterAll (the hovered-row scan rides a second copy of that world, created in the detail-page block's beforeAll and deleted in its afterAll); plus, for the baseline scans, a world and a baseline of their own (a team, a person, a work stream, a program, a project, four milestones and one baseline taken after the plan existed, unique `e2e-axe-bl-*` names, dated in 2026), created in that describe's beforeAll (the plan is re-planned under the baseline there) and deleted in its afterAll, the baseline first (a soft delete). For the Jira pages, a world and a connection of their own (a team, a person, a work stream, a program, a project, one milestone and one Jira connection scoped to the stub's `E2E` project with a unique throwaway site and one binding, unique `e2e-axe-jira-*` names, dated in 2044), created in that describe's beforeAll and deleted in its afterAll, the connection first (its binding goes with it). The connection is manual-only and runs once, manually, in the beforeAll (its status reads Current); the one Deviations scan that acknowledges the binding withdraws it again in a `finally`. For the Flow pages (1.5), a team (`e2e-axe-flow-team-*`) and a Flow connection (`e2e-axe-flow-connection-*`, base URL `E2E_FLOW_STUB_ORIGIN`, the stub's token, manual-only, tested once through the API - one call of the `flow-test` bucket - and read once in the beforeAll) with the team linked to the stub's "Axe Flow Team" (2026 dates, three current members and one former), created in that describe's beforeAll and deleted in its afterAll, the connection first (its link goes with it); no scan presses Test connection, and the stub's scenarios are never flipped.

This is the registered template-title exception (see README.md): one `test()` per page is
generated from a list, so a single scenario section stands in for each list.

## Scenario: login screen has no WCAG A/AA violations

1. An anonymous visitor opens `/login` and waits for the sign-in form.
   - *Expected*: an axe scan (WCAG 2.0/2.1 A+AA, `color-contrast` included) reports zero
     violations.

## Scenario: `<path>` has no WCAG A/AA violations

1. The admin signs in, opens `<path>`, and waits for its heading.
   - *Expected*: an axe scan (same tags) reports zero violations.

The list covers the Home page, the Schedule proposals page (1.8: the team picker; the administrator is offered every team, and no run is requested here), the Teams list, the People list, the Users list and its create form, the
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
It scans the team page `/teams/:id` with an **open schedule proposal** (v0.8: `/teams/:id with an open schedule proposal has no WCAG A/AA violations`, light and dark; a world of its own in 2042 - team T proposed for, with two moves: a new 6 MD milestone whose proposed span ends after a fixed successor of the other team starts, and a scheduled one that waits for a fixed predecessor of the other team; the proposal is requested with **Propose schedule**, the pointer is parked on the page heading so no row is hover-tinted, and the scan covers the dashed proposal bars, the Proposed schedule section's checkboxes and select-all, the summary line and the red "1 link would be violated" badge, the links column's "Conflict" badge, red "would violate" text and gray "resolves" text, and the Accept selected / Discard buttons).
It scans the baselines (v0.9; a describe of its own with its own world and baseline, light and dark): `/baselines with a row has no WCAG A/AA violations` (the registry table with the fixture baseline's row, its link and the Take baseline button), `/baselines/:id has no WCAG A/AA violations` (the comparison page, narrowed with the Project filter to the fixture project: the totals badges, the project row with its orange "Later" badge, the moved, new and removed milestone rows) and `/teams/:id with a baseline picked has no WCAG A/AA violations` (the pick stored in the browser before the page loads; the picker, the shadow bars under the moved milestone and the two appended rows "(unscheduled since the baseline)" and "(removed)", the Movement table open with its "Later" and "New" badges); the world is re-planned after the baseline is taken so every row kind exists.
The baseline world is scanned on three more pages, light and dark (the baseline pick and the program pick are stored in the browser before the page loads, the program pick narrowing a stack that holds the sample plan to the fixture program): `/roadmap with a baseline picked has no WCAG A/AA violations`, `/programs with a baseline picked has no WCAG A/AA violations` (the fixture program opened) and `/projects/:id with a baseline picked has no WCAG A/AA violations` (the shadow bars, the totals line on the plan pages, the Movement section on the project page).
It scans the OPEN row menus (`the open row menus of the Teams list, the Baselines list and the roadmap timeline have no WCAG A/AA violations`, light and dark): a Mantine menu dropdown only exists in the DOM while open, so a scan of a page with its menus closed never sees it.
It also scans the Plan page's "Move to…" modal (the grouped program select) scoped to its dialog, and its open option list; the fixture plan has a second program so the select has a target.

## Scenario: /integrations/jira has no WCAG A/AA violations

The Jira pages (v1.1) are one describe of their own with their own world: a connection scoped to the stub's `E2E` project (tested once in the beforeAll through the API - no
scan presses Test connection or Peek, which share the per-IP bucket (10 a minute by default, 30 on the e2e stacks) with `jira-sync.spec.ts` - so the two result tables are axe-scanned by `jira-sync.spec.ts` instead, at no extra call), one
milestone (2044-01-04..2044-01-13, a plan, a team and a person of its own, `e2e-axe-jira-*`) linked to the stub's `E2E-4`, which exists in both of the stub's scenario
states, so nothing here depends on `jira-sync.spec.ts`'s flips or rows. Each test runs in the light scheme and again in the dark one.

1. The administrator opens `/integrations/jira` and waits for the heading and the fixture connection's row link.
   - *Expected*: the scheme is on `<html>` and an axe scan reports zero violations.

## Scenario: /integrations/jira/:id has no WCAG A/AA violations

1. The administrator opens the fixture connection's page and waits for every section: Connection (facts, the "Recent runs" table), Mapping (the discovery report, the mapping
   form, "Peek at an issue") and "Links to plan items" with the fixture milestone's row.
   - *Expected*: zero violations.

## Scenario: /deviations has no WCAG A/AA violations

1. The administrator opens `/deviations?projectId=<fixture project>` and waits for the fixture milestone's row ("Ends 3 working days later than Jira": the orange warning badge).
   - *Expected*: zero violations.

## Scenario: the Jira connection editor modal has no WCAG A/AA violations

1. The administrator opens the registry and presses **New connection**; the scan is scoped to the dialog; Escape closes it.
   - *Expected*: zero violations.
2. They open the fixture row's **Edit** from its row menu (the site read-only, "A token is stored. Leave blank to keep the current token").
   - *Expected*: zero violations.

## Scenario: the Jira bind dialog has no WCAG A/AA violations

1. The administrator opens the fixture connection's page and presses **Link a node…**; the dialog's connection is the page's own, the node picker and the issue-key field are
   shown.
   - *Expected*: the scan scoped to the dialog reports zero violations. (The same dialog is opened from the project page by `jira-sync.spec.ts`.)

## Scenario: the Jira connection editor's Polling controls have no WCAG A/AA violations

1. The administrator opens the fixture connection's page and presses **Edit**: the connection is manual-only, so **Manual only (no polling)** is checked and the interval is disabled.
   - *Expected*: the scan scoped to the dialog reports zero violations.
2. They uncheck it, type 3 in **Polling interval (minutes)** and press **Save**.
   - *Expected*: the rule's refusal ("… from 5 to 1440") shows under the field, nothing is saved, and the scan scoped to the dialog reports zero violations.

## Scenario: /projects/:id with the Flags column and a Jira bar has no WCAG A/AA violations

1. The administrator opens the fixture project's page: the milestone is linked to `E2E-4`, so the **Flags** column holds its key link "E2E-4 (opens in Jira)" and its flag icon, and the dashed Jira bar is drawn under the **Jira dates** toggle (on).
   - *Expected*: zero violations.

## Scenario: /roadmap with a Jira entry in the open flag panel has no WCAG A/AA violations

1. The administrator opens the roadmap (the program pick, stored before the load, narrows it to the fixture program) and presses **Show the N flags**.
   - *Expected*: the flag table lists "1 milestone deviates from Jira"; zero violations.

## Scenario: /deviations with the Acknowledge button and the status badges has no WCAG A/AA violations

1. The administrator opens `/deviations?projectId=<fixture project>&all=false` (the Open list) with the Filters panel open.
   - *Expected*: the milestone's row offers **Acknowledge E2E-4**; "Data from Jira" shows the connection's "Succeeded" badge (the fixture connection ran once, manually, in the beforeAll); the Status select reads Open; zero violations.

## Scenario: /deviations with an acknowledged item has no WCAG A/AA violations

1. The administrator presses **Acknowledge E2E-4** (the row leaves the Open list), then opens `/deviations?projectId=<fixture project>&acknowledged=true`.
   - *Expected*: the row reads "Acknowledged by …" and offers **Unacknowledge E2E-4**; the Status select reads Acknowledged; zero violations. A `finally` withdraws the acknowledgement through the API whatever happened, so the other scans meet the item open.

## Scenario: the telemetry panel's Sync section has no WCAG A/AA violations

1. The administrator opens the telemetry panel from the account menu and expands **Sync**.
   - *Expected*: the table "Sync status per connection" has the fixture connection's row with the state "Current"; zero violations.

(Each of the eleven has a `… in the dark scheme` twin with the dark scheme emulated: `<html>` carries the dark scheme and the scan reports zero violations.)

## Scenario: `<path>` has no WCAG A/AA violations in the dark scheme

1. The browser context emulates the dark colour scheme (Playwright `colorScheme: "dark"`; the
   app's `auto` default follows it). The admin signs in, opens `<path>` (the same list as above)
   and waits for its heading.
   - *Expected*: `<html>` carries `data-mantine-color-scheme="dark"` — the scan really runs in the
     dark palette — and an axe scan (same tags, `color-contrast` included) reports zero violations.

## Scenario: login screen has no WCAG A/AA violations in the dark scheme

1. An anonymous visitor with the dark scheme emulated opens `/login` and waits for the sign-in form.
   - *Expected*: the dark scheme is on `<html>` and the axe scan reports zero violations.

## Scenario: the open account menu has no WCAG A/AA violations

1. The admin signs in, opens `/`, waits for the Home heading and opens the header's account menu.
   - *Expected*: the menu (a portal'd `role="menu"`, in the DOM only while open) is visible and has settled at full opacity (axe measures contrast against a fade-in's partial opacity), its
     first item "English" holds the focus, the admin's email shows in the identity block (the identity query has landed: no "—" placeholders), `<html>` carries the light scheme and an axe scan of the whole page (same tags, `color-contrast` included) reports zero violations: the identity block, the language items,
     the theme switch, the Changelog link, the telemetry toggle and the red Sign out item.
2. The admin presses Escape.
   - *Expected*: the menu leaves the DOM and the focus returns to the account-menu trigger.

## Scenario: the open account menu has no WCAG A/AA violations in the dark scheme

1. The same with the dark scheme emulated.
   - *Expected*: `<html>` carries the dark scheme and the scan reports zero violations.

## Scenario: the app shell at a mobile width has no WCAG A/AA violations

1. The browser viewport is 390x844. The admin signs in, opens `/` and waits for the Home heading.
   - *Expected*: the header's burger is visible with the accessible name "Toggle navigation" (it is
     the only control that opens the nav drawer at this width), `<html>` carries the light scheme
     and an axe scan (same tags, `color-contrast` included) reports zero violations.

## Scenario: the app shell at a mobile width has no WCAG A/AA violations in the dark scheme

1. The same at 390x844 with the dark scheme emulated.
   - *Expected*: the burger is visible by name, `<html>` carries the dark scheme and the axe scan
     reports zero violations.

## Scenario: the hovered rows of the Users, Dependencies, Weekly load and Proposed schedule tables have no WCAG A/AA violations

1. The admin signs in and opens `/users`; the pointer rests on the seed administrator's row of the Users table (a data row, not a loading skeleton).
   - *Expected*: an axe scan (same tags, `color-contrast` included) reports zero violations. Mantine's hover background replaces the row's, and axe measures the computed styles, so the scan covers every ink of that row on the theme's hover tint.
2. The admin opens the fixture project's page and hovers the violated row of the Dependencies table (the red badge, dimmed text).
   - *Expected*: zero violations.
3. The admin opens the fixture team's page, expands the weekly figures and hovers the first week with an "Overloaded" verdict (orange text).
   - *Expected*: zero violations.
4. The admin opens the team page of the open-proposal world (a second copy of it, in 2042), proposes a schedule and hovers the move row whose Links cell reads "would violate" (the red ink).
   - *Expected*: zero violations. The tint is the theme's own, with no per-table opt-out; `web/src/theme.test.ts` chooses its two hexes so every table ink clears 4.5:1 on it and it stays visible against the row.

## Scenario: the hovered rows of the Users, Dependencies, Weekly load and Proposed schedule tables have no WCAG A/AA violations in the dark scheme

1. The same four hovers with the dark scheme emulated.
   - *Expected*: `<html>` carries the dark scheme and every scan reports zero violations.

## Scenario: /roadmap with a baseline picked has no WCAG A/AA violations

1. The admin signs in; the browser stores the fixture baseline as the timeline's baseline pick and the fixture program as the planning program pick, then opens `/roadmap` and waits for the Roadmap timeline.
   - *Expected*: the fixture project's link is visible, the Baseline picker shows the fixture baseline, at least one shadow bar (`data-tone="baseline"`) is attached, the baseline totals line (`role="note"`) is visible, `<html>` carries the light scheme and an axe scan (same tags, `color-contrast` included) reports zero violations.

## Scenario: /roadmap with a baseline picked has no WCAG A/AA violations in the dark scheme

1. The same with the dark scheme emulated.
   - *Expected*: the dark scheme is on `<html>` and the axe scan reports zero violations.

## Scenario: /programs with a baseline picked has no WCAG A/AA violations

1. The admin signs in with the same two stored picks, opens `/programs` and opens the fixture program's chevron.
   - *Expected*: the fixture project's link is visible, the Baseline picker shows the fixture baseline, a shadow bar is attached, the totals line (`role="note"`) is visible and the axe scan reports zero violations.

## Scenario: /programs with a baseline picked has no WCAG A/AA violations in the dark scheme

1. The same with the dark scheme emulated.
   - *Expected*: the dark scheme is on `<html>` and the axe scan reports zero violations.

## Scenario: /projects/:id with a baseline picked has no WCAG A/AA violations

1. The admin signs in with the stored picks and opens the fixture project's page.
   - *Expected*: the project heading and the Milestone timeline are visible, the Baseline picker shows the fixture baseline, a shadow bar is attached, the heading "Movement vs baseline <name>" is visible and the axe scan reports zero violations.

## Scenario: /projects/:id with a baseline picked has no WCAG A/AA violations in the dark scheme

1. The same with the dark scheme emulated.
   - *Expected*: the dark scheme is on `<html>` and the axe scan reports zero violations.

## Scenario: the open row menus of the Teams list, the Baselines list and the roadmap timeline have no WCAG A/AA violations

1. The fixture project is ranked through the API for the scan (and unranked again at the end, so the shared ranking is as the other specs expect it). The admin signs in, opens `/teams`, narrows the list to the fixture team with the Name filter and opens that row's "Operations for <team>" menu.
   - *Expected*: the menu is visible and has settled at full opacity (axe measures contrast against a fade-in's partial opacity), and an axe scan of the whole page reports zero violations: the dropdown holds only menu items (no focus placeholder), the red Delete item clears AA on the dropdown, and every item's accessible name contains its visible text. Escape closes the menu, the kebab that opened it has the focus again (a keyboard user is not sent back to the top of the document), and only then does the next menu open.
2. The admin opens `/baselines` and opens the fixture baseline's "Operations for <baseline>" menu (Rename, Delete).
   - *Expected*: the same: zero violations.
3. The admin opens `/roadmap` (narrowed by the program pick to the fixture program) and opens the fixture project's row menu (Move up, Move down, Move to top, Move to bottom, Unrank, the target-window items, Open project; the first four disabled on the single ranked row).
   - *Expected*: the same: zero violations.

## Scenario: the open row menus of the Teams list, the Baselines list and the roadmap timeline have no WCAG A/AA violations in the dark scheme

1. The same three menus with the dark scheme emulated.
   - *Expected*: `<html>` carries the dark scheme and every scan reports zero violations (the dropdown is dark-6; the destructive ink and its hover tint are the theme's dark tokens).

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
