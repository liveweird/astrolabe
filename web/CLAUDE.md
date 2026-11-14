# Frontend (`web/`)

Vite + React 19 + TypeScript SPA over the server's HTTP API, trimmed from Flow (`~/Sources/flow` @ e9c3b726, the donor: port building blocks from there, don't reinvent). Routes are lazy.
**This file is the RULE SET** (loaded for every `web/` edit; capped at 30,000 bytes by `AlwaysLoadedDocsBudgetTest`): how each page works lives in
`.claude/docs/web-internals.md`, one section per page in nav order ("Pages (the map)" below), and the shared Gantt frame in `.claude/docs/timeline.md`.
Read the page's section before changing the page; a new how-it-works paragraph goes there, never here.

- Dev server: `cd web && npm run dev` (port **5178**, beside Flow's 5176 and the sibling stacks' 5173–5175); Vite proxies the single `/api` subtree →
  `http://localhost:8086`, any other path is `index.html`.
- Production build: `cd web && npm run build` → `web/dist`, baked into the Docker image and served by Ktor (`WEB_STATIC_DIR`, `plugins/Routing.kt`): single-origin, no Vite proxy.
- Regenerate API types: `cd web && npm run gen:api` (reads `server/src/main/resources/openapi/documentation.yaml`, writes `web/src/api/schema.ts`); run it after
  every spec edit and commit `schema.ts` in the same change. Install with `npm install --legacy-peer-deps` (`openapi-typescript` declares TS `^5`, the scaffold
  uses TS 6).
- **Quality gates** (zero findings, no baseline): `npm run lint` (eslint + `eslint-plugin-sonarjs` + `eslint-plugin-jsx-a11y` + core size/complexity backstops);
  rule tuning lives in `eslint.config.js` ONLY, one commented override per deliberate idiom, and any inline `eslint-disable` needs a justifying comment.
  `npm run knip` is the dead-code gate: keep exports that only the declaring file uses un-exported, and delete what knip flags rather than ignoring it. **API
  contract**: `npm run lint:api` Spectral-lints the spec and `api-guidelines/examples/conformant.yaml` through `web/spectral.astrolabe.yaml` (a finding is fixed
  in the spec; the shared `api-guidelines/api-guidelines.spectral.yaml` is never edited; a new local `off` needs an inapplicability comment);
  `npm run check:api` diffs the in-memory regeneration against `src/api/schema.ts` and must never overwrite it, so `gen:api` stays the one command that updates
  it. **Size gate**: no `web/src` `.ts`/`.tsx` file passes 400 lines (`wc -l`) — `src/sourceFileSize.test.ts`, twin of the server's `SourceFileSizeTest`, with an exact ratchet
  for the grandfathered `OVERSIZED` list (generated `schema.ts`, `entries.ts`, tests excluded); split by concern first. Cache, ignore lists and the version stamp: web-internals "Quality gates and the build stamp".

## Layout conventions

- **Flat directories**: `pages/`, `components/`, `hooks/`, `utils/`, `api/`, `changelog/`, `locales/{en,pl}/`, `test/` — no deeper nesting, no per-feature
  folders. **Default exports for components/pages**, named exports for everything else; **no path aliases**.
- **Co-located tests**: `Foo.test.tsx` beside `Foo.tsx`; scaffolding in `src/test/` (`setup.ts` forces `en`, `render.tsx` the provider wrapper, `http.ts` the
  fetch stubs, `headings.ts`). Every `MantineProvider` in a test (`render.tsx` included) must pass `env="test"`, or Select/Popover interaction silently fails
  under happy-dom.
- **CSS modules only where the theme can't express it**: styling belongs in `src/theme.ts` (Mantine `createTheme` — component `extend`s, defaultProps) with
  `src/theme.module.css` for the class-level parts; a per-component `*.module.css` is the exception, not the pattern.
