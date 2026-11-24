# Scheduling

Owns: the auto-proposal (one team's not-started milestones, placed by the pure kernel), the cross-team run (that proposal over a set of teams), the scope token, the accept, the check, the saved proposals and their vectors. Not here: the plan structure, the `plan_state` lock, milestones, the pin, the batch schedule write and capacity periods (`planning-model.md`), the guard order and existence disclosure (`authorization.md` "Rules"), the audit event catalogue (`observability.md`), the page mechanics (`web-internals.md`, `timeline.md`), the product intent and the user's answers (`product.md`).

## Rules

- **A proposal never moves anything.** The kernels are pure (no I/O, no clock, no randomness; the calendar, `asOf` and every row are parameters); a proposal, a run and a check store nothing, take no lock, bump no revision and emit no audit event ("The auto-proposal", "The proposal endpoint", "The run endpoint").
- **Fixed and movable.** The team's not-started milestones with no dates or a start after `asOf` are movable; every other milestone, a pinned one and another team's included, is fixed ("Placement"). The target window is not a constraint; a day without capacity or on hold is unusable.
- **Capacity and WIP are exact, per day and per week.** The candidate loop never adds load to a week the view would show overloaded; a milestone no span fits is `NO_CAPACITY` or `NO_ROOM` ("The candidate loop").
- **One snapshot.** The plan revision is read first, in one read-only REPEATABLE READ transaction, and `revision`, every block, the link verdicts and `scopeHash` describe that one plan ("The proposal endpoint", "The run endpoint").
- **The scope token is three parts** (structure, holidays, `asOf`). The accept recomputes it under the plan lock: a different structure part, or a team milestone the batch does not name rescheduled after `expectedRevision`, is `409 stale-scope`; only the holidays part differing is the look-again ("The scope check").
- **The per-team and the run token never cross.** Each is `409 stale-scope` on the other's route; `CrossTeamAcceptTest` pins both ways ("The accept").
- **The run orders its teams by links** (most movable milestones first, then name, then id), every pass covers every team once (from pass 2 only a team a predecessor team changed under is placed again), and `settled` says whether a next pass would repeat it; after `maxPasses` the last pass stands ("Kernel").
- **The cross-team routes read the team set from the body**, so the body decodes first, then `validateTeamIds`, every team ACTIVE (404 for every caller), then `requireTeamManagerOfAllOrAdmin` (403); the accept re-guards under the lock in ascending team id ("The run endpoint", "The accept", "The check"; the order is `authorization.md`'s).
- **A stale item is skipped and the rest land** (`GONE`, `NOT_ON_TEAM`, `NO_WORKING_DAY`, `STALE`: data in the `200`); the accept is ONE plan write and ONE bump ("The accept").
- **Dependencies and capacity only warn**: a violated link after the moves is reported by the post-check, never a refusal ("The check").
- **A saved proposal is the server's own re-computation and is not plan state.** The save recomputes the run under the accept's `409`s and stores THAT (never a client document), takes no plan lock, moves no revision and writes no plan row; the accept is unchanged ("Saved proposals").
- The user's answers behind these rules are `product.md` "Domain decisions"; this doc says what the code does.

## The auto-proposal

Files: `planning/ScheduleKernels.kt`, `ScheduleLedger.kt`, `ScheduleConstraints.kt` (the kernel); `ScheduleProposalService.kt`, `ScheduleProposalAssembly.kt`, `TeamScheduleRoutes.kt` (the endpoint); `ScheduleScope.kt`, `ScheduleSnapshot.kt` (the scope check).

The scheduling kernel is pure: no I/O, no clock, no randomness; the calendar, the clock date `asOf` and every row are parameters. It places ONE team's not-started milestones and answers a PROPOSAL; nothing moves. The user's answers that bind it:

- Every not-started milestone is re-planned from the earliest day. A link into another team's fixed milestone is placed anyway and reported. A day without capacity, or on hold, is unusable.
- A 0 MD milestone takes one working day and counts for WIP. The target window is NOT a constraint. A stale item is skipped and the rest land (the batch's rule).

### Placement

- **API.** `ScheduleKernels.propose(ScheduleInputs): ScheduleProposalResult` and `ScheduleKernels.postCheck(inputs, result): ScheduleProposalCheck`.
  `ScheduleInputs(asOf, teamId, team: List<TeamScheduleItem>, periods, plan: Collection<PlanMilestoneFact>, links: Collection<PlanLinkFact>, calendar, horizonWeeks = 520)`; `TeamScheduleItem(id, projectId, span: DaySpan?, estimateMd, key: OrderKey, pinned = false)`; `Placement(milestoneId, from: DaySpan?, to: DaySpan)` (`to == from` = it stays).
  `Unplaced(milestoneId, reason: NO_CAPACITY | NO_ROOM)`; `ScheduleProposalResult(placements, unplaced, spansAfter)`; `ScheduleProposalCheck(weeks: List<WeekLoad>, weeksTruncated, links: List<ScheduleLinkCheck(linkId, before: DependencyStatus, after: DependencyCheck)>)`.
  `Fraction` (`LoadKernels.kt`, the exact rational) and `DependencyKernels.requiredIndex` are the shared arithmetic (`internal`).
- **Movable / fixed.** MOVABLE = the team's milestones with no dates or a start AFTER `asOf`. FIXED = every other milestone: the other teams' always; this team's with `start <= asOf` (in progress or past; a weekend-dated start counts by its date) **and its PINNED dated milestones whatever their start**.
  The one predicate is `Pass.isFixed`: `span != null && (start <= asOf || pinned || id in held)`.
- **A pinned milestone** keeps its dates, its load is booked in the ledger at the even rate, its dates feed the link values (an FS successor starts after it, like another team's milestone), it is in `spansAfter`, and it is in NO placement and NO `unplaced` list.
  "Pinned" has two meanings here: the manager's pin (stored) and the fixpoint's internal "held" set below.
- **The ledger starts with this team's fixed milestones only** (their effective working days at the even rate `E/n`); a movable milestone's current dates are forgotten until it is placed (they survive as the order tiebreak only).
- **Order and hoisting.** Movable milestones are sorted by `effectiveOrder`. The PLACEMENT order hoists, depth-first in link-id order, the movable milestones of this team that a milestone must wait for: the predecessor of a link INTO it (any type), the movable milestones of a predecessor PROJECT, and the same for a START-bound link (FS/SS) into its project (containment).
  `placements` and `unplaced` are listed in the TEAM order.
- **An END-bound link (FF/SF) into a PROJECT** binds the project's derived end, which no single milestone owns: no bound, no hoist; the post-check reports it.
- **A hoisting loop is skipped, never an error.** The hoisting relation can close a loop on valid data (`a FF b` + `b SS a`: the cycle rule is on time points, the hoist on entities): an entity met again on the walk's stack is skipped (the bound it would have given is missing; only the post-check reports a link it leaves violated). A real cycle of the time-point graph fails closed first with `error("the active plan graph holds a cycle")`.
- **The ledger** runs per working day from the team's first USABLE day (a working day in a period with capacity above zero and a WIP limit above zero) to `horizonWeeks` weeks later: `dailyCap = mdPerWeek / 5` (the fixed divisor of `weekCapacity`), `share = dailyCap / (wipLimit ?: 1)`, and `wip` and `used` (exact `Fraction`s) booked by the fixed milestones and every placement.
- **Earliest start.** The later of the first working day after `asOf` and every START-bound lower bound: `requiredIndex` of each binding link whose predecessor has dates now (fixed, or placed in this run; a project predecessor = min start / max end over its dated milestones). A predecessor without dates binds nothing.
  END-bound links into the MILESTONE (FF/SF) demand the span's last working-day index be `>= required` (`last index >= requiredIndex`, the check's own comparison, instead of calling `DependencyKernels.check` per candidate), tested per candidate. All four types are lower bounds, so no link makes a milestone impossible, only later. A link between two fixed ends is not the scheduler's business.
- **Duration.** From a candidate start `s`, `n` = the smallest number of consecutive usable working days `d1..dn` with `E <= n x min(share(d1..dn))` (`E = 0` gives `n = 1`). For a constant share this is exactly `ceil(E / share)`; when a period lowers the share inside the span the span stretches, so the even rate `E/n` never exceeds the share of ANY of its days.
  A holiday inside a span costs a calendar day, not a working day. An unusable day ends the candidate.

### The candidate loop

- **Per DAY, stricter than the view's week rule and implying it.** The first start that fits: every day has WIP place (`wip + 1 <= limit` when a limit is in force that day) and room for the rate (`rate <= dailyCap - used`, exact), and the END-bound links hold. A conflict moves the start by ONE working day (the span length, hence the rate, depends on the start).
- **Two exact shortcuts only.** The first day alone (WIP full, or `used >= dailyCap` for `E > 0`) rejects every span starting there. A start from which even every remaining day of its usable run at the run's best share cannot carry `E` skips the whole run (a later start has fewer days and no greater share). A stretch without capacity costs one jump per run, never a walk.
- **Why one day at a time.** With a share that varies inside a span a later start can end earlier (a weak first day taxes the whole span), so a "jump past the conflict" could skip a valid start; the exact run-level pruning above gives identical results for a constant share.
- **Two levels.** The per-day test alone does not imply the view's week rule when FIXED load overbooks a day (3 MD on a 2/day day) or sits on a day without capacity or before the first candidate day. So the ledger also keeps, per ISO week, the exact `weekCap` (`sum of mdPerWeek/5` over ALL the week's working days, the view's `weekCapacity` unrounded) and the exact `weekUsed`
  (every booking's rate on every working day of the week, the days before the first candidate day and any unusable day included).
- **A candidate fits** only if the per-day test holds and, for every week it touches, `weekUsed + rate x (its days there) <= weekCap` (O(weeks touched) per candidate; a 0 MD estimate skips both load tests, WIP still applies). So the proposal never adds load to a week the view would show overloaded (`HALF_UP` rounding is monotone, so exact `load <= capacity` keeps the rounded comparison false).
  The fixed milestones' own excess (an overbooked in-progress milestone) stays and is shown, never added to.
  Example: F 3 MD on Mon 02-01 (`asOf` = 02-01), X 8 MD (4 days at 2): from 02-02 the week would load 3 + 8 = 11 of 10, so X starts Wed 02-03 (3 + 6 = 9; 02-08 loads 2).
- **Reasons.** `NO_CAPACITY`: no usable day exists at or after the milestone's earliest start (no period, or on hold from there on). `NO_ROOM`: usable days exist but no span fits before the horizon (`horizonWeeks` counted from the team's FIRST USABLE day, not from `asOf`: a team whose capacity starts years away is placed there). An unplaced milestone with NO dates needs nothing and is absent from `spansAfter`.
- **The fixpoint.** A SCHEDULED movable milestone that ends unplaced keeps its stored dates when the proposal is accepted, so its load is real: it is treated as fixed at its stored dates ("held": booked in the ledger, its dates feed link values), and the run repeats until the held set stops growing (at most `|movable| + 1` passes).
  It stays listed in `unplaced` with its reason and is present in `spansAfter` at its stored dates. Example: capacity on hold from 02-15, A 18 MD first in order, U 4 MD stored 02-08..02-09: accepting A's nine days would overload week 02-08 with U's kept dates, so U is held and A finds no nine free days either (both `NO_ROOM`; the week reads U's 4.00).
- **The post-check.** `weeks` = the view's own `weeklyLoad` over the team's spans AFTER the run (fixed + placed), the strip the team page shows after accepting everything. `links` = `DependencyKernels.check` before (stored spans) and after for every link with a MILESTONE end among the team's milestones plus every link with a PROJECT end whose derived span changed, violated-after first, then by link id.
- **Determinism and cost.** Inputs are sorted inside (`team` by effective order, `links`/`plan` by id, periods by `effectiveFrom`); nothing depends on hash order (pinned by shuffled inputs). Cost is bounded by the horizon, never by the data: arrays over at most about 2,600 working days; most candidates are O(1) thanks to the first-day tests,
  an end bound beyond the horizon answers `NO_ROOM` at once, a full candidate is O(days + weeks touched).

### Hand-counted vectors

`ScheduleKernelsTest`; 2027-02-01 is a Monday, capacity 10 MD/week from 2027-01-04 = 2/day, `asOf` Sunday 01-31, `MON_FRI`.

| Case | Result |
|---|---|
| 3 MD, WIP 2 (share 1) / no limit (share 2) | 02-01..02-03 / 02-01..02-02; 0 MD takes 02-01 (a second 0 MD under WIP 1 takes 02-02) |
| no limit, A 3, B 4, C 5 | A 02-01..02 (1.5/day), B 02-03..04 (2/day), C 02-05..09 (3 days at 5/3): the daily rule serialises what the week rule would run in parallel |
| fixed F Sat 01-30..Fri 02-05, X 4 MD, WIP 2 | F 5 MD: X 02-01..04. F 10 MD: X 02-08..11. F 15 MD (overbooked): X 02-08..11, week 02-01 stays 15.00 vs 10.00, nothing added |
| capacity 10, then 5 from Thu 02-04; X 7 MD | 7 days 02-01..02-09 (rate 1 is within every share); week 02-01 loads 5.00 against 3x2 + 2x1 = 8.00 |
| first period Mon 02-08 / no period / on hold / a period in 2086 | 02-08..02-09 / `NO_CAPACITY` / `NO_CAPACITY` / 2086-01-07..01-08 |
| on hold 02-08..02-12, 10 again from 02-15; X 3 MD, Y 10 MD | X 02-01..02; Y jumps the hold to 02-15..02-19. Hold for good: Y `NO_ROOM` |
| m 3 MD against a fixed P 02-01..02-05 (no limit) | FS 0: 02-08..09. FS 2: 02-10..11. FS -2: 02-04..05. FS -10: 02-01..02 (clamped). SS 1: 02-02..03. FF 0: 02-04..05. SF 0: 02-01..02 |
| Wed 02-03 a holiday | P ending 02-02, FS lag 2: 02-08..09. X 4 MD at 1/day: 02-01..02-05 (four working days, five calendar days) |
| order [c, a, b], `b -> c` FS (2 MD each, WIP 2) | b 02-01..02, c 02-03..04, a 02-01..02; `placements` read [c, a, b] |
| FF into a project | no bound; the post-check reads UNSCHEDULED before, `VIOLATED` after, shortfall 8 |
| `a FF b` + `b SS a`, a 3 MD, b 2 MD | b 02-01..02, a 02-01..03; the skipped hoist bound shows only as `a FF b` VIOLATED by 1 in the post-check |
| shuffled inputs / a cyclic plan / a dense 200-milestone team | identical output / `IllegalStateException` / no overloaded and no over-WIP week |

### The proposal endpoint

`POST /teams/{id}/schedule-proposal`, body `{asOf}`. ONE read-only REPEATABLE READ snapshot (the plan revision first, then the calendar and the rows: the team's milestones with their order keys, its capacity periods, EVERY active milestone and link) feeds `propose` and `postCheck`; nothing is stored, locked, bumped or audited. The answer's `revision` is the snapshot's plan revision (the batch's `expectedRevision`).
`asOf` is capped at `LAST_PLAN_DAY` minus the horizon (+1 week) so every proposed date stays writable. The guard order is `authorization.md`'s.

- **`moves`**: the placements whose span differs from the stored one (`from` null = unscheduled, `workingDays`, `shiftDays` in working days between the effective starts, null when newly scheduled). **`unchanged`**: the placements that land on their stored dates.
- **`unplaced`**: the kernel's verdicts with names (a scheduled milestone the fixpoint held at its stored dates is listed ONLY there).
- **`pinned`**: the team's pinned milestones that start after `asOf` (fixed by their pin; one already in progress is fixed regardless and not listed), in the team's effective order, in neither `moves` nor `unchanged`. The page says "N kept by a pin".
- **`weeks`/`weeksTruncated`** are the post-check's. **`dependencies`** are only the post-check's links whose verdict is VIOLATED before or after, each end slimmed to `{kind, id, name, projectName|null}` (no dates, no team; the full `check` carries `requiredDate`/`actualDate` after the moves, and `before` sits beside it).

### The scope check

`scopeHash` is the proposal's fingerprint of what the kernel read; the batch accept (`POST /teams/{id}/milestone-schedules`) recomputes it under the plan lock. The cross-team run's token is "The cross-team run"'s, and the two never match.

- **The token has three parts, 64 hex.** Chars 0-27 the **structure** digest (the first 28 hex of `sha256(canonical JSON of ScheduleScope)`, the scope WITHOUT the holidays); chars 28-55 the **holidays** digest (the first 28 hex of `sha256` of the canonical JSON array of the Monday-Friday holidays ascending, `WorkingCalendar.offDayDates()`: a weekend holiday changes nothing);
  chars 56-63 the proposal's `asOf` as days since 1900-01-01 in 8 hex (`ScopeDigests.token`, `ScopeToken`). Two proposals of an unchanged plan for the same `asOf` carry the same token.
- **The accept** carries `scopeHash` OPTIONALLY (absent: no check). It recomputes the token UNDER THE PLAN LOCK from the same function over the same row shape (`loadScheduleSnapshot` → `ScheduleSnapshot.scopeDigests`, the proposal's own loader) and refuses the WHOLE batch with `409 stale-scope` (nothing written, no bump, no audit) on a different STRUCTURE part,
  or when another milestone of the team that the batch does not name has `schedule_revision > expectedRevision` (the team sweep). A token of another layout lands in the same refusal: a proposal open across an upgrade is refused once and proposed again by the page.
- **In the structure hash:** the team's milestone set with each one's project, estimate and **pin** (a pin flipped after the proposal is a `409 stale-scope`); the team's effective ORDER (stored positions, the projects' global rank, project and milestone names, ids) with the milestones' own start/end taken out of its tiebreak (as the id sequence, so an absolute rank shift that reorders nothing is not a change);
  the capacity periods (`effectiveFrom`, man-days, WIP); every link with an end that is a team milestone or a project holding one, each end carrying the span of its FOREIGN part (a foreign milestone's own span; a project's derived span over its milestones of OTHER teams).
- **Out of the structure hash:** the Monday-Friday holidays (their own digest); the team's OWN milestones' spans, fixed or movable, scheduled or not (covered by `schedule_revision`: a batch item is the per-item `STALE`, any other team milestone is the sweep, so a colleague dragging a batch item skips that item and the rest land, and the team's own accepted moves never stale a later accept); the horizon (not state).
  A change of the other teams' milestones that no link of the team touches changes nothing the kernel reads and does not flip the hash.
- **The look-again.** When the structure and the sweep pass and ONLY the holidays part differs, the accept does not refuse. It decodes `asOf` from the token (a day past `LATEST_AS_OF`, or any other undecodable part, is `409 stale-scope`), runs the kernel ONCE on the snapshot the check just loaded (`ScheduleKernels.propose(snapshot.inputs(teamId, asOf))`, `proposeMany` for a run; `ScheduleSnapshot.freshSpans`)
  and goes through only when EVERY item carries both dates and equals the fresh `spansAfter` of its milestone (`acceptsOnlyFreshDates`: another date, an unschedule pair, a milestone the fresh run does not place are all `409 stale-scope`; nothing written, no bump).
- **What the look-again writes** is exactly what a proposal computed now, on the current dictionary, would propose for those milestones: the page's own "propose again, accept the same ticks" without the round trip. A far-off holiday and a near one that moves nothing pass; a holiday inside an accepted span, or on a day that moves one, refuses. A colleague's drag of a batch item together with a holiday change refuses the batch instead of skipping the item.
- **Cost.** With unchanged holidays the check is the digests only and runs NO kernel (the `asOf` part is not even decoded); on the look-again path one kernel run under the plan lock.
- **Known consequence.** The per-item `STALE` rule judges each item alone: if a batch item is the hoisted predecessor of another batch item and is skipped as `STALE`, the dependent item is still written against the predecessor's PROPOSED dates and its link may read violated on the team view, which only warns. The page re-proposes at once on this 409 (`web-internals.md` "Teams and the team page").

Pinned by: `ScheduleKernelsTest`, `ScheduleProposalTest`, `ScheduleScopeTest`, `TeamScheduleScopeTest`, `CrossTeamAcceptTest`.

## The cross-team run

Files: `planning/CrossTeamKernels.kt` (the kernel); `CrossTeamSchedule.kt`, `CrossTeamProposalService.kt`, `CrossTeamScheduleRoutes.kt`, `ScheduleSnapshot.kt`, `ScheduleScope.kt` (the endpoints); `TeamScheduleService.acceptRun`, `TeamSchedule.kt` (the accept).

"The auto-proposal" places ONE team with every other team's dates fixed, and accepting every team in turn never reaches a global fixed point (the other teams' dates are constraints, so the first team moves again after the rest were accepted). The cross-team run is that proposal over a SET of teams (the user's answer). It is pure like the kernel it is built on (no I/O, no clock). Nothing moves; a run stores nothing.

### Kernel

- **API.** `ScheduleKernels.proposeMany(MultiTeamInputs): MultiTeamResult` (extension functions on the `ScheduleKernels` object). `MultiTeamInputs(asOf, teams: List<TeamRun>, plan, links, calendar, horizonWeeks = 520, maxPasses = MAX_CROSS_TEAM_PASSES)`; `TeamRun(teamId, name, team: List<TeamScheduleItem>, periods)` (`name` is only the team order's tiebreak).
  `MultiTeamResult(order, passes, settled, byTeam: Map<teamId, ScheduleProposalResult>, placements)`: `byTeam` iterates in `order`; each value is the team's result of the LAST pass, the very `ScheduleProposalResult` of the per-team kernel. `placements` (internal, never on the wire) counts the per-team kernel runs.
- **`MAX_CROSS_TEAM_PASSES = 5`**, a separate constant from the per-team fixpoint's (that one is internal to each team's run). `propose` itself is `requireAcyclicPlan` + `proposeUnchecked`; the run calls `proposeUnchecked` per team and pass and checks the plan ONCE (containment over `plan` and every run team's rows, all links), because 75 acyclicity checks of about 300 DFS over 2,200 points would be the whole cost.
- **Each team is placed by today's kernel,** with the teams placed so far as FIXED facts. The other teams enter a team's run only through `inputs.plan`: the run keeps a working copy of the plan facts and, after a team, replaces that team's facts by the spans it ended on (a milestone with no span after the run gets `null`). The team's own facts are ignored by teamId, so its `TeamScheduleItem.span` stays the STORED span (the `from` of a move, the fixed test, the order tiebreak).
  Before the first pass every run team's facts are its stored rows. **Pinned milestones are fixed everywhere:** in their own team's run, in its `spansAfter` at the stored dates, as the stored dates in every other team's facts, and in no placement list.
- **The team order.** A team graph over the run's teams has an edge `a -> b` per link with an end on `a` and the other on a different team `b` (a MILESTONE end is its plan fact's team, a PROJECT end every run team holding one of its milestones; teams outside the run add no edge, their dates never change).
  Influence flows only along links (`ScheduleConstraints.bounds` reads link predecessors), so the graph captures every path by which one team's placement can change another's.
- **Kahn's algorithm** picks among the READY teams (no incoming edge from a remaining team) by ONE comparator: **the most movable milestones first** (`span == null || (start > asOf && !pinned)` at the stored dates, the complement of the kernel's fixed test), then the **name case-insensitively**, then the **id**.
- **The cycle break.** When a cycle leaves no team ready the same comparator picks among the teams of the SOURCE strongly connected components of what remains (a team is eligible when every remaining team that reaches it is also reachable from it; closure per round over at most 50 teams), so a team merely downstream of a cycle is never placed before that cycle.
  An edge whose source is placed after its target is a **back edge** (only a cyclic team graph has any): the target read the source's dates of the PREVIOUS pass.
- **Passes and `settled`.** Pass 1 places every team in `order` once; from pass 2 only the stale ones (the worklist below). A team is **changed** in a pass when its `spansAfter` differs from its previous result's (pass 1: from its stored spans). After a pass, **`settled`** = no team changed in it is the SOURCE of a back edge (a change read only by later-placed teams was already seen in this pass, so a next pass would reproduce every result); then the run stops, `passes` = the passes made.
  After `maxPasses` without settling: `settled = false` and the last pass's results stand (each team's dates are self-consistent; the cross-team links that still fail are what the post-check reports).
- **The worklist (1.26).** Pass 1 places every team; from pass 2 a team is placed again only when a team with an edge INTO it (`TeamGraph.predecessorsOf`) changed its `spansAfter` since this team last ran (a version per team, the versions each team saw at its last run). A skipped team keeps its previous result and counts as unchanged, so `order`, `passes`, `settled` and `byTeam` are exactly those of placing every team every pass.
  **The premise:** a team reads other teams ONLY through `values.spanOf(link.predecessor)` in `ScheduleConstraints.bounds` (`Pass.execute` puts the others' facts into `values`, and nothing else reads them), and the teams behind a predecessor (its milestone's team, every run team holding a milestone of a predecessor project) are exactly the edge sources; rows, periods, calendar and `asOf` are constants. A new cross-team read breaks it: `CrossTeamWorklistTest` (500 seeded worlds against an exhaustive loop kept in the test) fails.
- **Pinned consequences.** An acyclic team graph settles in ONE pass; a single team always does and equals `propose`; teams with no link between them each equal their own `propose`; the request order never matters (the order is computed); shuffled `teams`/`plan`/`links`/rows give the identical result.
- **`checkMany(inputs, afterByTeam)` and `postCheckMany(inputs, result)`.** `before` = every plan fact's stored span (the run teams' from their rows); `after` = the stored spans of the teams OUTSIDE the run plus `afterByTeam` (team → milestone → span, an id absent = no dates); a run team with no entry fails closed with `NoSuchElementException`.
  Per team: `weeks` = the view's `weeklyLoad` over its after-spans (`ScheduleKernels.proposedWeeks`, also `postCheck`'s) and `links` = `teamLinkChecks`: a link with a MILESTONE end among the team's, or a PROJECT end that holds one of the team's milestones AND whose derived span changed.
  So a link between two run teams is in BOTH lists. For ONE team the holding clause is implied and `postCheck` is unchanged. `postCheckMany` is `checkMany` over the run's own final spans.
- **`CheckInputs(teams, plan, links, calendar)`** (`MultiTeamInputs.checkInputs()`, `CrossTeamSnapshot.checkInputs()`) is the narrower input of `checkMany`: no `asOf`, horizon or pass limit, so none can be read by mistake.
- **Cost.** 15 teams x up to 5 passes would be up to 75 `proposeUnchecked` calls; the worklist makes 43 of 60 on the sample's sizes (4 passes), plus one acyclicity check: about 212-236 ms a run (257 ms placing every team every pass), `postCheckMany` about 11 ms (`ScheduleKernelsScaleTest`, tripwire 20 s). The biggest team dominates the time and is placed in every pass it is stale.

### The run endpoint

`POST /api/v1/schedule-proposals`, body `{asOf, teamIds[1..50]}`, answers `{revision, asOf, passes, settled, teams[], scopeHash}`. A COMPUTATION like the per-team proposal: `200`, no lock, no bump, no audit event, nothing stored. `teams[]` is in PLACEMENT order (`MultiTeamResult.order`; no separate `order[]`).
Each block is the per-team proposal's shape without the run-level fields: `{teamId, name, moves, unchanged, unplaced, pinned, weeks, weeksTruncated, dependencies}` (`proposalLists` and `proposalLinks` are shared with the per-team service through `ScheduleProposalAssembly.kt`). `dependencies` are the links touching THAT team, violated before or after over the WHOLE run's final dates (`postCheckMany`).

- **Order of checks.** The team SET is in the body, so it differs from the per-team route: the body decodes first (a malformed body is a `400` even for a caller the guard would refuse); `validateTeamIds` `400` (1..50, none twice); `PlanRouteDeps.requireTeamManagers` (every team ACTIVE else `404` for EVERY caller, `TeamService.activeNamesAmong`, one query);
  `requireTeamManagerOfAllOrAdmin` (ADMIN, or one `activeManagedTeamIds` query and every listed team in it, else `403`); then `asOf` `400` (`validateAsOf`; a forbidden caller's malformed `asOf` stays `403`).
- **One snapshot, no lock.** `CrossTeamProposalService.propose` is ONE read-only REPEATABLE READ transaction whose FIRST statement is the plan revision, then the teams' names, the calendar, per team `teamMilestoneRows` / `positionsOf` / `teamCapacityRows`, and the plan-wide `milestoneFacts` / `linkFacts` read ONCE (`loadCrossTeamSnapshot` → `CrossTeamSnapshot`),
  so `revision`, every block, the link verdicts and `scopeHash` describe one plan. A team deleted between the guard and the snapshot is the same `404`.
- **`scopeHash`** is the same three-part token as the per-team proposal's ("The auto-proposal" › "The scope check"; the holidays digest and `asOf` as there; `CrossTeamSnapshot.scopeDigests`), but the structure digest is over `ScheduleRunScope`: the teams sorted by id with their LOWERCASE names (the team order's tiebreak reads the name, so a rename can change the placement)
  plus one `ScheduleScope` per team built with the WHOLE run set as "own" (`scheduleScope(..., runTeamIds)`; the per-team endpoints keep the default `setOf(teamId)`).
- **"Foreign" = outside the run.** A run team's milestone spans are NOT in the hash (each is covered by its `schedule_revision`: a colleague's drag of a ticked item must skip that item, not refuse the run); a team outside the run enters only through the links that touch a run team.
- **`GET /api/v1/schedule-proposals/teams`** answers `{items[{id, name}], truncated}`: the first 1,000 ACTIVE teams the caller may include (ADMIN: all; otherwise the actor's `managedTeamIds`), with eligibility applied in SQL before the case-insensitive name/id order and limit. `truncated` says more eligible teams exist. It is the page's multi-select; the server's `403` stays the rule.
- **Size.** The sample-density plan (15 teams, 1,000 milestones, 300 links) answers about 470 KB uncompressed in 3 passes, settled (`CrossTeamProposalSizeTest` gates the bytes at 600,000 B with a 10 s tripwire).

### The accept

`POST /api/v1/schedule-proposals/accept`, body `{expectedRevision, scopeHash, teamIds[1..50], items[1..2,000]}` (`MAX_RUN_SCHEDULE_ITEMS`; items are the per-team batch's `{milestoneId, startDate, endDate}`), answering the per-team batch's `{revision, accepted, skipped}`: N teams' schedule PUTs in ONE plan write, ONE bump (an all-skipped accept bumps too).

- **Two deliberate differences from the per-team batch's body, both forced by the hash.** `teamIds` is IN the body (the run's fingerprint is over a team SET the items do not determine: a team whose moves were all unticked is still a premise of the run, so it must still be locked, re-guarded and checked). `scopeHash` is REQUIRED (a missing field is a `400` at the decode).
- **Order of checks.** Body decodes (`400`) → `validateTeamIds` `400` → every team ACTIVE else `404` → `requireTeamManagerOfAllOrAdmin` `403` → the rest of the shape `400` before the lock (`validateCrossTeamAccept`; a forbidden caller's malformed items stay `403`).
- **Inside `withPlanWrite`:** for each team in ASCENDING id order `lockActiveTeam` (`404`, `FOR SHARE`) then the locked guard (`teamManagerGuard`, `403`: ADMIN, or the ACTIVE manager of EVERY team as of the lock) → `expectedRevision` above the plan revision `409 stale-revision` → `requireRunScopeUnchanged` → the per-item rules.
- **`requireRunScopeUnchanged`** is `409 stale-scope` when the hash recomputed under the lock differs (`loadCrossTeamSnapshot` with the teams' CURRENT names, read after the team rows were locked, through the very loader and `CrossTeamSnapshot.scopeDigests` the run used; a different holidays part only is the look-again of "The auto-proposal" › "The scope check": `proposeMany` once, the items must equal the fresh spans),
  **or** when ANY milestone of ANY run team that the accept does not name has `schedule_revision > expectedRevision` (`reschedulesOutsideBatch(teamIds, …)`: `teamId IN (set)`, one `LIMIT 1` query). The sweep covers the FIXED milestones (started, pinned) too, whose spans the run's hash deliberately does not read; a pin flip is in the hash.
- **The per-item rules** (`decideItems`, shared with `batch`): the first of `GONE` / `NOT_ON_TEAM` (the item's STORED team is outside the set) / `NO_WORKING_DAY` / `STALE` skips it; the rest are written by `writeSchedules` with `schedule_revision = revision + 1`. A GONE or NOT_ON_TEAM item is data in the `200`, never a refusal.
- **The per-team and the run hash never cross.** The two definitions of "foreign" differ, so a per-team `scopeHash` on the run accept and a run `scopeHash` on `POST /teams/{id}/milestone-schedules` are both `409 stale-scope`; `CrossTeamAcceptTest` pins both ways so nobody "fixes" it.
- **Audit** (`observability.md`): `milestone.scheduled` per changed item with the item's STORED team (`AcceptedSchedule.teamId`, which the per-team batch fills too), `milestone.unpinned` per released pin, and ONE `team.schedule_batch_applied` per team of the set (ascending id) over the items whose stored team it is, plus the additive `runTeamIds`.

### The check

`POST /api/v1/schedule-proposals/check` (`CrossTeamProposalService.check`), body `{teamIds[1..50], items[1..2,000]}` (the accept's items; the null pair unschedules; no `asOf`: no verdict reads it) answers `{teams[{teamId, weeks, weeksTruncated, dependencies}]}` in the REQUEST's team order. It answers "what if only THESE moves were accepted".

- **How.** Each listed team's `after` is its STORED spans (`CrossTeamSnapshot.storedSpansOf`) with exactly the items overlaid, every other milestone keeps its stored dates, and `ScheduleKernels.checkMany` gives `weeks` and `dependencies` (the links touching the team that are or were violated, as the proposal's).
  So an unticked move keeps its stored dates, and a successor ticked WITHOUT its predecessor is judged against the predecessor's stored (or colleague-moved) dates.
- **What it cannot do.** The check cannot anticipate a skip (`STALE`, `NO_WORKING_DAY`); it describes the ticked subset as written. For the spans of a per-team proposal the answer equals that proposal's `weeks` and `dependencies`. Both pages call it, debounced: the cross-team page with the run's set, the team page with its one team.
- **Order of checks** (the team set is in the body): decode `400` → `validateTeamIds` `400` → every team ACTIVE else `404` → `requireTeamManagerOfAllOrAdmin` `403` → the items' shape `400` (`validateScheduleCheck`, after the guard) → ONE read-only REPEATABLE READ snapshot (no lock, no audit, nothing stored; a team deleted in the gap is the same `404`)
  → an item whose milestone is not an ACTIVE milestone of a listed team (unknown, deleted, another team's) is a `400` naming the ids (a client bug: ignoring it would make the verdicts describe another subset).

### Saved proposals

Files: `planning/SavedProposal.kt` (DTOs, `STORED_PROPOSAL_FORMAT`), `SavedProposalService.kt`, `SavedProposalRows.kt` (the header, the state), `SavedProposalRoutes.kt`; V32 (`persistence.md`). Pinned by: `SavedProposalTest`, `SavedProposalStateTest`, `SavedProposalRetentionTest`, `StoredProposalFormatTest`, `PlanStateTest`.

A saved run lets a second manager open what a first one computed (the user's answers: every signed-in user may read one; the newest 20 are kept). A computation kept, never a write to the plan. **Retention is global:** any save removes the globally oldest row beyond 20, whoever saved it; the delete guard stops a targeted delete only. A save is rate limited per login (`schedule-proposal-save`, 10 a minute, before the guard).

- **`/api/v1/saved-schedule-proposals`:** `POST {name, asOf, teamIds, expectedRevision, scopeHash, selectedMilestoneIds}` (the run's token and the ticks, no document) answers `201` + `Location` + the summary; `GET` `{items}` (at most 20, newest first, no document); `GET /{id}` the record; `DELETE /{id}` `204`, a hard delete. The order of checks: `authorization.md` "Schedule proposals".
- **The save is ONE read-write REPEATABLE READ transaction and no plan lock.** `LOCK TABLE … SHARE ROW EXCLUSIVE` comes first (a snapshot starts at the first query, so a waiting save reads what its predecessor committed and two never prune one row; readers are not blocked), then the manager-of-every-team guard again (`403` for a manager cleared while it waited, nothing stored), then the plan revision, `409 stale-revision` (`expectedRevision` above it), the teams' names (gone = `404`), `loadCrossTeamSnapshot`,
  `409 stale-scope` (the fresh token, `asOf` included, differs from `scopeHash`, or ANY milestone of a run team has `schedule_revision` above `expectedRevision`: `reschedulesOutsideBatch` with no items; a changed holiday is stale, there is no look-again),
  `assembleProposal` (`proposeMany` + `postCheckMany`, the run endpoint's own assembly), a ticked id that is no move `400`, for a PARTIAL selection `checkResponse` over the ticked moves (else `check` is null), the insert, the prune beyond the newest 20 by `id`.
- **`state` is derived at every read, never stored.** CURRENT: the current structure and holidays digests equal the stored token's AND no run-team milestone has `schedule_revision` above the proposal's `planRevision`. CHANGED: otherwise (a run team gone, a rename, a pin, a link, a capacity period). UNREADABLE: `format` is not `STORED_PROPOSAL_FORMAT` (no state is computed; `proposal` and `check` are null).
- **`can`** is `PlanPermissions.canDeleteSavedProposal` and `canAcceptSavedProposal`: ADMIN or the manager of every stored team, and for Accept also CURRENT. A hint: Accept is the unchanged `POST /schedule-proposals/accept`, which re-checks everything.
- **`STORED_PROPOSAL_FORMAT`** is the shape version of the stored `CrossTeamProposal`, `ScheduleCheckResponse` and the `teams`/`selected` columns. `StoredProposalFormatTest` fingerprints their serial descriptors (every list element type walked): a DTO change without a bump and a new fingerprint line fails; the old rows then read UNREADABLE, no migration.
- **Audit:** `schedule_proposal.saved` and `.deleted` (`observability.md`); reads emit none.

### Hand-counted vectors

`CrossTeamKernelsTest`; the builders and calendar of `ScheduleKernelsTest` (2027-02-01 a Monday, 10 MD/week from 2027-01-04 = 2/day, `asOf` Sunday 01-31, `MON_FRI`).

| Case | Result |
|---|---|
| two teams with no link | each equals its own `propose`, one pass; equal movables, the name decides |
| A: a1 4 MD stored 02-22..02-23, `a1 -> b1` FS; B: b1 2 MD unscheduled | order [A, B] whatever the request order; a1 02-01..02-02, b1 02-03 (the PROPOSED end, not the stored 02-23); one pass |
| cycle `a1 -> b1 -> a2`, A at 50 MD/week | order [A, B] (2 movables vs 1); pass 2 moves a2 only; `passes 2`, `settled` (B unchanged) |
| the same at 10 MD/week | `passes 3`, `settled`; with `maxPasses` 2: `settled = false`, the pass-2 dates stand |
| the 50 MD/week cycle with `maxPasses` 1 | `settled = false`; `postCheckMany` lists `b1 -> a2` in BOTH teams: `UNSCHEDULED` before, `VIOLATED` after |
| B: b1 pinned 02-15..02-16, `b1 -> a1` FS | order [B, A]; b1 stays, in no placement or unplaced list; a1 02-17; unpinned: b1 02-01, a1 02-02 |
| a team cycle, 3 movables vs 2 / equal counts / equal names | the team with more movables first / the lower name, case-insensitively / the lower id; an in-progress or pinned milestone is not counted |
| a team merely downstream of a cycle | the cycle's source component is placed first, the downstream team after the cycle's FINAL dates |
| `a1 -> b1` plus `P -> Q` (both projects hold only B's milestones) | link 1 in both teams' lists, link 2 in B's only |
| shuffled inputs / a cyclic plan / a team twice / `maxPasses` 0 | identical result / `IllegalStateException` / `IllegalArgumentException` x 2 |

Pinned by: `CrossTeamKernelsTest`, `CrossTeamWorklistTest`, `ScheduleKernelsScaleTest`, `ScheduleKernelsTest`, `CrossTeamProposalTest`, `CrossTeamProposalSizeTest`, `CrossTeamAcceptTest`, `ScheduleCheckTest`, `PlanStateTest`.
