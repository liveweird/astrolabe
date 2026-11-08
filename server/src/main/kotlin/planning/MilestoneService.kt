package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val MilestoneServiceKey = AttributeKey<MilestoneService>("MilestoneService")

private const val MILESTONE_NOT_FOUND = "Milestone not found"

/** The schedule guard the service re-runs INSIDE the plan lock, against the milestone's chain (and STORED team) re-read there. */
typealias ScheduleGuard = suspend (MilestoneChain) -> Unit

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to MilestoneService.Milestones.id,
    "name" to MilestoneService.Milestones.name,
    "createdAt" to MilestoneService.Milestones.createdAt,
    "updatedAt" to MilestoneService.Milestones.updatedAt,
)

/** The ONE sortable whitelist of `GET /milestones`, derived from the column map so the two can never drift. */
val MILESTONE_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

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

        /**
         * The auto-proposal keeps the dates (V25, `ck_milestones_pinned_scheduled`: a pin needs dates). Cleared by every unscheduling
         * write ([MilestoneService.schedule], [writeSchedules]); kept by a reschedule.
         */
        val pinned = bool("pinned").default(false)

        /** The plan revision at which the schedule was last written (internal, never on the wire): the per-milestone staleness check. */
        val scheduleRevision = long("schedule_revision")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The paged milestone list (the dependency pickers): ACTIVE milestones of an ACTIVE project, program and work stream, one predicate
     * for the count and the rows in ONE read transaction (no lock, no revision). The project's and the team's names ride the joins.
     */
    suspend fun list(filter: MilestoneListFilter, paging: PageRequest): MilestoneListResult = suspendTransaction(database) {
        val projects = ProjectService.Projects
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        val teams = TeamService.Teams
        var predicate: Op<Boolean> = Milestones.active() and projects.active() and programs.active() and streams.active()
        filter.name?.takeIf { it.isNotBlank() }?.let { predicate = predicate and Milestones.name.containsNormalized(it) }
        // The team joins without an `active()` filter: an active milestone's team is always active (`TeamService.delete`'s 409).
        val joined = Milestones.innerJoin(projects, { Milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .innerJoin(teams, { Milestones.teamId }, { teams.id })
        val total = joined.selectAll().where { predicate }.count()
        val rows = joined.select(Milestones.columns + projects.name + teams.name)
            .where { predicate }
            .applyPaging(paging, SORTABLE_COLUMNS)
            .toList()
        MilestoneListResult(
            items = rows.map { row ->
                MilestoneListItem(
                    id = row[Milestones.id].value,
                    projectId = row[Milestones.projectId].value,
                    projectName = row[projects.name],
                    name = row[Milestones.name],
                    description = row[Milestones.description],
                    teamId = row[Milestones.teamId].value,
                    teamName = row[teams.name],
                    estimateMd = row[Milestones.estimateMd].toDouble(),
                    startDate = row[Milestones.startDate]?.toString(),
                    endDate = row[Milestones.endDate]?.toString(),
                    pinned = row[Milestones.pinned],
                    createdAt = row[Milestones.createdAt],
                    updatedAt = row[Milestones.updatedAt],
                )
            },
            total = total,
        )
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
            pinned = row[Milestones.pinned],
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
            insertMilestoneRow(projectId, request.teamId, request.name, request.description, estimate, revision + 1, stamp)
        }.value
    }

    /**
     * Plan-field replace under the plan lock (name, description, team, estimate — NEVER the dates or `schedule_revision`: a team change
     * keeps the bar for the new team's manager to move or unschedule, and takes the milestone out of the old team's order). The chain is
     * re-read and [guard] re-run first (missing = 404).
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
            val teamFrom = before[Milestones.teamId].value
            // The milestone leaves the old team's order (its positions close up); the new team lists it only when its manager does.
            if (teamFrom != request.teamId) removeFromTeamOrder(id)
            MilestoneUpdateOutcome(teamFrom)
        }.value
    }

    /**
     * The schedule write under the plan lock, in this order: the chain is re-read (missing = 404, nothing written) -> [guard] against it
     * (the STORED team's manager as of the lock: a manager revoked meanwhile is a 403, not a 409) -> the span must hold a working day of
     * the CURRENT holiday calendar (400, D2: a holiday-only span; a stranger is refused before this) -> THIS milestone's
     * `schedule_revision` against `expectedRevision`, which must also not exceed the current plan revision (409
     * `urn:astrolabe:problem:stale-revision` either way, nothing written) -> the write, which stamps
     * `schedule_revision` with the new plan revision. The null pair unschedules. The outcome carries the STORED span for the audit.
     */
    suspend fun schedule(id: UInt, request: MilestoneScheduleRequest, guard: ScheduleGuard): ScheduleOutcome {
        val span = validateScheduleRequest(request)
        val write = database.withPlanWrite { revision ->
            val chain = milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            guard(chain)
            // The holiday-aware half of "at least one working day" (D2): the calendar is read HERE, under the lock, so the verdict is
            // the dictionary as of this write. After the re-guard (a stranger never learns it) and before the stale check.
            if (span != null && !loadWorkingCalendar().containsWorkingDay(span.start, span.end)) {
                throw BadRequestException(NO_WORKING_DAY_MESSAGE)
            }
            val before = Milestones.select(Milestones.startDate, Milestones.endDate, Milestones.scheduleRevision, Milestones.pinned)
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
                // An unschedule clears the pin in the same statement (the CHECK would refuse a pinned row without dates); a
                // reschedule keeps it - the pin is advice to the proposal, not a lock on the dates.
                if (span == null) it[pinned] = false
                it[scheduleRevision] = revision + 1
                it[updatedAt] = nowMillis()
            }
            val start = before[Milestones.startDate]
            val end = before[Milestones.endDate]
            ScheduleOutcome(
                from = if (start != null && end != null) MilestoneSpan(start, end) else null,
                teamId = chain.teamId,
                revision = 0,
                pinCleared = span == null && before[Milestones.pinned],
            )
        }
        return write.value.copy(revision = write.revision)
    }

    /**
     * The pin write under the plan lock, in this order: the chain is re-read (missing = 404, nothing written) -> [guard] against it
     * (the STORED team's manager as of the lock: the schedule write's audience, a manager revoked meanwhile is a 403) -> pinning an
     * UNSCHEDULED milestone is a 409 `urn:astrolabe:problem:milestone-unscheduled` (nothing written, no bump) -> `pinned` and
     * `updated_at` are written. `schedule_revision` is NOT touched (the pin is not the dates, and a pin must never stale a drag), the
     * plan revision bumps like any plan write, a no-op included (the conservative rule). The outcome carries the STORED pin for the audit
     * (which emits only on a change). No `expectedRevision`: the flag is idempotent, and the proposal's `scopeHash` is what refuses an
     * accept that raced a flipped pin.
     */
    suspend fun pin(id: UInt, pinned: Boolean, guard: ScheduleGuard): PinOutcome {
        val write = database.withPlanWrite {
            val chain = milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            guard(chain)
            val before = Milestones.select(Milestones.startDate, Milestones.pinned)
                .where { (Milestones.id eq id) and Milestones.active() }
                .toList().singleOrNull() ?: throw NotFoundException(MILESTONE_NOT_FOUND)
            if (pinned && before[Milestones.startDate] == null) {
                throw ConflictException(
                    "An unscheduled milestone cannot be pinned: schedule it first",
                    problemType = MILESTONE_UNSCHEDULED_PROBLEM,
                )
            }
            Milestones.update({ (Milestones.id eq id) and Milestones.active() }) {
                it[Milestones.pinned] = pinned
                it[updatedAt] = nowMillis()
            }
            PinOutcome(before = before[Milestones.pinned], teamId = chain.teamId, revision = 0)
        }
        return write.value.copy(revision = write.revision)
    }

    /**
     * Soft delete under the plan lock; the chain is re-read and [guard] re-run first (missing = 404). The name is freed. Every ACTIVE
     * dependency with this milestone at either end is soft-deleted in the same locked transaction ([deleteDependenciesOf]: a link
     * cannot outlive an end); the milestone also leaves its team's order ([removeFromTeamOrder]). The returned [DeletedDependencies]
     * feed the audit (`dependencyCount`, `dependencyIds`, `successorProjectIds`).
     */
    suspend fun delete(id: UInt, guard: PlanGuard): DeletedDependencies = database.withPlanWrite {
        guard((milestoneChain(id) ?: throw NotFoundException(MILESTONE_NOT_FOUND)).owners)
        val affected = Milestones.update({ (Milestones.id eq id) and Milestones.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        if (affected == 0) throw NotFoundException(MILESTONE_NOT_FOUND)
        removeFromTeamOrder(id)
        deleteDependenciesOf(milestoneIds = listOf(id), projectIds = emptyList())
    }.value

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

/** The ids of [projectId]'s ACTIVE milestones — what a project delete's dependency cascade must reach before the milestones go. */
internal suspend fun activeMilestoneIdsOf(projectId: UInt): List<UInt> {
    val milestones = MilestoneService.Milestones
    return milestones.select(milestones.id).where { (milestones.projectId eq projectId) and milestones.active() }
        .toList().map { it[milestones.id].value }
}

/** Whether an ACTIVE milestone names [teamId] — the team-delete 409 (`TeamService.delete`, under the team row lock). */
suspend fun hasActiveMilestones(teamId: UInt): Boolean {
    val milestones = MilestoneService.Milestones
    return milestones.select(milestones.id).where { (milestones.teamId eq teamId) and milestones.active() }.count() > 0
}
