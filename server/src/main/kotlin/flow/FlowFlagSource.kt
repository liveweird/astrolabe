package ch.nokillswit.flow

import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlagSource
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.FlaggedRange
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.TeamExternal
import java.time.LocalDate

/**
 * The Flow side of the timeline views' [ExternalFlagSource] seam (1.9): the team view's header flag and the weeks strip's marked days.
 * It answers only the TEAM half of a request. A request naming a team ([ExternalFlagRequest.teamId]) gets that team's [TeamExternal]
 * from the SAME computation the capacity deviations view runs ([CapacityDeviationService.computeTeamInTransaction]), INSIDE the view's
 * own snapshot transaction. Since 1.23 a request for EVERY team ([ExternalFlagRequest.everyTeam]: the roadmap loader, so the roadmap,
 * programs and Home views) gets the [TeamExternal] of each team that has something to say, from the same arithmetic in five statements
 * whatever the number of teams ([CapacityDeviationService.computeEveryTeamInTransaction]); both paths fold a team's facts through
 * [externalOf], so a team reads the same either way. A request naming no team and not asking for every one gets nothing, so the
 * project view costs nothing. It reads only and takes no lock.
 *
 * What a team gets, from the OPEN rows only (a row whose acknowledgement is current raises nothing; a stale one raises again):
 * - ONE [FlagKind.FLOW_CAPACITY] roll-up: `count` = the open rows, the severity the worst of them (a `CAPACITY_MISSING` row is
 *   an INFO row);
 * - one [FlaggedRange] per open row that holds days, `[effectiveFrom, end]` at the row's severity (a `TEAM_GONE` row flags but has no
 *   range).
 * Nothing at all for an unlinked team, a connection that never mirrored a document, or a DISABLED connection (nobody refreshes it, the
 * Jira rule: the Deviations page still lists its rows).
 */
internal class FlowFlagSource(private val deviations: CapacityDeviationService) : ExternalFlagSource {
    override suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags {
        if (request.everyTeam) {
            val teams = deviations.computeEveryTeamInTransaction(request.calendar)
                .mapNotNull { (teamId, facts) -> externalOf(facts)?.let { teamId to it } }.toMap()
            return ExternalFlags(teams = teams)
        }
        val teamId = request.teamId ?: return ExternalFlags()
        val external = deviations.computeTeamInTransaction(teamId, request.calendar)?.let(::externalOf) ?: return ExternalFlags()
        return ExternalFlags(teams = mapOf(teamId to external))
    }

    /** A team's flag and ranges from its OPEN rows, or null when its connection is disabled or nothing is open. */
    private fun externalOf(facts: TeamCapacityFacts): TeamExternal? {
        val open = facts.takeIf { it.enabled }?.deviations?.filter { it.isOpen }.orEmpty()
        if (open.isEmpty()) return null
        val flag = PlanFlag(
            kind = FlagKind.FLOW_CAPACITY,
            severity = open.minOf { it.severity.flag() },
            days = null,
            teamId = null,
            otherProjectId = null,
            count = open.size,
        )
        val ranges = open.mapNotNull { row ->
            val from = row.detail.effectiveFrom ?: return@mapNotNull null
            val to = row.detail.end ?: return@mapNotNull null
            FlaggedRange(LocalDate.parse(from), LocalDate.parse(to), row.severity.flag())
        }
        return TeamExternal(listOf(flag), ranges)
    }

    private fun DeviationSeverity.flag(): FlagSeverity = if (this == DeviationSeverity.WARNING) FlagSeverity.WARNING else FlagSeverity.INFO
}
