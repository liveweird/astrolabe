# Web internals (read on demand)

Mechanism and narrative text moved verbatim out of `web/CLAUDE.md` (B7 step 4) so that file stays a lean always-loaded-in-`web/` rule set. The binding rules (every never/must/always) stay in `web/CLAUDE.md` as one-liners; this doc holds the mechanics behind them. **Read the relevant section before changing the transport/session layer, the user/feature-flag pages, the language switcher, the colour tokens or logo, or the changelog wiring.**

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
  stored by another tab (same session identity, different refresh token) instead of replaying or clearing; a different login (new identity) is never adopted. **Why a 401 can now come at any time:** the server checks every access token against the user row per request (`security.md` "JWT model"), so a delete, a demotion/promotion, a password change or a logout elsewhere turns the NEXT request into a 401 (one text). The transport needs no special case: the 401 -> silent refresh -> retry path handles all of them - a role change refreshes successfully into the NEW roles (`persistRefreshedSession` republishes them and `notifyAuthChange` re-renders the nav and `RequireAdmin`, pinned in `http.test.ts`), a delete or password change makes the refresh a DEFINITIVE rejection and signs the user out. `ApiError` (status + parsed body; read
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
suspended or retried render cannot discard the notice. The flag carries a reason (`SignedOutReason` in `auth.tsx`: `sessionEnded`, the default, or `passwordChanged`; `pendingSignedOut()` reads it, `consumeSignedOut()` clears it) and `pages/Login.tsx` picks the notice from it. **The self password change signs the device out explicitly** (`pages/ChangePassword.tsx`): the PUT bumps the account's credential revision, which ends every access and refresh token including this device's, so after the success toast the page runs `clearSession()`, `flagSignedOut("passwordChanged")` and `navigate("/login", { replace: true })` (the notice reads "Your password was changed. Sign in with your new password."). No `/logout` call - nothing is left to revoke, and the stale access token would only 401; no broadcast, for the same reason as `UserMenu`'s sign-out.

### Password reset (confirm link)

`pages/ResetPassword.tsx` only REQUESTS a reset (a uniform 202: the server emails a single-use link and changes nothing). The link lands on `pages/ConfirmPasswordReset.tsx` at `/reset-password/confirm#token=…`, which is NOT behind `RedirectIfAuthed` (a signed-in device may finish a reset). The token travels in the URL fragment, so it never reaches a server log or a Referer: the page reads it once into component state, strips the fragment and any query from the address bar and history (`navigate(…, { replace: true })`), keeps it in memory only (never storage) and sends it to nothing but `confirmPasswordReset` (a plain `fetch`, never `authedFetch`, so it can never refresh or retry a session). Loading the page consumes nothing; the form shows for any well-formed 43-character token and an unusable one is learned at submit (401: the token is dropped and "Request another reset link" shows; 429, 400 and network failures keep it for a retry). The new-password rule is `newPasswordValidation` (`utils/flowUserForm.ts`), shared with `ChangePassword.tsx`. On success the page runs `clearSession()`, `queryClient.clear()` and `notifyAuthChange()` and shows the teal notice: no `/logout` call (the reset bumped the credential revision, so nothing is left to revoke) and no return destination.

## User management (`pages/Users|CreateUser|EditUser|ChangePassword.tsx`)

Passwords are generated client-side (`utils/password.ts`) and revealed exactly once: the modal
(`components/OneTimePasswordModal.tsx`) sets `closeOnClickOutside={false} closeOnEscape={false}`,
renders `components/RevealablePassword.tsx` (masked by default, eye toggle, copy), and closing
drops the plaintext from state for good — the server never returns it. The admin Reset-password
action (`hooks/useResetPassword.ts`) reuses the same generate→PUT→reveal flow. `NavLeaf.adminOnly`
gates the Users nav item (the Shell filters by `isAdmin()`); the management routes sit under ONE
`<Route element={<RequireAdmin />}>` in `App.tsx` (`auth.tsx`, beside `RequireAuth` — a regular
user is sent home), so no page redirects itself; their queries additionally stay
`enabled: isAdmin()` so a redirected caller fires no request. UX only — the server's
`requireAdmin` is the rule. The pages live under `/users` (`utils/userLinks.ts` is the one place the family is spelled out; Flow's `/flow-users` rename and its legacy `/users…` redirect do not exist here).

## Feature flags (`pages/FeatureFlags.tsx`, `pages/UserFeatures.tsx`)

Lettuce's per-user flag surfaces, ported with the MFA feature: `hasFeature()` (`api/session.ts`,
reading the `astrolabe.auth.disabledFeatures` localStorage set — currently awaiting its first
area-gating consumer; MFA gates only the login flow server-side), the per-user editor at
`/users/:id/features` (the Users table's Features button — a checkbox per `Feature`, wholesale-
replace PUT), and the ADMIN per-feature screen at `/feature-flags` (`adminOnly` nav leaf; state
filter + bulk enable/disable over every row matching the current filters behind a count-stating
confirm — `hooks/useBulkFeatureUpdate.ts` loops the same per-user wholesale PUTs client-side via
`ConfirmActionModal`). The page itself is only the query, the table and the single-row toggle; the rest sits in
co-located pieces: `hooks/useFeatureFlagFilters.ts` (the persisted filters), `hooks/useFeatureFlagBulk.ts` (the bulk run
wired to this screen), `components/FeatureFlagFilters|FeatureFlagBulk|FeatureFlagRow.tsx` and `utils/featureFlags.ts`
(`isFeatureEnabled`/`withFeatureEnabled`, the one place a disabled set is rewritten). A second `Feature` value needs no
restructuring: the feature `Select` already lists `FEATURES`. Both queries key under `["users", …]`. Mind the wholesale-replace
semantics: a PUT whose disabled set omits `MFA` ENABLES it. A bulk run with nothing to change is neither
success nor failure: it shows the inline gray `role="note"` Alert (`users.featureFlags.bulkNoChange`), never a toast.

## Permissions (`pages/UserPermissions.tsx`)

The ADMIN per-user permission editor at `/users/:id/permissions` (under the one `RequireAdmin` route; the Users row menu's Permissions item, `userPermissionsPath`
in `utils/userLinks.ts`) — a `UserFeatures.tsx` clone with the opposite polarity: one `Switch` per `PERMISSIONS` entry (`api/users.ts`, derived from `PERMISSION_TEXT`, which `satisfies Record<Permission, …>` against the spec's
`Permission` enum; checked = GRANTED, seeded from `UserResponse.permissions`), saved as the wholesale `PUT /users/{id}/permissions` (`updateUserPermissions`), then
`["users"]` and `["user", id]` are invalidated and the page returns to `/users` with the `users.toast.permissionsSaved` toast. Labels and hints are
`common.permission.*` / `common.permissionHint.*` (EN/PL). A permission is NOT in the session (`api/session.ts` stores roles and disabled features only): it is read
server-side per request, so a change needs no re-login and the SPA never gates on it — a UI that needs "can this caller rank" reads the server's `can` flags
(the planning views). A new spec `Permission` value is a compile error in `PERMISSION_TEXT` until it has its label/hint keys (then its two `common` entries). The wholesale PUT carries over any granted value the page has no switch for (a newer server), so a save can never silently revoke it.

## People (`pages/People.tsx`, `pages/PersonDetails.tsx`)

The people directory (V10), a Teams clone under Administration after Teams, **visible to everyone** (reads are open, emails included): `useRegistryListControls` + `RegistryListTable`
(Name link, Email, Login), ADMIN-only New/Edit/Delete through `components/PersonEditorModal.tsx` (name, optional email, optional Login — `components/UserSelect.tsx`, an ADMIN-only users
search). A list row carries every field of the detail, so Edit takes the row as it stands (no detail fetch). `components/PersonSelect.tsx` is the owner/manager picker
(`["people","picker",term]`, enabled for every session, options `name (email)` or `name`); it and `UserSelect` are thin wrappers over `components/SearchPicker.tsx` (debounced server-side
search, the picked entry held by the caller). A 409 on save marks the email field, or the login field when the server's detail says the link is taken. The family is spelled out in
`utils/peopleLinks.ts`; the team editor's manager is a person (`managerPersonId`). `PersonSelect` also takes `disabled` and `error` (the plan editors' Owner: read-only for a caller who may edit only another part of the modal, and the required-owner message).

