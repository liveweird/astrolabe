package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val MilestoneServiceKey = AttributeKey<MilestoneService>("MilestoneService")

private const val MILESTONE_NOT_FOUND = "Milestone not found"

/** The schedule guard the service re-runs INSIDE the plan lock, against the milestone's chain (and STORED team) re-read there. */
typealias ScheduleGuard = suspend (MilestoneChain) -> Unit

/**
 * Milestones (V14), under one project. Every write runs in [withPlanWrite] (a milestone IS plan state; teams and people are not) and
 * re-reads the milestone's chain under the lock, re-running the caller's guard against it. A milestone name is unique among the ACTIVE
 * milestones of its project (`uq_milestones_project_name_active`, 409). The plan fields ([create], [update], [delete]) belong to the
 * project's owner chain; the dates ([schedule]) only to the milestone's team manager or ADMIN, with per-milestone optimistic concurrency
 * on `schedule_revision`. Reads are open to every authenticated user.
 */
class MilestoneService(private val database: R2dbcDatabase) {
    object Milestones : UIntIdTable("milestones"), SoftDeletable {
        val projectId = reference("project_id", ProjectService.Projects)

        /** Required; always an ACTIVE team while the milestone is active (`TeamService.delete` refuses while it names the team). */
        val teamId = reference("team_id", TeamService.Teams)
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val description = varchar("description", length = MAX_PLAN_DESCRIPTION_LENGTH).nullable()

        /** Man-days, `NUMERIC(8,2)` (the spike: `DecimalColumnTest`). */
        val estimateMd = decimal("estimate_md", 8, 2)

        /** Both set or both null (`ck_milestones_schedule`), end not before start (`ck_milestones_schedule_order`); null = unscheduled. */
        val startDate = localDate("start_date").nullable()
        val endDate = localDate("end_date").nullable()

        /** The plan revision at which the schedule was last written (internal, never on the wire): the per-milestone staleness check. */
        val scheduleRevision = long("schedule_revision")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /** The milestone's chain (its project's owners, the stored team, the project), or null when it or an ancestor is gone. */
    suspend fun chain(id: UInt): MilestoneChain? = suspendTransaction(database) { milestoneChain(id) }

