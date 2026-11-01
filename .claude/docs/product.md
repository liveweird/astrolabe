### Product, roadmap and donors

Read on demand when you need the product intent, the per-version scope, a domain decision the user already took, or what a donor repository contributed. The binding one-liners
(the hierarchy, the current version, "Port, don't reinvent") stay in `CLAUDE.md`. The domain model sketch is `planning-model.md`; the timeline component is `timeline.md`.

## What Astrolabe is

A planning and roadmapping app in the spirit of Jira Plans — better UX, more opinionated, Gantt-centred — for a multi-stream / multi-program / multi-team environment. It keeps its
**own** plan data. Later it syncs with Jira and Flow only to **detect deviations**; corrections are made in Astrolabe, never written back. The name is the instrument: a tool for
reading where everything stands against time.

Scale assumed: about 15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones.

## Roadmap

Each increment gets its own plan (architect) before implementation; only v0.1.0 was specified up front. **Current version: 0.5.0.**

| Ver | Scope | User can test |
|---|---|---|
| **0.1.0 Foundation** | Flow trimmed: auth + email MFA, password reset, Users (renamed from Flow users), feature flags, teams with manager, EN/PL, light/dark, changelog, telemetry panel, cyan brand + logo | sign-in, MFA, reset, users/teams, PL/dark, telemetry |
| **0.2.0 Plan structure** | People; work streams/programs/projects CRUD with owners + owner-scoped guards; team manager → Person; ROADMAP_EDITOR grant; Plan tree page; Roadmap ranked list (dnd-kit sortable + keyboard move up/down, "Unranked" group; a timeline since 0.6.0) | build hierarchy, rank, check edit rights |
| **0.3.0 Timeline + project view** | Shared `Timeline*` component (zoom, non-working hatching, today line, virtualisation, drag/resize + keyboard); milestones CRUD; `PUT /milestones/{id}/schedule` (team manager/ADMIN); Unscheduled tray; derived project span + target band | split a project, schedule milestones |
| **0.4.0 Dependencies** | 4 types + lag, all 3 endpoint kinds; SVG arrows; cycles → 409; red violations + conflict list; ghost rows for external endpoints | link across teams/projects, see warnings |
| **0.5.0 Team view + capacity** | capacity periods; weekly load strip + overload; team order override/reset; schedule from team view; deterministic scale dataset `sample-data/plan/` | plan a team against capacity |
| **0.6.0 Roadmap + programs timelines** | derived spans upward; target window by drag; drift flags; rank-vs-time flags (inversion between projects sharing a team = warning, else info); program pick | review plan vs priority |
| **0.7.0 Calendar + critical path** | port Flow `PublicHoliday*`/`WorkingCalendar`; critical path; idle gaps per project/team | find the driving chain and idle time |
| **0.8.0 Auto-proposal** | server scheduler → diff preview → accept all/some via batch schedule (same guards) | generate + accept a proposal |
| **0.9.0 Baselines** | named snapshots at a plan revision; overlay + compare | see movement vs baseline |
| **1.0.0** | checkup, perf at scale, a11y sweep | — |
| **1.x** | Flow teams/capacity import; Jira/Flow deviation detection (re-port `ingest/`, `fetch/`, `jira/`, role switch, `EncryptedAtRest`/`Reencrypt`, WireMock stub on 8096) | — |

Version numbers are not strictly roadmap milestones (`app-releases.md`): a user-visible fix between two increments is a patch bump.

## Domain decisions taken with the user

- **Hierarchy.** Work stream (start, owner; end set only on close) → program (owner; span derived from its projects) → project (owner; **optional target window**; real span derived
  from milestones; drift flagged) → milestone (start/end, man-day estimate, exactly one team, no owner). All have a name and a description.
