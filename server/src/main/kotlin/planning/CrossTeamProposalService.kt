package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.LocalDate

val CrossTeamProposalServiceKey = AttributeKey<CrossTeamProposalService>("CrossTeamProposalService")

/**
 * The cross-team schedule run (1.8.0, `POST /schedule-proposals`) and the teams a caller may include in one: reads, no lock, no audit.
 * Reads `Teams`, the plan tables, `RoadmapEntries`, the order tables, `CapacityPeriods`, `Dependencies` and `PublicHolidays` (the
 * per-team proposal's tables, `ScheduleProposalService`), writes nothing.
 */
class CrossTeamProposalService(private val database: R2dbcDatabase) {
    /**
     * The run over [teamIds] as of [asOf], or null when a team is missing or deleted by the time the snapshot reads it (the route's 404).
     *
     * **One snapshot.** A single read-only REPEATABLE READ transaction ([SNAPSHOT], the team view's protocol) whose FIRST statement is
     * the plan revision: every row after it (the teams' names, the calendar, each team's milestones, order, capacity, and the plan-wide
     * milestones and links the other teams' dates come from) is read from the one snapshot that revision names. So `revision`, every
     * team's block, the link verdicts and the `scopeHash` describe the same plan, however many writers commit meanwhile; an accept
     * recomputes the hash under the plan lock through the same loader and refuses the run if the plan moved. No lock, nothing written,
     * no audit event, nothing stored.
     */
    suspend fun propose(teamIds: List<UInt>, asOf: LocalDate): CrossTeamProposal? =
        suspendTransaction(database, SNAPSHOT, readOnly = true) {
            val revision = readPlanRevision()
            val names = activeTeamNames(teamIds)
            if (names.size != teamIds.size) return@suspendTransaction null
            val snapshot = loadCrossTeamSnapshot(names)
            val inputs = snapshot.inputs(asOf)
            val result = ScheduleKernels.proposeMany(inputs)
            val checks = ScheduleKernels.postCheckMany(inputs, result)
            val snapshots = snapshot.teams.associateBy { it.teamId }
            CrossTeamProposal(
                revision = revision,
                asOf = asOf.toString(),
                passes = result.passes,
                settled = result.settled,
                teams = result.order.map { teamId ->
                    val team = snapshots.getValue(teamId)
                    val check = checks.getValue(teamId)
                    val lists = proposalLists(team.rows, result.byTeam.getValue(teamId), snapshot.calendar, asOf)
                    CrossTeamProposalTeam(
                        teamId = teamId,
                        name = team.name,
                        moves = lists.moves,
                        unchanged = lists.unchanged,
                        unplaced = lists.unplaced,
                        pinned = lists.pinned,
                        weeks = check.weeks.map { it.toView() },
                        weeksTruncated = check.weeksTruncated,
                        dependencies = proposalLinks(snapshot.links, check),
                    )
                },
                scopeHash = snapshot.scopeHash(),
            )
        }

    /**
     * The link verdicts and the weekly load of [teamIds] for the HYPOTHETICAL spans [items] describe (`POST /schedule-proposals/check`),
     * one block per team in the request's order; null when a team is missing or deleted by the time the snapshot reads it (the route's
     * 404). The same one-snapshot protocol as [propose] (no lock, nothing written, no audit), reading what the accept would write:
     * `after` of each run team is its STORED spans with exactly [items] applied (a null pair removes the span), nothing else - not the
     * kernel's placement, so an unticked move keeps its stored dates and the verdicts follow the ticked subset. The verdicts come from
     * [ScheduleKernels.checkMany], the function the run's own post-check is, so for the spans of a per-team proposal the answer equals
     * its `weeks` and `dependencies`.
     *
     * A milestone of [items] that is not an ACTIVE milestone of one of [teamIds] (unknown, deleted, or on another team) is a 400: the
     * page sends only the run's moves, so it is a client bug, and ignoring it would make the verdicts silently describe another subset.
     * Not modelled: an item the accept would skip (`STALE`, `NO_WORKING_DAY`) - the check cannot know the future, and a plan write or a
     * new holiday since the proposal changes the stored dates it reads or the `scopeHash` the accept refuses.
     */
    suspend fun check(teamIds: List<UInt>, items: List<ValidatedBatchItem>): ScheduleCheckResponse? =
        suspendTransaction(database, SNAPSHOT, readOnly = true) {
            val names = activeTeamNames(teamIds)
            if (names.size != teamIds.size) return@suspendTransaction null
            val snapshot = loadCrossTeamSnapshot(names)
            val checks = ScheduleKernels.checkMany(snapshot.checkInputs(), snapshot.hypotheticalSpans(items))
            ScheduleCheckResponse(
                teamIds.map { teamId ->
                    val check = checks.getValue(teamId)
                    ScheduleCheckTeam(teamId, check.weeks.map { it.toView() }, check.weeksTruncated, proposalLinks(snapshot.links, check))
                },
            )
        }

    /**
     * The ACTIVE teams [actor] may include in a run, by name (case-insensitive, then id): every active team for an ADMIN, otherwise the
     * ones [PlanPermissions.canSchedule] allows (the actor must have been built with its managed teams). The page's multi-select; the
     * server's 403 on `POST /schedule-proposals` stays the rule.
     */
    suspend fun runnableTeams(actor: PlanActor): ProposalTeamList {
        val teams = TeamService.Teams
        val rows = suspendTransaction(database) {
            teams.select(teams.id, teams.name).where { teams.active() }.toList().map { it[teams.id].value to it[teams.name] }
        }
        return ProposalTeamList(
            rows.filter { (id, _) -> PlanPermissions.canSchedule(actor, id) }
                .sortedWith(compareBy<Pair<UInt, String>>({ it.second.lowercase() }, { it.first }))
                .map { (id, name) -> ProposalTeam(id, name) },
        )
    }
}

/**
 * Every run team's spans with [items] applied over the stored ones (team id -> milestone id -> span; an item with no span removes the
 * milestone's). Covers EVERY run team, as `checkMany` requires. A 400 for an item whose milestone is not on a run team.
 */
private fun CrossTeamSnapshot.hypotheticalSpans(items: List<ValidatedBatchItem>): Map<UInt, Map<UInt, DaySpan>> {
    val teamOf = teams.flatMap { team -> team.items.map { it.id to team.teamId } }.toMap()
    val foreign = items.map { it.milestoneId }.filter { it !in teamOf }
    if (foreign.isNotEmpty()) {
        throw BadRequestException("Unknown, deleted or other-team milestone ids: ${foreign.sorted().joinToString(", ")}")
    }
    val spans = teams.associate { it.teamId to storedSpansOf(it.teamId).toMutableMap() }
    for (item in items) {
        val teamSpans = spans.getValue(teamOf.getValue(item.milestoneId))
        val span = item.span
        if (span == null) teamSpans.remove(item.milestoneId) else teamSpans[item.milestoneId] = DaySpan(span.start, span.end)
    }
    return spans
}
