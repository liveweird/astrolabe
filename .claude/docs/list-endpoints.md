### List endpoint conventions

> **Ported** from Lettuce; `GET /api/v1/users` is the reference.

**The generic list rules are owned by `api-guidelines/API-GUIDELINES.md`** (cite the rule IDs):

- Offset pagination `page`/`pageSize` (1-based, default 20, max 100; out-of-range → `400`) in the
  `{items, page, pageSize, total}` envelope; `total` is computed after filters, before pagination,
  with count + page rows in the **same `suspendTransaction`**; cursor paging is a documented
  per-endpoint opt-in [API-LIST-001/002, API-STRUCT-004].
- Sorting: `sort=field`/`-field`, comma-separated multi-field, validated against a per-endpoint
  whitelist → `400`; `id` asc always appended as tiebreaker; default `id` asc documented
  [API-LIST-003].
- Filtering: whitelisted equality filters on the field's own name plus `field[gte|gt|lte|lt]`
  bracket operators only where needed; strict `true`/`false` booleans; enums by string name; a repeated
  scalar key is a `400` (never silent first-value-wins; unknown parameter *names* stay ignored, deliberately), see "Repeated keys" below [API-LIST-004].
- Free text: `q` first, per-column substring only when a UI needs it [API-LIST-005].
- Naming: camelCase params; reusable `Page`/`PageSize`/`Sort` under `#/components/parameters`
  `$ref`'d from each list path; one `*Page` envelope schema per resource; sortable/filterable
  whitelists documented per path [API-NAME-001..004].

**Implementation shape:** `ApplicationCall.parsePaging(sortable = setOf(...))` parses
`page`/`pageSize`/`sort` from the query string against the per-endpoint whitelist into a
`PageRequest` (appending the `id`-asc tiebreaker); `Query.applyPaging(req, columns)` applies
`.orderBy(...)` + `.limit(...).offset(...)` to an Exposed `Query` via the service's file-level
`SORTABLE_COLUMNS` map (the two whitelists must agree — a missing column is an `error()`, i.e. a
500-grade invariant violation). Validation failures throw `BadRequestException` → `400` +
`ProblemDetail`. The service runs `count()` + the page rows on ONE shared predicate in ONE
`suspendTransaction` and returns an `XListResult(items, total)`; the route responds
`paging.toPage(items, total)` the DTO file declares `typealias XPageResponse = PageResponse<XResponse>`.
New list endpoints copy `users/` (service `list`, routes `get<X>`, OpenAPI `$ref`s to the shared
`Page`/`PageSize`/`Sort` parameters, a per-resource `*Page` schema) rather than re-parsing params.

**Substring filters:** every per-column substring filter must be case- AND accent-insensitive —
use `containsNormalized` (`infra/db/Sql.kt`, rendering
`LOWER(public.unaccent(col)) LIKE LOWER(public.unaccent(?))`, extension enabled in V4); never
hand-roll `lowerCase() like containsPattern(...)`, and keep unaccent-before-LOWER (the reverse
breaks uppercase-diacritic input under a C-locale database). The SPA mirrors the rule via the
theme-level `foldedOptionsFilter` (`web/src/utils/text.ts`).

**Repeated keys (`IN`).** A scalar key repeated is a `400` (`singleValue`); a parameter documents `IN` semantics through the `repeatedValues` family (`repeatedLongs`/`repeatedStrings` in `infra/paging/QueryParams.kt`), declared in the spec as `type: array` with `style: form`, `explode: true` and `minItems`/`maxItems`, with duplicates collapsed (`distinct()`) before the bound applies. No endpoint uses `IN` semantics yet; the first consumer adds a per-endpoint ledger line here.

