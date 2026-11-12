# Web internals (read on demand)

How the `web/` SPA works, page by page in nav order: every page's route, data and query keys, write path, files and tests, plus the shell, the transport/session
layer, the shared list-page and Timeline wiring, i18n, the colour tokens and logo, and the changelog wiring. The binding rules (every never/must/always) live in
`web/CLAUDE.md`, whose "Pages (the map)" names the section of this doc that owns each page; the shared Gantt frame's reference is `timeline.md`. **Read the
section of the page you touch before changing it, and put a new page's mechanics here, never in `web/CLAUDE.md`.**

## Contents

**Foundation**

- [The shell and page chrome](#the-shell-and-page-chrome)
- [Quality gates and the build stamp](#quality-gates-and-the-build-stamp)
- [Transport and session layer](#transport-and-session-layer)
- [Error boundaries, chunk reload and toasts](#error-boundaries-chunk-reload-and-toasts)
- [Shared list-page and dialog mechanics](#shared-list-page-and-dialog-mechanics)
- [Timeline mechanics](#timeline-mechanics-componentstimelinetsx)

**Pages in nav order**

- [Home](#home-pageshometsx-110)
- [Plan](#plan-pagesplantsx)
- [Project view](#project-view-pagesprojectviewtsx)
- [Roadmap](#roadmap-pagesroadmaptsx)
- [Programs](#programs-pagesprogramstsx)
- [Baselines](#baselines-pagesbaselinestsx-pagesbaselinecomparetsx-v09)
- [Schedule proposals](#schedule-proposals-pagesscheduleproposalstsx-18)
- [Deviations, bindings and the Jira chips](#deviations-bindings-and-the-jira-chips-pagesdeviationstsx-v110)
- [Teams and the team page](#teams-and-the-team-page-pagesteamstsx-pagesteamdetailstsx-v050)
- [People](#people-pagespeopletsx-pagespersondetailstsx)
- [Public holidays](#public-holidays-pagespublicholidaystsx-v070)
- [Users, feature flags and permissions](#users-feature-flags-and-permissions-pagesuserscreateuseredituserchangepasswordfeatureflagsuserfeaturesuserpermissionstsx)
- [Jira connections](#jira-connections-pagesjiraconnectionstsx-pagesjiraconnectiondetailstsx-v110)
- [Flow connections](#flow-connections-pagesflowconnectionstsx-pagesflowconnectiondetailstsx-v150)
- [Changelog and app versioning](#changelog-and-app-versioning-pageschangelogtsx-srcchangelog)
- [The telemetry panel](#the-telemetry-panel-componentstelemetrytsx)

**Cross-cutting reference**

- [Internationalization](#internationalization-i18n)
- [Theming](#theming-tokens-tuple-overlays-logo)
- [Not yet ported](#not-yet-ported-port-dont-reinvent)
- [Storage keys, Web Locks and shared reference](#storage-keys-web-locks-and-shared-reference)

## The shell and page chrome

The shell is `Shell` in `App.tsx`: the sidebar (`NAV_SECTIONS`), the 48 px header, `AppShell.Main` around the `<Outlet />` and the telemetry aside. Rules: `web/CLAUDE.md` "Layout conventions".

**Navigation.** The nav model lives in `utils/navigation.ts`, shared by the sidebar and the command palette: `NAV_SECTIONS` — labelled, always-open sections
(currently Overview, Planning: Plan, Roadmap, Programs, Baselines and Deviations, and Administration: Teams, People, Public holidays (all readable by everyone),
Users, Feature flags, Jira, Flow) of `NavLeaf`s (the `label` is a typed i18n key; `adminOnly?` gates admin leaves, `keywords?` adds raw palette search terms for
a renamed page's old name, and `visibleSections(isAdmin())` drops an emptied section) — plus `ACCOUNT_NAV` (Change password, Changelog), which the header
`UserMenu` and the palette render and the sidebar never does. Sections are static captions (`role="group"` + `aria-label`), never toggles: every leaf is always
in the DOM, so tests and e2e address the links directly; leaf clicks close the mobile drawer; `activeNavPath` is the longest-prefix matcher over the leaves.
**The icon rail (Lettuce's):** a header `ActionIcon` beside the Burger (`appShell.toggleNav`, `data-expanded` while expanded) narrows the desktop navbar from
240 to 64px — `rail = navCollapsed && !opened`, remembered under `astrolabe.viewSettings.appShell.navCollapsed`; in rail mode each leaf is an icon-only
`NavLink` (`classes.railLink`) whose `aria-label` IS the label (so every by-name locator keeps working) inside a right-hand `Tooltip`, section captions become
hairline `Divider`s. The mobile overlay always shows full labels.

**The header and the palette.** The shell header is 48px: brand, the `CommandPalette` trigger, and the `UserMenu` (avatar → identity from `GET /users/{id}`
under the `["user", id]` key, language, theme as three `Menu.Item`s (Light / Dark / System; the chosen one carries `IconCheck` + `aria-current`, `closeMenuOnClick={false}` keeps the menu open: a SegmentedControl is a radiogroup, not allowed inside `role="menu"`, axe `aria-required-children`), Change password, Changelog with the what's-new badge, for an ADMIN a "Telemetry
panel" toggle, Sign out). The version stamp stays in the sidebar footer. **Focus on navigation**: `hooks/useFocusMainOnNavigation.ts` (called in the `Shell`)
focuses `#main-content` (`tabIndex={-1}`, ring suppressed in `index.css`, `preventScroll`) when the PATHNAME changes - never for a `?baseline=`/filter/sort
change or a same-path push, never on the first render (a fresh sign-in or reload leaves the document start; the skip link is the first Tab stop) - and leaves a
focus that is already inside main alone, so a page's own `autoFocus` wins in either mount order. **`components/CommandPalette.tsx`** wraps `@mantine/spotlight`
(pinned to the core version — keep every `@mantine/*` on one version) over a module-level store (`utils/commandPalette.ts`): the session's pages, plus an
ADMIN-only show/hide action for the telemetry panel. No `highlightQuery` — it splits labels into `<mark>` fragments that role/name locators cannot match.

**Page chrome.** Every page is a `Stack gap="md"` on the canvas starting with `components/PageHeader.tsx` (`title` → the `order={2}` heading tests locate,
`description?`, `backTo?`, right-aligned `actions?` — the ONE place a page's primary "New …" button lives — and a `toolbar?` row; No `Container` and no
page-wrapping `Paper`; widths come from `utils/layout.ts`: full-bleed lists, `Box maw={CONTENT_MAX_WIDTH}` for registry tables and the changelog,
`Paper withBorder p="xl" maw={FORM_MAX_WIDTH}` (left-aligned) for the simple field forms. The one spinner is `components/LoadingBlock.tsx` (`TableLoadingRow`
wraps it); `components/EditPageLoadState.tsx` is the edit pages' shared load-failure triage (centered loader, else a back-to-list alert); `EmptyState` takes the
Tabler icon COMPONENT and sizes it itself (an optional `hint` is the next step under the label). **One heading outline everywhere**: the `PageHeader` title is
the h2, a page's cards/sections are h3 (`<Title order={3} size="h4">` keeps the look), their inner blocks h4; and every `Table` has an accessible name
(`aria-label` — the words of the heading above it, or a `<area>.tableAria` key). Page tests pin the outline with `test/headings.ts`'s `headingOutline()`. **Tab
titles**: `PageHeader` (and `AuthCard` for the pages outside the shell) is the ONE owner of `document.title` through `hooks/usePageTitle.ts` —
`appShell.documentTitle` = "{{page}} · Astrolabe", the brand alone for Home or a blank title (a detail page's entity name only exists once loaded; its
load/failure states pass a static title). Mantine's `useDocumentTitle` does not restore on unmount, so `test/setup.ts` resets `document.title` after each test.

### Heading outline guard

`pages/headingOutline.test.tsx` renders every route read from `App.tsx` (via `?raw`, so a new route is covered
the moment it registers) under an ADMIN session with an empty API and asserts the outline starts at h2 and never
skips a level going down. A page whose real title needs loaded data passes a static `title` to
`EditPageLoadState`, so its load/failure state still opens with an h2 (TeamDetails).

## Quality gates and the build stamp

- **Quality gates (the frontend counterpart of the backend's detekt)**: `npm run lint` carries `eslint-plugin-sonarjs` (recommended), `eslint-plugin-jsx-a11y`
  (recommended; static accessibility rules, two file-scoped overrides) plus core size/complexity backstops — zero-findings gate; rule tuning lives in
  `eslint.config.js` ONLY, one commented override per deliberate idiom, and any inline `eslint-disable` needs a justifying comment. `npm run lint` runs with
  `--cache --cache-strategy content` (`web/.eslintcache`, gitignored; a warm run is ~0.6 s against ~12 s, CI restores the file between runs — `build-times.md`
  WHY 20); the config is not type-aware, so a per-file cache is sound, and a config change or an ESLint/node upgrade re-lints everything on its own.
  `npm run knip` is the dead-code gate (unused files/exports/dependencies; `knip.json` ignores the generated `schema.ts` and the `ajv` devDependency pinned only
  for `@stoplight/spectral-cli`'s resolution; `@mantine/dates` and `dayjs` have real consumers since the Plan page) — keep exports that only the declaring file
  uses un-exported, and delete what knip flags rather than ignoring it. **The API-contract gate**: `npm run lint:api` Spectral-lints the OpenAPI spec and
  `api-guidelines/examples/conformant.yaml` with `--fail-severity=warn`, through Astrolabe's local ruleset `web/spectral.astrolabe.yaml` (it `extends` the
  shared `api-guidelines/api-guidelines.spectral.yaml`, which is the other team's area and never edited; it switches off only the two registered-gap rules
  `x-sla`/`termsOfService`, each with its reason). A finding is fixed in the spec; a new local `off` needs an inapplicability comment, never a fixable finding;
  `npm run check:api` (`scripts/check-api.mjs`) regenerates the API types in memory and diffs them against the committed `src/api/schema.ts` — it must never
  overwrite that file, so `gen:api` stays the one command developers run to update it.
- **Build version stamp**: `vite.config.ts` injects `__APP_COMMIT__` (short sha, `+dirty` when the worktree has uncommitted changes) and `__APP_COMMIT_TIME__`
  (commit ISO timestamp) via `define`, declared in `src/vite-env.d.ts`. Env vars `GIT_SHA`/`GIT_COMMIT_TIME` override the local-git lookup — the Dockerfile's
  SPA stage sets them explicitly (its worktree never matches the index, so the dirty check would false-positive), and CI can do the same when building without
  `.git`. `src/components/VersionStamp.tsx` renders `v<APP_VERSION> · <sha> · <time>` at the bottom of the navbar (`App.tsx`) and under the login card
  (`components/AuthCard.tsx`).

- Types are regenerated with `npm run gen:api` (rules: `web/CLAUDE.md`); `openapi-typescript` is installed with `--legacy-peer-deps` because its declared peer
  is TS `^5` while the scaffold uses TS 6 (the generated output is compatible); after a from-scratch `npm install`, use `npm install --legacy-peer-deps`.

## Transport and session layer

The rules (never collapse a definitive and a transient failure, attach `timeoutSignal()`, the session boundary) are in `web/CLAUDE.md` "The typed API layer";
this is the machinery. The OpenAPI spec is hand-maintained, not generated from routes; Swagger UI is at `http://localhost:8086/openapi` (dev); the layer is
small hand-written modules, and the types come from the generated `schema.ts` (the lightweight pairing of `openapi-typescript` (types only) + hand-written fetch
is intentional; Orval/Kiota are not used).

### `http.ts` — the transport's refresh internals

- **`http.ts`** (transport): `authedFetch()` with the **single-flighted silent refresh** — on a
  401 it exchanges the stored refresh token once (concurrent 401s from the same session share one
  in-flight `/refresh` call) and retries once; a DEFINITIVE rejection (no refresh token, or
  401/403 from the server) clears the originating session and signs out only if that session is
  still current, while a TRANSIENT failure (network/timeout/5xx/429/malformed body) keeps the
  session so a later retry can succeed — **never collapse the two** (a network blip must not
  erase a valid session). Stale requests and refresh completions must not publish credentials,
  clear a newer login or retry across session identities. **The server rotates the refresh token** (each works once, plus a
  60 s server-side replay grace for a lost response; after that a replay is a 401), so two tabs on one session can race on
  `/refresh`: `doRefresh` serialises them with a Web Lock (`astrolabe.auth.refresh`, where the browser has `navigator.locks`; a lock
  that cannot be acquired falls back to an unserialised refresh) and, inside it and again after a 401/403, adopts a pair already
  stored by another tab (same session identity, different refresh token) instead of replaying or clearing; a different login (new identity) is never adopted.
  **Why a 401 can now come at any time:** the server checks every access token against the user row per request (`security.md` "JWT model"), so a delete, a
  demotion/promotion, a password change or a logout elsewhere turns the NEXT request into a 401 (one text). The transport needs no special case: the 401 ->
  silent refresh -> retry path handles all of them - a role change refreshes successfully into the NEW roles (`persistRefreshedSession` republishes them and
  `notifyAuthChange` re-renders the nav and `RequireAdmin`, pinned in `http.test.ts`), a delete or password change makes the refresh a DEFINITIVE rejection and
  signs the user out. `ApiError` (status + parsed body; read
  RFC 7807 fields via the `detail`/`instance`/`type` getters, never hand-cast `err.body`), and the two
  standard wrapper shapes **`jsonRequest<T>()`/`voidRequest()`** every ordinary endpoint wrapper
  uses, plus **`buildQuery()`** — the query-string builder behind the list wrappers (skips
  null/undefined/""; `false` and `0` ARE sent, so an omit-when-false param is passed as
  `value || undefined` at the call site). Reach for the raw `authedFetch`/`safeJson` primitives
  only when a wrapper genuinely inspects the Response. Every transport fetch carries
  `timeoutSignal()` (30 s, feature-detected for happy-dom) — a hung request rejects with a
  `TimeoutError` DOMException instead of pending forever; new `fetch` call sites in `api/` must
  attach it.

### `session.ts`

- **`session.ts`**: token/roles/userId storage under the `astrolabe.auth.*` localStorage keys, written
  by `persistSession(LoginResponse)` on login/MFA and conditionally by `persistRefreshedSession`
  on refresh, and the render-time accessors (`isAdmin()`, `getUserId()`, …). Components whose
  controls or queries depend on ADMIN use `useAdmin()` from `auth.tsx`; it subscribes to role
  changes from silent refresh and other tabs. A random stored identity distinguishes sign-ins,
  while credential snapshots guard refresh publication; renewing tokens preserves the logical
  session so staggered 401s can reuse the new token.

### Session boundary

- **Session boundary** (`components/SessionBoundary.tsx` + `utils/sessionQueryCache.ts`): bind the
  root `QueryClient` to logical session identity changes, and key the mounted app subtree by that
  identity. A different sign-in, definitive automatic sign-out, explicit sign-out, or a change
  from another tab must synchronously cancel and remove caller-scoped query data and discard
  mounted form/mutation results before the next account renders; an access/refresh token rotation
  within the same identity must retain them. Keep this at the session boundary rather than
  clearing individual page keys, because user/team/account queries all contain caller-specific
  projections. Late requests from the previous identity must not repopulate the new account's UI
  or cache.

### Sign-out and the return destination

Explicit sign-out opens `/login` without a saved return destination, so the next sign-in opens
Home even when a different account signs in. Anonymous access to a protected link still preserves
its path, query and hash. Test logout navigation with the real route guards from a non-home page;
a root-only menu test cannot detect a stale return destination. Reading the signed-out notice
during render must be side-effect free. Acknowledge it only after the login page commits, so a
suspended or retried render cannot discard the notice. The flag carries a reason (`SignedOutReason` in `auth.tsx`: `sessionEnded`, the default, or
`passwordChanged`; `pendingSignedOut()` reads it, `consumeSignedOut()` clears it) and `pages/Login.tsx` picks the notice from it. **The self password change
signs the device out explicitly** (`pages/ChangePassword.tsx`): the PUT bumps the account's credential revision, which ends every access and refresh token
including this device's, so after the success toast the page runs `clearSession()`, `flagSignedOut("passwordChanged")` and
`navigate("/login", { replace: true })` (the notice reads "Your password was changed. Sign in with your new password."). No `/logout` call - nothing is left to
revoke, and the stale access token would only 401; no broadcast, for the same reason as `UserMenu`'s sign-out.

### Password reset (confirm link)

`pages/ResetPassword.tsx` only REQUESTS a reset (a uniform 202: the server emails a single-use link and changes nothing). The link lands on
`pages/ConfirmPasswordReset.tsx` at `/reset-password/confirm#token=…`, which is NOT behind `RedirectIfAuthed` (a signed-in device may finish a reset). The token
travels in the URL fragment, so it never reaches a server log or a Referer: the page reads it once into component state, strips the fragment and any query from
the address bar and history (`navigate(…, { replace: true })`), keeps it in memory only (never storage) and sends it to nothing but `confirmPasswordReset` (a
plain `fetch`, never `authedFetch`, so it can never refresh or retry a session). Loading the page consumes nothing; the form shows for any well-formed
43-character token and an unusable one is learned at submit (401: the token is dropped and "Request another reset link" shows; 429, 400 and network failures
keep it for a retry). The new-password rule is `newPasswordValidation` (`utils/userForm.ts`), shared with `ChangePassword.tsx`. On success the page runs
`clearSession()`, `queryClient.clear()` and `notifyAuthChange()` and shows the teal notice: no `/logout` call (the reset bumped the credential revision, so
nothing is left to revoke) and no return destination.

### `auth.ts`

- **`auth.ts`**: login + the MFA exchange, self-service password reset, and logout. `logout()` is best-effort — local credentials are cleared immediately,
  before awaiting the revoke POST for the captured token pair; a delayed completion never clears a later login, and the function never throws.

## Error boundaries, chunk reload and toasts

The rules are in `web/CLAUDE.md` "Error handling"; the wiring:

- **ErrorBoundary** (`components/ErrorBoundary.tsx`): `RouteErrorBoundary` wraps the `<Outlet />` inside `AppShell.Main` (header/nav survive; keyed by
  `location.pathname`, so navigating anywhere recovers), and a plain `ErrorBoundary` in `main.tsx` is the last resort for shell crashes (it only catches crashes
  of the shell itself). Per-page boundaries are not added — the two mounts are the model.
- **Catch-all 404**: `pages/NotFound.tsx` is the LAST `path="*"` child of the Shell route; new routes go above it.
- **Chunk-load recovery**: `main.tsx` listens for `vite:preloadError` (a redeploy 404s the old hashed chunks) and reloads once, rate-limited via sessionStorage
  (`astrolabe.chunkReloadedAt`, max one reload/minute) so a genuinely missing chunk falls through to the ErrorBoundary instead of looping.
- **Query retry policy**: the `QueryClient` in `main.tsx` uses `shouldRetryQuery` (`api/http.ts`) — a 4xx is never retried (the answer won't change; retrying
  only delays the error UI), at most two retries for transient failures.
- **Messages**: `error.message` is the internal `API <status>` / the browser's "Failed to fetch"; statuses map to i18n keys via the shared mappers in
  `utils/saveError.ts`: `saveErrorMessage(err, t, keys)` for mutations (per-status keys + a `failed` fallback) and `loadErrorMessage(err, t)` for list loads. A
  failed QUERY renders through `components/ErrorAlert.tsx` (`error`, optional `title`), a form/action failure (an already-mapped string) through
  `components/FormErrorAlert.tsx`.
- **Toasts**: the `@mantine/notifications` host is mounted in `main.tsx` (top-center, autoClose 2500, limit 3 — deliberately not in App, so unit tests never
  mount it; top-center because bottom-right would cover `PaginationBar` and form footers, top-right the header cluster). `showSuccessToast(t("<area>.toast.*"))`
  in `utils/toast.tsx` is the only writer (green; the close X's accessible name, `common.action.closeNotification`, is set there too, at show time).

## Shared list-page and dialog mechanics

The template and its rules: `web/CLAUDE.md` "Shared list-page building blocks". The pieces behind them, copied from Lettuce (`pages/Users.tsx` is the reference page):

- **Chrome**: `FilterPanel` (collapsed by default, persisted, active-count badge) + `ClearableTextInput` for freetext filters (debounced); `SortHeader` renders
  its OWN `Table.Th` (so the sort state lands as `aria-sort` on the header cell — don't wrap it in another Th); `TableLoadingRow` (`isLoading && !data`) / rows
  / `EmptyState` (`!isError`) triage in the tbody; a `color="red" variant="light"` Alert with `loadErrorMessage` ABOVE the table on error; `PaginationBar`
  below.
- **Delete**: `useDeleteConfirm` + `ConfirmDeleteModal` — the hook owns modal state and the success toast, the page owns cache refresh. For mutations while a
  list remains mounted, use `refreshQueriesAfterMutation(queryClient, ["area"], ...)` from `utils/queryRefresh.ts` after success. It cancels all affected query
  groups before invalidating them: a newly keyed initial fetch has no cached data even when `keepPreviousData` displays rows, so default invalidation alone may
  reuse a pre-mutation response. Keep refresh out of failed mutation paths.
- **Focus after a successful delete**: `useDeleteConfirm` takes `focusAfterDelete` (required): the page's `PageHeader` `titleRef` (the title is `tabIndex={-1}`,
  never a tab stop; `index.css` draws the accent ring on `:focus-visible`), a section's own h3 ref, or `null` where the delete navigates away
  (`useFocusMainOnNavigation` owns the focus; the hook unmounts with the page, so they never fight). The kebab and the dialog's Delete button are both gone, and
  the browser would leave the focus on `body`; the hook tries the target at every render and when the modal has exited (`ConfirmDeleteModal` wires
  `onExitTransitionEnd`; the hook keeps looking for up to half a second while the leaving dialog still holds the focus) by one rule: focus on `body` -> take it,
  inside a `[role="dialog"]` (still fading) or a `[role="menu"]` (Mantine's return focus puts it back on the menu item that opened the dialog, which stays mounted while its dropdown fades, about 150 ms, and then drops it to `body`) -> wait, anywhere else -> leave; the predicate is `utils/focusTransit.ts` `isFocusInTransit`, shared with `useDialogFocus`. A failed delete never arms it (the modal stays open with its error). **A cancel**
  (Escape, Cancel, X, click outside) goes through the same rule: a dialog opened from a row menu has lost its opener (the unmounted menu item), so
  `requestDelete` takes the menu's trigger from the shared `utils/menuOpener.ts` memory (`RowActionsMenu` remembers the kebab on a click inside its menu; it
  expires at the end of the click) and a focus left on `body` returns to that kebab if still connected, else to the same target; a focus anywhere else is left
  alone. **The 1.13.1 fix (history):** until then only a focus inside a dialog counted as in transit, so a list render (the debounced filter's request) in
  the window between Mantine's return focus (the menu item) and the dropdown's unmount dropped the pending move and the kebab lost the focus; three CI
  failures were the only sighting until a browser repro on the unfixed build failed 48 of 50 runs (a list request fired inside the closing window; a control
  without the request passed 20 of 20). `useDeleteConfirm.focus.test.tsx` and `useDialogFocus.test.tsx` pin it (the first was proven red on master).
- **`ConfirmActionModal`** is the non-destructive sibling (Lettuce's, ported with the feature-flags bulk actions) — a message plus a neutral cancel and a
  confirm button whose `loading` blocks cancel/close while the action runs; labels arrive already translated.
- **An entity's NAME is the way into its detail page** — a `RouterLink` `Anchor` with an interpolated accessible name (`common.action.editAria` = "Edit
  {{name}}", or an area-specific `openAria`), which is what tests and e2e locate. A real link, not an onClick: cmd/middle-click opens a tab and it takes
  keyboard focus. Route families are spelled out ONCE in `utils/<area>Links.ts` — never hand-assemble a URL.
- Row action buttons carry interpolated aria-labels (`<area>.editAria` etc.) — unit tests and e2e locate by them; table tests query cells by **text**, not
  `cell` role names. **Row actions**: a row with more than two actions bundles them under `components/RowActionsMenu.tsx` — an icon-only kebab whose accessible
  name is `common.table.operationsAria` ("Operations for {{name}}"; items are plain `menuitem`s, only one row's menu is open at a time); a per-row `Switch`
  (Feature flags) is state, not an action. A menu opens with the focus on its FIRST item (the theme drops Mantine's focus placeholder, which fails axe
  `aria-required-children`), so the next ArrowDown reaches the second; the item's tint shows for the pointer and for a keyboard focus only. Tab or Shift+Tab
  closes an open menu and moves on from its trigger (`hooks/useMenuTabExit.ts`; Mantine's trap would swallow the key; menu items are `tabindex="-1"`, so
  the first Tab leaves, including the account menu's theme items); every menu is items only, so the hook has no inner-Tab-stop branch (a menu that ever needs its own tabbable controls adds one). A destructive item (Delete, Sign out) is `components/DestructiveMenuItem.tsx`, never
  `Menu.Item color="red"` (red-6 is 3.3:1 on the white dropdown); an item's `aria-label` must contain its visible text ("Move to top: {{name}}", not "Move
  {{name}} to top": axe `label-content-name-mismatch`). **A dialog mounted with `opened` already true (`{editor && <XModal ... />}`) calls
  `useDialogFocus(open)`** in its owner (`hooks/useDialogFocus.ts`): Mantine records no opener for it, so without the hook the focus lands on `body`. Focus
  returns to the opener when it closes (the kebab for a row-menu item, else the button that held the focus); for 5 seconds after that a refetch cannot lose it
  (a focus blurred to `body` by a row moving in the DOM goes back to the opener, or to `#main-content` if the opener is gone; a focus parked in a closing
  menu or dialog is in transit and does not end the watch); a dialog that opens only after an
  await wraps the awaited promise in the returned `claim(...)` (Teams' Edit). **The two paths the 1.13.1 review left open are settled (after 1.13.4,
  `useDialogFocus.menu.test.tsx`: the real `RowActionsMenu` + Mantine `Modal` harness).** (A) `menuOpener.ts`'s `setTimeout(0)` expiry cannot beat the hook's
  effect: the click is a discrete event, React commits it and flushes the passive effect before any timer; the kebab-return tests (click, Escape, keyboard)
  passed 100 of 100 shuffled runs and never failed, so no change was needed and the tests are the pin. (B) Reproduced: within the 5 s watch, another row's
  kebab and an action that dropped the focus to `body` (its row removed or re-sorted) was answered at the next render with the FIRST kebab. Fixed: while
  the dialog is closed the hook listens to `focusin` (a no-op while no opener is held) and ends the watch when the focus lands anywhere but the opener, a dialog or the opener's own
  menu (`isChoiceAwayFrom`), so the second row's kebab ends it at once. The next render finds nothing to restore. Accepted: a focus inside another `[role="dialog"]` (a palette) does not end the watch.

### Registries and forms

The small ADMIN-curated registries (Teams and People today; more arrive with the planning domain) compose `useRegistryListControls` for their persisted name
filter, debounce and paged sort, and `RegistryListTable` for the common load/error/empty/pagination states. Each page owns its query key and parameters, extra
filters, columns, row actions and mutation refresh prefixes. Their editors (e.g. `components/TeamEditorModal.tsx`; `PersonEditorModal.tsx` has no description,
so it composes its own fields) share the `RegistryMetadataFields` (name + description, with `utils/charCount.tsx`'s "123 / 4000" counter) and
`RegistryEditorActions` (save-error alert + cancel/submit footer) components; form rules (`utils/formRules.ts`'s shared `nameRule`/`descriptionRule`),
submit/conflict handling and any parent/target fields stay local. Keep each registry's field limits explicit and mirrored from the server's own validation
(`infra/validation/Text.kt`'s `requireNameAndDescription`).

- Shared vocabulary in `utils/<area>Form.ts`: the `<Area>FormValues` type, length constants mirroring the server's, a `<area>FormValidation(t)` factory (rules
  identical to the server's — keep them in sync), and `toRequest`/`fromResponse` mappers. The field block lives in `components/<Area>FormFields.tsx`; the pages
  own submit/error/navigation.
- Edit prefills via **`form.initialize(...)` guarded by `!form.initialized` during render** — never a `useEffect`. Submit is a plain async fn with local
  `submitting`/`error` state wrapped by `form.onSubmit`; success → `invalidateQueries` (list + detail) → `showSuccessToast` →
  `navigate(list, { replace: true })`; failure → `saveErrorMessage` into an inline Alert.
- **Widths**: `Paper withBorder p="xl" maw={FORM_MAX_WIDTH}` under a `PageHeader` (with `backTo` to the list) for simple field forms — left-aligned, never a centred `Container`.

## Timeline mechanics (`components/Timeline*.tsx`)

The binding reference is `.claude/docs/timeline.md` (coordinate model, data contract, arrows, load strip, drag/resize/keyboard contract, row drag, draw gesture,
accessibility model, virtualisation, holidays, idle bands, critical path, proposal preview, baseline overlay, Jira markers, measured figures). The rules a page
follows: `web/CLAUDE.md` "Per-feature rules". What the pages see of the component, with the `timeline.md` section that owns each mechanism:

- **Boundary.** `Timeline` takes rows, bars and bands as `TimelineRowData[]` (`utils/timelineModel.ts`); the page builds the `scale` (`makeScale(zoom, range)`,
  `defaultRange`) and keeps the range stable across edits. `editable` comes from the view's `can` flags, and a drop is only `onSchedule(id, start, end)` on the
  page's `TimelineDndContext` — the page's write path owns the optimistic update, the revision and the rollback. Dates are ISO strings at the boundary; layout
  is `utils/timelineScale.ts` (28/8/3/1 px per day at week/month/quarter/year), drag arithmetic is `utils/timelineDrag.ts` — both pure and unit-tested. It is a
  `role="grid"` with ONE roving tab stop (`useRovingGrid`; a left cell that holds its own focusable is a function cell that spreads the stop on it), rows
  virtualised with TanStack Virtual only above `virtualizeFrom` (80). Keyboard: Space/Enter picks up a bar or edge handle, ←/→ a day, Shift a week, Space drops,
  Escape cancels, announced in the UI language (`timeline.announce.*`); the page ships the explicit buttons (Edit schedule…, the tray's Schedule). Pointer drags
  are not unit-tested (happy-dom has no layout; `Timeline.test.tsx` feeds the wrapped `DndContext` its events) — the e2e does them. Reference: "Coordinate
  model", "Data contract", "Drag, resize and keyboard contract", "Accessibility model", "Virtualisation".
- **Zooms, the window tone, draw and `focusRow` (v0.6).** `Timeline` takes `zooms` (default `MILESTONE_ZOOMS` = week/month/quarter, which the project and team
  pages keep; the plan pages pass `PLAN_ZOOMS` = month/quarter/year, Year = 1 px per day, year header over quarter cells) and validates a stored zoom against
  its own list (`isOneOf(MILESTONE_ZOOMS)`). `tone: "window"` is the one tone an EDITABLE bar honours (a target window as a bar: the band look over the whole
  row height, handles and keyboard as any editable bar). `TimelineRowData.draw = {barId, label}` mounts a pointer-only, `aria-hidden` `TimelineDrawSurface`
  behind the row's bars: a drag across the empty stretch is the fifth drag kind `draw`, previewed as a window-toned ghost and proposed through the SAME
  `onSchedule(barId, start, end)` as a bar move (`drawOutcome(anchorDay, pointerDay)`; the page's dialog is the keyboard/touch path). `ref` exposes
  `focusRow(rowId)` (focus + reveal a row header, mounted or not). Reference: "The draw gesture", "Bar tones", "Accessibility model".
- **Bands** (v0.7 adds a third tone): `TimelineBandData.tone` is `window` (quiet gray, dashed edges), `drift` (orange) or `idle` (a diagonal gray hatch, no
  edges; the project and team pages' idle gaps); every band carries `data-band-tone`, is `aria-hidden` and its facts live in the page's text. Reference: "Idle
  bands".
- **Tones and arrows (v0.4).** A read-only bar may carry `tone: "ghost"` (another project's endpoint: faint, dashed), `"summary"` (the project's own span:
  hollow), since v0.8 `"proposal"` (a PROPOSED span of the team page's schedule proposal: hollow with a dashed 2 px text-colour outline, no new hue), since v0.9
  `"baseline"` (the span a picked baseline froze: a 5 px SHADOW bar along the bottom of the row, pointer-transparent, no hue) or, since 1.3, `"jira"` (the dates
  Jira holds: a 5 px dashed outline along the TOP of the row, pointer-transparent). Dependency arrows are `TimelineArrowData[]` (`from`/`to`
  `{row, bar, kind: START|END}`, `violated`, `label`) drawn by `components/TimelineArrows.tsx` through the `overlay={(geometry) => …}` slot — decorative
  (`aria-hidden`; the page's table is the accessible surface), gray, RED when `violated`, only for mounted rows and from committed dates. Tests read
  `data-arrow`/`data-violated`/`data-tone`, never colour. Reference: "Arrows", "The proposal preview", "The baseline overlay (v0.9.0)", "The Jira markers
  (1.3)".
- **Row drag (v0.5).** The same one `TimelineDndContext` learns a fourth drag kind, `kind: "row"` (no `@dnd-kit/sortable`: no row ever gets a transform, a
  `DragOverlay` card plus an insertion line show the slot, computed from the live pointer against the body-wide row zone, so it reaches unmounted rows). It is
  the timeline's variant of the Roadmap rule: a pointer-only, `aria-hidden` handle (one cell, one roving stop) plus the row menu as the keyboard path, announced
  by dnd-kit's region (`timeline.announce.*Row`); the page passes `onReorder(id, slot) → boolean` (absent = no reordering). Reference: "Row drag".
- **Public holidays (v0.7).** `holidays?: {date, name}[]` (the dictionary, any range; every page passes `useHolidays()`): a holiday working day is hatched like
  a weekend at week and month zoom (`trackBackground` = a holiday `linear-gradient` layer over the weekend layer, the same `--timeline-hatch` ink, one
  `backgroundImage`), its week-zoom header day cell is tinted and named in its `title` ("Public holiday: {{name}}", `data-holiday`), and a `VisuallyHidden`
  paragraph after the toolbar lists the ones in view ("Public holidays shown: 2027-01-06 …") because the header and tracks are `aria-hidden`. Decoration only:
  the server decides every figure. Reference: "Public holidays".
- **The load strip (v0.5).** The optional `strip={{label, render: (scale) => …}}` prop adds a sticky THIRD header row (36 px, `aria-hidden`, a visible caption)
  under the date cells; `components/TimelineLoadStrip.tsx` draws the weekly load into it from a local `LoadWeek[]` (the server's week row; the page maps its
  view onto it): one cell per ISO week at `scale.xOf(weekStart)`, a column against the capacity line (orange past it), a figure ("8.5 / 14"), a dashed WIP chip
  (a dot at quarter zoom) — the overload and the WIP warning differ by SHAPE, both orange. A week with no capacity (`null`) has only its dimmed figure, never
  flagged. Decorative: the page's weekly table is the accessible surface; tests read `data-week`/`data-overloaded`/`data-wip-exceeded`. The header becomes
  `headerHeight(hasStrip)` tall and every consumer follows it (`--timeline-head`); with no strip nothing changes. Reference: "The load strip".

### Wiring notes

The non-obvious wiring: (1) `Timeline` reads `useDndContext().active` to suspend its own arrow handling while a bar is held (dnd-kit's keyboard sensor listens
on the document, AFTER React's handlers) and registers the track drop zone with `useDroppable` — both work
without a `DndContext` (read-only timelines need none). (2) `TimelineDndContext` passes its handlers as `DndContext` props; dnd-kit calls those BEFORE the
monitor that feeds `accessibility.announcements`, so the handlers stash the latest outcome in refs and the announcements only read them. (3) A resize redraws
from the context's preview (`PreviewContext`); a move is a CSS translate of the bar wrapper from `useDraggable` (the context's modifiers hold it to its row and
snap it to days). The edge handles sit outside the bar with a constant width per zoom so a resize never re-measures the dragged node. (4) `useDraggable` results
are destructured in `TimelineBar` because the React-compiler lint (`react-hooks/refs`) flags field reads off an object that carries a ref. (5) The virtualiser's
`useVirtualizer` carries the one justified `react-hooks/incompatible-library` disable. (6) The track drop zone's droppable `data` carries `visibleBounds()` (the
scroller's live rectangle minus the sticky columns and header) and `zoneLeft()` (its element's live left edge) — `outcomeOf` combines them with the pointer
`TimelineDndContext` tracks itself during a tray drag, so a tray item released over the tray below or the left columns is not scheduled and a scrolled grid
gives the right day (dnd-kit's `delta` is wrong for it, `timeline.md`). (7) A pending "focus the row once it mounts" wish is cleared by another key, a focus
elsewhere or a manual scroll. (8) Tests stub the scroller size with `HTMLElement.prototype.clientWidth/clientHeight` (happy-dom lays nothing out; the
virtualiser reads them), restore the original descriptors in a file-level `afterEach` and wait with `waitFor`, never a real sleep (the suite is
`isolate: false`); the keyboard-sensor test fakes only `setTimeout` for dnd-kit's zero-delay listener attach. (9) **Arrows (v0.4):** `TimelineArrows` renders a
fragment (the `<defs>` with two `<marker>`s of FIXED ids, then one `<path>` per kept arrow) inside the Timeline's own `aria-hidden` svg; the marker colours are
CSS classes (`timelineArrowHead*`), because a marker's content inherits from the marker's ancestors, not from the path that references it, and the theme tokens
`--timeline-arrow`/`--timeline-violation` live on `.timelineGrid`, an ancestor of both. `geometry.rowIndexOf` (a lazily built id→index map) lets the arrow input
name rows by `TimelineRowData.id`, so a re-sorted page never re-indexes its arrows. The route math (`utils/timelineArrows.ts`) is pure; the tests feed a
hand-built geometry, and `Timeline.test.tsx` covers the plain and the virtual path (the unmounted end of an arrow is positioned from data). (10) **The header
height (v0.5 load strip):** the sticky header is `headerHeight(hasStrip)` = 56 px, or 92 px with a `strip` (`STRIP_HEIGHT` 36). Its five consumers all follow
ONE number computed in `Timeline.tsx`: the track drop zone's `visibleBounds().top` (`hooks/useTimelineDropZones.ts`), the virtualiser's `scrollMargin` and `scrollPaddingStart`, `revealFocused`'s
`clearTop` (`utils/timelineReveal.ts`), and the two CSS `scroll-margin-top`s (`.timelineCell`, `.timelineBarBody`), which read `var(--timeline-head)` set on the grid beside
`--timeline-left`. A new sticky part adds to `headerHeight()`, never to a literal; `Timeline.test.tsx` "the load strip" pins the value of `--timeline-head` and
the drop zone's top, `revealFocused`'s `clearTop` and the virtualiser's `scrollMargin` (through the mounted window), with and without a strip. NOT pinned
(happy-dom has no layout and does not process CSS modules): `scrollPaddingStart` (where `scrollToIndex` lands a row) and the two CSS `var(--timeline-head)`
uses; the real-browser proof is the team page's e2e/manual pass (C5). The strip is a header row, so the geometry's origin (the top of the first body row) and
the arrows do not move. (11) **Public holidays (v0.7):** `Timeline` takes `holidays?` and builds ONE epoch-day map per render (`holidayDayMap`); the same map
feeds the row hatch (`trackBackground`: the holiday gradient layer over the weekend layer, ONE `backgroundImage` string computed once per render and handed down
as `hatch`), the header (`headerRows(scale, map)` puts `holiday` on the day cells; `HeaderCells` renders the `title` and `data-holiday`) and the visually hidden
"Public holidays shown" paragraph (`holidaysShown`). The pages never touch any of it: they pass `useHolidays()` straight through. happy-dom keeps gradient
strings in `style.backgroundImage`, so the tests count `gradient(` occurrences on the body row's LAST `gridcell` (its left cells are gridcells too).

## Home (`pages/Home.tsx`, 1.10)

The landing at `/`, for everyone: `PageHeader` (title "Astrolabe", the intro as its description) and a `SimpleGrid` of three `Paper withBorder` cards - Plan, Roadmap, Deviations - each an h3
(the nav's own label, `appShell.nav.*`), the nav's icon, one dimmed sentence and a real `RouterLink` `Anchor` ("Open the plan", "Open the roadmap", "Open the deviations": distinct from the
sidebar's names, so a by-name locator never meets two links) to `planPath` / `roadmapPath` / `deviationsPath`. The outline is `[[2,"Astrolabe"],[3,"Plan"],[3,"Roadmap"],[3,"Deviations"]]`; the other pages
stay in the nav only, and the tab title stays the brand alone (`usePageTitle` of the `home.title`).

**The only live figures are the OPEN deviation counts**, in the Deviations card (`hooks/useOpenDeviationCounts.ts`): `GET /views/deviations?acknowledged=true` and `GET /views/capacity-deviations?acknowledged=true`,
keyed `["jira","deviations","totals"]` and `["flow","deviations","totals"]` (under the prefixes the existing refresh helpers invalidate), `staleTime` 60 s. Why `acknowledged=true`: both views compute `totals` over
"every filter but the acknowledgement state" and count the OPEN rows, so the same totals arrive while the body lists only the acknowledged items (typically a few KB against up to 700 KB for the default list of up to 2,000
items; the cost grows with the acknowledgements, so a plan with nearly everything acknowledged pays close to the full list, bounded by `staleTime` 60 s). **Measured (1.10 release, NON-BINDING)** on the throwaway stack with the sample plan, nothing bound on the Jira side and the seed admin as the caller (loopback `curl`, median of 10 after warm-ups): `GET /views/deviations?acknowledged=true` 11 ms / 715 B and `GET /views/capacity-deviations?acknowledged=true` 6 ms / 137 B, against 13 ms / 2,010 B and 5 ms / 137 B for the default lists. This does not cover a heavily bound or acknowledged plan, where the cost grows as described above (the Jira computation is about 50 ms for 1,100 bindings, `timeline.md` "Measured figures (1.3)"). No new endpoint, no plan or roadmap read. Per source, ONE line (label "Open differences from Jira:" / "Open capacity differences from Flow:" and the orange warnings / gray infos badges of the Deviations page; a zero badge is omitted)
- shown only for a source whose view lists a connection AND whose count is positive. **No claim at zero** (no "nothing open", `web/CLAUDE.md` "Deviations wording"): zero, no connection and loading all show nothing.
A failed read is the inline `ErrorAlert` (title `home.deviations.loadFailed`) inside the Deviations card, the other source's line still shows and the links never depend on either read.

**Tests:** `Home.test.tsx` pins the outline, the three hrefs, both requests (`acknowledged=true`), the badges, the silence at zero / without a connection and the alert. `App.test.tsx` renders `/` about twenty times, so its
blanket fetch stubs answer the two Home URLs with their own empty documents (`homeViews`): a paged envelope is not a deviation view. `pages/headingOutline.test.tsx`'s `emptyApi` answers them with a 404 and the
outline holds with the alert shown.

## Plan (`pages/Plan.tsx`)

The plan tree (V12 + `GET /views/plan`), a read for everyone whose actions are gated by the view's `can` flags (`utils/planActions.ts` is the row-to-page
callback contract). `Plan.tsx` owns the query (`["plan","view"]`), which editor is open (`EditorState`: work stream / program under its stream / project under
its program), one `useDeleteConfirm` for all three delete levels (the confirm texts come from the `DELETE_TEXT` map, a 409 says "delete the children first") and
the close/reopen mutation; every success refreshes `["plan"]` through `refreshQueriesAfterMutation`. A stream's menu (`can.edit`) also has **Import from Jira…** (1.10: the connections read from the deviations view only after the click) and a LINKED program's menu (`can.createProject`) **Import from Jira…** rooted at it (1.14); both live in `hooks/usePlanJiraImport.ts` ("The import modal" under the Jira sections). **Close / reopen** is a one-step menu action on a stream:
the full-replace `PUT /work-streams/{id}` of the row as it stands with only `endDate` changed (today, never before the start / `null`) — a closed stream (end
date set) still shows "New program" and still takes children. The stream editor's End date field does the same with a typed date, and clearing it reopens.

**The project editor has two independently permitted parts**, because the server guards them differently: the fields (`PUT /projects/{id}`, `can.edit`) and the
target window (`PUT /projects/{id}/target-window`, `can.editTargetWindow` — a project's OWN owner is deliberately not enough; a roadmap editor has the window
but not the fields). A disabled part still shows its current values with a note. Save sends only the parts that are enabled AND differ from what the server last
accepted (held in state, updated after each successful PUT, so a retry after the second PUT failed never repeats the first); nothing changed closes the modal
without a request. A NEW project carries its window in the create body (the creator is always a window editor). The window is both dates or neither (validated
in `utils/planForm.ts`, the server's 400 is the backstop).

**Route and editors.** `/plan` (nav section Planning, everyone) renders `GET /views/plan` under `["plan", "view"]` as the tree work stream (h3,
`PlanWorkStreamSection`) → program (h4, `PlanProgramBlock`) → projects table. What a row offers comes from the view's `can:{}` flags, which the server computes
with the guards' own arithmetic; the server's 403/409/400 reach the modals through `planSaveErrorMessage`/`saveErrorMessage` (a name clash marks the name field,
everything else is an inline alert). The three editors (`WorkStreamEditorModal`, `ProgramEditorModal`, `ProjectEditorModal`) share `PlanNodeFields` (name,
description, owner via `PersonSelect` — required on every node); the project editor enables its fields by `can.edit` and its target window by
`can.editTargetWindow` and saves only the changed, enabled parts as two PUTs.

**Move to…** (`components/PlanMoveModal.tsx`; `moveProject`/`moveProgram` in `api/plan.ts`; the pure arithmetic in `utils/planMove.ts`: `projectMoveTargets`
groups the eligible programs by work stream, `programMoveTargets` lists the eligible streams, `hasTarget` reads either shape, `findProject`/`findProgram` look a
node up in the current view, `canMoveProject`/`canMoveProgram` are the row-level "offer it?" tests). A row offers the action only when its own `can.move` is set
AND some target is eligible (`Plan.tsx` puts both tests into `actions.canMoveProject|Program`); with no target it is hidden, not disabled, and a row whose only
action it was loses its kebab. The page holds a `MoveState` of just `{kind, id}`: on every render it looks the node up in the CURRENT view and derives the
dialog's name, its parent now ("currently in …"), the targets (excluding that parent) and `forbidden = !can.move`. So a reload under the open dialog (a
400/403's `onRefresh`, or any other `["plan"]` refetch) reshapes the options, a pick that is no longer offered is dropped
(`picked = hasTarget(data, value) ? value : null`), a node that lost `can.move` shows the 403 message with Move disabled, and a node that left the plan closes
the dialog (state reset during render, as on a 404). Eligibility is only the target half of the server's rule (`can.createProject` / `can.createProgram`); the
source half is the node's `can.move`, and the server re-checks both. Outcomes besides 204 are inline in the dialog, never toasts: 409 on a PROJECT (name taken
in the target program) stays open to pick another; 400 and 403 say so, then `onRefresh` reloads the plan, and `submitting` is cleared only AFTER that reload
(Move cannot be pressed on the old plan); 404 closes via `onDone` (close + refresh); anything else, including a 409 on a program, is "The move failed (status)".
Success refreshes `["plan"]` AND `["roadmap"]`. Tests: `PlanMove.test.tsx`, `planMove.test.ts`. The row-level tests are computed in `Plan.tsx`'s `actions`.

**Move targets and outcomes (the page's side).** For a project the targets are the programs whose `can.createProject` is set minus its current program, grouped
by work stream; for a program the work streams whose `can.createProgram` is set minus its current stream; a closed stream stays a valid target and is labelled
"(closed)"; the picker is a searchable `Select` (the theme's folded filter). `POST /projects/{id}/move` `{programId}` / `POST /programs/{id}/move`
`{workStreamId}` answer 204: the success toast is `plan.toast.projectMoved|programMoved`, then the page refreshes `["plan"]` + `["roadmap"]` (a mounted project
view is under `["plan"]`). If the last target vanishes under an open dialog it says so and disables Move.

**Dates**: `PlanDateInput` wraps Mantine's `DateInput` (string `value`/`onChange`, `valueFormat="YYYY-MM-DD"`, placeholder `common.dateFormatHint`, a clear
button named "Clear {label}"). `AppDatesProvider` (mounted in `main.tsx` around the router) passes the UI language and `firstDayOfWeek: 1` to `DatesProvider`;
dayjs only knows `en` until `dayjs/locale/<lang>` is imported (that file imports `pl`); `@mantine/dates/styles.layer.css` is imported in `main.tsx` next to the
core layer. Tests need no provider (the default locale is English). Unit tests type the ISO text into the input; the calendar popup is covered by
`AppDatesProvider.test.tsx` (month and weekday names per language). The input is `components/PlanDateInput.tsx`; the language reaches the calendar through
`components/AppDatesProvider.tsx` in `main.tsx`, which also owns the `dayjs/locale/<lang>` imports — a new shipped language needs its line there. Rules and wire
mappers: `utils/planForm.ts`.

## Project view (`pages/ProjectView.tsx`)

The first Timeline page (lazy). Files: `api/milestones.ts` (`getProjectView`, `createMilestone`, `updateMilestone`, `deleteMilestone`, `scheduleMilestone`),
`hooks/useMilestoneSchedule.ts` (the query under `["plan","project",id]` and the ONE schedule write path), `utils/projectViewUpdate.ts` (`applySchedule`),
`utils/milestoneForm.ts`, `components/ProjectTimeline.tsx` (the view → `TimelineRowData[]` adapter: it composes `ProjectTimelineRows.tsx`'s row and band builders and `MilestoneMenu.tsx`'s row menu;
`ProjectTray` for the Unscheduled tray), `MilestoneEditorModal`, `MilestoneScheduleModal`, `TeamSelect` (a `SearchPicker` over `GET /teams`). `ProjectView` is
`<ProjectPage key={id}>` so another project starts with its own range and editors. `ProjectPage` composes child components (1.6 split, `complexity` 35):
`ProjectPageHeader` (name, meta lines, the `can`-gated actions), `ProjectViewNotices` (notes, inline write failures, the polite status region), `ProjectEditors`
(the dialogs for the open `editor`; the union, `isJiraEditor` and `needsJiraConnections` in `utils/projectEditor.ts`), `TimelineTitle` and `UnscheduledTraySection` (shared with the
team page) and `utils/seenRange.ts` `growSeenRange` (the remembered range only grows). The team page has the same shape: `TeamPageHeader`, `TeamViewNotices`,
`TeamResetConfirm` and `TeamFlowSection`. (Files: `components/ProjectPageHeader.tsx`, `ProjectViewNotices.tsx`, `ProjectEditors.tsx`, `TimelineTitle.tsx`,
`UnscheduledTraySection.tsx`; the team page's `TeamPageHeader.tsx`, `TeamViewNotices.tsx`, `TeamResetConfirm.tsx`, `TeamFlowSection.tsx`.) A split moves markup,
never ARIA, focus or query behaviour (the complexity backstop is `complexity: 35`, `eslint.config.js`).

`/projects/:id` (a detail page, no nav leaf: the Plan page's project NAME is the link, `plan.openProjectAria`; `projectPath(id)` in `utils/planLinks.ts`)
renders `GET /views/project/{id}` under `["plan","project",id]` — under the `["plan"]` prefix, so every Plan mutation also refreshes a mounted project view.
Header facts: the target window, the derived span and the drift in words ("Ends 7 days after the target", one `Badge` per non-zero figure: ORANGE when the
project runs later than its target, gray when ahead, nothing red). **Everything is gated by the view's `can:{…}` flags, never the session's roles:** the owner
chain's `can.edit`/`can.delete`/`createMilestone` give the plan-field editors (`MilestoneEditorModal`: name, description, `TeamSelect`, an estimate
`NumberInput` step 0.25, **no dates for anyone** — a new milestone is always unscheduled), and ONLY a milestone's `can.schedule` (its team's manager or an
ADMIN) makes its bar editable, shows its Schedule button and drag handle and its schedule menu items — the project's own owner reads read-only bars
(`role="img"`, no handles). **Import from Jira… (1.14)**: a header button (`ProjectJiraImportButton`, `components/JiraChips.tsx`, beside Link/Unlink) shown with the project's `can.createMilestone` AND only while the view says the project is linked (`marks`, not a request); `Editor` gains `{kind: "jiraImport"}`, `needsJiraConnections(editor)` enables `useJiraLinks` for it as for the bind dialog (so the connections are asked only after the click), and `ProjectEditors` mounts `JiraImportModal` rooted at the project (`ImportRoot` built from the view: `project.jira`, `workStreamId`, `ownerPersonId/ownerName`; level PROJECT, so no owner field: the project's owner is sent) through `importSourceOf(links)` (`utils/jiraImport.ts`, shared with the Plan page). An apply refreshes `["plan"]` (this view included). Tests: `pages/ProjectView.jiraImport.test.tsx`.
**One write path for dates**, `hooks/useMilestoneSchedule.ts` (a thin wrapper of the generic `hooks/useScheduleWritePath.ts`, which
the team page runs too; the `useRoadmapRanking` shape): a drag, a resize, the tray's Schedule, "Edit schedule…" (`MilestoneScheduleModal`) and Unschedule all
`commit(id, start, end)` — optimistic (`utils/projectViewUpdate.ts` `applySchedule`), the PUT carries the view's `revision`, success adopts the revision the PUT
answers, any failure rolls back and AWAITS the refetch; a stale-revision 409 (THIS milestone moved) shows `project.stale`, 403/400/other an inline alert, never
a toast; a change aimed at a milestone that has left the view (deleted, refetched away) is refused the same way with `project.milestoneGone` and closes the
schedule dialog. **The status region is the one announcer** of these notices: the page's visible notices are `role="note"` (an Alert's implicit `role="alert"`
would read each twice), and the dialog's own refusal Alert stays a live alert (`ownRefusalAlert`) because a modal's content is all a screen reader reads. The
tray's Schedule places the milestone for one calendar week from the later of today (the viewer's LOCAL calendar day, `localIsoDate`) and the project's target
start (`dropOutcome("tray", …)`, the pointer drop's week). **The page owns the timeline range** ("Range" below); the zoom is `useStoredState("timeline.zoom")`,
shared by the project and team pages. Deleting the project states the milestone count (it cascades). Rules mirror the server in `utils/milestoneForm.ts` (the
schedule dialog also pre-checks "at least one working day": Monday–Friday and not a public holiday of the cached dictionary,
`hasWorkingDay(start, end, holidayDays)`; the server's 400 is the rule); a 409 on save marks the name field.

**The write path** is the Roadmap's (`commit` cancels in-flight `["plan"]` fetches (the whole prefix, not only this view), writes
`applySchedule(view, id, start, end)` synchronously — the milestone moves between `scheduled` and `unscheduled` and both keep the server's order, `span`/`drift`
stay the server's — then `mutate`s with the pre-change view as the rollback). The PUT's `expectedRevision` is the cached view's `revision`; the server compares
it with THAT milestone's last schedule write only (unrelated plan writes never stale a drag), so `onSuccess` stores the answered revision and refreshes
`["plan"]` without awaiting it (the refetch also brings the new `span`/`drift`), and `onError` restores and AWAITS the refresh. `stale` is
`isStaleRevision(save.error)` (a 409 of the stale-revision problem type); the 400 of the schedule PUT has several causes (order, shape, no working day), so its
one sentence names the working-day rule instead of sniffing the server's text. The page's polite live region announces the button/dialog paths
(`project.announce.*`); a drag is announced by dnd-kit's own localized region. **A change is never lost silently:** while a save is in flight `commit` answers
`false` and sets `refused` (cleared when that save settles) — the page shows an orange "a save is still running — try again" notice (also inside the schedule
dialog, which stays open), announces it (every announcement flips an invisible zero-width suffix, so the same sentence twice is re-read), a visible "Saving…"
indicator sits by the Timeline heading, and `TimelineDndContext` corrects dnd-kit's drop announcement (`onSchedule` returns a boolean). **The schedule dialog
saves with the revision of the view it was OPENED on** (`Scheduling = {milestone, revision}`), so another manager's move of that milestone meanwhile is the
stale 409, not an overwrite; unrelated writes never stale it (the check is per milestone).

**Range.** The page keeps `seen = {min, max}` (ISO strings) in state, grows it during render whenever the view holds an earlier/later date (scheduled dates, the
target window), and builds `makeScale(zoom, defaultRange([min, max], today, zoom))` from it — `today` is `localIsoDate()` (`utils/isoDate.ts`): the VIEWER'S
local calendar day, not UTC — the today line and the Schedule button agree with their wall calendar, and a Saturday evening in Warsaw is Saturday, not (for part
of the day) Friday or Sunday in UTC. It is the one place the UI reads the browser's zone; the server's dates stay plain ISO dates with no zone, and the Plan
page's close-a-stream date still uses UTC `todayIsoDate()`. The range NEVER shrinks: after the last far-off link (a ghost row's dates) is deleted it stays wide
until the page is reloaded. A drag cannot go further than the padded range (the track clips); typed dates in the schedule dialog can, and the range then grows.
**Bands.** The target window is a `window` band across every row; when the span ends after the target a `drift` band covers the overrun (`addDays(targetEnd, 1)`
… `span.end`). **Rows** are fixed 36 px, so the name cell is one line: the name and the description as dimmed text after it, clipped by the cell. The kebab of a
row is a roving stop of the grid (`RowActionsMenu`'s `trigger` prop spreads the stop on the button). The timeline body is at least three rows tall
(`MIN_BODY_ROWS`) so an empty timeline still has an area to drop a tray row on.

**Dependencies (v0.4.0).** Files: `api/dependencies.ts` (`createDependency(projectId, body)`, `updateDependency(id, {type, lagDays})` (the in-place edit, 204),
`deleteDependency(id)`, `isDependencyCycle(err)` — the `isStaleRevision` shape — and the types), `api/plan.ts` `listProjects` / `api/milestones.ts`
`listMilestones` (the pickers' paged searches), `api/http.ts` `ApiError.cycle` (a typed getter beside `detail`/`type`; malformed entries dropped),
`utils/projectDependencies.ts` (pure: `ghostEndpoints`, `summaryRowNeeded`, `arrowSpecs`, `conflictCount`, `conflictsByBar`, `linksOfMilestone`),
`utils/dependencyForm.ts` (form values, the self-link and lag rules, `toDependencyBody`, `cyclePathText`, `dependencySaveErrorMessage`; the edit's
`editDependencyForm`, `dependencyEditValidation` (the lag only), `toDependencyUpdateBody`, `dependencyUpdateErrorMessage` and the shared
`dependencyEndpointText`), `components/ProjectDependencies.tsx` (the h3 section: table, Delete, empty state), `DependencyEditorModal.tsx`,
`MilestoneSelect.tsx`, `ProjectSelect.tsx`, and in `ProjectTimelineRows.tsx` the summary row and the ghost rows, in `ProjectTimeline.tsx` the overlay, in `MilestoneMenu.tsx` the "Add dependency…" menu item.
- **Row and bar ids.** Own milestones keep their numeric ids; the synthetic rows are strings that cannot collide: `project:<id>` (the summary row, one hollow
  bar of the derived span — none while nothing is scheduled), `ghost:m:<id>` / `ghost:p:<id>` (one per DISTINCT external endpoint WITH dates, sorted by start,
  end, name). A row's bar id equals its row id for the synthetic rows. An arrow end resolves to: the own project → the summary row, an own milestone → its row
  (a tray milestone has none: the arrow is skipped by `arrowsToDraw`, as is the whole link when its status is UNSCHEDULED), anything else → its ghost row. The
  page's `seen` range includes every end's dates so an arrow to a far-away ghost is in range.
- **Placement.** The section sits AFTER the Unscheduled tray (and after the "No milestones yet" empty state), not between the timeline and the tray: the tray's
  pointer drop needs the tray close to the timeline and in view with it (the e2e tray drop asserts both are inside the viewport), and the section is taller than
  the viewport slack once it holds an empty state.
- **The page owns the dialog**, not the section: `Editor` has a `{kind: "dependency", successor}` variant so the section's button (successor null → "This
  project") and a milestone's row-menu item (successor = that milestone) open the same `DependencyEditorModal`; the section owns only its Delete confirmation.
  The page's `editDependency` variant (the row menu's "Edit…", `ProjectDependencies`' `onEdit`) opens the SAME modal with `target` set: ends as read-only
  `TextInput`s, `TypeAndLagFields` shared with the create, `updateDependency` on Save, success toast `project.toast.dependencySaved`, the cycle sentence
  `project.dependency.cycleEdit`; a held `ProjectDependency` snapshot is fine because a vanished link answers 404 ("This no longer exists"). The modal saves
  with `createDependency` and a cycle 409 (`isDependencyCycle`) is drawn from `err.cycle`; every other failure goes through `dependencySaveErrorMessage` (the
  fixed vocabulary — a 409 here is the duplicate pair).
- **Refresh.** Create/edit/delete: `refreshQueriesAfterMutation(queryClient, ["plan"])` (+ `["roadmap"]` through the page's `saved`). The schedule write path
  already refreshes `["plan"]` after a PUT (`useMilestoneSchedule`), which is what brings the new checks: the optimistic `applySchedule` moves the bar but never
  touches `dependencies[].check`, so for a moment after a drop the table/arrow still show the previous check. Pinned by `ProjectView.test.tsx` ("a schedule
  write refetches the view…").
- **Picker query keys** are `["plan", "milestones", "picker", term]` and `["plan", "projects", "picker", term]` — under the `["plan"]` prefix, so a Plan mutation refreshes an open picker's list too.
- **Delete bodies** state the cascade: `project.dependency.deleteWith` ("Its N dependencies will be deleted too.") is appended to the milestone's and the
  project's confirm text when the view holds any link on them (`linksOfMilestone`; the project's count is `dependencies.length`, which is exactly its own links
  and its milestones').

**Dependencies (v0.4).** The view's `dependencies[]` is read, never recomputed: the SERVER's `check` (OK / VIOLATED + shortfall + required/actual dates /
UNSCHEDULED) is shown as is. The **Dependencies section** (`components/ProjectDependencies.tsx`, h3) is the accessible surface — one table row per link in the
server's order, violated first (so the top IS the conflict list): a red `Badge` "Violated · N working days short" (gray "OK" / "Not scheduled yet" — never
colour alone), predecessor, type ("Finish → Start (FS)"), lag (a negative one reads "(lead)"), successor, "needs X · is Y", an "Edit…" in the row menu only with
the link's own `can.edit` and a Delete only with its own `can.delete` (both the SUCCESSOR's project chain, or ADMIN; the predecessor's owner sees the link and
the arrow but can neither change nor remove it; the kebab shows when either is set; Delete through `useDeleteConfirm`). **Edit** (the row's `editDependency`
variant, "The page owns the dialog"): only Type and Lag are editable (changing an end stays delete + add); Save is `PUT /dependencies/{id}` `{type, lagDays}`
(204); a type that would close a cycle is the same 409 drawn from `ApiError.cycle` under "With this type the link would close a cycle through:", a 400 reads as
the lag sentence, 403/404 as the create's. The facts line gains a red "N conflicts" badge and a violated bar's accessible name gains ", N conflicts" (an
editable bar's name ends with it; a read-only bar reads "…, N conflicts, read-only"); the timeline gets a **ghost row** per distinct external endpoint with
dates (dimmed; its name a `RouterLink` to that project whose accessible name keeps the visible text — `project.ghostLinkAria` "A › a1 - open project A", axe's
label-content-name-mismatch), a **summary row** only while the project itself is an endpoint, and gray/red arrows (`utils/projectDependencies.ts` maps view →
`TimelineArrowData[]`; an own end with no row is simply not drawn). **Add dependency** (button beside the heading, and "Add dependency…" in a milestone's row
menu, both gated by `project.can.createDependency`) opens `DependencyEditorModal`: the SUCCESSOR is fixed to this project or one of its milestones (the
constrained side; the intro says so), the predecessor is a Milestone/Project `SegmentedControl` over `MilestoneSelect`/`ProjectSelect` (`SearchPicker`s over the
paged `GET /milestones` / `GET /projects`, options "name · project" / "name · program · work stream"), type, and a lag in working days (−365..365, negative = a
lead). Create, edit and delete are plain mutations (no optimistic step, no revision; `refreshQueriesAfterMutation(["plan"])` brings the server's new checks,
"Refresh" below). A cycle 409 renders the localized sentence plus the path ("A → B → A", from `ApiError.cycle`, never the server's text); the duplicate pair 409
is "already linked".

**Idle gaps (v0.7.0).** `view.idleGaps` is the server's list (`IdleGap{start, end, workingDays}`, `api/milestones.ts` `IdleGap`), read as is: `bandsOf` appends
`idleBands(view.idleGaps, t)` (`utils/idleGaps.ts`) after the window/drift bands (and returns them when the project has no window), `ProjectFacts` adds the gray
`timeline.idle.badge` plural badge only when the list is non-empty, and `<IdleGaps gaps scope="project" />` is mounted right after `{dependencies}` (so the h3
order is Timeline, Unscheduled, Dependencies, Idle gaps). `applySchedule` spreads the view, so the cached gaps survive the optimistic step unchanged (pinned by
`projectViewUpdate.test.ts`: same array identity) and the refetch replaces them (`ProjectView.test.tsx`: the old band is still drawn synchronously after a drop,
then the server's new gap). Reference: `timeline.md` "Idle bands".

**Idle gaps (v0.7).** The view's `idleGaps[]` (working-day runs of 3 or more inside the span when none of the project's milestones is in progress; the SERVER's
list, read and never recomputed) draw as one hatched `idle` band per gap across every row (`TimelineBandData.tone "idle"`, `data-band-tone="idle"`,
`utils/idleGaps.ts` `idleBands`; `bandsOf` appends them after the window and drift bands, also when the project has no target window), list in the **Idle gaps
section** (`components/IdleGaps.tsx`, h3 after the Dependencies section: a `TableDisclosure` over a From / To / Working days table, or "No idle gaps of 3 or
more working days.") and count in a gray "N idle gaps" badge of the facts line (absent at zero; neutral information, never a warning). The optimistic step keeps
them (above): dropping them would flash a false "no idle gaps" for a round trip. Strings: `timeline.idle.*`.

**Critical path (v0.7.0).** `ProjectPage` holds `useCriticalPathPick()` (the one `timeline.criticalPath` key, shared with the team page, 1.7; before the early return: hooks stay unconditional),
passes `criticalPath` and `<CriticalPathToggle>` (as `toolbar`) to `ProjectTimeline`, `showCritical` to `ProjectDependencies` (1.7: with it a **Slack** column of each link's own `check.slackDays`, "—" while an end is unscheduled, a critical link "0" + the hidden "critical path") and mounts `<CriticalChain view />`
right after `{dependencies}` (before `IdleGaps`) while the toggle is on and the project has milestones (so the h3 order is Timeline, Unscheduled, Dependencies,
Critical chain, Idle gaps). `ProjectTimeline` (rows in `ProjectTimelineRows.tsx`, cell in `SlackCell.tsx`) adds the `slack` column (`withOptional` inserts the cell before the actions cell, so a bar's roving columns shift by
one with it) and applies `emphasized(t, critical, describe)` to the bar fields; `arrowSpecs(view, criticalPath)` flags the arrows. The ghost rows' slack and
emphasis come from `upstreamIndex(view)` by kind + id. `applySchedule` leaves `slackDays`/`critical`/`criticalPath` as cached (the refetch brings the server's).
Reference: `timeline.md` "The critical-path highlight".

**The pin (1.7, project page).** A scheduled milestone's row menu offers "Pin dates" / "Unpin dates" (`common.action.pin*`, `IconPin`/`IconPinnedOff`) by the ROW's `can.schedule` (the team's manager or an ADMIN;
the project's owner sees the glyph and no item) and never on a tray row: `MilestoneActions.pin` -> `schedule.pin(id, pinned)` of the page's write path (the team page's section has the mechanics). A pinned row
carries `PinMark` after its name (`IconPin` `aria-hidden` + a `VisuallyHidden` "pinned", `timeline.pinned`) and its bar's accessible name gains ", pinned" right after the base sentence (`withPinned`,
`utils/pinText.ts`, before ", N conflicts" and ", on the critical path"). Tests: `ProjectView.pin.test.tsx`.

**The critical path (v0.7).** A "Critical path" toggle button in the timeline's new `toolbar` slot (after Today; `aria-pressed`, filled cyan while on;
`useStoredState("timeline.criticalPath", false, isBoolean)`) shows the server's critical path, read and never recomputed (`milestone.slackDays`/`critical`,
`dependency.critical`, `criticalPath{upstream, upstreamTruncated}`). While on: a **Slack** column (own rows "0" + a hidden "critical path" or "N working days";
ghost rows the neighbour's slack looked up in `upstream` by kind + id, "—" when absent; **never filter by `hops`**: a milestone of a project a link names is 1
hop but not a ghost row), a text-colour outline (`TimelineBarData.emphasis: "critical"`, `data-critical="true"`, ", on the critical path" in the bar's name) on
critical milestones, on ghost bars whose entity is critical and on the summary bar when a critical link ends on the project, heavier text-colour arrows with
their own arrowhead for critical links (a violated arrow stays red), a gray "Critical path" badge on those links' Dependencies rows and the **Critical chain
section** (`components/CriticalChain.tsx`, h3 between Dependencies and Idle gaps): "On the chain" (the critical `upstream` entries that are not ghost rows,
server order, each name a link into its project) and "Upstream with slack" behind a disclosure, with a "not shown" note when truncated. Off, the DOM is
unchanged (pinned). Pure derivations: `utils/projectDependencies.ts`. Strings: `project.critical.*`, `project.column.slack`, `timeline.criticalToggle`,
`timeline.bar.critical`. Reference: `timeline.md` "The critical-path highlight".

**The baseline overlay (v0.9).** With a baseline picked (the toolbar's picker, beside the Critical path toggle; `useMilestoneSchedule(id, pick)`) each scheduled
milestone's row gets a shadow bar for the span the baseline froze, a milestone it did not know reads "(new since the baseline)", dimmed rows follow the
milestones for the baseline's milestones that were deleted ("(removed)") or are in the tray now ("(unscheduled since the baseline)"), the facts line gains
badges for the project's own span ("Ends 3 working days later than the baseline" ORANGE when the END is later, a gray start figure) and the **Movement section**
(`components/BaselineMovement.tsx`, h3, after Idle gaps) is the accessible surface: totals badges, then a disclosure over a table of every milestone against the
baseline ("Changed only" on by default, an estimate-only change counts as changed). The optimistic step keeps the cached `baseline` block. Tests:
`ProjectView.baseline.test.tsx`, `BaselineMovement.test.tsx`.

**The Jira markers (1.3).** All from the view, no request of their own: the chip in the facts line (the project's `jira` and `flags`, the milestones' count and
open-flag total - "The chips and marks" under "Deviations, bindings and the Jira chips"), a **Flags** column (while a scheduled milestone is linked; before
Slack) holding each linked row's Jira key link and flag icon, the tray rows' key, icon and "Jira: start to end", and the dashed shadow bar `jira:<milestoneId>`
per linked scheduled row with the toolbar's "Jira dates" toggle (after Critical path; only when `jiraSites` is non-empty; the shared `timeline.jiraBars`). The
page's range follows `jiraPageRange(...)`: the Jira days join it only inside the plan's own dates padded by a year, so a mistyped Jira date cannot stretch the
track. The row menu's Link/Unlink item and the header button read the view; the bind dialog asks for its `connections[]` when it opens (`useJiraLinks`).
Reference: `timeline.md` "The Jira markers (1.3)". Tests: `ProjectView.jira.test.tsx`.

**Tests.** `ProjectView.test.tsx` runs the page against a small fetch-mock server (a schedule PUT applies the dates and bumps the revision; the dependency
POST/DELETE and the milestone picker list are stubbed) and wraps `DndContext` to hand the test the page's drop handler; fake timers (`Date` only) pin "today"
for the Schedule button. `milestoneForm.test.ts`, `projectViewUpdate.test.ts`, `projectDependencies.test.ts`, `dependencyForm.test.ts`,
`api/milestones.test.ts`, `api/dependencies.test.ts`, `TeamSelect.test.tsx`, `DependencyEditorModal.test.tsx` are pure/small. The real pointer drag, the resize
handle, the tray drop under scroll, the keyboard sensor and the stale notice are `e2e/tests/project-view.spec.ts`; the dependency journeys (link, ghost row,
arrow, cycle refusal, the manager's conflict, delete) are `e2e/tests/dependencies.spec.ts`.

## Roadmap (`pages/Roadmap.tsx`)

The global project ranking (V13 + `GET /views/roadmap`, `PUT /roadmap/ranking`) as a timeline, a read for everyone whose editing is gated by the view's
`can.editRank`. Files: `api/roadmap.ts` (`getRoadmapView`, `putRanking`, `isStaleRevision` — a 409 whose problem `type` is
`urn:astrolabe:problem:stale-revision`; the view's `RoadmapProject` carries the server's `rankPosition`, `teamIds`, `span`, `drift`, `flags[]`,
`can.editTargetWindow`, and the view `teams[]` and the rolled-up `links[]`), `hooks/useRoadmapRanking.ts` (query + the one write path),
`hooks/useRoadmapFilters.ts` and `hooks/useProgramPick.ts` (the stored filters and the shared pick), `utils/roadmapOrder.ts` (pure:
`moveBy`/`moveToEdge`/`moveToSlot` — the team page's too —, `moveAmongVisible`, `rankingAfterDrop`, `sameIds`, `appendId`, `removeId`, `applyRanking`),
`utils/roadmapRows.ts` (pure: filters, the pick, the displayed rows and the divider, the flag totals and panel entries, the drift band, the arrows of the
rolled-up links) and the components `RoadmapTimeline` (the rows, bars, bands, the row menu, the arrows — inside the page's `TimelineDndContext`),
`RoadmapFlagPanel`, `RoadmapFilters`.

`/roadmap` (nav section Planning after Plan, palette entry "Roadmap" / PL "Roadmapa") renders `GET /views/roadmap` under `["roadmap","view"]` as a **timeline**
on the shared `Timeline*` (`components/RoadmapTimeline.tsx`): a row per project in rank order, then an "Unranked" divider row (present only while something
unranked is visible) and the unranked projects (by name). Left columns, 404 px sticky: `#` (the SERVER's position, "—" when unranked; a filter leaves gaps),
Project (the pointer-only row handle, the name as the link into `/projects/:id` — `roadmap.openProjectAria` "Open {{name}}" — the program dimmed after it),
Flags, Operations (the row menu); work stream and owner are filters, not columns. On the track: the project's **span bar** (read-only, `tone: "summary"`, name
"{{name}}, {{start}} to {{end}}" plus ", N conflicts") over its **target window** (a `tone: "window"` bar, `window:<id>`, name `timeline.bar.window`; editable
only where the project's own `can.editTargetWindow` is set, else a read-only image) and, past the window, the orange drift band (`utils/roadmapRows.ts`
`driftBandOf`). The server's `span`/`drift`/`flags` are only read, never recomputed (a window write drops them optimistically; the refetch brings the server's).
**Whether the ranking can be changed is the view's `can.editRank`** (never the session's roles); without it: no handle, no ranking item in the menu, read-only
bars.

**Flags**: a row's `flags[]` show as icons with counts in the Flags cell (an ORANGE triangle for warnings, a gray info circle for infos, plus a visually hidden
"2 warnings, 1 info"); the facts line under the title ("N ranked", "M unranked", an ORANGE "K warnings" badge, a gray "J infos" badge) counts the VISIBLE rows;
`components/RoadmapFlagPanel.tsx` (h3 "Flags", behind `TableDisclosure`) is their accessible surface — one table row per flag, severity in words (never colour
alone), the project link, the sentence by kind (plural keys: "Ends 10 days after the target", "Ranked below X, but starts 7 days earlier on Team", …) and a
"Show in timeline" button that calls `timelineRef.current.focusRow(projectId)` (the row-header cell, revealed, mounted or not). A `SegmentedControl` above the open table (a labelled radiogroup: All / Warnings / Infos, each label with its count, default All) filters the LIST by severity: panel-local state, never stored or in the URL; the row icons and the disclosure's count stay total, and an empty slice says "No warnings/infos among the flags shown." instead of an empty table (the Programs page has no flag panel). **Filters**
(`components/RoadmapFilters.tsx` in a `FilterPanel`, stored `roadmap.filter.*` through `hooks/useRoadmapFilters.ts`): work stream, team (a project matches when
`teamIds` has it), owner, flagged only, and the **program pick** (a `MultiSelect`, empty = all; ONE stored key `planning.programPick` through
`hooks/useProgramPick.ts`, shared with the programs page) — applied client-side by `utils/roadmapRows.ts` (`visibleProjects`; a stored id the view no longer has
is ignored, `knownFilters`/`knownPick`), and to the facts line and the panel too. **Arrows** (`arrowSpecsForLinks`): a PROJECT-to-project link by its type on
the two span bars (red when VIOLATED), plus ONE bundle arrow per ordered project pair for the milestone links between them (`bundle:<pred>-<succ>`, end to
start, red when any is violated, `<title>` "A → B, 3 milestone links (1 violated)"); an arrow whose project has no span or no visible row is left out. **Zoom**:
Month / Quarter / Year (`PLAN_ZOOMS`, default Quarter) under its own key `timeline.planZoom`; the range only ever grows over every span and window of the WHOLE
plan (a filter never shifts it). Rows virtualise above 80 (the sample plan's ~100 projects take the virtual path).

**The baseline overlay (v0.9):** with a baseline picked (`useRoadmapRanking(pick)`, the picker in the timeline toolbar) a project the baseline froze gets a
shadow bar `baseline:<id>` under its span bar (`projectTrack`; named with the frozen dates and the movement), `components/BaselineTotals.tsx` prints one
`role="note"` line under the facts ("vs baseline X: 14 end later, 3 end earlier, 2 new, 1 removed" - the removed ones are `view.baseline.removedProjects`),
the range grows over the frozen spans (the removed projects' too) and, since 1.10, every removed project that had a span is appended as a dimmed "(removed)" row
after the last unranked row (`RoadmapTimeline`, `removedProjectRows`, `visibleRemoved`: the work stream filter and the program pick apply, a team, owner or
flagged-only filter hides them; rank cell "—", the shadow bar only; `timeline.md`); the flag panel is untouched. **Rank movement (1.7):** the rank cell reads "5 (was 3)" / "(was unranked)" from the frozen `baseline.rankPosition` (a `VisuallyHidden` sentence carries it for assistive technology; the column widens while a baseline is picked) and the totals note appends `rankTotals` ("N moved up in rank", "M down", newly ranked / no longer ranked). Tests: `Roadmap.baseline.test.tsx`.

**The critical path to a picked project (1.7):** the toolbar's "Critical path to…" picker (`components/RoadmapCriticalPicker.tsx`: a searchable `Select`, "None" first, then the projects with a span by name; a picked project without one stays an option of its own) and the row menu's "Show critical path to this project" / "Hide critical path" (disabled while a write runs, like the picker) set the target: PAGE-LOCAL state (`hooks/useCriticalTarget.ts`, never stored - a question, not a setting), said in the live region. It is the second part of the view's key (`roadmapViewKey(baseline, criticalPath)` = `["roadmap","view",{baseline, criticalPath}]`, `getRoadmapView(baseline, criticalPath)` -> `?baseline=N&criticalPath=M`; `useRoadmapRanking(baseline, criticalPath)`, `useTargetWindow` take the key like the pick; the optimistic steps spread the view, so the cached `criticalPath` block is KEPT like `baseline`; the `keepPreviousData` placeholder shows NO chain, `withoutCriticalPath`, since it is the old target's). The server's block is read by `utils/roadmapCritical.ts` (`criticalIndex`: the target and the zero-slack projects are emphasised, the pairs key the arrows; `chainProjects`: the panel's rows in the server's order) and drawn by `projectTrack`/`planArrows` ("The roadmap page's use" in `timeline.md`). **A plain 400 for the target** (`isRejectedTarget`: deleted or off-roadmap; not the typed `unknown-baseline` one) clears the selection during render (`reject()`), shows `roadmap.critical.unknown` in a red inline alert until the next pick, and the key change fetches the plain view - no error flash, no loop. The panel (`components/RoadmapCriticalChain.tsx`, h3 "Critical path to {name}", under the flag panel while a target is set) states the target's span, then ONE table (`components/UpstreamTable.tsx`, generalised from the project page's `CriticalChain` so both share it: hops, the project as a `RouterLink`, program, dates, slack, an "On the chain" badge) over `criticalPath.projects`; "Nothing is scheduled in {name}" and "No other project is upstream of {name}" are its empty states, and a project the filters hide stays listed with a dimmed "(not shown)". Tests: `Roadmap.critical.test.tsx`, `RoadmapCriticalChain.test.tsx`, `roadmapCritical.test.ts`, `baselineWrites.test.tsx`.

**The Jira markers (1.3):** the toolbar's "Jira dates" toggle (`components/JiraBarsToggle.tsx`, after the baseline picker; ONE remembered boolean
`timeline.jiraBars` through `hooks/useJiraBarsPick.ts`, **on by default**, shared by all four timeline pages; rendered only when the view lists a Jira site)
switches each bound project's shadow bar `jira:<id>` (`tone: "jira"`, a 5 px dashed outline along the TOP of the row from `project.jira.start/end`, drawn only
when both are known; `projectTrack(…, jira)`, `utils/jiraBars.ts`; drawn and ranged only inside the Jira window - the plan's own dates padded by a year - so a
mistyped Jira date cannot stretch the range; named "Jira E2E-6: start to end" plus the row's open date-deviation sentence). The flag panel phrases
`JIRA_DEVIATION` as "Jira {{key}}: " + the Deviations page's sentence for `flag.deviation` with an icon-only link to the issue through the view's `jiraSites`
(`JiraKeyLink`; the URL is never per row), and `JIRA_MILESTONES` as "{{count}} milestones deviate from Jira"; the icons and counts stay severity-driven.
Reference: `timeline.md` "The Jira markers (1.3)". Tests: `Roadmap.jira.test.tsx`.

**The write path.** Every change — a row-menu move, a row drag, Rank (append), Unrank — becomes the complete new id list and is sent as the wholesale PUT with
the `expectedRevision` of the view on screen (the view's `revision` is the RANKING's own, V18: a plan write elsewhere never stales it, so the page only echoes
it and a stale 409 means another ranking write or the delete of a ranked project). `commit` (a) answers `true` WITHOUT a PUT when the list equals the current
one (a drop beside the row itself), (b) REFUSES the change out loud while a write is in flight (`useIsMutating` on the shared mutation key `["roadmap","write"]`
— the key the window write path shares in a later v0.6 step —: `refused` drives the page's `role="note"` Alert and `project.busy` goes to the live region;
`useRefusal` clears it when no write is left), (c) cancels in-flight `["roadmap"]` fetches, (d) writes `applyRanking(view, ids)` into the cached view
synchronously (the optimistic reorder: the ranked list in the new order, positions 1..n AND each project's own `rankPosition`; flags and spans stay the server's
until the refetch; the row, the focus and the PUT all start from the same click), (e) `mutate`s with the pre-change view as the rollback. `onSuccess` stores the
response's `revision` in the cached view and starts `refreshQueriesAfterMutation(["roadmap"])` WITHOUT awaiting it (the save is over once the PUT answers, so a
held Enter on a menu item is never swallowed; the next `commit` cancels that refetch before it writes its optimistic order, and the stored revision is what it
sends); `onError` restores the pre-change view and AWAITS the refresh (the reload after a stale 409 must finish before another change builds on the list). A 409
stale-revision shows `roadmap.stale` (the problem type is what tells it from any other 409), 403/400/other failures map through `saveErrorMessage` into an
inline alert — never a toast, and no success toast either (the optimistic reorder and the live region are the feedback). The stale 409 means **the change was
NOT saved** — the alert says so.

**Re-ranking** (the write path above): the stale-revision 409 reads "the roadmap changed in the meantime — the list was reloaded". **A change made while a write
is in flight is refused out loud** (the team page's rule: `useRefusal`, an orange `role="note"` "try again" Alert, `project.busy` in the page's one polite live
region, `aria-busy` and a "Saving…" indicator on the grid; every entry point answers whether the change was taken; one mutation key per cached view so a later
window write sees it). The paths: the **row menu** (the deterministic, keyboard path; after a taken change the page puts focus back on the row's menu button — a
browser blurs a row moved in the DOM — or, when the virtual path has unmounted the row, `focusRow`s its header; done once at render and again when the menu has
FINISHED closing, "Roadmap menu focus" below) — ranked rows: Move up / Move down / Move to top / Move to bottom (disabled at the ends of the VISIBLE ranked
rows) and Unrank, unranked rows: Rank (appended at the END, the v0.2 rule), always Open project — and the **row drag** by the pointer-only handle
(`onReorder(id, slot)` on the page's `TimelineDndContext`, the team page's mechanism): inside the ranked rows it moves the row; **across the divider** a drop
above it RANKS an unranked row at that slot and a drop below it UNRANKS a ranked row (dropping an unranked row among the unranked changes nothing). A drag
(including one across the divider) is announced by dnd-kit's region only; every menu change is said by the page ("{{name}} moved to position …", "… ranked at
position …", "… removed from the ranking"). The Plan page's mutations also refresh `["roadmap"]`.

**Under a filter.** The moves take the ids of the VISIBLE ranked rows: `moveAmongVisible(full, visible, id, slot)` numbers the gaps like `moveToSlot` but over
the rows the user sees and puts the row just before the visible row that follows the gap (after the last visible row for the final gap), so hidden rows keep
their order and their place. A drop is `rankingAfterDrop(full, visibleRanked, id, slot)` with the slot counted over the DISPLAYED rows: a slot beyond the
divider (`visibleRanked.length`) unranks a ranked row (an unranked row comes back unchanged = no PUT); a slot up to it is a place in the ranking, so an unranked
row is RANKED there. The page binds `visibleRankedIds` into the hook's `move`/`moveTo`/`dropAt`.

**Dragging.** The row handle (`TimelineRowHandle`, pointer-only) and the page's `TimelineDndContext` `onReorder(id, slot)` are the team page's mechanism
(`timeline.md` "Row drag"); there is no keyboard drag — the row menu is the keyboard path, and the page restores keyboard focus after a taken menu change
(`refocus` in `Roadmap.tsx`): a browser blurs a focused element whose row is moved in the DOM, so the render that reorders is followed by `focus()` on the row's
`data-operations-for` menu button, or by `focusRow(id)` when the virtual path has unmounted the row (Move to bottom, Rank on a 100-row plan). dnd-kit's region
announces a drag (also across the divider); the page's polite region says the menu changes only.

- **Roadmap menu focus.** After a taken menu change the roadmap repeats its refocus once the row menu has FINISHED closing (`RowActionsMenu`'s opt-in `onClosed`
  = Mantine's `onExitTransitionEnd`, via `actions.menuClosed`): the dropdown and its focus trap stay mounted through the ~150 ms exit transition and pull an
  earlier focus back into the dropdown, which lands on `body` when the dropdown unmounts.

### The target window (both plan pages)

**The target window (v0.6, both pages):** wherever the project's own `can.editTargetWindow` is set (ADMIN, an owner ABOVE the project, a ROADMAP_EDITOR - the
project's own owner alone is read-only; never the session's roles) the window is edited by (1) moving or resizing its band (the bar machinery, keyboard
included; the read-only span bar over it is pointer-transparent, `.timelineBarInert`, so the window under it is grabbed where they overlap and a draw can start
on it), (2) a **draw** across a row with no window (`projectTrack` returns `draw: {barId: "window:<id>"}`), and (3) the row menu: "Edit target window…"
(`components/TargetWindowModal.tsx`, the `MilestoneScheduleModal` shape: two `PlanDateInput`s, both required, end not before start, a Clear button, the refusal
shown inside the dialog) and "Clear target window" (`TargetWindowItems` in `PlanProjectCells.tsx`) - the keyboard and touch path. All three are
`onSchedule("window:<id>", start, end)` / the menu on the page's `TimelineDndContext`, answered by ONE write path, `hooks/useTargetWindow.ts` ("The target
window's write path" below; generic over the cached view: roadmap `["roadmap","view"]` with `applyRoadmapWindow`, programs `["roadmap","programs"]` with
`applyProgramsWindow`): the failures read 403 `roadmap.window.forbidden` / 404 `roadmap.window.gone` / 400 `roadmap.window.invalid`, and a change while the
ranking write runs (or the reverse) is **refused out loud**, the dialog staying open with its own alert. After a menu action the focus returns to the row's menu
button (`hooks/useRowMenuFocus.ts`, the roadmap's `onClosed` pattern, `restore` for a closed dialog). Drags are announced by dnd-kit, the dialog and Clear by
the page (`roadmap.announce.windowSet/windowCleared`). Tests: `Roadmap.window.test.tsx`, `Programs.window.test.tsx`, `targetWindowUpdate.test.ts`; the real
pointer gestures are the third scenario of `e2e/tests/roadmap.spec.ts`.

**The target window's write path (v0.6, both plan pages).** `hooks/useTargetWindow.ts` is generic over the page's cached view (`view`, `queryKey`, `apply`,
`nameOf`, and the page's `announce`): `commit(id, start|null, end|null, {announce?, ownRefusalAlert?}) → boolean` cancels in-flight reads of the view, writes
`apply(...)` (`utils/targetWindowUpdate.ts`: the window set, `drift` and the DRIFT_* flags dropped - the RANK_INVERSION flags stay -, and on the programs view
the program's and work stream's roll-up counts lowered by the dropped flags), then `mutate`s `PUT /projects/{id}/target-window` (204, no revision) with the
pre-change view as the rollback. Success refreshes `["roadmap"]` and `["plan"]` WITHOUT awaiting (so the other plan page, not mounted, is invalidated and a
mounted project view's band follows); failure restores the view, AWAITS the refresh and maps 403/404/400 through `saveErrorMessage` (`roadmap.window.*`). The
mutation key is the ranking's exported `ROADMAP_WRITE_KEY`, so `useIsMutating` sees both and each refuses the other: `commit` answers `false`, sets `refused`
(`useRefusal`) and announces `project.busy`; a change aimed at a project that left the view sets `gone`. The roadmap passes `ranking.announce` as its `announce`
(ONE polite region), the programs page its own toggled-suffix announcer. `hooks/useRowMenuFocus.ts` is the roadmap's former inline refocus (`keep` = at render
and again on the menu's `onClosed`; `restore` = at render only, for a dialog that was opened from the menu) shared by both pages. The dialog
(`TargetWindowModal`, `returnFocus={false}`: the page puts the focus on the menu button) is kept as `{id}` page state, the project read from the view on every
render and the dialog closed when it left. **dnd-kit's click blocker:** after ANY drag ends, dnd-kit swallows the next `click` for 50 ms (its document-level
capture listener is removed on a timer), and an Enter on a button is a click - a Playwright step that presses a menu button right after a drag must retry
(`e2e/tests/roadmap.spec.ts` `menuItemByKeyboard`). Tests: `Roadmap.window.test.tsx` and `Programs.window.test.tsx` (the PUT bodies, the optimistic figures,
rollback, the 403/404/400 sentences, the refusal both ways, the dialog and Clear, focus), `targetWindowUpdate.test.ts`, `planTrack.test.ts` (who gets an
editable band and a draw surface), `planForm.test.ts` (the dialog's rules).

**Tests.** `Roadmap.test.tsx` runs the whole flow against a small fetch-mock server (a PUT applies the order and bumps the revision); it wraps `DndContext` to
hand the test the page's drag handlers (a row drop is fed with the row zone's live readers), since happy-dom has no layout for a real drag.
`roadmapOrder.test.ts`, `roadmapRows.test.ts` and `api/roadmap.test.ts` are pure. The real pointer drag (inside the ranking and across the divider), focus
retention after a menu move and the stale notice are `e2e/tests/roadmap.spec.ts`.

## Programs (`pages/Programs.tsx`)

`/programs` (nav section Planning after Roadmap, `IconListTree`; palette "Programs" / PL "Programy") renders `GET /views/programs` under
`["roadmap","programs"]` (`api/programs.ts`; under the `["roadmap"]` prefix the Plan page and the project view already refresh) as the plan **tree on the shared
Timeline** (`components/ProgramsTimeline.tsx`): work stream → program → project, one row each, in the server's order (open streams first, projects ranked
first). Read for everyone; the one thing written here is a project's target window (band, draw, row menu - "The target window" under the Roadmap page, the same
shared row and write path); the server's spans, flag counts, drift and link checks are only read.

Files: `api/programs.ts` (`getProgramsView`, `programsViewKey` = `["roadmap","programs"]`, the view types), `utils/programsTree.ts` (pure: `treeRows`,
`defaultOpen`, `allOpen`, `toggled`, `programChoices`, `treeFacts`, `treeDates`), `components/ProgramsTimeline.tsx` (tree rows → `TimelineRowData[]`, the
chevron cell, the arrows), and the pieces it shares with the roadmap: `utils/planTrack.ts`, `components/PlanProjectCells.tsx`,
`components/ProgramPickField.tsx`, `hooks/usePlanScale.ts`, `hooks/useProgramPick.ts`, `utils/roadmapRows.ts` `pickAmong`.

**Rows** (`utils/programsTree.ts`, pure and tested: `treeRows(view, pick, open)`). Left columns, 448 px sticky (the Flags column is 120 px: a stream's roll-up
runs to three digits on the sample plan): the name (a tree indent of 16 px per level), Flags, Operations. A **work stream / program row** shows its name with
the owner dimmed (and "(closed)" for a stream with an end date), a read-only `tone: "summary"` bar over the span its projects cover
(`programs.streamBarAria`/`programBarAria`) and the **roll-up counts** of its projects' flags in the Flags cell (the project row's icons: an orange triangle and
a gray info circle with a visually hidden sentence, `data-flags`); a node with nothing under it (an empty program) shows no chevron. A **project row** is the
roadmap's row — `projectTrack`: the target-window band, the span bar (with ", N conflicts"), the drift band — with the name as the link into the project (the
owner dimmed) and a menu that holds "Open project" and, by the project's own `can.editTargetWindow`, the window items. Row ids are `ws:<id>` / `pg:<id>` / the
project id; bar ids the same (`ws:`/`pg:` keys, the project id) so the arrows anchor on the project ids as on the roadmap.

**The baseline overlay (v0.9):** the same picker, shadow bar (`projectTrack`) and totals line as the roadmap (since 1.10 the view lists its removed projects too: the line
counts them, and each is appended as a dimmed "(removed)" row under its program when that program is shown and expanded - `treeRows`' `removedProject` kind,
`ProgramsTimeline`'s `RemovedLabel`; they count as the program's children, so a program whose live projects are all deleted can still be expanded; a removed project of a gone, hidden or folded program has no row); a work stream and a program row also get a shadow bar from their own `baseline.span` (a work stream the program pick shows in part: the union
of the shown programs' frozen spans, named without a movement sentence). The query key `["roadmap","programs",{baseline}]` carries the pick. Tests:
`Programs.baseline.test.tsx`.

**The Jira markers (1.3):** the same "Jira dates" toggle (after the baseline picker, the one stored `timeline.jiraBars`, on by default, only when the view lists
a Jira site) and the same project-row bar `jira:<id>` (`projectTrack`; a project row only - work stream and program rows are not bound); the roll-up counts in
the Flags cell and the facts badges stay severity-driven. The page has no flag panel. Tests: `Programs.jira.test.tsx`.

**Expand / collapse.** A node with children has a chevron `ActionIcon` as the ONE roving stop of its name cell (a function cell), `aria-expanded`, its name
telling the level ("Work stream X" / "Program Y", `programs.streamAria`/`programAria`; no `aria-controls` — the child rows are separate grid rows without ids).
Enter/Space flips it, the focus stays on that chevron ("The expanded set" below) and the page SAYS what happened in its polite status region ("X expanded, 3
programs", "X collapsed"). Defaults: every work stream open, every program closed (≈ 25 rows on the sample plan; "Expand all" there is ~125 rows = the virtual
path); **Expand all / Collapse all** buttons in the facts row. The expanded set is **page state, not persisted**.

**The program pick** is the roadmap's — ONE stored key `planning.programPick` (`hooks/useProgramPick.ts`), the same `ProgramPickField` (its labels
`common.filter.*`) in a `FilterPanel` (stored `programs.filtersOpen`); read through `pickAmong(programChoices(view), stored)` (a stored id the plan no longer
has is ignored). A picked program keeps its work stream's row; a stream with no picked program is hidden; a stream the pick shows in part is rolled up over the
programs that remain ("Roll-up in part" below). The facts line ("N work streams · M programs · K projects", an orange "K warnings" and a gray "J infos" badge)
counts what is shown. **Arrows**: `planArrows` over `view.links`, only between the project rows that are SHOWN (a folded program leaves its projects' arrows
out). **Zoom**: Month / Quarter / Year under `timeline.planZoom` (the roadmap's key), the range grows over every span and window of the WHOLE plan. Tests:
`utils/programsTree.test.ts`, `pages/Programs.test.tsx`, `api/programs.test.ts`; the real browser is `e2e/tests/programs.spec.ts` and the axe scans in
`accessibility.spec.ts`.

- **One project-row builder.** `projectTrack(project, t, conflicts)` is the only place a project's bars and drift band are made (`window:<id>` and `<id>` bars,
  `drift:<id>` band), `planArrows` the only place the rolled-up links become arrows; `RoadmapTimeline` and `ProgramsTimeline` both call them, so the target
  window's gestures (an editable `window:<id>` bar by the project's `can.editTargetWindow`, the draw surface on a row without a window) land once; the menu's
  window items are `TargetWindowItems`. Row/bar ids never collide on the programs timeline: project rows use the numeric project id, work stream / program rows
  the strings `ws:<id>` / `pg:<id>` (also their bars' ids).
- **The expanded set** is `useState<ReadonlySet<string> | null>(null)` in `ProgramsBody`: `null` means "the defaults" (`defaultOpen(view)`: every stream), so a
  work stream that appears with a refetch opens; any change (a chevron, Expand all, Collapse all) writes a concrete set from what the user sees. `toggle(key)`
  finds the row in the CURRENT rows to say what it did (`programs.announce.*` with a plural `count`); while the rows stay on one render path the chevron button
  is the same DOM node before and after (rows are keyed by id), so it keeps the focus and the roving grid re-adopts it as the tab stop. **When a toggle crosses
  the virtualisation threshold (80 rows) it is NOT**: the Timeline swaps plain for virtual rows (or back), every row remounts and the pressed chevron is lost (a
  freshly enabled virtualiser also mounts no row on its first render). So `toggle` records the node key in a ref and an effect, after the render, leaves the
  focus alone only when `[data-node-key=<key>]` is the active element and otherwise calls `timelineRef.focusRow(key)` (the roadmap's `refocus` pattern; the
  virtual path scrolls to the row and the Timeline's layout effect focuses it once mounted). Pinned by `Programs.virtual.test.tsx` (Expand all, an Enter
  collapse staying over 80 and falling under it, a single toggle crossing up and back).
- **The pick.** `programChoices(view)` lists every program (empty ones too) and `pickAmong` reads the stored ids against them; the roadmap passes its own
  `programOptions(view)` (programs with projects) to the same function. An id only one of the pages knows is ignored there, not dropped from storage. The
  `MultiSelect`'s clear button is `aria-hidden` (Mantine), so tests and e2e find it by its label (`getByLabel`), not by role.
- **Roll-up in part.** `shownStreams` (inside `programsTree.ts`) keeps the server's span/counts for a stream shown whole and recomputes them (`unionSpan`,
  `sumFlags`) for one the pick shows in part. Nothing else on the page is computed.
- **No `TimelineDndContext`.** Nothing on the page is draggable yet, so the `Timeline` is mounted without a drag context (it works without one); the target-window step wraps it like the roadmap.
- **Tests.** `Programs.test.tsx` runs the page against a one-endpoint fetch mock (default open set, the chevron by pointer and keyboard, the status sentences,
  Expand/Collapse all, the project row, the arrows appearing and leaving with the fold, the pick and its shared key, Year zoom, empty and failed loads);
  `programsTree.test.ts` and `api/programs.test.ts` are pure.

## Baselines (`pages/Baselines.tsx`, `pages/BaselineCompare.tsx`, v0.9)

`/baselines` (nav: Planning after Programs, `IconCamera`, **for everyone**; palette "Baselines" / PL "Bazy odniesienia") is the registry of the named, frozen
copies of the plan, `GET /baselines` under `["baselines","list"]` through `hooks/useBaselines.ts` (`{items, can, loading, failed, error}`, `staleTime` 1 minute,
the `useHolidays.ts` shape - the timelines' picker reads the same cache). The list is a BOUNDED set (the cap is 100, newest first), so it is ONE unpaged table
in a `ScrollRegion` (no `RegistryListTable`: it carries a pager), not the Teams page's paged shape: Name (the link into the comparison, `baselines.openAria`),
Description, Taken (`YYYY-MM-DD HH:mm`, read in UTC, the header says so), Plan revision, Taken by, Milestones, Projects. **What a row offers comes from the
list's `can.manage`** (ADMIN or a `ROADMAP_EDITOR`, the server's arithmetic - never the session's roles): "Take baseline" and the row menu (Rename..., Delete)
exist only with it. `components/BaselineEditorModal.tsx` is take (name + description, then the server copies the plan) and rename in one; the take's 409 is told
apart by `isBaselineLimit` (the problem type `urn:astrolabe:problem:baseline-limit`): the cap reads "The limit of 100 baselines is reached: delete one first" as
the dialog's alert, any other 409 is a name clash and marks the name field. At 100 rows the page says the cap is reached instead of counting. **Every write
bumps the plan revision**, so a take, rename or delete refreshes `["baselines"]` AND `["plan"]` + `["roadmap"]`; a delete of a baseline already deleted
elsewhere (404) says so and reloads the list.

`/baselines/:id` renders `GET /views/baseline/{id}` under `["baselines","view",id,{against}]` (read, never recomputed - the server counts the working days on the CURRENT
calendar): the facts line (taken, by whom, the plan revision, the counts; "The plan has not changed since this baseline." when the view's `revision` equals the
baseline's `planRevision`), the **totals** of milestones and of projects as badges (`utils/baselineOverlay.ts` `movementTotalsParts`: an ORANGE "N end later",
gray for the rest, "No schedule changes" at zero), and the **Changes** table - ONE plain table in a `ScrollRegion` (`maxHeight` 70vh, <= 1,000 rows, no
virtualisation) grouped by project: the project row (name = link into `/projects/:id`, program > work stream, the span movement as a sentence and its
milestones' counts, the two spans, Start/End in signed working days, Status) then its CHANGED milestone rows (team, baseline and current dates or "Unscheduled"
or a dash, Start/End deltas, the estimate "10 -> 12.5", Status). **The Status badge** is `movementStatus`: ORANGE "Later" exactly when a moved row's END is
later (the user's rule), gray "Earlier" / "Moved" / "New" / "Removed" / "Scheduled" / "Unscheduled" / "Unchanged" - and gray "Re-estimated" for an estimate-only
change, which the server lists as a changed row though its kind is `UNCHANGED`. Client-side, unpersisted filters (`utils/baselineCompare.ts`, pure): a team
`Select` (the teams of the listed rows; keeps only the projects that have a row of it), a project-name text filter (case- and accent-insensitive) and "Changed
projects only" (on by default; a project stays when it changed itself, its counts show a change, or it has a listed row). A malformed or unknown id is the
not-found alert (`EditPageLoadState`, under the page's h2) and a malformed one never asks the server. Strings: `baselines.*` (`movement.*` and `totals.*` are
the shared sentences; PL has the full `_one/_few/_many/_other` set). The picker, the shadow bars and the Movement section on the timeline pages reuse
`movementSentence`, `movementStatus` and `movementTotalsParts` (see "Timeline mechanics"); here each project row has a "Show on timeline" button and the header
a "Show on the roadmap" one - both set the browser-wide pick (`useBaselinePick`) before they navigate. **Two baselines (1.7):** `components/BaselineCompareControls.tsx` is the
"Compare against" `Select` (the live plan, the default, or any OTHER baseline newest first with its plan revision; the URL's `?against=N` is the state, so a comparison is a link; a
malformed or own id is ignored, the typed 400 `unknown-baseline` drops the parameter with an inline note); this baseline stays "then", the facts line and the Then/Now column headers name
both sides, a project row gains the rank sentence ("Rank 3 → 5", `utils/baselineCompare.ts` `rankSentence`, none for a new or gone project) and both "Show on ..." buttons are hidden (a newly picked "now" that fails to load with anything but the typed 400 keeps the page chrome and the picker mounted with the error inline, so the live plan or another baseline can be picked; a failure with no `against` is the load-error page; the overlay is one
baseline against the live plan). Tests: `Baselines.test.tsx`, `BaselineCompare.test.tsx`, `BaselineCompare.against.test.tsx`,
`baselines.test.ts`, `useBaselines.test.tsx`, `baselineOverlay.test.ts`, `baselineCompare.test.ts`.

### The baseline pick on the timeline pages

**The baseline overlay (v0.9, every timeline page).** ONE browser-remembered pick (`hooks/useBaselinePick.ts`, key `timeline.baseline`, none by default) selects
the baseline all four pages compare with: `components/BaselinePicker.tsx` in the Timeline's `toolbar` slot (None + the baselines newest first, the first
"(latest)"), `?baseline=N` on the view getters, the pick inside every query key (`["plan","team",id,{baseline}]`, ...; the optimistic steps keep the cached
`baseline` block; a write is refused while the shown copy is the previous pick's placeholder, rolls back into the entry it was made on and stores its revision
into the entry it was made on ONLY (the roadmap ranking and the schedule, pin, team-order and proposal-accept writes: a sibling pick's entry still holds the old order and dates, so it keeps its old revision and a write there is a 409); the picker is disabled while a write runs), the typed 400 `unknown-baseline` clearing the pick once (`useDropUnknownPick`), shadow bars
and appended rows from the pure `utils/baselineOverlay.ts`. The project and team pages add the Movement section (`components/BaselineMovement.tsx`), the plan
pages one totals line (`components/BaselineTotals.tsx`); the comparison page's "Show on timeline" sets the pick. Reference and the details: `timeline.md` "The
baseline overlay (v0.9.0)".

## Schedule proposals (`pages/ScheduleProposals.tsx`, 1.8)

`/schedule-proposals` (nav: Planning after Baselines, `IconCalendarStats`, **for everyone**; palette "Schedule proposals" / PL "Propozycje harmonogramu", keywords proposal, schedule,
cross-team; path `utils/scheduleProposalLinks.ts`) runs ONE proposal over several teams (`POST /schedule-proposals`: the teams in dependency order to a fixed point, `planning-model.md`
"The cross-team run") and accepts the ticked moves of every team in ONE plan write. **What it offers comes from the server:** the `MultiSelect` (`maxValues` 50, searchable, disabled while a
run is requested or open, picks the server no longer lists are dropped at Propose) is filled from `GET /schedule-proposals/teams` under `["schedule-proposals","teams"]` (an ADMIN: every
active team; otherwise the teams the caller manages; an ADMIN also gets an **"All teams"** button beside it that ticks the first 50 listed at once, the run's `teamIds` ceiling, disabled while a run is requested or open); an empty list is the `EmptyState` "You manage no team" with no multi-select and no Propose; the server's 403/404/400 on the run reach the page
inline (`scheduleProposals.forbidden/gone/invalid`, then the generic action words). Wrappers in `api/scheduleProposals.ts` (`listProposalTeams`, `proposeCrossTeamSchedule`,
`acceptCrossTeamSchedule`, `checkSchedule`).

**The run** is page state in `hooks/useCrossTeamProposal.ts`, the team page's `useScheduleProposal` state machine over a run: `propose(teamIds)` (local `asOf`; a run with no move in ANY team
opens nothing and leaves the same two notes as the team page), ONE `selected` set over every team's move ids (milestone ids are global), `toggle`, `selectAll(teamId)` / `selectNone(teamId)` (a
section's header checkbox acts on THAT team's moves; the status region says the run-wide "n of N selected"), `discard()` (not while the accept runs), `dismiss()`. `accept()` posts
`{expectedRevision, scopeHash, teamIds (the run's blocks), items}` for the ticked moves of all sections on the write key `["schedule-proposals","accept"]`; while it runs a second accept
or Propose is refused out loud (`refused`, the `role="note"` "A save is still running", `project.busy` announced; Discard answers `false`). On success the preview closes, `["plan"]` and
`["roadmap"]` refresh in the background (no cache patch: the page holds no view) and `outcome` is the inline note ("N scheduled · M skipped: reasons", the fixed `teams.proposal.reason.*`
vocabulary; no toast). `409 stale-revision` closes the run with the reload note; **`409 stale-scope`** closes it, re-proposes the SAME teams at once and keeps the ticks of the moves that still
exist (`rescoped`, orange note); any other failure is the inline `FormErrorAlert` above the buttons, which takes the focus, with the run open. The page owns the ONE polite status region
(`VisuallyHidden role="status"`, the zero-width-space re-read flip) the hook announces into; `useProposalFocus` (made structural, `{applying, rescoped}`) hands Discard the focus when a run
opens and Propose gets it back.

**The page** (a `Stack`, h2 `PageHeader` with Propose in `actions`): the multi-select, `ProposalNotes` (its prop is the structural `ProposalFlow`), then with a run open `components/CrossTeamFacts.tsx`
(`role="note"`: gray "Placed in N pass(es) · settled"; an ORANGE Alert when `!settled`: "Not settled after 5 passes: the teams depend on each other in a loop, so every pass moved something again.
The dates shown are the last pass's - check the link warnings before you accept"), one `components/CrossTeamProposalSection.tsx` per block of `teams[]` in PLACEMENT order, the accept's alert
and ONE **Accept selected across teams (N)** (primary) with Discard. A section is an h3 (the team's name, a dimmed "placed n of N") holding the team page's `ProposalTable` (named per team
through its `label` prop, so no two tables share a name; "Accept all" in its header acts on that team) and, collapsed, `TeamWeeklyLoad` with `labels` (an h4 "Proposed load", the table named per team);
with no move ticked anywhere there are no `weeks` and the section says "Tick a move to see the load after accepting it". **The ticked-subset check is `useScheduleCheck`** with ALL the run's team ids and
every team's moves; `overlayCheck(block, check, block.teamId)` gives each section the verdicts and load of the ticked moves (all ticked = the run's own, none = no new warnings, some = the check's answer
once in), and `ProposalTable` words "Checking the ticked moves..." / the failure under each summary. Closing the run drops the `["plan","schedule-check"]` queries. The hook returns `words` (`ProposalWords`, an optional override of `ProposalFlow`): the no-capacity, stale and re-proposed notes and their announcements speak of "the chosen teams" (`scheduleProposals.noCapacity/stale/rescoped`), not of one team or a schedule to reload. A run that did not settle is announced in the SAME sentence as the ready one (two announcements in one batch keep only the last). `accept()` sets a synchronous in-flight ref (cleared in `onSettled`) so a double click sends ONE request and the second is refused out loud. Strings: `scheduleProposals.*`
(`appShell.nav.scheduleProposals`), the accept/discard/outcome words reuse `teams.proposal.*`; an administrator with no team at all reads "No team to propose for yet" (the words only: `useAdmin()` gates nothing). Tests: `ScheduleProposals.test.tsx`, `CrossTeamProposalSection.test.tsx`,
`useCrossTeamProposal.test.tsx` (fixtures `test/crossTeamRun.ts`).

## Deviations, bindings and the Jira chips (`pages/Deviations.tsx`, v1.1.0)

`/deviations` (nav: Planning after Baselines, `IconGitCompare`, **everyone**; palette "Deviations" / PL "Odchylenia") is where the plan and the linked Jira
items disagree: `GET /views/deviations` under `["jira","deviations","view",filter]` through `hooks/useDeviations.ts` - ONE purpose-built document
(`{revision, asOf, connections[], totals, items[≤2,000], truncated}`), unpaged, `api/deviations.ts`. **Reading never touches a timeline view**: every query here
lives under the `["jira"]` prefix (the page's second section, Capacity from Flow, under `["flow"]`). A refresh (Refresh now, a connection edit) refreshes
`["jira"]` only; a write that changes the Jira flags and bars the four timeline views carry - a bind, an unlink, the import's apply, an acknowledgement - goes
through `refreshJiraAndTimelines` (`utils/queryRefresh.ts`: `["jira"]`, `["plan"]` = plan, project and team views, `["roadmap"]` = roadmap and programs; a
scheduled poll has no write here, open pages catch up on focus). It refetches on window focus and, while the SERVER says a run is running
(`connections[].lastRun.running`), every 10 s (`DEVIATIONS_POLL_MS`; the run table's 3 s is too eager for this big document) through `useBoundedPoll`, the C8
rule: the response that first reports the run finished carries the new data.

**The URL holds the filters** (`utils/deviationFilters.ts`, pure: `parseDeviationFilter`/`deviationFilterParams`): `connectionId`, `level`, `severity`, `kind`,
`workStreamId`, `programId`, `projectId`, `teamId`, `acknowledged`, `all`; a malformed or unknown value is dropped (a stale link never breaks the page), a
change `replace`s the entry, the chips link in with a normal navigation, so Back and a reload restore the view. The panel (`components/DeviationsFilters.tsx`)
holds a select each for **Status** (Open / Acknowledged / All, first), connection, plan item type, severity, work stream (from `GET /views/plan`, the page's
cache entry) and team, plus the **"Show everything"** switch (`all=true`: items with no deviation AND the `ESTIMATE_NOT_COMPARABLE` lines, which are never
listed otherwise nor counted by a chip; a project or team scope IMPLIES `all` server-side, so the switch reads ON there and turning it off sends `all=false`,
which the URL accepts); a project / program / kind scope from the URL is a removable chip beside the toggle ("Project: Invoices"), named from the plan view.

**Acknowledge** (1.3, per LINE since 1.12; `hooks/useAcknowledge.ts`, `components/DeviationAckCell.tsx` = a line's sentence and button, `DeviationAckAll` = the batch buttons at the head of a
row's lines, `DeviationAckOrphanNotice`; `POST`/`DELETE /integrations/jira/bindings/{id}/acknowledge`). **Status** (`deviationStatus`/`deviationStatusPatch`, `utils/deviationFilters.ts`) composes with
the URL as the server does: Open sends NOTHING (the server lists the open items), except under a project/team scope, which implies `all`, where it sends the
override `all=false` (so does ADDING a scope while Open, `keepStatus`; REMOVING the last scope falls back to the default Open list, the implied All being the
chip's; `acknowledged=false` in a URL is dropped); Acknowledged sends `acknowledged=true` (and keeps an explicit `all=true`); All sends `all=true`; a scope
reads All. The "Show everything" switch writes the same `all`, so All and the switch are two views of one parameter. **There is no Acknowledgement column**: the
Deviations cell lists every LISTED line of the row (`items[].deviations[]`, whatever the Status - a row on the Open list shows its acknowledged lines too), each
as the kind badge (gray once acknowledged, `SeverityBadge dimmed`) and the sentence, and under it the line's own acknowledgement (`DeviationLine.acknowledgement{at, by, current}`; the
deprecated item-level `acknowledgement` is NOT read): "Acknowledged by X on D" / "Acknowledged on D by X · changed since" (a stamp whose line changed is `current: false`,
the line is open again; a deleted acknowledger drops the name) and ONE button (`isLineOpen`, `utils/deviations.ts`): **Acknowledge** for an open line (no stamp or a stale one),
**Unacknowledge** for a current one - both only with the item's `can.acknowledge` (a pure RIGHTS flag; a clean row has no lines, so no button). The buttons name the line by
Jira key and kind ("Acknowledge E2E-6: End"), carry `data-ack-for="<bindingId>:<KIND>"`, are `aria-disabled` + `data-disabled` (Mantine's disabled look; never `disabled`/`loading`:
they lose the focus) and ignore clicks while ANY write runs. A line is `POST {fingerprint: item.fingerprint, kind}` / `DELETE …?kind=KIND`. **Acknowledge all (N)** /
**Withdraw all (N)** (the port of Flow's `CapacityAckAll`; named "Acknowledge all (N) open deviations of E2E-6" / "Withdraw all (N) acknowledged deviations of E2E-6") head the lines when
at least two LISTED lines are open (a stale stamp counts) / currently acknowledged; one open line has only its own button. The batch is the same two calls WITHOUT `kind`
(`POST {fingerprint}` stamps every line without a current acknowledgement; `DELETE` clears every stored stamp of the binding, stale ones too), both with the key
`<bindingId>:all` (`data-ack-for`, busy, notice), and the success toast, re-read, 409 note, refusals and focus rule of a single line. N counts the lines the row lists: a hidden
`ESTIMATE_NOT_COMPARABLE` line (shown under `all=true` only) is not in it, though the kind-less POST would stamp it. **A success re-reads `["jira"]`, `["plan"]` and
`["roadmap"]`** (a current acknowledgement silences the Jira flags on all four timeline views); a `409 stale-deviations` is the orange inline `role="status"`
note "The deviations changed since you looked" plus the same re-read, never a toast and never the red alert; a 403/404 is a red inline message and re-reads
`["jira"]`; the note or message shows under its OWN control (`AckNoticeAlert`; a row far down must see why its button did nothing), above the
table with a scroll-into-view only once that control has left the list (`DeviationAckOrphanNotice` over the keys of the rendered rows, `itemAckKeys`); a DELETE's 404 reads "already withdrawn", not "link gone";
messages clear on the next write or whenever the filters' URL string changes (Back, a chip link and "Clear the filters" included), and a write that settles after that sets none. **Focus**:
after a write that re-reads, `useDeleteConfirm`'s rule at every render and once after the re-read (focus on `body` -> the control's own button if still there (a line's Acknowledge becomes its
Unacknowledge under the same key, the two batch buttons share the all-key), else the row's other controls, the next row's, the previous row's, else the list's h3 `tabIndex={-1}`; anywhere else -> leave).
Totals gain a gray "N acknowledged" (`totals.acknowledged`: bindings with a current line), and under any Status but Open a line says the warning/info/gone figures count open items only (the
server counts open LINES); an Open list that is empty while acknowledged items exist reads "Nothing is open" with the count hidden. Tests: `Deviations.ack.test.tsx`, `Deviations.ack.lines.test.tsx`
(per line, the batch, counts, `can` false), `Deviations.ack.refusals.test.tsx`, `DeviationAckCell.test.tsx`, `utils/deviations.test.ts`, `api/deviations.test.ts`.

**Honesty about currency** (the page never implies the data is fresh): "Data from Jira" (`components/DeviationsSources.tsx`, h3) is one row per connection with
its newest run as the C8 helpers read it (`utils/syncRuns.ts` `runState`: the server's `running`, `finishedAt: null` and not running = **Interrupted**) and the
notes that qualify the figures - never refreshed ("as they were when each item was linked"), the last refresh FAILED (with `errorCodeText`, the code kept
visible), abandoned/interrupted, the connection DISABLED (its items are listed and unlinkable but stale), and **`mappingOk: false`** ("levels and estimates are
not compared for its items"). An orange `role="note"` above the list says it may be out of date when any ENABLED connection's newest run is missing, failed,
abandoned or interrupted, or its mapping does not fit (`hasStaleSource`/`staleConnection`, `utils/deviations.ts`; the any-enabled-stale and oldest-success folds are the generic `hasStaleSource`/`verifiedAt` of `utils/staleness.ts`, which Flow's twins in `utils/capacityDeviations.ts` share, each connector passing its own stale rule and success accessor). The column is "Last run", not "last refresh"
(a failed run is a run). **Refresh now is ADMIN-only** (per connection, `POST /integrations/sync/runs`; a `409 run-in-progress` is a normal state: no error and
no note of its own, the page re-reads and its status line says a refresh is running; a `429` of the per-user `sync-run` bucket, 1.13.1, reads "Too many requests. Wait a minute and try again." (`common.error.tooManyRequests`) in the inline alert, here and on the connection pages). Each row's last column is "Data as of": `jira.observedAt` aged ("5 minutes
ago", the exact UTC time in its `title`) - it is when Astrolabe last CAPTURED that item (the bind, or a run in which Jira reported it changed), NOT when it was
linked and not when a run last looked, so it can be older than the connection's last run; a gone item or a disabled connection adds "stale". A gone item's Jira cell badge reads "Gone from Jira", or "Moved out of scope" when its GONE line's `detail.jira` is `MOVED_OUT` (1.12: a probe still read the issue, under a key outside the connection's projects; the sentence is "Moved out of the connection's projects (Jira still has it)", `deviations.phrase.goneMovedOut`), or "Not listed by Jira" for `NOT_LISTED` (1.13: the key it answered with is inside them; "Still in the connection's projects, but Jira no longer lists it (archived, or its type changed)", `deviations.phrase.goneNotListed`); one helper, `goneBadge(reason)` in `utils/deviations.ts`, maps a reason to `movedOut | notListed | gone`, and the key link already shows the binding's current (followed) key. The age is measured
against the browser's clock (`dataUpdatedAt`) from the server's `observedAt`, so the two clocks can differ by their skew: accepted, the tooltip carries the
exact UTC time and the age is cosmetic. **The chips on the project and team pages are the exception that proves the rule**: they are built from the timeline
view, which carries no connection status, so they show the LAST OBSERVATION and say nothing about whether it is current (1.1's "may be out of date" qualifier is
gone; a `BACKLOG.md` item brings it back with a per-site status on `jiraSites`). Whether a connection is stale, failed or disabled is told on the Deviations
page and the connection pages only.

**Counting words**: the totals badges are the server's `warnings`/`infos` over every match before the cap (orange / gray, the roadmap flag vocabulary; red is
never used); **the gone figure is split (1.13)**: "N gone from Jira" shows `totals.gone - totals.stillInJira` and a second gray "N still in Jira, out of scope" shows `totals.stillInJira` (`deviations.totals.stillInJira_*`), each hidden at 0; "N items shown" is `items.length`, `truncated` is an orange note; **`totals.bindings` is never worded as "how many are linked"** - it counts only
deviating bindings unless `all` applies. The empty list is told apart: no connection (an ADMIN gets the link to Administration, Jira; anyone else "an
administrator has to add one"), nothing linked (asked by `GET /integrations/jira/bindings?pageSize=1` `total`, only when it decides the wording), the filters
match nothing (+ "Clear the filters"), an empty list is a claim about a READ and is DATED: "No deviations in the data read at 2026-11-06 10:01 (UTC)"
(`verifiedAt`: the oldest finish among the connections, and only when every connection is enabled, its mapping fits and its newest run SUCCEEDED - a disabled
one may hold bindings nobody refreshes - because 1.1 has no scheduler and the present tense is not earned), else "No deviations in the data read so far". A
project or team scope whose own `totals.bindings` is 0 (with `all` in force, that is every link in scope) reads "Nothing here is linked", never "no items
match". While a new filter's answer is on its way (`isPlaceholderData`) the kept answer belongs to the OLD filters, so a busy status stands in for any
empty-state claim.

**The sentences** (`utils/deviations.ts`, pure, EN/PL with `_one/_few/_many/_other`): `deviationSentence(deviation, item, t)` for every `DeviationKind` - "Ends
3 working days later than Jira (plan 2044-01-12, Jira 2044-01-08)": **`detail.days` is in working days, POSITIVE = the plan is later** (so a negative figure
reads "earlier"); the dates are appended only when BOTH sides are known (a date is never made up from an absent one), a missing or zero figure degrades to "ends
on a different day", `TARGET_DIFFERS` (days is the end's shift, else the start's) is a neutral sentence with no count (the dates column carries the figures),
and `ESTIMATE_NOT_COMPARABLE` (no conversion declared, OR the figure was read under another unit than the mapping names now) names neither cause. **Coverage
kinds (1.4):** `UNLINKED_IN_JIRA` ("3 Jira items are not in the plan: COV-5, COV-6, COV-7", `detail.jira` = the keys), `UNLINKED_IN_PLAN` ("1 plan item is not
linked to Jira: Rollout", `detail.plan` = the names) and `CHILDREN_DONE` ("All 2 child issues are done in Jira while the plan ends 2046-03-01", `detail.count` =
the children, `detail.plan` = the plan's end) with its mirror `CHILDREN_OPEN` (1.14: "3 of 12 child issues still open in Jira while the plan ended 2046-03-01", the open
figure parsed from `detail.jira` = `open/children`; PL "Otwartych zgłoszeń podrzędnych w Jirze: 3 z 12, a plan zakończył się …"; unreadable members degrade to the label "Children open"); **the "+N more" rule**: the server lists at most 10 keys/names and `detail.count` is the full figure, so the
sentence appends "and {N} more" (PL "i jeszcze {N}") when `count` exceeds 10 - the listed figure is `min(count, 10)`, never a split of the joined text (a plan
name may contain ", "); a missing list, count or date degrades to the plain kind label. The roadmap panel phrases these through the same function. Severity is
spelled in a visually hidden word before each kind badge (`components/SeverityBadge.tsx`: orange warning / gray info; the Deviations table, the Flow capacity lines and the team page's fact use it, the roadmap flag panel with `hiddenPrefix={false}`). `ageText`/`countDeviations` are in the same file; the table is `components/DeviationsTable.tsx` (plan
item with its link into `/projects/:id` - a milestone's through its project -, the Jira key through `JiraKeyLink`, both sides' dates, the sentences, the age)
in a `ScrollRegion` (1,080 px minimum: a phone scrolls it); the acknowledgement is per line inside the Deviations cell (above). Tests: `Deviations.test.tsx`,
`utils/deviations|deviationFilters|jiraMarks|jiraBind.test.ts`, `hooks/useDeviations.test.tsx`, `api/deviations.test.ts`.

**The bind dialog** (`components/JiraBindDialog.tsx`, `JiraBindNodePicker.tsx`; used on the connection page and the project page):
`POST /integrations/jira/bindings`. It works for a plan OWNER who is no administrator, for whom the connection registry is forbidden, so it asks for nothing
itself: the `source` prop is what the page has - the connection page's own connection (fixed; `mappingOk` is taken as true there, a stale mapping is the
server's inline 409), the project page's `useJiraLinks` `connections[]` (asked only while the dialog is open: a pending or failed answer is the dialog's own
note, with Retry) - and only `enabled` ones are offered, exactly one is preselected (with two or more and none chosen, a note says why Link is disabled), one
with `mappingOk: false` is marked "(mapping needs fixing)" and refuses the link in words, none says so plainly (an ADMIN gets the link to Jira, anyone else "an
administrator has to add one"). `target` fixes the node (project header, milestone row menu: no picker); `connectionId` fixes the connection (the connection
page). Otherwise a level select and a picker: **programs from `GET /views/plan`** (no list exists; only those with `can.edit`), projects and milestones through
the dependency editor's paged pickers (`ProjectSelect`/`MilestoneSelect` take `label`/`description`). **Every refusal is inline with the entered key kept**
(`utils/jiraBind.ts` `bindFailure`): 400 (the server's sentence under a fixed lead: unknown issue, outside the connection's keys, wrong level), 409
`already-bound` (the sentence names the other side), 409 `jira-mapping-invalid` / `jira-not-discovered` / `jira-token-unreadable` (an administrator's to fix),
429 (the per-user `jira-bind` bucket), 502 (Jira's code in words), 403, 404; success is the toast "Linked to Jira" + `refreshJiraAndTimelines`. **`can.edit` is
the bind's guard**: the owner chain or ADMIN (`PlanPermissions.canManage` = `requireOwnerOrAdmin`; a milestone's `can.edit` is its project's), so "Link to
Jira…" shows with the node's own `can.edit` and a team manager who owns nothing sees none. A node the page's view says is linked is never offered the link
(1:1): with `can.edit` the OWNER gets "Unlink from Jira" (the project header button, replacing Link; a milestone's red "Unlink from Jira: KEY" menu item)
through `hooks/useJiraUnlink.ts` + `components/JiraUnlinkModal.tsx` (the delete-confirm pattern shared with the connection page's table:
`DELETE /integrations/jira/bindings/{id}`, `refreshJiraAndTimelines`, focus to the page heading, 403/404 inline); without it the key shows as a disabled line.
The header's Link/Unlink read the view's own `jira` blocks, so they are right from the first render. Program bindings are linked and unlinked on the connection
page only (`BACKLOG.md`).

**The bindings list** (`components/JiraBindingsSection.tsx`, the connection page's third h3 section): `GET /integrations/jira/bindings?connectionId=` paged
(sort `issueKey`/`createdAt`), a level filter and the `q` name filter, a gone mark ("Gone from Jira", "Moved out of scope" from `observation.goneReason === "MOVED_OUT"`, or "Not listed by Jira" from `NOT_LISTED`, through `goneBadge`; the key shown is the binding's current one), **Unlink** through `useDeleteConfirm` + `ConfirmDeleteModal`
(`confirmLabel`; focus returns to the section's h3) and "Link a node…" (disabled while the connection is disabled). The server hides bindings of deleted plan
items, so a row is not always there and the list may differ from a connection delete's count by those.

**The import modal** (1.2, `components/JiraImportModal.tsx`; entry points: since 1.10 "Import from Jira…" beside "Link a node…" in the bindings section - ADMIN's
page, disabled until the connection is enabled and has a stored discovery - and the Plan page's work-stream menu, and since 1.14 a linked program's menu, below): ONE wide `Modal` (title = the h2, phases are h3) in three phases, state in
`hooks/useJiraImport.ts`, pure model in `utils/jiraImport.ts` (ticks, scope, body), sentences in `utils/jiraImportText.ts`. **Scope** (`JiraImportScopeStep`:
work stream from `["plan","view"]`, owner, Jira project keys all preselected, **the import filter (1.13.3)**, "Copy Jira's dates", default team / program / project - the last two offered only
from the picked stream, the server's own rule) -> `POST …/import-preview`; **Preview** (`JiraImportPreviewStep`: totals, notes, "N of M selected", a virtualised
table - `JiraImportVirtualTable`, TanStack Virtual above 80 rows, fixed row height, `aria-rowcount`/`aria-rowindex`, shared with the outcome's skipped list -, a
checkbox per CREATE/BIND row, SKIP rows say why in words) -> `POST …/import`; **Outcome** (counts created / linked / scheduled / skipped, every skipped row with
its reason, "Preview again" when rows read `CHANGED`). **Ticks keep the dependencies true**: unticking a row unticks what is created under it (`dependsOn` =
`parent.rowJiraId`; the server would answer `PARENT_SKIPPED`), the rows show "Not imported: its parent X is not ticked" and a polite status says how many moved;
ticking a row ticks the rows it lands under. **The body is strict**: `expected.parent` is projected to `{kind, nodeId}` (never the preview's `parent` verbatim),
a BIND carries `nodeId`, a milestone CREATE the `teamId` the row showed; a per-row team `NativeSelect` goes to `overrides.teamId` and never into `expected`; **(1.14)** a program or project row that would be CREATED has a compact owner picker (`PersonSelect compact`, aria "Owner for KEY", opened on the dialog's owner; clearing it goes back to the dialog's owner; a milestone, BIND or skipped row has none), whose pick goes to `overrides.ownerPersonId` only when it differs from the scope's owner (`toApplyRequest`'s fifth parameter, `hasOwnerChoice`), the picks are page state of the preview step and reset with a new preview; the
apply sends the SCOPE the preview was read under. `totals.truncated` disables Import (narrow the keys or the filter). **The filter (1.13.3)**: right under the keys, a
Switch "Leave out done items" (ON when the dialog opens) and a NumberInput "Updated within (days)" (365; `PollingFields`' idiom: `clampBehavior="none"`, bounds
`MIN/MAX_IMPORT_UPDATED_DAYS` 1..3,650 mirroring the server's, a value outside them shows the sentence under the field and disables Preview, `toScope` answers
null; EMPTY = no time limit; 0 is refused), the Switch's description carries two sentences: what "done" means and that a done or older parent of an item that is read is read as well when it is in the selected Jira projects (not "always kept": a parent outside them, past the 200-read cap or unreadable is not). `toScope` adds `filter{excludeDone,
updatedWithinDays}` only when a control is on (`{excludeDone: true}` with the field empty; NO member with both off = the request of before the filter), and
since the apply spreads the preview's scope it sends the SAME filter. The preview step reads `preview.scope.filter` (the filter the rows were read under, never the
form): one `role="note"` line "Left out: … Their parents in the selected projects are still read." in three wordings (done / window / both, plural on the days; none without a filter, and no count - the server does not report
one), the too-large alert names both causes (over 2,000 issues, over 200 parents read one by one) and the filter as the lever, an empty preview under a filter says
the filter may be why (or that the projects have none); a kept parent and a child whose parent could not be read show `KEPT_AS_PARENT` / `PARENT_UNREADABLE` among the row's notes (`infoText`).
Tests: `JiraImportModal.filter.test.tsx`.
**The preview search (1.13.4)**: a `ClearableTextInput` "Search the preview" above the table (page state, nothing stored, no API change) filters the rows by a trimmed,
case- and accent-insensitive substring (`foldDiacritics`, the rule of `foldedOptionsFilter`) over the Jira key, the Jira id, the summary and the plan name
(`searchItems` in `utils/jiraImport.ts`); a blank query shows every row. A row with no Jira key (a non-admin's row redacted under an active filter: a `hidden-n` placeholder
id, a blank name) NEVER matches a non-empty query. The search only HIDES rows: ticks and team overrides are untouched, "N of M selected" and **Import (n)** stay global, and
the apply sends every ticked row. While a query is active an always-mounted `role="status"` line says "Showing X of Y", Select all / Select none become "Tick shown" /
"Untick shown" and, with the header checkbox (its checked / indeterminate state too), act on the SHOWN selectable rows only through `tickShown` (`tickRow`'s
parent/child rules per shown row: ticking also ticks what a shown row is created under, unticking also unticks what is created under it, shown or not; the
existing live region says "Also ticked / unticked N items outside the search …", cleared when the search changes). No match: a `role="note"` "No rows match “…”." replaces the table, the box stays.
Tests: `JiraImportModal.search.test.tsx`, `utils/jiraImport.test.ts`. **Time**: each call owns an `AbortController` that
aborts at `IMPORT_TIMEOUT_MS` (180 s, over the server's 170 s browse), the visible wait has a Stop for a preview, one request at a time, and an apply is never
aborted by the client: the dialog cannot be closed over it, and leaving the page (Back, the palette) does not cancel it either (only an unmount mid-PREVIEW
aborts) - it finishes and still refreshes the plan; an answer that leaves the write in doubt (the 180 s abort, no server answer, a 5xx other than the server's
own 502: `applyMayHaveLanded`) says so, points at the "Links to plan items" list, offers Preview again and refreshes anyway. The app's rate-bucket 429 (this one, `jira-import`) carries
`Retry-After` in whole seconds (declared on the spec's `TooManyRequests`; the account-lockout and password-change-lock 429s carry none) but `ApiError` exposes no headers and the transport reads none: the message says to wait a minute (the `jira-import` bucket is 5/min, shared by preview and
apply). Failures are inline (`importFailure`), a 409 in the apply offers "Preview again". **After an apply the plan moves**, so it refreshes `["jira"]`,
`["plan"]` (plan, project and team views) and `["roadmap"]` (roadmap and programs) - the one Jira mutation that does. A non-admin's redacted SKIP row (empty
summary, the key as its name) renders the key, never a blank cell. The rows are one fixed 88 px (`IMPORT_ROW_HEIGHT`; clamped text keeps its full text in the
DOM and a `title`), there is no Level column (the cell under the key reads "Epic → milestone"), and the Skipped badge is orange only when some skip is not
`ALREADY_BOUND`. The "N of M milestones created unscheduled" note counts ticked rows the SERVER marked `DATES_NOT_COPIED`. Tests: `JiraImportModal.test.tsx`,
`.errors.test.tsx`, `.virtual.test.tsx` (the 2,000-row cap), `.source.test.tsx` (the connection source), `hooks/useJiraImport.test.tsx` (the in-flight guard, unmount),
`utils/jiraImport|jiraImportText.test.ts`, harness `test/jiraImportHarness.ts`; the server pins the same bodies in `JiraImportWebBodyTest.kt` (literal JSON
through the real deserialization and the kernel).
**The modal is connection-source driven (1.10)**, `JiraBindDialog`'s contract: props `{ source: ImportSource, initialWorkStreamId?, onClose }` (`utils/jiraImport.ts`:
`ImportConnection` = `{id, name, siteUrl, projectKeys}`, a `JiraConnection` is structurally one; `ImportSource` = `{connections | null, failed, retry}`). The connection page
passes `{connections: [connection]}`; the Plan page passes the deviations view's `connections[]` filtered to `enabled && mappingOk` (`usableImportConnections`). The scope
step opens with `JiraImportConnectionField` (loading text / a failed alert with Retry / the "none usable" note / the Select, read-only when exactly one; reusing
`jira.bind.connection|loading|loadFailed|retry`); the modal preselects exactly one, and changing the connection resets the Jira-project keys to the new one's (the rest of the
form stays). `useJiraImport(connectionId | null)` does nothing while null and Preview is disabled until a connection is chosen. `initialWorkStreamId` presets the stream
(`emptyScope(keys, workStreamId)`) and the stream Select is `readOnly`. The connection of the preview and outcome phases is kept even if a later refetch drops it.
**The Plan page's entries** (four entry points since 1.14: the connection page, the work stream's menu, a linked program's menu, a linked project's page header - "Project view"). The stream's (`PlanActions.importFromJira`, `PlanWorkStreamSection`): a `Menu.Item` "Import from Jira…" (aria "Import from Jira into {name}") under `can.edit`, after
Close/Reopen. `hooks/usePlanJiraImport.ts` holds the page's import state (`importing`: a stream OR a program with its link; `Plan.tsx` calls `useDialogFocus(jiraImport.modal !== null)`) and reads the connections with
`useJiraConnections({workStreamId}, importing is a stream)` (`hooks/useDeviations.ts`, key `["jira","deviations","connections",filter]`; `useJiraLinks` is its one-line
project wrapper) - the request appears only after the click. After an apply the plan page shows the imported tree (the hook refreshes `["jira"]`, `["plan"]`, `["roadmap"]`).
**The rooted import (1.14, "Import from a linked node" in `jira-sync.md`).** The modal takes an optional `root: ImportRoot` (`utils/jiraImport.ts`: `{level: PROGRAM|PROJECT, nodeId, name, issueKey, connectionId, workStreamId, owner: PickedOption}`);
with it the stream is the root's, the connection is the root's own (`source.connections` filtered to `root.connectionId`; absent from the usable ones = a `role="note"` "linked through a connection that is disabled or no longer fits its site: an administrator has to enable and test it" instead of the field, Preview disabled; a source that has not answered yet shows the loading text), the form opens with `owner = root.owner`, and `toScope(form, keys, root)`
adds `root {level, nodeId}` and NEVER `projectKeys` or `defaults.programId` (nor `defaults.projectId` under a project root); the apply spreads the preview's scope, so it repeats the root. The scope step replaces the intro by a `role="note"` first line naming the key and the node ("Importing what Jira lists under KEY into the program “NAME”: its projects and their milestones." / "… the project “NAME”: its milestones."), hides the work stream,
the Jira projects and the default program, shows the owner for a PROGRAM root only (a project root sends the project's owner) and turns "Default project" into "Project for items directly under KEY" offering the root program's own projects (PROGRAM root only); the filter, "Copy Jira's dates" and the default team are as before. The preview step shows, for an empty rooted preview, one `role="note"` with "Jira lists nothing under KEY at the levels this connection maps.", under an active filter "The filter may be why: …", and "If KEY has child items in Jira, search Jira for parent = KEY." (the 1.13.4 search and the rest are untouched). `409 urn:astrolabe:problem:jira-root-unusable` is `isJiraRootUnusable` (`api/jira.ts`) and `importFailure` answers `jira.import.error.rootUnusable` (the link cannot be used; see the Deviations page; no server text, no "Preview again").
**The program entry and its links read.** `useJiraProgramLinks(enabled)` (`hooks/useDeviations.ts`; key `["jira","deviations","links",{level:"PROGRAM"}]`, `getDeviations({level: "PROGRAM", all: true})`, `staleTime` 5 min, `refetchOnWindowFocus: false`, `retry: false`) answers `{links: Map<programId, {bindingId, connectionId, issueKey, gone}>, connections, failed, retry}` from ONE read that feeds both the entry's visibility and the dialog's connection, so opening the rooted dialog asks for nothing more. The RESPONSE is small (at most one item per program) but the READ is not: the server runs its full deviation computation over every binding before it filters the level, so each fetch costs about what the Deviations page's own does; hence the 5-minute `staleTime` and no refetch on window focus (a Plan visit within five minutes reuses it), and it still refreshes whenever a `["jira"]` query is invalidated (a bind, an unlink, an import, a refresh). It is enabled only while the plan view holds a program with `can.createProject`; a failed read hides the entry and shows no error. `PlanActions.canImportChildren(program)` = the program's `can.createProject` AND a link, and `PlanProgramBlock` shows a `Menu.Item` "Import from Jira…" (aria "Import from Jira what is listed under {name}": it starts with the visible text, label-in-name; `IconFileImport`) after "Move to…"; the kebab's own condition includes it. A link through a connection that is not usable still shows the entry (the dialog says why), and so does a link whose Jira item the read already says is gone (`item.jira.gone` -> `link.gone` -> `root.gone`): the scope step opens with the "cannot be used" note (`jira.import.error.rootUnusable`) and Preview disabled, no Jira round trip. The project page cannot tell: `project.jira` carries no gone flag (its dates are null for a gone item but also for a never-observed one), so that dialog learns it from the `jira-root-unusable` refusal. A rooted PROGRAM dialog's owner hint says only projects are created (`ownerHintRoot`). Every mount site keys the modal by its source (`stream:<id>`, `program:<id>`, `project:<id>`) so its form state never carries over. Tests: `JiraImportModal.root.test.tsx`, `pages/Plan.test.tsx` ("Import from a linked program"), `utils/jiraImport|jiraImportText.test.ts`, the harness's `previewScope(user, rooted)`.

**The chips and marks (1.3: built from the VIEW)** (`components/JiraChips.tsx`, `utils/jiraMarks.ts`): the project and team pages make **no request of their
own** for what is linked - `projectMarks(view)` / `teamMarks(view)` read the document's `jira` blocks (the project's own and every milestone row's, scheduled
and tray) and `jiraSites` (`url = siteUrl + "/browse/" + key`, https only through `JiraKeyLink`/`jiraBrowseUrl`; the URL is never per row), so the chip is
exactly as current as the view and any refresh of `["plan"]` (a plan write, a bind, an unlink, an acknowledgement) moves it. Only OPEN flags are counted - the
view lists none for an acknowledged item or a disabled connection - and only `JIRA_DEVIATION` ones: the project's `JIRA_MILESTONES` roll-up repeats its
milestone rows' flags and counting it would count a deviation twice. The project page's facts row (inside `ProjectFacts`, so nothing under it shifts) has "Jira:
E2E-1" (the project's own key), "N milestones linked to Jira" and the count (a link to `/deviations?projectId=`, orange with a warning, gray otherwise; "No
deviations seen" at zero, never "in line"); the team page the same count line (`/deviations?teamId=`); nothing at all while nothing is linked. The old "may be
out of date" qualifier is gone with the separate query: the view carries no connection status (the Deviations page and the connection pages still do).
`useJiraLinks(projectId, enabled)` (`hooks/useDeviations.ts`) survives ONLY for the bind dialog's `connections[]` (`GET /views/deviations?projectId=`, asked
while the dialog is open, no `answered` gate on the page); `useJiraColumn` and its `teams.jiraColumn.<id>` key are removed.

**The Flags column and the tray (1.3)** (`components/MilestoneFlags.tsx`, `utils/flagSentences.ts`): the project and team timelines get a **Flags** column
(`roadmap.column.flags`, before Slack and Operations) while some SCHEDULED milestone has a `jira` link or a flag (the calendar's `NO_WORKING_DAY`, phrased "Covers no working day: only weekends or holidays" by `roadmap.flag.noWorkingDay`; an unlinked row shows just the triangle); the column is 130 px, 210 px while some scheduled row
shows a roll-up and its cell is the row's Jira key as an external link (`JiraKeyLink`, out of the roving tab order, https only through `jiraBrowseUrl`, the site
from the view's `jiraSites`), beside the roadmap's icon (an orange triangle for warnings, a gray info circle for infos, with counts); the icon's accessible
label lists the row's flag sentences behind its key ("Jira E2E-3: Ends 3 working days later than Jira (plan …, Jira …)", `flagSentence` shared with the
roadmap's flag panel), and a linked row with no open flag (clean, acknowledged, or on a disabled connection) gets "Linked to Jira: E2E-3" instead, so it is told
apart from an unlinked one; an unlinked, ghost, summary or baseline row has an empty cell. **The roll-up (1.4)** comes LAST in the cell, after the key and the
icon (the least critical element: the cell clips without an ellipsis, so it must never push a warning badge out), when the link's `rollup` is set - compact
dimmed `xs` text `5/12 · 34 pt` (done of children, then Jira's story points as Jira states them, never converted; the points part is omitted when `points` is
null); it shrinks with an ellipsis (`minWidth: 0`), so in a tray name cell a long name cannot widen the row. **The roll-up text** is
`components/JiraRollupText.tsx` (`rollupText`/`rollupSentence`/`formatPoints` in `utils/deviations.ts`, keys `deviations.rollup.*`): the short text is
`aria-hidden` and the ACCESSIBLE NAME is the full sentence ("12 child issues in Jira, done: 5, story points: 34", plural forms on the children count), also the
`title` and a visually hidden span; points show up to two decimals, trailing zeros dropped; a link with `rollup: null` (a project link, a disabled connection, a
childless epic) renders nothing of it, and the tray's `NameWithFlags` carries it through `MilestoneFlags`. The Deviations page's Jira cell shows the same
component under the type/status line. **A binding through a DISABLED connection stays a link** (the server keeps `jira` with null dates and no flag): the chip
counts it with no deviations, the key shows, Unlink works, no bar is drawn. A **tray row** has no column: the same key link and icon sit beside the name and,
for an open `UNSCHEDULED_IN_PLAN` flag, the name cell adds "Jira: 2027-03-01 to 2027-03-05" (nothing appended to the timeline for it). Tests:
`ProjectView.jira.test.tsx`, `TeamDetails.jira.test.tsx`, `JiraChips.test.tsx`, `utils/jiraMarks.test.ts`, `utils/flagSentences.test.ts`,
`hooks/useDeviations.test.tsx`, `JiraBindDialog.test.tsx`, `JiraBindingsSection.test.tsx`.

### Capacity from Flow (1.6)

`components/CapacityDeviationsSection.tsx` (the page's second h3 after the Jira list): ANOTHER document, `GET /views/capacity-deviations`
(`{asOf, connections[], totals{warnings, infos, gone, acknowledged, teams}, items[≤1,000 teams, each with `can{acknowledge}` and its sprint rows, each row with its
`fingerprint` and `acknowledgement{at, by, current}|null`], truncated}`, no `revision`: capacity is team data)
under `["flow","deviations","view",filter]` through `hooks/useCapacityDeviations.ts` (`api/capacityDeviations.ts`) - the Jira document is untouched, the two
load in parallel and fail separately (a failed Flow document is the section's own heading and alert; a failed Jira one leaves the Flow section standing). **It
exists only when there is a Flow connection** (`connections.length > 0`; a Jira-only stack sees nothing new, not even a heading). **Filters:** it takes the
URL's `teamId`, `severity` and **Status** (a team id and the WARNING/INFO scale mean the same in both lists; the server narrows each team's ROWS by severity, so
"warnings only" lists the warning sprints; the page's ONE Status select - Open / Acknowledged / All, `acknowledged`/`all` in the URL - applies to both lists and is
sent as the view's own `acknowledged`/`all`, `all=false` too, the Open choice under a team scope, since the server's `teamId` implies `all`); plan item type, work
stream, project, kind and connection are the Jira list's (a Jira connection id is not a Flow one) and are named in one `role="note"` line while any is in the URL. **Honesty about currency** (the Jira rule, read off the derived `status`,
`utils/capacityDeviations.ts`): "Data from Flow" (`CapacityDeviationsSources.tsx`, h4) is a row per connection - state badge, when its document was mirrored
(`teamsAt`), the notes that qualify the figures (never refreshed, last refresh failed with `errorCodeText(…, "FLOW")`, stale, disabled) and, for an ADMIN,
**Refresh now** = `POST /integrations/sync/runs {kind: "FLOW"}` then a re-read of `["flow"]` (a 409 run-in-progress is a normal state; a 429 reads "Too many requests. Wait a minute and try again.", 1.13.1); an orange `role="note"`
says the list may be out of date when an ENABLED connection is not CURRENT (`hasStaleFlowSource`); an empty section is told apart - no team is linked (asked of
the connections' own team lists `["flow","teams",id]`, only then), a filter that matches nothing, or "In line with Flow in the data read at T (UTC)"
(`verifiedFlowAt`: the OLDEST success, withheld - "read so far" - when ANY connection is disabled or not CURRENT; the team-list check is not polled, it re-reads
on focus and on `refreshFlowLinks`). A failed re-read keeps the last answer under the section's `ErrorAlert`. A row whose connection is disabled or not CURRENT
carries "stale" under "Data as of" (the Jira table's mark), since the banner covers enabled connections only. **Totals:** orange warnings (a gone team is one of
them), gray infos, an ORANGE "of which N teams gone from Flow" (part of the warnings, not an addition), a gray "N acknowledged" (rows, not teams; warnings,
infos and gone count the OPEN rows whatever Status lists, so under Acknowledged/All the Jira list's "open items only" note says it), "N teams shown", or "N of M
teams shown" from `totals.teams` when the server cut the list. The poll is the Jira page's (`DEVIATIONS_POLL_MS` while `status.lastRun.running`, bounded). **Rows:** one per team -
the team (a link to `/teams/:id`), its Flow team (with the connection's name only when there are several), the lines (`CapacityDeviationList`, shared with the
team page: severity in words before an orange/gray kind badge, `TEAM_GONE` as one sentence, the sprints that differ as sentences, the sprints WITHOUT capacity
folded into one "N sprints without capacity in the plan (from DATE)" line over a table disclosure - the count and the date are the OPEN sprints', with a dimmed
"· M acknowledged" after it, or "N sprints … all acknowledged" when none is open) and when Flow was last seen. **The acknowledge (1.9)** is per sprint row: every
line carries `CapacityAckCell` (the Jira `DeviationAckCell`'s shape and its `deviations.ack.*` sentences - "Acknowledged by Ada on 2026-11-06", "… by Ada ·
changed since" for a stale one, which is open again and offers Acknowledge anew - plus ONE button named by the sprint, "the team's own row" for the gone team,
Acknowledge / Unacknowledge by the item's `can.acknowledge` and the row's state, `data-ack-for="<bindingId>:<sprintId|team>"`); the folded sprints carry it in a
fourth "Acknowledgement" column of their table, so a single missing sprint is a sentence with its cell. The write is `hooks/useCapacityAcknowledge.ts`, the Jira
`useAcknowledge` state machine over the row key: `POST`/`DELETE /integrations/flow/team-bindings/{id}/acknowledge` with the row's `detail.sprintId` (always in
the POST body, `null` for the gone team) and `fingerprint`; a success re-reads `["flow","deviations"]` and `["plan"]` (`refreshCapacityAcknowledgements`: the team
view's flag and markers follow the open rows); the shared `409 stale-deviations` (`isStaleDeviations`) is an orange note in the row plus the re-read (a note of
a row that left the list is shown above the list, `CapacityAckOrphanNotice`), a 403/404 a red message and a `refreshFlowLinks`; the focus rule is the Jira
one (the row's own button, the next row's, the previous row's, else the "Differences from Flow" heading). **Acknowledge all (1.10)**: at the head of a team's list
(`CapacityAckAll` in `CapacityAckCell.tsx`, rendered by `CapacityDeviationList`, so both surfaces have it) a `Button` "Acknowledge all (N)" - named "Acknowledge all (N)
open differences of <team>" (`CapacityAckContext.team` is the item's team name) - shown only when the item's `can.acknowledge` allows it AND at least two of the listed
rows are open (`isOpen`: a stale acknowledgement and every folded "sprints without capacity" row count; acknowledged ones neither count nor are sent; one open row has
its own button). It **acknowledges what the list shows**: the page's Status/severity/team filters have already narrowed the rows, and N is on the label. One request,
`POST /integrations/flow/team-bindings/{id}/acknowledge-all` (`acknowledgeCapacityDeviations`, body `{items:[{sprintId|null, fingerprint}]}`, all or nothing), through the
SAME hook as a `{kind: "acknowledgeAll", bindingId, rows}` request keyed by `capacityAckAllKey(bindingId)` (`<id>:all`, the button's `data-ack-for` and the busy and notice
key): the success toast, the re-read, the stale `409` note ("The deviations changed since you looked…", nothing was stored), the 403/404 refusals and the focus rule are
the single write's (the neighbours are the list's row keys, so after a batch the focus goes to the first row button still there, else the heading). While any write runs the button is
`aria-disabled`/`data-disabled`, never `disabled`. The batch's note shows under the button at the head of its team's list (button or not), and `listedKeys` of both
callers hold each listed team's all-key, so `CapacityAckOrphanNotice` shows it above the list only once the team's item has left the list (an Open list with nothing open
left). **Withdraw all (1.11)**: beside it in the same `CapacityAckAll` a `Button` "Withdraw all (N)" (named "Withdraw all (N) acknowledged differences of <team>"; PL "Cofnij wszystkie (N)") - shown with `can.acknowledge` and at least two listed rows that are CURRENTLY acknowledged (`!isOpen`: a stale acknowledgement is open and not sent; every folded acknowledged sprint counts), so it shows where the list has acknowledged rows (the Status filter on the Deviations page, always on the team page). One request, `POST …/team-bindings/{id}/unacknowledge-all` (`unacknowledgeCapacityDeviations`, body `{items:[{sprintId|null}]}`, all or nothing, `204`), through the SAME hook as `{kind: "unacknowledgeAll", bindingId, rows}` keyed by the same all-key (busy, notice, `data-ack-for`), with the "Acknowledgement withdrawn" toast, the re-read, the stale `409` note (nothing was deleted), the refusals (its 404 is the binding: "This link no longer exists") and the focus rule of the batch acknowledge. **The sentence**
(`capacityDeviationSentence`, EN/PL): `"<Flow's sprint name> (<start> – <end>): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan"` (`gapMd` > 0 =
the plan has more; man-days are JSON numbers shown with two decimals and a dot), plus "Flow plans 44.00 man-days for the whole sprint; 22.00 fall on the days it
holds here." when `flowTotalMd` differs from `flowMd` (a fixed per-sprint figure that shares days with an earlier sprint). **An empty Open list** with rows
acknowledged (`totals.acknowledged > 0`) says "No open capacity difference." and how many sprints are hidden - never "In line with Flow". Tests:
`CapacityDeviationsSection.test.tsx`, `CapacityDeviationsSection.ack.test.tsx` (the acknowledge, "Acknowledge all", "Withdraw all"), `CapacityDeviationList.test.tsx`, `CapacityAckCell.test.tsx`, `Deviations.test.tsx` ("Capacity from Flow"),
`utils/capacityDeviations.test.ts`, `hooks/useCapacityDeviations.test.tsx`, `hooks/useCapacityAcknowledge.test.tsx`, `api/capacityDeviations.test.ts`; fixtures in
`test/flow.ts` (`capacityView`, `capacityItem`, `differsRow`, `missingRow`, `acknowledgedRow`, `staleAcknowledgedRow`, `NO_FLOW_VIEW`).

## Teams and the team page (`pages/Teams.tsx`, `pages/TeamDetails.tsx`, v0.5.0)

`/teams` is the flat teams registry (the `Teams.tsx` template of `web/CLAUDE.md`; reads for everyone, create/edit/delete ADMIN). The Teams list's name link opens `/teams/:id`, the team view (lazy).

Files: `api/teams.ts` (`getTeamView`, `createCapacityPeriod`, `updateCapacityPeriod`, `deleteCapacityPeriod`, `putTeamOrder` and the types `TeamView`,
`TeamMilestone`, `WeekLoad`, `CapacityPeriod`; `listCapacityPeriods` is deliberately NOT wrapped — the view carries the periods),
`hooks/useScheduleWritePath.ts` (the project view's write path, generic over the view document: `{queryKey, queryFn, apply, enabled, writeKey}`),
`hooks/useMilestoneSchedule.ts` and `hooks/useTeamSchedule.ts` (its two wrappers; `ProjectView.tsx` and its test are untouched by the generalisation),
`hooks/useTeamOrder.ts`, `utils/teamOrderList.ts` (`fullOrderList`, `placeScheduled`: the order PUT's FULL list — the stored `order.milestoneIds` with the
scheduled permutation filled around the unscheduled listed ids, `planning-model.md` "The team milestone order"), `utils/teamViewUpdate.ts` (`applyTeamSchedule`,
`applyTeamOrder` — both pure, incl. the server's default order for the reset), `utils/dependencyArrows.ts` (the view-independent halves of
`projectDependencies.ts`: `arrowSpecsFor`, `conflictsByBarFor`, `conflictCountOf`), `utils/roadmapOrder.ts` `moveToEdge`/`moveToSlot`, `utils/capacityForm.ts`,
`components/TeamTimeline.tsx` (rows, arrows, the strip; `TeamTray`) with its row menus in `TeamTimelineMenu.tsx`, `TeamCapacity.tsx`, `CapacityPeriodModal.tsx`, `TeamWeeklyLoad.tsx`.
`TeamDetails` is `<TeamPage key={id}>`.

`/teams/:id` (the Teams list's name link; any signed-in user reads it) renders `GET /views/team/{id}` under `["plan","team",id]` — under the `["plan"]` prefix
like the project view. **Everything is gated by the view's `team.can:{schedule, editCapacity, editOrder}`** (the team's manager or an ADMIN), never the
session's roles.

Header: name, description, the manager line, an ADMIN's Edit (`TeamEditorModal` on the view's team block; a save refreshes `["teams"]` and `["plan"]`); **the Flow capacity flag (1.9)** beside the title — `team.flags[]` (the ONE `FLOW_CAPACITY` roll-up of the OPEN rows, so an acknowledged row is not in it) through `PageHeader`'s `titleAddon` slot as a light badge (`TeamPageHeader`'s `TeamFlags`: orange with a triangle for a warning, gray with an info circle for an info; the visible text is `flagSentence`'s "Capacity differs from Flow: N open differences" (open ROWS, not sprints: a gone Flow team is one too), the icon `aria-hidden`, so it is announced once; NO count badge — the roll-up is one flag and the number is in the sentence; nothing for `[]`; the rows themselves are the Flow section's); the
facts line: "N milestones · M scheduled", ORANGE "N weeks overloaded" and "N weeks over WIP limit" badges (warnings — nothing moves), the RED conflicts badge of
the project page, a gray "Custom order" badge while the team's own order is in force.

The timeline (`components/TeamTimeline.tsx`, on the shared `Timeline*` with the sticky load `strip`) has one row per SCHEDULED milestone in the server's order —
**the project rank is only the DEFAULT order; a manager's override is the execution order and is never reshuffled by a rank change** — with the project as a
link, the estimate and the row menu; arrows are drawn only between this timeline's rows (no ghost rows, no Dependencies table; a bar's name gains ", N
conflicts"); the Unscheduled tray is the project page's.

**Critical path (1.7).** The team page holds the project page's `useCriticalPathPick()` (the same remembered `timeline.criticalPath`; `<CriticalPathToggle>` in the
timeline's `toolbar` after the baseline picker) and passes `criticalPath` to `TeamTimeline`: a **Slack** column (`SlackCell`, after Flags, before Operations; a
critical row "0" + the hidden "critical path", else "N working days") from the view's `slackDays`/`critical`, `emphasis: "critical"` and ", on the critical path" on a
critical bar, `markCriticalArrows(specs, view.dependencies)` (`utils/dependencyArrows.ts`, shared with `arrowSpecs`) for the critical links, and a dimmed
`teams.view.criticalNote` under the timeline title saying the figures are toward each milestone's OWN project's end and a link is marked only on the chain of
a project the team works on. Read, never recomputed; off, the DOM is the one it was (pinned, `TeamTimeline.test.tsx`).

**The pin (1.7).** `PUT /milestones/{id}/pin {pinned}` (`api/milestones.ts` `pinMilestone`, answers `{revision}`; no `expectedRevision`: an idempotent flag) is a SECOND write of `useScheduleWritePath`
(`pin(id, pinned)`, so both timeline pages have it): its own mutation on the SAME write key (`teamWriteKey`; the project page's `["plan","project-write",id]`), so a drag, a pin and an order save see each other in
flight and a change made meanwhile is refused out loud like any other (`refused`, `project.busy`). The step is optimistic (`utils/pinUpdate.ts` `applyPin`, pure, generic over both views), success stores the
answered plan revision into the entry the pin was made on (only) and refreshes `["plan"]` (the views carry `pinned`), a failure rolls back and awaits the refetch; the quiet confirmation is the live region ("{{name}} pinned" /
"unpinned", `project.announce.pinned|unpinned`) and there is NO toast (a pin is a state, not an event). A 403 reads the schedule's forbidden sentence, a 404 the gone one, and the one 409
(`milestone-unscheduled`: it lost its dates meanwhile) `project.pinUnscheduled`, inline through the page's `error`; a taken schedule change and a taken pin each clear the other's old failure.
The server clears the pin on an unschedule, so `applySchedule` / `applyTeamSchedule` set `pinned` false on a null pair (a reschedule keeps it). The row menu (`TeamTimelineMenu.tsx`) offers Pin / Unpin dates
for a SCHEDULED row under `team.can.schedule` (the schedule PUT's rule), hidden while a proposal previews or requests (`lock.guarded`) and never on a tray row; the pinned row shows `PinMark` after its name
and ", pinned" in its bar's name (as on the project page); a baseline's appended rows and the Jira bars are untouched. **In the proposal**, the Proposed schedule `Summary` appends "N pinned" to the figures
line and, when `proposal.pinned` is not empty, a dimmed sentence "N milestones keep their dates because they are pinned" (`teams.proposal.summary.pinnedCount|pinned`; `pinned` lists the dated milestones the
proposal keeps ONLY because of the pin). A pin flipped after a proposal was read turns its accept into the `stale-scope` re-proposal that keeps the ticks. Tests: `TeamDetails.pin.test.tsx`,
`TeamTimelineMenu.test.tsx`, `TeamProposal.test.tsx`, `pinUpdate.test.ts`, `teamViewUpdate.test.ts`.

- **Query keys.** The view is `["plan","team",id]` (`teamViewKey`), under the `["plan"]` prefix like the project view, so every plan mutation, a schedule write
  and a capacity write refresh a mounted team page. The team editor's save refreshes `["teams"]` and `["plan"]`.
- **Two revisions, never crossed.** The view's `revision` is the PLAN revision: the schedule PUT's `expectedRevision`, adopted from the PUT's answer.
  `order.revision` is the TEAM's order revision: the order PUT's `expectedRevision`, set ONLY from the order PUT's answer (`TeamOrderResponse.revision`, the
  plan revision the write left behind). The roadmap's revision is a third thing the page never touches.
- **One write at a time.** The schedule mutation and the order mutation carry the same `mutationKey` (`teamWriteKey(id)`); each hook treats
  `useIsMutating(key) > 0` as "busy" and refuses a change OUT LOUD: `commit` answers `false`, the hook sets its `refused` flag (the page's visible `role="note"`
  shows when either hook's is set) and announces `project.busy` in the live region (`onSchedule` answers `false` for a drop; a Move or Reset is refused the same
  way, and the Reset confirm dialog stays open and says so inside, since a modal's content is all a screen reader reads). `refused` is cleared by
  `hooks/useRefusal.ts` the moment NO write is in flight any more, whichever write was the busy one (a drop refused during an order save does not leave its note
  up after that save). Two optimistic writes on one cached view would roll each other back. The page's `busy` (aria-busy, the "Saving…" indicator) is either.
- **Order failures.** A stale 409 and a 400 (a listed milestone was deleted or moved to another team meanwhile — removals do not bump the team's order revision)
  are both "the list changed": rollback, awaited refetch, the visible `role="note"` "The team's order changed in the meantime" and the same sentence in the live
  region (announced from `onError`, so a screen-reader user hears the list jump back). 403 reads `teams.view.orderForbidden`; anything else the generic
  action-failed sentence.
- **Optimistic order.** Every reorder goes through the hook's one seam `placed(id, permutation)` (a permutation of the displayed scheduled ids; the Move items
  and a future row drag): `placeScheduled` turns it into the full list (unscheduled listed milestones keep their index), `commit` sends it.
  `applyTeamOrder(view, ids)` (ids = the full list): the listed scheduled rows in that order, the unlisted after them in the default order (rank position,
  project name, project id, start, end, name, id — the server's `effectiveOrder` without the custom positions), `order.milestoneIds` = the list (ids the view
  does not hold dropped), `order.custom = ids.length > 0`; the empty list (Reset) therefore shows the default order at once. `applyTeamSchedule` appends a newly
  scheduled row (the refetch places it), keeps a rescheduled row where it is and returns an unscheduled row to the tray in the default order.
- **Menu focus.** Rows are keyed by milestone id, so a Move keeps the row's DOM node and Mantine's menu returns focus to its (still mounted) kebab; the roving
  grid's focus handler re-adopts it as the tab stop at its new row. `TeamDetails.test.tsx` pins "the menu button keeps focus" through a real Move.
- **Row drag (C5b).** `TimelineDndContext` takes an optional `onReorder(id, slot) → boolean` (`onSchedule`'s twin: `false` = refused, announced as "not
  changed"); the page passes `order.dropAt(id, slot)` = `placed(id, moveToSlot(scheduledIds, id, slot), false)` (`false` = no page announcement: dnd-kit's
  region is the drag's single announcer) (`moveToSlot` in `utils/roadmapOrder.ts`: remove the id, re-insert at `slot − 1` when the gap lies below it, else at
  `slot`; a slot of `from` or `from + 1` is the identity — the context proposes those too and `placed` answers `true` WITHOUT a PUT when the permutation equals
  the displayed order, so the page, not a pick-up snapshot, judges a no-op), so a drop is the SAME `commit` as a menu Move: the optimistic `applyTeamOrder`, the
  PUT against `order.revision`, the stale/400 rollback. The handle (`TimelineRowHandle`) is rendered by `TeamTimeline`'s name cell under `can.editOrder`;
  `TimelineDndContext` keeps the picked-up `DragData` in a ref because dnd-kit blanks an unmounted active node's data (a virtualised row scrolled out mid-drag).
  Mechanics and the slot arithmetic: `timeline.md` "Row drag".
- **Idle gaps (v0.7.0).** Information only — an idle team week is not a warning: the days inside the team's schedule on which none of its milestones is in
  progress, 3 or more working days at a time (the view's `idleGaps[]`, the server's list), as hatched `idle` bands across every row, a gray "N idle gaps" badge
  in the facts line (absent at zero) and `components/IdleGaps.tsx` (`scope="team"`) after the weekly load table. In code: `TeamTimeline` passes
  `bands={idleBands(view.idleGaps, t)}` (no window band on this page), `TeamFacts` adds the gray `timeline.idle.badge` badge before the "Custom order" one (only
  when non-empty) and `<IdleGaps gaps scope="team" />` follows `TeamWeeklyLoad`. `applyTeamSchedule` and `applyTeamOrder` spread the view, so the cached gaps
  stay until the refetch (`teamViewUpdate.test.ts`).
- **Messages shared with the project page.** The busy / milestone-gone / stale / schedule-error / scheduled-unscheduled sentences are the project page's own
  keys (`project.busy`, `project.milestoneGone`, `project.stale`, `project.scheduleForbidden`, `project.announce.*`): the same refusal says the same words on
  both pages.
- **The strip's data.** `view.weeks` is handed to `TimelineLoadStrip` as it is: the API's `WeekLoad` is structurally the strip's local `LoadWeek`, so no mapping
  layer exists (`flowCapacity?` is optional on both; `stripCells` normalises an absent member to `null`). The weekly table formats with two decimals (what the server flags on); the strip trims zeros.
- **The Flow capacity marks (1.9, the web half of `timeline.md` "The Flow capacity marker").** `weeks[].flowCapacity` (`WARNING`|`INFO`, only the weeks an OPEN row's held days meet) is read, never recomputed: the strip cell gets `data-flow-capacity` and a top-left mark `data-part="flow-capacity"` (`data-severity`; a SHAPE per severity, never a hue alone — a solid orange triangle for a warning, a hollow gray ring for an info), the cell's `title` gains "; capacity differs from Flow for this week's sprint", and the weekly table's verdict cell gains a badge "Differs from Flow" (orange / gray, `data-flow-badge`; `data-flow-capacity` is the strip cell's alone) BESIDE the week's own verdict (an OK week reads "OK" + "Differs from Flow"); the table's intro names the corner mark. The marks follow the CURRENT plan: a proposal preview's strip draws the proposal's weeks, which carry none, while the header flag and the Weekly load table keep reading `view.weeks`. An acknowledge refreshes `["plan"]` (1.9 C4), so the flag and every mark follow without a reload. Tests: `TeamPageHeader.test.tsx`, `TimelineLoadStrip.test.tsx`, `timelineLoad.test.ts`, `TeamWeeklyLoad.test.tsx`, `TeamDetails.test.tsx`.

**The deterministic order path** (the Roadmap rule; the write paths are the bullets above): the dates go through `useScheduleWritePath` → `useTeamSchedule`, the
order is the wholesale `PUT /teams/{id}/milestone-order` against the TEAM's order revision (`view.order.revision`), and every reorder is
`placed(id, permutation of the displayed scheduled ids)`. The row menu's Move up / Move down / Move to top / Move to bottom (`can.editOrder`, disabled at the
ends, the menu button keeps focus) and the "Reset order" button (confirms with "Reset", then sends the empty list = the project rank again), announced in the
page's one polite live region. A refused Reset keeps its confirm dialog open and says so inside.

**Capacity** (`components/TeamCapacity.tsx`, `CapacityPeriodModal.tsx`, `utils/capacityForm.ts`): the periods table is where the limits are READ ("—" = no WIP
limit); Add/Edit/Delete only with `can.editCapacity`; a period takes effect on ANY date (no weekday rule — a weekend date applies from the next working day),
man-days per week (0 ≤ x < 1,000,000, two decimals) and an optional WIP limit 1..99 (empty sends `null`); a date clash (409) marks the date field. **The weekly
load table** (`components/TeamWeeklyLoad.tsx`, behind a `TableDisclosure`) is the accessible surface of the decorative strip: load, capacity ("—" when none),
peak WIP and the verdict in words (orange "Overloaded · +X MD", orange "Over WIP limit", gray "OK" / "No capacity", plus the 1.9 "Differs from Flow" badge). **Row drag:** a manager (`can.editOrder`)
also drags a row by its pointer-only handle (`TimelineRowHandle`, the first thing in the name cell) — a drop becomes `onReorder(id, slot)` on the
`TimelineDndContext` → `order.dropAt` → the same `commit` as the menu, so the save, the rollback and the stale notice are one path; the menu stays the keyboard
path, and dnd-kit's region announces the drag (the single announcer of a drag: `dropAt` passes through `placed` silently, so the page's polite region does not
repeat the menu's "moved to position").
- **Capacity dialog.** `NumberInput`s use `clampBehavior="none"`: Mantine's default clamps `0` to the `min` of 1 on blur, which would silently turn an invalid
  WIP limit into a valid one; with `none` the typed value reaches the validator and the inline message. No weekday rule anywhere.

**The baseline overlay (v0.9)** - the picker sits in the timeline's toolbar (after Today), the query key and the three write hooks (`useTeamSchedule`,
`useTeamOrder`, `useScheduleProposal`) take the pick, a shadow bar follows each row's bar (after a proposal bar when both are on), a milestone the baseline did
not know reads "(new since the baseline)", and dimmed rows are appended after the scheduled ones for the baseline's milestones that are gone from the team
("(removed)", "(moved to {team})") or sit in the tray now ("(unscheduled since the baseline)"); the Movement section (`scope="team"`, with a Project column)
follows Idle gaps. Tests: `TeamDetails.baseline.test.tsx`, `TeamTimeline.test.tsx`.

**The schedule proposal (v0.8)** - a third write path, `hooks/useScheduleProposal.ts` (the generated view of it: `timeline.md` "The proposal preview (v0.8.0)").
"Propose schedule" (timeline header, `team.can.schedule`) POSTs the viewer's local day as `asOf`; a proposal with something to show opens the **Proposed
schedule section** (`components/TeamProposal.tsx`, h3, mounted under the timeline before the Unscheduled tray; since 1.8 its summary line, table and unplaced rows are `components/ProposalTable.tsx`, a controlled table over the structural `ProposalContent` with no actions, which the cross-team page composes once per team), one that has nothing to show (nothing to propose
/ no capacity: add a capacity period first) opens nothing and says so in a note. The section is controlled by the hook (`selected`, `toggle`, `selectAll`,
`selectNone`, `accept`, `discard`): a summary line ("3 moves · 1 newly scheduled · 2 stay · 1 could not be placed"), a RED "N links would be violated" badge for
links violated AFTER and not before (a gray "N links stay violated" for those violated both times - `linkTotals`), the table (`teams.proposal.tableAria`; a
header "Accept all" `Checkbox`, `indeterminate` while only some rows are ticked, a per-row `Checkbox` named "Accept {{name}}"; Milestone with the project as a
link, Current, Proposed with its working days, Change = `changeSentence`, Links = `linksAtMove`: "would violate: Web > Checkout page must start on 2042-02-26 or
later" (start or end by the link type, `requiredEdge`: FS/SS start, FF/SF end) in `classes.proposalViolation` red with a red "Conflict" badge, "resolves: link
with ..." gray, nothing for a link that did not change), a "Could not be placed" row group with the reason in words (no capacity after {{date}}, the request's
`asOf` like the page note / no room within the 520-week horizon, `PROPOSAL_HORIZON_WEEKS`; no checkbox) and the actions **Accept selected (N)** (primary;
disabled at zero or while ANY write of the page runs) and **Discard** (disabled while the accept runs). Accept all / none are announced in the page's one polite
region ("2 of 3 selected"); a per-row tick is a self-announcing checkbox. **What an accept came to** is a dismissible `role="note"` line that lasts until the
next action (`ProposalNotes` under the timeline header, green; orange when something was skipped: "3 scheduled · 1 skipped: rescheduled in the meantime"), as is
the whole-batch stale refusal ("the plan changed in the meantime - nothing was saved; propose again") and, v0.9 C4, the re-proposal after a `stale-scope`
refusal (see below); the status region is the single announcer, so none is an `Alert` with its implicit `role="alert"`. A 403/404/400 of the accept is a
`FormErrorAlert` INSIDE the open section above the actions (the preview stays open, the selection is kept) and takes the focus (the disabled Accept would
otherwise drop it to the body); a propose's failure shows under the timeline header while no preview is open. There is no success toast on accept: the visible
outcome note and the polite sentence carry it. The intro line says the link warnings and the proposed load follow the moves you tick (1.8, below). Focus: Discard takes it when the preview
opens; Propose gets it back after Discard, an accept or a stale refusal, once no write is running (a disabled button cannot take it). The page is read-only
while a proposal is requested or open (`hooks/useProposalLock.ts`). **The scope check (v0.9 C4):** the accept sends the proposal's `scopeHash`; on a
`409 stale-scope` (`isStaleScope`; the team's plan changed since the proposal, nothing was written) the hook closes the preview, requests a fresh proposal at
once (a fresh `asOf`), refreshes `["plan"]`, and the new preview keeps the ticks of the milestones that were ticked and still move (`keptTicks`: the old
selection intersected with the new moves; a move new to the page starts unticked) with an orange dismissible `role="note"` `teams.proposal.rescoped`
(`rescoped`); the focus goes back to Discard once the preview is open and the accept has settled (the refresh is not awaited, so `applying` ends at once; the
page arms the focus when a preview opens or the rescoped note appears, and hands it over when `applying` is false). A fresh proposal with nothing to show leaves
the usual note instead. The whole-batch `stale-revision` 409 keeps the "reloaded, propose again" note. Tests: `TeamProposal.test.tsx` (select all/some/none,
names, badges, unplaced rows), `TeamDetails.proposal.test.tsx` (accept sends exactly the selected moves, outcome/skipped/stale/rescoped notes, Discard, focus),
`useScheduleProposal.test.tsx`, `utils/scheduleProposal.test.ts`.

**The ticked-subset check (1.8)** - the proposal's link verdicts (`dependencies`) and proposed load (`weeks`) describe EVERY move accepted, so they would lie
once some moves are unticked. `hooks/useScheduleCheck.ts` (`{teamIds, revision, scopeHash, moves, selected, enabled}`; the cross-team page reuses it with the run's
teams) asks the server (`checkSchedule`, `api/scheduleProposals.ts`: `POST /schedule-proposals/check {teamIds:[team], items}`, a computation) for the
verdicts of exactly the ticked moves, and ONLY while some but not all are ticked: all ticked IS the proposal's own answer and none ticked changes nothing, so
neither sends a request. The ticks are debounced 300 ms (`useDebouncedValue` over their JSON; the query is keyed `["plan", "schedule-check", sorted teamIds, revision,
scopeHash, items]` by the DEBOUNCED ticks and runs only once they have caught up with the current ones, so an answer for an older selection is never shown for the current
one). It returns `ScheduleCheckState {mode: all|some|none, byTeam, pending, failed}` and `overlayCheck(open, check, teamId)` (`utils/scheduleProposal.ts`, pure)
turns the open proposal into what the page shows: all = the proposal as it is; none = the plan as it is: only the links already violated BEFORE remain (the gray "N links stay violated", no new warning) and no `weeks` (the strip keeps the CURRENT load, so
`TeamProposalView.weeks` is optional); some = the check's `dependencies`/`weeks`/`weeksTruncated` for the team once they are in. While the check is pending
(the debounce window and the request count; a check cancelled by a write's `cancelQueries(["plan"])` is asked again, never left "Checking…") or has failed the all-accepted verdicts stay and `ProposalTable` says so in one dimmed line under the summary
(`teams.proposal.checking` / `checkFailed`; visible only, never a toast or an alert, no announcement - the status region already speaks on select all/none).
So unticking a predecessor turns the ticked successor's Links cell and the summary badge red BEFORE the accept. `TeamDetails` hands the overlaid proposal to
both `TeamProposal` and `TeamTimeline`; the accept still sends the selected moves exactly as before (the check is a query, `teamWriteKey` is untouched); closing the preview drops the check queries, so the refresh after an accept re-asks none.
`ProposalNotes` takes the structural `ProposalFlow` (`utils/scheduleProposal.ts`), so a second hook fits it. Tests: `ProposalTable.test.tsx`,
`useScheduleCheck.test.tsx`, `TeamDetails.proposal.test.tsx` ("the ticked-subset check"), `utils/scheduleProposal.test.ts` (`overlayCheck`).

**The Jira markers (1.3).** The same view-fed pieces as the project page, from `GET /views/team/{id}` alone: the chip's count line (`teamMarks(view)`: the
team's linked milestones, scheduled and tray, and their open flags), a **Flags** column on the timeline (while a scheduled milestone is linked; it replaces the
old remembered "Jira" column and keeps its per-row key link), the tray rows' key link, icon and "Jira: start to end" (the key moved from the tray's own Jira
column into the name cell), and the shadow bar `jira:<milestoneId>` with the "Jira dates" toggle after the baseline picker (a bar follows the baseline's shadow,
the proposal bar and the current bar in one row). Tests: `TeamDetails.jira.test.tsx`.

- **Tests.** `TeamDetails.test.tsx` (the page against a fetch-mock server that applies the order and schedule PUTs; the wrapped `DndContext` hands it the bar
  drop and the row drop), `teamViewUpdate.test.ts`, `capacityForm.test.ts`, `dependencyArrows.test.ts`, `api/teams.test.ts`, `roadmapOrder.test.ts`. The real
  browser is `e2e/tests/team-view.spec.ts` and the team page scans in `accessibility.spec.ts`.

### The team page: Flow (`components/TeamFlowSection.tsx`, v1.5.0)

An h3 **Flow** after Capacity on `/teams/:id`, over its OWN read `GET /teams/{id}/flow` under `["flow","team",id]` (not a member of the team view; any signed-in
user, re-read every `IDLE_REFRESH_MS`); the controls follow the panel's `can:{link, unlink, importCapacity}`, never the session's roles, and a viewer without
them reads only who can link. Unlinked: "Not linked to a Flow team" + **Link to Flow team…** (`FlowTeamLinkDialog`: an ENABLED connection from the panel, then
one of its UNLINKED Flow teams with the server's suggestion preselected; `linkFailure` in `utils/flowLinkFailure.tsx` is the connection page's too). Linked:
facts (Flow team, connection, `SyncStatusBadge`, observed at), an orange "No longer in Flow" when `gone` (the link stays; Import is disabled, the roster reads
"not available"), a note while the connection is disabled, **Import capacity…**, **Unlink** (an in-page `ConfirmDeleteModal`) and `FlowRosterPanel` (an h4
Roster: current members with "since", a `TableDisclosure` "N former members" with from/to, observed at; names only, "Unknown account" is the server's). A link
or unlink refreshes `refreshFlowLinks` (which re-reads the capacity deviations too); `importBlocked` (a schedule proposal is open, `useProposalLock`) disables
Import and closes an open modal. The dialog's connections are the panel's own `connections[{id, name, enabled}]` (every active connection by name, for any
login: the registry list is ADMIN only), offered only when `enabled` (one enabled is preselected; none says so in a note), so a team manager who is no
administrator links on their own; a refused link (409/400) re-reads the Flow teams so a stale option goes.

**Capacity vs Flow (1.6)** (`components/TeamFlowCapacity.tsx`, shared lines in `CapacityDeviationList.tsx`): once the team is linked the section also asks
`GET /views/capacity-deviations?teamId=` (`hooks/useCapacityDeviations.ts`, under `["flow","deviations","view",filter]`, re-read every `IDLE_REFRESH_MS` like
the panel; the SAME document and sentences as the Deviations page's section, no second computation) and adds a **Capacity vs Flow** fact row: an ORANGE badge
"Differs from Flow for N sprints" while the plan has MORE than Flow for some OPEN sprint, gray when it only has less, a gray "No capacity in the plan for N
sprints", both when both - the badges count the OPEN rows (1.9: the document asks `teamId`, which the server takes as `all`, so the acknowledged rows arrive with
their state; the team's own item brings `can.acknowledge`), a dimmed "· N acknowledged" follows them when any is acknowledged, and with only acknowledged rows left
the fact reads the dimmed "No open difference · N acknowledged" (never "In line with Flow": the figures still differ) - and green TEXT "In line with Flow" (the AA-tested `--mantine-color-green-light-color`; never a badge) when the team has no row AND its
connection is enabled and CURRENT (`staleFlowConnection` on the panel's binding) - a disabled, failed, stale or never-mirrored connection reads the neutral
dimmed "No difference in the data read so far" instead; each badge carries a visually hidden "Warning:"/"Info:" prefix; a loading line while the answer is on
its way, an inline `ErrorAlert` below the facts when a read failed (also a re-read: the last answer stays under the alert). A Flow team that left the document
(the panel's `gone`, or a `TEAM_GONE` row) adds nothing: the panel's own orange badge says it. Under the facts the team's lines (`CapacityDeviationList`:
warnings first, the first five, the rest behind a `TableDisclosure` "Show N more", the sprints without capacity folded into ONE line with their own table
disclosure), EVERY line carrying its `CapacityAckCell` (`CapacityDetails` passes `ack`: the section's `useCapacityAcknowledge`, keyed by the team's id, whose focus
fallback is the section's h3; an orphaned note shows above the lines; "Capacity from Flow" above has the cell's and the hook's mechanics, so the manager
acknowledges where they plan; the list opens with "Acknowledge all (N)", `CapacityAckAll`, "Capacity from Flow" above) and, for whoever `can.importCapacity` (and no proposal is open), the truthful remedy line "Import capacity… shows what an import would change.
Hand-entered periods are left as they are, and a sprint where Flow has 0 must be ticked by hand." (it never promises the plan will match: a hand-entered period
and a ZERO_CAPACITY sprint are not touched by default) The apply of the import (`onImported`), a link or unlink (`refreshFlowLinks`), a saved/deleted capacity
period (`TeamCapacity`) and a public-holiday write all invalidate `["flow","deviations"]`, because each moves what the comparison reads; an acknowledge or its
withdrawal re-reads `["flow","deviations"]` and `["plan"]` (`refreshCapacityAcknowledgements`). A gone Flow team (`TEAM_GONE`, or the panel's `gone`) has no
sprint lines, no fact row and no import remedy, but its OWN row is listed (`CapacityDetails`) with its cell ("the team's own row", `sprintId` null, the DELETE
carries no parameter): the open row counts in the header's flag, so the manager silences it where they plan. An acknowledged row's severity badge is dimmed gray
(`SeverityBadge` `dimmed`; a stale acknowledgement keeps its colour), as is a fully acknowledged folded missing line. Tests: `TeamFlowSection.test.tsx` ("capacity against Flow"), `TeamFlowSection.ack.test.tsx` (acknowledging a sprint, and all the open ones, from the team page),
`utils/capacityDeviations.test.ts`, `hooks/useCapacityDeviations.test.tsx`, `hooks/useCapacityAcknowledge.test.tsx`.

**`CapacityImportModal`** (`utils/capacityImport.ts` is its pure half): "Include closed sprints" (re-reads the plan), the preview table
(`POST …/capacity-preview`, read once per opening: `gcTime: 0`, no refocus refetch, so ticks are never reset), a checkbox only on a CREATE / UPDATE row
(`isImportable`), defaulting to the server's `ticked` (closed, `ZERO_CAPACITY` and `LONG_WINDOW` rows start unticked and may be ticked; `infoSentence` words
each info (`FIXED_FIGURE` with the server's `days`), the long-window one with the row's own calendar days from `calendarDays`, since Flow's 60-day cap makes a
sprint that long a likely Jira date mistake); UNCHANGED, `MANUAL_PERIOD` and SKIP rows have none and say why in words (`flow.import.reason/info.*`); the
**removals** list is never preselected. **Import** (`POST …/capacity-import`) sends exactly `{from, includeClosed}` as the preview echoed them, the ticked rows
with their `expected{action, effectiveFrom, mdPerWeek}` and the ticked removal ids (`applyRequest`: nothing is built from anything but the preview); the outcome
is a polite line in neutral forms ("3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime"; Polish "utworzono: 3 …", grammatical for every
count), orange while something was skipped, and a fresh preview is read under it. The outcome sits in an always-mounted polite status region and takes the focus
once that plan is read (the plan replaces the table the Import button sat in); a failed refresh of the page behind never hides it. An apply refreshes `["plan"]`
(team capacity and weekly load are in the team view) and `["flow","deviations"]`. **Capacity table:** a `source === "FLOW"` row gets a gray "Flow" badge titled
with the sprint; the period editor says a saved edit makes the period hand-entered. Tests:
`TeamFlowSection|CapacityImportModal|FlowTeamLinkDialog|FlowRosterPanel|TeamCapacity.test.tsx`, `pages/TeamDetails.flow.test.tsx` (the other `TeamDetails.*`
tests serve `READ_ONLY_PANEL`), `utils/capacityImport.test.ts`; fixtures in `test/flow.ts`. `pages/TeamDetails.tsx` is at 252 lines after the 2026-11-08 splits
(`TeamPageHeader`, `TeamViewNotices`, `TeamResetConfirm`, `TeamFacts`, `TeamProposalNotes`, `TeamTimelineButtons`, `hooks/useProposalFocus.ts` (Discard/Propose focus hand-over), and the `TimelineTitle`/`UnscheduledTraySection` the project page shares).

## People (`pages/People.tsx`, `pages/PersonDetails.tsx`)

The people directory (V10), a Teams clone under Administration after Teams, **visible to everyone** (reads are open, emails included): `useRegistryListControls` +
`RegistryListTable` (Name link, Email, Login), ADMIN-only New/Edit/Delete through `components/PersonEditorModal.tsx` (name, optional email, optional Login —
`components/UserSelect.tsx`, an ADMIN-only users search). A list row carries every field of the detail, so Edit takes the row as it stands (no detail fetch).
`components/PersonSelect.tsx` is the owner/manager picker (`["people","picker",term]`, enabled for every session, options `name (email)` or `name`); it and
`UserSelect` are thin wrappers over `components/SearchPicker.tsx` (debounced server-side search, the picked entry held by the caller). A 409 on save marks the
email field, or the login field when the server's detail says the link is taken. The family is spelled out in `utils/peopleLinks.ts`; the team editor's manager
is a person (`managerPersonId`). `PersonSelect` also takes `disabled` and `error` (the plan editors' Owner: read-only for a caller who may edit only another
part of the modal, and the required-owner message).

## Public holidays (`pages/PublicHolidays.tsx`, v0.7.0)

`/public-holidays` is Flow's holiday page ported (its `ColumnTable` is a plain `Table` in a `ScrollRegion` here), a leaf of the Administration section after
People (`IconCalendarOff`, palette "Public holidays" / PL "Święta państwowe") that **everyone sees** (reads are open, like Teams and People; the dictionary is
global and read by every timeline). The page is a year `Select` (the data's years + this year + next), one table per year (date, weekday, name) and, for an
ADMIN only, an add strip, a row delete behind `ConfirmDeleteModal` and the Polish preset button (`POST /public-holidays/apply-preset`). The dictionary is handed
to `Timeline`'s `holidays` prop. Files: `api/calendar.ts` (`listPublicHolidays` unwraps `{items}`; `createPublicHoliday`, `deletePublicHoliday`,
`applyHolidayPreset`; the types are the spec's `PublicHolidayResponse`/`HolidayPresetResponse`), `hooks/useHolidays.ts`, `utils/publicHolidays.ts` (Flow's
helpers: `holidayYears`, `holidaysOfYear`, `weekdayName`, `localYear`, `yearOf`), `utils/calendarLinks.ts` (`publicHolidaysPath`),
`locales/{en,pl}/calendar.json` (strings `calendar.*`).

- **ONE cached query, two consumers.** The dictionary is `["calendar","holidays"]` (`HOLIDAYS_QUERY_KEY`, `staleTime` 1 min, so another admin's edit reaches a
  mounted page soon). The page reads it with its own `useQuery` on that key; every timeline component (`ProjectTimeline`, `TeamTimeline`, `RoadmapTimeline`,
  `ProgramsTimeline`) and `MilestoneScheduleModal` read it through `useHolidays()` = `{holidays, failed}`: `[]` while loading or on a failure (the holiday layer
  is decoration and the schedule pre-check is only a pre-check; the server's views and 400 are the rule), `failed` true only when there is no copy at all, which
  the timelines pass on as `holidaysFailed` so `Timeline` shows its muted "could not be loaded" line. A page test that does not serve
  `GET /api/v1/public-holidays` therefore sees that line (the 404) and no holidays.
- **A write refreshes `["calendar"]`, `["plan"]` and `["roadmap"]`** (`refreshQueriesAfterMutation`): the holiday write bumps the plan revision server-side and
  every view's working-day figures changed. A mounted project view, the roadmap and the programs page (`["roadmap","programs"]`) all follow.
- **The year picker** shows ONE year at a time, client-side (the endpoint is unpaged): the years in the data, the current year, the year after it (so the Polish
  preset can be applied to the coming year on an empty list) and the viewed year. A successful add jumps the picker to the new row's year.
- **The Polish preset** (ADMIN): the "Add Polish public holidays for {{year}}" button opens a `ConfirmActionModal` (non-destructive:
  `confirmColor="astrolabe"`); `POST /public-holidays/apply-preset {preset: "POLISH", year}` for the VIEWED year; on success the fixed-vocabulary toast
  `calendar.toast.presetAdded` and a `role="status"` line "Polish holidays of 2027: 12 added, 2 already present." under the picker (cleared when the year
  changes or a holiday is added); a 400/403/other failure closes the dialog and shows the same inline `FormErrorAlert` as an add (`calendar.error.preset*`),
  never a toast. A holiday on a weekend is stored and shown in the table; it changes no figure.
- **Add / delete.** The add strip is a `<form>` (Enter submits; the button is disabled until the date is a real calendar date and the name is 1..100
  characters); a 409 reads the fixed `calendar.duplicateDate`, a 400 `calendar.invalid`, a 403 `calendar.error.forbidden` — the server's `detail` is never
  rendered. Delete is `useDeleteConfirm` + `ConfirmDeleteModal` with an interpolated row aria-label (`calendar.deleteAria`); a 404 on delete reads "This holiday
  no longer exists".
- **Tests.** `PublicHolidays.test.tsx` (Flow's, plus the preset), `utils/publicHolidays.test.ts`, `api/calendar.test.ts`; the wiring into the pages is one test
  each in `ProjectView|TeamDetails|Roadmap|Programs.test.tsx`; `MilestoneScheduleModal`'s pre-check is `ProjectView.test.tsx` and `milestoneForm.test.ts`.

## Users, feature flags and permissions (`pages/Users|CreateUser|EditUser|ChangePassword|FeatureFlags|UserFeatures|UserPermissions.tsx`)

Routes: `/users` (list, `/new`, `/:id/edit`, `/:id/features`, `/:id/permissions`; `utils/userLinks.ts` spells the family out) and ADMIN `/feature-flags`, all
under ONE `RequireAdmin` route (UX only: the server's `requireAdmin` is the rule).

### User management (`pages/Users|CreateUser|EditUser|ChangePassword.tsx`)

Passwords are generated client-side (`utils/password.ts`) and revealed exactly once: the modal (`components/OneTimePasswordModal.tsx`) sets
`closeOnClickOutside={false} closeOnEscape={false}`, renders `components/RevealablePassword.tsx` (masked by default, eye toggle, copy), and closing drops the
plaintext from state for good — the server never returns it. The admin Reset-password action (`hooks/useResetPassword.ts`) reuses the same generate→PUT→reveal
flow; the confirm is the shared `ConfirmActionModal` (its optional `error` slot carries the inline `FormErrorAlert`). `NavLeaf.adminOnly` gates the Users nav item (the Shell filters by `isAdmin()`); the management routes sit under ONE `<Route element={<RequireAdmin />}>`
in `App.tsx` (`auth.tsx`, beside `RequireAuth` — a regular user is sent home), so no page redirects itself; their queries additionally stay `enabled: isAdmin()`
so a redirected caller fires no request. UX only — the server's `requireAdmin` is the rule. The pages live under `/users` (`utils/userLinks.ts` is the one place
the family is spelled out; Flow's `/flow-users` rename and its legacy `/users…` redirect do not exist here).

**Login and person in one step (unreleased, after 1.13.3).** The new-login form (`CreateUser.tsx` only, not the shared `UserFormFields`, so the edit page has none) has a `Switch`
"Also create a linked person", ON by default (a page-local `useState`), posted as `alsoCreatePerson`; the server creates the person (the login's name and email, linked) in
the same transaction, and the create refreshes `["users"]` and `["people"]`. A 409 whose problem `detail` names a person gets its own message (`users.personAlreadyExists`),
the plain 409 stays the email-in-use one; a refused person means no login. The Users row menu offers "Create a person" (`POST /people` with the login's name, email and
`userId`, success toast `users.toast.personCreated`, a failure inline) only when the row's `personId` is null (`UserResponse.personId`: the id of the ACTIVE person linked to the login, read by the server with every list and detail
read); a success refreshes `["people"]` and `["users"]`. The inline failure belongs to the view it happened in (a filter, sort or page change drops it) and is cleared when
another row action starts. The person 409 is told from the user 409 by the problem `detail` text (no distinct problem type: the 23505 handler maps constraints to details only). e2e: the helper `createUserViaUi` turns the switch OFF unless asked, so a throwaway login leaves no person behind.

### Feature flags (`pages/FeatureFlags.tsx`, `pages/UserFeatures.tsx`)

Lettuce's per-user flag surfaces, ported with the MFA feature: `hasFeature()` (`api/session.ts`, reading the `astrolabe.auth.disabledFeatures` localStorage set
— currently awaiting its first area-gating consumer; MFA gates only the login flow server-side), the per-user editor at `/users/:id/features` (the Users table's
Features button — a checkbox per `Feature`, wholesale- replace PUT), and the ADMIN per-feature screen at `/feature-flags` (`adminOnly` nav leaf; state filter +
bulk enable/disable over every row matching the current filters behind a count-stating confirm — `hooks/useBulkFeatureUpdate.ts` loops the same per-user
wholesale PUTs client-side via `ConfirmActionModal`). The page itself is only the query, the table and the single-row toggle; the rest sits in co-located
pieces: `hooks/useFeatureFlagFilters.ts` (the persisted filters), `hooks/useFeatureFlagBulk.ts` (the bulk run wired to this screen),
`components/FeatureFlagFilters|FeatureFlagBulk|FeatureFlagRow.tsx` and `utils/featureFlags.ts` (`isFeatureEnabled`/`withFeatureEnabled`, the one place a
disabled set is rewritten). A second `Feature` value needs no restructuring: the feature `Select` already lists `FEATURES`. Both queries key under
`["users", …]`. Mind the wholesale-replace semantics: a PUT whose disabled set omits `MFA` ENABLES it. A bulk run with nothing to change is neither success nor
failure: it shows the inline gray `role="note"` Alert (`users.featureFlags.bulkNoChange`), never a toast.

### Permissions (`pages/UserPermissions.tsx`)

The ADMIN per-user permission editor at `/users/:id/permissions` (under the one `RequireAdmin` route; the Users row menu's Permissions item,
`userPermissionsPath` in `utils/userLinks.ts`) — a `UserFeatures.tsx` clone with the opposite polarity: one `Switch` per `PERMISSIONS` entry (`api/users.ts`,
derived from `PERMISSION_TEXT`, which `satisfies Record<Permission, …>` against the spec's `Permission` enum; checked = GRANTED, seeded from
`UserResponse.permissions`), saved as the wholesale `PUT /users/{id}/permissions` (`updateUserPermissions`), then `["users"]` and `["user", id]` are invalidated
and the page returns to `/users` with the `users.toast.permissionsSaved` toast. Labels and hints are `common.permission.*` / `common.permissionHint.*` (EN/PL).
A permission is NOT in the session (`api/session.ts` stores roles and disabled features only): it is read server-side per request, so a change needs no re-login
and the SPA never gates on it — a UI that needs "can this caller rank" reads the server's `can` flags (the planning views). A new spec `Permission` value is a
compile error in `PERMISSION_TEXT` until it has its label/hint keys (then its two `common` entries). The wholesale PUT carries over any granted value the page
has no switch for (a newer server), so a save can never silently revoke it.

## Jira connections (`pages/JiraConnections.tsx`, `pages/JiraConnectionDetails.tsx`, v1.1.0)

`/integrations/jira` (nav: Administration, **ADMIN only**, `IconPlugConnected`, palette "Jira"; both routes sit under `RequireAdmin` and their queries are
`enabled: isAdmin()`) is the registry of the Jira Cloud sites Astrolabe OBSERVES (nothing is ever written to Jira), `GET /integrations/jira/connections` under
`["jira","list",…]` through `api/jira.ts`: the Teams shape (`usePagedSort` + `RegistryListTable`, no name filter - the endpoint has none; columns name (the
link, a gray "Disabled" badge), site (an external link, `rel="noopener noreferrer"`), project keys, last test, **Status**, last run, kebab Open / Edit /
Delete). **Status** is `components/SyncStatusBadge.tsx` over the connection's server-derived `status` (`SyncStatus`: nothing is stored; CURRENT green, FAILED
red, STALE orange, NEVER_SYNCED / DISABLED gray, label `sync.status.<STATE>`) with a secondary line from `utils/syncStatus.ts`: the failure streak while there
is one ("3 failures in a row · TOKEN_UNREADABLE", plural forms EN/PL), else "not polled: test the connection first" (`discoveredAt == null`), "manual only",
"due now" or "next poll in 7 min" (minutes rounded UP, hours from 2 h); `now` is `hooks/useNow.ts`'s minute-ticking client clock (the telemetry section passes
the server's `generatedAt`), a wording only: no decision rests on it. **Last run** is the connection's own `lastRun`
(`{id, startedAt, finishedAt, outcome, errorCode, running}`, null before its first run; the SERVER reads it for the page's rows, scoped to the connection): an
outcome badge and when it started, "—" for none. While any listed connection's `lastRun.running` is set the list is re-read at the same bounded poll as the run
table (`hooks/useBoundedPoll.ts`), so its badge moves by itself. **Open pages follow the scheduler**: the list, the connection and its runs
(`useSyncRuns(..., IDLE_REFRESH_MS)`) are also re-read every 30 s while the tab is visible (`utils/syncRuns.ts`; TanStack pauses it in the background), even
after the fast poll's safety net stopped, so a scheduled run, or a run the server stopped calling running, reaches an open page; Refresh now's claim settling
re-reads all three. `useNow(period, readAt)` floors the clock at the query's `dataUpdatedAt`, and a connection whose `nextPollAt` has passed reads "due now"
alone (no clock time). `components/JiraConnectionEditorModal.tsx` creates and edits (rules in `utils/jiraForm.ts`, mirrored from `JiraConnection.kt`; the 409
marks the name). **The token is write-only**: never pre-filled, a password field with `autoComplete="new-password"`; on edit the hint is "A token is stored.
Leave blank to keep the current token" (from `hasApiToken`) and a blank field is OMITTED from the PUT (a typed one rotates it); never logged, shown or echoed.
**The site is the connection's identity**: read-only on edit (a PUT with another one is a 409). **A PUT is a full replace**: `toJiraConnectionRequest` always
sends `authScheme`, `enabled` and **`pollIntervalMinutes` (the number, or an explicit `null` for manual only - never omitted: an omitted member resets the
server to 15; pinned in `jiraForm.test.ts` and the editor's rename round trip)**. The editor's **Polling** `Fieldset`: a `NumberInput` 5..1440 step 5 (default
15, `clampBehavior="none"`: a 3 or 2000 is refused with the rule's sentence, never clamped on blur) and a "Manual only (no polling)" `Checkbox` that disables it
and sends `null`; unticking brings the number back. The modal's "Test connection" needs the name too (the server's probe body requires it) and probes with the
form's values (an ad-hoc call with the token in the body) unless editing with a blank token, which probes the STORED connection and refreshes `["jira"]`;
**while the form's account, scheme or keys differ from the saved ones, a note says the stored probe tests the SAVED settings** (`probeSettingsDiffer`, the
server's own last-test invalidation set). A saved edit that cleared the verdict says "Not tested since the connection was last changed" (`untestedKey`; the verdict cell of the facts table and of this list is `components/ConnectionTestBadge.tsx`, shared with Flow: `layout="fact"` date then badge, `layout="row"` badge then date), and the
toast asks for a new test. A 400 on save shows the server's sentence under the fixed lead. **Delete** goes through `useDeleteConfirm` + `ConfirmDeleteModal`
(never `window.confirm`); its body (`DeleteBody`) says the connection's links between plan items and Jira items are unlinked (the server does it in the same
transaction), with the count of LIVE-node links from `GET /integrations/jira/bindings?connectionId=&pageSize=1` (`total`; that list hides dead-node bindings, so
the sentences say "live plan items" and never claim there is nothing else; a count-less sentence while it loads or fails). A new connection lands on its page.

The page is a thin adapter over the shared shell `components/ConnectionDetailsPage.tsx` (route-id parse keyed by `:id`, load triage, header with Edit, sections column, editor modal; it takes `kind`, the list path, the read, a `sections` render slot and the `Editor`; the Flow page is its twin). `/integrations/jira/:id` has h3 sections inside `Box maw={CONTENT_MAX_WIDTH}`, each with a component of its own so the page stays a composition (the Bindings
section is the third, `components/JiraBindingsSection.tsx`, below): **Connection** (`components/JiraConnectionSection.tsx`: the facts table - the token only as
"stored / not stored" -, **Test connection** on the STORED token (the verdict is also said in a polite status region, `components/ConnectionTestStatus.tsx`, and
an old result is cleared the moment a new attempt starts) with the result in `components/ConnectionTestResults.tsx` (Flow's, ported: one row per probe, a
passing row GREEN, a failed required row RED, a failed optional one ORANGE, a row the server did not run (`SKIPPED`, after a failed `tenant_info`:
`utils/connectionTestRows.ts` `isSkipped`) a gray "Skipped" that the status sentence does not count as a failure, the failure in words with its code kept
visible and the scope the probe needs; **the note "a 401 on one probe while `myself` passes = a missing scope, not bad credentials"** shows exactly then;
`recorded: false` says the result was dropped because an edit raced it) and refreshes `["jira"]` (the discovery, the mapping defaults and the verdict moved),
**Refresh now**, and the runs table) and **Mapping** (`components/JiraMappingSection.tsx`: "Test the connection first" until `connection.discoveredAt` is set -
no empty form, no discovery request -, then the discovery report, the editor and Peek).
**Coverage** (`components/JiraCoverageSection.tsx`, 1.14, between Mapping and the bindings list): `GET …/{id}/coverage` (query key `["jira","coverage",id]`, so a binding change, a Test and a finished run - the Connection section's `wasRunning` effect - all refresh it) as a real table named "Coverage per level" (column headers; the level word is the row header), one row per mapped level with the in-scope, linked and open-and-unlinked counts right-aligned, no colour (a count is not a verdict), and a dimmed "Counted from the census of … (UTC)" line from `censusAt`. `NOT_SYNCED` says "Not synced yet" and `MAPPING_UNUSABLE` a gray note, each instead of a table (never zeros); a failed read is the inline `ErrorAlert`. Tests: `JiraCoverageSection.test.tsx`, the outline in `JiraConnectionDetails.test.tsx`.

**Development stub (1.5.1):** `connection.stub` (derived by the server per response, never stored: the stub is configured AND the site's label starts with
`stub-`) shows a gray "Development stub" badge (`components/JiraStubBadge.tsx`) after the site in the registry's site cell and in the connection facts, and
`result.stub` shows a gray `role="note"` Alert under a Jira test result (`ConnectionTestResults`: `jira.test.stubNote`); the polite status sentence is
unchanged. The editor's site hint stays free of the dev convention (production users must not read it).

The section's facts also carry **Status** (the badge), **Last success** (the date and `ageText`), **Next poll** and **Polling** ("every 15 min" / "Manual
only"). **Refresh now** is disabled while a run is running (the POLLED runs list's verdict, the connection's own `status.lastRun.running` only until the list
arrives; whoever started the run, a person or the schedule), and when that run ends the connection and the registry are re-read so the facts follow. It is
`POST /integrations/sync/runs {kind: "JIRA", connectionId}` (`api/sync.ts`): the 202 claims a run, the page re-reads the runs and `hooks/useSyncRuns.ts` POLLS
`GET /integrations/sync/runs?kind=JIRA&connectionId=` (react-query `refetchInterval`, `RUN_POLL_MS` 3 s) **only while the SERVER says a run is running
(`run.running`), and stops when it ends and when the page unmounts**. **The client never judges a run's age by its own clock**: `running` is the server's
verdict (unfinished and younger than `sync.maxRunMinutes`; one rule, `SyncRunService.isRunning`, shared by the run list, the connection's `lastRun` and the
Deviations view). The one client-side bound is a safety net: the poll stops `RUN_POLL_MAX_MS` (10 min) after the page first saw the newest running run, latched
on that run's id (`useBoundedPoll`), so a NEW claim after the bound polls again. **A `409 run-in-progress` is a normal state** (`isRunInProgress`; now only a
race, since the button waits for a running run): a plain-text note "already running" while the server still says a run is running, never a red alert or a toast.
`components/SyncRunsTable.tsx` names the trigger (Manual / Scheduled) and reads the outcome honestly: SUCCEEDED (green) / FAILED (red) / ABANDONED (orange) from
`outcome`, an unfinished row as "Running" (gray) or "Interrupted" (orange; "No result was recorded and nothing is running it now" - no claim about what happens
next) by the server's `running`, the counters, and `errorCode` as `utils/syncRuns.ts` `errorCodeText` - a human EN/PL sentence with the code kept visible, for
every code the server can write (Jira's fetch vocabulary, the probes' `PROJECT_NOT_VISIBLE`/`TOKEN_UNREADABLE`, the run's own
`NOT_DISCOVERED`/`MAPPING_INVALID`/`MAPPING_UNREADABLE`/`CONNECTION_GONE`/`CONNECTION_DISABLED`/`RUN_DEADLINE`/`SHUTDOWN`/`INTERNAL`/`ABANDONED`; an unknown
code reads as itself) - and `errorDetail` as clamped plain text.

**The mapping editor** (`components/JiraMappingEditor.tsx`, pure model in `utils/jiraMappingForm.ts`): a `Fieldset` each for Program / Project / Milestone - a
level `Select` over the DISCOVERY's levels labelled "Level 1 — Epic" (the type names), clearable for program and project (unset = null in the document),
required for the milestone, and three field `Select`s: start and end offer only `date` fields, the estimate only `number` fields (`fieldOptions`), the
discovery's default marked "(default)" in the option LIST and as a short "Default" note under the select - never in the closed value (a narrow column would cut
it off); `utils/jiraMappingForm.ts` labels are name and id only. The form opens on the SAVED mapping, else on the `defaults`; turning a level on fills its
fields from the defaults; "Use the defaults" restores them. Estimate unit POINTS / HOURS / DAYS + the man-days-per-unit factor (**hidden and not sent for DAYS** -
the server ignores it - 0 < x <= 1000, two decimals), and the Team field (the site's `atlassian-team` field). **A saved mapping that no longer fits the site
stays displayable and fixable**: the GET's `problems[]` are amber lines (one orange `role="note"` list), and a stored level or field the discovery no longer
offers stays a flagged option ("Level 5 (not on this site)", "customfield_9 (not found on this site)", "(a number field, not valid here)") instead of being
dropped. Client rules are the shape rules only (milestone required, levels strictly decreasing, the factor); everything that needs the discovery is the
server's: a `400` shows the server's own sentence (it names the level or field) under a fixed lead, `409 jira-not-discovered` / `jira-token-unreadable` are told
in words. **The discovery report** (`components/JiraDiscoveryReport.tsx`) is what the first real-site test reads: counts, the levels, one green line per
assumption marker found (Target start / Target end with the `schema.custom` that identified them, Start date, Due date, story points, Team) and an AMBER line
for each NOT found, plus a gray line for a legacy Epic/Parent Link field.

**Peek** (`components/JiraPeek.tsx`): an issue-key field with the `ISSUE_KEY_PATTERN` check, `GET …/peek?key=`, the result as ONE table (the issue with
`JiraKeyLink`, what the mapping resolves, the raw values); a result belongs to the mapping it was read under (`resetKey`: the saved mapping and the discovery),
so a save or a new test hides it while the typed key stays; the raw values are arbitrary JSON and are rendered as TEXT NODES only (a string as is, anything else
as clamped JSON). 400 / 404 / 409 / 429 / 502 show inline (the 400 with the server's sentence, the 502 with Jira's failure code put in words).
**`components/JiraKeyLink.tsx`** (Flow's, ported; C9 uses it too) takes the connection's `siteUrl`: an external link `{site}/browse/{KEY}`,
`target="_blank" rel="noopener noreferrer"`, plain text when the site is not `https://`. **`components/JiraKeyWithPrevious.tsx`** (1.13) is the key cell of the connection page's bindings list (`observation.issueKey`) and of the Deviations Jira cell (`jira.previousKey`): the current key as the link and, only when the key the issue was last read under differs (a moved item), a muted "was OLD-1" / "wcześniej OLD-1" beside it, the pair a `role="group"` named "NEW-1, was OLD-1"; the timeline chips show the current key only. Strings: `jira.*` (`jira.link.was`, `jira.link.keyWas`) (the `errorCode.*` table is shared by the probe rows
and the runs). Tests: `JiraConnections.test.tsx`, `JiraConnectionDetails.test.tsx`, `JiraConnectionEditorModal.test.tsx`, `ConnectionTestResults.test.tsx`,
`ConnectionTestStatus.test.tsx`, `SyncRunsTable.test.tsx`, `JiraMappingEditor.test.tsx`, `JiraDiscoveryReport.test.tsx`, `JiraPeek.test.tsx`,
`useSyncRuns.test.tsx` (fake timers, incl. a second claim after the bound), `SyncStatusBadge.test.tsx`, `useNow.test.tsx`,
`utils/jiraForm|jiraMappingForm|syncRuns|syncStatus|jiraLinks.test.ts`; shared fixtures in `test/jira.ts`.

## Flow connections (`pages/FlowConnections.tsx`, `pages/FlowConnectionDetails.tsx`, v1.5.0)

`/integrations/flow` (nav: Administration after Jira, **ADMIN only**, `IconActivity`, palette keywords `flow capacity roster`; both routes under `RequireAdmin`,
queries `enabled: isAdmin()`) is the registry of the Flow instances Astrolabe READS team capacity and rosters from (nothing is written to Flow),
`GET /integrations/flow/connections` under `["flow","list",…]` through `api/flow.ts`: the Jira registry's twin (`usePagedSort` + `RegistryListTable`; columns
name, base URL, time zone, last test, **Status** (`SyncStatusBadge`, `ready` = `flowReady`: a passing test or a mirrored document, the server's sticky rule),
last run, kebab; the test cell is the shared `ConnectionTestBadge`) with the same slow re-read (`IDLE_REFRESH_MS`) and bounded poll while a run runs. `/integrations/flow/:id` is a thin adapter over the same shell (`components/ConnectionDetailsPage.tsx`, see the Jira section) and has two h3 sections: **Connection**
(`components/FlowConnectionSection.tsx`: facts via the shared `SyncFacts`, Test connection on the STORED token, Refresh now =
`POST /integrations/sync/runs {kind: "FLOW"}`, `SyncRunsTable kind="FLOW"`; a test writes NO mirror - the run does - so the Teams section follows a run's end,
not a test) and **Teams** (`components/FlowTeamsSection.tsx`, below). The shared pieces are kind-aware, never forked: `ConnectionTestResults kind="FLOW"` words
the probes (`flow.probe.*`), adds the document's size and the truncation note and has no Jira scope note; `errorCodeText(code, t, kind)` (`utils/syncRuns.ts`)
has the Flow table (`flow.errorCode.*`, the revoked-token sentence tells to issue a new token in Flow) and falls back to the shared sentences;
`useSyncRuns`/`syncRunsKey` cache Flow's runs under `["flow"]`, Jira's under `["jira"]`. The generic connector vocabulary lives in `sync.*` (`sync.status.*`, `sync.runs.*`,
`sync.test.*`, `sync.details.status…`, `sync.errorCode.*`; `jira.test.scopeHint/scopeNote/stubNote/cloudId` stay Jira-only) and is shared as is; the Polling labels and rule live in `common.polling.*` (`components/PollingFields.tsx`,
`utils/pollingForm.ts`, used by both editors).

`components/FlowConnectionEditorModal.tsx` (rules in `utils/flowForm.ts`, mirrored from `FlowConnection.kt`): **the base URL is the connection's identity**
(read-only on edit) and is written canonically when the field is left and before every send (`normaliseBaseUrl`: lowercase, default port and trailing slash
dropped; a path, query or credentials are NEVER cut, the form refuses them; whether the origin is one the OPERATOR listed is the server's 400, shown with its
own sentence under the fix (two sentences since 1.5.1: `NOT_CANONICAL` "the origin alone, in lowercase…" and `NOT_LISTED` "not one of the Flow origins this
server is configured to allow…"; a port is never the reason); the create form reads `GET /integrations/flow/origins` under `["flow","origins"]` (create only,
ADMIN) and prints "Allowed on this server: …" after the hint (`allowedOriginsHint`; the plain hint while loading or when the read fails, a "no Flow origin is
configured" note for an empty list); the **time zone** is a text field pre-filled `Europe/Warsaw` (Flow's metrics zone) checked by `isKnownTimeZone`
(`Intl.supportedValuesOf("timeZone")` when the engine has it, the formatter plus a region's shape otherwise; a bare offset is refused); the **token is
write-only** (`PasswordInput`, `autoComplete="new-password"`, shape `flow_int_` + 43 characters, a blank one omitted from the PUT and "A token is stored. Leave
blank to keep…" from `hasApiToken`); **a PUT is a full replace**: `pollIntervalMinutes` (default **60**, or an explicit `null` for manual only) always travels.
A new token or zone clears the server's verdict, so the toast asks for a new test (`clearsVerdict`); there is no Jira-style "saved settings" note: the stored
probe (blank token) tests the SAVED token and zone (the zone feeds `sprintsSince`).

**Teams section**: `GET /integrations/flow/teams?connectionId=` under `["flow","teams",id]` (unpaged, any signed-in user, re-read every `IDLE_REFRESH_MS` and
when a run ends): the mirror's teams with membership and sprint counts, the linked Astrolabe team (a link to its page) with Unlink (an in-page
`ConfirmDeleteModal`, never `window.confirm`; "capacity already imported stays"), or the server's UNIQUE suggestion with **Link** (`POST /team-bindings`),
**Link all suggested** (`POST …/team-bindings/match`, ADMIN; the outcome is a polite status line "N linked, M without a unique match, K linked already"), and
when the mirror was read; before the first run it reads "Refresh the connection first". The suggestion is the server's, never computed here. A disabled
connection links nothing (a note; the server answers 400). A refused link shows a fixed lead and, for a 409 `already-bound` or a 400, the server's sentence, and
re-reads the list. A link or unlink refreshes `["flow","teams"]` and `["flow","team"]` through `utils/flowRefresh.ts` `refreshFlowLinks` (**the team page's Flow
panel of C11 keys on `["flow","team",id]` and gets the refresh for free**); nothing of the timeline views moves. Strings: `flow.*`. Tests:
`FlowConnections.test.tsx`, `FlowConnectionDetails.test.tsx`, `FlowConnectionSection.test.tsx`, `FlowTeamsSection.test.tsx`,
`FlowConnectionEditorModal.test.tsx`, `PollingFields.test.tsx`, `utils/flowForm|flowLinks|pollingForm.test.ts`; shared fixtures in `test/flow.ts`.

## Changelog and app versioning (`pages/Changelog.tsx`, `src/changelog/`)

The user-facing changelog is a **build-time artifact** — no DB, no API, changes only with a deploy. `src/changelog/entries.ts` holds `ChangelogEntry` rows
(`version`, `date` `YYYY-MM-DD`, `en`/`pl` **markdown** bodies), newest first; the app's only human-readable version is `APP_VERSION` in
**`src/changelog/version.ts`** — its own tiny module so the shell's eager imports (VersionStamp, the what's-new dot) never pull the bilingual entries into the
main bundle (the entries ride the lazy Changelog chunk only). A release = the new entry at the top of entries.ts + the bump of that one literal (the Gradle
`1.0.0-SNAPSHOT` is unrelated); `src/changelog/entries.test.ts` pins `CHANGELOG[0].version === APP_VERSION`, so forgetting either half fails the suite. Dates
stay descending (same-day releases are fine — newest stays on top), versions unique and both bodies non-empty. Bodies are *content*, so they live in the data
file, not `locales/`; the PL body follows the Polish voice conventions (inclusive slash forms, active voice). Keep phrases that tests assert on in plain text
runs: markdown formatting splits text nodes, and testing-library's `getByText` matches direct text nodes only. The release convention itself (both bodies by
hand, descending dates, the tag and the GitHub release, which PRs bump the version) is `web/CLAUDE.md` and `app-releases.md`.

### Changelog rendering & UI wiring

- `pages/Changelog.tsx` (`/changelog`, authenticated, lazy) renders the entries as a Mantine
  `Timeline` with `MarkdownView` bodies in the viewer's language, and calls `markChangelogSeen()`
  on mount. **Bodies are authored EN+PL only, by policy** — a new shipped UI language does NOT
  add changelog fields; non-authored languages read the English body (`AUTHORED_LANGUAGES` in the
  page). `components/MarkdownView.tsx` (Typography + react-markdown + remark-gfm/gemoji, all
  lazy-chunk-only deps) is the one markdown renderer — reuse it for future markdown content.
- `components/VersionStamp.tsx` shows `v<APP_VERSION> · <sha> · <time>`; its optional `to` prop
  renders it as a router link — the navbar footer instance links to `/changelog` (no dot on it any
  more), the Login/AuthCard instance deliberately stays plain (the route is behind auth). The
  "Changelog" entry is an `ACCOUNT_NAV` leaf rendered by the `UserMenu` and the command palette,
  not a sidebar item.
- The **"what's new" dot** is a red Mantine `Indicator` around the header `UserMenu` trigger (it
  carries the `title="What's new"` e2e locates; the Changelog menu item shows a text badge
  instead of a second title, which would trip strict-mode locators while the menu is open), shown
  while localStorage `astrolabe.changelog` (`{seenVersion}`) differs from `APP_VERSION`. It's driven
  by `hooks/useChangelogSeen.ts` via `useSyncExternalStore` over a module-level listener set — do
  **not** replace that with a plain localStorage read in state: the shell renders before the
  page's mark-seen effect, so the dot would only clear on the next navigation. The seen-state is
  device-level (survives logout, like `astrolabe.lang`) and hand-rolls its guarded read/write, not
  `useStoredState` (that hook owns the `astrolabe.viewSettings.*` namespace).
- Tests: `pages/Changelog.test.tsx`, `changelog/entries.test.ts`, the dot/nav cases in
  `App.test.tsx`, the link/prefix cases in `components/VersionStamp.test.tsx`.

### The Jira and Flow release-note caveat

**Binding for later Jira work:** until a real site has been tested (`jira-sync.md` "First real-site walk-through"), every changelog entry and release note that
touches the Jira pages carries the line "Proven against a built-in Jira stub; not yet tested against a real Jira site." (PL: "Sprawdzone na wbudowanej atrapie
Jiry; jeszcze nie przetestowane na prawdziwej witrynie Jira."); nothing on these pages promises polling or Flow before it ships. The import (1.2) is shipped and
carries the same caveat; its release note and its pages say that a name renamed in Jira previews as a new item, that an existing plan item is never overwritten
and that dates are copied only where the caller manages the team, and must not claim more (an owner's entry points only on the Plan page's work-stream menu (1.10) and, from 1.14, a linked program's menu and a linked project's page, no target windows, no matching of renamed
items). **Flow (1.5, 1.6):** until a real Flow has been compared (`flow-sync.md` "First real-Flow walk-through" and its ledger), every changelog entry and
release note that touches the Flow pages or the capacity deviation carries the same kind of line - "Proven against the built-in Flow stub; not yet compared with
a real Flow." (PL: "Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z prawdziwym Flow.") - and the Deviations section and the team page's line
promise nothing a stub cannot prove.

## The telemetry panel (`components/Telemetry*.tsx`)

The ADMIN telemetry panel (`components/Telemetry*.tsx`, the shell's right-hand aside: memory, storage, **sync**, requests, JVM) is the only chart surface in
0.1.0. **Sync** (`TelemetrySyncSection.tsx`, Flow's trimmed; the `sync` block of `GET /telemetry/current`, no history/trend) is whether this process runs the
scheduler and, per connection, the state badge, the last success's age (against the server's `generatedAt`), the failure streak with the newest run's code, the
next poll and the interval; it shares `SyncStatusBadge` / `utils/syncStatus.ts` with the Jira pages.

- **Telemetry panel** (`components/Telemetry*.tsx`, `hooks/useTelemetryPanel.ts`, `utils/telemetry*.ts`): the memory, storage, requests and jvm groups only
  (`GET /api/v1/telemetry/history?group=`), and one process role, `app` (`utils/telemetryRole.ts`). The sync and derive sections of Flow are gone.
- **`components/TableDisclosure.tsx`** (Flow's `DailyTableDisclosure`) is the collapsible accessible-table twin of a chart; use it for every chart that carries data a screen-reader user needs.

## Internationalization (i18n)

The rules: `web/CLAUDE.md` "Internationalization".

The SPA is **N-language by architecture** via react-i18next (`src/i18n.ts`); the shipped bundles are English (THE default and fallback everywhere) and Polish.
All user-facing strings go through `const { t } = useTranslation()` / `<Trans>` — **no hardcoded UI text**. Conventions:

- **Resources** live in `src/locales/{en,pl}/<area>.json`, one file per area (`appShell`, `auth`, `baselines`, `calendar`, `changelog`, `common`, `deviations`,
  `flow`, `home`, `jira`, `people`, `plan`, `programs`, `project`, `roadmap`, `sync`, `teams`, `telemetry`, `timeline`, `users`); `i18n.ts` merges them into a single
  `translation` namespace, so keys read `area.key` (e.g. `t("auth.signIn")`). Only EN is statically imported — its typed `en` tree is the key canon AND the
  runtime fallback; every other language is auto-discovered from `locales/<lang>/` via `import.meta.glob`. Bundles are eager on purpose; move non-EN to lazy
  loading when a 3rd language ships or a bundle grows large.
- **Keys are typed**: `src/i18next.d.ts` augments i18next's `CustomTypeOptions` with `typeof en` from `i18n.ts` (the `@public`-tagged export — knip can't trace
  the d.ts consumer), so every `t()` call and `i18nKey` is compile-checked against the EN tree — a typo or removed key fails `tsc`/`npm run build`. Fields
  holding a key are typed `ParseKeys` (from `i18next`), never `string` (the `NavLeaf` `label` pattern in `utils/navigation.ts`); functions taking a translator
  take `TFunction`, never a hand-written `(key: string) => string`.
- **`common.*` is the shared source**: actions, field labels, shared vocabulary (`common.dateFormatHint` is the date-input placeholder: `YYYY-MM-DD` in EN,
  `RRRR-MM-DD` in PL). Reuse it instead of duplicating; build Mantine `Select` option labels from `t()` at render so they translate.
- **Keep key parity vs EN for every shipped language** — a shipped bundle is all-or-nothing: every English key must exist in each `locales/<lang>/`
  (language-specific plural variants are expected), enforced by `locales/parity.test.ts` (auto-discovers language folders; also pins folders ==
  `SUPPORTED_LANGUAGES`). Use i18next interpolation (`{{name}}`) and plural keys rather than string concatenation.
- **Polish voice convention** (inherited from Lettuce): inclusive slash forms, active/direct voice, same tense and meaning as the English; spell out irregular
  feminines in full. No impersonal/passive dodges.
- **Tests render English**: `src/test/setup.ts` imports `../i18n` and forces `en`, so text-based assertions match the EN resources.

### Adding a language

- **Adding a language** = a complete `locales/<lang>/` folder (every area file, parity-gated) +
  one code in `SUPPORTED_LANGUAGES` (`i18n.ts`) + one `NATIVE_LANGUAGE_NAMES` line — the Record
  type and the parity test each fail loudly on a missed step. Server-side, the `LocalizedText(en, pl)`
  constructor arity is the parity gate for email texts (a new language means a new parameter —
  every email text becomes a compile error until translated), and `users/Languages.kt` mirrors
  `SUPPORTED_LANGUAGES`.

### The language switcher and the synced user language

- The language switcher is the Language section of `components/UserMenu.tsx` (the header account
  menu) — `Menu.Item`s of NATIVE language names (`NATIVE_LANGUAGE_NAMES`, deliberate constants:
  readable before switching, and `Intl.DisplayNames` yields lowercase forms); choice persists in
  `localStorage` (`astrolabe.lang`) and updates `<html lang>` (the `languageChanged` hook in
  `i18n.ts`). **The user language is ONE synced property (V1's `language` column)**: the switcher
  also fire-and-forget saves it server-side (`setUserLanguage` — it drives every email sent to the
  user), and `persistSession` applies the login/refresh response's `language` to the UI — signing
  in restores the user's language on any device, and an admin change propagates at the ≤15-min
  silent refresh. Emails render in the RECIPIENT'S stored language (`LocalizedText(en, pl)` in
  `infra/mail/`, EN fallback).

## Theming (tokens, tuple, overlays, logo)

The rules: `web/CLAUDE.md` "Theming".

**The design language is theme-owned** (Lettuce's "clean enterprise SaaS" posture) — `src/theme.ts` + `src/themeVariables.ts` + `src/theme.module.css` are the
single source, and `src/theme.test.ts` guards every contrast ratio:

- The brand is the 10-stop **`astrolabe` cyan tuple** (`#e3fafc … #0b7285 #095c6b`: Mantine's cyan shifted one step deeper) with
  `primaryShade: { light: 8, dark: 9 }` — Mantine's own shade 7/8 pair falls short of 4.5:1 for white text on this hue, so the primary shades sit one step
  deeper than a stock Mantine cyan (white on shade 8 is 5.6:1, on shade 9 7.6:1, pinned in `theme.test.ts`) — and `autoContrast: true`. **Restrained** — in UI
  chrome and status badges (chart series colours are `utils/chartColors.ts`'s): cyan marks only primary CTAs, the active nav item (a light tint + a 3px accent
  bar) and focus — it is the interactive accent and nothing else (see the colour vocabulary). Everything else is neutral BY THEME DEFAULT — `Anchor` is
  text-coloured with a hover underline, `Chip` is `variant="light"`, `Badge` is `variant="light"`, `ActionIcon` is `variant="subtle" color="gray"` (destructive
  ones pass `color="red"`), `Menu` is bottom-end in a portal, tables are `verticalSpacing="xs"` (≈40px rows). Pages never pass those props back. GREEN is the
  SUCCESS colour, red the BLOCKING one, orange the warning one (soft findings, waived); the ADMIN role badge is `variant="outline" color="gray"`. **Never use
  teal for success** — its tints are near-identical to the cyan brand's; `theme.test.ts` pins the CIEDE2000 distance between the brand and success tints (≥ 10)
  and fills (≥ 20).
- `theme.module.css` is scheme-aware **via `light-dark()`** throughout (tables card-framed on a quiet tinted canvas, white header/navbar surfaces, hairline
  borders) — new surface styling follows that pattern, not `[data-mantine-color-scheme]` selectors. Every `Table` inherits the card frame + hoverable rows +
  neutral compact header from the theme's `Table.extend` — don't add per-table frames. **The hover tint is theme-owned and AA-tested too** (`tableHover` in
  `themeVariables.ts`, applied by `table.table` in `theme.module.css` as `--table-hover-color`; light gray-1 `#f1f3f5`, dark dark-6 `#2e2e2e`, because Mantine's
  own dark-5 left dimmed text at 4.44:1): `theme.test.ts` pins that every table ink clears 4.5:1 on it in both schemes and that it stays ≥ 1.1:1 against the
  row. Never pass `highlightOnHover` (or a hover colour) to a single `Table` — change the token, and the test says whether it still holds; the e2e axe scan of
  hovered rows is in `accessibility.spec.ts`.
- Soft diffuse `shadows` scale; tightened heading sizes (pages title themselves with `order={2}`).
- Inter is bundled (`@fontsource-variable/inter`, imported in `main.tsx`) so it loads same-origin and satisfies the CSP `font-src 'self'`; the system stack is the fallback.
- **Overlay accessibility rules (pinned by the e2e axe sweep over dialogs):** every `Modal` and `Drawer` passes
  `closeButtonProps={{ "aria-label": t("common.action.close") }}` — Mantine's close X has no default name — or hides the X with `withCloseButton={false}` when a
  footer button is the one deliberate exit (`OneTimePasswordModal`). An OPEN row menu is scanned too (the `accessibility` spec opens the Teams, Baselines and
  roadmap menus, light and dark): its dropdown is white / dark-6, and `theme.test.ts` pins the destructive ink and tint on those surfaces.
- **A scroller that can overflow is a focusable, labelled region.** A table wider than its box or capped by `maxHeight` goes in `components/ScrollRegion.tsx`
  (native scroller, `tabIndex={0}`, `role="region"`, the table's own i18n name as `aria-label`, the `tableScroll` focus ring) — never a bare
  `Table.ScrollContainer`; axe's `scrollable-region-focusable` fails any that overflows without it.
- **An option list is a scroller too — and the LISTBOX is the scroller.** The theme gives every `Select`/`MultiSelect`/`Autocomplete`/`TagsInput`
  `withScrollArea: false` and `classNames.options` (`theme.module.css` `.comboboxOptions`:
  `max-height: calc(13.75rem * var(--mantine-scale)); overflow-y: auto`). Mantine's default inner `ScrollArea` viewport is a plain scroller inside the
  `role="listbox"`: axe's `scrollable-region-focusable` flags it once ~100 options overflow, and a tab stop on it puts a focusable non-option in the listbox
  (`aria-required-children`, the reverted v0.6 C4 attempt). axe exempts exactly the element that IS a combobox popup (the listbox the input's `aria-controls`
  names), so the listbox scrolls itself; the input keeps DOM focus and `aria-activedescendant` scrolls the active option into view.
  `maxDropdownHeight`/`scrollAreaProps`/`floatingHeight` therefore no longer apply (the cap is the CSS). Pinned by the overflow + keyboard + axe test in
  `e2e/tests/dependencies.spec.ts` (the `accessibility.spec.ts` scans of the open lists overflow only on a full stack).

### Colour tokens

- **Colour tokens are AA-tested** (`themeVariables.ts`, ported from Lettuce): `LIGHT_TOKENS`/
  `DARK_TOKENS` (text, dimmed, canvas, border, table hover, error inks) and
  `LIGHT_VARIANT_INKS` (the per-hue ink over a `variant="light"` surface — Mantine's stock light-
  scheme ink fails 4.5:1 for several hues) go in through `cssVariablesResolver` in `main.tsx`.
  Never hand a shade-suffixed colour (`"orange.8"`) to a light Badge/Alert — the tint comes from
  the hue, the ink from this map. **`--astrolabe-accent-ink`** is the brand hue where it must be
  PERCEIVED against the canvas (the nav marker, the anchor hover underline, focus): the light
  primary (deep cyan `#0b7285`) in light mode, the 4-shade (`#3bc9db`) in dark mode. The light-variant ink for the brand hue is `#095c6b`. Success is GREEN (ink
  `#236b34`; cyan and teal tints are indistinguishable, pinned by a CIEDE2000 distance test in `theme.test.ts`); red = blocking/violation, orange =
  warning/overload/drift — the full vocabulary is `web/CLAUDE.md`. `utils/chartColors.ts` exports `CATEGORY_PALETTE` only (`astrolabe.6`, `violet.5`, `pink.6`,
  `indigo.5`, `gray.6` — categorical series, never semantic status colours). `index.css` repeats the two canvas hexes for
  the first paint (`public/color-scheme.js` stamps the scheme on `<html>` before the bundle
  loads); the theme test pins them equal to the tokens.

### The logo

- The logo SVGs (`public/logo-{light,dark}.svg` + `favicon.svg`; rendered by `components/BrandLogo.tsx`) are the brand mark: a stylised **astrolabe** on a 48×48 grid — a disc, a
  limb ring with 24 ticks and 4 major ticks, an off-centre rete ring with three star pointers, an alidade rule with sight vanes and a pivot. The favicon is simplified (disc, ring,
  alidade, pivot) so it survives 16 px; check both in both colour schemes. The geometry is computed (ticks on a circle) — change it in a vector editor or regenerate it, not by hand-editing path data.
  Restyle rule: keep aria-labels, roles, and real semantic elements stable — e2e and unit tests locate by role/name. (Flow's "Rolling" logo is gone.)

## Not yet ported (port, don't reinvent)

When a feature needs one of these, port the sibling's `web/` implementation and its
`web/CLAUDE.md` section wholesale:

- **Lettuce's** `safeBackParam` open-redirect guard for any future `?back=` param,
  `StatusPill`/`MetaStrip`/`FormFooter`/`ListToolbar` (`lettuce/web/src/components/`), and
  `useDiscardGuard` + `DiscardGuard` for dirty-form navigation (its in-app half is the data router's `useBlocker`, which
  the plain `BrowserRouter` does not have; only the `beforeunload` half, `hooks/useBeforeUnloadGuard.ts`, was ported in Flow — port it again with the first dirty-form page, e.g. the capacity editor).
- **Covenant's catalog surface** (`covenant/web/src/`) — the filter-set/facets pattern
  (`hooks/useContractFilterState.ts` + `components/ContractFilterControls.tsx`), the CodeMirror
  document editor, Save-anyway, and the reader/render-model views — port these only once the planning
  model needs a document- or finding-shaped list; today's Teams/Users lists are the
  `useRegistryListControls`/`Users.tsx` templates above, which is as far as the foundation goes.

## Storage keys, Web Locks and shared reference

- **localStorage:** `astrolabe.auth.*` (session), `astrolabe.viewSettings.*` (`useStoredState`), `astrolabe.lang`, `astrolabe.changelog`. **sessionStorage:**
  `astrolabe.chunkReloadedAt` (the one-shot reload after a failed lazy chunk, `main.tsx`). **Web Lock:** `astrolabe.auth.refresh`. **CSS variables:**
  `--astrolabe-*`. None of Flow's `flow.*` keys exist; there are no legacy redirects.
- **Timeline view settings** (`astrolabe.viewSettings.timeline.*`, shared by the pages that show them, each a `useStoredState` with its own validator): `zoom`
  (project, team), `planZoom` (roadmap, programs), `criticalPath` (project and team, default false; `hooks/useCriticalPathPick.ts`), `baseline` (all four, an id or none), **`jiraBars`** (1.3, all four
  pages; a boolean, **default true**: the "Jira dates" toggle of the Jira shadow bar, `hooks/useJiraBarsPick.ts`; a stored non-boolean reads as the default).
  The team page's `teams.jiraColumn.<id>` (1.1/1.2: the remembered answer of whether the Jira column exists) is gone in 1.3 - the view's own `jira` blocks say
  whether a row is linked, so the Flags column needs no stored guess; a value an old browser still holds is never read or cleaned.
- The Polish user-facing noun for Users is "Użytkownicy/czki" (EN "Users").
