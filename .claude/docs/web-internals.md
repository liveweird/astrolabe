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

- [Home](#home)
- [Plan](#plan)
- [Project view](#project-view)
- [Roadmap](#roadmap)
- [Programs](#programs)
- [Milestones](#milestones)
- [Dependencies](#dependencies)
- [Team load](#team-load)
- [Baselines](#baselines)
- [Schedule proposals](#schedule-proposals)
- [Deviations, bindings and the Jira chips](#deviations-bindings-and-the-jira-chips)
- [Teams and the team page](#teams-and-the-team-page)
- [People](#people)
- [Public holidays](#public-holidays)
- [Users, feature flags and permissions](#users-feature-flags-and-permissions)
- [Jira connections](#jira-connections)
- [Flow connections](#flow-connections)
- [Changelog and app versioning](#changelog-and-app-versioning)
- [The telemetry panel](#the-telemetry-panel)

**Cross-cutting reference**

- [Internationalization](#internationalization)
- [Theming](#theming)
- [Not yet ported](#not-yet-ported)
- [Storage keys, Web Locks and shared reference](#storage-keys-web-locks-and-shared-reference)

## The shell and page chrome

The shell is `Shell` in `App.tsx`: grouped navigation, a 56 px header, `AppShell.Main` around the `<Outlet />` and the telemetry aside.
Rules: `web/CLAUDE.md` "Layout conventions"; the route of every page: its "Pages (the map)".

### Navigation

The model is `utils/navigation.ts`, shared by the sidebar and the command palette (the rules: `web/CLAUDE.md` "Layout conventions").

- `NAV_SECTIONS` is the labelled sections of `NavLeaf`s: the `label` is a typed i18n key, `adminOnly?` gates admin leaves, `keywords?` adds raw palette search
  terms (a renamed page's old name), and `visibleSections(isAdmin())` drops an emptied section.
- `ACCOUNT_NAV` (Change password, Changelog) is rendered by the header `UserMenu` and the palette, never by the sidebar.
- Leaf clicks close mobile navigation. `activeNavPath` picks the longest prefix and highlights Projects on a project's page.
- Planning groups plan views and lists. Teams and capacity groups staffing and scheduling. Integrations holds deviations and connection
  settings. Administration holds account controls and appears for administrators.
- **The icon rail** (Lettuce's): a header `ActionIcon` beside the Burger (`appShell.toggleNav`, `data-expanded` while expanded) narrows the desktop navbar from
  232 to 64 px (the mobile overlay is 248 px wide). `rail = navCollapsed && !opened`, remembered under `astrolabe.viewSettings.appShell.navCollapsed`.
  In rail mode each leaf is an icon-only `NavLink` (`classes.railLink`) whose `aria-label` IS the label, inside a right-hand `Tooltip`; section captions
  become hairline `Divider`s. The mobile overlay always shows full labels.

### The header and the palette

- The header holds the brand, `CommandPalette` and `UserMenu`.
- `UserMenu`: the avatar (identity from `GET /users/{id}` under the `["user", id]` key), language, theme, Change password, Changelog with the what's-new badge,
  for an ADMIN a "Telemetry panel" toggle, Sign out. The version stamp stays in the sidebar footer.
- Theme is three `Menu.Item`s (Light / Dark / System): the chosen one carries `IconCheck` + `aria-current`, and `closeMenuOnClick={false}` keeps the menu open.
  A SegmentedControl is a radiogroup, which axe `aria-required-children` refuses inside `role="menu"`.
- **Focus on navigation**: `hooks/useFocusMainOnNavigation.ts` (called in the `Shell`) focuses `#main-content` (`tabIndex={-1}`, ring suppressed in
  `index.css`, `preventScroll`) when the PATHNAME changes. It never fires for a `?baseline=`/filter/sort change or a same-path push, nor on the first render
  (a fresh sign-in or reload leaves the document start; the skip link is the first Tab stop), and it leaves a focus already inside main alone, so a page's
  own `autoFocus` wins in either mount order.
- **`components/CommandPalette.tsx`** wraps `@mantine/spotlight` (pinned to the core version) over a module-level store (`utils/commandPalette.ts`): the
  session's pages, plus an ADMIN-only show/hide action for the telemetry panel. No `highlightQuery`: it splits labels into `<mark>` fragments that
  role/name locators cannot match.

### Page chrome

The rules (the `Stack`, the widths, the one spinner, the heading outline, the tab title): `web/CLAUDE.md` "Layout conventions". The mechanics behind them:

- `components/PageHeader.tsx` takes `title` (the `order={2}` heading), `description?`, `backTo?`, `actions?`, a `toolbar?` row and a `switcher?` above the title.
- `components/LoadingBlock.tsx` is the one spinner (`TableLoadingRow` wraps it); `components/EditPageLoadState.tsx` is the edit pages' shared load-failure
  triage (a centred loader, else a back-to-list alert); `EmptyState` sizes the Tabler icon itself, and an optional `hint` is the next step under the label.
- Page tests pin the outline with `test/headings.ts`'s `headingOutline()`.
- The tab title is `appShell.documentTitle` = "{{page}} · Astrolabe", the brand alone for Home or a blank title. A detail page's entity name only exists once
  loaded, so its load and failure states pass a static title. Mantine's `useDocumentTitle` does not restore on unmount, so `test/setup.ts` resets
  `document.title` after each test.

### Heading outline guard

`pages/headingOutline.test.tsx` renders every route read from `App.tsx` (via `?raw`, so a new route is covered the moment it registers) under an ADMIN
session with an empty API and asserts the outline starts at h2 and never skips a level going down. A page whose real title needs loaded data passes a
static `title` to `EditPageLoadState`, so its load/failure state still opens with an h2 (TeamDetails).

## Quality gates and the build stamp

The gates and their rules (zero findings, no baseline, the size gate): `web/CLAUDE.md` (its opening bullets); the CI job: `ci.md`. The mechanics:

- **ESLint**: `npm run lint` carries `eslint-plugin-sonarjs` (recommended), `eslint-plugin-jsx-a11y` (recommended; static accessibility rules, two
  file-scoped overrides) plus core size/complexity backstops. It runs with `--cache --cache-strategy content` (`web/.eslintcache`, gitignored; a warm run
  takes a fraction of a second against about 12 s cold, and CI restores the file between runs, `ci.md`). The config is not type-aware, so a per-file cache
  is sound, and a config change or an ESLint/node upgrade re-lints everything on its own.
- **knip**: `knip.json` ignores only the `ajv` devDependency, which is pinned for `@stoplight/spectral-cli`'s resolution.
- **The API-contract gate**: `npm run lint:api` Spectral-lints the OpenAPI spec and `api-guidelines/examples/conformant.yaml` with `--fail-severity=warn`
  through the local ruleset `web/spectral.astrolabe.yaml`. It `extends` the shared `api-guidelines/api-guidelines.spectral.yaml` (the other team's area,
  never edited) and switches off only the two registered-gap rules `x-sla`/`termsOfService`, each with its reason.
- **`npm run check:api`** (`scripts/check-api.mjs`) regenerates the API types in memory and diffs them against the committed `src/api/schema.ts`; it never
  overwrites that file, so `gen:api` stays the one command that updates it.
- **Types**: `openapi-typescript` is installed with `--legacy-peer-deps` because its declared peer is TS `^5` while the scaffold uses TS 6 (the generated
  output is compatible), so a from-scratch `npm install` uses the same flag.
- **Build version stamp**: `vite.config.ts` injects `__APP_COMMIT__` (short sha, `+dirty` when the worktree has uncommitted changes) and
  `__APP_COMMIT_TIME__` (commit ISO timestamp) via `define`, declared in `src/vite-env.d.ts`.
  - Env vars `GIT_SHA`/`GIT_COMMIT_TIME` override the local-git lookup: the Dockerfile's SPA stage sets them (its worktree never matches the index, so the
    dirty check would false-positive), and CI can do the same when building without `.git`.
  - `src/components/VersionStamp.tsx` renders `v<APP_VERSION> · <sha> · <time>` at the bottom of the navbar (`App.tsx`) and under the login card
    (`components/AuthCard.tsx`).
  - The same constant has a second consumer: a small `transformIndexHtml` plugin in `vite.config.ts` writes it into `index.html` as
    `<meta name="astrolabe-build" content="<commit>">` (nothing else), so a build's shell and bundle always agree; `api/build.ts` reads it back (the deploy
    check, "Error boundaries, chunk reload and toasts").
- **Test fetch stubs**: `test/http.ts` `routeFetch(table)` answers by `"METHOD /path"` (exact, or `:name`/`*` patterns) with a body, a `Response` or a
  function of the call. An unlisted call rejects naming its method and path and fails the test in `setup.ts`'s `afterEach`. `test/planView.ts` (`planOf`) and
  `test/roadmapView.ts` build the view documents. A touched test file moves to the router (and to the builders) instead of a hand-rolled `mockImplementation`.

## Transport and session layer

The rules (never collapse a definitive and a transient failure, attach `timeoutSignal()`, the session boundary): `web/CLAUDE.md` "The typed API layer".
This is the machinery. The layer is small hand-written modules over the generated `schema.ts`; `openapi-typescript` (types only) plus hand-written fetch is
intentional, so Orval and Kiota are not used.

### `http.ts` — the transport's refresh internals

- **The single-flighted silent refresh**: on a 401, `authedFetch()` exchanges the stored refresh token once (concurrent 401s from the same session share
  one in-flight `/refresh` call) and retries once.
  - A DEFINITIVE rejection (no refresh token, or a 401/403 from the server) clears the originating session and signs out only if that session is still current.
  - A TRANSIENT failure (network, timeout, 5xx, 429, malformed body) keeps the session so a later retry can succeed: a network blip must not erase a valid session.
  - Stale requests and refresh completions never publish credentials, clear a newer login or retry across session identities.
- **Two tabs on one session** can race on `/refresh`, because the server rotates the refresh token (each works once, plus a 60 s server-side replay grace for
  a lost response; after that a replay is a 401). `doRefresh` serialises them with a Web Lock (`astrolabe.auth.refresh`, where the browser has
  `navigator.locks`; a lock that cannot be acquired falls back to an unserialised refresh). Inside the lock, and again after a 401/403, it adopts a pair
  another tab already stored (same session identity, different refresh token) instead of replaying or clearing; a different login (new identity) is never adopted.
- **A 401 can come at any time**: the server checks every access token against the user row per request (`security.md` "JWT model"), so a delete, a
  demotion/promotion, a password change or a logout elsewhere turns the NEXT request into a 401. The transport needs no special case, because the 401, silent
  refresh, retry path handles all of them:
  - a role change refreshes successfully into the NEW roles (`persistRefreshedSession` republishes them and `notifyAuthChange` re-renders the nav and
    `RequireAdmin`, pinned in `http.test.ts`);
  - a delete or a password change makes the refresh a DEFINITIVE rejection and signs the user out.
- **Wrappers**: `ApiError` (status + parsed body) is read through the RFC 7807 `detail`/`instance`/`type` getters, never by hand-casting `err.body`.
  `jsonRequest<T>()`/`voidRequest()` are the two wrapper shapes every ordinary endpoint wrapper uses. `buildQuery()` backs the list wrappers: it skips
  null/undefined/"" while `false` and `0` ARE sent, so an omit-when-false param is passed as `value || undefined` at the call site. Reach for the raw
  `authedFetch`/`safeJson` primitives only when a wrapper genuinely inspects the Response.
- **`timeoutSignal()`** (30 s, feature-detected for happy-dom) makes a hung request reject with a `TimeoutError` DOMException instead of pending forever;
  new `fetch` call sites in `api/` attach it.
- The server's own time limit on a statement answers a typed `500` (`isDatabaseTimeout`) that the retry policy and the message mappers know: "Error
  boundaries, chunk reload and toasts".

### `revalidate.ts` — the revalidating view reads

Every `/api/` answer is `Cache-Control: no-store` (`security.md` "Caching"), so the browser never revalidates by itself. The ten view GETs that answer
through a server validator (`getPlanView`, `getHomeView`, `getTeamLoadView`, `getDependencyListView`, `getRoadmapView`, `getProgramsView`, `getProjectView`,
`getTeamView`, `getBaselineView`, `getJiraLinks`) therefore call `revalidatedRequest<T>(path)` instead of `jsonRequest`; the two deviation reads, the list
wrappers and every write keep the old helpers. The server side: `planning-model.md` "View validators".

The module keeps the last `ETag` and the exact response TEXT per address and sends `If-None-Match`; a `304` resolves a fresh `JSON.parse` of the kept text,
so a page that mutated its copy can never corrupt a later `304` (one parse of a 336 KB document takes about 0.8 ms in Node). The seven rules (binding):

1. A `304` is answered ONLY with the text that arrived with the tag that was sent, for the same session identity: never TanStack Query's data, never an
   optimistic state, so a failed write's rollback refetch gets the server's document back whatever the cache held. A `200` that does not parse drops the old entry.
2. Memory only: a module-level `Map`; nothing in `localStorage`, `sessionStorage`, IndexedDB or the Cache API.
3. Session boundary: `bindSessionQueryCache` calls `forgetRevalidated()` beside `queryClient.clear()`; each entry carries the `getSessionSnapshot().identity`
   it was read under (an entry of another identity is dropped, neither sent nor returned) and an answer is kept only if the identity is still the one the
   request went out with (a token rotation keeps the identity, so keeps the entries).
4. With no kept tag the request is exactly `authedFetch(path)` with no init; with one, the only difference is the header (the 401, silent refresh and retry
   path is `authedFetch`'s and carries it).
5. A `200` with an `ETag` replaces the entry, a `200` without one drops it, an error throws `ApiError` as `jsonRequest` does and leaves the entry alone.
6. A `304` whose kept text is gone while the SAME session identity is still current (evicted, forgotten, or replaced by a newer answer while the request
   was out) is answered by ONE plain re-read without the header: never a guess, never a loop (a second `304` there is an `ApiError`). If the identity
   CHANGED while the request was out (another login, a sign-out here or in another tab) NO request is made for the new identity (nothing is retried across
   identities) and the read rejects with a plain "session changed" error, never the previous identity's text; the boundary has already discarded the query.
7. Bounded: 16 documents and 8,000,000 characters (a single document over the bound is never kept), least recently used first out; reading an address makes
   it the most recent.

TanStack Query sees an ordinary resolved read: the fresh copy is structurally equal, so it keeps the previous `data` reference and re-renders nothing;
`dataUpdatedAt` moves and `isFetching` toggles as for any read. No `staleTime`, key or hook changed.

Tests: `test/http.ts` `jsonResponse(status, body, headers)` and `notModified(etag)`. Any test that keeps a tagged document calls `forgetRevalidated()` in
`afterEach` (the map is module-level and survives between the tests of one file; `setup.ts` resets modules per file).

### `session.ts`

Token, roles and user id are stored under the `astrolabe.auth.*` localStorage keys, written by `persistSession(LoginResponse)` on login/MFA and
conditionally by `persistRefreshedSession` on refresh; the render-time accessors are `isAdmin()`, `getUserId()` and the like. Components whose controls or
queries depend on ADMIN use `useAdmin()` from `auth.tsx`, which subscribes to role changes from silent refresh and other tabs. A random stored identity
distinguishes sign-ins, while credential snapshots guard refresh publication; renewing tokens preserves the logical session so staggered 401s can reuse the
new token.

### Session boundary

`components/SessionBoundary.tsx` + `utils/sessionQueryCache.ts` bind the root `QueryClient` to logical session identity changes and key the mounted app
subtree by that identity (the rule: `web/CLAUDE.md` "The typed API layer").

- A different sign-in, a definitive automatic sign-out, an explicit sign-out or a change from another tab synchronously cancels and removes caller-scoped
  query data and discards mounted form and mutation results before the next account renders; a token rotation within the same identity retains them.
- It sits at the boundary rather than clearing individual page keys, because user, team and account queries all contain caller-specific projections.
- The same boundary empties the kept view documents of `revalidate.ts` (`forgetRevalidated()`).

### Sign-out and the return destination

The rules (no saved return destination after an explicit sign-out, a protected link keeps its path, query and hash, how to test logout): `web/CLAUDE.md`
"The typed API layer". The mechanics:

- The signed-out notice is acknowledged only after the login page commits, so a suspended or retried render cannot discard it.
- The flag carries a reason (`SignedOutReason` in `auth.tsx`: `sessionEnded`, the default, or `passwordChanged`); `pendingSignedOut()` reads it,
  `consumeSignedOut()` clears it, and `pages/Login.tsx` picks the notice from it.
- **The self password change signs the device out explicitly** (`pages/ChangePassword.tsx`): the PUT bumps the account's credential revision, which ends
  every access and refresh token including this device's. After the success toast the page runs `clearSession()`, `flagSignedOut("passwordChanged")` and
  `navigate("/login", { replace: true })`; the notice reads "Your password was changed. Sign in with your new password."
- There is no `/logout` call (nothing is left to revoke, and the stale access token would only 401) and no broadcast, for the same reason as `UserMenu`'s sign-out.

### Password reset (confirm link)

`pages/ResetPassword.tsx` only REQUESTS a reset (a uniform 202: the server emails a single-use link and changes nothing). The link lands on
`pages/ConfirmPasswordReset.tsx` at `/reset-password/confirm#token=…`, which is NOT behind `RedirectIfAuthed` (a signed-in device may finish a reset).

- The token travels in the URL fragment, so it never reaches a server log or a Referer. The page reads it once into component state, strips the fragment and
  any query from the address bar and history (`navigate(…, { replace: true })`), keeps it in memory only (never storage) and sends it to nothing but
  `confirmPasswordReset` (a plain `fetch`, never `authedFetch`, so it can never refresh or retry a session).
- Loading the page consumes nothing; the form shows for any well-formed 43-character token and an unusable one is learned at submit (401: the token is
  dropped and "Request another reset link" shows; 429, 400 and network failures keep it for a retry).
- The new-password rule is `newPasswordValidation` (`utils/userForm.ts`), shared with `ChangePassword.tsx`.
- On success the page runs `clearSession()`, `queryClient.clear()` and `notifyAuthChange()` and shows the green notice (`Alert color="green"`): no `/logout`
  call (the reset bumped the credential revision, so nothing is left to revoke) and no return destination.

### `auth.ts`

Login + the MFA exchange, self-service password reset, and `logout()`: best-effort, local credentials are cleared immediately, before awaiting the revoke
POST for the captured token pair; a delayed completion never clears a later login, and the function never throws.

## Error boundaries, chunk reload and toasts

The rules are in `web/CLAUDE.md` "Error handling"; the wiring:

- **Boundaries** (`components/ErrorBoundary.tsx`): `RouteErrorBoundary` wraps the `<Outlet />` inside `AppShell.Main` (the header and nav survive; it is keyed by
  `location.pathname`, so navigating anywhere recovers). The plain `ErrorBoundary` in `main.tsx` is the last resort and only catches crashes of the shell itself.
  The one deliberate third mount is the telemetry panel's: `App.tsx` wraps the right-hand `AppShell.Aside` in its own `ErrorBoundary` with `fallback={<TelemetryPanelCrash onClose={closePanel} />}`, outside every route boundary.
  The panel's open flag (`astrolabe.viewSettings.telemetry.panelOpen`) survives a reload, so a render crash inside it would come back on every load with no way to switch it off; "Close panel" clears the flag (the account menu opens it again).
- **Chunk-load recovery**: `main.tsx` listens for `vite:preloadError` (a redeploy 404s the old hashed chunks) and reloads once a minute at most, keyed in
  sessionStorage by `astrolabe.chunkReloadedAt`.
- **Query retry policy**: the `QueryClient` in `main.tsx` uses `shouldRetryQuery` (`api/http.ts`); the rule is in `web/CLAUDE.md`. The database time-out is the
  `500` whose problem `type` is `urn:astrolabe:problem:database-timeout` (`DATABASE_TIMEOUT_PROBLEM`, `isDatabaseTimeout(err)` in `api/http.ts`).
  - The server cancelled a statement at its own limit (15 s by default, `persistence.md`), so it has just spent that whole limit on the request, and two more
    tries would be half a minute more spinner and two more statements on a database that is not answering. A stuck read therefore says so after about 15 s
    instead of about 93 (30 s a try, three tries).
  - A browser-side `TimeoutError` (the server sent nothing for 30 s) is still retried.
  - `loadErrorMessage` and `saveErrorMessage` answer `common.error.timeout` ("The request timed out. Try again.") for it before any status branch, so a page's
    own `500` wording never shows over it; a kept document stays on screen under the alert, as for any failed re-read.
  - The sentence never claims that nothing was saved: the cancelled transaction is rolled back, but an earlier committed step of the same request (a
    create's re-read) may stay, so a retry of a save can meet a `409`.
- **Messages**: `error.message` is the internal `API <status>` / the browser's "Failed to fetch". Statuses map to i18n keys through the shared mappers in
  `utils/saveError.ts`: `saveErrorMessage(err, t, keys)` for mutations (per-status keys + a `failed` fallback) and `loadErrorMessage(err, t)` for list loads.
  A failed QUERY renders through `components/ErrorAlert.tsx` (`error`, optional `title`), a form/action failure (an already-mapped string) through
  `components/FormErrorAlert.tsx`.
- **Toasts**: the `@mantine/notifications` host is mounted in `main.tsx` (top-center, autoClose 2500, limit 3), deliberately not in App, so unit tests never
  mount it; top-center because bottom-right would cover `PaginationBar` and form footers, and top-right the header cluster. `showSuccessToast(t("<area>.toast.*"))`
  in `utils/toast.tsx` is the only writer (green; the close X's accessible name, `common.action.closeNotification`, is set there too, at show time).

### The deploy check

The rule (a Reload notice, never an automatic reload): `web/CLAUDE.md` "Error handling".

- `api/build.ts` `getServedBuild()` fetches `index.html` (`cache: "no-store"`, `timeoutSignal()`, a plain `fetch` with no token: the shell is public) and
  returns the meta's content. It REJECTS on a non-200, a body without the meta (a JSON stub, an older shell), an empty content or a failed fetch: "could not
  tell" is never "equal".
- `hooks/useServedBuild.ts` is the one query `["build"]`: a read on mount, a focus refetch with no `staleTime`, every 5 minutes while visible, `retry: false`, and off when
  `__APP_COMMIT__` is `unknown` (a build without git). `outdated` = an answer arrived and differs from the bundle's commit (inequality, so a rollback prompts
  too); a failed re-check keeps the last answer, an equal one clears it.
- `components/UpdateBanner.tsx` is mounted at the top of `AppShell.Main` (outside the route boundary, so it survives navigation and a page crash) and at the
  top of `AuthCard`, above the card and as wide as it (the login and the two password-reset pages, so a tab left open there learns too; the shell and a
  public page are never on screen together). It is a gray `role="status"` line and a "Reload" button (`common.action.reload`, shared with the crash
  fallback), and nothing in the DOM otherwise.
- The three public pages' tests stub `__APP_COMMIT__` to `unknown` (the check off: under vitest it is the real commit and would fetch `index.html`).
- Limits: a rebuilt image of the SAME commit is not noticed; during a rolling deploy a tab may be prompted, reload onto the old build and be prompted again
  until the rollout ends.

## Shared list-page and dialog mechanics

The template and its rules (the chrome, the colour vocabulary, delete, the entity name as the way into its page, row actions): `web/CLAUDE.md` "Shared
list-page building blocks". The pieces behind them were copied from Lettuce (`pages/Users.tsx` is the reference page).

- `SortHeader` renders its own `Table.Th` so the sort state lands as `aria-sort` on the header cell; wrapping it in another `Th` would lose that.
- **Every paged list page calls `useClampPage`** (`hooks/usePagedSort.ts`) beside `usePagedSort`: when a SETTLED answer's `total` falls below the current page (a delete emptied the last page, a filter narrowed it elsewhere) it returns to the last real page; a failed or placeholder (`keepPreviousData`) answer never moves the user.
- `FilterPanel` is collapsed by default, remembers open or closed per view, and badges the number of active filters; `ClearableTextInput` debounces.
- **A filter select is complete, or says what it lacks.** The team options are ALL teams: `api/teams.ts` `listEveryTeam` reads pages of 100 by name until
  they reach `total` or a page is empty, at most 20 pages, and `hooks/useTeamOptions.ts` answers `{ teams, settled }` under the one key
  `["teams","options"]`, so every team write still refreshes it. The Jira import preview's per-row Team select reads the same hook (null, so no select,
  until it has settled).
- The project options are every project of the plan view (`utils/planNames.ts` `projectOptions`: two of one name carry their program, as the program pick
  does). An id from a link that a SETTLED list does not hold is one more option, "Team 12" / "Project 12"; while a read runs or failed the field is blank,
  because nothing is said about a team or project from data that has not arrived.
- `PlanFilterSelect` owns its plan read (a panel's fields mount only while it is open); `TeamSelect` / `ProjectSelect` stay the dialogs' search-as-you-type pickers.
- **Refresh after a mutation**: `refreshQueriesAfterMutation(queryClient, ["area"], ...)` (`utils/queryRefresh.ts`) cancels all affected query groups before
  invalidating them, because a newly keyed initial fetch has no cached data even when `keepPreviousData` displays rows, so default invalidation alone may
  reuse a pre-mutation response. Refresh stays out of failed mutation paths.
- **`ConfirmActionModal`** is the non-destructive sibling of `ConfirmDeleteModal` (Lettuce's, ported with the feature-flags bulk actions): a message plus a
  neutral cancel and a confirm button whose `loading` blocks cancel/close while the action runs; labels arrive already translated.

### Focus after a delete

`useDeleteConfirm` takes `focusAfterDelete` (required): the page's `PageHeader` `titleRef` (the title is `tabIndex={-1}`, never a tab stop; `index.css` draws
the accent ring on `:focus-visible`), a section's own h3 ref, or `null` where the delete navigates away (`useFocusMainOnNavigation` owns the focus; the hook
unmounts with the page, so they never fight).

- The kebab and the dialog's Delete button are both gone and the browser would leave the focus on `body`, so the hook tries the target at every render and when
  the modal has exited (`ConfirmDeleteModal` wires `onExitTransitionEnd`; the hook keeps looking for up to half a second while the leaving dialog still holds
  the focus), by one rule:
  - focus on `body`: take it;
  - focus inside a `[role="dialog"]` (still fading) or a `[role="menu"]` (Mantine's return focus puts it back on the menu item that opened the dialog, which
    stays mounted while its dropdown fades, about 150 ms, and then drops it to `body`): wait;
  - anywhere else: leave it.
- The predicate is `utils/focusTransit.ts` `isFocusInTransit`, shared with `useDialogFocus`. A failed delete never arms it (the modal stays open with its error).
- **A cancel** (Escape, Cancel, X, click outside) goes through the same rule. A dialog opened from a row menu has lost its opener (the unmounted menu item),
  so `requestDelete` takes the menu's trigger from the shared `utils/menuOpener.ts` memory (`RowActionsMenu` remembers the kebab on a click inside its menu;
  it expires at the end of the click); a focus left on `body` returns to that kebab if still connected, else to the same target, and a focus anywhere else is left alone.

### Row menus and dialog focus

- **`components/RowActionsMenu.tsx`**: an icon-only kebab named `common.table.operationsAria` ("Operations for {{name}}"); its items are plain `menuitem`s and
  only one row's menu is open at a time. A menu opens with the focus on its FIRST item (the theme drops Mantine's focus placeholder, which fails axe
  `aria-required-children`), so the next ArrowDown reaches the second; an item's tint shows for the pointer and for a keyboard focus only.
- **Tab leaves a menu**: Tab or Shift+Tab closes an open menu and moves on from its trigger (`hooks/useMenuTabExit.ts`; Mantine's trap would swallow the
  key). Menu items are `tabindex="-1"`, so the first Tab leaves, including the account menu's theme items. Every menu is items only, so the hook has no inner-Tab-stop
  branch; a menu that ever needs its own tabbable controls adds one.
- **A destructive item** (Delete, Sign out) is `components/DestructiveMenuItem.tsx`, never `Menu.Item color="red"` (red-6 is 3.3:1 on the white dropdown). An item's
  `aria-label` must contain its visible text ("Move to top: {{name}}", not "Move {{name}} to top": axe `label-content-name-mismatch`).
- **`hooks/useDialogFocus.ts`**: a dialog mounted with `opened` already true (`{editor && <XModal ... />}`) calls `useDialogFocus(open)` in its owner. Mantine
  records no opener for it, so without the hook the focus lands on `body`. A dialog that opens only after an await wraps the awaited promise in the returned
  `claim(...)` (Teams' Edit).
  - Focus returns to the opener when it closes (the kebab for a row-menu item, else the button that held the focus), and for 5 seconds after that a refetch
    cannot lose it: a focus blurred to `body` by a row moving in the DOM goes back to the opener, or to `#main-content` if the opener is gone, while a focus
    parked in a closing menu or dialog is in transit and does not end the watch.
  - A focus inside a `[role="dialog"]` that appeared AFTER the editor closed ends the watch, because another flow has taken over (the same row's Delete
    confirmation within seconds of an edit); a dialog already open at the close (ours fading, or one beneath it) stays exempt. The order in which an editor's
    `useDialogFocus` and the page's `useDeleteConfirm` are declared therefore does not matter.
  - While the dialog is closed the hook listens to `focusin` (a no-op while no opener is held) and ends the watch when the focus lands anywhere but the opener, a
    dialog or the opener's own menu (`isChoiceAwayFrom`), so another row's kebab, or an action that dropped the focus to `body` (its row removed or re-sorted),
    never gets answered with the first kebab.
  - `menuOpener.ts`'s `setTimeout(0)` expiry cannot beat the hook's effect: the click is a discrete event, and React commits it and flushes the passive effect
    before any timer.
- Pinned by the co-located `useDeleteConfirm.focus` and `useDialogFocus*` tests (the real `RowActionsMenu` + Mantine `Modal` harness) and the edit-then-delete cases of the project page, Teams and Dependencies. Those page cases render inside a `main#main-content`, as the shell does (without it the watch has nowhere to send the focus and the race does not show
  in vitest), and answer the DELETE after about 30 ms (Mantine's 10 ms return-focus timer would otherwise race a confirm click no person can make).

### Registries and forms

The rules: `web/CLAUDE.md` "Registries" and "Forms". The small ADMIN-curated registries (Teams and People) compose `useRegistryListControls` and
`RegistryListTable`; each page owns its query key and parameters, extra filters, columns, row actions and mutation refresh prefixes.

- The editors (`components/TeamEditorModal.tsx`; `PersonEditorModal.tsx` has no description, so it composes its own fields) share `RegistryMetadataFields`
  (name + description, with `utils/charCount.tsx`'s "123 / 4000" counter) and `RegistryEditorActions` (save-error alert + cancel/submit footer).
- The field limits mirror the server's own validation (`infra/validation/Text.kt`'s `requireNameAndDescription`); form rules (`utils/formRules.ts`'s shared
  `nameRule`/`descriptionRule`), submit/conflict handling and any parent/target fields stay local.

## Timeline mechanics (`components/Timeline*.tsx`)

The binding reference is `timeline.md` (coordinate model, data contract, arrows, load strip, drag/resize/keyboard contract, row drag, draw gesture,
accessibility model, virtualisation, holidays, idle bands, critical path, proposal preview, baseline overlay, Jira markers, measured figures). The rules a page
follows: `web/CLAUDE.md` "Per-feature rules". What the pages see of the component, with the `timeline.md` section that owns each mechanism:

- **Boundary.** `Timeline` takes rows, bars and bands as `TimelineRowData[]` (`utils/timelineModel.ts`); the page builds the `scale` (`makeScale(zoom, range)`,
  `defaultRange`) and keeps the range stable across edits. `editable` comes from the view's `can` flags, and a drop is only `onSchedule(id, start, end)` on the
  page's `TimelineDndContext`: the page's write path owns the optimistic update, the revision and the rollback.
  - Dates are ISO strings at the boundary; layout is `utils/timelineScale.ts` (28/8/3/1 px per day at week/month/quarter/year), drag arithmetic is
    `utils/timelineDrag.ts`, both pure and unit-tested.
  - It is a `role="grid"` with ONE roving tab stop (`useRovingGrid`; a left cell that holds its own focusable is a function cell that spreads the stop on it),
    rows virtualised with TanStack Virtual only above `virtualizeFrom` (80).
  - Keyboard: Space/Enter picks up a bar or edge handle, ←/→ a day, Shift a week, Space drops, Escape cancels, announced in the UI language
    (`timeline.announce.*`); the page ships the explicit buttons (Edit schedule…, the tray's Schedule).
  - Pointer drags are not unit-tested (happy-dom has no layout; `Timeline.test.tsx` feeds the wrapped `DndContext` its events); the e2e does them.
  - Reference: "Coordinate model", "Data contract", "Drag, resize and keyboard", "Accessibility model", "Virtualisation".
- **Zooms, the window tone, draw and `focusRow`.** `Timeline` takes `zooms` (default `MILESTONE_ZOOMS` = week/month/quarter, which the project and team pages
  keep; the plan pages pass `PLAN_ZOOMS` = month/quarter/year, Year = 1 px per day, year header over quarter cells) and validates a stored zoom against its own
  list (`isOneOf(MILESTONE_ZOOMS)`).
  - `tone: "window"` is the one tone an EDITABLE bar honours (a target window as a bar: the band look over the whole row height, handles and keyboard as any editable bar).
  - `TimelineRowData.draw = {barId, label}` mounts a pointer-only, `aria-hidden` `TimelineDrawSurface` behind the row's bars: a drag across the empty stretch is
    the fifth drag kind `draw`, previewed as a window-toned ghost and proposed through the SAME `onSchedule(barId, start, end)` as a bar move
    (`drawOutcome(anchorDay, pointerDay)`; the page's dialog is the keyboard/touch path).
  - `ref` exposes `focusRow(rowId)`: focus + reveal a row header, mounted or not; it answers `false` for a row the Timeline does not have.
  - Reference: "The draw gesture", "Bar tones", "Accessibility model".
- **Bands.** `TimelineBandData.tone` is `window` (quiet gray, dashed edges), `drift` (orange) or `idle` (a diagonal gray hatch, no edges; the project and
  team pages' idle gaps). Every band carries `data-band-tone`, is `aria-hidden`, and its facts live in the page's text. Reference: "Idle bands".
- **Tones and arrows.** A read-only bar may carry a `tone`:
  - `tone: "ghost"`: another project's endpoint, faint and dashed;
  - `"summary"`: the project's own span, hollow;
  - `"proposal"`: a PROPOSED span of the team page's schedule proposal, hollow with a dashed 2 px text-colour outline, no new hue;
  - `"baseline"`: the span a picked baseline froze, a 5 px SHADOW bar along the bottom of the row, pointer-transparent, no hue;
  - `"jira"`: the dates Jira holds, a 5 px dashed outline along the TOP of the row, pointer-transparent.
- Dependency arrows are `TimelineArrowData[]` (`from`/`to` `{row, bar, kind: START|END}`, `violated`, `label`) drawn by `components/TimelineArrows.tsx` through the
  `overlay={(geometry) => …}` slot: decorative (`aria-hidden`; the page's table is the accessible surface), gray, RED when `violated`, only for mounted rows
  and from committed dates. Tests read `data-arrow`/`data-violated`/`data-tone`, never colour.
  Reference: "Arrows", "The proposal preview", "The baseline overlay", "The Jira markers".
- **Row drag.** The one `TimelineDndContext` has a fourth drag kind, `kind: "row"` (no `@dnd-kit/sortable`: no row ever gets a transform; a `DragOverlay`
  card plus an insertion line show the slot, computed from the live pointer against the body-wide row zone, so it reaches unmounted rows). It is the
  timeline's variant of the Roadmap rule: a pointer-only, `aria-hidden` handle (one cell, one roving stop) plus the row menu as the keyboard path, announced
  by dnd-kit's region (`timeline.announce.*Row`). The page passes `onReorder(id, slot) → boolean`; absent, there is no reordering. Reference: "Row drag".
- **Public holidays.** `holidays?: {date, name}[]` is the dictionary, any range; every page passes `useHolidays()`. Reference: "Public holidays".
- **The load strip.** The optional `strip={{label, render: (scale) => …}}` prop adds a sticky THIRD header row (36 px, `aria-hidden`, a visible caption) under
  the date cells; `components/TimelineLoadStrip.tsx` draws the weekly load into it from a local `LoadWeek[]` (the server's week row; the page maps its view onto it). Reference: "The load strip".

### Wiring notes

The non-obvious wiring:

1. `Timeline` reads `useDndContext().active` to suspend its own arrow handling while a bar is held (dnd-kit's keyboard sensor listens on the document, AFTER
   React's handlers) and registers the track drop zone with `useDroppable`. Both work without a `DndContext` (read-only timelines need none).
2. `TimelineDndContext` passes its handlers as `DndContext` props; dnd-kit calls those BEFORE the monitor that feeds `accessibility.announcements`, so the
   handlers stash the latest outcome in refs and the announcements only read them.
3. A resize redraws from the context's preview (`PreviewContext`); a move is a CSS translate of the bar wrapper from `useDraggable` (the context's modifiers
   hold it to its row and snap it to days). The edge handles sit outside the bar with a constant width per zoom, so a resize never re-measures the dragged node.
4. `useDraggable` results are destructured in `TimelineBar` because the React-compiler lint (`react-hooks/refs`) flags field reads off an object that carries a ref.
5. The virtualiser's `useVirtualizer` carries the one justified `react-hooks/incompatible-library` disable.
6. The track drop zone's droppable `data` carries `visibleBounds()` (the scroller's live rectangle minus the sticky columns and header) and `zoneLeft()` (its
   element's live left edge). `outcomeOf` combines them with the pointer `TimelineDndContext` tracks itself during a tray drag, so a tray item released over
   the tray below or the left columns is not scheduled and a scrolled grid gives the right day (dnd-kit's `delta` is wrong for it, `timeline.md`).
7. A pending "focus the row once it mounts" wish is cleared by another key, a focus elsewhere or a manual scroll.
8. Tests stub the scroller size with `HTMLElement.prototype.clientWidth/clientHeight` (happy-dom lays nothing out; the virtualiser reads them), restore the
   original descriptors in a file-level `afterEach` and wait with `waitFor`, never a real sleep (the suite is `isolate: false`). The keyboard-sensor test
   fakes only `setTimeout` for dnd-kit's zero-delay listener attach.
9. **Arrows.** `TimelineArrows` renders a fragment (the `<defs>` with two `<marker>`s of FIXED ids, then one `<path>` per kept arrow) inside the Timeline's own
   `aria-hidden` svg. The marker colours are CSS classes (`timelineArrowHead*`), because a marker's content inherits from the marker's ancestors, not from the
   path that references it, and the theme tokens `--timeline-arrow`/`--timeline-violation` live on `.timelineGrid`, an ancestor of both. `geometry.rowIndexOf`
   (a lazily built id→index map) lets the arrow input name rows by `TimelineRowData.id`, so a re-sorted page never re-indexes its arrows. The route math
   (`utils/timelineArrows.ts`) is pure; the tests feed a hand-built geometry, and `Timeline.test.tsx` covers the plain and the virtual path (the unmounted end
   of an arrow is positioned from data).
10. **The header height** (`timeline.md` "The load strip"). NOT pinned (happy-dom has no layout and ignores CSS modules): `scrollPaddingStart` and the CSS uses (the team page's e2e or a manual pass).
11. **Public holidays** (`timeline.md`). The tests count `gradient(` occurrences on the body row's LAST `gridcell` (happy-dom keeps gradient strings in `style.backgroundImage`).

## Home

Files: `pages/Home.tsx`; `api/home.ts`; `hooks/useOpenDeviationCounts.ts`; `components/HomeMine.tsx` with `HomeProjectsTable.tsx`, `HomeTeamsTable.tsx`, `HomeNodesTable.tsx`
and `HomeFlagBadges.tsx`; `components/BadgeLink.tsx`.

### Route and data

The landing at `/` shows Plan, Roadmap and Deviations in a responsive grid, with each destination at the foot of its card.

- Each card has an h3 (the nav's own label, `appShell.nav.*`), the nav's icon, one dimmed sentence, whatever the card shows live and a real `RouterLink` `Anchor` ("Open the plan",
  "Open the roadmap", "Open the deviations": distinct from the sidebar's names, so a by-name locator never meets two links) to `planPath` / `roadmapPath` / `deviationsPath`.
  The links never depend on a read.
- The outline is `[[2,"Astrolabe"],[3,"Plan"],[3,"Roadmap"],[3,"Deviations"],[3,"Yours"]]`, plus an h4 per "Yours" table shown (a failed first read of `GET /views/home` leaves
  "Yours" out). The other pages stay in the nav only, and the tab title stays the brand alone (`usePageTitle` of the `home.title`).
- **Three reads.** (1) `GET /views/home` (`api/home.ts`, key `HOME_VIEW_KEY = ["plan","home"]`, `staleTime` `HOME_STALE_MS` = 60 s like the two deviation counts: coming back to Home
  or refocusing the tab inside the minute makes no request and shows the kept figures; the document, its disclosure rules and its measured figures: `planning-model.md` "The home view")
  feeds the Plan and Roadmap cards and, through its `me` block, "Yours". (2) and (3) the two open-deviation reads feed the Deviations card.

### Refresh after other pages' writes

Home writes nothing. The user's own write re-reads Home on its next visit because it marks the key stale.

- Every plan write refreshes `["plan"]` (the key's prefix).
- A write that moves a figure WITHOUT refreshing `["plan"]` names `HOME_VIEW_KEY` in its `refreshQueriesAfterMutation` call:
  - the ranking (`hooks/useRoadmapRanking.ts`: ranked, unranked, rank);
  - the Teams registry (`pages/Teams.tsx`: a team's name, manager, deletion);
  - the People pages (`People.tsx`, `PersonDetails.tsx`: the person line and what is owned) and the login-person link (`Users.tsx` "Create a person", `CreateUser.tsx`);
  - Jira connection settings, tests, Refresh now, run completion, mapping saves and refused acknowledgements that only refresh Jira keys.
- Flow link changes, capacity writes, acknowledgements, connection lifecycle and completed runs refresh `["plan"]` and `["roadmap"]`
  alongside the affected Flow keys. Those views carry derived capacity flags, and Home follows under `["plan"]`.
- A new write that moves a Home figure must do the same.
- What waits up to a minute: another person's change, a scheduled poll, and a run that ends after the user left the page that started it (Home's Jira and Flow sides follow
  within the minute). A cold landing still makes the three requests and computes the Jira side twice (BACKLOG).

### The plan's figures

Shown as the server derives them, never recomputed.

- Each is one `role="group"` (`aria-label` "The plan in figures" / "The roadmap in figures") passed as the card's `children`, so the sentence above and the link below keep their
  place. Before the read answers the group is in the DOM EMPTY with a minimum height (`PLAN_FIGURES_MIN_HEIGHT`, `ROADMAP_FIGURES_MIN_HEIGHT`; no skeleton, the app has none).
- Plan card, in a two-column figure grid, zero shown: work streams, programs, projects (`programs.facts.*`), milestones (`teams.view.milestones`),
  `home.plan.notScheduled` (a link when positive).
- Roadmap card: `roadmap.facts.ranked|unranked`, then badges only when positive - orange warnings, gray infos (`roadmap.facts.*`), red `home.roadmap.conflicts` and the two
  whole-plan capacity badges, orange, `home.roadmap.overloadedTeams|wipTeams` ("N teams with an overloaded week" / "over the WIP limit": the teams the team page flags) - and the Jira sentence.
  - "N violated dependencies": `plan.conflicts` counts every violated link once, a link inside one project included, so it is NOT worded or linked as a Roadmap figure (the Roadmap
    draws only the links between projects); it is a link to the Dependencies page narrowed to the violated ones.
- **A failed Home read** (first or a later re-read) is ONE `ErrorAlert` (`home.figures.loadFailed`) under the grid and above "Yours". A first failure leaves the groups empty and
  mounts no "Yours" section; a failed re-read keeps the figures and "Yours" with its rows on screen.

### Yours

`components/HomeMine.tsx` is a section under the cards, never a fourth card (an h3, `home.mine.*`). It reads `me` of the Home document, never the session's role: what the login's
linked person may manage through the owner chain (what they own and everything under a work stream or program they own; each program and project row names its owner and says
`direct`) and the teams it manages.

- States: while the first read is pending, the heading and the one `LoadingBlock`. `me: null` (no active person): the sentence `home.mine.noPerson`, and for an ADMIN
  (`useAdmin()`, UX only) the link "Open the People page" to `peoplePath`. A person with nothing: `home.mine.nothing`.
- Otherwise: one dimmed line naming the person, one dimmed sentence under it that says what is listed (`home.mine.scope`; `home.mine.scopeOwn` while the switch narrows the lists),
  the switch, then up to three tables, each under its h4, each a `Table` with an `aria-label` in a `ScrollRegion`, each only when it has a row, plus `home.mine.truncated` when the
  document says a list was cut (the cap, 100, is the spec's).
- **The switch "Only what I own myself"** (`home.mine.ownOnly`) sits above the tables, only while a project or program row exists; off by default and remembered in this browser
  (`useStoredState`, key `home.mine.ownOnly` under `astrolabe.viewSettings.`, every read and write try/catch-wrapped, a corrupt value reads as off).
  - On, it keeps the `direct` rows of the projects and programs tables on the client. A work stream is listed only when the person owns it, so it stays, and its roll-up figures
    (programs, projects, flags) still count the rows under it, the document's own; the teams are untouched.
  - A table it empties keeps its h4 and says `home.mine.ownOnlyNoProjects|NoPrograms` ("You do not own any of the listed projects yourself."), a claim about the LISTED rows only,
    because the document may have cut the list (`truncated`); the page never says "owns nothing" while the unfiltered list has rows.
- *Your projects* (`HomeProjectsTable`): the name (a link to `projectPath`, `plan.openProjectAria`), program, owner (`ownerName`: the person's own name on a `direct` row, the owner's
  on an inherited one), rank (or "Unranked"), milestones, not scheduled (a link when positive), the flag badges (`HomeFlagBadges`: orange warnings, gray infos, each only when
  positive) and the red conflicts badge (a link, see the table below).
- *Your teams* (`HomeTeamsTable`): the name (a link to `teamPath`, `teams.openAria`), milestones, not scheduled (a link when positive), the two orange capacity badges of the team
  page, conflicts (a link), the Jira chip's count badge (`DeviationCount`, a link to `deviationsForTeamPath`, only when positive, `stale={false}`) and the header's Flow sentence badge
  (`TeamFlags`, shared with `TeamPageHeader`: one badge serves both).
- *Your programs and work streams* (`HomeNodesTable`): work streams then programs by name, each a link to the filtered Roadmap (a closed work stream as `plan.move.closedName`;
  neither has a page of its own), level, the program's work stream, owner (a work stream's is the person, a program's its `ownerName`), programs, projects, flags; one "Open the
  programs" link follows.
- "May be out of date" is said once beside the person line: the Jira sentence by the plan pages' fold over the document's `jiraSites` and only when a row exists, the Flow sentence
  when a listed team carries a `FLOW_CAPACITY` flag and `flowStale` (the Deviations card's fold) holds.

### Where each figure leads

A figure that leads somewhere is itself the link: a real `RouterLink` (`components/BadgeLink.tsx`, a light `Badge` as a link, the `DeviationCount` idiom; a text line is an `Anchor`),
shown only when positive (zero is no claim and no link). What it says is still the document's own figure - a link changes where it leads, never what it says. Every URL comes from a
builder (`roadmapFilteredPath`, `unscheduledMilestonesPath`, `teamLoadWarningPath`); none is assembled by hand.

| Figure on Home | Leads to | Why the two agree |
|---|---|---|
| Plan: "N not scheduled yet" | `/milestones?scheduled=false` | the list's `total` and `plan.unscheduledMilestones` count one set |
| Roadmap: "N unranked" (a link when positive, text at zero) | `/roadmap?unranked=true` | `plan.unrankedProjects` and the Roadmap's "N unranked" count the same rows; a link is shown as written, so no remembered filter or pick narrows it; "N ranked" stays text (no "ranked only" filter) |
| Roadmap: "N warnings" / "N infos" (each opens its own severity) | `/roadmap?severity=WARNING` / `?severity=INFO` | every warning sits on a project that has one, so the facts line's warnings figure under the filter is Home's; the infos figure there counts the infos of those rows (fewer than Home's, as every filter narrows a count) |
| Roadmap: "N teams with an overloaded week" / "over the WIP limit" | `/team-load?warning=overloaded` / `wip` | the page's rows and Home's count fold the same `teamWeeks` |
| Roadmap: "N violated dependencies" | `/dependencies?status=violated` (`violatedDependenciesPath()`) | `totals.violated` of the dependencies view and `plan.conflicts` are one server function over one kernel's output |
| Yours, a project's / a team's red "N conflicts" | `/dependencies?status=violated&projectId=N` / `&teamId=N` | the violated links with an end in the project / a milestone end in the team: the subsets Home counts; the page's filter keeps the same rows |
| Yours, a project's / a team's "Not scheduled" | `/milestones?scheduled=false&projectId=N` / `&teamId=N` | the project's / team's subset of the same set |
| Yours, "Open the projects you own yourself on the roadmap" (under the projects table, only while a listed project is `direct`) | `/roadmap?ownerPersonId=<me.personId>` | the Roadmap's Owner filter; direct ownership on both sides (the table may list more: the projects under a work stream or program the person owns) |
| Yours, a work stream's / a program's name | `/roadmap?workStreamId=N` / `?programId=N` | the Work stream filter / the program pick with one program; a node with no project is plain text (its id is no filter option on the Roadmap, so the link would open it unfiltered) |
| Yours, a project's and a team's name; a team's Jira badge | their pages; the Deviations page | the existing links, not figure-links |
| Plan card's counts, ranked, the capacity badges in "Yours", the Deviations card | no figure-link | the card's own link / the team's name leads there |

**Naming rule.** A figure-link's accessible name contains its visible text.

- Where several rows show the same number each link names its row: `home.mine.notScheduledAria` "{{count}} not scheduled: {{name}}"; a node's name `home.mine.nodeOnRoadmapAria`
  "Open {{name}} on the roadmap" with a closed work stream's visible "(closed)" name inside it; a "Yours" conflicts badge `home.mine.conflictsAria` "{{figure}}: {{name}}", the
  figure being `project.conflicts`' own words.
- The Roadmap card's two flag badges each name their own destination (`home.roadmap.warningsAria` "{{figure}}: the projects with a warning on the roadmap", `home.roadmap.infosAria`
  likewise; the unranked line is named by its own text); the violated badge is unique and needs no extra name.
- None contains the e2e's exact names ("Open the plan", "Open the roadmap", "Open the programs", "Open <project>", "Open team <name>").

### The Deviations card

- **"May be out of date" follows the page each figure links to.** The Roadmap card shows `JiraStaleNote` while `jiraSites.some(isStaleSource)` (the plan pages' fold: plan-wide, a
  DISABLED site counts, `mappingOk: false` counts).
- **The figures are the OPEN deviation counts** (`hooks/useOpenDeviationCounts.ts`): `GET /views/deviations?acknowledged=true` and `GET /views/capacity-deviations?acknowledged=true`,
  keyed `["jira","deviations","totals"]` and `["flow","deviations","totals"]` (under the prefixes the existing refresh helpers invalidate), `staleTime` 60 s. No new endpoint, no plan or
  roadmap read.
  - Why `acknowledged=true`: both views compute `totals` over "every filter but the acknowledgement state" and count the OPEN rows, so the same totals arrive while the body lists only
    the acknowledged items (typically a few KB against up to 700 KB for the default list of up to 2,000 items). The cost grows with the acknowledgements, so a plan with nearly
    everything acknowledged pays close to the full list, bounded by `staleTime` 60 s.
  - Cost: with `acknowledged=true` the deviations read is under 1 KB on a sample plan against about 2 KB for the default list (capacity views: about 137 B either way); a heavily bound plan costs more (the Jira computation is about 50 ms for 1,100 bindings, `timeline.md` "Measured figures").
- Per source, ONE line (label "Open differences from Jira:" / "Open capacity differences from Flow:" and the orange warnings / gray infos badges of the Deviations page; a zero badge is
  omitted), shown only for a source whose view lists a connection AND whose count is positive. **No claim at zero** (no "nothing open", `web/CLAUDE.md` "Deviations wording"): zero, no
  connection and loading all show nothing. The one exception is neutral and separate (1.26.0): `flowPending` (the Flow view's `totals.pending`, which counts under `acknowledged=true` too) shows one
  dimmed line "N teams waiting for a complete Flow refresh" (`deviations.flowSection.totals.pending`, plural keys) under the Flow line, with or without any difference.
- A failed read is the inline `ErrorAlert` (title `home.deviations.loadFailed`) inside the Deviations card; the other source's line still shows and the links never depend on either read.
- `useOpenDeviationCounts` also answers `jiraStale` (`hasStaleSource` of the Jira document's connections: the Deviations banner's fold, an ENABLED connection only) and `flowStale`
  (`hasStaleFlowSource`). A source's sentence (`JiraStaleNote`, "Jira data may be out of date"; Flow's own `home.deviations.flowStale`) sits under its line and only while the line
  itself shows (no figure, no qualifier).

### Tests

- `Home.test.tsx` is built on the honest builders (`connectionIn(shape)` / `view()` of `test/deviations.ts`, `CAPACITY_CONNECTION` / `capacityView()` of `test/flow.ts`, `homeView()` /
  `homeMe()` / `emptyHomeView()` of `test/home.ts`); the figure-links' hrefs and names are pinned in it and in `HomeMine.test.tsx`.
- `App.test.tsx` renders `/` about twenty times, so its blanket fetch stubs answer the three Home URLs with their own empty documents (`homeViews`): a paged envelope is not one of them.
  `headingOutline.test.tsx`'s `emptyApi` answers them with a 404 and the outline holds with the alert shown.

## Plan

Files: `pages/Plan.tsx` (composition only), `components/PlanTree.tsx`, `PlanTreeRow.tsx`, `PlanRowMenu.tsx`, `PlanToolbar.tsx`, `PlanDialogs.tsx`, `PlanDndContext.tsx`; `hooks/usePlanDialogs.ts`, `usePlanFolds.ts`, `usePlanJiraImport.ts`, `usePlanOrder.ts`; `utils/planTree.ts` (pure rows and folds), `planOrder.ts` (the order, `plan-tree.md`), `planActions.ts` (the row-to-page callback contract), `planMove.ts`, `planForm.ts`; the editors `WorkStreamEditorModal.tsx`, `ProgramEditorModal.tsx`, `ProjectEditorModal.tsx` over
`PlanNodeFields.tsx`; `PlanMoveModal.tsx`; `PlanDateInput.tsx`, `AppDatesProvider.tsx`; `api/plan.ts`.

### Route and data

`/plan` (nav section Planning, everyone) renders `GET /views/plan` (V12) under `["plan", "view"]` as ONE tree table, in the server's order ("The Plan page's tree" in `plan-tree.md`: rows, folds, the row menu). A read for everyone whose actions are gated by the view's `can:{}` flags, which the server computes with the guards' own arithmetic.

- `usePlanDialogs` owns the open editor (`EditorState`: work stream / program under its stream / project under its program), the move dialog, the Jira imports, one `useDeleteConfirm` for all three delete
  levels (`DELETE_TEXT`; a 409 says "delete the children first") and the close/reopen mutation; `PlanDialogs` draws them. Every success refreshes `["plan"]` through `refreshQueriesAfterMutation`.
- The server's 403/409/400 reach the modals through `planSaveErrorMessage`/`saveErrorMessage` (a name clash marks the name field, everything else is an inline alert).
- The three editors share `PlanNodeFields` (name, description, owner via `PersonSelect` - required on every node).
- **Import from Jira…** (all in `hooks/usePlanJiraImport.ts`; "The import modal" under the Jira sections): a stream's menu (`can.edit`; the connections are read from the deviations
  view only after the click), a LINKED program's menu (`can.createProject`) rooted at it, and a LINKED project's row menu (`can.createMilestone`) rooted at the project.

### Close and reopen

A one-step menu action on a stream: the full-replace `PUT /work-streams/{id}` of the row as it stands with only `endDate` changed (today, never before the start / `null`). A closed
stream (end date set) still shows "New program" and still takes children. The stream editor's End date field does the same with a typed date, and clearing it reopens.

### The project editor

Two independently permitted parts, because the server guards them differently: the fields (`PUT /projects/{id}`, `can.edit`) and the target window
(`PUT /projects/{id}/target-window`, `can.editTargetWindow` - a project's OWN owner is deliberately not enough; a roadmap editor has the window but not the fields).

- A disabled part still shows its current values with a note.
- Save sends only enabled parts that changed. An edit to both parts uses `PUT /projects/{id}/details`, so both commit together.
  A window-only edit uses its own PUT. Nothing changed closes the modal without a request, and a pending save keeps it open.
- A NEW project carries its window in the create body (the creator is always a window editor).
- The window is both dates or neither (validated in `utils/planForm.ts`, the server's 400 is the backstop).

### Move to…

`components/PlanMoveModal.tsx`; `moveProject`/`moveProgram` in `api/plan.ts`: `POST /projects/{id}/move` `{programId}` / `POST /programs/{id}/move` `{workStreamId}` answer 204. The pure
arithmetic is `utils/planMove.ts`: `projectMoveTargets` groups the eligible programs by work stream, `programMoveTargets` lists the eligible streams, `hasTarget` reads either shape,
`findProject`/`findProgram` look a node up in the current view, `canMoveProject`/`canMoveProgram` are the row-level "offer it?" tests.

- **Targets.** For a project, the programs whose `can.createProject` is set minus its current program, grouped by work stream; for a program, the work streams whose
  `can.createProgram` is set minus its current stream. A closed stream stays a valid target and is labelled "(closed)"; the picker is a searchable `Select` (the theme's folded filter).
  Eligibility is only the target half of the server's rule; the source half is the node's `can.move`, and the server re-checks both.
- **The offer.** A row offers the action only when its own `can.move` is set AND some target is eligible (`Plan.tsx`'s `actions.canMoveProject|Program` hold both tests); with no target it is
  hidden, not disabled, and a row whose only action it was loses its kebab.
- **State.** The page holds a `MoveState` of just `{kind, id}`; on every render it looks the node up in the CURRENT view and derives the dialog's name, its parent now ("currently in …"),
  the targets (excluding that parent) and `forbidden = !can.move`. So a reload under the open dialog (a 400/403's `onRefresh`, or any other `["plan"]` refetch) reshapes the options, a
  pick that is no longer offered is dropped (`picked = hasTarget(data, value) ? value : null`), a node that lost `can.move` shows the 403 message with Move disabled, and a node that left
  the plan closes the dialog (state reset during render, as on a 404). If the last target vanishes under an open dialog it says so and disables Move.
- **Outcomes** besides 204 are inline in the dialog, never toasts: 409 on a PROJECT (name taken in the target program) stays open to pick another; 400 and 403 say so, then `onRefresh`
  reloads the plan, and `submitting` is cleared only AFTER that reload (Move cannot be pressed on the old plan); 404 closes via `onDone` (close + refresh); anything else, including a 409
  on a program, is "The move failed (status)".
- **Success:** the toast `plan.toast.projectMoved|programMoved`, then `["plan"]` AND `["roadmap"]` refresh (a mounted project view is under `["plan"]`).

### Dates

- `PlanDateInput` (`components/PlanDateInput.tsx`) wraps Mantine's `DateInput` (string `value`/`onChange`, `valueFormat="YYYY-MM-DD"`, placeholder `common.dateFormatHint`, a clear
  button named "Clear {label}").
- `AppDatesProvider` (`components/AppDatesProvider.tsx`, mounted in `main.tsx` around the router) passes the UI language and `firstDayOfWeek: 1` to `DatesProvider` and owns the
  `dayjs/locale/<lang>` imports (dayjs only knows `en` until the locale file is imported; a new shipped language needs its line there). `@mantine/dates/styles.layer.css` is imported in
  `main.tsx` next to the core layer.
- Tests need no provider (the default locale is English). Unit tests type the ISO text into the input; the calendar popup is covered by `AppDatesProvider.test.tsx` (month and weekday
  names per language). Rules and wire mappers: `utils/planForm.ts`.

### Tests

The co-located `Plan*.test.tsx` (`Plan.rows`, `Plan.tree`, `Plan.order`), `AppDatesProvider.test.tsx` and the `planTree`/`planMove`/`planForm` `utils/` tests.

## Project view

Files:

- Page and data: `pages/ProjectView.tsx`; `api/milestones.ts` (`getProjectView`, `createMilestone`, `updateMilestone`, `deleteMilestone`, `scheduleMilestone`); `hooks/useMilestoneSchedule.ts`
  (the query under `["plan","project",id]` and the ONE schedule write path, a thin wrapper of the generic `hooks/useScheduleWritePath.ts`, which the team page runs too);
  `utils/projectViewUpdate.ts` (`applySchedule`); `utils/milestoneForm.ts`; `utils/seenRange.ts` (`growSeenRange`); `utils/projectEditor.ts` (the `Editor` union, `isJiraEditor`,
  `needsJiraConnections`).
- Timeline: `components/ProjectTimeline.tsx` (the view → `TimelineRowData[]` adapter; it composes `ProjectTimelineRows.tsx`'s row and band builders and `MilestoneMenu.tsx`'s row menu;
  `ProjectTray` for the Unscheduled tray).
- Page parts: `components/ProjectPageHeader.tsx`, `ProjectViewNotices.tsx`, `ProjectEditors.tsx`, `TimelineTitle.tsx`, `UnscheduledTraySection.tsx` (the last two shared with the team page); the dialogs `MilestoneEditorModal.tsx`,
  `MilestoneScheduleModal.tsx`; `TeamSelect.tsx` (a `SearchPicker` over `GET /teams`).
- Dependencies: `api/dependencies.ts` (`createDependency(projectId, body)`, `updateDependency(id, {type, lagDays})` - the in-place edit, 204 -, `deleteDependency(id)`, `isDependencyCycle(err)`
  - the `isStaleRevision` shape -, the types), `api/plan.ts` `listProjects` / `api/milestones.ts` `listMilestones` (the pickers' paged searches), `api/http.ts` `ApiError.cycle` (a typed
  getter beside `detail`/`type`; malformed entries dropped), `utils/projectDependencies.ts` (pure: `ghostEndpoints`, `summaryRowNeeded`, `arrowSpecs`, `conflictCount`,
  `conflictsByBar`, `linksOfMilestone`), `utils/dependencyForm.ts`, `components/ProjectDependencies.tsx`, `DependencyEditorModal.tsx`, `DependencyDeleteModal.tsx`, `DependencyFormParts.tsx`, `MilestoneSelect.tsx` (`projectId`, `clearLabel`),
  `ProjectSelect.tsx`; the summary and ghost rows are in `ProjectTimelineRows.tsx`, the overlay in `ProjectTimeline.tsx`, the "Add dependency…" item in `MilestoneMenu.tsx`.
  - `dependencyForm.ts`: the form values, the self-link and lag rules, `toDependencyBody`, `cyclePathText`, `dependencySaveErrorMessage`; the edit's `editDependencyForm`,
    `dependencyEditValidation` (the lag only), `toDependencyUpdateBody`, `dependencyUpdateErrorMessage`, and the shared `dependencyEndpointText` (`ownProjectId` `null` = no own project, so every
    milestone end names its project). `EditableDependency` is what the editor and the delete read of a link.
  - `DependencyDeleteModal.tsx`: the delete confirmation's wording and error mapping, shared with the Dependencies page.

### Route and data

`/projects/:id` (the Projects leaf; the Plan page's project NAME links it, `plan.openProjectAria`; `projectPath(id)` in `utils/planLinks.ts`; the picker and the bare `/projects`: `projects-view.md`) renders
`GET /views/project/{id}` under `["plan","project",id]` - under the `["plan"]` prefix, so every Plan mutation also refreshes a mounted project view. `ProjectView` is
`<ProjectPage key={id}>`, so another project starts with its own range and editors.

- **Header facts:** the target window, the derived span and the drift in words ("Ends 7 days after the target", one `Badge` per non-zero figure: ORANGE when the project runs later
  than its target, gray when ahead, nothing red).
- **Everything is gated by the view's `can:{…}` flags, never the session's roles.**
  - The owner chain's `can.edit`/`can.delete`/`createMilestone` give the plan-field editors (`MilestoneEditorModal`: name, description, `TeamSelect`, an estimate `NumberInput` step
    0.25, **no dates for anyone** - a new milestone is always unscheduled).
  - ONLY a milestone's `can.schedule` (its team's manager or an ADMIN) makes its bar editable and shows its Schedule button, drag handle and schedule menu items; the project's own
    owner reads read-only bars (`role="img"`, no handles).
- **Import from Jira…:** a header button (`ProjectJiraImportButton`, `components/JiraChips.tsx`, beside Link/Unlink) shown with the project's `can.createMilestone` AND only while the
  view says the project is linked (`marks`, not a request).
  - `Editor` has `{kind: "jiraImport"}`; `needsJiraConnections(editor)` enables `useJiraLinks` for it as for the bind dialog, so the connections are asked only after the click.
  - `ProjectEditors` mounts `JiraImportModal` rooted at the project: `ImportRoot` is built by the shared `rootOf("PROJECT", project, project.jira)` of `utils/jiraImportRoot.ts` (which
    the Plan page's program and project entries use too: `workStreamId`, `ownerPersonId/ownerName`; level PROJECT, so no owner field: the project's owner is sent) through
    `importSourceOf(links)` (`utils/jiraImport.ts`, shared with the Plan page). An apply refreshes `["plan"]` (this view included).
- Deleting the project states the milestone count (it cascades). Rules mirror the server in `utils/milestoneForm.ts`; a 409 on save marks the name field.

### Page composition

`ProjectPage` composes child components, split for the complexity backstop (`complexity: 35`, `eslint.config.js`):

- `ProjectPageHeader` (name, meta lines, the `can`-gated actions), `ProjectViewNotices` (notes, inline write failures, the polite status region), `ProjectEditors` (the dialogs for the
  open `editor`), `TimelineTitle` and `UnscheduledTraySection` (shared with the team page).
- The team page has the same shape: `TeamPageHeader.tsx`, `TeamViewNotices.tsx`, `TeamResetConfirm.tsx` and `TeamFlowSection.tsx` (`components/`).
- A split moves markup, never ARIA, focus or queries.

### Write path (dates)

`hooks/useMilestoneSchedule.ts` (the `useRoadmapRanking` shape): a drag, a resize, the tray's Schedule, "Edit schedule…" (`MilestoneScheduleModal`) and Unschedule all
`commit(id, start, end)`.

- `commit` cancels in-flight `["plan"]` fetches (the whole prefix, not only this view), writes `applySchedule(view, id, start, end)` synchronously - the milestone moves between
  `scheduled` and `unscheduled` and both keep the server's order, `span`/`drift` stay the server's - then `mutate`s with the pre-change view as the rollback.
- The PUT carries the view's `revision` as `expectedRevision`. The server compares it with THAT milestone's last schedule write only (unrelated plan writes never stale a drag), so
  `onSuccess` stores the answered revision and refreshes `["plan"]` without awaiting it (the refetch also brings the new `span`/`drift`), and `onError` restores and AWAITS the refresh.
- `stale` is `isStaleRevision(save.error)` (a 409 of the stale-revision problem type) and shows `project.stale` (THIS milestone moved). A 403/400/other failure is an inline alert, never
  a toast. The 400 of the schedule PUT has several causes (order, shape, no working day), so its one sentence names the working-day rule instead of sniffing the server's text.
- A change aimed at a milestone that has left the view (deleted, refetched away) is refused the same way with `project.milestoneGone` and closes the schedule dialog.
- **The status region is the one announcer** of these notices (`web/CLAUDE.md` "Per-feature rules"): the visible notices are `role="note"`, and the dialog's own refusal Alert stays a live alert
  (`ownRefusalAlert`) because a modal's content is all a screen reader reads. The polite region announces the button/dialog paths (`project.announce.*`); a drag is announced by dnd-kit's own region.
- **A change is never lost silently:** while a save is in flight `commit` answers `false` and sets `refused` (cleared when that save settles). The page shows an orange "a save is still
  running - try again" notice (also inside the schedule dialog, which stays open) and announces it (each announcement flips an invisible zero-width suffix, so the same sentence twice is re-read);
  a "Saving…" indicator sits by the Timeline heading; `TimelineDndContext` corrects dnd-kit's drop announcement (`onSchedule` returns a boolean).
- **The schedule dialog saves with the revision of the view it was OPENED on** (`Scheduling = {milestone, revision}`), so another manager's move of that milestone meanwhile is the
  stale 409, not an overwrite; unrelated writes never stale it (the check is per milestone).
- The tray's Schedule places the milestone for one calendar week from the later of today (`localIsoDate`) and the project's target start (`dropOutcome("tray", …)`).
- The schedule dialog pre-checks "at least one working day": Monday-Friday and not a public holiday of the cached dictionary (`hasWorkingDay(start, end, holidayDays)`); the server's 400 is the rule.
- The zoom is `useStoredState("timeline.zoom")`, shared with the team page.

### Range, bands and rows

- **Range.** The page keeps `seen = {min, max}` (ISO strings) in state, grows it during render whenever the view holds an earlier/later date (scheduled dates, the target window), and
  builds `makeScale(zoom, defaultRange([min, max], today, zoom))` from it.
  - `today` is `localIsoDate()` (`utils/isoDate.ts`): the VIEWER'S local calendar day, not UTC - the today line and the Schedule button agree with their wall calendar. It is the one place the UI
    reads the browser's zone; the server's dates stay plain ISO dates, and the Plan page's close-a-stream date still uses UTC `todayIsoDate()`.
  - The range NEVER shrinks: after the last far-off link (a ghost row's dates) is deleted it stays wide until reload. A drag cannot go further than the padded range (the track clips); typed dates
    in the schedule dialog can, and the range then grows.
- **Bands.** The target window is a `window` band across every row; when the span ends after the target a `drift` band covers the overrun (`addDays(targetEnd, 1)` … `span.end`).
- **Rows** are fixed 36 px, so the name cell is one line: the name and the description as dimmed text after it, clipped by the cell. A row's kebab is a roving stop of the grid (`RowActionsMenu`'s
  `trigger` prop spreads the stop on the button). The timeline body is at least three rows tall (`MIN_BODY_ROWS`) so an empty timeline still has an area to drop a tray row on.

### Dependencies

The view's `dependencies[]` is read, never recomputed: the SERVER's `check` (OK / VIOLATED + shortfall + required/actual dates / UNSCHEDULED) is shown as is.

- **The section** (`components/ProjectDependencies.tsx`, h3) is the accessible surface: one table row per link in the server's order, violated first (so the top IS the conflict list).
  - A red `Badge` "Violated · N working days short" (gray "OK" / "Not scheduled yet" - never colour alone), predecessor, type ("Finish → Start (FS)"), lag (a negative one reads "(lead)"),
    successor, "needs X · is Y".
  - An "Edit…" in the row menu only with the link's own `can.edit` and a Delete only with its own `can.delete` (both the SUCCESSOR's project chain, or ADMIN; the predecessor's owner
    sees the link and the arrow but can neither change nor remove it; the kebab shows when either is set; Delete through `useDeleteConfirm`).
- **In the rest of the page:**
  - The facts line gains a red "N conflicts" badge; a violated bar's accessible name gains ", N conflicts" (an editable bar's name ends with it; a read-only bar reads "…, N conflicts,
    read-only").
  - The timeline gets a **ghost row** per distinct external endpoint with dates (dimmed; its name a `RouterLink` to that project whose accessible name keeps the visible text -
    `project.ghostLinkAria` "A › a1 - open project A", axe's label-content-name-mismatch), a **summary row** only while the project itself is an endpoint, and gray/red arrows
    (`utils/projectDependencies.ts` maps view → `TimelineArrowData[]`; an own end with no row is simply not drawn).
- **Add dependency** (button beside the heading, and "Add dependency…" in a milestone's row menu, both gated by `project.can.createDependency`) opens `DependencyEditorModal`:
  - The SUCCESSOR is fixed to this project or one of its milestones (the constrained side).
  - The predecessor is a Milestone/Project `SegmentedControl` over `MilestoneSelect`/`ProjectSelect` (`SearchPicker`s over the paged `GET /milestones` / `GET /projects`, options
    "name · project" / "name · program · work stream").
  - Type, and a lag in working days (−365..365; negative = lead).
  - It saves with `createDependency`. A cycle 409 (`isDependencyCycle`) renders the localized sentence plus the path ("A → B → A", from `err.cycle`, never the server's text); every other
    failure goes through `dependencySaveErrorMessage` (the fixed vocabulary - a 409 here is the duplicate pair, "already linked").
- **Edit** (the page's `editDependency` variant: the row menu's "Edit…", `ProjectDependencies`' `onEdit`) opens the SAME modal with `target` set: the ends as read-only `TextInput`s,
  `TypeAndLagFields` shared with the create, `updateDependency` on Save (`PUT /dependencies/{id}` `{type, lagDays}`, 204), success toast `project.toast.dependencySaved`.
  - Only Type and Lag are editable (changing an end stays delete + add).
  - A type that would close a cycle is the same 409 drawn from `ApiError.cycle` under "With this type the link would close a cycle through:" (`project.dependency.cycleEdit`); a 400 reads
    as the lag sentence, 403/404 as the create's.
  - A held `ProjectDependency` snapshot is fine: a vanished link answers 404 ("This no longer exists").
- Create, edit and delete are plain mutations (no optimistic step, no revision).

### Dependency rows, ids and refresh

- **Row and bar ids.** Own milestones keep their numeric ids; the synthetic rows are strings that cannot collide: `project:<id>` (the summary row), `ghost:m:<id>` / `ghost:p:<id>` (one
  per DISTINCT external endpoint WITH dates); a synthetic row's bar id equals its row id. An arrow end resolves to: the own project → the summary row, an own milestone → its row (a tray
  milestone has none), anything else → its ghost row. The skipped arrows and the range: `timeline.md` "The project page".
- **Placement.** The section sits AFTER the Unscheduled tray (and after the "No milestones yet" empty state), not between the timeline and the tray: the tray's pointer drop needs the tray close to
  the timeline and in view with it (the e2e tray drop asserts both are inside the viewport).
- **The page owns the dialog**: `Editor` has a `{kind: "dependency", successor}` variant, so the section's button (successor null → "This project") and a milestone's row-menu item open the same
  `DependencyEditorModal`; the section owns only its Delete confirmation (the shared `DependencyDeleteModal`).
- **Refresh.** Create/edit/delete: `refreshQueriesAfterMutation(["plan"])` (+ `["roadmap"]` through the page's `saved`), which brings the server's new checks. The schedule write path already
  refreshes `["plan"]` after a PUT; the optimistic `applySchedule` moves the bar but never touches `dependencies[].check`, so for a moment after a drop the table/arrow show the previous check.
  Pinned by `ProjectView.test.tsx` ("a schedule write refetches the view…").
- **Picker query keys** are `["plan", "milestones", "picker", term]` and `["plan", "projects", "picker", term]` (under `["plan"]`: a Plan mutation refreshes an open picker's list).
- **Delete bodies** state the cascade: `project.dependency.deleteWith` ("Its N dependencies will be deleted too.") is appended to the milestone's and the project's confirm text when the view holds
  any link on them (`linksOfMilestone`; the project's count is `dependencies.length`).

### Idle gaps

The view's `idleGaps[]` is the SERVER's list, read and never recomputed; the band, its look and order, the accessible surface and the optimistic rule are `timeline.md` "Idle bands".

- `bandsOf` appends `idleBands(view.idleGaps, t)` (`utils/idleGaps.ts`) after the window and drift bands, also when the project has no target window.
- `<IdleGaps gaps scope="project" />` (`components/IdleGaps.tsx`, h3) follows `{dependencies}` (h3 order: Timeline, Unscheduled, Dependencies, Idle gaps); the facts line gains a gray
  `timeline.idle.badge` "N idle gaps", absent at zero.
- `applySchedule` spreads the view, so the cached gaps survive the optimistic step unchanged (same array identity, `projectViewUpdate.test.ts`) and the refetch replaces them
  (`ProjectView.test.tsx`: the old band is still drawn synchronously after a drop, then the server's new gap). Strings: `timeline.idle.*`.

### The critical path

The server's critical path (`milestone.slackDays`/`critical`, `dependency.critical`, `criticalPath{upstream, upstreamTruncated}`) is read and never recomputed; what is drawn, the Slack
column, the ghost-row lookup (by kind + id, never by `hops`) and the Critical chain section are `timeline.md` "The critical-path highlight".

- `ProjectPage` holds `useCriticalPathPick()` (the one `timeline.criticalPath` key, shared with the team page; called before the early return: hooks stay unconditional) and passes
  `criticalPath` and `<CriticalPathToggle>` (as `toolbar`) to `ProjectTimeline`, `showCritical` to `ProjectDependencies`.
- `ProjectTimeline` (rows in `ProjectTimelineRows.tsx`, cell in `SlackCell.tsx`) adds the `slack` column; `withOptional` inserts the cell before the actions cell, so a bar's roving
  columns shift by one. `emphasized(t, critical, describe)` applies the outline to the bar fields, `arrowSpecs(view, criticalPath)` flags the arrows, and the ghost rows' slack and
  emphasis come from `upstreamIndex(view)` by kind + id.
- Strings: `project.critical.*`, `project.column.slack`, `timeline.criticalToggle`, `timeline.bar.critical`.

### The pin

A scheduled milestone's row menu offers "Pin dates" / "Unpin dates" (`common.action.pin*`, `IconPin`/`IconPinnedOff`) by the ROW's `can.schedule` (the team's manager or an ADMIN; the
project's owner sees the glyph and no item) and never on a tray row: `MilestoneActions.pin` → `schedule.pin(id, pinned)` of the page's write path (the team page's section has the
mechanics).

- A pinned row carries `PinMark` after its name (`IconPin` `aria-hidden` + a `VisuallyHidden` "pinned", `timeline.pinned`).
- Its bar's accessible name gains ", pinned" right after the base sentence (`withPinned`, `utils/pinText.ts`, before ", N conflicts" and ", on the critical path").

### The baseline overlay

With a baseline picked (the toolbar's picker, beside the Critical path toggle; `useMilestoneSchedule(id, pick)`) the page draws the shadow bars, the dimmed "(new since the baseline)",
"(removed)" and "(unscheduled since the baseline)" rows and the facts-line badges for the project's own span; the rules are `timeline.md` "The baseline overlay".

- The **Movement section** (`components/BaselineMovement.tsx`, h3, after Idle gaps) is the accessible surface: totals badges, then a disclosure over a table of every milestone against
  the baseline ("Changed only" on by default, an estimate-only change counts as changed).
- The optimistic step keeps the cached `baseline` block.
- **Dependencies (1.26):** a link with `newSinceBaseline: true` carries a gray "New since the baseline" Badge beside its status badge (`ProjectDependencies.tsx`); `false` and absent (no baseline, links not captured) show nothing.

### The Jira markers

All from the view, no request of their own; the bars, the Jira window, `jiraPageRange` and the appended tray rows are `timeline.md` "The Jira markers" ("Appended rows for the tray").

- The chip in the facts line (the project's `jira` and `flags`, the milestones' count and open-flag total - "The chips and marks" under "Deviations, bindings and the Jira chips").
- A **Flags** column (while a scheduled milestone is linked; before Slack) holding each linked row's Jira key link and flag icon; the tray rows' key, icon and "Jira: start to end".
- The toolbar's "Jira dates" toggle (after Critical path; only when `jiraSites` is non-empty; the shared `timeline.jiraBars`) shows the dashed bar `jira:<milestoneId>` per linked
  scheduled row.
- A tray milestone's appended row (`jiraRows`/`baselineRows` in `ProjectTimelineRows.tsx`) has a menu for whoever may schedule THAT milestone (its own `can.schedule`; none when Jira's two dates are reversed): `JiraRowMenu`, one item "Schedule
  on Jira's dates", whose click is `actions.scheduleOnJira`. The page writes the link's REAL dates (`jiraScheduleDates`) through `schedule.commit(..., { announce: true })`, the one write
  path, and a taken change moves the focus to the milestone's own row (`useRowMenuFocus(timelineRef).keep`, the Timeline's `focusRow`).
- The row menu's Link/Unlink item and the header button read the view; the bind dialog asks for its `connections[]` when it opens (`useJiraLinks`).

### Tests

The page's co-located tests (`ProjectView*.test.tsx` incl. `.jira`, `.jiraTray`, `.jiraImport`, `.pin`, `.baseline`; the form, dependency and `api/` helpers), and the e2e `project-view.spec.ts` (the real
pointer drag, the resize handle, the tray drop under scroll, the keyboard sensor, the stale notice) and `dependencies.spec.ts` (link, ghost row, arrow, cycle refusal, the manager's
conflict, delete).

`ProjectView.test.tsx` runs the page against a small fetch-mock server (a schedule PUT applies the dates and bumps the revision; the dependency POST/DELETE and the milestone picker list
are stubbed) and wraps `DndContext` to hand the test the page's drop handler; fake timers (`Date` only) pin "today" for the Schedule button.

## Roadmap

Files: `pages/Roadmap.tsx`;

- `api/roadmap.ts`: `getRoadmapView`, `putRanking`, `isStaleRevision` (a 409 whose problem `type` is `urn:astrolabe:problem:stale-revision`). The view's `RoadmapProject` carries the
  server's `rankPosition`, `teamIds`, `span`, `drift`, `flags[]`, `can.editTargetWindow`; the view carries `teams[]` and the rolled-up `links[]`.
- Hooks: `useRoadmapRanking.ts` (query + the one write path), `useRoadmapFilters.ts` (the filters and the pick, in the address and remembered), `useProgramPick.ts` (the programs
  page's pick, in its address and remembered under the shared key), `useCriticalTarget.ts`, `useTargetWindow.ts`, `useRowMenuFocus.ts`, `useJiraBarsPick.ts`.
- `utils/roadmapOrder.ts` (pure: `moveBy`/`moveToEdge`/`moveToSlot` - the team page's too -, `moveAmongVisible`, `rankingAfterDrop`, `sameIds`, `appendId`, `removeId`, `applyRanking`);
  `utils/roadmapRows.ts` (pure: filters, the pick, the displayed rows and the divider, the flag totals and panel entries, the drift band, the arrows of the rolled-up links);
  `utils/roadmapFilterParams.ts`, `utils/roadmapCritical.ts`, `utils/planTrack.ts`.
- Components: `RoadmapTimeline` (the rows, bars, bands, the row menu, the arrows - inside the page's `TimelineDndContext`), `RoadmapFlagPanel`, `RoadmapFilters`,
  `RoadmapCriticalPicker`, `RoadmapCriticalChain`, `UpstreamTable`, `BaselineTotals`, `JiraBarsToggle`, `TargetWindowModal`, `PlanProjectCells`.

### Route and data

`/roadmap` (nav section Planning after Plan, palette entry "Roadmap" / PL "Roadmapa") renders `GET /views/roadmap` (V13; the ranking is `PUT /roadmap/ranking`) under
`["roadmap","view"]` as a **timeline** on the shared `Timeline*` (`components/RoadmapTimeline.tsx`). A read for everyone; its editing is gated by the view's `can.editRank` (never the
session's roles): without it there is no handle, no ranking item in the menu, and the bars are read-only.

- Rows: one per project in rank order, then an "Unranked" divider row (present only while something unranked is visible) and the unranked projects (by name).
- Left columns, 404 px sticky: `#` (the SERVER's position, "—" when unranked; a filter leaves gaps), Project (the pointer-only row handle, the name as the link into `/projects/:id` -
  `roadmap.openProjectAria` "Open {{name}}" - the program dimmed after it), Flags, Operations (the row menu). Work stream and owner are filters, not columns.
- On the track: the project's **span bar** (read-only, `tone: "summary"`, name "{{name}}, {{start}} to {{end}}" plus ", N conflicts") over its **target window** (a `tone: "window"` bar,
  `window:<id>`, name `timeline.bar.window`; editable only where the project's own `can.editTargetWindow` is set, else a read-only image) and, past the window, the orange drift band
  (`utils/roadmapRows.ts` `driftBandOf`).
- The server's `span`/`drift`/`flags` are only read, never recomputed (a window write drops them optimistically; the refetch brings the server's).
- **Zoom:** Month / Quarter / Year (`PLAN_ZOOMS`, default Quarter) under its own key `timeline.planZoom`. The range only ever grows over every span and window of the WHOLE plan (a filter
  never shifts it); rows virtualise above 80 (`timeline.md` "The roadmap page's use").
- **Arrows** (`arrowSpecsForLinks`): a PROJECT-to-project link by its type on the two span bars, plus ONE bundle arrow per ordered project pair for the milestone links between them
  (`bundle:<pred>-<succ>`, `<title>` "A → B, 3 milestone links (1 violated)"); the roadmap never rolls up (`timeline.md` "The roadmap page's use").

### Flags

A row's `flags[]` show as icons with counts in the Flags cell (an ORANGE triangle for warnings, a gray info circle for infos, plus a visually hidden "2 warnings, 1 info"). The facts line
under the title ("N ranked", "M unranked", an ORANGE "K warnings" badge, a gray "J infos" badge) counts the VISIBLE rows.

- `components/RoadmapFlagPanel.tsx` (h3 "Flags", behind `TableDisclosure`) is their accessible surface: one table row per flag, severity in words (never colour alone), the project link,
  the sentence by kind (plural keys: "Ends 10 days after the target", "Ranked below X, but starts 7 days earlier on Team", …) and a "Show in timeline" button that calls
  `timelineRef.current.focusRow(projectId)` (the row-header cell, revealed, mounted or not).
- A `SegmentedControl` above the open table (a labelled radiogroup: All / Warnings / Infos, each label with its count, default All) filters the LIST by severity: panel-local state,
  never stored or in the URL. The row icons and the disclosure's count stay total, and an empty slice says "No warnings/infos among the flags shown." instead of an empty table (the
  Programs page has no flag panel).
- **The pending marker (1.26.0):** `FLOW_CAPACITY_PENDING` (a team flag, `roadmap.flag.flowCapacityPending`) is drawn neutral by `TeamFlags` (gray, hourglass, no `data-severity`); a project row's `flowPendingTeamIds` makes `FlagCountsCell` (`PlanProjectCells.tsx`, `flowPending`) add a gray hourglass (`data-flow-pending`) and the same words to its hidden sentence, never a count; the sentence names the pending teams (`utils/roadmapRows.ts` `pendingTeamNames` over the view's `teams`, `roadmap.flag.flowCapacityPendingTeams`) and falls back to the unnamed words for a team the view does not list.
  The team page's Capacity vs Flow row (`CapacityFact`) reads "Waiting for a complete Flow refresh" for an item with `sprintsComplete` false (never "In line"), and the Capacity from Flow section lists such a team with that note, a hint and a neutral `totals.pending` badge.
- **The Flow capacity flag:** `flagSentence` phrases `FLOW_CAPACITY_MILESTONES` through `names.team` ("{{count}} milestones on {{team}} are scheduled in sprints whose capacity differs
  from Flow"; the plural forms of both languages are in `flagSentences.test.ts`).
  - The panel puts an icon-only link beside it (`TeamLink`: `IconUsersGroup`, a visually hidden name `teams.openAria` "Open team {{name}}", to `teamPath(teamId)`, where the sprints
    are), shown only when the flag has a `teamId` the document's `teams[]` names. A team the document does not name (the server always names it) reads without its name
    (`roadmap.flag.flowCapacityMilestonesNoTeam`, as `inversionNoTeam` does) and offers no link.
  - The counts cells, the facts line and the filters count it like any flag; no Flow-staleness note is shown beside it (the document carries no Flow connection state).

### Filters

`components/RoadmapFilters.tsx` in a `FilterPanel`, held in the address and remembered through `hooks/useRoadmapFilters.ts` ("The URL holds the filters"): work stream, team (a project
matches when `teamIds` has it), owner, and:

- the **flag severity** (a select "Flag severity", Any / Warning / Info): a project is kept when one of its `flags[]`, Jira's included, has that severity; the flag panel keeps its own
  control and still lists every flag of the rows shown;
- flagged only;
- **unranked projects only** (a switch): no ranked row is shown, the unranked ones pass the other filters as before;
- the **program pick** (a `MultiSelect`, empty = all; its memory is the ONE key `planning.programPick`, which the programs page reads and writes through `hooks/useProgramPick.ts`).

They apply client-side through `utils/roadmapRows.ts` (`visibleProjects`; an id the address or the memory names and the view no longer has is ignored, `knownFilters`/`knownPick`), and
to the facts line and the panel too.

### The URL holds the filters

Flow's rule (its `useReportFilter`, ported): the address bar always holds the filters the page shows, and the seven stored keys (`roadmap.filter.workStream|team|owner|flagged|severity|unranked`,
`planning.programPick`) are the Roadmap's MEMORY, not its state.

- Parameters (`utils/roadmapFilterParams.ts`, pure: `parseRoadmapFilter`, `roadmapFilterParams`, `hasRoadmapFilterParams`; the ONE spelling of a filtered link is `roadmapFilteredPath`
  in `utils/planLinks.ts`): `workStreamId`, `teamId`, `ownerPersonId` (one positive integer each, `idOf`'s rule), `flagged=true` and `unranked=true` (the exact word),
  `severity=WARNING|INFO` (exact; the Deviations address's spelling) and `programId` repeated for the pick (de-duplicated, ascending, at most 100).
- Written in the order `programId, workStreamId, teamId, ownerPersonId, flagged, severity, unranked`. A malformed or unknown value is dropped, an id the plan no longer has filters
  nothing.

| Situation | Shown | Address | Remembered keys |
|---|---|---|---|
| bare URL, nothing remembered | no filter | stays bare | untouched |
| bare URL, something remembered | the remembered filters and pick | rewritten by `replace` to say so | untouched |
| a URL naming any filter parameter | exactly what it names (anything unnamed is off, the pick included) | as written | untouched |
| the user changes a filter or the pick | the new whole state | rewritten by `replace` (bare when empty) | all seven written with the new state |
| Back / forward | what that URL names | as navigated | untouched |

The hook answers `{ filters, pick, setFilters, setPick }`; the remembered state is read once at mount; a foreign parameter in the address is kept. A change is never a push and no effect
writes the memory on a link's arrival. The Programs page follows the same rule for the pick alone (`programId` in its address, the same key remembered: "Programs").

### The baseline overlay

With a baseline picked (`useRoadmapRanking(pick)`, the picker in the timeline toolbar) the page draws what `timeline.md` "The baseline overlay" ("Roadmap and programs") describes: the
shadow bar `baseline:<id>` (`projectTrack`), the dimmed "(removed)" rows, the rank movement "5 (was 3)" and the totals line.

- `components/BaselineTotals.tsx` prints the totals as one `role="note"` line under the facts; the removed ones are `view.baseline.removedProjects`, and the range grows over the frozen
  spans (the removed projects' too).
- The removed rows are appended after the last unranked row (`RoadmapTimeline`, `removedProjectRows`, `visibleRemoved`): the work stream filter and the program pick apply; a team,
  owner, flagged-only, severity or unranked-only filter hides them. The flag panel is untouched.
- The rank cell widens while a baseline is picked; a `VisuallyHidden` sentence carries the movement for assistive technology, and the totals note appends `rankTotals`.

### The critical path to a picked project

The toolbar's "Critical path to…" picker (`components/RoadmapCriticalPicker.tsx`: a searchable `Select`, "None" first, then the projects with a span by name; a picked project without
one stays an option of its own) and the row menu's "Show critical path to this project" / "Hide critical path" (disabled while a write runs, like the picker) set the target: PAGE-LOCAL
state (`hooks/useCriticalTarget.ts`, never stored - a question, not a setting), said in the live region. What is emphasised and drawn: `timeline.md` "The roadmap page's use".

- **The view's key.** The target is the second part of the key: `roadmapViewKey(baseline, criticalPath)` = `["roadmap","view",{baseline, criticalPath}]`.
  `getRoadmapView(baseline, criticalPath)` → `?baseline=N&criticalPath=M`; `useRoadmapRanking(baseline, criticalPath)` and `useTargetWindow` take the key like the pick. The optimistic steps spread the view, so
  the cached `criticalPath` block is KEPT like `baseline`; the `keepPreviousData` placeholder shows NO chain (`withoutCriticalPath`), since it is the old target's.
- The server's block is read by `utils/roadmapCritical.ts` (`criticalIndex`: the target and the zero-slack projects are emphasised, the pairs key the arrows; `chainProjects`: the
  panel's rows in the server's order) and drawn by `projectTrack`/`planArrows`.
- **A plain 400 for the target** (`isRejectedTarget`: deleted or off-roadmap; not the typed `unknown-baseline` one) clears the selection during render (`reject()`), shows
  `roadmap.critical.unknown` in a red inline alert until the next pick, and the key change fetches the plain view - no error flash, no loop.
- **The panel** (`components/RoadmapCriticalChain.tsx`, h3 "Critical path to {name}", under the flag panel while a target is set) states the target's span, then ONE table
  (`components/UpstreamTable.tsx`, shared with the project page's `CriticalChain`: hops, the project as a `RouterLink`, program, dates, slack, an "On the chain" badge) over
  `criticalPath.projects`. "Nothing is scheduled in {name}" and "No other project is upstream of {name}" are its empty states, and a project the filters hide stays listed with a dimmed
  "(not shown)".
- **Shared with the programs page:** `RoadmapCriticalPicker` takes `projects` (the page's `allProjects(view)` / `treeProjects(view)`).
  `RoadmapCriticalChain` takes `{projects, criticalPath, shown, intro, notShown}` (the two strings are the page's typed keys: the roadmap's `roadmap.critical.intro` / `.notShown`),
  with `chainProjects(projects, block)`. The menu item is `CriticalPathItem` (`PlanProjectCells.tsx`).
- **Said once per pick:** `useCriticalAnnouncement(target, chainProject, announce)` (`hooks/useCriticalTarget.ts`) remembers the TARGET it said the sentence for, forgetting it only when
  the target is cleared or replaced, so another baseline picked under a target (the kept copy shows no chain while the new document loads) does not say it again.

### The Jira markers

The toolbar's "Jira dates" toggle (`components/JiraBarsToggle.tsx`, after the baseline picker; ONE remembered boolean `timeline.jiraBars` through `hooks/useJiraBarsPick.ts`, **on by
default**, shared by all four timeline pages; rendered only when the view lists a Jira site) switches each bound project's shadow bar `jira:<id>` (`projectTrack(…, jira)`,
`utils/jiraBars.ts`; look, window and naming: `timeline.md` "The Jira markers").

- The flag panel phrases `JIRA_DEVIATION` as "Jira {{key}}: " + the Deviations page's sentence for `flag.deviation` with an icon-only link to the issue through the view's `jiraSites`
  (`JiraKeyLink`; the URL is never per row), and `JIRA_MILESTONES` as "{{count}} milestones deviate from Jira"; the icons and counts stay severity-driven.
- **The currency line.** While `view.jiraSites.some(isStaleSource)` (`utils/staleness.ts`: a site's `state` is not `CURRENT`, or `mappingOk` is false; a DISABLED site counts, as on the
  chips) the facts line ends with the chips' dimmed "Jira data may be out of date" (`JiraStaleNote` in `JiraChips.tsx`, key `deviations.chip.stale`), INSIDE the `role="group"` after the
  badges (nothing under it moves).
  - It is about the PLAN, not the rows on screen: `jiraSites` lists every site a project or milestone binding of the whole document links through and a project's milestone roll-up does
    not say which, so no filter, program pick or fold narrows it. It shows with the "Jira dates" toggle off; a plan with no binding lists no site and says nothing.
  - Plain text: the Deviations banner is the warning.

### The write path

Every change - a row-menu move, a row drag, Rank (append), Unrank - becomes the complete new id list and is sent as the wholesale PUT with the `expectedRevision` of the view on screen.
The view's `revision` is the RANKING's own (V18): a plan write elsewhere never stales it, so the page only echoes it and a stale 409 means another ranking write or the delete of a
ranked project.

`commit`:

1. answers `true` WITHOUT a PUT when the list equals the current one (a drop beside the row itself);
2. REFUSES the change out loud while a write is in flight (`useIsMutating` on the shared mutation key `["roadmap","write"]`, `ROADMAP_WRITE_KEY`, which the window write path shares):
   `refused` drives the page's orange `role="note"` "try again" Alert and `project.busy` goes to the page's one polite live region; `useRefusal` clears it when no write is left. The grid
   carries `aria-busy` and a "Saving…" indicator, and every entry point answers whether the change was taken;
3. cancels in-flight `["roadmap"]` fetches;
4. writes `applyRanking(view, ids)` into the cached view synchronously (the optimistic reorder: the ranked list in the new order, positions 1..n AND each project's own `rankPosition`;
   flags and spans stay the server's until the refetch; the row, the focus and the PUT all start from the same click);
5. `mutate`s with the pre-change view as the rollback.

- `onSuccess` stores the response's `revision` in the cached view and starts `refreshQueriesAfterMutation(["roadmap"])` WITHOUT awaiting it (the save is over once the PUT answers, so a
  held Enter on a menu item is never swallowed; the next `commit` cancels that refetch before it writes its optimistic order, and the stored revision is what it sends).
- `onError` restores the pre-change view and AWAITS the refresh (the reload after a stale 409 must finish before another change builds on the list).
- A stale-revision 409 (the problem type is what tells it from any other 409) shows `roadmap.stale`, "the roadmap changed in the meantime - the list was reloaded": **the change was NOT
  saved**, and the alert says so. 403/400/other failures map through `saveErrorMessage` into an inline alert - never a toast, and no success toast either (the optimistic reorder and the
  live region are the feedback).
- The Plan page's mutations also refresh `["roadmap"]`.

**The paths.**

- The **row menu** (the deterministic, keyboard path; focus: "Roadmap menu focus" below):
  - ranked rows: Move up / Move down / Move to top / Move to bottom (disabled at the ends of the VISIBLE ranked rows) and Unrank;
  - unranked rows: Rank (appended at the END);
  - always: Dependencies (a `RouterLink` to `/dependencies?projectId=N` through `dependenciesFilteredPath`, accessible name "Dependencies of {{name}}", the arrows' text path, offered on EVERY
    project row to every viewer, also a project without links, since the row's own document cannot tell; `DependenciesItem` in `PlanProjectCells.tsx`) and Open project.
- The **row drag** by the pointer-only handle (`TimelineRowHandle`; `onReorder(id, slot)` on the page's `TimelineDndContext`, the team page's mechanism, `timeline.md` "Row drag"):
  inside the ranked rows it moves the row; **across the divider** a drop above it RANKS an unranked row at that slot and a drop below it UNRANKS a ranked row (dropping an unranked row
  among the unranked changes nothing). There is no keyboard drag - the row menu is the keyboard path.
- **Announcements:** dnd-kit's region announces a drag (also across the divider); the page's polite region says the menu changes only ("{{name}} moved to position …", "… ranked at
  position …", "… removed from the ranking").

**Under a filter.** The moves take the ids of the VISIBLE ranked rows: `moveAmongVisible(full, visible, id, slot)` numbers the gaps like `moveToSlot` but over the rows the user sees and
puts the row just before the visible row that follows the gap (after the last visible row for the final gap), so hidden rows keep their order and their place. A drop is
`rankingAfterDrop(full, visibleRanked, id, slot)` with the slot counted over the DISPLAYED rows: a slot beyond the divider (`visibleRanked.length`) unranks a ranked row (an unranked row
comes back unchanged = no PUT); a slot up to it is a place in the ranking, so an unranked row is RANKED there. The page binds `visibleRankedIds` into the hook's `move`/`moveTo`/`dropAt`.

### Roadmap menu focus

A browser blurs a focused element whose row is moved in the DOM, so after a taken menu change the page restores keyboard focus (`refocus` in `Roadmap.tsx`, then `hooks/useRowMenuFocus.ts`). Its ids are `BarId`: the Plan page's order moves pass `tree:pg:12` (`plan-tree.md`).

- The render that reorders is followed by `focus()` on the row's `data-operations-for` menu button, or by `focusRow(id)` when the virtual path has unmounted the row (Move to bottom,
  Rank on a 100-row plan).
- The refocus is repeated once the row menu has FINISHED closing (`RowActionsMenu`'s opt-in `onClosed` = Mantine's `onExitTransitionEnd`, via `actions.menuClosed`): the dropdown and its
  focus trap stay mounted through the ~150 ms exit transition and pull an earlier focus back into the dropdown, which lands on `body` when the dropdown unmounts.
- **Rank under "Unranked projects only":** the ranked row leaves the list at once, its menu button with it, so the page reads the neighbour from `visible.unranked` BEFORE the write
  (`neighbourOf`: the next row, else the previous) and keeps the focus on THAT row (`focus.keep(neighbour ?? project.id, …)`; `useRowMenuFocus` is unchanged in that).
  - With no row left the focus goes to the **Filters button**: the hook is given a `fallbackRef` (the page's `FilterPanel` `toggleRef`) and uses it whenever the row it was asked for is
    neither a menu button nor one of the timeline's rows (`focusRow` answers `false`) or the timeline is not mounted (the empty state replaced it). Only the Roadmap passes a fallback;
    Programs and the project page keep nothing. The status region has said the change either way.
  - **The armed second put:** that put waits for the used row's menu to close, but a menu that left with its row never closes; the render after `keep` drops the wait when
    `[data-operations-for=<used row>]` is gone, so the row coming back later (the filter turned off) is not mistaken for that close and does not steal the focus.
- **After a rolled-back ranking write:** `useRoadmapRanking` counts `rollbacks` (a failed save has restored the view and its awaited reload has settled); the page's effect calls
  `focus.returnToOrigin()`, which puts the focus back on the row the change came from (`watchRollback`'s `from`: the ranked row itself, not the neighbour) by the same rule, but only
  while the focus is still on the element the hook put it on, or on `body`: a focus the user has moved meanwhile (the Programs field) is left alone, as in `useDialogFocus`.
  - Only the failure of a write the page saw go out (`watchRollback`, via `ranking.writeCount()`) can return the focus, and the row is forgotten (`forgetOrigin`) when that write
    settles without a rollback, so a later failed pointer drag never pulls it to an old row.
  - A user focus that sits on the very element the hook placed (they pressed Enter on the Filters button before a 409/403 settled) cannot be told apart from the hook's own, so the focus
    returns to the row.
- Under happy-dom Mantine's exit transition never ends, so `menuClosed` is proven at the hook (`useRowMenuFocus.test.tsx`), the rest in `Roadmap.test.tsx` ("Rank under Unranked projects
  only").

### The target window

Both plan pages. Wherever the project's own `can.editTargetWindow` is set (ADMIN, an owner ABOVE the project, a ROADMAP_EDITOR - the project's own owner alone is read-only; never the
session's roles) the window is edited by:

1. moving or resizing its band (the bar machinery, keyboard included; the read-only span bar over it is pointer-transparent, `.timelineBarInert`, so the window under it is grabbed where
   they overlap and a draw can start on it);
2. a **draw** across a row with no window (`projectTrack` returns `draw: {barId: "window:<id>"}`);
3. the row menu: "Edit target window…" (`components/TargetWindowModal.tsx`, the `MilestoneScheduleModal` shape: two `PlanDateInput`s, both required, end not before start, a Clear
   button, the refusal shown inside the dialog) and "Clear target window" (`TargetWindowItems` in `PlanProjectCells.tsx`) - the keyboard and touch path.

All three are `onSchedule("window:<id>", start, end)` / the menu on the page's `TimelineDndContext`, answered by ONE write path, `hooks/useTargetWindow.ts` ("The target window's write
path"; generic over the cached view: roadmap `["roadmap","view"]` with `applyRoadmapWindow`, programs `["roadmap","programs"]` with `applyProgramsWindow`).

- Failures read 403 `roadmap.window.forbidden` / 404 `roadmap.window.gone` / 400 `roadmap.window.invalid`, and a change while the ranking write runs (or the reverse) is **refused out
  loud**, the dialog staying open with its own alert.
- After a menu action the focus returns to the row's menu button (`hooks/useRowMenuFocus.ts`, the roadmap's `onClosed` pattern, `restore` for a closed dialog).
- Drags are announced by dnd-kit, the dialog and Clear by the page (`roadmap.announce.windowSet/windowCleared`).

### The target window's write path

`hooks/useTargetWindow.ts` is generic over the page's cached view (`view`, `queryKey`, `apply`, `nameOf`, and the page's `announce`).

- `commit(id, start|null, end|null, {announce?, ownRefusalAlert?}) → boolean` cancels in-flight reads of the view, writes `apply(...)` (`utils/targetWindowUpdate.ts`: the window set,
  `drift` and the DRIFT_* flags dropped - the RANK_INVERSION flags stay -, and on the programs view the program's and work stream's roll-up counts lowered by the dropped flags), then
  `mutate`s `PUT /projects/{id}/target-window` (204, no revision) with the pre-change view as the rollback.
- Success refreshes `["roadmap"]` and `["plan"]` WITHOUT awaiting (so the other plan page, not mounted, is invalidated and a mounted project view's band follows). Failure restores
  the view, AWAITS the refresh and maps 403/404/400 through `saveErrorMessage` (`roadmap.window.*`).
- The mutation key is the ranking's exported `ROADMAP_WRITE_KEY`, so `useIsMutating` sees both and each refuses the other: `commit` answers `false`, sets `refused` (`useRefusal`) and
  announces `project.busy`. A change aimed at a project that left the view sets `gone`.
- The roadmap passes `ranking.announce` as its `announce` (ONE polite region), the programs page its own toggled-suffix announcer.
- `hooks/useRowMenuFocus.ts` is shared by both pages (`keep` = at render and again on the menu's `onClosed`; `restore` = at render only, for a dialog that was opened from the menu).
- The dialog (`TargetWindowModal`, `returnFocus={false}`: the page puts the focus on the menu button) is kept as `{id}` page state, the project read from the view on every render and the
  dialog closed when it left.
- **dnd-kit's click blocker:** after ANY drag ends, dnd-kit swallows the next `click` for 50 ms (its document-level capture listener is removed on a timer), and an Enter on a button is a
  click - a Playwright step that presses a menu button right after a drag must retry (`e2e/tests/roadmap.spec.ts` `menuItemByKeyboard`).

### Tests

The page's co-located tests (`Roadmap*.test.tsx` incl. `.flow`, `.jira`, `.baseline`, `.critical`, `.window`; `roadmapOrder|roadmapRows|roadmapCritical|targetWindowUpdate.test.ts`; `Roadmap.test.tsx` has "the filters in the address"), among them `hooks/useRoadmapFilters.test.tsx` (the table), `planTrack.test.ts` (who gets an editable band and a draw surface), `planForm.test.ts` (the dialog's rules), and the e2e `roadmap.spec.ts` (the real pointer drag inside the ranking and
across the divider, focus retention after a menu move, the stale notice, the window gestures: its third scenario).

`Roadmap.test.tsx` runs the whole flow against a small fetch-mock server (a PUT applies the order and bumps the revision); it wraps `DndContext` to hand the test the page's drag
handlers (a row drop is fed with the row zone's live readers), since happy-dom has no layout for a real drag.

## Programs

Files: `pages/Programs.tsx`;

- `api/programs.ts`: `getProgramsView(baseline, criticalPath)`, `programsViewKey` = `["roadmap","programs",{baseline, criticalPath}]`, the view types.
- `utils/programsTree.ts` (pure: `treeRows`, `defaultOpen`, `allOpen`, `toggled`, `programChoices`, `treeFacts`, `treeDates`, `arrowAnchors`); `components/ProgramsTimeline.tsx` (tree rows →
  `TimelineRowData[]`, the chevron cell, the arrows).
- Shared with the roadmap: `utils/planTrack.ts`, `components/PlanProjectCells.tsx`, `components/ProgramPickField.tsx`, `hooks/usePlanScale.ts`, `hooks/useProgramPick.ts`,
  `utils/roadmapRows.ts` `pickAmong`.

### Route and data

`/programs` (nav section Planning after Roadmap, `IconListTree`; palette "Programs" / PL "Programy") renders `GET /views/programs` under `["roadmap","programs"]` (under the
`["roadmap"]` prefix the Plan page and the project view already refresh) as the plan **tree on the shared Timeline** (`components/ProgramsTimeline.tsx`): work stream → program →
project, one row each, in the server's order (open streams first, projects ranked first).

- Read for everyone; the one thing written here is a project's target window (band, draw, row menu - "The target window" under "Roadmap", the same shared row and write path). The
  server's spans, flag counts, drift and link checks are only read.
- **Zoom:** Month / Quarter / Year under `timeline.planZoom` (the roadmap's key); the range grows over every span and window of the WHOLE plan (`hooks/usePlanScale.ts`).
- The Timeline is wrapped in the page's `TimelineDndContext`, the window gestures' drag context, as on the roadmap.

### Rows

`treeRows(view, pick, open)` (`utils/programsTree.ts`, pure and tested). Left columns, 448 px sticky (the Flags column is 120 px: a stream's roll-up runs to three digits on the sample
plan): the name (a tree indent of 16 px per level), Flags, Operations.

- A **work stream / program row** shows its name with the owner dimmed (and "(closed)" for a stream with an end date), a read-only `tone: "summary"` bar over the span its projects cover
  (`programs.streamBarAria`/`programBarAria`) and the **roll-up counts** of its projects' flags in the Flags cell (the project row's icons: an orange triangle and a gray info circle
  with a visually hidden sentence, `data-flags`). A node with nothing under it (an empty program) shows no chevron.
- A **project row** is the roadmap's row - `projectTrack`: the target-window band, the span bar (with ", N conflicts"), the drift band - with the name as the link into the project (the
  owner dimmed) and a menu that holds the critical-path item ("Show…"/"Hide critical path", for everyone), "Dependencies" (the roadmap's `DependenciesItem`: the text path of the arrows, a
  link to the list narrowed to the project), "Open project" and, by the project's own `can.editTargetWindow`, the window items.
- Row ids are `ws:<id>` / `pg:<id>` / the project id; bar ids the same (`ws:`/`pg:` keys, the project id), so the arrows anchor on the project ids as on the roadmap, or, for a project
  whose row is folded away, on the bar of the folded row that stands for it ("Arrows").
- **One project-row builder.** `projectTrack(project, t, conflicts)` is the only place a project's bars and drift band are made (`window:<id>` and `<id>` bars, `drift:<id>` band);
  `planArrows` (over `arrowSpecsForLinks` and `rolledUpLinks`, in `utils/roadmapRows.ts`) is the only place the rolled-up links become arrows. `RoadmapTimeline` and `ProgramsTimeline`
  both call them (the roadmap's `anchorOf` answers only a project's own id, so it never rolls up), so the target window's gestures (an editable `window:<id>` bar by the project's
  `can.editTargetWindow`, the draw surface on a row without a window) land once; the menu's window items are `TargetWindowItems`.
- **Roll-up in part.** `shownStreams` (inside `programsTree.ts`) keeps the server's span/counts for a stream shown whole and recomputes them (`unionSpan`, `sumFlags`) for one the pick
  shows in part. Nothing else on the page is computed.

### Expand and collapse

A node with children has a chevron `ActionIcon` as the ONE roving stop of its name cell (a function cell), `aria-expanded`, its name telling the level ("Work stream X" / "Program Y",
`programs.streamAria`/`programAria`; no `aria-controls` - the child rows are separate grid rows without ids). Enter/Space flips it, the focus stays on that chevron and the page SAYS what
happened in its polite status region ("X expanded, 3 programs", "X collapsed").

- Defaults: every work stream open, every program closed. **Expand all / Collapse all** buttons in the facts row. The expanded set is **page state, not persisted**.
- **The expanded set** is `useState<ReadonlySet<string> | null>(null)` in `ProgramsBody`: `null` means "the defaults" (`defaultOpen(view)`: every stream), so a work stream that appears
  with a refetch opens; any change (a chevron, Expand all, Collapse all) writes a concrete set from what the user sees.
- `toggle(key)` finds the row in the CURRENT rows to say what it did (`programs.announce.*` with a plural `count`).
- **Focus.** While the rows stay on one render path the chevron button is the same DOM node before and after (rows are keyed by id), so it keeps the focus and the roving grid re-adopts
  it as the tab stop. A toggle that crosses the virtualisation threshold (80 rows) remounts every row (`timeline.md` "The programs page's use"), so `toggle` records the node key in a
  ref and an effect, after the render, leaves the focus alone only when `[data-node-key=<key>]` is the active element and otherwise calls `timelineRef.focusRow(key)` (the roadmap's
  `refocus` pattern). Pinned by `Programs.virtual.test.tsx`.

### The program pick

The roadmap's pick, in the address (`hooks/useProgramPick.ts`): the same rule as the Roadmap's filters ("Roadmap" "The URL holds the filters", the table), for the pick alone.
`programId` repeated (`parseProgramPick` / `withProgramPick` in `utils/roadmapFilterParams.ts`, the Roadmap's own spelling: de-duplicated, ascending, at most 100).

- An address naming `programId` (even a malformed one) is shown exactly as written (none valid = every program) and remembers nothing; only the user's own change writes the ONE key
  `planning.programPick` (shared with the Roadmap) and rewrites the address by `replace`.
- Nothing links into the page (the address is there to be copied).
- The same `ProgramPickField` (its labels `common.filter.*`) sits in a `FilterPanel` (stored `programs.filtersOpen`). The `MultiSelect`'s clear button is `aria-hidden` (Mantine), so tests
  and e2e find it by its label (`getByLabel`), not by role.
- It is read through `pickAmong(programChoices(view), pick)`: `programChoices(view)` lists every program (empty ones too); the roadmap passes its own `programOptions(view)` (programs with
  projects) to the same function. An id only one of the pages knows, or that the plan no longer has, is ignored there, not dropped from storage or the address.
- A picked program keeps its work stream's row; a stream with no picked program is hidden; a stream the pick shows in part is rolled up over the programs that remain ("Roll-up in
  part"). The facts line ("N work streams · M programs · K projects", an orange "K warnings" and a gray "J infos" badge) counts what is shown.

### Arrows

`planArrows` over `view.links` between the rows that STAND FOR the projects (`arrowAnchors(view, pick, open)`, `utils/programsTree.ts`): the project's own row, else its folded
program's row, else its folded work stream's. Two project rows keep the roadmap's arrows; every other pair of rows gets ONE `rollup:<fromRow>-<toRow>` arrow, END to START, titled by
`roadmap.rollupLabel` with the two rows' names; a folded node's bar says ", N conflicts" for the violated links ending on it. Nothing is opened for the user, and the figures are the
server's, only summed over what is folded. The rules (the anchors, the count, red, critical, what draws nothing): `timeline.md` "The programs page's use".

### The baseline overlay

The same picker, shadow bar (`projectTrack`) and totals line as the roadmap; the rules are `timeline.md` "The baseline overlay" ("Roadmap and programs"). The query key
`["roadmap","programs",{baseline, criticalPath}]` carries the pick (and the critical-path target).

- The view lists its removed projects: each is appended as a dimmed "(removed)" row under its program when that program is shown and expanded (`treeRows`' `removedProject` kind,
  `ProgramsTimeline`'s `RemovedLabel`). They count as the program's children, so a program whose live projects are all deleted can still be expanded.
- A work stream and a program row also get a shadow bar from their own `baseline.span`.
- Tests: `Programs.baseline.test.tsx`.

### The Jira markers

- The same "Jira dates" toggle (after the baseline picker, the one stored `timeline.jiraBars`, on by default, only when the view lists a Jira site) and the same project-row bar
  `jira:<id>` (`projectTrack`; a project row only - work stream and program rows are not bound); the roll-up counts in the Flags cell and the facts badges stay severity-driven.
- The page has no flag panel. A project's Flow capacity flag counts in its row and in the roll-ups of its program and work stream like any flag; the sentence and the team link are the
  Roadmap panel's ("Roadmap" "Flags").
- **The currency line** is the roadmap's: the facts line (`ProgramsFacts`) ends with "Jira data may be out of date" while any site in `view.jiraSites` is behind (`isStaleSource`);
  plan-wide, so neither the program pick nor a fold narrows it.
- Tests: `Programs.jira.test.tsx`.

### The critical path to a picked project

The roadmap's pieces, shared and never forked ("Roadmap" "The critical path to a picked project"): the toolbar's "Critical path to…" picker (after the baseline picker; every project of
the tree with a span, folded or picked away too), the row menu's `CriticalPathItem`, the panel (`RoadmapCriticalChain`, h3 under the timeline) and `useCriticalAnnouncement` (the sentence
is said once per pick).

- The target is `useCriticalTarget()` in `Programs()` (page-local, never stored, not the roadmap's) and the second part of the view's key (`programsViewKey(baseline, criticalPath)`,
  `getProgramsView` → `?baseline=N&criticalPath=M`). `useTargetWindow` gets the keyed entry, so a window write keeps the block; the `keepPreviousData` placeholder shows no chain
  (`withoutCriticalPath` after `withoutStaleOverlay`). A plain 400 for the target clears it during render and shows `roadmap.critical.unknown` (`isRejectedTarget`).
- **The emphasis lands on the row that stands for the project** (`arrowAnchors`; `timeline.md` "The programs page's use"): a project row on the chain gets `projectTrack`'s `critical`
  argument; a FOLDED node row that stands for at least one chain project gets `emphasis: "critical"` on its summary bar and ", holds a project on the critical path"
  (`programs.barCriticalInside`) in its name; an expanded node is not emphasised (its children are); nothing is ever opened for the user.
- The panel's `shown` is the project rows on the timeline; a chain project in a folded row or outside the program pick reads `programs.critical.notShown` "(folded or not picked)", and
  the intro's last sentence is `programs.critical.intro`. "Showing the critical path to X" / "Critical path hidden" go through the page's one status region.
- Tests: `Programs.critical.test.tsx`.

### Tests

The page's co-located tests (`Programs*.test.tsx` incl. `.virtual`, `.baseline`, `.jira`, `.critical`, `.window`; `utils/programsTree.test.ts`), the e2e `programs.spec.ts` and the axe scans in `accessibility.spec.ts`.

`Programs.test.tsx` runs the page against a one-endpoint fetch mock (the default open set, the chevron by pointer and keyboard, the status sentences, Expand/Collapse all, the arrows
following the fold, the pick and its shared key, Year zoom, empty and failed loads).

## Milestones

Files: `pages/Milestones.tsx`; `api/milestones.ts` (`listMilestones`); `utils/milestoneFilters.ts` (pure: `parseMilestoneFilter`, `milestoneFilterParams`, `narrowingCount`, the Schedule choice, `cascadePatch`, `milestoneSortParam`);
`utils/milestoneLinks.ts` (`milestonesPath`, `unscheduledMilestonesPath({teamId?, projectId?})`, the builder Home's "not scheduled" figures use); `components/MilestonesFilters.tsx`;
`components/TeamFilterSelect.tsx`, `components/PlanFilterSelect.tsx` (`level`, optional `within`; its project level also on Dependencies), `components/ProjectScopeChip.tsx` (also on Dependencies); `hooks/useTeamOptions.ts`; `utils/planNames.ts`.

### Route and data

`/milestones` (nav: Planning, `IconTimelineEvent`, **everyone**, read-only) lists every milestone of the plan from the paged `GET /milestones`. The rows are the ones the dependency pickers
search, so a milestone under a deleted project or program is absent. It is the list-page template ("Shared list-page and dialog mechanics": `FilterPanel`, `SortHeader`,
`RegistryListTable`) with the filters in the URL instead of `useStoredState` (the Deviations idiom, no remembered filter).

- Query: key `["plan","milestones","list", page, pageSize, sortParam, scheduled, teamId, workStreamId, programId, projectId, name]` (under `["plan"]`, so a schedule or plan write refreshes it; the pickers' own
  search is not a query), `placeholderData: keepPreviousData`. Sortable Rank / Milestone / Project / Team, initial sort project name; the Rank header sends `rankPosition,projectName,startDate,name`, descending `-rankPosition,…` (`milestoneSortParam`: only the first key flips, so unranked projects come last both ways, by name); sort and page size are
  remembered per browser (`usePagedSort`, key `milestones`).
- Rows: the project's rank ("–", hidden "Not ranked", if none), milestone name (text: a milestone has no page), project (link, `plan.openProjectAria`), team (link, `teams.openAria`), estimate in man-days, start, end; a milestone without dates
  shows one dimmed "Not scheduled" across the two date cells. Under the title: "N milestones" (the server's `total`); the empty states carry a "Clear the filters" button.

### Filters

- In the URL: `scheduled` (the exact words `true`/`false`; `false` is the unscheduled list), `teamId`, `workStreamId`, `programId`, `projectId` (positive integers, `idOf`) and `name`. A malformed value is dropped, a
  change `replace`s the entry, so a link, a reload and Back restore the view.
- Controls: the Schedule select (All / Not scheduled / Scheduled, never clearable), the team select (EVERY team: `useTeamOptions`, key `["teams","options"]`, shared with the Deviations
  panel), the Work stream, Program and Project selects (the plan view's nodes, no chips for the first two; each offers what lies under the picks above it, and a work stream or program pick drops an earlier pick outside it, `cascadePatch`; an id the plan lacks is never dropped) and the name search (`ClearableTextInput`).
- A `projectId` is also a removable chip beside the toggle (`ProjectScopeChip`: "Project: Invoices", named from `GET /views/plan` under `["plan","view"]` through `utils/planNames.ts`, the
  Deviations page's strings), so the scope shows with the panel closed; the select and the chip are two views of one parameter.
- The name input keeps the text as typed and writes it trimmed to the URL at once; the REQUEST waits 300 ms (the debounced value is in the query key), and a URL change from elsewhere
  (Back, a link, "Clear the filters") that disagrees with the typed text replaces it during render.

### Tests

The page's co-located tests (`Milestones.test.tsx`, the `milestoneFilters|milestoneLinks` `utils/` tests; fixtures `test/milestones.ts`).

## Dependencies

Files: `pages/Dependencies.tsx`; `api/dependencyList.ts` (`getDependencyListView`); `utils/dependencyListRows.ts` (`resolveDependencyList`); `utils/dependencyListFilters.ts`
(`parseDependencyListFilter`, `dependencyListFilterParams`, `matchesDependencyFilter`, `narrowingCount`); `utils/dependencyListLinks.ts` (`dependenciesPath`,
`dependenciesFilteredPath(filter)`, `violatedDependenciesPath({teamId?, projectId?})`, the builders the plan pages' and Home's links use); `components/DependencyListFilters.tsx`;
`components/DependencyListTable.tsx`; `components/DependencyCells.tsx`; `components/ProjectScopeChip.tsx`; `components/DependencyAddModal.tsx`, `DependencyFormParts.tsx`.

### Route and data

`/dependencies` (nav: Planning after Milestones, `IconLink`, **everyone**) lists every dependency of the plan from the ONE unpaged `GET /views/dependencies`
(`getDependencyListView`, key `DEPENDENCY_LIST_KEY = ["plan","dependencies"]`, under `["plan"]` so every plan write refreshes it; at most 1,000 rows with `truncated`); the page also reads the plan view (`getPlanView`, revalidated). Each row carries
the caller's own `can{edit, delete}`, the project view's flags, and nothing else differs between callers.

- **The wire document names its ends once.** A row holds `predecessor`/`successor` as `{kind, id}` and the names are in `milestones`, `projects` and `teams`, exactly what the listed
  rows name. `resolveDependencyList` joins them back, once, in the page's query function (`readDependencyList`), so the cache holds the resolved list: each row's two ends are
  `{kind, id, name, projectId, projectName, teamId, teamName}` (the table, the filter and their tests read that).
- It is NOT a `select`: a reference the lists do not hold throws in the query function, a failed read (below); why, in the comment at `Dependencies.tsx:29-33`.
- Each row is the project view's own item minus `critical` and `can`, in the server's order: the page never sorts
  or recounts.
- The facts line (`role="group"`, "N dependencies", Home's own red string `home.roadmap.conflicts` and a gray "N not scheduled yet", each badge only when positive, the whole line absent
  while the plan has no dependency) reads the document's `totals` over EVERY dependency, so a filter or the cap never changes it.

### Changing a link

A row offers "Edit…" and "Delete" in a `RowActionsMenu` (named `common.table.operationsAria` with "predecessor → successor", each end with its project) only under its own `can` flag.

- A row with neither has no menu, never a disabled control; when no shown row offers anything the operations column (header `common.table.operations`) is absent altogether, otherwise a
  row without a menu has an empty cell.
- "Edit…" opens the project page's own `DependencyEditorModal` with `project={null}` (the type and the lag; both ends read-only, each naming its project; the page owns `useDialogFocus`,
  so the focus returns to the row's menu button). "Delete" goes through `useDeleteConfirm` and the shared `DependencyDeleteModal` (the project page's wording; the focus goes to the page
  title).
- A save or a delete refreshes `["plan"]` (this list, the plan, project and team views, Home) and `["roadmap"]`; the dialog's own errors (the cycle `409` with its path, the `403`, the
  `404` of a link deleted meanwhile) stay in the dialog and re-read nothing.

### Adding a link

The header's "Add dependency" shows only while the plan view (`planViewKey`) is answered, not failed, and holds a project with `can.createDependency` (`addableProjects`).

- `DependencyAddModal` (parts shared with the project page's editor in `DependencyFormParts.tsx`): the successor's project (a `Select` over those, started from `?projectId=` when addable), the successor (`MilestoneSelect projectId`, or the project), the predecessor from the whole plan, type, lag.
- Errors stay in the dialog, on their fields; it cannot close while saving. A save refreshes the plan and roadmap groups, keeps the filters, and returns the focus to the button.

### Filters

Three filters are in the URL like the Milestones page's (a change `replace`s the entry; nothing is remembered): `status` = `violated` | `ok` | `unscheduled` (absent, `all` or unknown =
every dependency), `teamId`, `projectId` (positive integers, `idOf`).

- They are applied in the browser over the rows that arrived, AND-combined, so a change makes no second read: a team keeps a row when either end is a milestone of it (a project end has no
  team), a project when either end belongs to it (a project end's `projectId` is its own id).
- Controls: the Status select (All / Violated / OK / Not scheduled yet, never clearable; "OK" and "Not scheduled yet" are the project table's `project.dependency.status.*`), the team select
  (EVERY team, `useTeamOptions`) and the Project select (every project of the plan view), plus, for a `projectId`, the removable chip `ProjectScopeChip` beside the toggle.

### Table and states

- The table (`DependencyListTable`, named "Dependencies of the plan" - not "Dependencies of the project", which the project page's table and e2e specs address): a plain table in a
  `ScrollRegion` with a 70vh height cap and a sticky header (the baseline comparison's shape). Status, lag and dates are the project table's own cells (`DependencyStatusBadge`,
  `DependencyLagText`); an end's cell: its name ("Project X" for a project end), under it its project (link, `plan.openProjectAria`) and, for a milestone, its team (link, `teams.openAria`).
- Loading: `LoadingBlock`, no facts line and no claim until the read answers. A failed read: `ErrorAlert`; the rows of a kept document stay on screen over a failed re-read, and no empty claim
  is made from it (a document whose row names an end the lists do not hold is that same failed read).
- No dependency at all (`totals.links === 0`); nothing matches the filters (with "Clear the filters" when a filter narrows).
- `truncated`: one dimmed line under the rows shown; when the filters hide every row READ, the line says "none of the first N" with the same Clear button, never "nothing matches".

### Tests

The page's co-located tests (`Dependencies.test.tsx`; `Dependencies.write.test.tsx` pins the menu by `can`, the dialog, the confirmation, the refresh, the focus; the `dependencyList*` `api/` and `utils/` tests). The fixtures `test/dependencyList.ts`: rows and ends are the RESOLVED shapes;
`dependencyListView(rows)` answers the wire document built from them.

## Team load

Files: `pages/TeamLoad.tsx`; `api/teamLoad.ts` (`getTeamLoadView`); `utils/teamLoadFilters.ts` (`parseTeamLoadFilter`, `teamLoadFilterParams`, `matchesWarning`, `matchesWeek`);
`utils/teamLoadLinks.ts` (`teamLoadPath`, `teamLoadWarningPath(warning)`, the builder Home's two capacity badges use); `components/TeamLoadWeeks.tsx`; `components/WeekLoadCells.tsx`
(`WeekStatus`; `weekLabel` and `mdText` live in `utils/weekLoadText.ts`, imported by `TeamWeeklyLoad.tsx` too).

### Route and data

`/team-load` (nav: Planning after Dependencies, `IconGauge`, **everyone**, read-only) lists every team against its capacity from the ONE unpaged `GET /views/team-load`
(`getTeamLoadView`, key `TEAM_LOAD_KEY = ["plan","teamLoad"]`, under `["plan"]` so a schedule or capacity write refreshes it; at most 200 rows with `truncated`, the same document for every
caller, no `can`). The figures are the team page's own and are shown as they arrive, never recounted.

- The facts line (`role="group"`, "N teams" and the two orange badges in Home's own strings `home.roadmap.overloadedTeams|wipTeams`, each only when positive) reads the document's `totals`
  over EVERY team, so a filter or the 200-row cap never changes it.
- Columns: Team (the link to the team page, `teams.openAria`), Manager (dimmed "No manager" when none), Milestones, Not scheduled (a link to `unscheduledMilestonesPath({teamId})` named by
  its row, `teamLoad.notScheduledAria`, only when positive; a plain 0 otherwise), Overloaded and WIP (the team page's two orange badges, only when positive) and Capacity (a gray "N weeks
  without capacity" badge, only when positive: a team with scheduled work and no capacity period can never be overloaded, and the page says so instead of looking fine). No row or page ever
  says "fits"; no chart; every figure is worded.
- States: loading (`LoadingBlock`, no facts line and no claim until the read answers), a failed read (`ErrorAlert`, no empty claim), no team at all (`totals.teams === 0`), nothing matches
  the filter (with "Show every team"), `truncated` (one dimmed line with the rows shown).

### Filters

Both are in the URL like the Milestones page's (a change `replace`s the entry; no remembered filter) and applied in the browser over the rows, so changing one makes no second read.

- `warning` = `overloaded` | `wip` | `any` (absent or unknown = every team). `any` means an overloaded week or a week over the WIP limit; weeks without capacity are a fact, not a warning.
- `past` (`?past=true`, the exact word; anything else reads as off) is the "Include past weeks" `Switch` after the Show select (`teamLoad.filter.past`; the filter badge counts it). Each
  control's change keeps the other's parameter (`replace`).

### Weeks with a warning

Under the teams table an h3 "Weeks with a warning", one dimmed sentence and the table "Weeks with a warning, by team" (a `ScrollRegion`, min width 720, max height 420, sticky header): one row
per team and week, in the document's order (team by team, oldest week first) - Team (the same `teams.openAria` link as the teams table; tests and e2e scope by table), Week, Load, Capacity, In
progress (peak) and Status. The weeks are the document's `warningWeeks` (the team page's own `WeekLoad`, no `flowCapacity`), shown as they arrive.

- **From this week on.** The section lists the weeks from the document's `currentWeekStart` on (the server's Monday in UTC; the page never reads the browser's clock; a week ON it stays; ISO
  dates compare as text in `matchesWeek`'s third argument) unless `past=true`, which lists every listed week with the sentence without a week (`teamLoad.weeks.intro`); the default sentence
  (`teamLoad.weeks.introFrom`) names the week with `weekLabel`.
- **The hidden count.** A dimmed line, `teamLoad.weeks.earlier`, counts what the date hides (`earlierWeekCount`: the listed weeks of the rows the Show filter keeps that its warning keeps and
  the date hides) and shows whether or not the section does, so a team with "3 weeks overloaded" and no week below is never a riddle; it is absent with `past=true`, when nothing is hidden and
  while there is no answer.
- The date only HIDES listed weeks: the teams table's three counts, the facts line and Home's two team figures still count every week (as the team page's badges do), so no figure moves with
  the switch, and it makes no second read.
- The "Show" filter keeps the teams the table above keeps AND narrows their weeks (`matchesWeek`: `overloaded` the overloaded weeks, `wip` the weeks over the limit, `any` or none every
  listed week), from the same one read.
- The section is ABSENT when no week is left (zero is no claim, and no sentence says "no warnings"), while the first read runs and after a failed first read; a failed re-read keeps the kept
  document's weeks under the alert. The weeks without capacity stay a count.
- `warningWeeksTruncated` shows one dimmed line, `teamLoad.weeks.truncated` (N = the weeks the document lists, from this week on first), under the section or alone when it is absent, so a
  short or missing list is never read as "none".

### Tests

The page's co-located tests (`TeamLoad.test.tsx` also pins the date, the line, the switch, a pinned far-off browser clock; the `teamLoad*` `api/` and `utils/` tests; fixtures `test/teamLoad.ts`).

## Baselines

Files: `pages/Baselines.tsx`; `pages/BaselineCompare.tsx`; `hooks/useBaselines.ts`; `components/BaselineEditorModal.tsx`; `components/BaselineCompareControls.tsx`; `utils/baselineMovement.ts` (`movementTotalsParts`,
`movementSentence`, `movementStatus`); `utils/baselineOverlay.ts`; `utils/baselineCompare.ts` (`rankSentence`); `hooks/useBaselinePick.ts`; `components/BaselinePicker.tsx`; `components/BaselineMovement.tsx`;
`components/BaselineTotals.tsx`; 1.26: `components/BaselineLinksSection.tsx`, `components/BaselineCapacitySection.tsx`, `components/TeamBaselineCapacity.tsx`.

### The registry

`/baselines` (nav: Planning after Team load, `IconCamera`, **everyone**) is the registry of the named, frozen copies of the plan, `GET /baselines` under `["baselines","list"]` through
`hooks/useBaselines.ts` (`{items, can, loading, failed, error}`, `staleTime` 1 minute, the `useHolidays.ts` shape - the timelines' picker reads the same cache).

- The list is a BOUNDED set (cap 100, newest first): ONE unpaged table in a `ScrollRegion` (no `RegistryListTable`: it carries a pager):
  Name (the link into the comparison, `baselines.openAria`), Description, Taken (`YYYY-MM-DD HH:mm`, read in UTC, the header says so), Plan revision, Taken by, Milestones, Projects, Links, Capacity periods
  (1.26: `dependencyCount`/`capacityPeriodCount`; null = "not captured", a baseline from before 1.26: unknown, never 0).
- **What a row offers comes from the list's `can.manage`** (ADMIN or a `ROADMAP_EDITOR`, the server's arithmetic - never the session's roles): "Take baseline" and the row menu (Rename...,
  Delete) exist only with it.
- `BaselineEditorModal` is take (name + description) and rename in one. The take's 409 is told apart by `isBaselineLimit` (problem type `urn:astrolabe:problem:baseline-limit`): the cap is the dialog's
  alert "The limit of 100 baselines is reached: delete one first", any other 409 is a name clash marking the name field. At 100 rows the page says the cap is reached instead of counting.
- **Every write bumps the plan revision**: a take, rename or delete refreshes `["baselines"]` AND `["plan"]` + `["roadmap"]`; a delete of one already deleted elsewhere (404) says so and reloads the list.

### The comparison

`/baselines/:id` renders `GET /views/baseline/{id}` under `["baselines","view",id,{against}]` (read, never recomputed - the server counts working days on the CURRENT calendar). A malformed or
unknown id is the not-found alert (`EditPageLoadState`, under the page's h2); a malformed one never asks the server.

- The facts line: taken, by whom, the plan revision, the counts; "The plan has not changed since this baseline." when the view's `revision` equals the baseline's `planRevision` AND no captured team's capacity differs (a capacity write bumps no revision; else `samePlanCapacity`).
- The **totals** of milestones and of projects as badges (`movementTotalsParts`: an ORANGE "N end later", gray for the rest, "No schedule changes" at zero).
- The **Changes** table is ONE plain table in a `ScrollRegion` (`maxHeight` 70vh, <= 1,000 rows, no virtualisation) grouped by project: the project row (name = link into `/projects/:id`,
  program > work stream, the span movement as a sentence and its milestones' counts, the two spans, Start/End in signed working days, Status) then its CHANGED milestone rows (team, baseline
  and current dates, "Unscheduled" or a dash, the deltas, the estimate "10 -> 12.5", Status).
- **The Status badge** is `movementStatus`: ORANGE "Later" exactly when a moved row's END is later, gray "Earlier" / "Moved" / "New" / "Removed" / "Scheduled" / "Unscheduled" / "Unchanged", and
  gray "Re-estimated" for an estimate-only change (listed by the server though its kind is `UNCHANGED`).
- Client-side, unpersisted filters (`utils/baselineCompare.ts`, pure): a team `Select` (the listed rows' teams; keeps the projects with a row of it), a project-name text filter (case- and
  accent-insensitive) and "Changed projects only" (on by default; a project stays when it changed, its counts show a change, or it has a listed row).
- The timelines' picker, shadow bars and Movement section reuse `movementSentence`, `movementStatus` and `movementTotalsParts`; each project row has "Show on timeline" and the header "Show on the
  roadmap" - both set the browser-wide pick before navigating.

### The frozen links and capacity

Two h3 sections after Changes, read as they arrive: `BaselineLinksSection` (`links`) and `BaselineCapacitySection` (`capacity`), each `{…, sides}` (null against the live plan; else the Then/Now headers name both baselines).

- **Links:** gray totals badges (added / removed / changed / unchanged - information, never orange), ONLY the changed links in a table (Change badge; both ends as "Milestone · Project" or "Project X"; Baseline / Current terms "type · lag", "-" for the missing side), a `truncated` note.
- **Capacity:** the badge "Teams with changed capacity: N of M", ONE table with a rowgroup per changed team (From, To or "no end", Baseline / Current "20 MD/week · WIP 3", null = "No capacity"), a `truncated` note.
- **`captured: false`** (the baseline, or with `against` either, predates 1.26) is ONE dimmed note per section (own wording for `against`), no totals, no table, never "no changes".

### Compare against

`components/BaselineCompareControls.tsx` is the "Compare against" `Select` (the live plan, the default, or any OTHER baseline newest first with its plan revision). The URL's `?against=N` is
the state, so a comparison is a link; a malformed or own id is ignored, the typed 400 `unknown-baseline` drops the parameter with an inline note.

- This baseline stays "then"; the facts line and the Then/Now headers name both sides, a project row gains the rank sentence ("Rank 3 → 5", `rankSentence`, none for a new or gone project) and
  both "Show on ..." buttons are hidden (the overlay is one baseline against the live plan).
- A newly picked "now" that fails with anything but the typed 400 keeps the chrome and the picker mounted with the error inline (so another can be picked); a failure with no `against` is the
  load-error page.

### The baseline pick on the timeline pages

The ONE browser-remembered pick (`hooks/useBaselinePick.ts`, key `timeline.baseline`, none by default) selects the baseline all four timeline pages compare with (`BaselinePicker` in the
Timeline's `toolbar` slot, `?baseline=N` on the view getters, the pick in every query key). The project and team pages add the Movement section (`BaselineMovement`), the plan pages one totals
line (`BaselineTotals`); query keys, write rules, tone, rows: `timeline.md` "The baseline overlay".

### Tests

The co-located `Baseline*.test.tsx` (the frozen sections: `BaselineCompare.frozen.test.tsx`), `useBaselines.test.tsx` and the `baseline*` `utils/` tests.

## Schedule proposals

Files: `pages/ScheduleProposals.tsx`; `utils/scheduleProposalLinks.ts`; `api/scheduleProposals.ts` (`listProposalTeams`, `proposeCrossTeamSchedule`, `acceptCrossTeamSchedule`,
`checkSchedule`); `hooks/useCrossTeamProposal.ts`; `components/CrossTeamFacts.tsx`; `components/CrossTeamProposalSection.tsx`; `components/CrossTeamRunView.tsx`; saved (1.26): `pages/SavedScheduleProposal.tsx`,
`api/savedProposals.ts`, `utils/savedProposal.ts`, `components/Saved{ProposalsTable,ProposalState}.tsx`, `components/SaveProposalModal.tsx`, `hooks/useStatusAnnouncer.ts`.

### Route and data

`/schedule-proposals` (nav: Planning after Baselines, `IconCalendarStats`, **everyone**) runs ONE proposal over several teams (`POST /schedule-proposals`: the teams in dependency order to a
fixed point, `scheduling.md` "The cross-team run") and accepts the ticked moves of every team in ONE plan write.

**What it offers comes from the server.** The `MultiSelect` (`maxValues` 50, searchable, disabled while a run is requested or open, picks the server no longer lists are dropped at Propose) is
filled from `GET /schedule-proposals/teams` under `["schedule-proposals","teams"]`.

- An ADMIN gets every active team, anyone else the teams the caller manages; an ADMIN also gets an **"All teams"** button beside the select that ticks the first 50 listed at once (the run's
  `teamIds` ceiling), disabled while a run is requested or open.
- An empty list is the `EmptyState` "You manage no team" with no multi-select and no Propose; an administrator with no team at all reads "No team to propose for yet" (the words only:
  `useAdmin()` gates nothing).
- The server's 403/404/400 on the run reach the page inline (`scheduleProposals.forbidden/gone/invalid`, then the generic action words).

### The run

Page state in `hooks/useCrossTeamProposal.ts`, the team page's `useScheduleProposal` state machine over a run.

- `propose(teamIds)` (local `asOf`; a run with no move in ANY team opens nothing and leaves the same two notes as the team page), ONE `selected` set over every team's move ids (milestone ids are
  global), `toggle`, `selectAll(teamId)` / `selectNone(teamId)` (a section's header checkbox acts on THAT team's moves; the status region says the run-wide "n of N selected"), `discard()` (not
  while the accept runs), `dismiss()`.
- `accept()` posts `{expectedRevision, scopeHash, teamIds (the run's blocks), items}` for the ticked moves of all sections on the write key `["schedule-proposals","accept"]`. It sets a
  synchronous in-flight ref (cleared in `onSettled`), so a double click sends ONE request; while it runs a second accept or Propose is refused out loud (`refused`, the `role="note"` "A save is
  still running", `project.busy` announced; Discard answers `false`).
- On success the preview closes, `["plan"]` and `["roadmap"]` refresh in the background (no cache patch: the page holds no view) and `outcome` is the inline note ("N scheduled · M skipped:
  reasons", the fixed `teams.proposal.reason.*` vocabulary; no toast).
- `409 stale-revision` closes the run with the reload note; **`409 stale-scope`** closes it, re-proposes the SAME teams at once and keeps the ticks of the moves that still exist (`rescoped`,
  orange note); any other failure is the inline `FormErrorAlert` above the buttons, which takes the focus, with the run open.
- The page owns the ONE polite status region (`VisuallyHidden role="status"`, the zero-width-space re-read flip) the hook announces into; `useProposalFocus` (structural, `{applying, rescoped}`)
  hands Discard the focus when a run opens and Propose gets it back. A run that did not settle is announced in the SAME sentence as the ready one (two announcements in one batch keep only the
  last).
- The hook returns `words` (`ProposalWords`, an optional override of `ProposalFlow`): the no-capacity, stale and re-proposed notes and their announcements speak of "the chosen teams"
  (`scheduleProposals.noCapacity/stale/rescoped`), not of one team or a schedule to reload.

### The page

A `Stack`, h2 `PageHeader` with Propose in `actions`: the multi-select, `ProposalNotes` (its prop is the structural `ProposalFlow`), then with a run open:

- `CrossTeamFacts` (`role="note"`): gray "Placed in N pass(es) · settled"; an ORANGE Alert when `!settled` (`scheduleProposals.facts.unsettled_*`: the teams depend on each other in a loop, so every
  pass moved something again; the dates shown are the last pass's).
- One `CrossTeamProposalSection` per block of `teams[]` in PLACEMENT order: an h3 (the team's name, a dimmed "placed n of N") holding the team page's `ProposalTable` (named per team through
  its `label` prop, so no two tables share a name; "Accept all" in its header acts on that team) and, collapsed, `TeamWeeklyLoad` with `labels` (an h4 "Proposed load", the table named per
  team). With no move ticked anywhere there are no `weeks` and the section says "Tick a move to see the load after accepting it".
- The accept's alert and ONE **Accept selected across teams (N)** (primary) with Discard.

**The ticked-subset check is `useScheduleCheck`** with ALL the run's team ids and every team's moves; `overlayCheck(block, check, block.teamId)` gives each section the verdicts and load of the
ticked moves (all ticked = the run's own, none = no new warnings, some = the check's answer once in), and `ProposalTable` words "Checking the ticked moves..." / the failure under each summary.
Closing the run drops the `["plan","schedule-check"]` queries.

The accept/discard/outcome words reuse `teams.proposal.*`.

### Saved proposals

A saved run is the SERVER's own re-computation (`scheduling.md` "Saved proposals"): no document is sent, none recomputed. Keys: `SAVED_PROPOSALS_KEY` `["schedule-proposals","saved"]`; an accept, a stale refusal and a delete refresh it, a delete or a 404 drops the record's copy.

- **Save proposal** (beside Accept, one move ticked): `SaveProposalModal` posts the name, the run's `asOf`, teams, `revision`, `scopeHash` and the ticks. A `409` is inline (focus on **Propose again**) = hook `proposeAgain(teamIds, ticks, rescoped?)`: same teams, ticks kept. `open(run, ticks)` takes a stored run, no request.
- **Saved proposals** h3 (`SavedProposalsTable`, every user): the newest 20, the name links, Delete by the row's `can.delete` (`useDeleteConfirm`).
- **`/schedule-proposals/saved/:id`**: h2 the name, a state badge (`data-state`; green CURRENT, else gray), the facts, `CrossTeamRunView`. While CURRENT, `can.accept` AND `asOf` = today (the server ignores the day) the stored run opens as the hook's preview: ticks editable, the ONE accept, the stored `check` for the stored ticks, the live one for any other. Else read-only (an earlier day says so; a refetch that turns it CHANGED ends the preview).
- **Propose again** (by `can.delete`) opens a FRESH run (`sameRun`), a neutral note (the "plan changed" one only when CHANGED) and Discard back to the saved one; a stale-scope accept lands there too. `UNREADABLE` shows no run.

### Tests

Co-located: `ScheduleProposals*.test.tsx`, `Saved*.test.tsx`, `SaveProposalModal.test.tsx`, `CrossTeamProposalSection.test.tsx`, `useCrossTeamProposal.test.tsx` (fixtures `test/crossTeamRun.ts`).

## Deviations, bindings and the Jira chips

Files: `pages/Deviations.tsx`; `api/deviations.ts`; `hooks/useDeviations.ts`; `hooks/useAcknowledge.ts`; `hooks/useAckFocus.ts`; `utils/deviationFilters.ts`; `utils/deviations.ts`;
`utils/staleness.ts`; `utils/syncRuns.ts`; `utils/queryRefresh.ts`; `components/DeviationsFilters.tsx`; `components/DeviationsSources.tsx`; `components/DeviationsTable.tsx`;
`components/DeviationAckCell.tsx`; `components/SeverityBadge.tsx`. The bind dialog, the bindings list, the import modal, the chips and the Capacity from Flow section have their own files,
named in their sections.

### Route and data

`/deviations` (nav: Planning after Schedule proposals, `IconGitCompare`, **everyone**) is where the plan and the linked Jira items disagree: `GET /views/deviations` under
`["jira","deviations","view",filter]` through `hooks/useDeviations.ts` - ONE purpose-built document (`{revision, asOf, connections[], totals, items[≤2,000], truncated}`), unpaged,
`api/deviations.ts`.

- **Reading never touches a timeline view**: every query here lives under the `["jira"]` prefix (the page's second section, Capacity from Flow, under `["flow"]`). A refresh (Refresh now,
  a connection edit) refreshes `["jira"]` only.
- A write that changes the Jira flags and bars the four timeline views carry - a bind, an unlink, the import's apply, an acknowledgement - goes through `refreshJiraAndTimelines`
  (`utils/queryRefresh.ts`: `["jira"]`, `["plan"]` = plan, project and team views, `["roadmap"]` = roadmap and programs). A scheduled poll has no write here; open pages catch up on focus.
- It refetches on window focus and, while the SERVER says a run is running (`connections[].lastRun.running`), every 10 s (`DEVIATIONS_POLL_MS`; the run table's 3 s is too eager for this big
  document) through `useBoundedPoll`: the response that first reports the run finished carries the new data.

### Filters

**The URL holds the filters** (`parseDeviationFilter`/`deviationFilterParams`, pure): `connectionId`, `level`, `severity`, `kind`, `workStreamId`, `programId`, `projectId`, `teamId`,
`acknowledged`, `all`. A malformed or unknown value is dropped (a stale link never breaks the page), a change `replace`s the entry, the chips link in with a normal navigation, so Back and a
reload restore the view.

- The panel (`DeviationsFilters`) holds a select each for **Status** (Open / Acknowledged / All, first), connection, plan item type, severity, work stream (from `GET /views/plan`, the
  page's cache entry) and team (`useTeamOptions`, every team; no "Team N" option), plus the **"Show everything"** switch (`all=true`: items with no deviation AND the
  `ESTIMATE_NOT_COMPARABLE` lines, which are never listed otherwise nor counted by a chip).
- A project or team scope IMPLIES `all` server-side, so the switch reads ON there and turning it off sends `all=false`, which the URL accepts. A project / program / kind scope from the URL
  is a removable chip beside the toggle ("Project: Invoices"), named from the plan view.
- **Status** (`deviationStatus`/`deviationStatusPatch`) composes with the URL as the server does: Open sends NOTHING (the server lists the open items), except under a project/team scope,
  which implies `all`, where it sends the override `all=false` (so does ADDING a scope while Open, `keepStatus`; REMOVING the last scope falls back to the default Open list; `acknowledged=false`
  in a URL is dropped). Acknowledged sends `acknowledged=true` (and keeps an explicit `all=true`); All sends `all=true`; a scope reads All. The "Show everything" switch writes the same `all`, so
  All and the switch are two views of one parameter.

### The table and its sentences

The table is `DeviationsTable` in a `ScrollRegion` (1,080 px minimum: a phone scrolls it): the plan item with its link into `/projects/:id` (a milestone's through its project), the Jira key
through `JiraKeyLink`, both sides' dates, the sentences, the age. `utils/deviations.ts` (pure, EN/PL with `_one/_few/_many/_other`) holds the sentences: `deviationSentence(deviation, item, t)`
covers every `DeviationKind` ("Ends 3 working days later than Jira (plan 2044-01-12, Jira 2044-01-08)").

- **`detail.days` is in working days, POSITIVE = the plan is later** (a negative figure reads "earlier").
- **A `detail` member that does not apply is ABSENT, never `null`**, so every check is `=== undefined` (a `=== null` compiles against the generated types and is silently always false). A
  flag's `deviation` is `{kind, detail}` without a severity, `deviationSentence` takes `Pick<Deviation, "kind" | "detail">`, and the flags' optional members (`days`, `teamId`,
  `otherProjectId`, `deviation`, `count`) follow the same rule (`utils/flagSentences.ts`, `utils/jiraBars.ts`).
- The dates are appended only when BOTH sides are known (a date is never made up from an absent one); a missing or zero figure degrades to "ends on a different day"; `TARGET_DIFFERS` (days
  is the end's shift, else the start's) is a neutral sentence with no count (the dates column carries the figures); `ESTIMATE_NOT_COMPARABLE` (no conversion declared, OR the figure was read
  under another unit than the mapping names now) names neither cause.
- **Coverage kinds.** `UNLINKED_IN_JIRA` (`detail.jira` = the keys, e.g. "3 Jira items are not in the plan: COV-5, COV-6, COV-7"), `UNLINKED_IN_PLAN` (`detail.plan` = the names),
  `CHILDREN_DONE` (`detail.count` = the children, `detail.plan` = the plan's end) and its mirror `CHILDREN_OPEN` ("3 of 12 child issues still open in Jira while the plan ended
  2046-03-01": the open figure is parsed from `detail.jira` = `open/children`; unreadable members degrade to the label "Children open").
- **The "+N more" rule**: the server lists at most 10 keys/names and `detail.count` is the full figure, so the sentence appends "and {N} more" when `count` exceeds 10 - the listed figure
  is `min(count, 10)`, never a split of the joined text (a plan name may contain ", "). A missing list, count or date degrades to the plain kind label. The roadmap panel phrases these
  through the same function.
- Severity is spelled in a visually hidden word before each kind badge (`SeverityBadge`: orange warning / gray info; the Deviations table, the Flow capacity lines and the team page's fact use
  it, the roadmap flag panel with `hiddenPrefix={false}`). `ageText` is in the same file.

### Acknowledge

Per LINE (`hooks/useAcknowledge.ts`; `DeviationAckCell` = a line's sentence and button, `DeviationAckAll` = the batch buttons at the head of a row's lines, `DeviationAckOrphanNotice`;
`POST`/`DELETE /integrations/jira/bindings/{id}/acknowledge`).

- **There is no Acknowledgement column.** The Deviations cell lists every LISTED line of the row (`items[].deviations[]`, whatever the Status - a row on the Open list shows its acknowledged
  lines too), each as the kind badge (gray once acknowledged, `SeverityBadge dimmed`) and the sentence, and under it the line's own acknowledgement
  (`DeviationLine.acknowledgement{at, by, current}`; the item has no `acknowledgement` of its own): "Acknowledged by X on D", or "Acknowledged on D by X · changed since" when the stamp's line
  changed (`current: false`, the line is open again); a deleted acknowledger drops the name.
- ONE button per line (`isLineOpen`, `utils/deviations.ts`): **Acknowledge** for an open line (no stamp or a stale one), **Unacknowledge** for a current one - both only with the item's
  `can.acknowledge` (a pure RIGHTS flag; a clean row has no lines, so no button). A line is `POST {fingerprint: item.fingerprint, kind}` / `DELETE …?kind=KIND`.
- The buttons name the line by Jira key and kind ("Acknowledge E2E-6: End"), carry `data-ack-for="<bindingId>:<KIND>"`, are `aria-disabled` + `data-disabled` (Mantine's disabled look; never `disabled`/`loading`: they lose the focus) and ignore clicks while ANY write runs.
- **Acknowledge all (N)** / **Withdraw all (N)** (named "Acknowledge all (N) open deviations of E2E-6" / "Withdraw all (N) acknowledged deviations of E2E-6") head the lines when at least two
  LISTED lines are open (a stale stamp counts) / currently acknowledged. The batch is the same two calls WITHOUT `kind` (`POST {fingerprint}` stamps every line without a current
  acknowledgement; `DELETE` clears every stored stamp of the binding, stale ones too), both with the key `<bindingId>:all` (`data-ack-for`, busy, notice) and a single line's toast, re-read, 409
  note, refusals and focus rule. N counts the lines the row lists: a hidden `ESTIMATE_NOT_COMPARABLE` line (shown under `all=true` only) is not in it, though the kind-less POST would stamp it.
- **A success re-reads `["jira"]`, `["plan"]` and `["roadmap"]`** (a current acknowledgement silences the Jira flags on all four timeline views). A `409 stale-deviations` is the orange inline
  `role="status"` note "The deviations changed since you looked" plus the same re-read, never a toast and never the red alert; a 403/404 is a red inline message and re-reads `["jira"]`; a
  DELETE's 404 reads "already withdrawn", not "link gone".
- The note or message shows under its OWN control (`AckNoticeAlert`; a row far down must see why its button did nothing), above the table with a scroll-into-view only once that control has
  left the list (`DeviationAckOrphanNotice` over the keys of the rendered rows, `itemAckKeys`). Messages clear on the next write or whenever the filters' URL string changes, and a write that
  settles after that sets none.
- **Focus** (`hooks/useAckFocus.ts`, shared with `useCapacityAcknowledge`: the hook arms the keys, the page-level hooks own the writes): after a write that re-reads, `useDeleteConfirm`'s rule at
  every render and once after the re-read - focus on `body` -> the control's own button if still there (a line's Acknowledge becomes its Unacknowledge under the same key, the two batch buttons
  share the all-key), else the row's other controls, the next row's, the previous row's, else the list's h3 `tabIndex={-1}`; anywhere else -> leave.

### Honesty about currency

The page never implies the data is fresh (the chips on the project and team pages show the LAST OBSERVATION and qualify it: "The chips and marks").

- "Data from Jira" (`DeviationsSources`, h3) is one row per connection with its newest run as the helpers read it (`utils/syncRuns.ts` `runState`: the server's `running`, `finishedAt: null`
  and not running = **Interrupted**). The column is "Last run", not "last refresh" (a failed run is a run). The notes that qualify the figures: never refreshed ("as they were when each item
  was linked"), the last refresh FAILED (with `errorCodeText`, the code kept visible), abandoned/interrupted, **stale** ("The last successful refresh is older than expected", Flow's sentence
  under the shared key `deviations.sources.noteStale`), the connection DISABLED (its items are listed and unlinkable but stale), and **`mappingOk: false`** ("levels and estimates are not
  compared for its items").
- An orange `role="note"` above the list says it may be out of date when any ENABLED connection is not `CURRENT` (the SERVER's derived `status.state`: never synced, failed, `STALE`; a first
  run or a retry after a failure still in flight keeps the old state, a routine refresh on a good connection does not raise it) or its mapping does not fit.
- That is ONE rule, `isStaleSource({state, mappingOk?})` in `utils/staleness.ts`, read by the banner and the dated claim (`staleConnection`/`hasStaleSource`/`verifiedAt`,
  `utils/deviations.ts`, which add `!enabled`), by Flow's twins in `utils/capacityDeviations.ts` (no mapping to pass) and by the chips (`marksOf`); the any-enabled-stale and oldest-success folds
  are the generic `hasStaleSource`/`verifiedAt`, each connector passing its own stale predicate and success accessor. Nothing is judged on the client's clock.
- **Refresh now is ADMIN-only** (per connection, `POST /integrations/sync/runs`). A `409 run-in-progress` is a normal state: no error and no note of its own, the page re-reads and its status
  line says a refresh is running. A `429` of the per-user `sync-run` bucket reads `common.error.tooManyRequests` in the inline alert, here and on the connection pages.
- **"Data as of"** is `jira.observedAt` aged (the exact UTC time in its `title`): when Astrolabe last CAPTURED that item (the bind, or a run in which Jira reported it changed), NOT when it was
  linked and not when a run last looked, so it can be older than the connection's last run; a gone item or a disabled connection adds "stale" (the READING is frozen: a rule of its own). The age is the browser's clock against the
  server's `observedAt`: the skew is accepted.
- **A gone item's Jira cell badge** reads "Gone from Jira"; "Moved out of scope" when its GONE line's `detail.jira` is `MOVED_OUT` (a probe still read the issue, under a key outside the
  connection's projects; `deviations.phrase.goneMovedOut`); "Not listed by Jira" for `NOT_LISTED` (the key it answered with is inside them; `deviations.phrase.goneNotListed`). `goneBadge(reason)`
  in `utils/deviations.ts` maps a reason to `movedOut | notListed | gone`; the key link shows the binding's current (followed) key.

### Totals and empty states

- **Counting words.** The totals badges are the server's `warnings`/`infos` over every match before the cap (orange / gray, the roadmap flag vocabulary; red is never used) and a gray "N
  acknowledged" (`totals.acknowledged`: bindings with a current line). "N items shown" is `items.length`; `truncated` is an orange note. Under any Status but Open a line says the
  warning/info/gone figures count open items only (the server counts open LINES); an Open list that is empty while acknowledged items exist reads "Nothing is open" with the count hidden.
- **The gone figure is split**: "N gone from Jira" shows `totals.gone - totals.stillInJira` and a second gray "N still in Jira, out of scope" shows `totals.stillInJira`
  (`deviations.totals.stillInJira_*`), each hidden at 0. `totals.bindings` is never worded as "how many are linked": it counts only deviating bindings unless `all` applies.
- **The empty list is told apart**: no connection (an ADMIN gets the link to Administration, Jira; anyone else is told an administrator has to add one), nothing linked (asked by
  `GET /integrations/jira/bindings?pageSize=1` `total`, only when it decides the wording), the filters match nothing (+ "Clear the filters").
- An empty list is a claim about a READ and is DATED ("No deviations in the data read at 2026-11-06 10:01 (UTC)"; `verifiedAt`: the oldest finish among the connections), withheld under the
  staleness predicate above and when the newest run did not SUCCEED (a routine refresh in flight included) - a disabled connection may hold bindings nobody refreshes - else "No deviations in
  the data read so far".
- A project or team scope whose own `totals.bindings` is 0 (with `all` in force, that is every link in scope) reads "Nothing here is linked", never "no items match". While a new filter's
  answer is on its way (`isPlaceholderData`) the kept answer belongs to the OLD filters, so a busy status stands in for any empty-state claim.

### The bind dialog

`components/JiraBindDialog.tsx`, `JiraBindNodePicker.tsx` (used on the connection page and the project page): `POST /integrations/jira/bindings`. It works for a plan OWNER who is no
administrator, for whom the connection registry is forbidden, so it asks for nothing itself: the `source` prop is what the page has.

- The connection page's own connection (fixed; `mappingOk` is taken as true there, a stale mapping is the server's inline 409), or the project page's `useJiraLinks` `connections[]` (asked
  only while the dialog is open: a pending or failed answer is the dialog's own note, with Retry; `useJiraLinks(projectId, enabled)` in `hooks/useDeviations.ts`, `GET /views/deviations?projectId=`, is used only for this).
- Only `enabled` connections are offered, exactly one is preselected (with two or more and none chosen, a note says why Link is disabled), one with `mappingOk: false` is marked "(mapping
  needs fixing)" and refuses the link in words, none says so plainly (an ADMIN gets the link to Jira, anyone else is told an administrator has to add one).
- `target` fixes the node (project header, milestone row menu: no picker); `connectionId` fixes the connection (the connection page). Otherwise a level select and a picker: programs, projects
  and milestones through paged name searches (`ProgramSelect` over `GET /programs`; `ProjectSelect`/`MilestoneSelect`, the dependency editor's, take `label`/`description`), all open lists, so a node the viewer may not link
  is offered and the bind's 403 shows inline.
- **Every refusal is inline with the entered key kept** (`utils/jiraBind.ts` `bindFailure`): 400 (the server's sentence under a fixed lead: unknown issue, outside the connection's keys,
  wrong level), 409 `already-bound` (the sentence names the other side), 409 `jira-mapping-invalid` / `jira-not-discovered` / `jira-token-unreadable` (an administrator's to fix), 429 (the
  per-user `jira-bind` bucket), 502 (Jira's code in words), 403, 404. Success is the toast "Linked to Jira" + `refreshJiraAndTimelines`.
- **`can.edit` is the bind's guard**: the owner chain or ADMIN (`PlanPermissions.canManage` = `requireOwnerOrAdmin`; a milestone's `can.edit` is its project's), so "Link to Jira…" shows with
  the node's own `can.edit` and a team manager who owns nothing sees none. A node the page's view says is linked is never offered the link (1:1).
- With `can.edit` the OWNER gets "Unlink from Jira" (the project header button, replacing Link; a milestone's red "Unlink from Jira: KEY" menu item) through `hooks/useJiraUnlink.ts` +
  `components/JiraUnlinkModal.tsx` (the delete-confirm pattern shared with the connection page's table: `DELETE /integrations/jira/bindings/{id}`, `refreshJiraAndTimelines`, focus to the page
  heading, 403/404 inline); without it the key shows as a disabled line. The header's Link/Unlink read the view's own `jira` blocks, so they are right from the first render. Program bindings
  are linked and unlinked on the connection page only.

### The bindings list

`components/JiraBindingsSection.tsx`, the connection page's third h3 section: `GET /integrations/jira/bindings?connectionId=` paged (sort `issueKey`/`createdAt`), a level filter and the `q`
name filter.

- A gone mark ("Gone from Jira", "Moved out of scope" from `observation.goneReason === "MOVED_OUT"`, or "Not listed by Jira" from `NOT_LISTED`, through `goneBadge`; the key shown is the
  binding's current one).
- **Unlink** through `useDeleteConfirm` + `ConfirmDeleteModal` (`confirmLabel`; focus returns to the section's h3) and "Link a node…" (disabled while the connection is disabled). The server
  hides bindings of deleted plan items, so a row is not always there and the list may differ from a connection delete's count by those.
- **"Import from Jira…" on a program or project row**: an inline `Button` (`variant="subtle"`, `size="compact-sm"`, aria `jira.import.entryRootAria` = "Import from Jira what is listed under
  {name}": it never contains the section button's "Import from Jira…", so a substring match finds one) before "Unlink"; shown only while the section's `canImport` holds (enabled, stored
  discovery) AND the plan view knows the node.
- The plan view is read under the Plan page's own key `["plan","view"]` (`getPlanView`), enabled only while the list shows a program or project row and `canImport`, and a failed read just
  leaves the buttons out. The root is `rootOfBinding(plan, row, connection.id)` (`utils/jiraImportRoot.ts`: `findProgram`/`findProject` for the work stream and the owner the binding's node
  lacks, then `rootOf` with the row's `issueKey` and `observation.gone`; null for a milestone row, an unread view or a node the plan no longer holds). A second `JiraImportModal` is mounted for
  it (`key` = `<level>:<nodeId>`, `source` = this connection only, `useDialogFocus` covers it); the section's whole-scope modal is unchanged.

### The import modal

`components/JiraImportModal.tsx`: ONE wide `Modal` (title = the h2, phases are h3) in three phases; state in `hooks/useJiraImport.ts`, the pure model in `utils/jiraImport.ts` (ticks, scope,
body), sentences in `utils/jiraImportText.ts`.

- **Scope** (`JiraImportScopeStep`): work stream from `["plan","view"]`, owner, Jira project keys all preselected, the import filter, "Copy Jira's dates", default team / program / project
  (the last two offered only from the picked stream, the server's own rule) -> `POST …/import-preview`.
- **Preview** (`JiraImportPreviewStep`): totals, notes, "N of M selected", a virtualised table (`JiraImportVirtualTable`, TanStack Virtual above 80 rows, fixed row height,
  `aria-rowcount`/`aria-rowindex`, shared with the outcome's skipped list), a checkbox per CREATE/BIND row, SKIP rows say why in words -> `POST …/import`. `totals.truncated` disables Import.
- **Outcome**: counts created / linked / scheduled / skipped, every skipped row with its reason, "Preview again" when rows read `CHANGED`.
- **Rows** are one fixed 88 px (`IMPORT_ROW_HEIGHT`; clamped text keeps its full text in the DOM and a `title`); no Level column (the cell under the key reads "Epic → milestone"); the
  Skipped badge is orange only when some skip is not `ALREADY_BOUND`; a non-admin's redacted SKIP row renders the key, never a blank cell.
- A created PROJECT row's dates cell reads "Target window a to b" (the window the server will write; the same `copyDates` switch), and its info `TARGET_NOT_COPIED` says "created without a
  target window" when Jira gives one date or a reversed pair. The "N of M milestones created unscheduled" note counts ticked rows the SERVER marked `DATES_NOT_COPIED`.
- **Ticks keep the dependencies true**: unticking a row unticks what is created under it (`dependsOn` = `parent.rowJiraId`; the server would answer `PARENT_SKIPPED`), the rows show "Not
  imported: its parent X is not ticked" and a polite status says how many moved; ticking a row ticks the rows it lands under.
- **The body is strict**: `expected.parent` is projected to `{kind, nodeId}` (never the preview's `parent` verbatim), a BIND carries `nodeId`, a milestone CREATE the `teamId` the row showed;
  a per-row team `NativeSelect` goes to `overrides.teamId` and never into `expected`. A program or project row that would be CREATED has a compact owner picker (`PersonSelect compact`, aria
  "Owner for KEY", opened on the dialog's owner; clearing it goes back to the dialog's owner), whose pick goes to `overrides.ownerPersonId` only when it differs from the scope's owner
  (`toApplyRequest`'s fifth parameter, `hasOwnerChoice`); the picks are page state of the preview step and reset with a new preview. The apply sends the SCOPE the preview was read under.

### Time, failures and the refresh after an apply

- Each call owns an `AbortController` that aborts at `IMPORT_TIMEOUT_MS` (180 s, over the server's 170 s browse); the visible wait has a Stop for a preview, one request at a time.
- An apply is never aborted by the client: the dialog cannot be closed over it, and leaving the page does not cancel it either (only an unmount mid-PREVIEW aborts) - it finishes and still
  refreshes the plan. An answer that leaves the write in doubt (the 180 s abort, no server answer, a 5xx other than the server's own 502: `applyMayHaveLanded`) says so, points at the "Links to
  plan items" list, offers Preview again and refreshes anyway.
- The rate-bucket 429 (`jira-import`, 5/min, shared by preview and apply) carries `Retry-After` (declared on the spec's `TooManyRequests`) but `ApiError` exposes no headers and the transport
  reads none: the message says to wait a minute. Other failures are inline (`importFailure`); a 409 in the apply offers "Preview again".
- **After an apply the plan moves**, so it refreshes `["jira"]`, `["plan"]` (plan, project and team views) and `["roadmap"]` (roadmap and programs) - the one Jira mutation that does.

### The import filter

Right under the keys: a Switch "Leave out done items" (ON when the dialog opens) and a NumberInput "Updated within (days)" (365; `PollingFields`' idiom: `clampBehavior="none"`, bounds
`MIN/MAX_IMPORT_UPDATED_DAYS` 1..3,650 mirroring the server's, a value outside them shows the sentence under the field and disables Preview, `toScope` answers null; EMPTY = no time limit; 0
is refused). The Switch's description says what "done" means and that a done or older parent of an item that is read is read as well when it is in the selected Jira projects.

- `toScope` adds `filter{excludeDone, updatedWithinDays}` only when a control is on (`{excludeDone: true}` with the field empty; NO member with both off = a request without a filter); the
  apply spreads the preview's scope, so it sends the SAME filter.
- The preview step reads `preview.scope.filter` (the filter the rows were read under, never the form): one `role="note"` line `jira.import.preview.leftOut*` in three wordings (done / window / both;
  none without a filter, and no count - the server does not report one).
- The too-large alert names both causes and the filter as the lever; an empty preview under a filter says the filter may be why. A kept
  parent and a child whose parent could not be read show `KEPT_AS_PARENT` / `PARENT_UNREADABLE` among the row's notes (`infoText`).

### Suggested matches

Server side: `jira-sync.md` "Suggested matches". A CREATE row the server found a strict name match for carries `suggestion {nodeId, nodeName}`; the Action cell (`JiraImportRowMatch`) says it
looks like that plan item and offers a compact **Link instead** (aria "Link instead: KEY to NAME"). A BIND row with the info `MATCH_CONFIRMED` offers **Create instead** (aria "Create instead:
KEY as a new item").

- A click records a **pending change** (`MatchChange`, state in `hooks/useImportMatches.ts`, per preview: the step is keyed by `useJiraImport`'s `previewSeq`, a counter bumped whenever a
  preview is set - never by `asOf`, which two previews can share) and nothing else: the row reads "Will be linked ... / created as a new item after the next preview" with **Undo** (aria "Undo
  the change for KEY").
- A `role="note"` banner (`JiraImportMatchNote`; never an `Alert`, whose implicit `role="alert"` would interrupt) says N changes are waiting and carries **Preview again**, and **Import is
  disabled** until the preview is read again: the preview must stay the exact picture of what Import does. While the banner shows, the footer's own "Preview again" is not rendered, so the
  footer never doubles it (an apply failure's own "Preview again" can still coexist).
- "Preview again" re-runs the preview under the preview's scope with `matches = nextMatches(scope, items, pending)` (`utils/jiraImport.ts`: the scope's confirmed entries minus every row with a
  pending change plus the suggestion of each pending "link", each Jira id once; `withMatches` leaves the member out when the list is empty). The apply spreads the preview's scope, so it
  repeats `matches`, and the outcome step's "Preview again" (after `CHANGED`) re-reads under the same confirmed matches. **Back then a new Preview drops the confirmed matches**: the scope is
  rebuilt from the form, which holds none.
- Above the table a `role="note"` line counts the suggestions (under an active import filter it adds that the items the filter left out are not considered, because the matcher cannot see
  them) beside a Switch **Possible matches only** that narrows the shown rows to the ones offering a choice (a suggestion or a confirmed link); it composes with the search, leaves the ticks
  alone and, like the search, drives "Showing X of Y" and "Tick shown". Neither exists when the preview has no such row.
- The fixed 88 px row height holds because a match row spends at most one badge line and two text lines: the badge (min-width 0, an ellipsis, the full label in its `title`) and the
  `compact-xs` button (`flex: none`) share ONE line (`Group`, no wrap), the suggestion / pending sentence is one clamped line, and on such a row the "parent is not ticked" note is clamped to one
  line (other rows keep three), so a long Polish label cannot push the button out of the 250 px cell.
- **Work is carried across a match-driven "Preview again"** (`PreviewCarry`, `carriedTicks`, `carriedPicks` in `utils/jiraImport.ts`, held by the modal for the NEXT step only): each row still
  present with the SAME action keeps its tick state, team override and owner pick, keyed by Jira id; a row whose action changed and a row new in the preview start fresh (ticked, no override),
  and an unticked row also unticks what is created under it in the new plan. Any other preview starts afresh.
- While any call is reading (a match-driven preview can take up to 180 s) the per-row controls are disabled, because an edit made then would be lost when the next preview replaces the step. A
  failed "Preview again" leaves the step as it was: the pending changes stay, Import stays disabled, and the banner's button retries with the same `matches`.

### The preview search

A `ClearableTextInput` "Search the preview" above the table (page state, nothing stored, no API change) filters the rows by a trimmed, case- and accent-insensitive substring
(`foldDiacritics`, the rule of `foldedOptionsFilter`) over the Jira key, the Jira id, the summary and the plan name (`searchItems` in `utils/jiraImport.ts`); a blank query shows every row.

- A row with no Jira key (a non-admin's row redacted under an active filter: a `hidden-n` placeholder id, a blank name) NEVER matches a non-empty query.
- The search only HIDES rows: ticks and team overrides are untouched, "N of M selected" and **Import (n)** stay global, and the apply sends every ticked row.
- While a query is active an always-mounted `role="status"` line says "Showing X of Y", Select all / Select none become "Tick shown" / "Untick shown" and, with the header checkbox (its
  checked / indeterminate state too), act on the SHOWN selectable rows only through `tickShown` (`tickRow`'s parent/child rules per shown row: ticking also ticks what a shown row is created
  under, unticking also unticks what is created under it, shown or not; the live region says "Also ticked / unticked N items outside the search …", cleared when the search changes).
- No match: a `role="note"` "No rows match “…”." replaces the table, the box stays.

### The connection source and the entry points

**The modal is connection-source driven**, `JiraBindDialog`'s contract: props `{ source: ImportSource, initialWorkStreamId?, onClose }` (`utils/jiraImport.ts`: `ImportConnection` =
`{id, name, siteUrl, projectKeys}`, a `JiraConnection` is structurally one; `ImportSource` = `{connections | null, failed, retry}`). The connection page passes `{connections: [connection]}`; the Plan page
passes the deviations view's `connections[]` filtered to `enabled && mappingOk` (`usableImportConnections`).

- The scope step opens with `JiraImportConnectionField` (loading text / a failed alert with Retry / the "none usable" note / the Select, read-only when exactly one; reusing
  `jira.bind.connection|loading|loadFailed|retry`); the modal preselects exactly one, and changing the connection resets the Jira-project keys to the new one's.
  `useJiraImport(connectionId | null)` does nothing while null and Preview is disabled until a connection is chosen. The connection of the preview and outcome phases is kept even if a later refetch drops it.
- `initialWorkStreamId` presets the stream (`emptyScope(keys, workStreamId)`) and the stream Select is `readOnly`.
- **Entry points** (six): the connection page's button and its program and project rows ("The bindings list"), the work stream's menu, a linked program's menu, a linked project's row menu and
  a linked project's page header. The stream's (`PlanActions.importFromJira`, `PlanRowMenu`) is a `Menu.Item` "Import from Jira…" (aria "Import from Jira into {name}") under
  `can.edit`, after Close/Reopen. The connection page's button beside "Link a node…" is disabled until the connection is enabled and has a stored discovery.
- `hooks/usePlanJiraImport.ts` holds the Plan page's import state (`importing`: a stream, a program with its link OR a project with its link; `usePlanDialogs` calls
  `useDialogFocus(jiraImport.modal !== null)`) and reads the connections with `useJiraConnections({workStreamId}, importing is a stream)` (`hooks/useDeviations.ts`, key
  `["jira","deviations","connections",filter]`; `useJiraLinks` is its one-line project wrapper) - the request appears only after the click. Every mount site keys the modal by its source
  (`stream:<id>`, `program:<id>`, `project:<id>`), so its form state never carries over.

### The rooted import

"Import from a linked node" in `jira-sync.md`. The modal takes an optional `root: ImportRoot` (`utils/jiraImport.ts`:
`{level: PROGRAM|PROJECT, nodeId, name, issueKey, connectionId, workStreamId, owner: PickedOption}`).

- The stream is the root's; the connection is the root's own (`source.connections` filtered to `root.connectionId`; absent from the usable ones = a `role="note"` that an administrator has to
  enable and test it instead of the field, Preview disabled; a source that has not answered yet shows the loading text); the form opens with `owner = root.owner`.
- `toScope(form, keys, root)` adds `root {level, nodeId}` and NEVER `projectKeys` or `defaults.programId` (nor `defaults.projectId` under a project root); the apply spreads the preview's
  scope, so it repeats the root.
- The scope step replaces the intro by a `role="note"` first line naming the key and the node, hides the work stream, the Jira projects and the default program, shows the owner for a PROGRAM
  root only (a project root sends the project's owner) and turns "Default project" into "Project for items directly under KEY" (PROGRAM root only: the root program's own projects); the filter,
  "Copy Jira's dates" and the default team are as before. A rooted PROGRAM dialog's owner hint says only projects are created (`ownerHintRoot`).
- An empty rooted preview shows one `role="note"`: Jira lists nothing under KEY at the levels this connection maps, under an active filter that the filter may be why, and the hint to search
  Jira for `parent = KEY`.
- `409 urn:astrolabe:problem:jira-root-unusable` is `isJiraRootUnusable` (`api/jira.ts`) and `importFailure` answers `jira.import.error.rootUnusable` (the link cannot be used; no server text,
  no "Preview again").
- **The entries read the links.** `useJiraPlanLinks(enabled)` (`hooks/useJiraPlanLinks.ts`; key `["jira","links"]`, `getJiraLinks()` = `GET /views/jira-links`, `staleTime` 30 s, focus refetch
  at the default, `retry: false`) answers `{programs: Map<programId, JiraNodeLink>, projects: Map<projectId, JiraNodeLink>, connections, failed, retry}` from ONE read that feeds both the
  entries' visibility and the dialog's connection, so opening a rooted dialog asks for nothing more. Every `["jira"]` invalidation (a bind, an unlink, an import, a refresh) re-reads it.
- It is enabled only while the plan view holds a program with `can.createProject` or a project with `can.createMilestone` (an optimisation, never the rule); a failed read hides both entries and
  shows no error. `PlanActions.canImportChildren(program)` = the program's `can.createProject` AND a program link, `canImportMilestones(project)` = the project's `can.createMilestone` AND a
  project link.
- `PlanRowMenu` shows a `Menu.Item` "Import from Jira…" (aria "Import from Jira what is listed under {name}": it starts with the visible text, label-in-name; `IconFileImport`) after "Move
  to…" in the program's menu and in the project row's menu; each kebab's own condition includes the import right, so an owner with `canImportChildren` or `canImportMilestones` alone still gets the menu. Both roots are built by `rootOf(level, node, link)` (`utils/jiraImportRoot.ts`: the node's `workStreamId`,
  `ownerPersonId`/`ownerName`, the link's `issueKey`/`connectionId`/`gone`).
- A link through a connection that is not usable still shows the entry (the dialog says why), and so does a link whose Jira item the read already says is gone (`link.gone` -> `root.gone`):
  the scope step opens with the "cannot be used" note and Preview disabled, no Jira round trip. The project page cannot tell (`project.jira` carries no gone flag: its dates are null for a
  gone item but also for a never-observed one), so that dialog learns it from the `jira-root-unusable` refusal.

### The chips and marks

`components/JiraChips.tsx`, `utils/jiraMarks.ts`. The project and team pages make **no request of their own** for what is linked: `projectMarks(view)` / `teamMarks(view)` read the document's
`jira` blocks (the project's own and every milestone row's, scheduled and tray) and `jiraSites` (`url = siteUrl + "/browse/" + key`, https only through `JiraKeyLink`/`jiraBrowseUrl`; the URL is
never per row), so the chip is exactly as current as the view and any refresh of `["plan"]` (a plan write, a bind, an unlink, an acknowledgement) moves it.

- Only OPEN flags are counted - the view lists none for an acknowledged item or a disabled connection - and only `JIRA_DEVIATION` ones: the project's `JIRA_MILESTONES` roll-up repeats its
  milestone rows' flags and counting it would count a deviation twice.
- The project page's facts row (inside `ProjectFacts`, so nothing under it shifts) has "Jira: E2E-1" (the project's own key), "N milestones linked to Jira" and the count (a link to
  `/deviations?projectId=`, orange with a warning, gray otherwise; "No deviations seen" at zero, never "in line"); the team page the same count line (`/deviations?teamId=`); nothing at all
  while nothing is linked.
- **The qualifier.** `JiraMarks.stale` (`marksOf`) is true when some site a MARKED node links through has `state !== "CURRENT"` (so `NEVER_SYNCED`, `STALE`, `FAILED` and `DISABLED` all count) or
  `mappingOk === false`, read off the view's own `jiraSites[{connectionId, siteUrl, state, mappingOk}]`; a site no marked node uses, a link whose connection is not in `jiraSites` and a
  document with no mark say nothing. Both chips (`DeviationCount` in `JiraChips.tsx`) render `deviations.chip.stale` as plain dimmed text after the count badge, inside the `role="group"`,
  at ANY count (three deviations read from a connection that failed last night are as doubtful as none); not an `Alert` and not orange - the Deviations page's banner is the warning, the chip
  only qualifies.
- **One rule with the banner**: both read `isStaleSource` (`utils/staleness.ts`), so, except for a DISABLED site, a chip never qualifies a figure the page it links to leaves unwarned. The
  Roadmap and Programs pages' facts line reads the same rule over ALL the document's sites ("Roadmap", "Programs"). What still differs is deliberate: a DISABLED site counts on the chip, while
  the banner skips a disabled connection (its own row says "Disabled" with a note) so a retired connection raises no permanent banner.
- **Honest limit:** `CURRENT` means the newest run succeeded and, for a polled connection, not long ago; a manual-only connection stays `CURRENT` after any success however old (its "Last run"
  is on the Deviations page).

### The Flags column and the roll-up

The Flags column, the tray row and its menu: `timeline.md` "The Jira markers". Their web half is `components/MilestoneFlags.tsx` (with `utils/flagSentences.ts`): the icon's accessible label
lists the row's flag sentences behind its key (`flagSentence`, shared with the roadmap's flag panel), and a linked row with no open flag (clean, acknowledged, or on a disabled connection) gets
"Linked to Jira: E2E-3" instead, so it is told apart from an unlinked one. A binding through a DISABLED connection stays a link: the chip counts it with no deviations, the key shows, Unlink
works, no bar is drawn. A tray row's name cell adds "Jira: 2027-03-01 to 2027-03-05" for an open `UNSCHEDULED_IN_PLAN` flag; the calendar's `NO_WORKING_DAY` flag is phrased by `roadmap.flag.noWorkingDay`.

- **The roll-up** comes LAST in the cell, after the key and the icon (the least critical element: the cell clips without an ellipsis, so it must never push a warning badge out), when the
  link's `rollup` is set: compact dimmed `xs` text `5/12 · 34 pt` (done of children, then Jira's story points as Jira states them, never converted; the points part is omitted when `points`
  is null). It shrinks with an ellipsis (`minWidth: 0`), so in a tray name cell a long name cannot widen the row.
- `components/JiraRollupText.tsx` (`rollupText`/`rollupSentence`/`formatPoints` in `utils/deviations.ts`, keys `deviations.rollup.*`): the short text is `aria-hidden` and the ACCESSIBLE NAME is
  the full sentence ("12 child issues in Jira, done: 5, story points: 34", plural forms on the children count), also the `title` and a visually hidden span; points show up to two decimals,
  trailing zeros dropped; a link with `rollup: null` (a project link, a disabled connection, a childless epic) renders nothing of it, and the tray's `NameWithFlags` carries it through
  `MilestoneFlags`. The Deviations page's Jira cell shows the same component under the type/status line.

### Capacity from Flow

`components/CapacityDeviationsSection.tsx`, the page's second h3 after the Jira list: ANOTHER document, `GET /views/capacity-deviations`, shaped
`{asOf, connections[], totals{warnings, infos, gone, acknowledged, teams}, items[], truncated}`: `items` ≤ 1,000 teams, each with `can{acknowledge}` and its sprint rows, each row with its
`fingerprint` and `acknowledgement{at, by, current}|null`; no `revision` (capacity is team data). It is read under `["flow","deviations","view",filter]` through
`hooks/useCapacityDeviations.ts` (`api/capacityDeviations.ts`). The Jira document is untouched; the two load in parallel and fail separately (a failed Flow document is the section's own
heading and alert; a failed Jira one leaves the Flow section standing).

- **It exists only when there is a Flow connection** (`connections.length > 0`; a Jira-only stack sees nothing new, not even a heading).
- **Filters.** It takes the URL's `teamId`, `severity` and **Status** (the server narrows each team's ROWS by severity, so "warnings only" lists the warning sprints). The page's ONE Status
  select applies to both lists and is sent as the view's own `acknowledged`/`all`, `all=false` too (the Open choice under a team scope, since the server's `teamId` implies `all`). Plan item
  type, work stream, project, kind and connection are the Jira list's (a Jira connection id is not a Flow one) and are named in one `role="note"` line while any is in the URL.
- **Rows:** one per team - the team (a link to `/teams/:id`), its Flow team (with the connection's name only when there are several), the lines (`CapacityDeviationList`, shared with the team
  page: severity in words before an orange/gray kind badge, `TEAM_GONE` as one sentence, the sprints that differ as sentences, the sprints WITHOUT capacity folded into one line over a table
  disclosure - the count and the date are the OPEN sprints', with a dimmed "· M acknowledged" after it, or "all acknowledged" when none is open) and when Flow was last seen.
- **Totals:** orange warnings (a gone team is one of them), gray infos, an ORANGE "of which N teams gone from Flow" (part of the warnings, not an addition), a gray "N acknowledged" (rows, not
  teams; warnings, infos and gone count the OPEN rows whatever Status lists, so under Acknowledged/All the Jira list's "open items only" note says it), "N teams shown" or, when the server cut
  the list, "N of M teams shown" from `totals.teams`. The poll is the Jira page's (`DEVIATIONS_POLL_MS` while `status.lastRun.running`, bounded).
- **The sentence** (`capacityDeviationSentence`, EN/PL): `"<Flow's sprint name> (<start> – <end>): the plan has 36.00 man-days, Flow 30.00 — 6.00 more in the plan"` (`gapMd` > 0 = the plan
  has more; man-days are JSON numbers shown with two decimals and a dot), plus a second sentence when `flowTotalMd` differs from `flowMd` (a fixed per-sprint figure that shares days with an
  earlier sprint).
- **An empty Open list** with rows acknowledged (`totals.acknowledged > 0`) says "No open capacity difference." and how many sprints are hidden - never "In line with Flow".

#### Currency

The Jira rule, read off the derived `status` (`utils/capacityDeviations.ts`). "Data from Flow" (`CapacityDeviationsSources.tsx`, h4) is a row per connection - state badge, when its document
was mirrored (`teamsAt`), the notes that qualify the figures (never refreshed, last refresh failed with `errorCodeText(…, "FLOW")`, stale, disabled) and, for an ADMIN, **Refresh now** =
`POST /integrations/sync/runs {kind: "FLOW"}` then a re-read of `["flow"]` (a 409 run-in-progress is a normal state; a 429 reads "Too many requests. Wait a minute and try again.").

- An orange `role="note"` says the list may be out of date when an ENABLED connection is not CURRENT (`hasStaleFlowSource`). A row whose connection is disabled or not CURRENT carries "stale"
  under "Data as of" (the Jira table's mark), since the banner covers enabled connections only.
- An empty section is told apart: no team is linked (asked of the connections' own team lists `["flow","teams",id]`, only then; not polled, it re-reads on focus and on `refreshFlowLinks`), a
  filter that matches nothing, or "In line with Flow in the data read at T (UTC)" (`verifiedFlowAt`: the OLDEST success, withheld - "read so far" - when ANY connection is disabled or not
  CURRENT). A failed re-read keeps the last answer under the section's `ErrorAlert`.

#### Acknowledge

Per sprint row: every line carries `CapacityAckCell` (the Jira `DeviationAckCell`'s shape and its `deviations.ack.*` sentences, a stale stamp is open again) plus ONE button named by the sprint
("the team's own row" for the gone team), Acknowledge / Unacknowledge by the item's `can.acknowledge` and the row's state, `data-ack-for="<bindingId>:<sprintId|team>"`. The folded sprints carry
it in a fourth "Acknowledgement" column of their table, so a single missing sprint is a sentence with its cell.

- The write is `hooks/useCapacityAcknowledge.ts`, the Jira `useAcknowledge` state machine over the row key: `POST`/`DELETE /integrations/flow/team-bindings/{id}/acknowledge` with the row's
  `detail.sprintId` (always in the POST body, `null` for the gone team) and `fingerprint`. A success re-reads `["flow","deviations"]`, `["plan"]` and `["roadmap"]` (`refreshFlowCapacity`: the
  team view's flag and markers follow the open rows); the shared `409 stale-deviations` (`isStaleDeviations`) is an orange note in the row plus the re-read (a note of a row that left the list is
  shown above the list, `CapacityAckOrphanNotice`), a 403/404 a red message and a `refreshFlowLinks`; the focus rule is the Jira one (the same `useAckFocus`; the fallback is the "Differences
  from Flow" heading).
- **Acknowledge all** (`CapacityAckAll` in `CapacityAckCell.tsx`, rendered by `CapacityDeviationList`, so the team page has it too): at the head of a team's list a `Button` "Acknowledge all
  (N)" (named "Acknowledge all (N) open differences of <team>"; `CapacityAckContext.team` is the item's team name), shown only when the item's `can.acknowledge` allows it AND at least two of the listed rows are open (`isOpen`: a stale
  acknowledgement and every folded "sprints without capacity" row count; acknowledged ones neither count nor are sent). It **acknowledges what the list shows**: the page's
  Status/severity/team filters have already narrowed the rows, and N is on the label. One request, `POST /integrations/flow/team-bindings/{id}/acknowledge-all`
  (`acknowledgeCapacityDeviations`, body `{items:[{sprintId|null, fingerprint}]}`, all or nothing).
- **Withdraw all**: beside it a `Button` "Withdraw all (N)" (named "Withdraw all (N) acknowledged differences of <team>"), shown with `can.acknowledge` and at least two listed rows that are
  CURRENTLY acknowledged (`!isOpen`: a stale acknowledgement is open and not sent; every folded acknowledged sprint counts), so it shows where the list has acknowledged rows. One request,
  `POST …/team-bindings/{id}/unacknowledge-all` (`unacknowledgeCapacityDeviations`, body `{items:[{sprintId|null}]}`, all or nothing, `204`).
- Both batches go through the SAME hook as `{kind: "acknowledgeAll", bindingId, rows}` / `{kind: "unacknowledgeAll", bindingId, rows}` keyed by `capacityAckAllKey(bindingId)` (`<id>:all`, the button's `data-ack-for` and
  the busy and notice key), with the single write's toast, re-read, stale `409` note (nothing was stored / deleted), refusals (the withdrawal's 404 is the binding) and focus rule - after a batch
  the focus goes to the first row button still there, else the heading. While any write runs the button is `aria-disabled`/`data-disabled`, never `disabled`. The batch's note shows under the
  button at the head of its team's list (button or not), and `listedKeys` of both callers hold each listed team's all-key, so `CapacityAckOrphanNotice` shows it above the list only once the
  team's item has left the list.

### Tests

The co-located tests of the page and its parts (`Deviations*`, `JiraBind*`, `JiraChips`, `Capacity*`, the helpers; fixtures in `test/flow.ts`).

- Import: the co-located `JiraImportModal*.test.tsx` family (`.virtual` pins the 2,000-row cap), `useJiraImport.test.tsx` (the in-flight guard, unmount), `Plan.test.tsx` ("Import from a linked program", "Import from a linked project"), the harness `test/jiraImportHarness.ts`
  (`previewScope(user, rooted)`); the server pins the same bodies in `JiraImportWebBodyTest.kt` (literal JSON through the real deserialization and the kernel).
- Technique: tests build connections with `connectionIn(shape)` (`test/deviations.ts`: every member of `enabled`/`lastRun`/`status` agrees, as the server derives it), never by overriding
  `lastRun` alone.

## Teams and the team page

`/teams` is the flat teams registry (the Registries template of `web/CLAUDE.md`: everyone reads, ADMIN writes). Its name link opens `/teams/:id`, the team view (lazy; `TeamDetails` is
`<TeamPage key={id}>`). Team colours: `team-colours.md`.

Files: `api/teams.ts` (`listCapacityPeriods` is deliberately NOT wrapped: the view carries the periods); `hooks/useScheduleWritePath.ts` (the project view's write path, generic over the view document:
`{queryKey, queryFn, apply, enabled, writeKey}`) with its wrappers `useMilestoneSchedule.ts` and `useTeamSchedule.ts`, `useTeamOrder.ts`, `useRefusal.ts`, `useScheduleProposal.ts`,
`useScheduleCheck.ts`, `useProposalLock.ts`; `utils/teamOrderList.ts` (`fullOrderList`, `placeScheduled`: the order PUT's FULL list, `planning-model.md` "The team milestone order"),
`teamViewUpdate.ts`, `pinUpdate.ts`, `roadmapOrder.ts`, `scheduleProposal.ts`; `components/TeamTimeline.tsx` (rows, arrows, the strip; `TeamTray`), `TeamTimelineMenu.tsx`, `TeamTimelineRows.tsx`,
`TeamPageHeader.tsx`, `TeamFacts.tsx`, `TeamCapacity.tsx`, `TeamWeeklyLoad.tsx`, `TeamProposal.tsx`, `ProposalTable.tsx`.

### Route and data

`/teams/:id` renders `GET /views/team/{id}` under `["plan","team",id,{baseline,chain}]` (`teamViewKey`), under the `["plan"]` prefix like the project view, so every plan mutation, a schedule write and a capacity write
refresh a mounted page. The team editor's save refreshes `["teams"]` and `["plan"]`. **Everything is gated by the view's `team.can:{schedule, editCapacity, editOrder}`** (the team's manager or an
ADMIN), never the session's roles.

- **Header.** Name, description, the manager line, an ADMIN's Edit (`TeamEditorModal` on the view's team block). The Flow capacity flag sits beside the title: `team.flags[]` (the ONE `FLOW_CAPACITY`
  roll-up of the OPEN rows, so an acknowledged row is not in it) goes through `PageHeader`'s `titleAddon` as a light badge (`TeamFlags`: orange triangle for a warning, gray info circle for an info). The text is `flagSentence`'s "Capacity differs from Flow: N open differences" (open ROWS, not sprints: a gone Flow team is one too); the icon is `aria-hidden`; no count badge,
  nothing for `[]`.
- **Facts line** (`TeamFacts`). "N milestones · M scheduled", ORANGE "N weeks overloaded" and "N weeks over WIP limit" badges (warnings: nothing moves), the RED conflicts badge of the project page, a
  gray "N idle gaps" badge (absent at zero) and a gray "Custom order" badge while the team's own order is in force. The red one is a `BadgeLink` to `/dependencies?status=violated&teamId=N`
  (`teams.view.conflictsAria`); after the badges, only while `view.dependencies` is not empty, a link "N dependencies" to `/dependencies?teamId=N` (`teams.view.dependenciesAria`). Both names
  start with their visible text; the paths come from `utils/dependencyListLinks.ts`.
- **The timeline** (`TeamTimeline`, on the shared `Timeline*` with the sticky load `strip`) has one row per SCHEDULED milestone in the server's order: **the project rank is only the DEFAULT order; a
  manager's override is the execution order and is never reshuffled by a rank change.** A row has the project as a link, the estimate and the row menu. Arrows are drawn only between this timeline's
  rows (ghost rows only for the critical chain, no Dependencies table; a bar's name gains ", N conflicts"); the Unscheduled tray is the project page's.
- **Two revisions, never crossed.** The view's `revision` is the PLAN revision: the schedule PUT's `expectedRevision`, adopted from the PUT's answer. `order.revision` is the TEAM's order revision: the
  order PUT's `expectedRevision`, set ONLY from the order PUT's answer (`TeamOrderResponse.revision`). The roadmap's revision is a third thing the page never touches.
- **Messages shared with the project page:** the busy / milestone-gone / stale / schedule-error / announce sentences are its keys (`project.busy`, `project.milestoneGone`, `project.stale`,
  `project.scheduleForbidden`, `project.announce.*`).
- **The strip's data.** `view.weeks` is handed to `TimelineLoadStrip` as it is (the API's `WeekLoad` is structurally the strip's `LoadWeek`; `stripCells` normalises an absent `flowCapacity` to
  `null`). The weekly table formats with two decimals (what the server flags on); the strip trims zeros.

### Critical path and the pin

- **Critical path.** The page holds the project page's `useCriticalPathPick()` and `<CriticalPathToggle>` (after the baseline picker); the highlight, the chain's ghost rows and arrows and the Critical chain section are `timeline.md` "The critical-path highlight". Read, never recomputed.
  - **The key.** On, the page asks `?criticalChain=true`: the toggle is the other half of the view's key. `useTeamSchedule`, `useTeamOrder` and `useScheduleProposal` all take the same trailing `chain` and build their key with `teamViewKey`, so a step, a rollback and an answered revision hit the entry the page shows, never the other document's (`teamWriteSiblings.test.tsx`); a chain-only placeholder keeps the pick's overlay (`overlayPick`). A successful write removes the team's inactive sibling entries (`dropInactiveSiblings`), so a toggle after one shows no stale copy.
  - **Locked toggle.** It is `disabled` with the baseline picker (`frozen`) while a write runs or a proposal is requested or open. `useTeamChain` hands over the block while on and says, once per switch-on in the mount (not a first load), how many rows arrived. A failed chain request offers "Show without the critical chain" (`PickedLoadState`), which turns the shared stored toggle off (the project page's too); the range stays wide after toggling off.
- **The pin.** `PUT /milestones/{id}/pin {pinned}` (`api/milestones.ts` `pinMilestone`, answers `{revision}`; no `expectedRevision`: an idempotent flag) is a SECOND write of `useScheduleWritePath`
  (`pin(id, pinned)`, so both timeline pages have it). It is its own mutation on the SAME write key (`teamWriteKey`; the project page's `["plan","project-write",id]`), so a drag, a pin and an order
  save see each other in flight and a change made meanwhile is refused out loud like any other (`refused`, `project.busy`).
  - The step is optimistic (`applyPin`, pure, generic over both views); success stores the answered plan revision into the entry the pin was made on (only) and refreshes `["plan"]`; a failure rolls
    back and awaits the refetch. The confirmation is the live region ("{{name}} pinned" / "unpinned", `project.announce.pinned|unpinned`), no toast (a pin is a state, not an event).
  - A 403 reads the schedule's forbidden sentence, a 404 the gone one, and the one 409 (`milestone-unscheduled`: it lost its dates meanwhile) `project.pinUnscheduled`, inline through the page's
    `error`; a taken schedule change and a taken pin each clear the other's old failure.
  - The server clears the pin on an unschedule: `applySchedule` / `applyTeamSchedule` set `pinned` false on a null pair (a reschedule keeps it).
  - The row menu (`TeamTimelineMenu.tsx`) offers Pin / Unpin dates for a SCHEDULED row under `team.can.schedule`, hidden while a proposal previews or requests (`lock.guarded`) and never on a tray row;
    the pinned row shows `PinMark` after its name and ", pinned" in its bar's name. A baseline's appended rows and the Jira bars are untouched.
  - **In the proposal**, the Proposed schedule `Summary` appends "N pinned" to the figures line and, when `proposal.pinned` is not empty, a dimmed sentence "N milestones keep their dates because they
    are pinned" (`teams.proposal.summary.pinnedCount|pinned`; `pinned` lists the dated milestones the proposal keeps ONLY because of the pin). A pin flipped after a proposal was read turns its accept
    into the `stale-scope` re-proposal that keeps the ticks.

### Writes: one at a time, and the team's order

- **One write at a time.** The schedule and order mutations carry the same `mutationKey` (`teamWriteKey(id)`); each hook treats `useIsMutating(key) > 0` as "busy" and refuses a change OUT LOUD:
  `commit` answers `false`, the hook sets its `refused` flag (the page's `role="note"` shows when either hook's is set) and announces `project.busy` in the live region (`onSchedule` answers `false`
  for a drop; a Move or Reset is refused the same way, and the Reset confirm dialog stays open and says so inside, since a modal's content is all a screen reader reads). `hooks/useRefusal.ts`
  clears `refused` the moment NO write is in flight, whichever was busy (two optimistic writes on one cached view would roll each other back). The page's `busy` (aria-busy, "Saving…") is either.
- **Order failures.** A stale 409 and a 400 (a listed milestone was deleted or moved to another team meanwhile: removals do not bump the team's order revision) are both "the list changed": rollback,
  awaited refetch, the visible `role="note"` "The team's order changed in the meantime" and the same sentence in the live region (from `onError`, so a screen-reader user hears the list jump back).
  403 reads `teams.view.orderForbidden`; anything else the generic action-failed sentence.
- **Optimistic order.** Every reorder goes through the hook's one seam `placed(id, permutation)` (a permutation of the displayed scheduled ids; the Move items and the row drop): `placeScheduled` turns
  it into the full list (unscheduled listed milestones keep their index), `commit` sends it. `applyTeamOrder(view, ids)` shows the listed scheduled rows in that order and the unlisted after them in
  the default order (rank position, project name, project id, start, end, name, id: the server's order without the custom positions); `order.milestoneIds` = the list (ids the view does not hold
  dropped), `order.custom = ids.length > 0`, so Reset (the empty list) shows the default order at once. `applyTeamSchedule` appends a newly scheduled row (the refetch places it), keeps a
  rescheduled row where it is and returns an unscheduled row to the tray in the default order.
- **Order commands.** The order is the wholesale `PUT /teams/{id}/milestone-order` against `view.order.revision`. The row menu's Move up / Move down / Move to top / Move to bottom (`can.editOrder`,
  disabled at the ends) and the "Reset order" button (confirms with "Reset", then sends the empty list = the project rank again) are announced in the page's one polite live region.
- **Menu focus.** Rows are keyed by milestone id, so a Move keeps the row's DOM node and Mantine's menu returns focus to its kebab; the roving grid's focus handler re-adopts it as the tab stop.
- **Row drag.** A manager (`can.editOrder`) also drags a row by its pointer-only handle (`TimelineRowHandle`, the first thing in the name cell). `TimelineDndContext` takes an optional
  `onReorder(id, slot) → boolean` (`onSchedule`'s twin: `false` = refused, announced as "not changed"); the page passes `order.dropAt(id, slot)` =
  `placed(id, moveToSlot(scheduledIds, id, slot), false)`, so a drop is the SAME `commit` as a menu Move (the optimistic `applyTeamOrder`, the PUT against `order.revision`, the stale/400 rollback).
  - `false` as `placed`'s third argument means no page announcement: dnd-kit's region is the drag's single announcer. The menu stays the keyboard path.
  - `moveToSlot` (`utils/roadmapOrder.ts`) removes the id and re-inserts it at `slot − 1` when the gap lies below it, else at `slot`; a slot of `from` or `from + 1` is the identity: the context
    proposes those too and `placed` answers `true` WITHOUT a PUT when the permutation equals the displayed order (the page, not a pick-up snapshot, judges a no-op).
  - `TimelineDndContext` keeps the picked-up `DragData` in a ref (dnd-kit blanks an unmounted active node's data). Mechanics and slot arithmetic: `timeline.md` "Row drag".

### Idle gaps and the Flow capacity marks

- **Idle gaps** are information only (`timeline.md` "Idle bands"): `TeamTimeline` passes `bands={idleBands(view.idleGaps, t)}` (no window band here), `TeamFacts` adds the gray
  `timeline.idle.badge` before the "Custom order" one (only when non-empty) and `<IdleGaps gaps scope="team" />` follows `TeamWeeklyLoad`. The optimistic steps spread the view: cached gaps stay until the refetch.
- **The Flow capacity marks** (the page half of `timeline.md` "The Flow capacity marker", which holds the strip cell's `data-flow-capacity` / `data-part="flow-capacity"` and the shapes).
  `weeks[].flowCapacity` (`WARNING`|`INFO`, only the weeks an OPEN row's held days meet) is read, never recomputed. The weekly table's verdict cell gains a badge "Differs from Flow" (orange / gray,
  `data-flow-badge`) BESIDE the week's own verdict (an OK week reads "OK" + "Differs from Flow"); the table's intro names the corner mark. The marks follow the CURRENT plan: a proposal preview's strip
  draws the proposal's weeks, which carry none, while the header flag and the table keep reading `view.weeks`. An acknowledge refreshes `["plan"]`.

### Capacity

`components/TeamCapacity.tsx`, `CapacityPeriodModal.tsx`, `utils/capacityForm.ts`: the periods table is where the limits are READ ("—" = no WIP limit); Add/Edit/Delete only with `can.editCapacity`. A
period takes effect on ANY date (no weekday rule: a weekend date applies from the next working day), man-days per week (0 ≤ x < 1,000,000, two decimals) and an optional WIP limit 1..99 (empty sends
`null`); a date clash (409) marks the date field (the model: `planning-model.md` "Team capacity periods").

- **Capacity dialog.** The `NumberInput`s use `clampBehavior="none"`: Mantine's default clamps `0` to the `min` of 1 on blur, silently making an invalid WIP limit valid.
- **The weekly load table** (`TeamWeeklyLoad.tsx`, behind a `TableDisclosure`) is the accessible surface of the decorative strip: load, capacity ("—" when none), peak WIP and the verdict in words
  (orange "Overloaded · +X MD", orange "Over WIP limit", gray "OK" / "No capacity", plus the "Differs from Flow" badge).
- A `source === "FLOW"` row gets a gray "Flow" badge titled with the sprint; the period editor says a saved edit makes the period hand-entered.

### Baseline overlay and Jira markers

Both are the shared pieces, fed from the team view alone (`timeline.md` "The baseline overlay" and "The Jira markers" hold the rows, bars, columns and the toggle).

- **Baseline.** The picker sits in the timeline's toolbar (after Today); the query key and the three write hooks (`useTeamSchedule`, `useTeamOrder`, `useScheduleProposal`) take the pick. The Movement
  section (`scope="team"`, with a Project column) follows Idle gaps. 1.26: `TeamBaselineCapacity` (inside `TeamCapacity`, under the current periods) lists the capacity the baseline froze
  as ranges (h4, From / To or "no end" / man-days / WIP); `captured: false` is one dimmed note without a heading.
- **Jira.** The chip's count line is `teamMarks(view)` (the team's linked milestones, scheduled and tray, and their open flags); the "Jira dates" toggle sits after the baseline picker. The Flags
  column, the tray rows' key link and the dimmed appended rows `jira-unscheduled:<milestoneId>` are the shared pieces.
  - The appended rows' menu (`TeamTimelineRows.tsx`, the pure builders; `timeline.md` "Appended rows for the tray") offers "Schedule on Jira's dates" only while `team.can.schedule` holds, no proposal
    previews and Jira's two dates are in order; it is `lock.guarded`, writes the REAL dates through the page's one schedule write path, then focuses the milestone's own row (`useRowMenuFocus`).

### The schedule proposal

A third write path, `hooks/useScheduleProposal.ts` (the generated view: `timeline.md` "The proposal preview"). "Propose schedule" (timeline header, `team.can.schedule`) POSTs the viewer's local day as
`asOf`. A proposal with something to show opens the **Proposed schedule section** (`components/TeamProposal.tsx`, h3, under the timeline before the Unscheduled tray; its summary line, table and
unplaced rows are `components/ProposalTable.tsx`, a controlled, action-free table over the structural `ProposalContent`, which the cross-team page composes once per team); one with nothing to show
(nothing to propose / no capacity: add a period first) opens nothing and says so in a note. The page is read-only while a proposal is requested or open (`hooks/useProposalLock.ts`).

- **The section** is controlled by the hook (`selected`, `toggle`, `selectAll`, `selectNone`, `accept`, `discard`).
  - A summary line ("3 moves · 1 newly scheduled · 2 stay · 1 could not be placed"), a RED "N links would be violated" badge for links violated AFTER and not before (a gray "N links stay violated" for
    those violated both times: `linkTotals`).
  - The table (`teams.proposal.tableAria`): a header "Accept all" `Checkbox` (`indeterminate` while only some rows are ticked), a per-row `Checkbox` "Accept {{name}}"; Milestone with the project as a
    link, Current, Proposed with its working days, Change = `changeSentence`, Links = `linksAtMove`: "would violate: <link> must start on <date> or later" (start or end by the link type,
    `requiredEdge`: FS/SS start, FF/SF end) in red with a red "Conflict" badge, "resolves: link with ..." gray, nothing for an unchanged link.
  - A "Could not be placed" row group with the reason in words (no capacity after {{date}}, the request's `asOf` / no room within the 520-week horizon, `PROPOSAL_HORIZON_WEEKS`; no checkbox).
  - **Accept selected (N)** (primary; disabled at zero or while ANY write of the page runs) and **Discard** (disabled while the accept runs). The intro says the link warnings and the proposed load follow the ticks.
- **Announcements.** Accept all / none are announced in the page's one polite region ("2 of 3 selected"); a per-row tick is a self-announcing checkbox. **What an accept came to** is a dismissible
  `role="note"` line lasting until the next action (`ProposalNotes` under the timeline header, green; orange when something was skipped: "3 scheduled · 1 skipped: rescheduled in the meantime"), as are
  the whole-batch stale refusal and the re-proposal after a `stale-scope` refusal. The status region is the single announcer (never an `Alert` with its implicit `role="alert"`); no success toast on accept.
- **Failures.** A 403/404/400 of the accept is a `FormErrorAlert` INSIDE the open section above the actions (the preview stays open, the selection is kept) and takes the focus (the disabled Accept
  would otherwise drop it to the body); a propose's failure shows under the timeline header while no preview is open.
- **Focus.** Discard takes it when the preview opens; Propose gets it back after Discard, an accept or a stale refusal, once no write is running (a disabled button cannot take it)
  (`hooks/useProposalFocus.ts`).

### The scope check and the ticked-subset check

- **The scope check.** The accept sends the proposal's `scopeHash`; on a `409 stale-scope` (`isStaleScope`; the team's plan changed since the proposal, nothing was written) the hook closes the
  preview, requests a fresh proposal at once (a fresh `asOf`), refreshes `["plan"]`, and the new preview keeps the ticks of the milestones that were ticked and still move (`keptTicks`: the old
  selection intersected with the new moves; a move new to the page starts unticked) with an orange dismissible `role="note"` `teams.proposal.rescoped` (`rescoped`). The focus goes back to Discard once
  the preview is open and the accept has settled (the refresh is not awaited, so `applying` ends at once; the page arms the focus when a preview opens or the rescoped note appears, and hands it over
  when `applying` is false). A fresh proposal with nothing to show leaves the usual note instead. The whole-batch `stale-revision` 409 keeps the "reloaded, propose again" note.
- **The ticked-subset check.** The proposal's link verdicts (`dependencies`) and proposed load (`weeks`) describe EVERY move accepted, so they would lie once some moves are unticked.
  `hooks/useScheduleCheck.ts` (`{teamIds, revision, scopeHash, moves, selected, enabled}`; the cross-team page reuses it with the run's teams) asks the server (`checkSchedule`,
  `api/scheduleProposals.ts`: `POST /schedule-proposals/check {teamIds:[team], items}`, a computation) for the verdicts of exactly the ticked moves, and ONLY while some but not all are ticked: all
  ticked IS the proposal's own answer and none ticked changes nothing, so neither sends a request.
  - The ticks are debounced 300 ms (`useDebouncedValue` over their JSON); the query is keyed `["plan", "schedule-check", sorted teamIds, revision, scopeHash, items]` by the DEBOUNCED ticks and runs
    only once they have caught up with the current ones, so an answer for an older selection is never shown for the current one.
  - It returns `ScheduleCheckState {mode: all|some|none, byTeam, pending, failed}` and `overlayCheck(open, check, teamId)` (`utils/scheduleProposal.ts`, pure) turns the open proposal into what the
    page shows: all = the proposal as it is; none = the plan as it is (only the links already violated BEFORE remain, the gray "N links stay violated", no new warning, and no `weeks`: the strip keeps
    the CURRENT load, so `TeamProposalView.weeks` is optional); some = the check's `dependencies`/`weeks`/`weeksTruncated` for the team once they are in.
  - While the check is pending (the debounce window and the request count; a check cancelled by a write's `cancelQueries(["plan"])` is asked again, never left "Checking…") or has failed, the
    all-accepted verdicts stay and `ProposalTable` says so in one dimmed line under the summary (`teams.proposal.checking` / `checkFailed`; visible only, never a toast or an alert, no announcement:
    the status region already speaks on select all/none). So unticking a predecessor turns the ticked successor's Links cell and the summary badge red BEFORE the accept.
  - `TeamDetails` hands the overlaid proposal to both `TeamProposal` and `TeamTimeline`; the accept still sends the selected moves exactly as before (the check is a query, `teamWriteKey` is
    untouched); closing the preview drops the check queries, so the refresh after an accept re-asks none. `ProposalNotes` takes the structural `ProposalFlow` (`utils/scheduleProposal.ts`), so a second
    hook fits it.

### The team page: Flow

Files: `components/TeamFlowSection.tsx`, `FlowTeamLinkDialog.tsx`, `FlowRosterPanel.tsx`; `utils/flowLinkFailure.tsx` (`linkFailure`, the connection page's too).

An h3 **Flow** after Capacity, over its OWN read `GET /teams/{id}/flow` under `["flow","team",id]` (not a member of the team view; any signed-in user, re-read every `IDLE_REFRESH_MS`). The controls
follow the panel's `can:{link, unlink, importCapacity}`, never the session's roles, and a viewer without them reads only who can link.

- **Unlinked:** "Not linked to a Flow team" + **Link to Flow team…** (`FlowTeamLinkDialog`: an ENABLED connection from the panel, then one of its UNLINKED Flow teams with the server's suggestion
  preselected). The dialog's connections are the panel's own `connections[{id, name, enabled}]` (every active connection by name, for any login: the registry list is ADMIN only), offered only when
  `enabled` (one enabled is preselected; none says so in a note), so a team manager who is no administrator links on their own. A refused link (409/400) re-reads the Flow teams so a stale option goes.
- **Linked:** facts (Flow team, connection, `SyncStatusBadge`, observed at), an orange "No longer in Flow" when `gone` (the link stays; Import is disabled, the roster reads "not available"), a note
  while the connection is disabled, **Import capacity…**, **Unlink** (an in-page `ConfirmDeleteModal`) and `FlowRosterPanel` (an h4 Roster: current members with "since", a `TableDisclosure` "N former
  members" with from/to, observed at; names only, "Unknown account" is the server's).
- A link or unlink refreshes `refreshFlowLinks` (which re-reads the capacity deviations too); `importBlocked` (a schedule proposal is open, `useProposalLock`) disables Import and closes an open modal.

### Capacity against Flow

`components/TeamFlowCapacity.tsx`, shared lines in `CapacityDeviationList.tsx`, `hooks/useCapacityDeviations.ts`. Once the team is linked the section also asks `GET /views/capacity-deviations?teamId=`
(under `["flow","deviations","view",filter]`, re-read every `IDLE_REFRESH_MS`; the SAME document and sentences as the Deviations page's section, no second computation; the server takes `teamId` as
`all`, so acknowledged rows arrive with their state and the team's own item brings `can.acknowledge`) and adds a **Capacity vs Flow** fact row.

- **The badges count the OPEN rows.** An ORANGE "Differs from Flow for N sprints" while the plan has MORE than Flow for some OPEN sprint, gray when it only has less, a gray "No capacity in the plan
  for N sprints", both when both. A dimmed "· N acknowledged" follows them when any is acknowledged; with only acknowledged rows left the fact reads the dimmed "No open difference · N acknowledged"
  (never "In line with Flow": the figures still differ). Each badge carries a visually hidden "Warning:"/"Info:" prefix.
- **"In line with Flow"** is green TEXT (the AA-tested `--mantine-color-green-light-color`; never a badge) when the team has no row AND its connection is enabled and CURRENT (`staleFlowConnection` on
  the panel's binding); a disabled, failed, stale or never-mirrored connection reads the neutral dimmed "No difference in the data read so far" instead.
- A loading line while the answer is on its way, an inline `ErrorAlert` below the facts when a read failed (the last answer stays under the alert). A Flow team that left the document (the panel's
  `gone`, or a `TEAM_GONE` row) adds no fact row, no sprint lines and no import remedy: the panel's own orange badge says it.
- **The lines** are `CapacityDeviationList` (shared with the Deviations page's "Capacity from Flow", which holds the sentences, the folded no-capacity line and the acknowledge mechanics): warnings
  first, the first five, the rest behind a `TableDisclosure` "Show N more". EVERY line carries its `CapacityAckCell` (`CapacityDetails` passes `ack`: the section's `useCapacityAcknowledge`, keyed by
  the team's id, whose focus fallback is the section's h3; an orphaned note shows above the lines), so the manager acknowledges where they plan; the list opens with "Acknowledge all (N)"
  (`CapacityAckAll`, exported from `CapacityAckCell.tsx`). A gone Flow team's OWN row is listed with its cell (`sprintId` null, the DELETE carries no parameter): the open row counts in the header's
  flag, so the manager silences it where they plan.
- **The remedy line**, for whoever `can.importCapacity` (and no proposal is open): "Import capacity… shows what an import would change. Hand-entered periods are left as they are, and a sprint where
  Flow has 0 must be ticked by hand." It never promises the plan will match: a hand-entered period and a ZERO_CAPACITY sprint are not touched by default.
- **Invalidations.** Links use `refreshFlowLinks`; imports, period changes and acknowledgements use `refreshFlowCapacity`. Both refresh
  Flow deviations, planning views and the Roadmap family. Public-holiday writes also refresh these views.

### The capacity import

`CapacityImportModal` (`utils/capacityImport.ts` is its pure half): "Include closed sprints" (re-reads the plan), the preview table (`POST …/capacity-preview`, read once per opening: `gcTime: 0`, no
refocus refetch, so ticks are never reset).
An observed snapshot with `sprintsComplete: false` shows refresh guidance and disables Apply. A missing observation still shows the no-mirror note.

- A checkbox only on a CREATE / UPDATE row (`isImportable`), defaulting to the server's `ticked` (closed, `ZERO_CAPACITY` and `LONG_WINDOW` rows start unticked and may be ticked). `infoSentence` words
  each info (`FIXED_FIGURE` with the server's `days`; the long-window one with the row's own `calendarDays`, since Flow's 60-day cap makes a sprint that long a likely Jira date mistake). UNCHANGED,
  `MANUAL_PERIOD` and SKIP rows have no checkbox and say why in words (`flow.import.reason/info.*`). The **removals** list is never preselected.
- **Import** (`POST …/capacity-import`) sends exactly `{from, includeClosed}` as the preview echoed them, the ticked rows with their `expected{action, effectiveFrom, mdPerWeek}` and the ticked removal
  ids (`applyRequest`: nothing is built from anything but the preview).
- The outcome is a polite line in neutral forms ("3 created · 1 updated · 1 removed · 1 skipped: changed in the meantime"; Polish "utworzono: 3 …", grammatical for every count), orange while something
  was skipped, and a fresh preview is read under it. It sits in an always-mounted polite status region and takes the focus once that plan is read (the plan replaces the table the Import button sat
  in); a failed refresh of the page behind never hides it. An apply refreshes `["plan"]` (team capacity and weekly load are in the team view) and `["flow","deviations"]`.

### Tests

The co-located `TeamDetails.test.tsx` (the page against a fetch-mock server that applies the order and schedule PUTs; the wrapped `DndContext` hands it the bar drop and the row drop; "the menu button
keeps focus" through a real Move) and its `TeamDetails.pin|proposal|baseline|jira|flow.test.tsx` siblings (the others serve `READ_ONLY_PANEL`), the `Team*`, `ProposalTable`, `CapacityImportModal`, `FlowTeamLinkDialog`, `FlowRosterPanel` and hook tests; fixtures in `test/flow.ts`; the real browser is `e2e/tests/team-view.spec.ts` and `accessibility.spec.ts`.


## People

Files: `pages/People.tsx`, `PersonDetails.tsx`; `components/PersonEditorModal.tsx`, `PersonSelect.tsx`, `UserSelect.tsx`, `SearchPicker.tsx`; `utils/peopleLinks.ts`; `api/people.ts`.

The people directory, a Teams clone under Administration after Teams, **visible to everyone** (reads are open, emails included): `useRegistryListControls` + `RegistryListTable` (Name link, Email,
Login), ADMIN-only New/Edit/Delete through `PersonEditorModal` (name, optional email, optional Login via `UserSelect`, an ADMIN-only users search). A list row carries every field of the detail, so
Edit takes the row as it stands (no detail fetch). The family of paths is spelled out in `utils/peopleLinks.ts`; the team editor's manager is a person (`managerPersonId`).

- **`PersonSelect`** is the owner/manager picker (`["people","picker",term]`, enabled for every session, options `name (email)` or `name`); it and `UserSelect` are thin wrappers over `SearchPicker`
  (debounced server-side search, the picked entry held by the caller). It also takes `disabled` and `error` (the plan editors' Owner: read-only for a caller who may edit only another part of the
  modal, and the required-owner message).
- **A 409 on save** marks the email field, or the login field when the problem `type` is `person-login-taken` (`isPersonLoginTaken`, `api/people.ts`); an untyped 409 reads as the email.

The co-located `People*.test.tsx`, `PersonDetails.test.tsx`, `PersonSelect.test.tsx`; the real browser is `e2e/tests/people.spec.ts`.

## Public holidays

`/public-holidays` is a leaf of the Teams and capacity section after People (`IconCalendarOff`, palette "Public holidays" / PL "Święta państwowe") that **everyone sees** (reads are open, like Teams and
People; the dictionary is global and read by every timeline). The page is a year `Select`, one table per year (date, weekday, name; a plain `Table` in a `ScrollRegion`) and, for an ADMIN only, an add
strip, a row delete behind `ConfirmDeleteModal` and the Polish preset button (`POST /public-holidays/apply-preset`). The dictionary is handed to `Timeline`'s `holidays` prop.

Files: `pages/PublicHolidays.tsx`; `api/calendar.ts` (`listPublicHolidays` unwraps `{items}`); `hooks/useHolidays.ts`; `utils/publicHolidays.ts`, `utils/calendarLinks.ts`;
`locales/{en,pl}/calendar.json` (`calendar.*`).

- **ONE cached query, two consumers.** The dictionary is `["calendar","holidays"]` (`HOLIDAYS_QUERY_KEY`, `staleTime` 1 min, so another admin's edit reaches a mounted page soon). The page reads it
  with its own `useQuery` on that key; every timeline component (`ProjectTimeline`, `TeamTimeline`, `RoadmapTimeline`, `ProgramsTimeline`) and `MilestoneScheduleModal` read it through `useHolidays()`
  = `{holidays, failed}`: `[]` while loading or on a failure (the holiday layer is decoration and the pre-check only a pre-check: the server's views and 400 are the rule), `failed` true only when
  there is no copy at all, which the timelines pass on as `holidaysFailed` so `Timeline` shows its muted "could not be loaded" line (a page test that does not serve `GET /api/v1/public-holidays` sees
  it).
- **A write refreshes `["calendar"]`, `["plan"]` and `["roadmap"]`** (`refreshQueriesAfterMutation`): the holiday write bumps the plan revision server-side and every view's working-day figures
  changed. A mounted project view, the roadmap and the programs page (`["roadmap","programs"]`) all follow.
- **The year picker** shows ONE year at a time, client-side (the endpoint is unpaged): the years in the data, the current year, the year after it (so the Polish preset can be applied to the coming
  year on an empty list) and the viewed year. A successful add jumps the picker to the new row's year.
- **The Polish preset** (ADMIN): the "Add Polish public holidays for {{year}}" button opens a `ConfirmActionModal` (non-destructive: `confirmColor="astrolabe"`);
  `POST /public-holidays/apply-preset {preset: "POLISH", year}` for the VIEWED year. On success the toast `calendar.toast.presetAdded` and a `role="status"` line "Polish holidays of 2027: 12 added, 2
  already present." under the picker (cleared when the year changes or a holiday is added); a 400/403/other failure closes the dialog and shows the same inline `FormErrorAlert` as an add
  (`calendar.error.preset*`), never a toast. A holiday on a weekend is stored and shown; it changes no figure.
- **Add / delete.** The add strip is a `<form>` (Enter submits; the button is disabled until the date is a real calendar date and the name is 1..100 characters); a 409 reads the fixed
  `calendar.duplicateDate`, a 400 `calendar.invalid`, a 403 `calendar.error.forbidden`: the server's `detail` is never rendered. Delete is `useDeleteConfirm` + `ConfirmDeleteModal` with an
  interpolated row aria-label (`calendar.deleteAria`); a 404 on delete reads "This holiday no longer exists".

The co-located `PublicHolidays.test.tsx`, `utils/publicHolidays.test.ts`, `api/calendar.test.ts`; the wiring into the pages is one test each in `ProjectView|TeamDetails|Roadmap|Programs.test.tsx`;
`MilestoneScheduleModal`'s pre-check is `ProjectView.test.tsx` and `milestoneForm.test.ts`.

## Users, feature flags and permissions

Routes: `/users` (list, `/new`, `/:id/edit`, `/:id/features`, `/:id/permissions`; `utils/userLinks.ts` spells the family out) and ADMIN `/feature-flags`, all under ONE
`<Route element={<RequireAdmin />}>` in `App.tsx` (`auth.tsx`, beside `RequireAuth`: a regular user is sent home). `NavLeaf.adminOnly` gates the Users nav item (the Shell filters by `isAdmin()`); the
rest is `web/CLAUDE.md`'s admin-page rule.

### User management

Files: `pages/Users.tsx`, `components/UserTableRow.tsx`, `CreateUser.tsx`, `EditUser.tsx`, `ChangePassword.tsx`; `components/OneTimePasswordModal.tsx`, `RevealablePassword.tsx`; `hooks/useResetPassword.ts`; `utils/password.ts`,
`userForm.ts`; `api/users.ts`.

- **Passwords** are generated client-side (`utils/password.ts`) and revealed exactly once: `OneTimePasswordModal` (not dismissable by click-outside or Escape) renders `RevealablePassword` (masked by
  default, eye toggle, copy), and closing drops the plaintext from state for good: the server never returns it. The admin Reset-password action (`useResetPassword`) reuses the same generate→PUT→reveal
  flow; the confirm is the shared `ConfirmActionModal` (its optional `error` slot carries the inline `FormErrorAlert`).
- **The edit page** tells the last-administrator 409 (`users.lastAdminError`) from the email-in-use one by the problem `type` `last-admin` (`isLastAdminConflict`, `api/users.ts`), never by the
  sentence.
- **Login and person in one step.** The new-login form (`CreateUser.tsx` only, not the shared `UserFormFields`, so the edit page has none) has a `Switch` "Also create a linked person", ON by default
  (a page-local `useState`), posted as `alsoCreatePerson`; the server creates the person (the login's name and email, linked) in the same transaction, and the create refreshes `["users"]` and
  `["people"]`. A refused person means no login.
  - A 409 of problem `type` `person-email-taken` (`isPersonEmailTaken`) gets its own message (`users.personAlreadyExists`); the plain 409 stays the email-in-use one. Every other 23505 stays
    `about:blank`; the 409s are told apart by the problem `type` (`person-email-taken`, `person-login-taken`), never by the sentence.
  - The Users row menu offers "Create a person" (`POST /people` with the login's name, email and `userId`, success toast `users.toast.personCreated`, a failure inline) only when the row's `personId`
    is null (`UserResponse.personId`: the id of the ACTIVE person linked to the login); a success refreshes `["people"]` and `["users"]`. The inline failure belongs to the view it happened in (a
    filter, sort or page change drops it) and is cleared when another row action starts.
  - e2e: the helper `createUserViaUi` turns the switch OFF unless asked, so a throwaway login leaves no person behind.

### Feature flags

Files: `pages/FeatureFlags.tsx`, `UserFeatures.tsx`; `hooks/useFeatureFlagFilters.ts` (the persisted filters), `useFeatureFlagBulk.ts` (the bulk run wired to this screen), `useBulkFeatureUpdate.ts`;
`components/FeatureFlagFilters.tsx`, `FeatureFlagBulk.tsx`, `FeatureFlagRow.tsx`; `utils/featureFlags.ts` (`isFeatureEnabled`/`withFeatureEnabled`, the one place a disabled set is rewritten).

`getDisabledFeatures()` (`api/session.ts`, reading the `astrolabe.auth.disabledFeatures` localStorage set; no area gates on it yet, MFA gates only the login flow server-side). The per-user editor is
at `/users/:id/features` (the Users table's Features button: a checkbox per `Feature`, wholesale-replace PUT); the ADMIN per-feature screen at `/feature-flags` (`adminOnly` nav leaf) has a state
filter and bulk enable/disable over every row matching the current filters behind a count-stating confirm (`useBulkFeatureUpdate` loops the same per-user wholesale PUTs client-side via
`ConfirmActionModal`). The page itself is only the query, the table and the single-row toggle. A second `Feature` value needs no restructuring: the feature `Select` already lists `FEATURES`. Both
queries key under `["users", …]`.

- **Mind the wholesale-replace semantics:** a PUT whose disabled set omits `MFA` ENABLES it.
- A bulk run with nothing to change is neither success nor failure: it shows the inline gray `role="note"` Alert (`users.featureFlags.bulkNoChange`), never a toast.

### Permissions

`pages/UserPermissions.tsx`: the ADMIN per-user permission editor at `/users/:id/permissions` (the Users row menu's Permissions item, `userPermissionsPath` in `utils/userLinks.ts`), a
`UserFeatures.tsx` clone with the opposite polarity: one `Switch` per `PERMISSIONS` entry (`api/users.ts`, derived from `PERMISSION_TEXT`, which `satisfies Record<Permission, …>` against the spec's
`Permission` enum; checked = GRANTED, seeded from `UserResponse.permissions`). It saves the wholesale `PUT /users/{id}/permissions` (`updateUserPermissions`), then invalidates `["users"]` and
`["user", id]` and returns to `/users` with the `users.toast.permissionsSaved` toast. Labels and hints are `common.permission.*` / `common.permissionHint.*` (EN/PL).

- A permission is NOT in the session (`api/session.ts` stores roles and disabled features only): it is read server-side per request, so a change needs no re-login and the SPA never gates on it; a UI
  that needs "can this caller rank" reads the server's `can` flags (the planning views).
- A new spec `Permission` value is a compile error in `PERMISSION_TEXT` until it has its label/hint keys (then its two `common` entries).
- The wholesale PUT carries over any granted value the page has no switch for (a newer server), so a save can never silently revoke it.

Pinned by: `Users|CreateUser|EditUser|FeatureFlags|UserFeatures|UserPermissions.test.tsx`, `api/users.test.ts`; the real browser is `e2e/tests/users.spec.ts`.

## Jira connections

Files: `pages/JiraConnections.tsx`, `JiraConnectionDetails.tsx`; `api/jira.ts`, `api/sync.ts`; `components/Jira*.tsx` (the editor modal, the Connection, Mapping, Coverage and Bindings sections, the
mapping editor, discovery report, Peek, key links, stub badge) and the pieces Flow shares (`ConnectionDetailsPage`, `SyncStatusBadge`, `LastRunCell`, `SyncFacts`, `ConnectionTest*`, `SyncRunsTable`,
`TrailingLinkIcon`, `PollingFields`); `hooks/useSyncRuns.ts`, `useBoundedPoll.ts`, `useNow.ts`; `utils/jiraForm.ts`, `jiraMappingForm.ts`, `jiraFailure.ts`, `syncRuns.ts`, `syncStatus.ts`,
`connectionTestRows.ts`, `pollingForm.ts`.

`/integrations/jira` (nav: Administration, **ADMIN only**, `IconPlugConnected`, palette "Jira"; both routes sit under `RequireAdmin` and their queries are `enabled: isAdmin()`) is the registry of the
Jira Cloud sites Astrolabe OBSERVES (nothing is ever written to Jira). `/integrations/jira/:id` is a thin adapter over the shared shell `ConnectionDetailsPage` (route-id parse keyed by `:id`, load
triage, header with Edit, sections column, editor modal; it takes `kind`, the list path, the read, a `sections` render slot and the `Editor`; the Flow page is its twin).

### The registry

`GET /integrations/jira/connections` under `["jira","list",…]`: the Teams shape (`usePagedSort` + `RegistryListTable`, no name filter: the endpoint has none).

- **Columns:** name (the link, a gray "Disabled" badge), site (an external link, `rel="noopener noreferrer"`, its trailing icon `TrailingLinkIcon`, also the Jira key link's, Flow's and the Roadmap
  flag panel's), project keys, last test, **Status**, last run, kebab Open / Edit / Delete.
- **Status** is `SyncStatusBadge` over the connection's server-derived `status` (`SyncStatus`: nothing is stored; CURRENT green, FAILED red, STALE orange, NEVER_SYNCED / DISABLED gray, label
  `sync.status.<STATE>`) with a secondary line from `utils/syncStatus.ts`: the failure streak while there is one ("3 failures in a row · TOKEN_UNREADABLE", plural forms EN/PL), else "not polled: test
  the connection first" (`discoveredAt == null`), "manual only", "due now" or "next poll in 7 min" (minutes rounded UP, hours from 2 h). `now` is `hooks/useNow.ts`'s minute-ticking client clock (the
  telemetry section passes the server's `generatedAt`), a wording only: no decision rests on it. `useNow(period, readAt)` floors the clock at the query's `dataUpdatedAt`, and a connection whose
  `nextPollAt` has passed reads "due now" alone (no clock time).
- **Last run** (`LastRunCell`, shared with Flow) is the connection's own `lastRun` (`{id, startedAt, finishedAt, outcome, errorCode, running}`, null before its first run; the SERVER reads it for the
  page's rows, scoped to the connection): an outcome badge and when it started, "—" for none.
- **Re-reads.** The list's `refetchInterval` is `listRefetchInterval` (`utils/syncRuns.ts`, shared with Flow). While any listed connection's `lastRun.running` is set the list is re-read at the same
  bounded poll as the run table (`useBoundedPoll`). **Open pages follow the scheduler:** the list, the connection and its runs (`useSyncRuns(..., IDLE_REFRESH_MS)`) are also re-read every 30 s while
  the tab is visible, even after the fast poll's safety net stopped, so a scheduled run, or a run the server stopped calling running, reaches an open page; Refresh now's claim settling re-reads all
  three.
- **Delete** goes through `useDeleteConfirm` + `ConfirmDeleteModal` (never `window.confirm`); its body (`DeleteBody`) says the connection's links between plan items and Jira items are unlinked (the
  server does it in the same transaction), with the count of LIVE-node links from `GET /integrations/jira/bindings?connectionId=&pageSize=1` (`total`; that list hides dead-node bindings, so the
  sentences say "live plan items" and never claim there is nothing else; a count-less sentence while it loads or fails). A new connection lands on its page.

### The editor

`JiraConnectionEditorModal` creates and edits (rules in `utils/jiraForm.ts`, mirrored from `JiraConnection.kt`; the 409 marks the name). A 400 on save shows the server's sentence under the fixed lead.

- **Write-only token, read-only site, full-replace PUT** (`web/CLAUDE.md`'s integration-page rules): the token field is a password field with `autoComplete="new-password"`, on edit the hint is "A
  token is stored. Leave blank to keep the current token" (from `hasApiToken`) and a blank field is OMITTED from the PUT (a typed one rotates it); a PUT with another site is a 409.
  `toJiraConnectionRequest` always sends `authScheme`, `enabled` and **`pollIntervalMinutes` (the number, or an explicit `null` for manual
  only: never omitted, an omitted member resets the server to 15; pinned in `jiraForm.test.ts` and the editor's rename round trip)**.
- **Polling** `Fieldset` (`PollingFields`, `utils/pollingForm.ts`, both editors'): a `NumberInput` 5..1440 step 5 (default 15, `clampBehavior="none"`: a 3 or 2000 is refused with the rule's sentence,
  never clamped on blur) and a "Manual only (no polling)" `Checkbox` that disables it and sends `null`; unticking brings the number back.
- **"Test connection"** in the modal needs the name too (the server's probe body requires it) and probes with the form's values (an ad-hoc call with the token in the body) unless editing with a blank
  token, which probes the STORED connection and refreshes `["jira"]`. While the form's account, scheme or keys differ from the saved ones, a note says the stored probe tests the SAVED settings
  (`probeSettingsDiffer`, the server's own last-test invalidation set).
- A saved edit that cleared the verdict says "Not tested since the connection was last changed" (`untestedKey`; the verdict cell of the facts table and of the list is `ConnectionTestBadge`, shared
  with Flow: `layout="fact"` date then badge, `layout="row"` badge then date), and the toast asks for a new test.

### The connection page

`/integrations/jira/:id` has h3 sections inside `Box maw={CONTENT_MAX_WIDTH}`, each a component of its own so the page stays a composition: **Connection**, **Mapping**, **Coverage** and the bindings
list (`JiraBindingsSection`: "The bindings list" under "Deviations, bindings and the Jira chips").

- **Connection** (`JiraConnectionSection`): the facts table (the token only as "stored / not stored"; **Status** (the badge), **Last success** (the date and `ageText`), **Next poll** and **Polling**
  ("every 15 min" / "Manual only")), **Test connection** on the STORED token, **Refresh now**, and the runs table.
  - The verdict is also said in a polite status region (`ConnectionTestStatus`), and an old result is cleared the moment a new attempt starts. The result is `ConnectionTestResults` (Flow's, ported):
    one row per probe, a passing row GREEN, a failed required row RED, a failed optional one ORANGE, a row the server did not run (`SKIPPED`, after a failed `tenant_info`:
    `utils/connectionTestRows.ts` `isSkipped`) a gray "Skipped" that the status sentence does not count as a failure, the failure in words with its code kept visible and the scope the probe needs.
  - **The note "a 401 on one probe while `myself` passes = a missing scope, not bad credentials"** shows exactly then; `recorded: false` says the result was dropped because an edit raced it. A test
    refreshes `["jira"]` (the discovery, the mapping defaults and the verdict moved).
  - **Development stub:** `connection.stub` (derived by the server per response, never stored: the stub is configured AND the site's label starts with `stub-`) shows a gray "Development stub" badge
    (`JiraStubBadge`) after the site in the registry's site cell and in the connection facts, and `result.stub` shows a gray `role="note"` Alert under a Jira test result (`jira.test.stubNote`); the
    polite status sentence is unchanged. The editor's site hint stays free of the dev convention (production users must not read it).
- **Mapping** (`JiraMappingSection`): "Test the connection first" until `connection.discoveredAt` is set (no empty form, no discovery request), then the discovery report, the editor and Peek.

### Runs and Refresh now

**Refresh now** is `POST /integrations/sync/runs {kind: "JIRA", connectionId}` (`api/sync.ts`): the 202 claims a run and `useSyncRuns` POLLS `GET /integrations/sync/runs?kind=JIRA&connectionId=`
(`refetchInterval`, `RUN_POLL_MS` 3 s) **only while the SERVER says a run is running (`run.running`), and stops when it ends and when the page unmounts.** The button is disabled while a run is running
(the POLLED runs list's verdict, the connection's own `status.lastRun.running` only until the list arrives; whoever started it), and when that run ends the connection and the registry are re-read.

- **`running` is the server's verdict** (unfinished and younger than `sync.maxRunMinutes`; one rule, `SyncRunService.isRunning`, shared by the run list, the connection's `lastRun` and the Deviations
  view); the client never judges a run's age by its own clock. The one client-side bound is a safety net: the poll stops `RUN_POLL_MAX_MS` (10 min) after the page first saw the newest running run,
  latched on that run's id (`useBoundedPoll`), so a NEW claim after the bound polls again.
- **A `409 run-in-progress` is a normal state** (`isRunInProgress`; now only a race, since the button waits for a running run): a plain-text note "already running" while the server still says a run is
  running, never a red alert or a toast.
- **`SyncRunsTable`** names the trigger (Manual / Scheduled) and reads the outcome honestly: SUCCEEDED (green) / FAILED (red) / ABANDONED (orange) from `outcome`, an unfinished row as "Running" (gray)
  or "Interrupted" (orange; "No result was recorded and nothing is running it now": no claim about what happens next) by the server's `running`, the counters, `errorDetail` as clamped plain text, and
  `errorCode` as `errorCodeText` (`utils/syncRuns.ts`): a human EN/PL sentence with the code kept visible.
- **The failure-code sentences** are typed over the spec's `SyncFailureCode`: `ERROR_CODE_KEYS` (`utils/syncRuns.ts`) is a `Record` over the declared list, so a code added to or renamed in the spec
  fails `tsc` until its sentence key is added. `SKIPPED` points at `sync.test.skippedDetail` (a skipped probe row is worded by the test table itself) and `TIME_ZONE_INVALID` at
  `flow.errorCode.TIME_ZONE_INVALID`. `FLOW_ERROR_CODE_KEYS` is a `Partial` override over the same codes; a code it does not word reads as the shared sentence. `errorCodeText` takes a `string`, and a
  code the list does not know reads as itself. The `errorCode.*` table is shared by the probe rows and the runs.

### The mapping editor and the discovery report

`JiraMappingEditor` (pure model in `utils/jiraMappingForm.ts`): a `Fieldset` each for Program / Project / Milestone.

- A level `Select` over the DISCOVERY's levels labelled "Level 1 — Epic" (the type names), clearable for program and project (unset = null in the document), required for the milestone, and three field
  `Select`s: start and end offer only `date` fields, the estimate only `number` fields (`fieldOptions`). The discovery's default is marked "(default)" in the option LIST and as a short "Default" note
  under the select, never in the closed value (a narrow column would cut it off); labels are name and id only.
- The form opens on the SAVED mapping, else on the `defaults`; turning a level on fills its fields from the defaults; "Use the defaults" restores them. Estimate unit POINTS / HOURS / DAYS + the
  man-days-per-unit factor (**hidden and not sent for DAYS**: the server ignores it; 0 < x <= 1000, two decimals), and the Team field (the site's `atlassian-team` field).
- **A saved mapping that no longer fits the site stays displayable and fixable:** the GET's `problems[]` are amber lines (one orange `role="note"` list), and a stored level or field the discovery no
  longer offers stays a flagged option ("Level 5 (not on this site)", "customfield_9 (not found on this site)", "(a number field, not valid here)") instead of being dropped.
- Client rules are the shape rules only (milestone required, levels strictly decreasing, the factor); everything that needs the discovery is the server's: a `400` shows the server's own sentence (it
  names the level or field) under a fixed lead, `409 jira-not-discovered` / `jira-token-unreadable` are told in words.
- **The discovery report** (`JiraDiscoveryReport`) is what the first real-site test reads: counts, the levels, one green line per assumption marker found (Target start / Target end with the
  `schema.custom` that identified them, Start date, Due date, story points, Team) and an AMBER line for each NOT found, plus a gray line for a legacy Epic/Parent Link field.

### Peek and the Jira key links

- **Peek** (`JiraPeek`): an issue-key field with the `ISSUE_KEY_PATTERN` check, `GET …/peek?key=`, the result as ONE table (the issue with `JiraKeyLink`, what the mapping resolves, the raw values). A
  result belongs to the mapping it was read under (`resetKey`: the saved mapping and the discovery), so a save or a new test hides it while the typed key stays. The raw values are arbitrary JSON and
  are rendered as TEXT NODES only (a string as is, anything else as clamped JSON). 400 / 404 / 409 / 429 / 502 show inline.
- **One failure mapper:** the status table of Peek, of the bind dialog (`utils/jiraBind.ts` `bindFailure`) and of the import modal (`utils/jiraImportText.ts` `importFailure`) is `utils/jiraFailure.ts`
  `jiraFailure(err, t, keys)` giving `{ message, detail? }` (each dialog passes its own key table; `detailFor` lists the statuses that carry the server's sentence, the 400 alone by default;
  `upstreamCode` lives there only). The problem-type branches (409 `already-bound` / mapping / discovery / token) and the import's apply and timeout preamble stay with each dialog.
- **`JiraKeyLink`** (Flow's, ported) takes the connection's `siteUrl`: an external link `{site}/browse/{KEY}`, `target="_blank" rel="noopener noreferrer"`, plain text when the site is not `https://`.
- **`JiraKeyWithPrevious`** is the key cell of the connection page's bindings list (`observation.issueKey`) and of the Deviations Jira cell (`jira.previousKey`): the current key as the link and, only
  when the key the issue was last read under differs (a moved item), a muted "was OLD-1" / "wcześniej OLD-1" beside it, the pair a `role="group"` named "NEW-1, was OLD-1" (`jira.link.was`,
  `jira.link.keyWas`); the timeline chips show the current key only.

### Coverage

`JiraCoverageSection`, between Mapping and the bindings list: `GET …/{id}/coverage` (query key `["jira","coverage",id]`, so a binding change, a Test, a mapping save and a finished run all refresh it;
the Connection section's effect notices a run either as the live-to-idle edge or as the NEWEST run's id or `finishedAt` moving between two polls, so a short run between two idle polls still re-reads
the counts) as a real table named "Coverage per level" (column headers; the level word is the row header): one row per mapped level with the in-scope, linked and open-and-unlinked counts
right-aligned, no colour (a count is not a verdict), and a dimmed "Counted as of the last successful synchronisation, … (UTC)" line from `readAt` (the last successful run's finish). `NOT_SYNCED` says
"Not synced yet", `MAPPING_UNUSABLE` a gray note and `MAPPING_CHANGED` ("The mapping changed since the last synchronisation … Use Refresh now to count them") likewise, each instead of a table (never
zeros); a failed read is the inline `ErrorAlert`.

The co-located `Jira*.test.tsx` (the pages, the editor, the mapping editor, the report, Peek, Coverage), `Connection*`, `SyncRuns*`, `SyncStatusBadge`, `useSyncRuns.test.tsx` (fake timers, incl. a second claim after the bound), `useNow` and the `utils/` tests; shared fixtures in
`test/jira.ts`.

## Flow connections

Files: `pages/FlowConnections.tsx`, `FlowConnectionDetails.tsx`; `api/flow.ts`; `components/FlowConnectionEditorModal.tsx`, `FlowConnectionSection.tsx`, `FlowTeamsSection.tsx`; `utils/flowForm.ts`,
`flowLinks.ts`, `flowRefresh.ts`; the shared pieces are listed under "Jira connections".

`/integrations/flow` (nav: Administration after Jira, **ADMIN only**, `IconActivity`, palette keywords `flow capacity roster`; both routes under `RequireAdmin`, queries `enabled: isAdmin()`) is the
registry of the Flow instances Astrolabe READS team capacity and rosters from (nothing is written to Flow), `GET /integrations/flow/connections` under `["flow","list",…]`: the Jira registry's twin
(`usePagedSort` + `RegistryListTable`).

- **Columns:** name, base URL, time zone, last test (`ConnectionTestBadge`), **Status** (`SyncStatusBadge`, `ready` = `flowReady`: a passing test or a mirrored document, the server's sticky rule),
  last run (`LastRunCell`), kebab. The same slow re-read (`IDLE_REFRESH_MS`) and bounded poll while a run runs (`listRefetchInterval`, one rule for both lists).
- `/integrations/flow/:id` is a thin adapter over the same shell (`ConnectionDetailsPage`, see "Jira connections") with two h3 sections: **Connection** (`FlowConnectionSection`: facts via the shared
  `SyncFacts`, Test connection on the STORED token, Refresh now = `POST /integrations/sync/runs {kind: "FLOW"}`, `SyncRunsTable kind="FLOW"`) and **Teams** (`FlowTeamsSection`, below). A test writes
  NO mirror (the run does), so the Teams section follows a run's end, not a test.
- **The shared pieces are kind-aware, never forked:** `ConnectionTestResults kind="FLOW"` words the probes (`flow.probe.*`), adds the document's size and the truncation note and has no Jira scope
  note; `errorCodeText(code, t, kind)` (`utils/syncRuns.ts`) has the Flow table (`flow.errorCode.*`, the revoked-token sentence tells to issue a new token in Flow) and falls back to the shared
  sentences; `useSyncRuns`/`syncRunsKey` cache Flow's runs under `["flow"]`, Jira's under `["jira"]`.
- **Strings.** The generic connector vocabulary lives in `sync.*` (`web/CLAUDE.md`'s i18n rules); `jira.test.scopeHint/scopeNote/stubNote/cloudId` stay Jira-only, and the Polling labels and rule live
  in `common.polling.*` (`PollingFields`, `utils/pollingForm.ts`, used by both editors).

### The editor

`FlowConnectionEditorModal` (rules in `utils/flowForm.ts`, mirrored from `FlowConnection.kt`):

- **The base URL is the connection's identity** (read-only on edit) and is written canonically when the field is left and before every send (`normaliseBaseUrl`: lowercase, default port and trailing
  slash dropped; a path, query or credentials are NEVER cut, the form refuses them). Whether the origin is one the OPERATOR listed is the server's 400, shown with its own sentence under the fix
  (`NOT_CANONICAL` "the origin alone, in lowercase…" and `NOT_LISTED` "not one of the Flow origins this server is configured to allow…"; a port is never the reason). The create form reads
  `GET /integrations/flow/origins` under `["flow","origins"]` (create only, ADMIN) and prints "Allowed on this server: …" after the hint (`allowedOriginsHint`; the plain hint while loading or when the
  read fails, a "no Flow origin is configured" note for an empty list).
- **The time zone** is a text field pre-filled `Europe/Warsaw` (Flow's metrics zone) checked by `canonicalTimeZone` (`utils/flowForm.ts`): `Intl.supportedValuesOf("timeZone")` when the engine has it,
  the formatter plus a region's shape otherwise; a bare offset is refused.
- **Token and PUT** follow the Jira editor's rules (write-only: `PasswordInput`, `autoComplete="new-password"`, shape `flow_int_` + 43 characters, a blank one omitted from the PUT; full replace:
  `pollIntervalMinutes`, default **60** or an explicit `null` for manual only, always travels).
- A new token or zone clears the server's verdict, so the toast asks for a new test (`clearsVerdict`). There is no Jira-style "saved settings" note: the stored probe (blank token) tests the SAVED
  token and zone (the zone feeds the sprint read).

### Teams section

`GET /integrations/flow/teams?connectionId=` under `["flow","teams",id]` (unpaged, any signed-in user, re-read every `IDLE_REFRESH_MS` and when a run ends): the mirror's teams with membership and
sprint counts, the linked Astrolabe team (a link to its page) with Unlink (an in-page `ConfirmDeleteModal`, never `window.confirm`; "capacity already imported stays"), or the server's UNIQUE
suggestion with **Link** (`POST /team-bindings`), **Link all suggested** (`POST …/team-bindings/match`, ADMIN; the outcome is a polite status line "N linked, M without a unique match, K linked
already"), and when the mirror was read; before the first run it reads "Refresh the connection first". The suggestion is the server's, never computed here. A disabled connection links nothing (a note;
the server answers 400).

- A refused link shows a fixed lead and, for a 409 `already-bound` or a 400, the server's sentence, and re-reads the list.
- A link or unlink refreshes the Flow lists, team panel, deviations, plan and Roadmap families through `refreshFlowLinks`.

The co-located `Flow*.test.tsx` (the pages, the sections, the editor), `PollingFields.test.tsx` and the `utils/` tests; shared fixtures in `test/flow.ts`.

## Changelog and app versioning

Files: `pages/Changelog.tsx`, `changelog/entries.ts`, `changelog/version.ts`, `components/MarkdownView.tsx`, `VersionStamp.tsx`, `hooks/useChangelogSeen.ts`.

The user-facing changelog is a **build-time artifact** (no DB, no API; it changes only with a deploy). `entries.ts` holds `ChangelogEntry` rows (`version`, `date` `YYYY-MM-DD`, `en`/`pl` **markdown**
bodies), newest first. The app's only human-readable version is `APP_VERSION` in **`changelog/version.ts`**, its own tiny module so the shell's eager imports (VersionStamp, the what's-new dot) never
pull the bilingual entries into the main bundle (the entries ride the lazy Changelog chunk only).

- **A release** = the new entry at the top of `entries.ts` + the bump of that one literal (the Gradle `1.0.0-SNAPSHOT` is unrelated); `entries.test.ts` pins `CHANGELOG[0].version === APP_VERSION`.
  Dates stay descending (same-day releases are fine: newest stays on top), versions unique and both bodies non-empty.
- Bodies are *content*, so they live in the data file, not `locales/`. Keep phrases that tests assert on in plain text runs: markdown formatting splits text nodes, and testing-library's `getByText`
  matches direct text nodes only. The release convention itself (the tag, the GitHub release, which PRs bump the version) is `web/CLAUDE.md` and `app-releases.md`.

### Rendering and UI wiring

- `pages/Changelog.tsx` (`/changelog`, authenticated, lazy) renders the entries as a Mantine `Timeline` with `MarkdownView` bodies in the viewer's language and calls `markChangelogSeen()` on mount.
  **Bodies are authored EN+PL only, by policy:** a new shipped UI language does NOT add changelog fields; non-authored languages read the English body (`AUTHORED_LANGUAGES` in the page).
  `MarkdownView` (Typography + react-markdown + remark-gfm/gemoji, all lazy-chunk-only deps) is the one markdown renderer: reuse it for future markdown content.
- `VersionStamp` shows `v<APP_VERSION> · <sha> · <time>`; its optional `to` prop renders it as a router link: the navbar footer instance links to `/changelog`, the Login/AuthCard instance deliberately
  stays plain (the route is behind auth). The "Changelog" entry is an `ACCOUNT_NAV` leaf (the `UserMenu` and the palette), not a sidebar item.
- The **"what's new" dot** is a red Mantine `Indicator` around the header `UserMenu` trigger (it carries the `title="What's new"` e2e locates; the Changelog menu item shows a text badge instead of a
  second title, which would trip strict-mode locators while the menu is open), shown while localStorage `astrolabe.changelog` (`{seenVersion}`) differs from `APP_VERSION`. It is driven by
  `useChangelogSeen` via `useSyncExternalStore` over a module-level listener set: do **not** replace that with a plain localStorage read in state (the shell renders before the page's mark-seen effect,
  so the dot would only clear on the next navigation). The seen-state is device-level (survives logout, like `astrolabe.lang`) and hand-rolls its guarded read/write, not `useStoredState` (that hook
  owns the `astrolabe.viewSettings.*` namespace).

Pinned by: `pages/Changelog.test.tsx`, `changelog/entries.test.ts`, the dot/nav cases in `App.test.tsx`, the link/prefix cases in `components/VersionStamp.test.tsx`.

### The Jira and Flow release-note caveat

`web/CLAUDE.md` "Changelog & app versioning" binds the English wording (which entries carry the stub caveat); the Polish lines and what the import's note may claim are here.

- **Jira** (until `jira-sync.md` "First real-site walk-through" is done): the line of `web/CLAUDE.md`, in Polish "Sprawdzone na wbudowanej atrapie Jiry; jeszcze nie przetestowane na prawdziwej
  witrynie Jira."
- **The import** carries the same caveat; its release note and its pages say that a name renamed in Jira previews as a new item, that an existing plan item is never overwritten and that dates are
  copied only where the caller manages the team, and must not claim more. An owner's entry points are the Plan page's work-stream menu, a linked program's menu, a linked project's page and Plan row,
  and the connection page's program and project rows; a new project's target window comes only from Jira's two dates; renamed items are not matched.
- **Flow** (until `flow-sync.md` "First real-Flow walk-through" and its ledger are done): the line of `web/CLAUDE.md`, in Polish "Sprawdzone na wbudowanej atrapie Flow; jeszcze nie porównane z
  prawdziwym Flow."; the Deviations section and the team page's line promise nothing a stub cannot prove.

## The telemetry panel

Files: `components/Telemetry*.tsx`, `hooks/useTelemetryPanel.ts`, `utils/telemetry*.ts`.

The ADMIN telemetry panel (the shell's right-hand aside: memory, storage, **sync**, requests, JVM; `GET /api/v1/telemetry/history?group=` for the charts and one process role, `app`:
`utils/telemetryRole.ts`) is the only chart surface.

- **Sync** (`TelemetrySyncSection`; the `sync` block of `GET /telemetry/current`, no history/trend) is whether this process runs the scheduler and, per connection, the state badge, the last success's
  age (against the server's `generatedAt`), the failure streak with the newest run's code, the next poll and the interval; it shares `SyncStatusBadge` / `utils/syncStatus.ts` with the Jira pages.
- **`components/TableDisclosure.tsx`** is the collapsible accessible-table twin of a chart; use it for every chart that carries data a screen-reader user needs.

## Internationalization

The rules (resources, typed keys, `common.*`, parity, Polish voice, English in tests): `web/CLAUDE.md` "Internationalization". The mechanics:

- **Resources.** `src/locales/{en,pl}/<area>.json`, one file per area (`common` is the shared one), merged by `i18n.ts` into one `translation` namespace. Only EN is statically imported; every other
  language is auto-discovered from `locales/<lang>/` via `import.meta.glob`. Bundles are eager on purpose; move non-EN to lazy loading when a 3rd language ships or a bundle grows large.
- **Keys are typed:** `src/i18next.d.ts` augments i18next's `CustomTypeOptions` with `typeof en` from `i18n.ts` (the `@public`-tagged export: knip can't trace the d.ts consumer), so every `t()` call
  and `i18nKey` is compile-checked against the EN tree: a typo or removed key fails `tsc`/`npm run build`. The `NavLeaf` `label` in `utils/navigation.ts` is the `ParseKeys` pattern.
- **`common.*`** includes `common.dateFormatHint`, the date-input placeholder: `YYYY-MM-DD` in EN, `RRRR-MM-DD` in PL.
- **Parity.** `locales/parity.test.ts` auto-discovers language folders, requires every English key in each (language-specific plural variants are expected) and pins folders == `SUPPORTED_LANGUAGES`.

### Adding a language

A complete `locales/<lang>/` folder (every area file, parity-gated) + one code in `SUPPORTED_LANGUAGES` (`i18n.ts`) + one `NATIVE_LANGUAGE_NAMES` line: the Record type and the parity test each fail
loudly on a missed step. Server-side, the `LocalizedText(en, pl)` constructor arity is the parity gate for email texts (a new language means a new parameter: every email text becomes a compile error
until translated), and `users/Languages.kt` mirrors `SUPPORTED_LANGUAGES`.

### The language switcher and the synced user language

The switcher is the Language section of `components/UserMenu.tsx` (the header account menu): `Menu.Item`s of NATIVE language names (`NATIVE_LANGUAGE_NAMES`, deliberate constants: readable before
switching, and `Intl.DisplayNames` yields lowercase forms). The choice persists in `localStorage` (`astrolabe.lang`) and updates `<html lang>` (`languageChanged` in `i18n.ts`).

- **The user language is ONE synced property** (V1's `language` column): the switcher also fire-and-forget saves it server-side (`setUserLanguage`; it drives every email sent to the user), and
  `persistSession` applies the login/refresh response's `language` to the UI: signing in restores it on any device, and an admin change propagates at the ≤15-min silent refresh. Emails render in the
  RECIPIENT'S stored language (`LocalizedText(en, pl)` in `infra/mail/`, EN fallback).


## Theming

The rules (restrained cyan, neutral defaults, success green, overlay close names, `ScrollRegion`, the listbox as scroller): `web/CLAUDE.md` "Theming". The numbers and mechanics: `src/theme.ts` +
`src/themeVariables.ts` + `src/theme.module.css` are the single source and `src/theme.test.ts` guards every contrast ratio.

- **The brand** is the 10-stop **`astrolabe` cyan tuple** (`#e3fafc … #0b7285 #095c6b`: Mantine's cyan shifted one step deeper) with `primaryShade: { light: 8, dark: 9 }`: Mantine's own shade 7/8 pair
  falls short of 4.5:1 for white text on this hue (white on shade 8 is 5.6:1, on shade 9 7.6:1, pinned in `theme.test.ts`), and `autoContrast: true`.
  - Cyan marks only primary CTAs, the active nav item (a light tint + a 3px accent bar) and focus (chart series colours are `utils/chartColors.ts`'s); everything else is neutral by theme default
    (tables `verticalSpacing="xs"`, ≈40px rows), and pages never pass those props back.
  - GREEN is the SUCCESS colour, red the BLOCKING one, orange the warning one (soft findings, waived); the ADMIN role badge is `variant="outline" color="gray"`. **Never use teal for success:** its
    tints are near-identical to the cyan brand's; `theme.test.ts` pins the CIEDE2000 distance between the brand and success tints (≥ 10) and fills (≥ 20).
- **Surfaces.** `theme.module.css` is scheme-aware via `light-dark()` throughout. Every `Table` inherits the card frame, hoverable rows and neutral compact header from the theme's `Table.extend`.
  **The hover tint is theme-owned and AA-tested too** (`tableHover` in `themeVariables.ts`, applied by `table.table` in `theme.module.css` as `--table-hover-color`; light gray-1 `#f1f3f5`, dark dark-6
  `#2e2e2e`, because Mantine's own dark-5 left dimmed text at 4.44:1): `theme.test.ts` pins that every table ink clears 4.5:1 on it in both schemes and that it stays ≥ 1.1:1 against the row. The e2e
  axe scan of hovered rows is in `accessibility.spec.ts`.
- A soft diffuse `shadows` scale and tightened heading sizes; Inter is bundled (`@fontsource-variable/inter`, imported in `main.tsx`): same-origin for the CSP `font-src 'self'`, the system stack the
  fallback.
- **Overlay accessibility** (pinned by the e2e axe sweep over dialogs): `OneTimePasswordModal` is the one dialog with `withCloseButton={false}`. An OPEN row menu is scanned too (the `accessibility`
  spec opens the Teams, Baselines and roadmap menus, light and dark): its dropdown is white / dark-6, and `theme.test.ts` pins the destructive ink and tint on those surfaces.
- **`ScrollRegion`** (`components/ScrollRegion.tsx`): a native scroller, `tabIndex={0}`, `role="region"`, the table's own i18n name as `aria-label`, the `tableScroll` focus ring; axe's
  `scrollable-region-focusable` fails any overflowing table without it.
- **An option list is a scroller too, and the LISTBOX is the scroller.** The theme gives every `Select`/`MultiSelect`/`Autocomplete`/`TagsInput` `withScrollArea: false` and `classNames.options`
  (`theme.module.css` `.comboboxOptions`: `max-height: calc(13.75rem * var(--mantine-scale)); overflow-y: auto`). Mantine's default inner `ScrollArea` viewport is a plain scroller inside the
  `role="listbox"`: axe's `scrollable-region-focusable` flags it once ~100 options overflow, and a tab stop on it puts a focusable non-option in the listbox (`aria-required-children`). axe exempts
  exactly the element that IS a combobox popup, so the listbox scrolls itself; the input keeps DOM focus and `aria-activedescendant` scrolls the active option into view. Pinned by the overflow +
  keyboard + axe test in `e2e/tests/dependencies.spec.ts`.

### Colour tokens

- **Colour tokens are AA-tested** (`themeVariables.ts`, ported from Lettuce): `LIGHT_TOKENS`/`DARK_TOKENS` (text, dimmed, canvas, border, table hover, error inks) and `LIGHT_VARIANT_INKS` (the per-hue
  ink over a `variant="light"` surface: Mantine's stock light-scheme ink fails 4.5:1 for several hues) go in through `cssVariablesResolver` in `main.tsx`. Never hand a shade-suffixed colour
  (`"orange.8"`) to a light Badge/Alert: the tint comes from the hue, the ink from this map.
- **`--astrolabe-accent-ink`** is the brand hue where it must be PERCEIVED against the canvas (the nav marker, the anchor hover underline, focus): the light primary (deep cyan `#0b7285`) in light
  mode, the 4-shade (`#3bc9db`) in dark mode. The light-variant ink for the brand hue is `#095c6b`.
- Success GREEN has the ink `#236b34`; the colour vocabulary is `web/CLAUDE.md`'s.
- `utils/chartColors.ts` exports `CATEGORY_PALETTE` only (`astrolabe.6`, `violet.5`, `pink.6`, `indigo.5`, `gray.6`: categorical series, never semantic status colours).
- `index.css` repeats the two canvas hexes for the first paint (`public/color-scheme.js` stamps the scheme on `<html>` before the bundle loads); the theme test pins them equal to the tokens.

### The logo

`components/BrandLogo.tsx` selects `public/logo-{light,dark}.svg` for the app theme. The marks depict a mariner’s astrolabe with a suspension loop, a graduated rim, and a sighting rule over a wind rose and chart lines.
`web/index.html` declares `public/favicon.svg` as the single browser-tab icon for both themes. It keeps the loop, rim, and four-point rose legible at 16 px. Check the app logos and favicon in both colour schemes.
The geometry is computed: change it in a vector editor or regenerate it, not by hand-editing path data. Restyle rule: keep aria-labels, roles and real semantic elements stable, since e2e and unit tests locate by role/name.

## Not yet ported

When a feature needs one of these, port the sibling's `web/` implementation and its `web/CLAUDE.md` section wholesale:

- **Lettuce's** `safeBackParam` open-redirect guard for any future `?back=` param, `StatusPill`/`MetaStrip`/`FormFooter`/`ListToolbar` (`lettuce/web/src/components/`), and `useDiscardGuard` +
  `DiscardGuard` for dirty-form navigation (its in-app half is the data router's `useBlocker`, which the plain `BrowserRouter` does not have; port it, with the `beforeunload` half
  `hooks/useBeforeUnloadGuard.ts`, with the first dirty-form page, e.g. the capacity editor).
- **Covenant's catalog surface** (`covenant/web/src/`): the filter-set/facets pattern (`hooks/useContractFilterState.ts` + `components/ContractFilterControls.tsx`), the CodeMirror document editor,
  Save-anyway, and the reader/render-model views; port these only once the planning model needs a document- or finding-shaped list (today's Teams/Users lists are the
  `useRegistryListControls`/`Users.tsx` templates).

## Storage keys, Web Locks and shared reference

- **localStorage:** `astrolabe.auth.*` (session), `astrolabe.viewSettings.*` (`useStoredState`), `astrolabe.lang`, `astrolabe.changelog`. **sessionStorage:** `astrolabe.chunkReloadedAt` (the one-shot
  reload after a failed lazy chunk, `main.tsx`). **Web Lock:** `astrolabe.auth.refresh`. **CSS variables:** `--astrolabe-*`.
- **View settings** (`astrolabe.viewSettings.<key>`, each a `useStoredState` with its own validator): `appShell.navCollapsed`, `home.mine.ownOnly`, `telemetry.panelOpen|range|sections`, the list
  pages' `…filter.*` and `…filtersOpen`, and the timeline and planning keys below.
- **The Roadmap's six filter keys** (`roadmap.filter.workStream|team|owner|flagged|severity|unranked`) and `planning.programPick` are MEMORY, not state: the address holds the state and only the user's
  own change writes them ("The URL holds the filters" under "Roadmap"); the Programs page reads and writes `planning.programPick` alone on the same terms.
- **`projects.last`** (the project `/projects` opens; `projects-view.md`).
- **The Plan page's** `plan.collapsed` (folded node keys), `plan.pins`, `plan.pinnedCollapsed`, `plan.pinnedOpen` and `plan.filtersOpen` (`plan-tree.md`); its filters and focus are address-only.
- **Timeline view settings** (`timeline.*`, shared by the pages that show them): `zoom` (project, team), `planZoom` (roadmap, programs), `criticalPath` (project and team, default false;
  `hooks/useCriticalPathPick.ts`), `baseline` (all four, an id or none; `hooks/useBaselinePick.ts`), and **`jiraBars`** (all four pages; a boolean, **default true**: the "Jira dates" toggle of the
  Jira shadow bar, `hooks/useJiraBarsPick.ts`; a stored non-boolean reads as the default).
- The Polish user-facing noun for Users is "Użytkownicy/czki" (EN "Users").
