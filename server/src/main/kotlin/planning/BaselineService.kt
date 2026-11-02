package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.users.UserService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.time.LocalDate

val BaselineServiceKey = AttributeKey<BaselineService>("BaselineService")

private const val BASELINE_NOT_FOUND = "Baseline not found"

/**
 * The baselines registry (V20): named, immutable copies of the plan's dated structure. `baselines` is a soft-deleted business entity
 * (the name frees on delete through `uq_baselines_name_active`); the two row tables are FROZEN - never updated or deleted, enforced by
 * the V20 triggers, and kept for a soft-deleted baseline too. Every write runs in [withPlanWrite] (the copy IS the plan at one
 * revision: no plan write can interleave, and the create bumps the revision like any plan write): the caller's guard is re-run there
 * (the grant re-read in the same transaction), a rejected write rolls the bump back with the rest. Reads are open to every
 * authenticated user.
 */
class BaselineService(private val database: R2dbcDatabase) {
    object Baselines : UIntIdTable("baselines"), SoftDeletable {
        // Name uniqueness rides the partial unique index uq_baselines_name_active (V20, active rows only, over LOWER(name)).
        val name = varchar("name", length = MAX_BASELINE_NAME_LENGTH)
        val description = varchar("description", length = MAX_BASELINE_DESCRIPTION_LENGTH).nullable()

        /** The plan revision this baseline EQUALS: the one its creation left behind (`revision + 1` under the plan lock). */
        val planRevision = long("plan_revision")
        val createdByUserId = reference("created_by_user_id", UserService.Users).nullable()
        val milestoneCount = integer("milestone_count")
        val projectCount = integer("project_count")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /** FROZEN: no foreign key to a live row (the ids are the live ids as they were), never updated or deleted. */
    object BaselineProjects : Table("baseline_projects") {
        val baselineId = reference("baseline_id", Baselines)
        val projectId = uinteger("project_id")
        val programId = uinteger("program_id")
        val workStreamId = uinteger("work_stream_id")
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val programName = varchar("program_name", length = MAX_PLAN_NAME_LENGTH)
        val workStreamName = varchar("work_stream_name", length = MAX_PLAN_NAME_LENGTH)
        val rankPosition = integer("rank_position").nullable()
        val targetStart = localDate("target_start").nullable()
        val targetEnd = localDate("target_end").nullable()
        val spanStart = localDate("span_start").nullable()
        val spanEnd = localDate("span_end").nullable()
        override val primaryKey = PrimaryKey(baselineId, projectId)
    }

    /** FROZEN, like [BaselineProjects]. */
    object BaselineMilestones : Table("baseline_milestones") {
        val baselineId = reference("baseline_id", Baselines)
        val milestoneId = uinteger("milestone_id")
        val projectId = uinteger("project_id")
        val teamId = uinteger("team_id")
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val estimateMd = decimal("estimate_md", 8, 2)
        val startDate = localDate("start_date").nullable()
        val endDate = localDate("end_date").nullable()
        override val primaryKey = PrimaryKey(baselineId, milestoneId)
    }

    /** The ACTIVE baselines, newest first (`created_at`, then `id`, both descending): at most [MAX_ACTIVE_BASELINES], not paged. */
    suspend fun list(): List<BaselineResponse> = suspendTransaction(database) {
        val headers = Baselines.selectAll().where { Baselines.active() }
            .orderBy(Baselines.createdAt to SortOrder.DESC, Baselines.id to SortOrder.DESC)
            .toList().map { it.toBaselineHeader() }
        val creators = creatorsOf(headers.mapNotNull { it.createdByUserId })
        headers.map { it.toResponse(creators) }
    }

    /** The ACTIVE baseline, or null when it is unknown or soft-deleted (the route's 404). */
    suspend fun read(id: UInt): BaselineResponse? = suspendTransaction(database) {
        activeBaseline(id)?.let { header -> header.toResponse(creatorsOf(listOfNotNull(header.createdByUserId))) }
    }