**View endpoints are the one shape-exception.** `GET /views/plan` and `GET /views/roadmap` answer one purpose-built document each instead of the paged envelope: the plan view
`{revision, can, workStreams[…programs[…projects[…]]]}` (each node with `can`), the roadmap view `{revision, can{editRank}, teams[], ranked[{position, project}], unranked[], links[]}` (≈100 projects; ≈ 300 link pairs); `GET /views/project/{id}` answers `{revision, project{…, can}, span|null, drift|null, scheduled[], unscheduled[], dependencies[], idleGaps[], criticalPath{upstream[], upstreamTruncated}}` (≈50 milestones, each with its `can`; `upstream[]` = the critical chain plus ≤ 100 others); **`GET /views/team/{id}`** answers `{revision, team{…, can{…}}, order{custom, revision, milestoneIds[]}, capacity{periods[]}, weeks[{weekStart, load, capacity|null, …}], weeksTruncated, scheduled[], unscheduled[], dependencies[], idleGaps[]}` (≈100 rows + `slackDays`/`critical`); `idleGaps[]` are `{start, end, workingDays}` runs; **`GET /views/programs`** answers `{revision (the plan's), teams[], links[], workStreams[{…, span, flags{warnings, infos}, programs[{…, span, flags, projects[<the roadmap's project row>]}]}]}` (≈100 projects; empty nodes present). **All four timeline views carry `jiraSites[]` (1.3; rows add `jira`, `flags`) and take an optional `?baseline=N`** (v0.9): the SAME document plus additive `baseline` blocks from the same snapshot, absent without the parameter (a repeated or malformed value is a `400`, an unknown or deleted id the `400` `urn:astrolabe:problem:unknown-baseline`, asked after the view's own `404`); **`GET /views/baseline/{id}`** answers the comparison `{revision, baseline, totals{milestones, projects}, projects[≤ 100], milestones[only the changed rows, ≤ 1,000]}` (`404` for an unknown or deleted id); **`GET /views/deviations`** answers `{revision, asOf, connections[{…, status}], totals{warnings, infos, bindings, gone, acknowledged}, items[≤ 2,000], truncated}` from one snapshot, unpaged: `totals` count before the cap (`warnings`, `infos`, `gone` over OPEN items), the default lists OPEN items (`acknowledged=true|false` narrows), and `all`, `projectId` or `teamId` also list clean and acknowledged ones (`all=false` overrides). **`GET /integrations/flow/teams?connectionId=`** answers an unpaged `{connectionId, teamsAt, items[≤ 1,000]}` (a mirror of one Flow document, capped by Flow at 1,000 teams; the match needs them all). **`GET /views/capacity-deviations`** (1.6) answers `{asOf, connections, totals, items[≤ 1,000], truncated}`, unpaged, no `revision`. Sub-lists are capped; the spec documents each cap. Every ordinary resource list keeps the envelope; **projects and milestones have a paged list** (`GET /projects` rows add `programName`/`workStreamName`, `GET /milestones` rows add `projectName`; sortable `id, name, createdAt, updatedAt`, one `name` filter), work streams and programs have NONE (the plan view is their read surface).

**Batch commands.** `POST /teams/{id}/milestone-schedules` takes `{expectedRevision, items[1..1000], scopeHash?}` and answers `{revision, accepted[], skipped[{milestoneId, reason}]}`: unpaged; a per-item failure is data in `200`. `…/schedule-proposal`, `…/import-preview` and `…/import` (`items[1..2,000]`) answer one unpaged document each.

**Sub-collections and facets:** a record's own unbounded sub-collection is paged like any other list; the plain `{items}`
wrapper is reserved for genuinely bounded, curated sets — a team's capacity periods (`GET /teams/{id}/capacity`, a handful a year), the public-holiday dictionary (`GET /public-holidays`, about 14 rows a year), the baselines (`GET /baselines` → `{items, can}`, ≤ 100 by the cap) and a connection's sync runs (`GET /integrations/sync/runs`, newest first, ≤ 50). No facet counts yet (port Covenant's pattern when a list needs them).
