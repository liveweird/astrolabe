package ch.nokillswit.planning

import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.infra.json.sha256Hex
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.math.BigDecimal
import java.time.LocalDate

/*
 * The scope fingerprint of a schedule proposal (v0.9.0; `planning-model.md` "The auto-proposal"): a content hash of everything the
 * scheduling kernel reads about ONE team that the batch accept's per-milestone `schedule_revision` rule does NOT already cover. The
 * proposal answers it (`scopeHash`) and the batch accept recomputes it under the plan lock from the same rows through the same function
 * ([scheduleScope]); a difference is a 409 `stale-scope`, nothing written.
 *
 * What is in and what is out, input by input:
 *  - IN: the team's milestone set with each one's project, estimate and PIN (V25: the kernel treats a pinned milestone as fixed, so a pin
 *    flipped after the proposal is a `stale-scope`, never an accept against a premise the preview did not see); the team's effective
 *    ORDER with the milestones' own dates taken out of its tiebreak (the stored positions, the projects' global rank and the names
 *    still count); the team's capacity periods; every link that touches the team (an end is one of its milestones, or a project
 *    holding one) with, per end, the span of what is NOT the team's; the Monday-Friday holidays.
 *  - OUT, covered elsewhere: the team's OWN milestones' spans - `schedule_revision` (a batch item is skipped STALE, any other team
 *    milestone is the batch's sweep). Hashing them would make a colleague's drag of a batch item refuse the whole batch instead of
 *    skipping that item, and the team's own accepted moves would stale every later accept.
 *  - OUT, not state: `asOf` (the viewer's clock; the batch carries the dates it chose), the horizon (a constant).
 */

@Serializable
data class ScopeMilestone(val id: UInt, val projectId: UInt, val estimateMd: String, val pinned: Boolean)

@Serializable
data class ScopePeriod(val effectiveFrom: String, val mdPerWeek: String, val wipLimit: Int?)

/**
 * One end of a link: [foreignStart]/[foreignEnd] are the span of what on that end is NOT the team's (a foreign milestone's own span;
 * a project's derived span over its milestones of OTHER teams); null for a team milestone or a project with no dated foreign milestone.
 */
@Serializable
data class ScopeEnd(val kind: EndpointKind, val id: UInt, val foreignStart: String?, val foreignEnd: String?)

@Serializable
data class ScopeLink(val id: UInt, val predecessor: ScopeEnd, val successor: ScopeEnd, val type: DependencyType, val lagDays: Int)

@Serializable
data class ScheduleScope(
    val teamId: UInt,
    val milestones: List<ScopeMilestone>,
    val order: List<UInt>,
    val periods: List<ScopePeriod>,
    val links: List<ScopeLink>,
    val holidays: List<String>,
)

/**
 * The scope of [teamId] from the rows the kernel reads: its milestones [team], its capacity [periods], every active milestone of the
 * [plan] and every active [links], the Monday-Friday [holidays]. Pure; the result does not depend on the order of any input.
 */
fun scheduleScope(
    teamId: UInt,
    team: Collection<TeamScheduleItem>,
    periods: Collection<CapacityPeriod>,
    plan: Collection<PlanMilestoneFact>,
    links: Collection<PlanLinkFact>,
    holidays: Collection<LocalDate>,
): ScheduleScope {
    val teamMilestoneIds = team.mapTo(HashSet()) { it.id }
    val teamProjectIds = team.mapTo(HashSet()) { it.projectId }
    val foreignByMilestone = plan.filter { it.teamId != teamId }.associateBy { it.id }
    val foreignByProject = foreignByMilestone.values.filter { it.span != null }.groupBy { it.projectId }

    fun end(ref: EndpointRef): ScopeEnd {
        val span = when (ref.kind) {
            EndpointKind.MILESTONE -> foreignByMilestone[ref.id]?.span
            EndpointKind.PROJECT -> foreignByProject[ref.id]?.mapNotNull { it.span }?.let { spans ->
                DaySpan(spans.minOf { it.start }, spans.maxOf { it.end })
            }
        }
        return ScopeEnd(ref.kind, ref.id, span?.start?.toString(), span?.end?.toString())
    }

    fun touchesTeam(ref: EndpointRef) =
        if (ref.kind == EndpointKind.MILESTONE) ref.id in teamMilestoneIds else ref.id in teamProjectIds

    return ScheduleScope(
        teamId = teamId,
        milestones = team.sortedBy { it.id }.map { ScopeMilestone(it.id, it.projectId, it.estimateMd.plain(), it.pinned) },
        order = effectiveOrder(team) { it.key.copy(start = null, end = null) }.map { it.id },
        periods = periods.sortedWith(compareBy({ it.effectiveFrom }, { it.mdPerWeek }, { it.wipLimit ?: Int.MAX_VALUE }))
            .map { ScopePeriod(it.effectiveFrom.toString(), it.mdPerWeek.plain(), it.wipLimit) },
        links = links.sortedBy { it.id }.filter { touchesTeam(it.predecessor) || touchesTeam(it.successor) }
            .map { ScopeLink(it.id, end(it.predecessor), end(it.successor), it.type, it.lagDays) },
        holidays = holidays.sorted().map { it.toString() },
    )
}

private fun BigDecimal.plain() = stripTrailingZeros().toPlainString()

/** The 64-character lowercase hex SHA-256 of [scope]'s canonical JSON: the wire `scopeHash`. */
fun scopeFingerprint(scope: ScheduleScope): String = sha256Hex(canonicalJson(Json.encodeToString(scope)))