## Public holidays (`pages/PublicHolidays.tsx`, v0.7.0)

Flow's holiday page ported (its `ColumnTable` is a plain `Table` in a `ScrollRegion` here), a leaf of the Administration section after People that **everyone sees** (reads are open, like Teams and People). Files: `api/calendar.ts` (`listPublicHolidays` unwraps `{items}`; `createPublicHoliday`, `deletePublicHoliday`, `applyHolidayPreset`; the types are the spec's `PublicHolidayResponse`/`HolidayPresetResponse`), `hooks/useHolidays.ts`, `utils/publicHolidays.ts` (Flow's helpers: `holidayYears`, `holidaysOfYear`, `weekdayName`, `localYear`, `yearOf`), `utils/calendarLinks.ts` (`publicHolidaysPath`), `locales/{en,pl}/calendar.json`.

- **ONE cached query, two consumers.** The dictionary is `["calendar","holidays"]` (`HOLIDAYS_QUERY_KEY`, `staleTime` 1 min, so another admin's edit reaches a mounted page soon). The page reads it with its own `useQuery` on that key; every timeline component (`ProjectTimeline`, `TeamTimeline`, `RoadmapTimeline`, `ProgramsTimeline`) and `MilestoneScheduleModal` read it through `useHolidays()` = `{holidays, failed}`: `[]` while loading or on a failure (the holiday layer is decoration and the schedule pre-check is only a pre-check; the server's views and 400 are the rule), `failed` true only when there is no copy at all, which the timelines pass on as `holidaysFailed` so `Timeline` shows its muted "could not be loaded" line. A page test that does not serve `GET /api/v1/public-holidays` therefore sees that line (the 404) and no holidays.
- **A write refreshes `["calendar"]`, `["plan"]` and `["roadmap"]`** (`refreshQueriesAfterMutation`): the holiday write bumps the plan revision server-side and every view's working-day figures changed. A mounted project view, the roadmap and the programs page (`["roadmap","programs"]`) all follow.
- **The year picker** shows ONE year at a time, client-side (the endpoint is unpaged): the years in the data, the current year, the year after it (so the Polish preset can be applied to the coming year on an empty list) and the viewed year. A successful add jumps the picker to the new row's year.
- **The Polish preset** (ADMIN): the "Add Polish public holidays for {{year}}" button opens a `ConfirmActionModal` (non-destructive: `confirmColor="astrolabe"`); `POST /public-holidays/apply-preset {preset: "POLISH", year}` for the VIEWED year; on success the fixed-vocabulary toast `calendar.toast.presetAdded` and a `role="status"` line "Polish holidays of 2027: 12 added, 2 already present." under the picker (cleared when the year changes or a holiday is added); a 400/403/other failure closes the dialog and shows the same inline `FormErrorAlert` as an add (`calendar.error.preset*`), never a toast. A holiday on a weekend is stored and shown in the table; it changes no figure.
- **Add / delete.** The add strip is a `<form>` (Enter submits; the button is disabled until the date is a real calendar date and the name is 1..100 characters); a 409 reads the fixed `calendar.duplicateDate`, a 400 `calendar.invalid`, a 403 `calendar.error.forbidden` — the server's `detail` is never rendered. Delete is `useDeleteConfirm` + `ConfirmDeleteModal` with an interpolated row aria-label (`calendar.deleteAria`); a 404 on delete reads "This holiday no longer exists".
- **Tests.** `PublicHolidays.test.tsx` (Flow's, plus the preset), `utils/publicHolidays.test.ts`, `api/calendar.test.ts`; the wiring into the pages is one test each in `ProjectView|TeamDetails|Roadmap|Programs.test.tsx`; `MilestoneScheduleModal`'s pre-check is `ProjectView.test.tsx` and `milestoneForm.test.ts`.

## Plan (`pages/Plan.tsx`)

The plan tree (V12 + `GET /views/plan`), a read for everyone whose actions are gated by the view's `can` flags (`utils/planActions.ts` is the row-to-page callback contract). `Plan.tsx` owns the query (`["plan","view"]`),
which editor is open (`EditorState`: work stream / program under its stream / project under its program), one `useDeleteConfirm` for all three delete levels (the confirm texts come from the `DELETE_TEXT` map,
a 409 says "delete the children first") and the close/reopen mutation; every success refreshes `["plan"]` through `refreshQueriesAfterMutation`. **Close / reopen** is a one-step menu action on a stream:
the full-replace `PUT /work-streams/{id}` of the row as it stands with only `endDate` changed (today, never before the start / `null`) — a closed stream (end date set) still shows "New program" and still takes children. The
stream editor's End date field does the same with a typed date, and clearing it reopens.

**The project editor has two independently permitted parts**, because the server guards them differently: the fields (`PUT /projects/{id}`, `can.edit`) and the target window (`PUT /projects/{id}/target-window`, `can.editTargetWindow` —
a project's OWN owner is deliberately not enough; a roadmap editor has the window but not the fields). A disabled part still shows its current values with a note. Save sends only the parts that are enabled AND differ from what
the server last accepted (held in state, updated after each successful PUT, so a retry after the second PUT failed never repeats the first); nothing changed closes the modal without a request. A NEW project carries its window in
the create body (the creator is always a window editor). The window is both dates or neither (validated in `utils/planForm.ts`, the server's 400 is the backstop).

**Move to…** (`components/PlanMoveModal.tsx`; `moveProject`/`moveProgram` in `api/plan.ts`; the pure arithmetic in `utils/planMove.ts`: `projectMoveTargets` groups the eligible programs by work stream, `programMoveTargets` lists the eligible streams, `hasTarget` reads either shape, `findProject`/`findProgram` look a node up in the current view, `canMoveProject`/`canMoveProgram` are the row-level "offer it?" tests). A row offers the action only when its own `can.move` is set AND some target is eligible (`Plan.tsx` puts both tests into `actions.canMoveProject|Program`); with no target it is hidden, not disabled, and a row whose only action it was loses its kebab. The page holds a `MoveState` of just `{kind, id}`: on every render it looks the node up in the CURRENT view and derives the dialog's name, its parent now ("currently in …"), the targets (excluding that parent) and `forbidden = !can.move`. So a reload under the open dialog (a 400/403's `onRefresh`, or any other `["plan"]` refetch) reshapes the options, a pick that is no longer offered is dropped (`picked = hasTarget(data, value) ? value : null`), a node that lost `can.move` shows the 403 message with Move disabled, and a node that left the plan closes the dialog (state reset during render, as on a 404). Eligibility is only the target half of the server's rule (`can.createProject` / `can.createProgram`); the source half is the node's `can.move`, and the server re-checks both. Outcomes besides 204 are inline in the dialog, never toasts: 409 on a PROJECT (name taken in the target program) stays open to pick another; 400 and 403 say so, then `onRefresh` reloads the plan, and `submitting` is cleared only AFTER that reload (Move cannot be pressed on the old plan); 404 closes via `onDone` (close + refresh); anything else, including a 409 on a program, is "The move failed (status)". Success refreshes `["plan"]` AND `["roadmap"]`. Tests: `PlanMove.test.tsx`, `planMove.test.ts`.

**Dates**: `PlanDateInput` wraps Mantine's `DateInput` (string `value`/`onChange`, `valueFormat="YYYY-MM-DD"`, placeholder `common.dateFormatHint`, a clear button named "Clear {label}"). `AppDatesProvider` (mounted in `main.tsx` around the
router) passes the UI language and `firstDayOfWeek: 1` to `DatesProvider`; dayjs only knows `en` until `dayjs/locale/<lang>` is imported (that file imports `pl`); `@mantine/dates/styles.layer.css` is imported in `main.tsx` next to the core
layer. Tests need no provider (the default locale is English). Unit tests type the ISO text into the input; the calendar popup is covered by `AppDatesProvider.test.tsx` (month and weekday names per language).

## Roadmap (`pages/Roadmap.tsx`)

The global project ranking (V13 + `GET /views/roadmap`, `PUT /roadmap/ranking`) as a timeline, a read for everyone whose editing is gated by the view's `can.editRank` (the page narrative: `web/CLAUDE.md` "The Roadmap page"). Files: `api/roadmap.ts` (`getRoadmapView`, `putRanking`, `isStaleRevision` — a 409 whose problem `type` is
`urn:astrolabe:problem:stale-revision`; the view's `RoadmapProject` carries the server's `rankPosition`, `teamIds`, `span`, `drift`, `flags[]`, `can.editTargetWindow`, and the view `teams[]` and the rolled-up `links[]`), `hooks/useRoadmapRanking.ts` (query + the one write path), `hooks/useRoadmapFilters.ts` and `hooks/useProgramPick.ts` (the stored filters and the shared pick), `utils/roadmapOrder.ts` (pure: `moveBy`/`moveToEdge`/`moveToSlot` — the team page's too —, `moveAmongVisible`, `rankingAfterDrop`, `sameIds`, `appendId`, `removeId`, `applyRanking`), `utils/roadmapRows.ts` (pure: filters, the pick, the displayed rows and the divider, the flag totals and panel entries, the drift band, the arrows of the rolled-up links) and the components `RoadmapTimeline` (the rows, bars, bands, the row menu, the arrows — inside the page's `TimelineDndContext`), `RoadmapFlagPanel`, `RoadmapFilters`.

**The write path.** Every change — a row-menu move, a row drag, Rank (append), Unrank — becomes the complete new id list and is sent as the wholesale PUT with the `expectedRevision` of the view on screen (the view's `revision` is the RANKING's own, V18: a plan write elsewhere never stales it, so the page only echoes it and a stale 409 means another ranking write or the delete of a ranked project). `commit` (a) answers `true` WITHOUT a PUT when the list equals the current one (a drop beside the row itself), (b) REFUSES the change out loud while a write is in flight (`useIsMutating` on the shared mutation key `["roadmap","write"]` — the key the window write path shares in a later v0.6 step —: `refused` drives the page's `role="note"` Alert and `project.busy` goes to the live region; `useRefusal` clears it when no write is left), (c) cancels in-flight `["roadmap"]` fetches, (d) writes
`applyRanking(view, ids)` into the cached view synchronously (the optimistic reorder: the ranked list in the new order, positions 1..n AND each project's own `rankPosition`; flags and spans stay the server's until the refetch; the row, the focus and the PUT all start from the same click), (e) `mutate`s with the pre-change view as the rollback. `onSuccess` stores the response's `revision` in the cached view
and starts `refreshQueriesAfterMutation(["roadmap"])` WITHOUT awaiting it (the save is over once the PUT answers, so a held Enter on a menu item is never swallowed; the next `commit` cancels that refetch before it writes its optimistic order, and the stored revision is what it sends);
`onError` restores the pre-change view and AWAITS the refresh (the reload after a stale 409 must finish before another change builds on the list). A 409 stale-revision shows
`roadmap.stale` (the problem type is what tells it from any other 409), 403/400/other failures map through `saveErrorMessage` into an inline alert — never a toast, and no success toast either (the optimistic reorder and the live region are the feedback). The stale 409 means **the change was NOT saved** — the alert says so.

**Under a filter.** The moves take the ids of the VISIBLE ranked rows: `moveAmongVisible(full, visible, id, slot)` numbers the gaps like `moveToSlot` but over the rows the user sees and puts the row just before the visible row that follows the gap (after the last visible row for the final gap), so hidden rows keep their order and their place. A drop is `rankingAfterDrop(full, visibleRanked, id, slot)` with the slot counted over the DISPLAYED rows: a slot beyond the divider (`visibleRanked.length`) unranks a ranked row (an unranked row comes back unchanged = no PUT); a slot up to it is a place in the ranking, so an unranked row is RANKED there. The page binds `visibleRankedIds` into the hook's `move`/`moveTo`/`dropAt`.

**Dragging.** The row handle (`TimelineRowHandle`, pointer-only) and the page's `TimelineDndContext` `onReorder(id, slot)` are the team page's mechanism (`timeline.md` "Row drag"); there is no keyboard drag — the row menu is the keyboard path, and the page restores keyboard focus after a taken menu change (`refocus` in `Roadmap.tsx`): a browser blurs a focused element whose row is moved in the DOM, so the render that reorders is followed by `focus()` on the row's `data-operations-for` menu button, or by `focusRow(id)` when the virtual path has unmounted the row (Move to bottom, Rank on a 100-row plan). dnd-kit's region announces a drag (also across the divider); the page's polite region says the menu changes only.

**The target window's write path (v0.6, both plan pages).** `hooks/useTargetWindow.ts` is generic over the page's cached view (`view`, `queryKey`, `apply`, `nameOf`, and the page's `announce`): `commit(id, start|null, end|null, {announce?, ownRefusalAlert?}) → boolean` cancels in-flight reads of the view, writes `apply(...)` (`utils/targetWindowUpdate.ts`: the window set, `drift` and the DRIFT_* flags dropped - the RANK_INVERSION flags stay -, and on the programs view the program's and work stream's roll-up counts lowered by the dropped flags), then `mutate`s `PUT /projects/{id}/target-window` (204, no revision) with the pre-change view as the rollback. Success refreshes `["roadmap"]` and `["plan"]` WITHOUT awaiting (so the other plan page, not mounted, is invalidated and a mounted project view's band follows); failure restores the view, AWAITS the refresh and maps 403/404/400 through `saveErrorMessage` (`roadmap.window.*`). The mutation key is the ranking's exported `ROADMAP_WRITE_KEY`, so `useIsMutating` sees both and each refuses the other: `commit` answers `false`, sets `refused` (`useRefusal`) and announces `project.busy`; a change aimed at a project that left the view sets `gone`. The roadmap passes `ranking.announce` as its `announce` (ONE polite region), the programs page its own toggled-suffix announcer. `hooks/useRowMenuFocus.ts` is the roadmap's former inline refocus (`keep` = at render and again on the menu's `onClosed`; `restore` = at render only, for a dialog that was opened from the menu) shared by both pages. The dialog (`TargetWindowModal`, `returnFocus={false}`: the page puts the focus on the menu button) is kept as `{id}` page state, the project read from the view on every render and the dialog closed when it left. **dnd-kit's click blocker:** after ANY drag ends, dnd-kit swallows the next `click` for 50 ms (its document-level capture listener is removed on a timer), and an Enter on a button is a click - a Playwright step that presses a menu button right after a drag must retry (`e2e/tests/roadmap.spec.ts` `menuItemByKeyboard`). Tests: `Roadmap.window.test.tsx` and `Programs.window.test.tsx` (the PUT bodies, the optimistic figures, rollback, the 403/404/400 sentences, the refusal both ways, the dialog and Clear, focus), `targetWindowUpdate.test.ts`, `planTrack.test.ts` (who gets an editable band and a draw surface), `planForm.test.ts` (the dialog's rules).

**Tests.** `Roadmap.test.tsx` runs the whole flow against a small fetch-mock server (a PUT applies the order and bumps the revision); it wraps `DndContext` to hand the test the page's drag handlers (a row drop is fed with the row zone's live readers), since happy-dom has no layout for a real drag. `roadmapOrder.test.ts`, `roadmapRows.test.ts` and `api/roadmap.test.ts` are pure. The real pointer drag (inside the ranking and across the divider), focus retention after a menu move and the stale notice are `e2e/tests/roadmap.spec.ts`.

## Programs (`pages/Programs.tsx`)

The plan as a tree on the timeline (`GET /views/programs`, the page narrative: `web/CLAUDE.md` "The Programs page"), a read for everyone (the one write is a project's target window, "The target window's write path" under Roadmap). Files: `api/programs.ts` (`getProgramsView`, `programsViewKey` = `["roadmap","programs"]`, the view types), `utils/programsTree.ts` (pure: `treeRows`, `defaultOpen`, `allOpen`, `toggled`, `programChoices`, `treeFacts`, `treeDates`), `components/ProgramsTimeline.tsx` (tree rows → `TimelineRowData[]`, the chevron cell, the arrows), and the pieces it shares with the roadmap: `utils/planTrack.ts`, `components/PlanProjectCells.tsx`, `components/ProgramPickField.tsx`, `hooks/usePlanScale.ts`, `hooks/useProgramPick.ts`, `utils/roadmapRows.ts` `pickAmong`.

- **One project-row builder.** `projectTrack(project, t, conflicts)` is the only place a project's bars and drift band are made (`window:<id>` and `<id>` bars, `drift:<id>` band), `planArrows` the only place the rolled-up links become arrows; `RoadmapTimeline` and `ProgramsTimeline` both call them, so the target window's gestures (an editable `window:<id>` bar by the project's `can.editTargetWindow`, the draw surface on a row without a window) land once; the menu's window items are `TargetWindowItems`. Row/bar ids never collide on the programs timeline: project rows use the numeric project id, work stream / program rows the strings `ws:<id>` / `pg:<id>` (also their bars' ids).
- **The expanded set** is `useState<ReadonlySet<string> | null>(null)` in `ProgramsBody`: `null` means "the defaults" (`defaultOpen(view)`: every stream), so a work stream that appears with a refetch opens; any change (a chevron, Expand all, Collapse all) writes a concrete set from what the user sees. `toggle(key)` finds the row in the CURRENT rows to say what it did (`programs.announce.*` with a plural `count`); while the rows stay on one render path the chevron button is the same DOM node before and after (rows are keyed by id), so it keeps the focus and the roving grid re-adopts it as the tab stop. **When a toggle crosses the virtualisation threshold (80 rows) it is NOT**: the Timeline swaps plain for virtual rows (or back), every row remounts and the pressed chevron is lost (a freshly enabled virtualiser also mounts no row on its first render). So `toggle` records the node key in a ref and an effect, after the render, leaves the focus alone only when `[data-node-key=<key>]` is the active element and otherwise calls `timelineRef.focusRow(key)` (the roadmap's `refocus` pattern; the virtual path scrolls to the row and the Timeline's layout effect focuses it once mounted). Pinned by `Programs.virtual.test.tsx` (Expand all, an Enter collapse staying over 80 and falling under it, a single toggle crossing up and back).
- **Roadmap menu focus.** After a taken menu change the roadmap repeats its refocus once the row menu has FINISHED closing (`RowActionsMenu`'s opt-in `onClosed` = Mantine's `onExitTransitionEnd`, via `actions.menuClosed`): the dropdown and its focus trap stay mounted through the ~150 ms exit transition and pull an earlier focus into their sentinel, which lands on `body` when the dropdown unmounts.
- **The pick.** `programChoices(view)` lists every program (empty ones too) and `pickAmong` reads the stored ids against them; the roadmap passes its own `programOptions(view)` (programs with projects) to the same function. An id only one of the pages knows is ignored there, not dropped from storage. The `MultiSelect`'s clear button is `aria-hidden` (Mantine), so tests and e2e find it by its label (`getByLabel`), not by role.
- **Roll-up in part.** `shownStreams` (inside `programsTree.ts`) keeps the server's span/counts for a stream shown whole and recomputes them (`unionSpan`, `sumFlags`) for one the pick shows in part. Nothing else on the page is computed.
- **No `TimelineDndContext`.** Nothing on the page is draggable yet, so the `Timeline` is mounted without a drag context (it works without one); the target-window step wraps it like the roadmap.
- **Tests.** `Programs.test.tsx` runs the page against a one-endpoint fetch mock (default open set, the chevron by pointer and keyboard, the status sentences, Expand/Collapse all, the project row, the arrows appearing and leaving with the fold, the pick and its shared key, Year zoom, empty and failed loads); `programsTree.test.ts` and `api/programs.test.ts` are pure.

### Heading outline guard

`pages/headingOutline.test.tsx` renders every route read from `App.tsx` (via `?raw`, so a new route is covered
the moment it registers) under an ADMIN session with an empty API and asserts the outline starts at h2 and never
skips a level going down. A page whose real title needs loaded data passes a static `title` to
`EditPageLoadState`, so its load/failure state still opens with an h2 (TeamDetails).

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

### Colour tokens

- **Colour tokens are AA-tested** (`themeVariables.ts`, ported from Lettuce): `LIGHT_TOKENS`/
  `DARK_TOKENS` (text, dimmed, canvas, surface tint, borders, error inks) and
  `LIGHT_VARIANT_INKS` (the per-hue ink over a `variant="light"` surface — Mantine's stock light-
  scheme ink fails 4.5:1 for several hues) go in through `cssVariablesResolver` in `main.tsx`.
  Never hand a shade-suffixed colour (`"orange.8"`) to a light Badge/Alert — the tint comes from
  the hue, the ink from this map. **`--astrolabe-accent-ink`** is the brand hue where it must be
  PERCEIVED against the canvas (the nav marker, the anchor hover underline, focus): the light
  primary (deep cyan `#0b7285`) in light mode, the 4-shade (`#3bc9db`) in dark mode. The light-variant ink for the brand hue is `#095c6b`. Success is GREEN (ink `#236b34`; cyan and teal tints are indistinguishable, pinned by a CIEDE2000 distance test in `theme.test.ts`); red = blocking/violation, orange = warning/overload/drift — the full vocabulary is `web/CLAUDE.md`. `utils/chartColors.ts` exports `CATEGORY_PALETTE` only (`astrolabe.6`, `violet.5`, `pink.6`, `indigo.5`, `gray.6` — categorical series, never semantic status colours). `index.css` repeats the two canvas hexes for
  the first paint (`public/color-scheme.js` stamps the scheme on `<html>` before the bundle
  loads); the theme test pins them equal to the tokens.

### The logo

- The logo SVGs (`public/logo-{light,dark}.svg` + `favicon.svg`; rendered by `components/BrandLogo.tsx`) are the brand mark: a stylised **astrolabe** on a 48×48 grid — a disc, a
  limb ring with 24 ticks and 4 major ticks, an off-centre rete ring with three star pointers, an alidade rule with sight vanes and a pivot. The favicon is simplified (disc, ring,
  alidade, pivot) so it survives 16 px; check both in both colour schemes. The geometry is computed (ticks on a circle) — change it in a vector editor or regenerate it, not by hand-editing path data.
  Restyle rule: keep aria-labels, roles, and real semantic elements stable — e2e and unit tests locate by role/name. (Flow's "Rolling" logo is gone.)

### Changelog rendering & UI wiring

Rendering & UI wiring:

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

## Project view (`pages/ProjectView.tsx`)

The first Timeline page (`/projects/:id`, lazy, linked from the Plan page's project name; a detail page with no nav leaf). Files: `api/milestones.ts` (`getProjectView`, `createMilestone`, `updateMilestone`, `deleteMilestone`, `scheduleMilestone`), `hooks/useMilestoneSchedule.ts` (the query under `["plan","project",id]` and the ONE schedule write path), `utils/projectViewUpdate.ts`
(`applySchedule`), `utils/milestoneForm.ts`, `components/ProjectTimeline.tsx` (the view → `TimelineRowData[]` adapter, the row menu, the target-window and drift bands; `ProjectTray` for the Unscheduled tray), `MilestoneEditorModal`, `MilestoneScheduleModal`, `TeamSelect` (a `SearchPicker` over `GET /teams`). `ProjectView` is `<ProjectPage key={id}>`
so another project starts with its own range and editors.

**The write path** is the Roadmap's (`commit` cancels in-flight `["plan"]` fetches (the whole prefix, not only this view), writes `applySchedule(view, id, start, end)` synchronously — the milestone moves between `scheduled` and `unscheduled` and both keep the server's order, `span`/`drift` stay the server's — then `mutate`s with the pre-change view as the rollback). The PUT's `expectedRevision` is the cached
view's `revision`; the server compares it with THAT milestone's last schedule write only (unrelated plan writes never stale a drag), so `onSuccess` stores the answered revision and refreshes `["plan"]` without awaiting it (the refetch also brings the new `span`/`drift`), and `onError` restores and AWAITS the refresh. `stale` is `isStaleRevision(save.error)` (a 409 of the stale-revision problem type);
the 400 of the schedule PUT has several causes (order, shape, no working day), so its one sentence names the working-day rule instead of sniffing the server's text. The page's polite live region announces the button/dialog paths (`project.announce.*`); a drag is announced by dnd-kit's own localized region. **A change is never lost silently:** while a save is in flight `commit` answers `false` and sets `refused` (cleared when that save settles) — the page shows an orange "a save is still running — try again" notice (also inside the schedule dialog, which stays open), announces it (every announcement flips an invisible zero-width suffix, so the same sentence twice is re-read), a visible "Saving…" indicator sits by the Timeline heading, and `TimelineDndContext` corrects dnd-kit's drop announcement (`onSchedule` returns a boolean). **The schedule dialog saves with the revision of the view it was OPENED on** (`Scheduling = {milestone, revision}`), so another manager's move of that milestone meanwhile is the stale 409, not an overwrite; unrelated writes never stale it (the check is per milestone).

**Range.** The page keeps `seen = {min, max}` (ISO strings) in state, grows it during render whenever the view holds an earlier/later date (scheduled dates, the target window), and builds `makeScale(zoom, defaultRange([min, max], today, zoom))` from it — `today` is `localIsoDate()` (`utils/isoDate.ts`): the VIEWER'S local calendar day, not UTC — the today line and the Schedule button agree with their wall calendar, and a Saturday evening in Warsaw is Saturday, not (for part of the day) Friday or Sunday in UTC. It is the one place the UI reads the browser's zone; the server's dates stay plain ISO dates with no zone, and the Plan page's close-a-stream date still uses UTC `todayIsoDate()`. The range NEVER shrinks: after the last far-off link (a ghost row's dates) is deleted it stays wide until the page is reloaded. A drag cannot go further than the padded range (the track clips); typed dates in the schedule dialog can, and the range then grows.
**Bands.** The target window is a `window` band across every row; when the span ends after the target a `drift` band covers the overrun (`addDays(targetEnd, 1)` … `span.end`). **Rows** are fixed 36 px, so the name cell is one line: the name and the description as dimmed text after it, clipped by the cell. The kebab of a row is a roving stop of the grid
(`RowActionsMenu`'s `trigger` prop spreads the stop on the button). The timeline body is at least three rows tall (`MIN_BODY_ROWS`) so an empty timeline still has an area to drop a tray row on.

**Idle gaps (v0.7.0).** `view.idleGaps` is the server's list (`IdleGap{start, end, workingDays}`, `api/milestones.ts` `IdleGap`), read as is: `bandsOf` appends `idleBands(view.idleGaps, t)` (`utils/idleGaps.ts`) after the window/drift bands (and returns them when the project has no window), `ProjectFacts` adds the gray `timeline.idle.badge` plural badge only when the list is non-empty, and `<IdleGaps gaps scope="project" />` is mounted right after `{dependencies}` (so the h3 order is Timeline, Unscheduled, Dependencies, Idle gaps). `applySchedule` spreads the view, so the cached gaps survive the optimistic step unchanged (pinned by `projectViewUpdate.test.ts`: same array identity) and the refetch replaces them (`ProjectView.test.tsx`: the old band is still drawn synchronously after a drop, then the server's new gap). Reference: `timeline.md` "Idle bands".

**Critical path (v0.7.0).** `ProjectPage` holds `useStoredState("timeline.criticalPath", false, isBoolean)` (before the early return: hooks stay unconditional), passes `criticalPath` and the toggle `Button` (as `toolbar`) to `ProjectTimeline`, `showCritical` to `ProjectDependencies` and mounts `<CriticalChain view />` right after `{dependencies}` (before `IdleGaps`) while the toggle is on and the project has milestones (so the h3 order is Timeline, Unscheduled, Dependencies, Critical chain, Idle gaps). `ProjectTimeline` adds the `slack` column (`withSlack` inserts the cell before the actions cell, so a bar's roving columns shift by one with it) and applies `emphasized(t, critical, describe)` to the bar fields; `arrowSpecs(view, criticalPath)` flags the arrows. The ghost rows' slack and emphasis come from `upstreamIndex(view)` by kind + id. `applySchedule` leaves `slackDays`/`critical`/`criticalPath` as cached (the refetch brings the server's). Reference: `timeline.md` "The critical-path highlight".

**Dependencies (v0.4.0).** Files: `api/dependencies.ts` (`createDependency(projectId, body)`, `deleteDependency(id)`, `isDependencyCycle(err)` — the `isStaleRevision` shape — and the types), `api/plan.ts` `listProjects` / `api/milestones.ts` `listMilestones` (the pickers' paged searches), `api/http.ts` `ApiError.cycle` (a typed getter beside `detail`/`type`; malformed entries dropped), `utils/projectDependencies.ts` (pure: `ghostEndpoints`, `summaryRowNeeded`, `arrowSpecs`, `conflictCount`, `conflictsByBar`, `linksOfMilestone`), `utils/dependencyForm.ts` (form values, the self-link and lag rules, `toDependencyBody`, `cyclePathText`, `dependencySaveErrorMessage`), `components/ProjectDependencies.tsx` (the h3 section: table, Delete, empty state), `DependencyEditorModal.tsx`, `MilestoneSelect.tsx`, `ProjectSelect.tsx`, and in `ProjectTimeline.tsx` the summary row, the ghost rows, the overlay and the "Add dependency…" menu item.
- **Row and bar ids.** Own milestones keep their numeric ids; the synthetic rows are strings that cannot collide: `project:<id>` (the summary row, one hollow bar of the derived span — none while nothing is scheduled), `ghost:m:<id>` / `ghost:p:<id>` (one per DISTINCT external endpoint WITH dates, sorted by start, end, name). A row's bar id equals its row id for the synthetic rows. An arrow end resolves to: the own project → the summary row, an own milestone → its row (a tray milestone has none: the arrow is skipped by `arrowsToDraw`, as is the whole link when its status is UNSCHEDULED), anything else → its ghost row. The page's `seen` range includes every end's dates so an arrow to a far-away ghost is in range.
- **Placement.** The section sits AFTER the Unscheduled tray (and after the "No milestones yet" empty state), not between the timeline and the tray: the tray's pointer drop needs the tray close to the timeline and in view with it (the e2e tray drop asserts both are inside the viewport), and the section is taller than the viewport slack once it holds an empty state.
- **The page owns the dialog**, not the section: `Editor` has a `{kind: "dependency", successor}` variant so the section's button (successor null → "This project") and a milestone's row-menu item (successor = that milestone) open the same `DependencyEditorModal`; the section owns only its Delete confirmation. The modal saves with `createDependency` and a cycle 409 (`isDependencyCycle`) is drawn from `err.cycle`; every other failure goes through `dependencySaveErrorMessage` (the fixed vocabulary — a 409 here is the duplicate pair).
- **Refresh.** Create/delete: `refreshQueriesAfterMutation(queryClient, ["plan"])` (+ `["roadmap"]` through the page's `saved`). The schedule write path already refreshes `["plan"]` after a PUT (`useMilestoneSchedule`), which is what brings the new checks: the optimistic `applySchedule` moves the bar but never touches `dependencies[].check`, so for a moment after a drop the table/arrow still show the previous check. Pinned by `ProjectView.test.tsx` ("a schedule write refetches the view…").
- **Picker query keys** are `["plan", "milestones", "picker", term]` and `["plan", "projects", "picker", term]` — under the `["plan"]` prefix, so a Plan mutation refreshes an open picker's list too.
- **Delete bodies** state the cascade: `project.dependency.deleteWith` ("Its N dependencies will be deleted too.") is appended to the milestone's and the project's confirm text when the view holds any link on them (`linksOfMilestone`; the project's count is `dependencies.length`, which is exactly its own links and its milestones').

**Tests.** `ProjectView.test.tsx` runs the page against a small fetch-mock server (a schedule PUT applies the dates and bumps the revision; the dependency POST/DELETE and the milestone picker list are stubbed) and wraps `DndContext` to hand the test the page's drop handler; fake timers (`Date` only) pin "today" for the Schedule button. `milestoneForm.test.ts`, `projectViewUpdate.test.ts`, `projectDependencies.test.ts`, `dependencyForm.test.ts`, `api/milestones.test.ts`, `api/dependencies.test.ts`, `TeamSelect.test.tsx`, `DependencyEditorModal.test.tsx` are pure/small. The real pointer drag,
the resize handle, the tray drop under scroll, the keyboard sensor and the stale notice are `e2e/tests/project-view.spec.ts`; the dependency journeys (link, ghost row, arrow, cycle refusal, the manager's conflict, delete) are `e2e/tests/dependencies.spec.ts`.

## Team page (`pages/TeamDetails.tsx`, v0.5.0)

`/teams/:id` is the team view (lazy; the Teams list's name link). Files: `api/teams.ts` (`getTeamView`, `createCapacityPeriod`, `updateCapacityPeriod`, `deleteCapacityPeriod`, `putTeamOrder` and the types `TeamView`, `TeamMilestone`, `WeekLoad`, `CapacityPeriod`; `listCapacityPeriods` is deliberately NOT wrapped — the view carries the periods), `hooks/useScheduleWritePath.ts` (the project view's write path, generic over the view document: `{queryKey, queryFn, apply, enabled, writeKey}`),
`hooks/useMilestoneSchedule.ts` and `hooks/useTeamSchedule.ts` (its two wrappers; `ProjectView.tsx` and its test are untouched by the generalisation), `hooks/useTeamOrder.ts`, `utils/teamOrderList.ts` (`fullOrderList`, `placeScheduled`: the order PUT's FULL list — the stored `order.milestoneIds` with the scheduled permutation filled around the unscheduled listed ids, `planning-model.md` "The team milestone order"), `utils/teamViewUpdate.ts` (`applyTeamSchedule`, `applyTeamOrder` — both pure, incl. the server's default order for the reset), `utils/dependencyArrows.ts` (the view-independent halves of `projectDependencies.ts`: `arrowSpecsFor`, `conflictsByBarFor`, `conflictCountOf`), `utils/roadmapOrder.ts` `moveToEdge`/`moveToSlot`,
`utils/capacityForm.ts`, `components/TeamTimeline.tsx` (rows, row menu, arrows, the strip; `TeamTray`), `TeamCapacity.tsx`, `CapacityPeriodModal.tsx`, `TeamWeeklyLoad.tsx`. `TeamDetails` is `<TeamPage key={id}>`.

- **Query keys.** The view is `["plan","team",id]` (`teamViewKey`), under the `["plan"]` prefix like the project view, so every plan mutation, a schedule write and a capacity write refresh a mounted team page. The team editor's save refreshes `["teams"]` and `["plan"]`.
- **Two revisions, never crossed.** The view's `revision` is the PLAN revision: the schedule PUT's `expectedRevision`, adopted from the PUT's answer. `order.revision` is the TEAM's order revision: the order PUT's `expectedRevision`, set ONLY from the order PUT's answer (`TeamOrderResponse.revision`, the plan revision the write left behind). The roadmap's revision is a third thing the page never touches.
- **One write at a time.** The schedule mutation and the order mutation carry the same `mutationKey` (`teamWriteKey(id)`); each hook treats `useIsMutating(key) > 0` as "busy" and refuses a change OUT LOUD: `commit` answers `false`, the hook sets its `refused` flag (the page's visible `role="note"` shows when either hook's is set) and announces `project.busy` in the live region (`onSchedule` answers `false` for a drop; a Move or Reset is refused the same way, and the Reset confirm dialog stays open and says so inside, since a modal's content is all a screen reader reads). `refused` is cleared by `hooks/useRefusal.ts` the moment NO write is in flight any more, whichever write was the busy one (a drop refused during an order save does not leave its note up after that save). Two optimistic writes on one cached view would roll each other back. The page's `busy` (aria-busy, the "Saving…" indicator) is either.
- **Order failures.** A stale 409 and a 400 (a listed milestone was deleted or moved to another team meanwhile — removals do not bump the team's order revision) are both "the list changed": rollback, awaited refetch, the visible `role="note"` "The team's order changed in the meantime" and the same sentence in the live region (announced from `onError`, so a screen-reader user hears the list jump back). 403 reads `teams.view.orderForbidden`; anything else the generic action-failed sentence.
- **Optimistic order.** Every reorder goes through the hook's one seam `placed(id, permutation)` (a permutation of the displayed scheduled ids; the Move items and a future row drag): `placeScheduled` turns it into the full list (unscheduled listed milestones keep their index), `commit` sends it. `applyTeamOrder(view, ids)` (ids = the full list): the listed scheduled rows in that order, the unlisted after them in the default order (rank position, project name, project id, start, end, name, id — the server's `effectiveOrder` without the custom positions), `order.milestoneIds` = the list (ids the view does not hold dropped), `order.custom = ids.length > 0`; the empty list (Reset) therefore shows the default order at once. `applyTeamSchedule` appends a newly scheduled row (the refetch places it), keeps a rescheduled row where it is and returns an unscheduled row to the tray in the default order.
- **Menu focus.** Rows are keyed by milestone id, so a Move keeps the row's DOM node and Mantine's menu returns focus to its (still mounted) kebab; the roving grid's focus handler re-adopts it as the tab stop at its new row. `TeamDetails.test.tsx` pins "the menu button keeps focus" through a real Move.
- **Row drag (C5b).** `TimelineDndContext` takes an optional `onReorder(id, slot) → boolean` (`onSchedule`'s twin: `false` = refused, announced as "not changed"); the page passes `order.dropAt(id, slot)` = `placed(id, moveToSlot(scheduledIds, id, slot), false)` (`false` = no page announcement: dnd-kit's region is the drag's single announcer) (`moveToSlot` in `utils/roadmapOrder.ts`: remove the id, re-insert at `slot − 1` when the gap lies below it, else at `slot`; a slot of `from` or `from + 1` is the identity — the context proposes those too and `placed` answers `true` WITHOUT a PUT when the permutation equals the displayed order, so the page, not a pick-up snapshot, judges a no-op), so a drop is the SAME `commit` as a menu Move: the optimistic `applyTeamOrder`, the PUT against `order.revision`, the stale/400 rollback. The handle (`TimelineRowHandle`) is rendered by `TeamTimeline`'s name cell under `can.editOrder`; `TimelineDndContext` keeps the picked-up `DragData` in a ref because dnd-kit blanks an unmounted active node's data (a virtualised row scrolled out mid-drag). The drop goes through `placed`, so besides dnd-kit's "Dropped … at position" the page's polite region also says "… moved to position". Mechanics and the slot arithmetic: `timeline.md` "Row drag".
- **Idle gaps (v0.7.0).** `TeamTimeline` passes `bands={idleBands(view.idleGaps, t)}` (no window band on this page), `TeamFacts` adds the gray `timeline.idle.badge` badge before the "Custom order" one (only when non-empty) and `<IdleGaps gaps scope="team" />` follows `TeamWeeklyLoad`. `applyTeamSchedule` and `applyTeamOrder` spread the view, so the cached gaps stay until the refetch (`teamViewUpdate.test.ts`).
- **Messages shared with the project page.** The busy / milestone-gone / stale / schedule-error / scheduled-unscheduled sentences are the project page's own keys (`project.busy`, `project.milestoneGone`, `project.stale`, `project.scheduleForbidden`, `project.announce.*`): the same refusal says the same words on both pages.
- **The strip's data.** `view.weeks` is handed to `TimelineLoadStrip` as it is: the API's `WeekLoad` is structurally the strip's local `LoadWeek`, so no mapping layer exists. The weekly table formats with two decimals (what the server flags on); the strip trims zeros.
- **Capacity dialog.** `NumberInput`s use `clampBehavior="none"`: Mantine's default clamps `0` to the `min` of 1 on blur, which would silently turn an invalid WIP limit into a valid one; with `none` the typed value reaches the validator and the inline message. No weekday rule anywhere.
- **Tests.** `TeamDetails.test.tsx` (the page against a fetch-mock server that applies the order and schedule PUTs; the wrapped `DndContext` hands it the bar drop and the row drop), `teamViewUpdate.test.ts`, `capacityForm.test.ts`, `dependencyArrows.test.ts`, `api/teams.test.ts`, `roadmapOrder.test.ts`. The real browser is `e2e/tests/team-view.spec.ts` and the team page scans in `accessibility.spec.ts`.

## Timeline mechanics (`components/Timeline*.tsx`)

The binding reference is `timeline.md`; the non-obvious wiring: (1) `Timeline` reads `useDndContext().active` to suspend its own arrow handling while a bar is held (dnd-kit's keyboard sensor listens on the document, AFTER React's handlers) and registers the track drop zone with `useDroppable` — both work
without a `DndContext` (read-only timelines need none). (2) `TimelineDndContext` passes its handlers as `DndContext` props; dnd-kit calls those BEFORE the monitor that feeds `accessibility.announcements`, so the handlers stash the latest outcome in refs and the announcements only read them. (3) A resize redraws from the context's preview (`PreviewContext`); a move is a CSS translate of the bar wrapper from `useDraggable` (the context's modifiers hold it to its row and snap it to days). The edge handles sit outside the bar with a constant width per zoom so a resize never re-measures the dragged node. (4) `useDraggable` results are destructured in `TimelineBar` because the React-compiler lint (`react-hooks/refs`) flags field reads off an object that carries a ref. (5) The virtualiser's `useVirtualizer` carries the one justified `react-hooks/incompatible-library` disable. (6) The track drop zone's droppable `data` carries `visibleBounds()` (the scroller's live rectangle minus the sticky columns and header) and `zoneLeft()` (its element's live left edge) — `outcomeOf` combines them with the pointer `TimelineDndContext` tracks itself during a tray drag, so a tray item released over the tray below or the left columns is not scheduled and a scrolled grid gives the right day (dnd-kit's `delta` is wrong for it, `timeline.md`). (7) A pending "focus the row once it mounts" wish is cleared by another key, a focus elsewhere or a manual scroll. (8) Tests stub the scroller size with `HTMLElement.prototype.clientWidth/clientHeight` (happy-dom lays nothing out; the virtualiser reads them), restore the original descriptors in a file-level `afterEach` and wait with `waitFor`, never a real sleep (the suite is `isolate: false`); the keyboard-sensor test fakes only `setTimeout` for dnd-kit's zero-delay listener attach. (9) **Arrows (v0.4):** `TimelineArrows` renders a fragment (the `<defs>` with two `<marker>`s of FIXED ids, then one `<path>` per kept arrow) inside the Timeline's own `aria-hidden` svg; the marker colours are CSS classes (`timelineArrowHead*`), because a marker's content inherits from the marker's ancestors, not from the path that references it, and the theme tokens `--timeline-arrow`/`--timeline-violation` live on `.timelineGrid`, an ancestor of both. `geometry.rowIndexOf` (a lazily built id→index map) lets the arrow input name rows by `TimelineRowData.id`, so a re-sorted page never re-indexes its arrows. The route math (`utils/timelineArrows.ts`) is pure; the tests feed a hand-built geometry, and `Timeline.test.tsx` covers the plain and the virtual path (the unmounted end of an arrow is positioned from data). (10) **The header height (v0.5 load strip):** the sticky header is `headerHeight(hasStrip)` = 56 px, or 92 px with a `strip` (`STRIP_HEIGHT` 36). Its five consumers all follow ONE number computed in `Timeline.tsx`: the track drop zone's `visibleBounds().top`, the virtualiser's `scrollMargin` and `scrollPaddingStart`, `revealFocused`'s `clearTop`, and the two CSS `scroll-margin-top`s (`.timelineCell`, `.timelineBarBody`), which read `var(--timeline-head)` set on the grid beside `--timeline-left`. A new sticky part adds to `headerHeight()`, never to a literal; `Timeline.test.tsx` "the load strip" pins the value of `--timeline-head` and the drop zone's top, `revealFocused`'s `clearTop` and the virtualiser's `scrollMargin` (through the mounted window), with and without a strip. NOT pinned (happy-dom has no layout and does not process CSS modules): `scrollPaddingStart` (where `scrollToIndex` lands a row) and the two CSS `var(--timeline-head)` uses; the real-browser proof is the team page's e2e/manual pass (C5). The strip is a header row, so the geometry's origin (the top of the first body row) and the arrows do not move. (11) **Public holidays (v0.7):** `Timeline` takes `holidays?` and builds ONE epoch-day map per render (`holidayDayMap`); the same map feeds the row hatch (`trackBackground`: the holiday gradient layer over the weekend layer, ONE `backgroundImage` string computed once per render and handed down as `hatch`), the header (`headerRows(scale, map)` puts `holiday` on the day cells; `HeaderCells` renders the `title` and `data-holiday`) and the visually hidden "Public holidays shown" paragraph (`holidaysShown`). The pages never touch any of it: they pass `useHolidays()` straight through. happy-dom keeps gradient strings in `style.backgroundImage`, so the tests count `gradient(` occurrences on the body row's LAST `gridcell` (its left cells are gridcells too).

## Storage keys, Web Locks and telemetry (reference)

- **localStorage:** `astrolabe.auth.*` (session), `astrolabe.viewSettings.*` (`useStoredState`), `astrolabe.lang`, `astrolabe.changelog`, `astrolabe.chunkReloadedAt` (the one-shot reload after a failed lazy chunk, `main.tsx`). **Web Lock:** `astrolabe.auth.refresh`. **CSS variables:** `--astrolabe-*`. None of Flow's `flow.*` keys exist; there are no legacy redirects.
- **Telemetry panel** (`components/Telemetry*.tsx`, `hooks/useTelemetryPanel.ts`, `utils/telemetry*.ts`): the memory, storage, requests and jvm groups only (`GET /api/v1/telemetry/history?group=`), and one process role, `app` (`utils/telemetryRole.ts`). The sync and derive sections of Flow are gone.
- **`components/TableDisclosure.tsx`** (Flow's `DailyTableDisclosure`) is the collapsible accessible-table twin of a chart; use it for every chart that carries data a screen-reader user needs.
- The Polish user-facing noun for Users is "Użytkownicy/czki" (EN "Users").
