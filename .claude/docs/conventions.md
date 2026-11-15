# Feature conventions

Owns: the `teams/` feature template and the recorded exceptions to it. Not here: the guard order and the 403/404 mapping (`authorization.md`), the table, migration and soft-delete rules (`persistence.md`), the plan's own shapes (`planning-model.md`). Read in full before adding a feature, route, service, migration or page.

## The feature template

**Copy `teams/`** (a small ADMIN-curated registry): it is the only shape the foundation ships.

- `<feature>/<Entity>.kt`: the request/response DTOs and `toResponse`, with the `validateX` free function enforced by the route AND the service (in the DTO file, or a sibling `<Entity>Validation.kt` once the rules outgrow it).
- `<Entity>Routes.kt`: `@Resource` typed routes under `/api/v1/...` and `configureXRoutes()`, which reads the services from `attributes`; `audit(...)` on every mutation; authorization BEFORE body decoding, so 403 wins over 400.
- Routes stay declarative and flat. Past ~100 lines a routes file delegates to private `Route.xxx(deps)` functions grouped by concern rather than splitting into more files; `config/detekt/detekt.yml`'s `LongMethod` (threshold 100) and `CyclomaticComplexMethod` (excludes `*Routes.kt`) overrides protect exactly that.
- `<Entity>Service.kt`: the Exposed `object` table nested inside the service, `suspendTransaction`, soft delete via `marked_as_deleted` plus partial unique indexes, a list as count + rows on one predicate.
- A `V<n>__description.sql` migration and its checksum pin in `MigrationChecksumTest`.
- Spec paths in `openapi/documentation.yaml`, and `cd web && npm run gen:api` in the same commit.
- Lazy pages and `NAV_SECTIONS` entries (`web/src/utils/navigation.ts`).
- An e2e spec, its scenario file and its coverage-map line.

## Exceptions to the template

A new exception is added to this table, with its reason, in the commit that introduces it. The shared reason is the 400-line file cap (`SourceFileSizeTest`): where guards differ by concern, one routes file would not fit. Guards per route: `authorization.md`.

| Package | What differs from `teams/` | Why | Registered from |
|---|---|---|---|
| `planning/` | One routes file per entity (and per team- or plan-scoped batch command); services and DTO files per entity too | Six resources with different guards (read-before-guard, owner-scoped writes, not the registry's `requireAdmin`); "delegate past ~100 lines" is applied per entity | ONE function, `configurePlanningRoutes()` in `PlanningRoutes.kt`, which also holds the shared per-request caller resolution |
| `teams/` (capacity periods) | A second routes file, `TeamCapacityRoutes.kt`, with its own service (`TeamCapacityService`) and DTO file (`TeamCapacity.kt`) | The registry's routes are ADMIN-only; the capacity routes are the team manager's or ADMIN's (read-before-guard, the guard re-run under the team row lock) | `configureTeamRoutes()` |
| `planning/` (public holidays) | An ADMIN registry with the `teams/` shape exactly (guard-before-read, `requireAdmin` before the body); its writes run in `planning.withPlanWrite` and bump the plan revision | Its rows are plan state, so it lives beside the plan | `configurePlanningRoutes()`; the service is read from `attributes`, not through `PlanRouteDeps` (whose services sit in three groups: `structure`, `views`, `scheduling`) |
| `planning/` (baselines) | A registry beside the ranking: the `teams/` shape with the RANKING's guard (`requireRoadmapEditorOrAdmin`, re-run under the plan lock) instead of `requireAdmin`; writes in `planning.withPlanWrite` like the holidays | A baseline is plan state guarded like the ranking | `configurePlanningRoutes()`; the service from `attributes`, the routes take the shared `PlanRouteDeps` for the caller's flags |
| `jira/` | One routes file per concern, with services and DTO files per concern too (`JiraTestRecorder` and `JiraMappingStore` share the registry's table and never select the token) | The guards differ: registry, Test, mapping and Peek ADMIN-only guard-before-read; bindings and import owner-chain read-before-guard; the deviations view any-authenticated | `configureJiraRoutes()` (`JiraConnectionRoutes.kt`), except the deviations view: its own module `configureDeviationRoutes()` beside it in `application.yaml` |
| `flow/` | One routes file per concern, a service and DTO file per concern | The guards differ: registry and Test ADMIN-only; bindings, import and acknowledgements the team manager's or ADMIN (one exception) | ONE function, `configureFlowRoutes()` (`FlowConnectionRoutes.kt`), which wires the sub-route functions |

- The run registry `sync/` is a separate package and module (`configureSync`, registered after `configureJira`, which registers the Jira connector).
- Flow's recorded precedents beyond the rows: a config PUT validated in the service because it needs reference data, and a service-side floor that reads another feature's setting.

## Shapes beyond the template

- A **view endpoint**: one read transaction, the plan revision first, the whole tree with the caller's `can:{…}` flags from a pure kernel, no paged envelope (`list-endpoints.md`; shapes in `planning-model.md`).
- A **sub-collection create** names the parent in the path (`POST /work-streams/{id}/programs`), so the guard sees the chain.
- A **read-before-guard** route resolves the node's owner chain first (`authorization.md`).

## Idioms

- **Not found.** A null read is `x.orNotFound("Resource")` and a zero-row mutation is `affected.orNotFound("Resource")` (`authz/Exceptions.kt`; the message is "<Resource> not found"). A boolean guard (`PlanningRoutes`' `requireTeamManager` team-exists check, `TeamOrderService`'s `lockActiveTeam`) keeps `if (!…) throw`.
- **A code vocabulary stored or served as an enum** (the sync failure codes) lives in constant objects mirrored by a spec enum: `SyncFailureCodeTest` pins the objects against the enum and forbids a literal at a call site, so a new code is one constant and one enum value in one commit (`sync.md` "Failure codes").