- Pages are **lazy** (`React.lazy` in `App.tsx`); new routes register above the `path="*"` NotFound catch-all (the LAST child, never feature-gated). **The nav
  model is `utils/navigation.ts`** (`NAV_SECTIONS` + `ACCOUNT_NAV`), shared by the sidebar and the command palette: the `label` is a typed i18n key,
  `adminOnly?` gates admin leaves, a new leaf also needs its `utils/<area>Links.ts` path. Sections are static captions (`role="group"` + `aria-label`), never
  toggles: every leaf is always in the DOM, so tests and e2e address the links directly, and in the icon rail a leaf's `aria-label` IS its label so by-name
  locators keep working. Keep every `@mantine/*` package on one version; the palette uses no `highlightQuery`.
- **Focus on navigation**: `hooks/useFocusMainOnNavigation.ts` owns the focus of `#main-content` when the PATHNAME changes (never for a query/filter change,
  never on the first render, never over a focus already inside main); a page's own `autoFocus` must keep working beside it.
- **Page chrome**: every page is a `Stack gap="md"` starting with `components/PageHeader.tsx` (`title` is the `order={2}` heading tests locate; `actions?` is
  the ONE place a page's primary "New …" button lives). No `Container`, no page-wrapping `Paper`; widths come from `utils/layout.ts`: full-bleed lists,
  `Box maw={CONTENT_MAX_WIDTH}` for registry tables and the changelog, `Paper withBorder p="xl" maw={FORM_MAX_WIDTH}` (left-aligned) for simple field forms. The
  one spinner is `components/LoadingBlock.tsx`; `EditPageLoadState` is the edit pages' load-failure triage; `EmptyState` takes the Tabler icon COMPONENT.
- **One heading outline everywhere**: the `PageHeader` title is the h2, a page's cards/sections are h3 (`<Title order={3} size="h4">`), their inner blocks h4;
  every `Table` has an accessible name (`aria-label`, the words of the heading above it or a `<area>.tableAria` key); page tests pin the outline with
  `headingOutline()`. **Tab titles**: `PageHeader` (and `AuthCard` outside the shell) is the ONE owner of `document.title` via `hooks/usePageTitle.ts`; a detail
  page whose name is not loaded yet passes a static title.

## The typed API layer (`src/api/`)

The OpenAPI spec is the contract (hand-maintained, not generated from routes; Swagger UI at `http://localhost:8086/openapi` in dev); the layer is small hand-written modules:

- **`http.ts`** (transport): `authedFetch()` with the single-flighted silent refresh on a 401. A DEFINITIVE rejection signs the session out, a TRANSIENT failure
  keeps it — **never collapse the two**; stale requests and refresh completions must not publish credentials, clear a newer login or retry across session
  identities. `ApiError` fields are read through the `detail`/`instance`/`type` getters, never by hand-casting `err.body`; `jsonRequest<T>()`/`voidRequest()`
  back every ordinary endpoint wrapper; `buildQuery()` backs list wrappers (`false` and `0` ARE sent). Every transport fetch carries `timeoutSignal()` — new
  `fetch` call sites in `api/` must attach it.
- **`session.ts`**: token/roles/userId under the `astrolabe.auth.*` keys; ADMIN-dependent components use `useAdmin()` from `auth.tsx`. **Session boundary**
  (`components/SessionBoundary.tsx`, `utils/sessionQueryCache.ts`): binds the root `QueryClient` to the logical session identity — a different sign-in, sign-out
  or cross-tab change must synchronously remove caller-scoped query data before the next account renders, a token rotation within one identity must retain it,
  and a late request of the previous identity must never repopulate the new account's UI or cache; keep this at the boundary rather than clearing page keys.
- **`auth.ts`**: login + the MFA exchange, password reset, and `logout()` (best-effort: local credentials are cleared first, a delayed completion never clears a later login, it never throws).
- A new endpoint's wrapper goes into its feature's module (a new feature area gets a new module — never a catch-all file); types come from the generated
  `schema.ts`. No heavyweight client generators (Orval/Kiota): `openapi-typescript` (types only) + hand-written fetch is intentional.

Explicit sign-out opens `/login` without a saved return destination (a self password change signs out the same way with its own notice); an anonymous visit to a
protected link preserves its path. Reading the signed-out notice during render must be side-effect free. Test logout navigation with the real route guards from
a non-home page. Mechanics: web-internals "Transport and session layer".

## Error handling

- **Two boundaries only**: `RouteErrorBoundary` wraps the `<Outlet />` (keyed by pathname) and a plain `ErrorBoundary` sits in `main.tsx`; a render crash must
  never white-screen the app, and no per-page boundaries. `pages/NotFound.tsx` is the LAST `path="*"` child.
- **Chunk-load recovery** (`vite:preloadError` in `main.tsx`) reloads once per minute at most (`astrolabe.chunkReloadedAt`) so a genuinely missing chunk reaches the ErrorBoundary instead of looping.
- **Deploy check**: the shell re-reads `index.html`'s `astrolabe-build` meta on mount, on focus and every 5 minutes and shows the Reload notice (`UpdateBanner`) when it differs from the bundle's commit; never an automatic reload, never a toast.
- **Query retry**: `shouldRetryQuery` (`api/http.ts`) NEVER retries a 4xx and retries transient failures at most twice.
- **Messages**: never render `error.message`; map statuses to i18n keys through `utils/saveError.ts` (`saveErrorMessage(err, t, keys)` for mutations,
  `loadErrorMessage(err, t)` for loads). Errors render inline as `color="red" variant="light"` Alerts — never as toasts: a failed QUERY through
  `components/ErrorAlert.tsx`, a form/action failure (an already-mapped string) through `components/FormErrorAlert.tsx`; never an inline
  `<Alert>{loadErrorMessage(…)}</Alert>` or a hand-written red `<Alert>`.
- The `@mantine/notifications` host is mounted in `main.tsx` only (unit tests never mount it). **Success toasts only, with fixed vocabulary only**:
  `showSuccessToast(t("<area>.toast.*"))` from `utils/toast.tsx` — never a user-entered value.

## Shared list-page building blocks (the Users.tsx template)

Every list page composes the same ported Lettuce blocks — copy `pages/Users.tsx`, don't re-derive:

- **State**: filters in `useStoredState` (`astrolabe.viewSettings.<viewKey>.filter.*`, text filters debounced 300 ms — the DEBOUNCED value goes into the query
  key, and any action reading the filters reads it too, so a click never operates on a slice the table isn't showing); sort/page/pageSize from
  `usePagedSort(initialSort, filterDeps, { key, sortFields })` with `SORT_FIELDS ... as const`. Every query of one area keys under that area's prefix
  (`["users", …]`, `["teams", …]`);
  `useQuery({ queryKey: ["<area>", page, pageSize, sortParam, ...filters], queryFn: list<Area>(...), placeholderData: keepPreviousData })`.
- **Chrome**: `FilterPanel` + `ClearableTextInput`; `SortHeader` renders its OWN `Table.Th` (never wrap it in another); `TableLoadingRow` (`isLoading && !data`)
  / rows / `EmptyState` (`!isError`) in the tbody; a red light Alert with `loadErrorMessage` ABOVE the table on error; `PaginationBar` below.
- **The colour vocabulary is app-wide, not per-page**: the cyan `astrolabe` brand = the interactive accent only (primary CTA, active nav item, focus); red =
  hard/blocking (validation errors, destructive confirms, a failed row, a violated constraint); orange = warning / waived (a soft finding, an overload, drift);
  GREEN = success — never teal; gray = neutral state. A new status colour goes through that vocabulary, not a page-local pick.
- **Delete**: `useDeleteConfirm` + `ConfirmDeleteModal` (never `window.confirm`) — the hook owns modal state and the success toast, the page owns cache refresh
  through `refreshQueriesAfterMutation(queryClient, ["area"], ...)` (`utils/queryRefresh.ts`) after success only (it cancels all affected groups before
  invalidating them). `focusAfterDelete` is required: the page's `PageHeader` `titleRef` (the title is `tabIndex={-1}`, never a tab stop), a section's own h3
  ref, or `null` where the delete navigates away; a failed delete never arms it. `ConfirmActionModal` is the non-destructive sibling (labels arrive translated).
- **An entity's NAME is the way into its detail page** — a `RouterLink` `Anchor` with an interpolated accessible name (`common.action.editAria` "Edit {{name}}"
  or an area `openAria`), a real link, not an onClick. Route families are spelled out ONCE in `utils/<area>Links.ts` — never hand-assemble a URL.
- **Row actions**: aria-labels are interpolated (`<area>.editAria`); table tests query cells by **text**. A row with more than two actions bundles them under
  `components/RowActionsMenu.tsx` (icon-only kebab named `common.table.operationsAria`); a per-row `Switch` is state, not an action. A destructive item is
  `components/DestructiveMenuItem.tsx`, never `Menu.Item color="red"`; an item's `aria-label` must contain its visible text ("Move to top: {{name}}"). **A
  dialog mounted with `opened` already true (`{editor && <XModal ... />}`) calls `useDialogFocus(open)`** in its owner. Focus mechanics: web-internals "Shared
  list-page and dialog mechanics".

## Registries (the Teams.tsx template)

Small ADMIN-curated registries (Teams, People) compose `useRegistryListControls` (persisted name filter, debounce, paged sort) and `RegistryListTable`
(load/error/empty/pagination); each page owns its query key, extra filters, columns, row actions and refresh prefixes. Editors share `RegistryMetadataFields`
and `RegistryEditorActions`; form rules (`utils/formRules.ts` `nameRule`/`descriptionRule`), submit/conflict handling and parent fields stay local. Keep each
registry's field limits explicit and mirrored from the server's validation (`infra/validation/Text.kt`).

## Forms (the CreateUser/EditUser template)

- Shared vocabulary in `utils/<area>Form.ts` (`<Area>FormValues`, length constants mirroring the server's, a `<area>FormValidation(t)` factory whose rules stay
  identical to the server's, `toRequest`/`fromResponse`); the field block is `components/<Area>FormFields.tsx`; the pages own submit/error/navigation.
- Edit prefills via **`form.initialize(...)` guarded by `!form.initialized` during render** — never a `useEffect`. Submit is a plain async fn with local
  `submitting`/`error` state under `form.onSubmit`: success → `invalidateQueries` (list + detail) → `showSuccessToast` → `navigate(list, { replace: true })`;
  failure → `saveErrorMessage` into an inline Alert. Simple forms are left-aligned `Paper … maw={FORM_MAX_WIDTH}` under a `PageHeader` with `backTo`, never a
  centred `Container`.

## Pages (the map)

One line per page in nav order: route — guard — the owning section of `.claude/docs/web-internals.md` (Timeline pages also `.claude/docs/timeline.md`).
Everything is lazy under `RequireAuth` unless noted.

- `/` — Overview, everyone — "Home" (links and the open deviation counts).
- `/plan` — Planning, everyone (actions by the view's `can`) — "Plan"; `/projects/:id` (no nav leaf, linked from Plan) — everyone (`can`) — "Project view" + `timeline.md`.
- `/roadmap` — Planning, everyone (`can.editRank`, `can.editTargetWindow`) — "Roadmap" + `timeline.md`.
- `/programs` — Planning, everyone (the target window by `can`) — "Programs" + `timeline.md`.
- `/baselines`, `/baselines/:id` — Planning, everyone (`can.manage` writes) — "Baselines".
- `/schedule-proposals` — Planning, everyone (the teams offered come from `GET /schedule-proposals/teams`; the server's 403 is the rule) — "Schedule proposals".
- `/deviations` — Planning, everyone (Refresh now ADMIN, acknowledge by `can`) — "Deviations, bindings and the Jira chips".
- `/teams` — Administration, everyone reads, ADMIN writes — "Teams and the team page" (the Registries template); `/teams/:id` — everyone (`team.can`) — "Teams and the team page" + `timeline.md`.
- `/people`, `/people/:id` — Administration, everyone reads, ADMIN writes — "People".
- `/public-holidays` — Administration, everyone reads, ADMIN writes — "Public holidays".
- `/users`, `/users/new`, `/users/:id/edit|features|permissions`, `/feature-flags` — Administration, ADMIN (one `RequireAdmin` route) — "Users, feature flags and permissions".
- `/integrations/jira`, `/integrations/jira/:id` — Administration, ADMIN (`RequireAdmin`, `enabled: isAdmin()`) — "Jira connections" and "Deviations, bindings and the Jira chips".
- `/integrations/flow`, `/integrations/flow/:id` — Administration, ADMIN — "Flow connections".
- `/change-password`, `/changelog` — the account menu (`ACCOUNT_NAV`), authenticated — "Users, feature flags and permissions" (the password change) with
  "Transport and session layer" (sign-out), "Changelog and app versioning".
- `/login`, `/reset-password`, `/reset-password/confirm` — outside the shell, anonymous (`RedirectIfAuthed` except the confirm link) — "Transport and session layer".
- The ADMIN telemetry panel (the shell's right-hand aside, no route) — "The telemetry panel".

## Per-feature rules (every page)

- **Charts**: only in lazy chunks, each importing `@mantine/charts/styles.css` itself; a legend for two or more series, one axis (never dual), the numbers in a
  table beside the chart (`TableDisclosure`), colour never the only carrier of identity, colours from `utils/chartColors.ts` (no new hue for meaningful series;
  series keyed by arbitrary names — statuses, columns, people — draw from its `CATEGORY_PALETTE`; every mark clears WCAG 1.4.11, ≥ 3:1). Tests mock
  `@mantine/charts`.
- **Dates** render deterministically (`YYYY-MM-DD` / `YYYY-MM-DD HH:mm` via `utils/formatDate.ts`), never `toLocaleString()`; date inputs are `PlanDateInput` over ISO strings.
- **Failures render inline, never as a toast**; success toasts use the fixed vocabulary only.
- **Planning views are read, not recomputed.** What a row offers comes from the view's `can:{…}` flags, never the session's roles; the server's figures (`span`,
  `drift`, `flags`, dependency `check`, `slackDays`, `idleGaps`, the critical path, baseline movement) are shown as they arrive, never recomputed; show only the
  allowed actions and let the server's 403/409/400 reach the dialog inline.
- **Writes on a view** go through ONE write path per cached view (optimistic step, the view's `revision`, rollback that AWAITS the refetch,
  `refreshQueriesAfterMutation`); a change made while a write is in flight is REFUSED out loud (`role="note"`, the page's one polite status region is the single
  announcer — never an `Alert` with its implicit `role="alert"`), never lost silently. The Roadmap and Programs pages share the project row
  (`utils/planTrack.ts` `projectTrack`/`planArrows`, `PlanProjectCells.tsx`, `usePlanScale`) and the target-window path, which are never forked.
- **The Timeline** (`components/Timeline*.tsx`, `timeline.md`) draws and proposes; the page decides: `editable` comes from `can`, a drop is only
  `onSchedule(id, start, end)`/`onReorder` on the page's `TimelineDndContext`. Every pointer gesture has a keyboard path announced in the UI language; bars are
  neutral gray, drift orange, the brand cyan only focus and the held bar; decorative layers are `aria-hidden` with their facts in the page's text; tests read
  `data-*`, never colour; pointer drags are not unit-tested (the e2e does them).
- **Integration pages** (Jira, Flow): the token is write-only (never pre-filled, logged, shown or echoed; a blank field is omitted from the PUT); the identity
  (site / base URL) is read-only on edit; a PUT is a full replace, so `pollIntervalMinutes` (a number or an explicit `null`) is never omitted; delete goes
  through `useDeleteConfirm`; the client never judges a run's age by its own clock, and a poll runs only while the SERVER says a run is running
  (`409 run-in-progress` is a normal state, not an error); a connection's raw Jira values render as text nodes only; external links are
  `rel="noopener noreferrer"`, `https` only. A write that moves Jira flags refreshes `["jira"]`, `["plan"]` and `["roadmap"]` (`refreshJiraAndTimelines`).
- **Admin pages** sit under ONE `RequireAdmin` route in `App.tsx`: no page redirects itself, its queries stay `enabled: isAdmin()` (UX only — the server's
  `requireAdmin` is the rule). A generated password is revealed exactly once (`OneTimePasswordModal`: `closeOnClickOutside={false} closeOnEscape={false}`;
  closing drops the plaintext for good), and the feature-flag PUT is wholesale — a disabled set that omits `MFA` ENABLES it.
- **Deviations wording**: `totals.bindings` is never worded as "how many are linked"; an empty list is a claim about a READ and is dated; the chips on the
  project and team pages (and the facts line of the Roadmap and Programs pages) show the last observation and add "may be out of date" while a site behind them is not `CURRENT` or its mapping does not fit; the banner,
  the dated claim and the chips share ONE predicate, `isStaleSource` (`utils/staleness.ts`), read off the server's derived state, never the client's clock.
- The ADMIN telemetry panel (`components/Telemetry*.tsx`) is the only chart surface; it shares `SyncStatusBadge` / `utils/syncStatus.ts` with the Jira pages.

## Internationalization (i18n)

The SPA is **N-language by architecture** (react-i18next, `src/i18n.ts`); shipped: English (THE default and fallback) and Polish. All user-facing strings go
through `const { t } = useTranslation()` / `<Trans>` — **no hardcoded UI text**.

- **Resources** live in `src/locales/{en,pl}/<area>.json`, one file per area, merged into one `translation` namespace (keys read `area.key`). Only EN is
  statically imported: its typed `en` tree is the key canon AND the runtime fallback.
- **Keys are typed** (`src/i18next.d.ts` over `typeof en`): fields holding a key are typed `ParseKeys`, never `string` (the `NavLeaf` `label` pattern);
  functions taking a translator take `TFunction`, never a hand-written `(key: string) => string`.
- **`common.*` is the shared source** (actions, field labels, shared vocabulary): reuse it instead of duplicating; build Mantine `Select` option labels from `t()` at render.
- **`sync.*` holds the generic connector strings** (test result table and verdicts, runs table, status, facts, error codes): both connectors use it; connector-specific strings stay in `jira.*` / `flow.*`.
- **Keep key parity vs EN for every shipped language** — a shipped bundle is all-or-nothing (plural variants aside), enforced by `locales/parity.test.ts`. Use
  interpolation (`{{name}}`) and plural keys, never string concatenation.
- **Adding a language** = a complete `locales/<lang>/` folder + one code in `SUPPORTED_LANGUAGES` + one `NATIVE_LANGUAGE_NAMES` line (server steps: web-internals "Internationalization").
- **Polish voice**: inclusive slash forms, active/direct voice, same tense and meaning as the English; spell out irregular feminines in full; no impersonal/passive dodges.
- The user language is ONE synced property (the switcher also saves it server-side; it drives every email). **Tests render English** (`src/test/setup.ts` forces `en`).

## Theming

**The design language is theme-owned** (`src/theme.ts` + `src/themeVariables.ts` + `src/theme.module.css`; `src/theme.test.ts` guards every contrast ratio):

- The brand is the 10-stop **`astrolabe` cyan tuple** with `primaryShade: { light: 8, dark: 9 }` and `autoContrast: true`. **Restrained**: cyan marks only
  primary CTAs, the active nav item and focus; everything else is neutral BY THEME DEFAULT (`Anchor`, `Chip`/`Badge` `variant="light"`, `ActionIcon` `subtle`
  gray — destructive ones pass `color="red"` —, `Menu` bottom-end in a portal, `verticalSpacing="xs"` tables); pages never pass those props back. GREEN is
  success, red blocking, orange warning/waived; **never use teal for success** (`theme.test.ts` pins the distance to the brand tints).
- **Colour tokens are AA-tested** (`themeVariables.ts`, wired through `cssVariablesResolver` in `main.tsx`): never hand a shade-suffixed colour (`"orange.8"`)
  to a light Badge/Alert — the tint comes from the hue, the ink from the token map.
- `theme.module.css` is scheme-aware via `light-dark()`; new surface styling follows that, not `[data-mantine-color-scheme]` selectors. Every `Table` inherits
  the card frame, hoverable rows and compact header from the theme's `Table.extend` — don't add per-table frames, and never pass `highlightOnHover` (or a hover
  colour) to a single `Table`: change the `tableHover` token, `theme.test.ts` says whether it holds.
- Inter is bundled (`@fontsource-variable/inter`, same-origin for the CSP `font-src 'self'`).
- **Overlay accessibility (pinned by the e2e axe sweep):** every `Modal` and `Drawer` passes `closeButtonProps={{ "aria-label": t("common.action.close") }}` or
  hides the X with `withCloseButton={false}` when a footer button is the one deliberate exit.
- **A scroller that can overflow is a focusable, labelled region**: a table wider than its box or capped by `maxHeight` goes in `components/ScrollRegion.tsx`,
  never a bare `Table.ScrollContainer`. **An option list is a scroller too and the LISTBOX is the scroller** (the theme's `withScrollArea: false` +
  `.comboboxOptions`): never pass `maxDropdownHeight`/`scrollAreaProps`/`floatingHeight`.
- The logo SVGs are computed geometry — change them in a vector editor, never by hand-editing path data; keep aria-labels, roles and real semantic elements stable.

## Changelog & app versioning

The changelog is a **build-time artifact** (no DB, no API): `src/changelog/entries.ts` holds the bilingual `ChangelogEntry` rows newest first; the one version
literal is `APP_VERSION` in **`src/changelog/version.ts`** (its own module, so the shell never pulls the entries into the main bundle). **A release = the new
entry at the top of entries.ts + the bump of that literal** (`entries.test.ts` pins them equal).

- Write both language bodies by hand (or LLM), never derived from commit messages; bodies are content and live in the data file, not `locales/`. Keep dates
  descending, versions unique, both bodies non-empty (`entries.test.ts`); keep phrases tests assert on in plain text runs.
- Publication (annotated tag, bilingual GitHub release), the bump rule (every user-visible PR bumps: minor for a feature, patch for a fix; docs/test-only
  changes may keep the version) and published tags never moving: [the application release process](../.claude/docs/app-releases.md). Rendering, the "what's new"
  dot (`useSyncExternalStore`, never a plain localStorage read in state) and the version stamp: web-internals "Changelog and app versioning".
- **Binding caveat for Jira and Flow work:** every changelog entry and release note touching the Jira pages carries "Proven against a built-in Jira stub; not
  yet tested against a real Jira site." (until `jira-sync.md` "First real-site walk-through" is done), and every one touching the Flow pages or the capacity
  deviation carries "Proven against the built-in Flow stub; not yet compared with a real Flow." (until `flow-sync.md` "First real-Flow walk-through"); the PL
  wording and the import's claims: web-internals "Changelog and app versioning".

## Not yet ported from Toadie / Lettuce (port, don't reinvent)

When a feature needs a Lettuce or Covenant `web/` building block, port the sibling's `web/` implementation and its `web/CLAUDE.md` section wholesale — the list
is in `.claude/docs/web-internals.md` "Not yet ported".
