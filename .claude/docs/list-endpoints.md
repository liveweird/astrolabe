### List endpoint conventions

> **Ported.** `server/src/main/kotlin/infra/paging/` (`Paging.kt`, `QueryParams.kt`, `PageResponse.kt`) is Lettuce's
> implementation, ported via Toadie; `GET /api/v1/users` is the reference implementation. The conventions below are the
> contract the package enforces.

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
  scalar key is a `400` (never silent first-value-wins; unknown parameter *names* stay ignored by deliberate
  leniency), see "Repeated keys" below [API-LIST-004].
- Free text: `q` first, per-column substring only when a UI requires it [API-LIST-005].
- Naming: camelCase params; reusable `Page`/`PageSize`/`Sort` under `#/components/parameters`
  `$ref`'d from each list path; one `*Page` envelope schema per resource; sortable/filterable
  whitelists documented per path [API-NAME-001..004].

**Implementation shape:** `ApplicationCall.parsePaging(sortable = setOf(...))` parses
`page`/`pageSize`/`sort` from the query string against the per-endpoint whitelist into a
`PageRequest` (appending the `id`-asc tiebreaker); `Query.applyPaging(req, columns)` applies
`.orderBy(...)` + `.limit(...).offset(...)` to an Exposed `Query` via the service's file-level
`SORTABLE_COLUMNS` map (the two whitelists must agree — a missing column is an `error()`, i.e. a
500-grade invariant violation). Validation failures throw `BadRequestException` → `400` +
`ProblemDetail`. The service runs `count()` + the page rows against ONE shared predicate in ONE
`suspendTransaction` and returns an `XListResult(items, total)`; the route responds
`paging.toPage(items, total)` and the DTO file declares `typealias XPageResponse = PageResponse<XResponse>`.
New list endpoints copy `users/` (service `list`, routes `get<X>`, the OpenAPI `$ref`s to the shared
`Page`/`PageSize`/`Sort` parameters and a per-resource `*Page` schema) rather than re-parsing params.

**Substring filters:** every per-column substring filter must be case- AND accent-insensitive —
use `containsNormalized` (`infra/db/Sql.kt`, rendering
`LOWER(public.unaccent(col)) LIKE LOWER(public.unaccent(?))`, extension enabled in V4); never
hand-roll `lowerCase() like containsPattern(...)`, and keep unaccent-before-LOWER (the reverse
breaks uppercase-diacritic input under a C-locale database). The SPA mirrors the rule via the
theme-level `foldedOptionsFilter` (`web/src/utils/text.ts`).

**Repeated keys (`IN`).** A scalar key repeated is a `400` (`singleValue`); a parameter documents `IN` semantics through the `repeatedValues` family (`repeatedLongs`/`repeatedStrings` in `infra/paging/QueryParams.kt`), declared in the spec as `type: array` with `style: form`, `explode: true` and `minItems`/`maxItems`, with duplicates collapsed (`distinct()`) before the bound applies. No endpoint uses `IN` semantics in v0.1.0; the first consumer adds a per-endpoint ledger line here (Flow kept the ledger in its reports doc).

**View endpoints are the one shape-exception.** `GET /views/plan` and `GET /views/roadmap` (both built, v0.2.0) answer one purpose-built document each instead of the paged envelope: the plan view
`{revision, can, workStreams[…programs[…projects[…]]]}` (every node with its own `can:{…}` flags), the roadmap view `{revision, can{editRank}, ranked[{position, project}], unranked[]}` (≈100 projects, no
paging, `ranked` in position order); the timeline pages (`/views/project/{id}`, `/views/team/{id}`, `/views/programs`, `planning-model.md`) follow the same shape. Their sub-lists are
bounded by the plan's scale and the endpoint documents its cap (the plan view: ~5 work streams, ~20 programs, ~100 projects). Every ordinary resource list keeps the envelope; work streams, programs and projects have
NO list endpoint in v0.2 (a list lands with its first consumer). (Flow's report drill lists — `{meta, bar, items[<=500], total, truncated}` — were the precedent.)

**Sub-collections and facets:** a record's own unbounded sub-collection is paged like any other list; the plain `{items}`
wrapper is reserved for genuinely bounded, admin-curated sets. Facet counts (`GET .../facets`) are not implemented — port Covenant's
pattern with the first filterable list that needs them.
