package ch.nokillswit.planning

import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.infra.json.sha256Hex
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.math.BigDecimal
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/*
 * The scope fingerprint of a schedule proposal (v0.9.0; `planning-model.md` "The auto-proposal"): a content hash of everything the
 * scheduling kernel reads about ONE team that the batch accept's per-milestone `schedule_revision` rule does NOT already cover. The
 * proposal answers it (`scopeHash`) and the batch accept recomputes it under the plan lock from the same rows through the same function
 * ([scheduleScope]); a difference in the STRUCTURE is a 409 `stale-scope`, nothing written.
 *
 * The wire token is 64 lowercase hex characters in three parts (1.13.1): chars 0-27 the STRUCTURE digest (this scope), chars 28-55 the
 * HOLIDAYS digest (the Monday-Friday holidays, [holidaysDigest]), chars 56-63 the proposal's `asOf` as days since 1900-01-01
 * ([ScopeToken]). The holidays are NOT in the structure: when only they differ, the accept looks again ([acceptsOnlyFreshDates]: the
 * kernel runs once on the current rows and the batch must hold exactly the dates it gives) instead of refusing.
 *
 * What is in and what is out, input by input:
 *  - IN: the team's milestone set with each one's project, estimate and PIN (V25: the kernel treats a pinned milestone as fixed, so a pin
 *    flipped after the proposal is a `stale-scope`, never an accept against a premise the preview did not see); the team's effective
 *    ORDER with the milestones' own dates taken out of its tiebreak (the stored positions, the projects' global rank and the names
 *    still count); the team's capacity periods; every link that touches the team (an end is one of its milestones, or a project
 *    holding one) with, per end, the span of what is NOT the team's.
 *  - OUT of the structure, in the holidays digest: the Monday-Friday holidays (a weekend holiday changes no working-day count).
 *  - OUT, covered elsewhere: the team's OWN milestones' spans - `schedule_revision` (a batch item is skipped STALE, any other team
 *    milestone is the batch's sweep). Hashing them would make a colleague's drag of a batch item refuse the whole batch instead of
 *    skipping that item, and the team's own accepted moves would stale every later accept.
 *  - OUT, not state: `asOf` (the viewer's clock; the batch carries the dates it chose; it rides the token's last part so the look-again
 *    can rerun the proposal), the horizon (a constant).
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
)

/**
 * The scope of [teamId] from the rows the kernel reads: its milestones [team], its capacity [periods], every active milestone of the
 * [plan] and every active [links]. Pure; the result does not depend on the order of any input.
 * "Foreign" is a milestone of a team outside [runTeamIds] (default: just this team, the per-team proposal's rule). A cross-team run
 * passes its whole team set ([runScope]): the spans of the run teams' milestones are NOT in the hash then, because each one is covered
 * by its `schedule_revision` (a ticked item is skipped STALE) or by the accept's sweep over the run's teams.
 */
fun scheduleScope(
    teamId: UInt,
    team: Collection<TeamScheduleItem>,
    periods: Collection<CapacityPeriod>,
    plan: Collection<PlanMilestoneFact>,
    links: Collection<PlanLinkFact>,
    runTeamIds: Set<UInt> = setOf(teamId),
): ScheduleScope {
    val teamMilestoneIds = team.mapTo(HashSet()) { it.id }
    val teamProjectIds = team.mapTo(HashSet()) { it.projectId }
    val foreignByMilestone = plan.filter { it.teamId !in runTeamIds }.associateBy { it.id }
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
    )
}

private fun BigDecimal.plain() = stripTrailingZeros().toPlainString()

/** The structure digest of [scope]: the first [STRUCTURE_LENGTH] hex characters of the SHA-256 of its canonical JSON. */
fun structureDigest(scope: ScheduleScope): String = sha256Hex(canonicalJson(Json.encodeToString(scope))).take(STRUCTURE_LENGTH)

/** A run team in the fingerprint: its id and its LOWERCASE name (the team order's tiebreak reads the name case-insensitively). */
@Serializable
data class ScopeRunTeam(val id: UInt, val name: String)

/**
 * The scope of a cross-team run (1.8.0): the [teams] sorted by id (each with its name: `proposeMany` breaks team-order ties by name,
 * so a rename between the run and the accept can change the placement) and, per team in that order, its own [ScheduleScope] built with
 * the WHOLE set as "own" ([scheduleScope]'s `runTeamIds`). Its JSON differs from a [ScheduleScope]'s by construction, so a per-team
 * hash and a run hash never match (the two definitions of "foreign" differ; `planning-model.md` "The cross-team run").
 */
