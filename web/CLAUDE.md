# Frontend (`web/`)

Vite + React 19 + TypeScript SPA: the shell + auth, user/feature management, MFA, password reset,
the changelog, the flat-teams registry, the people directory, the Plan page (work streams → programs → projects), the Roadmap page (the global project ranking) and the ADMIN telemetry panel — the v0.1.0 foundation,
trimmed from Flow (`~/Sources/flow` @ e9c3b726, the donor: port building blocks from there, don't reinvent) — with a placeholder Home;
milestones and the timeline arrive after 0.2. Routes are lazy.

- Dev server: `cd web && npm run dev` (port **5178** — not Vite's 5173 default, so Astrolabe can run
  beside Flow's 5176 and the sibling stacks' 5173–5175). All backend routes live under the
  `/api/` namespace and Vite proxies the single `/api` subtree → `http://localhost:8086`. Any
  other path is served as `index.html` so React Router owns the SPA URL space and browser reloads
  don't collide with API routes.
- Production build: `cd web && npm run build` → static files in `web/dist`. In the Docker image
  these are baked in and served by the Ktor server itself (via `WEB_STATIC_DIR`; see
  `plugins/Routing.kt`), so production is single-origin and there is no Vite proxy — the SPA and
  `/api` share `http://localhost:8086`.
- Regenerate API types: `cd web && npm run gen:api`. Reads
  `server/src/main/resources/openapi/documentation.yaml` directly (no server needed) and writes
  `web/src/api/schema.ts`. Run this after editing the OpenAPI spec; commit the regenerated
  `schema.ts` in the same change.
- **Quality gates (the frontend counterpart of the backend's detekt)**: `npm run lint` carries
  `eslint-plugin-sonarjs` (recommended) plus core size/complexity backstops — zero-findings gate;
  rule tuning lives in `eslint.config.js` ONLY, one commented override per deliberate idiom, and
  any inline `eslint-disable` needs a justifying comment. `npm run lint` runs with `--cache --cache-strategy content`
  (`web/.eslintcache`, gitignored; a warm run is ~0.6 s against ~12 s, CI restores the file between runs —
  `build-times.md` WHY 20); the config is not type-aware, so a per-file cache is sound, and a config change or an
  ESLint/node upgrade re-lints everything on its own. `npm run knip` is the dead-code gate
  (unused files/exports/dependencies; `knip.json` ignores the generated `schema.ts` and the
  `ajv` devDependency pinned only for `@stoplight/spectral-cli`'s resolution; `@mantine/dates` and `dayjs` have real consumers since the Plan page) — keep exports that
  only the declaring file uses un-exported, and delete what knip flags rather than ignoring it.
  **The API-contract gate**: `npm run lint:api` Spectral-lints the OpenAPI spec and
  `api-guidelines/examples/conformant.yaml` with `--fail-severity=warn`, through Astrolabe's local ruleset
  `web/spectral.astrolabe.yaml` (it `extends` the shared `api-guidelines/api-guidelines.spectral.yaml`, which is the other
  team's area and never edited; it switches off only the two registered-gap rules `x-sla`/`termsOfService`, each with
  its reason). A finding is fixed in the spec; a new local `off` needs an inapplicability comment, never a fixable finding;
  `npm run check:api` (`scripts/check-api.mjs`) regenerates the API types in memory and diffs
  them against the committed `src/api/schema.ts` — it must never overwrite that file, so
  `gen:api` stays the one command developers run to update it.
- **Build version stamp**: `vite.config.ts` injects `__APP_COMMIT__` (short sha, `+dirty` when the
  worktree has uncommitted changes) and `__APP_COMMIT_TIME__` (commit ISO timestamp) via `define`,
  declared in `src/vite-env.d.ts`. Env vars `GIT_SHA`/`GIT_COMMIT_TIME` override the local-git
  lookup — the Dockerfile's SPA stage sets them explicitly (its worktree never matches the index,
  so the dirty check would false-positive), and CI can do the same when building without `.git`.
  `src/components/VersionStamp.tsx` renders `v<APP_VERSION> · <sha> · <time>` at the bottom of the
  navbar (`App.tsx`) and under the login card (`components/AuthCard.tsx`).

## Layout conventions

- **Flat directories**: `pages/`, `components/`, `hooks/`, `utils/`, `api/`, `changelog/`,
  `locales/{en,pl}/`, `test/` — no deeper nesting, no per-feature folders (a feature contributes
  files into these).
- **Default exports for components/pages**, named exports for everything else; **no path
  aliases** — relative imports only.
- **Co-located tests**: `Foo.test.tsx` sits beside `Foo.tsx`; shared test scaffolding lives in
  `src/test/` (`setup.ts` forces `en`, `render.tsx` is the provider wrapper — it and every
  file-local `MantineProvider` must pass `env="test"`, or Select/Popover interaction silently
  fails under happy-dom; `http.ts` holds the fetch stubs).
- **CSS modules only where the theme can't express it**: styling belongs in `src/theme.ts`
  (Mantine `createTheme` — component `extend`s, defaultProps) with `src/theme.module.css` for the
  class-level parts; a per-component `*.module.css` is the exception, not the pattern.
- Pages are **lazy** (`React.lazy` in `App.tsx`); new routes register above the `path="*"`
  NotFound catch-all (LAST child, never feature-gated). **The nav model lives in
  `utils/navigation.ts`**, shared by the sidebar and the command palette: `NAV_SECTIONS` —
  labelled, always-open sections (currently Overview, Planning: Plan and Roadmap, and Administration: Teams, People, Users, Feature flags) of `NavLeaf`s (the
  `label` is a typed i18n key; `adminOnly?` gates admin leaves, `keywords?` adds raw palette search terms for a renamed page's old name, and `visibleSections(isAdmin())`
  drops an emptied section) — plus `ACCOUNT_NAV` (Change password, Changelog), which the header
  `UserMenu` and the palette render and the sidebar never does. Sections are static captions
  (`role="group"` + `aria-label`), never toggles: every leaf is always in the DOM, so tests and
  e2e address the links directly; leaf clicks close the mobile drawer; `activeNavPath` is the
  longest-prefix matcher over the leaves. **The icon rail (Lettuce's):** a header `ActionIcon`
  beside the Burger (`appShell.toggleNav`, `data-expanded` while expanded) narrows the desktop
  navbar from 240 to 64px — `rail = navCollapsed && !opened`, remembered under
  `astrolabe.viewSettings.appShell.navCollapsed`; in rail mode each leaf is an icon-only `NavLink`
  (`classes.railLink`) whose `aria-label` IS the label (so every by-name locator keeps working)
  inside a right-hand `Tooltip`, section captions become hairline `Divider`s. The mobile overlay
  always shows full labels.
- **The shell header** is 48px: brand, the `CommandPalette` trigger, and the `UserMenu` (avatar →
  identity from `GET /users/{id}` under the `["user", id]` key, language, theme as a three-state
  SegmentedControl, Change password, Changelog with the what's-new badge, for an ADMIN a "Telemetry panel" toggle, Sign out). The version
  stamp stays in the sidebar footer. **`components/CommandPalette.tsx`** wraps
  `@mantine/spotlight` (pinned to the core version — keep every `@mantine/*` on one version) over
  a module-level store (`utils/commandPalette.ts`): the session's pages, plus an ADMIN-only show/hide action for the telemetry panel. No
  `highlightQuery` — it splits labels into `<mark>` fragments that role/name locators cannot
  match.
- **Page chrome**: every page is a `Stack gap="md"` on the canvas starting with
  `components/PageHeader.tsx` (`title` → the `order={2}` heading tests locate, `description?`,
  `backTo?`, right-aligned `actions?` — the ONE place a page's primary "New …" button lives — and
  a `toolbar?` row; 
  No `Container` and no page-wrapping `Paper`; widths come from
  `utils/layout.ts`: full-bleed lists, `Box maw={CONTENT_MAX_WIDTH}` for registry tables and the
  changelog, `Paper withBorder p="xl" maw={FORM_MAX_WIDTH}` (left-aligned) for the simple field
  forms. The one spinner is `components/LoadingBlock.tsx` (`TableLoadingRow` wraps it);
  `components/EditPageLoadState.tsx` is the edit pages' shared load-failure triage (centered
  loader, else a back-to-list alert); `EmptyState` takes the Tabler icon COMPONENT and sizes it
  itself (an optional `hint` is the next step under the label; `components/KpiFigure.tsx` is the one headline-figure style). **One heading outline everywhere**: the `PageHeader` title is the h2, a page's cards/sections are h3
  (`<Title order={3} size="h4">` keeps the look), their inner blocks h4; and every `Table` has an accessible
  name (`aria-label` — the words of the heading above it, or a `<area>.tableAria` key). Page tests pin the
  outline with `test/headings.ts`'s `headingOutline()`.

## The typed API layer (`src/api/`)

The OpenAPI spec at `server/src/main/resources/openapi/documentation.yaml` is the contract between
backend and frontend — hand-maintained, not auto-generated from routes. Swagger UI is at
`http://localhost:8086/openapi` (dev). The layer is small hand-written modules:

- **`http.ts`** (transport): `authedFetch()` with the single-flighted silent refresh on a 401. A DEFINITIVE rejection signs the session out, a TRANSIENT failure keeps it — **never collapse the two**; stale requests and refresh completions must not publish credentials, clear a newer login or retry across session identities. `ApiError` (read RFC 7807 fields via the `detail`/`instance`/`type` getters, never hand-cast `err.body`); `jsonRequest<T>()`/`voidRequest()` for every ordinary endpoint wrapper; `buildQuery()` for list wrappers (`false` and `0` ARE sent). Every transport fetch carries `timeoutSignal()` — new `fetch` call sites in `api/` must attach it. Refresh/wrapper internals: `.claude/docs/web-internals.md`.
- **`session.ts`**: token/roles/userId under the `astrolabe.auth.*` localStorage keys (`persistSession`, `persistRefreshedSession`, the `isAdmin()`/`getUserId()` accessors); ADMIN-dependent components use `useAdmin()` from `auth.tsx`. Details: `.claude/docs/web-internals.md`.
- **Session boundary** (`components/SessionBoundary.tsx` + `utils/sessionQueryCache.ts`): binds the root `QueryClient` to logical session identity — a different sign-in, sign-out or cross-tab change must synchronously remove caller-scoped query data before the next account renders, a token rotation within one identity must retain it, and late requests from the previous identity must not repopulate the new account's UI or cache. Keep this at the session boundary rather than clearing individual page keys. Mechanics: `.claude/docs/web-internals.md`.
- **`auth.ts`**: login + the MFA exchange, self-service password reset, and logout (`logout()` is
  best-effort — local credentials are cleared immediately, before awaiting the revoke POST for the
  captured token pair; a delayed completion never clears a later login, and the function never
  throws).
- The types come from the generated `schema.ts`; a new endpoint's wrapper goes into its feature's
  module (a new feature area gets a new module — never a catch-all file). Avoid heavyweight client
  generators (Orval/Kiota) — the lightweight pairing of `openapi-typescript` (types only) +
  hand-written fetch is intentional.

Explicit sign-out opens `/login` without a saved return destination (a self password change signs out the same way, with its own notice: `flagSignedOut("passwordChanged")`); anonymous access to a protected link preserves its path. Reading the signed-out notice during render must be side-effect free (acknowledge it after the login page commits). Test logout navigation with the real route guards from a non-home page. Details: `.claude/docs/web-internals.md`.

`openapi-typescript` is installed with `--legacy-peer-deps` because its declared peer is TS `^5`
while the scaffold uses TS 6; the generated output is compatible. If you re-`npm install` from
scratch, use `npm install --legacy-peer-deps`.

## Error handling

- **ErrorBoundary** (`components/ErrorBoundary.tsx`): a page render crash must never white-screen
  the app. `RouteErrorBoundary` wraps the `<Outlet />` inside `AppShell.Main` (header/nav survive;
  keyed by `location.pathname`, so navigating anywhere recovers), and a plain `ErrorBoundary` in
  `main.tsx` is the last resort for shell crashes. Don't add per-page boundaries — the two mounts
  are the model.
- **Catch-all 404**: `pages/NotFound.tsx` is the LAST `path="*"` child of the Shell route. New
  routes go above it.
- **Chunk-load recovery**: `main.tsx` listens for `vite:preloadError` (a redeploy 404s the old
  hashed chunks) and reloads once, rate-limited via sessionStorage (`astrolabe.chunkReloadedAt`, max
  one reload/minute) so a genuinely missing chunk falls through to the ErrorBoundary instead of
  looping.
- **Query retry policy**: the `QueryClient` in `main.tsx` uses `shouldRetryQuery` (`api/http.ts`)
  — NEVER retry a 4xx (the answer won't change; retrying only delays the error UI), at most two
  retries for transient failures.
- **Messages**: never render `error.message` (it's the internal `API <status>` / the browser's
  "Failed to fetch") — map statuses to i18n keys via the shared mappers in `utils/saveError.ts`:
  `saveErrorMessage(err, t, keys)` for mutations (per-status keys + a `failed` fallback) and
  `loadErrorMessage(err, t)` for list loads. Errors render inline as `color="red" variant="light"`
  Alerts — never as toasts. A failed QUERY renders through `components/ErrorAlert.tsx`
  (`error`, optional `title`), never an inline `<Alert>{loadErrorMessage(…)}</Alert>`; a form/action failure
  (an already-mapped string) renders through `components/FormErrorAlert.tsx`, never a hand-written red `<Alert>`.
- The `@mantine/notifications` host is mounted in `main.tsx` (top-center, autoClose 2500, limit 3
  — deliberately not in App, so unit tests never mount it). **Success toasts only, with fixed
  vocabulary only** (`showSuccessToast(t("<area>.toast.*"))` in `utils/toast.tsx` — green, never
  user-entered values; errors stay inline).

## Shared list-page building blocks (the Users.tsx template)

Every list page composes the same ported Lettuce blocks — copy `pages/Users.tsx`, don't re-derive:

- **State**: filters in `useStoredState` (persisted under
  `astrolabe.viewSettings.<viewKey>.filter.*`, text filters debounced 300 ms — the DEBOUNCED value
  goes into the query key, and any action reading the filters reads the DEBOUNCED value too, so a
  click never operates on a slice the table isn't showing), sort/page/pageSize from
  `usePagedSort(initialSort, filterDeps, { key, sortFields })` with `SORT_FIELDS ... as const`.
  Every query derived from one area keys under that area's prefix (`["users", …]`, `["teams", …]`),
  so refreshing an area prefix after a mutation refreshes all its active queries and invalidates
  inactive cached data.
- **Query**: `useQuery({ queryKey: ["<area>", page, pageSize, sortParam, ...filters], queryFn: list<Area>(...), placeholderData: keepPreviousData })`.
- **Chrome**: `FilterPanel` (collapsed by default, persisted, active-count badge) +
  `ClearableTextInput` for freetext filters (debounced); `SortHeader` renders its OWN `Table.Th`
  (so the sort state lands as `aria-sort` on the header cell — don't wrap it in another Th);
  `TableLoadingRow` (`isLoading && !data`) / rows / `EmptyState` (`!isError`) triage in the tbody;
  a `color="red" variant="light"` Alert with `loadErrorMessage` ABOVE the table on error;
  `PaginationBar` below.
- **The colour vocabulary is app-wide, not per-page**: the cyan `astrolabe` brand = the interactive accent only (primary CTA,
  active nav item, focus); red = hard/blocking (validation errors, destructive confirm buttons, a failed row, a violated
  constraint); orange = warning / waived (a soft finding, an overload, drift); GREEN = success (success toasts and notices) —
  never teal; gray = neutral state. A new status colour goes through that vocabulary, not a page-local pick.
- **Delete**: `useDeleteConfirm` + `ConfirmDeleteModal` — the hook owns modal state and the
  success toast, the page owns cache refresh. For mutations while a list remains mounted, use
  `refreshQueriesAfterMutation(queryClient, ["area"], ...)` from `utils/queryRefresh.ts` after
  success. It cancels all affected query groups before invalidating them: a newly keyed initial
  fetch has no cached data even when `keepPreviousData` displays rows, so default invalidation
  alone may reuse a pre-mutation response. Keep refresh out of failed mutation paths.
  **`ConfirmActionModal`** is the non-destructive sibling (Lettuce's, ported with the
  feature-flags bulk actions) — a message plus a neutral cancel and a confirm button whose
  `loading` blocks cancel/close while the action runs; labels arrive already translated.
- **An entity's NAME is the way into its detail page** — a `RouterLink` `Anchor` with an
  interpolated accessible name (`common.action.editAria` = "Edit {{name}}", or an area-specific
  `openAria`), which is what tests and e2e locate. A real link, not an onClick: cmd/middle-click
  opens a tab and it takes keyboard focus. Route families are spelled out ONCE in
  `utils/<area>Links.ts` — never hand-assemble a URL.
- Row action buttons carry interpolated aria-labels (`<area>.editAria` etc.) — unit tests and e2e
  locate by them; table tests query cells by **text**, not `cell` role names. **Row actions**: a
  row with more than two actions bundles them under `components/RowActionsMenu.tsx` — an
  icon-only kebab whose accessible name is `common.table.operationsAria` ("Operations for
  {{name}}"; items are plain `menuitem`s, only one row's menu is open at a time); a per-row
  `Switch` (Feature flags) is state, not an action.

## Registries (the Teams.tsx template)

The small ADMIN-curated registries (Teams and People today; more arrive with the planning domain) compose
`useRegistryListControls` for their persisted name filter, debounce and paged sort, and
`RegistryListTable` for the common load/error/empty/pagination states. Each page owns its query
key and parameters, extra filters, columns, row actions and mutation refresh prefixes. Their
editors (e.g. `components/TeamEditorModal.tsx`; `PersonEditorModal.tsx` has no description, so it composes its own fields) share the `RegistryMetadataFields` (name +
description, with `utils/charCount.tsx`'s "123 / 4000" counter) and `RegistryEditorActions`
(save-error alert + cancel/submit footer) components; form rules
(`utils/formRules.ts`'s shared `nameRule`/`descriptionRule`), submit/conflict handling and any
parent/target fields stay local. Keep each registry's field limits explicit and mirrored from the
server's own validation (`infra/validation/Text.kt`'s `requireNameAndDescription`).

## Forms (the CreateUser/EditUser template)

- Shared vocabulary in `utils/<area>Form.ts`: the `<Area>FormValues` type, length constants
  mirroring the server's, a `<area>FormValidation(t)` factory (rules identical to the server's —
  keep them in sync), and `toRequest`/`fromResponse` mappers. The field block lives in
  `components/<Area>FormFields.tsx`; the pages own submit/error/navigation.
- Edit prefills via **`form.initialize(...)` guarded by `!form.initialized` during render** —
  never a `useEffect`. Submit is a plain async fn with local `submitting`/`error` state wrapped by
  `form.onSubmit`; success → `invalidateQueries` (list + detail) → `showSuccessToast` →
  `navigate(list, { replace: true })`; failure → `saveErrorMessage` into an inline Alert.
- **Widths**: `Paper withBorder p="xl" maw={FORM_MAX_WIDTH}` under a `PageHeader` (with `backTo`
  to the list) for simple field forms — left-aligned, never a centred `Container`.

## The Plan page (`pages/Plan.tsx`)

`/plan` (nav section Planning, everyone) renders `GET /views/plan` under `["plan", "view"]` as the tree work stream (h3, `PlanWorkStreamSection`) → program (h4, `PlanProgramBlock`) → projects table. **What a row offers
comes from the view's `can:{}` flags, never from the session's roles** — the server computes them with the guards' own arithmetic; show only the allowed actions, and let the server's 403/409/400 reach the modals through
`planSaveErrorMessage`/`saveErrorMessage` (a name clash marks the name field, everything else is an inline alert). The three editors (`WorkStreamEditorModal`, `ProgramEditorModal`, `ProjectEditorModal`) share
`PlanNodeFields` (name, description, owner via `PersonSelect` — required on every node); the project editor enables its fields by `can.edit` and its target window by `can.editTargetWindow` and saves only the changed, enabled
parts as two PUTs. **Dates** are `components/PlanDateInput.tsx` (`@mantine/dates` `DateInput` over `YYYY-MM-DD` strings, no `Date` objects; the language reaches the calendar through `components/AppDatesProvider.tsx` in `main.tsx`,
which also owns the `dayjs/locale/<lang>` imports — a new shipped language needs its line there). Rules and wire mappers: `utils/planForm.ts`. Mechanics: `.claude/docs/web-internals.md`.

## The Roadmap page (`pages/Roadmap.tsx`)

`/roadmap` (nav section Planning after Plan, palette entry "Roadmap" / PL "Roadmapa") renders `GET /views/roadmap` under `["roadmap","view"]`: the ranked list (h3 "Ranked": rank, project, program, work stream, owner, target window) and an h3 "Unranked" group below it. **Whether
the lists are editable is the view's `can.editRank`** (never the session's roles); without it both are plain read-only tables — no handles, no buttons. Editable, the ranked rows are dnd-kit sortable `<tr>`s (`components/RoadmapRankedTable.tsx` owns the `DndContext`,
`RoadmapRow.tsx` the `useSortable` row) and every change is the **wholesale `PUT /roadmap/ranking`** with the view's `expectedRevision`, from the one write path `hooks/useRoadmapRanking.ts`: optimistic reorder of the cached view, the new revision stored on success,
a rollback plus refetch on any failure, and on the stale-revision 409 (`isStaleRevision` in `api/roadmap.ts`) the "the roadmap changed in the meantime — the list was reloaded" alert. A change is ignored while a save is in flight. The pure order arithmetic is
`utils/roadmapOrder.ts` (move, drop-over, append, remove, `applyRanking`). A project enters the ranking only through "Rank" (appended at the END), leaves it through "Unrank".
**The rule: a dnd-kit list always ships explicit Move up / Move down buttons AND localized announcements** — the handle (a real button, `roadmap.dragHandleAria`) takes the `KeyboardSensor` (Space picks up, arrows move, Space drops) with `accessibility={{ announcements,
screenReaderInstructions }}` built from `roadmap.dnd.*` (`utils/roadmapAnnouncements.ts`), and the Move buttons are the deterministic path tests and e2e drive; a button-driven change is announced in a polite live region (`roadmap.announce.*`), and a Move button keeps keyboard focus through its own move. Pointer drags are not unit-tested (happy-dom has no layout; `Roadmap.test.tsx` wraps `DndContext` to feed it a drop) — the e2e does them. The Plan page's mutations also refresh `["roadmap"]`. Mechanics: `.claude/docs/web-internals.md`.

## User management and feature flags

Passwords are generated client-side and revealed exactly once (`components/OneTimePasswordModal.tsx` sets `closeOnClickOutside={false} closeOnEscape={false}`; closing drops the plaintext for good). The management routes sit under ONE `<Route element={<RequireAdmin />}>` in `App.tsx` — no page redirects itself, their queries stay `enabled: isAdmin()`; UX only, the server's `requireAdmin` is the rule. Users live under `/users` (list, `/new`, `/:id/edit`, `/:id/features`; `utils/userLinks.ts` spells the family out — never hand-assemble a URL); feature flags (`/users/:id/features`, ADMIN `/feature-flags`): mind the wholesale-replace semantics — a PUT whose disabled set omits `MFA` ENABLES it. Page narratives (`pages/Users|CreateUser|EditUser|ChangePassword|FeatureFlags|UserFeatures.tsx`): `.claude/docs/web-internals.md`.

## Per-feature rules (every page)

The ADMIN telemetry panel (`components/Telemetry*.tsx`, the shell's right-hand aside: memory, storage, requests, JVM) is the only chart surface in 0.1.0. Rules that apply to every page:

- **Charts** (any page): charts live only in lazy chunks, each chart component imports `@mantine/charts/styles.css` itself, a legend for two or more series, one axis (never dual), every chart has its numbers in a table beside it, colour is never the only carrier of identity, and colours come from the existing vocabulary in `utils/chartColors.ts` (no new hue for meaningful series; series keyed by arbitrary names — statuses, columns, people — draw from its `CATEGORY_PALETTE`; every mark clears WCAG 1.4.11, ≥ 3:1). Tests mock `@mantine/charts`. 
- **Dates** render deterministically (`YYYY-MM-DD` / `YYYY-MM-DD HH:mm` via `utils/formatDate.ts`), never `toLocaleString()`; date inputs are `PlanDateInput` over ISO strings (see "The Plan page").
- **Failures render inline, never as a toast** (see "Error handling"); success toasts use the fixed vocabulary only.

## Internationalization (i18n)

The SPA is **N-language by architecture** via react-i18next (`src/i18n.ts`); the shipped bundles
are English (THE default and fallback everywhere) and Polish. All user-facing strings go through
`const { t } = useTranslation()` / `<Trans>` — **no hardcoded UI text**. Conventions:

- **Resources** live in `src/locales/{en,pl}/<area>.json`, one file per area (`appShell`, `auth`,
  `changelog`, `common`, `home`, `people`, `plan`, `roadmap`, `teams`, `telemetry`, `users`); `i18n.ts` merges them into a single
  `translation` namespace, so keys read `area.key` (e.g. `t("auth.signIn")`). Only EN is
  statically imported — its typed `en` tree is the key canon AND the runtime fallback; every other
  language is auto-discovered from `locales/<lang>/` via `import.meta.glob`. Bundles are eager on
  purpose; move non-EN to lazy loading when a 3rd language ships or a bundle grows large.
- **Keys are typed**: `src/i18next.d.ts` augments i18next's `CustomTypeOptions` with `typeof en`
  from `i18n.ts` (the `@public`-tagged export — knip can't trace the d.ts consumer), so every
  `t()` call and `i18nKey` is compile-checked against the EN tree — a typo or removed key fails
  `tsc`/`npm run build`. Fields holding a key are typed `ParseKeys` (from `i18next`), never
  `string` (the `NavLeaf` `label` pattern in `utils/navigation.ts`); functions taking a translator
  take `TFunction`, never a hand-written `(key: string) => string`.
- **`common.*` is the shared source**: actions, field labels, shared vocabulary (`common.dateFormatHint` is the date-input placeholder: `YYYY-MM-DD` in EN, `RRRR-MM-DD` in PL). Reuse it instead
  of duplicating; build Mantine `Select` option labels from `t()` at render so they translate.
- **Keep key parity vs EN for every shipped language** — a shipped bundle is all-or-nothing: every
  English key must exist in each `locales/<lang>/` (language-specific plural variants are
  expected), enforced by `locales/parity.test.ts` (auto-discovers language folders; also pins
  folders == `SUPPORTED_LANGUAGES`). Use i18next interpolation (`{{name}}`) and plural keys rather
  than string concatenation.
- **Adding a language** = a complete `locales/<lang>/` folder (parity-gated) + one code in `SUPPORTED_LANGUAGES` (`i18n.ts`) + one `NATIVE_LANGUAGE_NAMES` line; the server-side steps are in `.claude/docs/web-internals.md`.
- **Polish voice convention** (inherited from Lettuce): inclusive slash forms, active/direct
  voice, same tense and meaning as the English; spell out irregular feminines in full. No
  impersonal/passive dodges.
- The language switcher is the Language section of `components/UserMenu.tsx`; the user language is ONE synced property (the switcher also saves it server-side — it drives every email). Details: `.claude/docs/web-internals.md`.
- **Tests render English**: `src/test/setup.ts` imports `../i18n` and forces `en`, so text-based
  assertions match the EN resources.

## Theming

**The design language is theme-owned** (Lettuce's "clean enterprise SaaS" posture) —
`src/theme.ts` + `src/themeVariables.ts` + `src/theme.module.css` are the single source, and
`src/theme.test.ts` guards every contrast ratio:

- The brand is the 10-stop **`astrolabe` cyan tuple** (`#e3fafc … #0b7285 #095c6b`: Mantine's cyan shifted one step deeper) with `primaryShade: { light: 8, dark: 9 }` —
  Mantine's own shade 7/8 pair falls short of 4.5:1 for white text on this hue, so the
  primary shades sit one step deeper than a stock Mantine cyan (white on shade 8 is 5.6:1, on shade 9 7.6:1, pinned in `theme.test.ts`) — and `autoContrast: true`.
  **Restrained** — in UI chrome and status badges (chart series colours are
  `utils/chartColors.ts`'s): cyan marks only primary CTAs, the active nav item (a light tint + a
  3px accent bar) and focus — it is the interactive accent and nothing else (see the colour vocabulary). Everything else
  is neutral BY THEME DEFAULT — `Anchor` is text-coloured with a
  hover underline, `Chip` is `variant="light"`, `Badge` is `variant="light"`, `ActionIcon` is
  `variant="subtle" color="gray"` (destructive ones pass `color="red"`), `Menu` is bottom-end in a
  portal, tables are `verticalSpacing="xs"` (≈40px rows). Pages never pass those props back. GREEN
  is the SUCCESS colour, red the BLOCKING one, orange the warning one (soft findings, waived); the ADMIN role badge is
  `variant="outline" color="gray"`. **Never use teal for success** — its tints are near-identical to the cyan brand's; `theme.test.ts`
  pins the CIEDE2000 distance between the brand and success tints (≥ 10) and fills (≥ 20).
- **Colour tokens are AA-tested** (`themeVariables.ts`: `LIGHT_TOKENS`/`DARK_TOKENS`/`LIGHT_VARIANT_INKS`, wired in through `cssVariablesResolver` in `main.tsx`). Never hand a shade-suffixed colour (`"orange.8"`) to a light Badge/Alert — the tint comes from the hue, the ink from that map. Internals (`--astrolabe-accent-ink`, the first-paint hexes): `.claude/docs/web-internals.md`.
- `theme.module.css` is scheme-aware **via `light-dark()`** throughout (tables card-framed on a
  quiet tinted canvas, white header/navbar surfaces, hairline borders) — new surface styling
  follows that pattern, not `[data-mantine-color-scheme]` selectors. Every `Table` inherits the
  card frame + hoverable rows + neutral compact header from the theme's `Table.extend` — don't add
  per-table frames.
- Soft diffuse `shadows` scale; tightened heading sizes (pages title themselves with `order={2}`).
- Inter is bundled (`@fontsource-variable/inter`, imported in `main.tsx`) so it loads same-origin
  and satisfies the CSP `font-src 'self'`; the system stack is the fallback.
- **Overlay accessibility rules (pinned by the e2e axe sweep over dialogs):** every `Modal` and
  `Drawer` passes `closeButtonProps={{ "aria-label": t("common.action.close") }}` — Mantine's
  close X has no default name — or hides the X with `withCloseButton={false}` when a footer
  button is the one deliberate exit (`OneTimePasswordModal`).
- **A scroller that can overflow is a focusable, labelled region.** A table wider than its box or
  capped by `maxHeight` goes in `components/ScrollRegion.tsx` (native scroller, `tabIndex={0}`,
  `role="region"`, the table's own i18n name as `aria-label`, the `tableScroll` focus ring) — never a
  bare `Table.ScrollContainer`; axe's `scrollable-region-focusable` fails any that overflows without it.
- The logo SVGs are computed geometry — change them in a vector editor, never by hand-editing the path data; restyle rule: keep aria-labels, roles and real semantic elements stable. Details: `.claude/docs/web-internals.md`.

## Changelog & app versioning

The user-facing changelog is a **build-time artifact** — no DB, no API, changes only with a
deploy. `src/changelog/entries.ts` holds `ChangelogEntry` rows (`version`, `date` `YYYY-MM-DD`,
`en`/`pl` **markdown** bodies), newest first; the app's only human-readable version is
`APP_VERSION` in **`src/changelog/version.ts`** — its own tiny module so the shell's eager imports
(VersionStamp, the what's-new dot) never pull the bilingual entries into the main bundle (the
entries ride the lazy Changelog chunk only). **A release = the new entry at the top of
entries.ts + the bump of that one literal** (the Gradle `1.0.0-SNAPSHOT` is unrelated);
`entries.test.ts` pins `CHANGELOG[0].version === APP_VERSION`, so forgetting either half fails the
suite. Release convention:

- Write both language bodies by hand (or LLM) — never derive them from commit messages. Bodies
  are *content*, so they live in the data file, not `locales/`; the PL body follows the Polish
  voice conventions (inclusive slash forms, active voice).
- Keep dates descending (same-day releases are fine — newest stays on top), versions unique, and
  both bodies non-empty — pinned by `src/changelog/entries.test.ts`.
- Complete publication with the annotated version tag and bilingual GitHub release described in
  [the application release process](../.claude/docs/app-releases.md). Every user-visible PR bumps
  the version with its own entry (minor for a feature, patch for a fix). Documentation/test-only
  changes may retain the version; published tags never move.
- Keep phrases that tests assert on in plain text runs: markdown formatting splits text nodes,
  and testing-library's `getByText` matches direct text nodes only.

Rendering & UI wiring (details: `.claude/docs/web-internals.md`): `pages/Changelog.tsx` renders the entries through `MarkdownView` and calls `markChangelogSeen()`; bodies are authored EN+PL only, by policy. The "what's new" dot is driven by `hooks/useChangelogSeen.ts` via `useSyncExternalStore` — do **not** replace that with a plain localStorage read in state.

## Not yet ported from Toadie / Lettuce (port, don't reinvent)

When a feature needs a Lettuce or Covenant `web/` building block (`safeBackParam`, `StatusPill`/`MetaStrip`/`FormFooter`/`ListToolbar`, `useDiscardGuard` / the `beforeunload` guard (Flow's `hooks/useBeforeUnloadGuard.ts`, dropped with the Capacity page), the catalog filter-set/facets, the CodeMirror editor), port the sibling's `web/` implementation and its `web/CLAUDE.md` section wholesale — the list is in `.claude/docs/web-internals.md`. `hooks/useRovingGrid.ts` is kept as prior art for the v0.3 timeline's keyboard navigation (no consumer yet; its test keeps it live for knip).