    /** The milestone, or null when it or its project, program or work stream is missing/deleted. */
    suspend fun read(id: UInt): MilestoneResponse? = suspendTransaction(database) {
        milestoneChain(id) ?: return@suspendTransaction null
        val row = Milestones.selectAll().where { (Milestones.id eq id) and Milestones.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val teamId = row[Milestones.teamId].value
        MilestoneResponse(
            id = id,
            projectId = row[Milestones.projectId].value,
            name = row[Milestones.name],
            description = row[Milestones.description],
            teamId = teamId,
            teamName = teamName(teamId),
            estimateMd = row[Milestones.estimateMd].toDouble(),
            startDate = row[Milestones.startDate]?.toString(),
            endDate = row[Milestones.endDate]?.toString(),
            createdAt = row[Milestones.createdAt],
            updatedAt = row[Milestones.updatedAt],
        )
    }

    /**
     * Creates an UNSCHEDULED milestone under [projectId]; under the lock the project's chain is re-read (missing = 404) and [guard]
     * re-run, then the team must be ACTIVE (400, locked `FOR SHARE`) and a name clash in the project is the partial index's 409.
     */
    suspend fun create(projectId: UInt, request: MilestoneCreateRequest, guard: PlanGuard): UInt {
        val estimate = validateMilestoneFields(request.name, request.description, request.estimateMd)
        return database.withPlanWrite { revision ->
            guard(projectChain(projectId) ?: throw NotFoundException("Project not found"))
            requireActiveTeam(request.teamId)
            val stamp = nowMillis()
            Milestones.insert {
                it[this.projectId] = projectId
                it[teamId] = request.teamId
                it[name] = request.name
                it[description] = request.description
                it[estimateMd] = estimate
                it[scheduleRevision] = revision + 1
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[Milestones.id].value
        }.value
    }

    /**
     * Plan-field replace under the plan lock (name, description, team, estimate — NEVER the dates or `schedule_revision`: a team change
     * keeps the bar for the new team's manager to move or unschedule). The chain is re-read and [guard] re-run first (missing = 404).
     */
    suspend fun update(id: UInt, request: MilestoneUpdateRequest, guard: PlanGuard): MilestoneUpdateOutcome {
        val estimate = validateMilestoneFields(request.name, request.description, request.estimateMd)
        return database.withPlanWrite {
            guard((milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)).owners)
            val before = Milestones.select(Milestones.teamId).where { (Milestones.id eq id) and Milestones.active() }
                .toList().singleOrNull() ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            requireActiveTeam(request.teamId)
            Milestones.update({ (Milestones.id eq id) and Milestones.active() }) {
                it[name] = request.name
                it[description] = request.description
                it[teamId] = request.teamId
                it[estimateMd] = estimate
                it[updatedAt] = nowMillis()
            }
            MilestoneUpdateOutcome(before[Milestones.teamId].value)
        }.value
    }

    /**
     * The schedule write under the plan lock, in this order: the chain is re-read (missing = 404, nothing written) -> [guard] against it
     * (the STORED team's manager as of the lock: a manager revoked meanwhile is a 403, not a 409) -> THIS milestone's `schedule_revision`
     * against `expectedRevision`, which must also not exceed the current plan revision (409 `urn:astrolabe:problem:stale-revision`
     * either way, nothing written) -> the write, which stamps
     * `schedule_revision` with the new plan revision. The null pair unschedules. The outcome carries the STORED span for the audit.
     */
    suspend fun schedule(id: UInt, request: MilestoneScheduleRequest, guard: ScheduleGuard): ScheduleOutcome {
        val span = validateScheduleRequest(request)
        val write = database.withPlanWrite { revision ->
            val chain = milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            guard(chain)
            val before = Milestones.select(Milestones.startDate, Milestones.endDate, Milestones.scheduleRevision)
                .where { (Milestones.id eq id) and Milestones.active() }
                .toList().singleOrNull() ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            // Stale in BOTH directions: a revision below this milestone's own means it moved since the client's view; one above the
            // current plan revision (read under the lock) is a view from the future - never a state the server produced - and must
            // not slip past the check (a client sending Long.MAX_VALUE would overwrite another manager's reschedule).
            if (before[Milestones.scheduleRevision] > request.expectedRevision || request.expectedRevision > revision) {
                throw ConflictException(
                    "This milestone was rescheduled after revision ${request.expectedRevision}; reload the project",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            Milestones.update({ (Milestones.id eq id) and Milestones.active() }) {
                it[startDate] = span?.start
                it[endDate] = span?.end
                it[scheduleRevision] = revision + 1
                it[updatedAt] = nowMillis()
            }
            val start = before[Milestones.startDate]
            val end = before[Milestones.endDate]
            ScheduleOutcome(
                from = if (start != null && end != null) MilestoneSpan(start, end) else null,
                teamId = chain.teamId,
                revision = 0,
            )
        }
        return write.value.copy(revision = write.revision)
    }

    /** Soft delete under the plan lock; the chain is re-read and [guard] re-run first (missing = 404). The name is freed. */
    suspend fun delete(id: UInt, guard: PlanGuard) {
        database.withPlanWrite {
            guard((milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)).owners)
            val affected = Milestones.update({ (Milestones.id eq id) and Milestones.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
            if (affected == 0) throw NotFoundException(MILESTONE_NOT_FOUND)
        }
    }

    /**
     * The team of a new or changed milestone must be ACTIVE — a client-supplied FK is a 400, never a 500 from the constraint. The check
     * locks the team row `FOR SHARE`, which conflicts with `TeamService.delete`'s `lockActiveForWrite` (`FOR NO KEY UPDATE`): a delete
     * racing this write either commits first (the team reads inactive here, 400) or waits for this transaction and then counts the
     * milestone (409) — never an active milestone left on a deleted team. The plan lock held by the caller does not cover teams.
     */
    private suspend fun requireActiveTeam(teamId: UInt) {
        val teams = TeamService.Teams
        val exists = teams.select(teams.id)
            .where { (teams.id eq teamId) and teams.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare)
            .toList()
            .isNotEmpty()
        if (!exists) throw BadRequestException("Unknown or deleted team ids: $teamId")
    }

    /** The team's name, read WITHOUT an `active()` filter: an active milestone's team is always active (`TeamService.delete`'s 409). */
    private suspend fun teamName(teamId: UInt): String {
        val teams = TeamService.Teams
        return teams.select(teams.name).where { teams.id eq teamId }.toList().single()[teams.name]
    }
}

/**
 * Soft-deletes every ACTIVE milestone of [projectId] and returns how many — the project delete's cascade (`ProjectService.delete`,
 * same plan-locked transaction): milestones are the project's own work breakdown with no owner of their own, so they leave with it.
 */
internal suspend fun deleteMilestonesOf(projectId: UInt): Int {
    val milestones = MilestoneService.Milestones
    return milestones.update({ (milestones.projectId eq projectId) and milestones.active() }) {
        it[markedAsDeleted] = true
        it[updatedAt] = nowMillis()
    }
}

/** Whether an ACTIVE milestone names [teamId] — the team-delete 409 (`TeamService.delete`, under the team row lock). */
suspend fun hasActiveMilestones(teamId: UInt): Boolean {
    val milestones = MilestoneService.Milestones
    return milestones.select(milestones.id).where { (milestones.teamId eq teamId) and milestones.active() }.count() > 0
}