@Serializable
data class ScheduleRunScope(val teams: List<ScopeRunTeam>, val scopes: List<ScheduleScope>)

/**
 * The [ScheduleRunScope] of the teams in [teamsById] (each team's milestones) with their [names] (one per team) and [periodsById] (a
 * team without periods may be absent). Pure; the result does not depend on the order of any input.
 */
fun runScope(
    teamsById: Map<UInt, Collection<TeamScheduleItem>>,
    names: Map<UInt, String>,
    periodsById: Map<UInt, Collection<CapacityPeriod>>,
    plan: Collection<PlanMilestoneFact>,
    links: Collection<PlanLinkFact>,
): ScheduleRunScope {
    val teamIds = teamsById.keys.sorted()
    val run = teamIds.toSet()
    return ScheduleRunScope(
        teamIds.map { ScopeRunTeam(it, names.getValue(it).lowercase()) },
        teamIds.map { id ->
            scheduleScope(id, teamsById.getValue(id), periodsById[id].orEmpty(), plan, links, runTeamIds = run)
        },
    )
}

/** The structure digest of a run's [scope] ([structureDigest]'s rule); its JSON never equals a team scope's, so the two never match. */
fun structureDigest(scope: ScheduleRunScope): String = sha256Hex(canonicalJson(Json.encodeToString(scope))).take(STRUCTURE_LENGTH)

private const val STRUCTURE_LENGTH = 28
private const val HOLIDAYS_LENGTH = 28
private const val ASOF_LENGTH = 8
private const val HEX_RADIX = 16
private val ASOF_EPOCH: LocalDate = LocalDate.of(1900, 1, 1)

/**
 * The first [HOLIDAYS_LENGTH] hex characters of the SHA-256 of the canonical JSON array of the Monday-Friday [holidays] (ascending,
 * `WorkingCalendar.offDayDates()`): flips exactly when a working-day count could.
 */
fun holidaysDigest(holidays: Collection<LocalDate>): String =
    sha256Hex(canonicalJson(Json.encodeToString(holidays.sorted().map { it.toString() }))).take(HOLIDAYS_LENGTH)

/** The two digests a snapshot computes from its rows: the [structure] and the [holidays] part of a wire token. */
data class ScopeDigests(val structure: String, val holidays: String) {
    /** The wire `scopeHash` of a proposal read as of [asOf]: structure, holidays, then [asOf] as days since 1900-01-01 in 8 hex. */
    fun token(asOf: LocalDate): String =
        structure + holidays + ChronoUnit.DAYS.between(ASOF_EPOCH, asOf).toString(HEX_RADIX).padStart(ASOF_LENGTH, '0')
}

/** A wire `scopeHash` taken apart: [hash] is already 64 lowercase hex (the request validator's rule, before the lock). */
class ScopeToken(hash: String) {
    val digests = ScopeDigests(hash.substring(0, STRUCTURE_LENGTH), hash.substring(STRUCTURE_LENGTH, STRUCTURE_LENGTH + HOLIDAYS_LENGTH))
    private val asOfPart = hash.substring(STRUCTURE_LENGTH + HOLIDAYS_LENGTH)

    /** The proposal's `asOf`, or null when the part decodes to a day [validateAsOf] would refuse (after the latest accepted `asOf`). */
    fun asOf(): LocalDate? {
        val days = asOfPart.toLong(HEX_RADIX)
        return if (days > ChronoUnit.DAYS.between(ASOF_EPOCH, LATEST_AS_OF)) null else ASOF_EPOCH.plusDays(days)
    }
}

/**
 * The look-again rule of the accept's scope check (only the holidays changed): every batch item carries both dates and equals the
 * span [fresh] (the kernel's `spansAfter` for the same `asOf` on the current rows, by milestone id) gives its milestone. Anything else
 * - another date, an unschedule pair, a milestone the fresh run does not place or hold - is false (a 409 `stale-scope`).
 */
fun acceptsOnlyFreshDates(items: List<ValidatedBatchItem>, fresh: Map<UInt, DaySpan>): Boolean = items.all { item ->
    val span = item.span
    span != null && fresh[item.milestoneId] == DaySpan(span.start, span.end)
}
