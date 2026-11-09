package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate

/*
 * The cross-team run (1.8.0; `planning-model.md` "The cross-team run"): pure functions, no I/O, no clock. ONE proposal over several
 * teams - the teams in dependency order, each placed by [ScheduleKernels.proposeUnchecked] (today's per-team kernel) with the teams
 * placed so far held as fixed facts, repeated until a pass changes nothing that an earlier team reads, or [MAX_CROSS_TEAM_PASSES].
 * Nothing here moves a date; the other teams enter a team's run only through its `plan` facts, so the run just hands each team a plan
 * whose run-team facts carry the dates proposed so far.
 */

/** The most passes a cross-team run makes before it answers with `settled = false` (the last pass's dates stand). */
const val MAX_CROSS_TEAM_PASSES = 5

/** One team of a run: its ALL active milestones and capacity periods. [name] is only the deterministic tiebreak of the team order. */
data class TeamRun(val teamId: UInt, val name: String, val team: List<TeamScheduleItem>, val periods: List<CapacityPeriod>)

/**
 * Everything a cross-team run reads: [teams] (each once), [plan] every active milestone of the plan (the facts of a run team are
 * superseded by its [TeamRun.team] rows), [links] every active link. [asOf] and [horizonWeeks] mean what they mean in [ScheduleInputs].
 */
data class MultiTeamInputs(
    val asOf: LocalDate,
    val teams: List<TeamRun>,
    val plan: Collection<PlanMilestoneFact>,
    val links: Collection<PlanLinkFact>,
    val calendar: WorkingCalendar,
    val horizonWeeks: Int = MAX_LOAD_WEEKS,
    val maxPasses: Int = MAX_CROSS_TEAM_PASSES,
)

/**
 * [order] is the placement order of the team ids, [passes] the passes made, [settled] whether another pass would reproduce every
 * result, [byTeam] each team's result of the LAST pass (iteration order = [order]).
 */
data class MultiTeamResult(val order: List<UInt>, val passes: Int, val settled: Boolean, val byTeam: Map<UInt, ScheduleProposalResult>)

/**
 * The team placement order and the teams that are the SOURCE of a back edge (an edge `a -> b` with `a` placed after `b`: `b` read `a`'s
 * dates of the previous pass).
 */
internal class TeamGraph(val order: List<UInt>, val backEdgeSources: Set<UInt>)

/**
 * Places every team of [inputs] in dependency order to a fixed point. The plan's acyclicity is checked ONCE (not per team and pass).
 * A team graph without a cycle settles in ONE pass; a single team equals [ScheduleKernels.propose]; teams with no link between them
 * each equal their own `propose`. Pinned milestones (V25) are fixed in their own team's run and so at their stored dates everywhere.
 */
fun ScheduleKernels.proposeMany(inputs: MultiTeamInputs): MultiTeamResult {
    require(inputs.maxPasses >= 1) { "maxPasses must be at least 1" }
    require(inputs.teams.map { it.teamId }.toSet().size == inputs.teams.size) { "a team is listed twice" }
    requireAcyclicPlan(planContainment(inputs.plan, inputs.teams.flatMap { it.team }), inputs.links.sortedBy { it.id })
    val graph = teamOrder(inputs)
    val runs = inputs.teams.associateBy { it.teamId }
    val working = LinkedHashMap<UInt, PlanMilestoneFact>()
    inputs.plan.sortedBy { it.id }.forEach { working[it.id] = it }
    for (run in inputs.teams) run.team.forEach { working[it.id] = PlanMilestoneFact(it.id, it.projectId, run.teamId, it.span) }
    var previous: Map<UInt, Map<UInt, DaySpan>> =
        inputs.teams.associate { run -> run.teamId to run.team.mapNotNull { item -> item.span?.let { item.id to it } }.toMap() }
    var results: Map<UInt, ScheduleProposalResult> = emptyMap()
    var passes = 0
    var settled = false
    while (passes < inputs.maxPasses && !settled) {
        passes++
        val pass = LinkedHashMap<UInt, ScheduleProposalResult>()
        for (teamId in graph.order) {
            val run = runs.getValue(teamId)
            val teamInputs = ScheduleInputs(
                inputs.asOf, teamId, run.team, run.periods, working.values, inputs.links, inputs.calendar, inputs.horizonWeeks,
            )
            val result = proposeUnchecked(teamInputs)
            pass[teamId] = result
            for (item in run.team) working[item.id] = PlanMilestoneFact(item.id, item.projectId, teamId, result.spansAfter[item.id])
        }
        // A team whose result changed AND is read by an earlier-placed team (a back edge) forces another pass; a change read only by
        // later teams was already seen in this very pass, so the next pass would reproduce every result (the kernel is deterministic).
        val changed = pass.filter { (teamId, result) -> result.spansAfter != previous[teamId] }.keys
        settled = changed.none { it in graph.backEdgeSources }
        previous = pass.mapValues { it.value.spansAfter }
        results = pass
    }
    return MultiTeamResult(graph.order, passes, settled, results)
}

/**
 * The post-check of a finished run: [checkMany] over the run's own final spans. A link between two run teams is listed for both;
 * a link a team's list names is judged on the whole plan (before = every stored span, after = the run's). A run team missing from
 * [MultiTeamResult.byTeam] fails closed (`NoSuchElementException`, see [checkMany]).
 */
fun ScheduleKernels.postCheckMany(inputs: MultiTeamInputs, result: MultiTeamResult): Map<UInt, ScheduleProposalCheck> =
    checkMany(inputs, result.byTeam.mapValues { it.value.spansAfter })