    /**
     * Takes a baseline under the plan lock: [guard] (the caller's `requireRoadmapEditorOrAdmin` re-run INSIDE the lock, the grant
     * re-read, so a revocation that landed while the request waited refuses the write: 403, no bump), then the CAP (409
     * `urn:astrolabe:problem:baseline-limit` at [MAX_ACTIVE_BASELINES] active ones), then the facts - the roadmap's one set of loaders
     * and ONE kernel run ([loadRoadmapSnapshot], so a project's span, rank and target are exactly what the roadmap showed at that
     * moment) plus [baselineMilestoneFacts] - the header (a name clash is the unique index's 23505 -> the central 409, before the bulk
     * rows) and one multi-row insert per frozen table. The answer's `planRevision` is `revision + 1`: the revision this write leaves
     * behind, which the plan then equals. A throw anywhere rolls everything back, the bump included.
     */
    suspend fun create(userId: UInt, values: BaselineValues, guard: suspend () -> Unit): PlanWrite<BaselineResponse> {
        validateBaseline(values.name, values.description)
        return database.withPlanWrite { revision ->
            guard()
            val active = Baselines.selectAll().where { Baselines.active() }.count()
            if (active >= MAX_ACTIVE_BASELINES) {
                throw ConflictException(
                    "The limit of $MAX_ACTIVE_BASELINES baselines is reached: delete one first",
                    problemType = BASELINE_LIMIT_PROBLEM,
                )
            }
            val snapshot = loadRoadmapSnapshot(CAPTURE_ACTOR)
            // Only milestones of the snapshot's projects (an active milestone's project is always active; the filter keeps the two
            // frozen tables consistent whatever happens).
            val known = snapshot.projects.mapTo(HashSet()) { it.id }
            val milestones = baselineMilestoneFacts().filter { it.projectId in known }
            val stamp = nowMillis()
            val id = Baselines.insert {
                it[name] = values.name
                it[description] = values.description
                it[planRevision] = revision + 1
                it[createdByUserId] = userId
                it[milestoneCount] = milestones.size
                it[projectCount] = snapshot.projects.size
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[Baselines.id].value
            insertProjects(id, snapshot)
            insertMilestones(id, milestones)
            BaselineResponse(
                id = id,
                name = values.name,
                description = values.description,
                planRevision = revision + 1,
                createdAt = stamp,
                createdBy = creatorsOf(listOf(userId))[userId],
                milestoneCount = milestones.size,
                projectCount = snapshot.projects.size,
            )
        }
    }

    /**
     * Renames / re-describes the baseline under the plan lock: [guard] re-run first, then the ACTIVE row locked (`FOR NO KEY UPDATE`; a
     * missing or deleted one is the 404), then the update. A clash with another active baseline's name is the unique index's 409. The
     * frozen rows are untouched. [BaselineUpdateOutcome.changed] tells the route whether to audit.
     */
    suspend fun update(id: UInt, values: BaselineValues, guard: suspend () -> Unit): PlanWrite<BaselineUpdateOutcome> {
        validateBaseline(values.name, values.description)
        return database.withPlanWrite {
            guard()
            val before = lockedActive(id)
            val changed = before[Baselines.name] != values.name || before[Baselines.description] != values.description
            if (changed) {
                Baselines.update({ (Baselines.id eq id) and Baselines.active() }) {
                    it[name] = values.name
                    it[description] = values.description
                    it[updatedAt] = nowMillis()
                }
            }
            BaselineUpdateOutcome(
                nameFrom = before[Baselines.name],
                descriptionChanged = before[Baselines.description] != values.description,
                changed = changed,
            )
        }
    }

    /** Soft-deletes the baseline under the plan lock (the name frees; the frozen rows stay); the answer is its name for the audit. */
    suspend fun delete(id: UInt, guard: suspend () -> Unit): PlanWrite<String> = database.withPlanWrite {
        guard()
        val before = lockedActive(id)
        // The row is locked and ACTIVE (lockedActive), so this update touches exactly it.
        Baselines.update({ (Baselines.id eq id) and Baselines.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        before[Baselines.name]
    }

    /** The ACTIVE row locked `FOR NO KEY UPDATE` (persistence.md "Row locks vs. FK locks"), or the 404. */
    private suspend fun lockedActive(id: UInt) = Baselines.selectAll().where { (Baselines.id eq id) and Baselines.active() }
        .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
        ?: throw NotFoundException(BASELINE_NOT_FOUND)

    private suspend fun insertProjects(baselineId: UInt, snapshot: RoadmapSnapshot) {
        BaselineProjects.insertRows(snapshot.projects) { p ->
            this[BaselineProjects.baselineId] = baselineId
            this[BaselineProjects.projectId] = p.id
            this[BaselineProjects.programId] = p.programId
            this[BaselineProjects.workStreamId] = p.workStreamId
            this[BaselineProjects.name] = p.name
            this[BaselineProjects.programName] = p.programName
            this[BaselineProjects.workStreamName] = p.workStreamName
            this[BaselineProjects.rankPosition] = p.rankPosition
            this[BaselineProjects.targetStart] = p.targetStart?.let(LocalDate::parse)
            this[BaselineProjects.targetEnd] = p.targetEnd?.let(LocalDate::parse)
            val span = snapshot.spans[p.id]
            this[BaselineProjects.spanStart] = span?.start
            this[BaselineProjects.spanEnd] = span?.end
        }
    }

    private suspend fun insertMilestones(baselineId: UInt, milestones: List<MilestoneCapture>) {
        BaselineMilestones.insertRows(milestones) { m ->
            this[BaselineMilestones.baselineId] = baselineId
            this[BaselineMilestones.milestoneId] = m.id
            this[BaselineMilestones.projectId] = m.projectId
            this[BaselineMilestones.teamId] = m.teamId
            this[BaselineMilestones.name] = m.name
            this[BaselineMilestones.estimateMd] = m.estimateMd
            this[BaselineMilestones.startDate] = m.span?.start
            this[BaselineMilestones.endDate] = m.span?.end
        }
    }
}