- **Capacity.** A team has man-days per week with effective-from periods. A milestone's estimate is **spread evenly** over its working days; the weekly load is compared with capacity.
  **Built (0.5.0), on the user's answers of 2026-11-01:** a period takes effect on **any date** (a weekend date applies from the next working day; the week it starts in counts each working day at the figure in force that day), carries an **optional WIP limit** (the most milestones in progress on one working day; parallel work is allowed, too much of it only warns) and is added, edited and deleted by the team's manager or ADMIN. The team page (`/teams/:id`) shows it as a sticky strip under the dates, orange badges on the facts line and a Weekly load table (the accessible surface); overload and WIP are orange warnings, nothing moves. **Override UI (Q8b):** the row menu (Move up / down / to top / to bottom) and a "Reset order" button are the deterministic path and are built; the row handle's pointer drag follows in its own commit.
- **Scheduling.** Manual drag/resize first. **Auto-proposal** (rank + dependencies + capacity → the user accepts or adjusts) comes later (v0.8).
- **Dependencies.** milestone↔milestone (cross-project), milestone↔project, project↔project. Types FS/SS/FF/SF plus a lag. Violations **warn only** (a red link and a conflict list),
  never cascade-move anything.
  **Built (0.4.0), on the defaults the user confirmed on 2026-11-01** (recorded here so overturning one is a known change): (1) who may link — the **successor's** project chain or ADMIN
  (the predecessor's owner sees the arrow and its warning but cannot remove it; overturned = C1 guard/matrix/tests, C3 `can.delete`, the dialog intro); (2) the lag is an integer of
  **working days, negative allowed (a lead), |lag| ≤ 365** (V15's CHECK is immutable); (3) an **unscheduled end is not evaluated** — status UNSCHEDULED, no warning, no arrow, "Not scheduled yet" in
  the table; (4) a link is created **on the successor's project page** (`POST /projects/{id}/dependencies`, the successor fixed to that project or one of its milestones; the predecessor is a free
  search); (5) the project's **summary row** shows only while the project itself is an endpoint; (6) **at most one active link per unordered pair** of ends (a reverse pair answers the same 409 "already
  linked"; changing the type or lag = delete + add — no PUT yet). The UI shows these as: the Dependencies table (violated first = the conflict list), the red "N conflicts" badge, the dialog's
  successor-first form, the cycle notice with its path. The start-to-finish rule is `W(A.effStart) − 1 + lag`.
- **Ranking.** **One global project rank**. A team's milestone order follows it by default; the team may override locally (and reset).
  **Built (0.5.0, V17), on the user's confirmed reading "A" (2026-11-01)** — two ranks with two meanings: the PROJECT rank is the top-down SUGGESTION of the order in which projects should be delivered; the MILESTONE order is the order of ACTUAL EXECUTION and is per TEAM (each team's manager orders their own team's milestones, and a lower-ranked
  project's milestone may come before a higher-ranked project's). The project rank is only the DEFAULT of a team's order, used until the team overrides it and again after a Reset. **A manager's override is never reshuffled by a later project-rank change**: the stored positions are the team's own, and only milestones the team did not list (new, or moved onto the team) slot in after the listed ones, in project-rank order.
  The v0.6 "rank-vs-time inversion between projects sharing a team" stays a WARNING. The order is written wholesale (`PUT /teams/{id}/milestone-order`, `[]` = reset) against the team's OWN order revision, so only that team's order write stales a reorder.
- **Owners.** A **people directory** (name, email, optional link to a login) — owners are people, not necessarily users.
- **Plans.** One live plan; baselines later (v0.9); no scenarios.
- **Permissions (owner-scoped).** ADMIN may do everything. Ownership cascades down (work stream → program → project). A project owner edits the project and its milestones' plan fields
  (name, description, team, estimate, dependencies) but **not dates**. **Milestone dates are set only by the team's manager** (or ADMIN). The global rank is edited by ADMIN and by users with the
  per-user **ROADMAP_EDITOR** grant. A team manager edits the team's capacity and team order. Reads are open to every authenticated user. (Rules land in `authorization.md` as each route does.)