/**
 * The post-check of ANY set of final spans of the run teams ([afterByTeam]: team id -> milestone id -> span, an id absent = no dates):
 * `before` is every plan fact's stored span, `after` the stored spans of the teams outside the run plus [afterByTeam]. Per team the
 * weekly load of its after-spans and the links of [ScheduleKernels.teamLinkChecks]. `asOf` and the horizon are not read. Every run
 * team MUST have an entry in [afterByTeam] (an empty map = nothing dated): a missing one throws `NoSuchElementException` (fail closed,
 * never read as "no dates"), so a caller building the map must cover the whole run.
 */
fun ScheduleKernels.checkMany(inputs: MultiTeamInputs, afterByTeam: Map<UInt, Map<UInt, DaySpan>>): Map<UInt, ScheduleProposalCheck> {
    val runIds = inputs.teams.map { it.teamId }.toSet()
    val before = PlanValues()
    val after = PlanValues()
    for (fact in inputs.plan.sortedBy { it.id }) {
        val span = fact.span
        if (fact.teamId !in runIds && span != null) {
            before.put(fact.id, fact.projectId, span)
            after.put(fact.id, fact.projectId, span)
        }
    }
    for (run in inputs.teams) {
        val spans = afterByTeam.getValue(run.teamId)
        for (item in run.team) {
            item.span?.let { before.put(item.id, item.projectId, it) }
            spans[item.id]?.let { after.put(item.id, item.projectId, it) }
        }
    }
    return inputs.teams.associate { run ->
        val (weeks, truncated) = proposedWeeks(run.team, run.periods, afterByTeam.getValue(run.teamId), inputs.calendar)
        run.teamId to ScheduleProposalCheck(weeks, truncated, teamLinkChecks(run.team, inputs.links, inputs.calendar, before, after))
    }
}

/**
 * The team graph of the run: an edge `a -> b` per link with an end on `a` (a PROJECT end = every run team holding one of its
 * milestones) and the other on a different team `b`, both in the run - the only paths along which one team's placement changes
 * another's. Kahn's algorithm picking, among the READY teams, the one the single comparator ranks first - the most movable milestones,
 * then the name case-insensitively, then the id; when a cycle leaves no team ready the same comparator picks among the teams of the
 * source components of what remains (the cycle break). An edge whose source is placed after its target is a back edge.
 */
internal fun teamOrder(inputs: MultiTeamInputs): TeamGraph {
    val runIds = inputs.teams.map { it.teamId }.toSet()
    val teamOf = HashMap<UInt, UInt>()
    val projectOf = HashMap<UInt, UInt>()
    for (fact in inputs.plan) {
        teamOf[fact.id] = fact.teamId
        projectOf[fact.id] = fact.projectId
    }
    for (run in inputs.teams) {
        for (item in run.team) {
            teamOf[item.id] = run.teamId
            projectOf[item.id] = item.projectId
        }
    }
    val teamsOfProject = HashMap<UInt, MutableSet<UInt>>()
    for ((milestone, project) in projectOf) {
        teamOf[milestone]?.takeIf { it in runIds }?.let { teamsOfProject.getOrPut(project) { HashSet() }.add(it) }
    }
    fun teamsOf(end: EndpointRef): Set<UInt> =
        if (end.kind == EndpointKind.MILESTONE) setOfNotNull(teamOf[end.id]?.takeIf { it in runIds }) else teamsOfProject[end.id].orEmpty()

    val edges = LinkedHashSet<Pair<UInt, UInt>>()
    for (link in inputs.links.sortedBy { it.id }) {
        for (from in teamsOf(link.predecessor)) for (to in teamsOf(link.successor)) if (from != to) edges.add(from to to)
    }
    val movable = inputs.teams.associate { run ->
        run.teamId to run.team.count { it.span == null || (it.span.start > inputs.asOf && !it.pinned) }
    }
    val names = inputs.teams.associate { it.teamId to it.name.lowercase() }
    val ranking = compareByDescending<UInt> { movable.getValue(it) }.thenBy { names.getValue(it) }.thenBy { it }

    val remaining = runIds.toMutableSet()
    val order = ArrayList<UInt>(runIds.size)
    while (remaining.isNotEmpty()) {
        val ready = remaining.filter { team -> edges.none { (from, to) -> to == team && from in remaining } }
        val next = (ready.ifEmpty { sourceComponents(remaining, edges) }).minWith(ranking)
        remaining.remove(next)
        order.add(next)
    }
    val position = order.withIndex().associate { (index, team) -> team to index }
    val sources = edges.filter { (from, to) -> position.getValue(from) > position.getValue(to) }.map { it.first }.toSet()
    return TeamGraph(order, sources)
}

/**
 * The cycle break's candidates: the remaining teams in a SOURCE strongly connected component of the subgraph that [remaining] induces
 * on [edges] - a team is eligible when every remaining team that reaches it is also reachable from it - so a team merely downstream of
 * a cycle is never placed before that cycle. One search per team per round (a run is at most 50 teams).
 */
private fun sourceComponents(remaining: Set<UInt>, edges: Set<Pair<UInt, UInt>>): List<UInt> {
    val successors = edges.filter { (from, to) -> from in remaining && to in remaining }.groupBy({ it.first }, { it.second })
    val reach = remaining.associateWith { start ->
        val seen = HashSet<UInt>()
        val stack = ArrayDeque(listOf(start))
        while (stack.isNotEmpty()) {
            for (next in successors[stack.removeLast()].orEmpty()) if (seen.add(next)) stack.addLast(next)
        }
        seen
    }
    return remaining.filter { team ->
        remaining.all { other -> other == team || team !in reach.getValue(other) || other in reach.getValue(team) }
    }
}
