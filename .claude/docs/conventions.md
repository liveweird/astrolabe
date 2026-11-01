### Feature conventions

The shape every new feature follows; read in full before adding a feature, route, service, migration or page.

**Feature template — copy `teams/` (a small ADMIN-curated registry)**: it is the
only shape the foundation ships. `<feature>/<Entity>.kt` (request/response DTOs + `toResponse`)
with the `validateX` free function enforced by route AND service (in the DTO file, or a sibling
`<Entity>Validation.kt` once the rules outgrow it), `<Entity>Routes.kt` (`@Resource` typed routes
under `/api/v1/...` + `configureXRoutes()` reading services from `attributes`, `audit(...)` on
every mutation, authorization BEFORE body decoding so 403 wins over 400 — declarative and flat; past
~100 lines it delegates to private `Route.xxx(deps)` functions grouped by concern rather than
splitting into more files, which is exactly what `config/detekt/detekt.yml`'s `LongMethod`
(threshold 100) and `CyclomaticComplexMethod` (excludes `*Routes.kt`) overrides protect),
`<Entity>Service.kt` (Exposed `object` table nested inside the service, `suspendTransaction`,
soft-delete via `marked_as_deleted` + partial unique indexes, list = count + rows on one
predicate), a `V<n>__description.sql` migration (+ its checksum pin in `MigrationChecksumTest`),
spec paths in `openapi/documentation.yaml`, `cd web && npm run gen:api` (same commit), lazy pages +
`NAV_SECTIONS` entries (`web/src/utils/navigation.ts`), and an e2e spec + scenario doc +
coverage-map line. 
**Deliberate exceptions to the template.** One in v0.2.0: **`planning/` has one routes file per entity** (`WorkStreamRoutes.kt`, `ProgramRoutes.kt`, `ProjectRoutes.kt`, `MilestoneRoutes.kt`, `DependencyRoutes.kt`, `PlanViewRoutes.kt`, `RoadmapRoutes.kt`),
all registered by ONE module function (`configurePlanningRoutes()` in `PlanningRoutes.kt`, which also holds the shared per-request caller resolution) — six resources with different guards (read-before-guard
owner-scoped writes, not the registry's ADMIN-only `requireAdmin`) would blow the 400-line file cap and the "past ~100 lines delegate to `Route.xxx(deps)` functions" rule is applied per entity instead; services
(`WorkStreamService`, `ProgramService`, `ProjectService`, `MilestoneService`, `DependencyService`, `PlanViewService`, `ProjectViewService`, `RoadmapService`) and DTO files are per entity too. Flow's three (a config PUT validated in the service because it needs reference data; one route file per sub-resource when a registry,
a queue and read-only views differ in guard; a service-side floor that reads another feature's setting) are recorded here only as precedent: a new exception is added to this list with its reason in
the commit that introduces it. The second exception, v0.5.0: **`teams/` has a second routes file, `TeamCapacityRoutes.kt`** (the team's capacity periods, V16), registered from `configureTeamRoutes()` — Flow's recorded precedent "one route file per sub-resource when the guard differs": the registry's routes are ADMIN-only,
the capacity routes are the team manager's or ADMIN's (read-before-guard, the guard re-run under the team row lock), with their own service (`TeamCapacityService`) and DTO file (`TeamCapacity.kt`). Fuller shapes arrive with the planning increments (`planning-model.md`): a **view endpoint** is now real (`GET /views/plan`: one read transaction, the plan revision first, the whole tree with the caller's
`can:{…}` flags from a pure kernel, no paged envelope — `list-endpoints.md`); a **sub-collection create** names the parent in the path (`POST /work-streams/{id}/programs`) so the guard sees the chain; a **read-before-guard**
route resolves the node's owner chain first (`authorization.md`).