- **Gantt.** A custom shared timeline component: DOM rows + SVG arrows, dnd-kit, TanStack Virtual (`timeline.md`).
- **Brand.** Deep cyan / ocean (`astrolabe` colour tuple, primary `#0b7285` light, `#095c6b` dark); the logo is a stylised astrolabe (limb ring with ticks, rete star pointers, alidade).
  Success is green, red = blocking, orange = warning (`web/CLAUDE.md`).

## Assumptions (not asked — change on request)

Day-precision dates; Monday–Friday working days (public holidays arrive with v0.7); week / month / quarter zoom; EN and PL kept; the scale above.

## v0.5.0 — what shipped

Team view and capacity (V16–V18), on the user's answers of 2026-11-01 (the plan `astrolabe-v0.5.0-team-capacity.md` §2). Capacity periods are team data written by the team's manager or ADMIN outside the plan lock: man-days per week (0 ≤ x < 1,000,000) from ANY date, the boundary week prorated by working days, with an optional WIP limit (1..99). `GET /views/team/{id}` answers the team's milestones across projects, the weekly load (each estimate spread evenly over its working days, rounded HALF_UP once per week) against the prorated capacity, the per-day WIP peak, the overload and WIP warnings (≤ 520 weeks from the earliest scheduled start), and the links between the team's own milestones. The per-team milestone order (V17, `PUT /teams/{id}/milestone-order` against the team's own order revision): the project rank is only its default; a manager's order is never reshuffled — only unlisted newcomers slot in at the bottom by rank, and an unscheduled listed milestone keeps its index; Reset restores the rank. The ranking has its own revision (V18), so unrelated plan writes no longer stale it. The `/teams/:id` page: the timeline with the sticky load strip, scheduling by drag/keyboard/dialog, the capacity table and editor, the weekly table, the order by row menu and by a pointer row-drag handle. A deterministic scale dataset (`sample-data/plan/`, 1,000 milestones) and its API loader; measured at scale in `timeline.md`.

## v0.4.0 — what shipped

Dependencies (V15): a link between two ends, a milestone or a project, of one of four types (finish-to-start, start-to-start, finish-to-finish, start-to-finish) with an integer lag in working days (negative is a lead, |lag| ≤ 365), across projects and teams. The semantics are working days, and every span is a half-open interval. A link that would close a cycle answers 409 and the dialog names the cycle; the owners of the successor's project chain (or ADMIN) add and remove links, and a link is created on the successor's project page. The project view draws the links as SVG arrows on the timeline; a milestone or project from another project is a grayed ghost row linking to its page. A link whose dates no longer hold is drawn red and listed first under Dependencies with what it needs; nothing moves automatically. The searchable milestone and project pickers find the other end.

## v0.3.0 — what shipped

Milestones (V14: one team, no owner, a NUMERIC(8,2) man-day estimate, inclusive nullable dates with at least one working day) under a project, scheduled only by the manager of the
milestone's team or ADMIN through `PUT /milestones/{id}/schedule` with per-milestone optimistic concurrency (`schedule_revision`); a team change keeps the dates, a project delete cascades its
milestones, a team still referenced answers 409. `GET /views/project/{id}` (the derived span, drift against the target window, per-milestone `can`); the first pure span kernel. The shared
web `Timeline*` component (week/month/quarter, weekend hatching, today line, dnd-kit move/resize with a keyboard path, a role=grid with one roving stop, TanStack Virtual, the overlay and track
slots for v0.4 arrows and v0.5 strips) and the `/projects/:id` page with the Unscheduled tray. Reparenting: `POST /projects/{id}/move` and `POST /programs/{id}/move` — the source side is
ancestors only, the target side needs rights on the target chain — with "Move to…" on the Plan page. Measured: 1,000 milestone rows scroll at the 60 Hz cap (`timeline.md`).

## v0.2.0 — what shipped

The plan structure (V10–V13): the people directory (owners and managers are people, optionally linked to a login; `teams.manager_person_id` replaced the user link), the per-user
`ROADMAP_EDITOR` grant (`user_permissions`, read per request, never a token claim), work streams / programs / projects with owners and owner-scoped guards under the `plan_state` lock and
revision, a project's optional target window, closing a work stream by its end date, `GET /views/plan` and `GET /views/roadmap` with per-node `can:{…}` flags, and the one global project rank
(`PUT /roadmap/ranking`, wholesale with `expectedRevision`, a stale write answers 409). The web gained the People, Plan and Roadmap pages (dnd-kit sortable, a keyboard path with localized
announcements, Move up/down, Rank/Unrank) and the Users → Permissions page. Not built (deliberately; reparenting came in v0.3.0): paged lists for the plan nodes (projects and milestones got theirs with the v0.4 pickers; work streams and programs still have none).

## v0.1.0 — what shipped

Flow's generic foundation, renamed and trimmed (Flow @ `e9c3b726`, 1.35.0): JWT auth with a sliding refresh pair, opt-in email MFA, self-service password reset, per-account lockout and
per-IP rate limits, ADMIN-managed users (`/api/v1/users`) with per-user feature flags and a synced UI/email language, flat teams with an optional manager, the ADMIN telemetry panel
(memory / JVM / requests / storage), the React shell (nav model, command palette, theme, changelog), the quality gates, the Docker/Compose/Kubernetes deployment and the Playwright suite. Removed
from Flow: Jira and GitLab ingestion, the normalized and metrics layers, reports, the Deep dive, the role switch and the worker process. One process serves everything.

## Donors

Astrolabe's repository is an exact copy (git archive) of Flow @ `e9c3b726` (`~/Sources/flow`, Flow 1.35.0), trimmed. Flow itself was copied from Covenant and trimmed; Lettuce and Toadie came in
indirectly through it. **Port, don't reinvent**: when Astrolabe needs a capability a sibling repo already has, port its implementation.

- **Flow** (`~/Sources/flow`, the primary donor) — the whole foundation: stack, API design, UI/UX, testing, gates, versioning, deployment, the telemetry panel.
- **Covenant** (`~/Sources/covenant`) — the scaffold Flow was cut from; its `toadie/` connector is the template for an external-API connector (encrypted config, scoped read-only credentials, bounded reads).
- **Lettuce** (`~/Sources/lettuce`) — `infra/mail`, `infra/crypto`, `infra/paging`, the connection pool, the WireMock stub pattern (stub port 8096 here).
- **Toadie** (`~/Sources/toadie`) — the `UrlFetch` SSRF guard, the password-reset-by-link design.

**Port later** (still in Flow, deliberately not here):

| What | Where in Flow | For |
|---|---|---|
| Ingestion, transport, Jira connector, role switch, encrypted-at-rest registry | `ingest/`, `fetch/`, `jira/`, `plugins/Role.kt`, `EncryptedAtRest`/`Reencrypt` | the Jira/Flow deviation sync (1.x) |
| Public holidays and the working calendar | `metrics/PublicHoliday*`, `WorkingCalendar.kt`, `WorkingDayIndex.kt` (`infra/time/WorkingDays.kt` holds the Monday–Friday closed-form index since v0.4; the port keeps its signatures and subtracts holidays) | v0.7 |
| ~~Timeline prior art~~ (ported, v0.3) | `DeepDiveMatrix.tsx`, `utils/deepDiveCalendar.ts`, `hooks/useRovingGrid.ts` | ported into the `Timeline*` components, `utils/timelineScale.ts` and `useRovingGrid` (`timeline.md`) |
| Pure-kernel idiom | `CapacityKernels.kt` | capacity and load kernels (v0.5) |
| WireMock stub pattern | Lettuce's stub, stub port 8096 | the sync's integration tests |
| Fork balancing | `balancedCandidateOrder`, `server/test-weights.tsv` | when `server-tests` outgrows its budget |
