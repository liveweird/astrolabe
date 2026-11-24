package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.jsonb
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.json.canonicalJson
import ch.nokillswit.plugins.ApiJson
import ch.nokillswit.users.UserService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory
import java.time.LocalDate

val SavedProposalServiceKey = AttributeKey<SavedProposalService>("SavedProposalService")

private val logger = LoggerFactory.getLogger(SavedProposalService::class.java)

/** The most rows one prune looks at: the table never holds more than [MAX_SAVED_PROPOSALS] plus the one just inserted. */
private const val PRUNE_WINDOW = 1000

/** What a save did: the new row's [summary] and the ids its prune removed (the audit line's `prunedIds`). */
class SavedProposalSaved(val summary: SavedProposalSummary, val prunedIds: List<UInt>)

/**
 * The saved cross-team proposals (V32, `scheduling.md` "Saved proposals"): the SERVER's own re-computation of a run, kept so a second
 * manager can open it. NOT plan state - no plan lock, no revision bump, and no write to any plan table. The rows are immutable and
 * hard-deleted; the newest [MAX_SAVED_PROPOSALS] are kept. Reads are every signed-in user's; the caller's rights come from the
 * pure [PlanPermissions] over the actor the route resolved.
 */
class SavedProposalService(private val database: R2dbcDatabase) {
    object SavedProposals : UIntIdTable("saved_schedule_proposals") {
        val name = varchar("name", length = MAX_SAVED_PROPOSAL_NAME_LENGTH)
        val asOf = localDate("as_of")
        val planRevision = long("plan_revision")
        val scopeHash = varchar("scope_hash", length = 64)
        val teams = jsonb("teams")
        val selected = jsonb("selected")
        val moveCount = integer("move_count")
        val selectedCount = integer("selected_count")
        val passes = integer("passes")
        val settled = bool("settled")
        val format = short("format")
        val document = jsonb("document")
        val checkDocument = jsonb("check_document").nullable()
        val createdByUserId = reference("created_by_user_id", UserService.Users).nullable()
        val createdAt = long("created_at")
    }

    /**
     * Saves the run [command] describes as the server computes it NOW, in ONE read-write REPEATABLE READ transaction ([SNAPSHOT]) with
     * no plan lock: the table lock first (below), then [guard] (the route's manager-of-every-team check, re-run here against what
     * is committed once the lock is won: a manager cleared while the save waited is a `403`, nothing stored), then the plan revision,
     * then `409 stale-revision` (`expectedRevision` above it) -> the teams' names (a team gone is the `404`) ->
     * [loadCrossTeamSnapshot] -> `409 stale-scope` (the fresh token differs from the request's `scopeHash`, or ANY milestone of a
     * run team has `schedule_revision` above `expectedRevision`) -> [assembleProposal]
     * (`proposeMany` + `postCheckMany`; never a client document) -> a ticked id that is not a move is a `400` -> for a PARTIAL
     * selection [checkResponse] over the ticked moves -> the insert -> the prune of everything beyond the newest
     * [MAX_SAVED_PROPOSALS]. Nothing of the plan is written, so no revision moves.
     *
     * `LOCK TABLE … SHARE ROW EXCLUSIVE` is the FIRST statement, because a REPEATABLE READ snapshot starts at the first query (the
     * guard's): a save that waited for the lock then reads what the saver before it committed (so the prune sees the newest rows and
     * two saves never delete the same row, which would be a serialization failure). Readers are not blocked; a delete waits the few
     * hundred milliseconds a save takes. The lock is the only one the save takes and nothing waits on it while holding another.
     */
    suspend fun save(userId: UInt, actor: PlanActor, command: SavedProposalCommand, guard: suspend () -> Unit): SavedProposalSaved =
        suspendTransaction(database, SNAPSHOT) {
            exec("LOCK TABLE saved_schedule_proposals IN SHARE ROW EXCLUSIVE MODE")
            guard()
            val revision = readPlanRevision()
            if (command.expectedRevision > revision) throw staleRevision(command.expectedRevision, "propose again")
            val names = activeTeamNames(command.teamIds)
            val missing = command.teamIds.filter { it !in names }
            if (missing.isNotEmpty()) throw NotFoundException("Team not found: ${missing.joinToString(", ")}")
            val snapshot = loadCrossTeamSnapshot(names)
            if (snapshot.scopeDigests().token(command.asOf) != command.scopeHash ||
                reschedulesOutsideBatch(command.teamIds, command.expectedRevision, emptyList())
            ) {
                throw ConflictException(
                    "The plan changed since the proposal (a milestone of one of the teams, a pin, a capacity period, a link or a " +
                        "holiday): propose again",
                    problemType = STALE_SCOPE_PROBLEM,
                )
            }
            val proposal = snapshot.assembleProposal(revision, command.asOf)
            val moves = proposal.teams.flatMap { it.moves }.associateBy { it.milestoneId }
            val foreign = command.selected.filter { it !in moves }
            if (foreign.isNotEmpty()) {
                throw BadRequestException("Selected milestones that are not moves of the run: ${foreign.sorted().joinToString(", ")}")
            }
            val check = if (command.selected.size == moves.size) {
                null
            } else {
                val items = command.selected.map { id ->
                    val to = moves.getValue(id).to
                    ValidatedBatchItem(id, DaySpan(LocalDate.parse(to.start), LocalDate.parse(to.end)))
                }
                snapshot.checkResponse(command.teamIds, items)
            }
            val teams = names.entries.sortedBy { it.key }.map { SavedProposalTeam(it.key, it.value) }
            val rowId = SavedProposals.insert {
                it[name] = command.name
                it[asOf] = command.asOf
                it[planRevision] = revision
                it[scopeHash] = proposal.scopeHash
                it[SavedProposals.teams] = canonicalJson(ApiJson.encodeToString(teams))
                it[selected] = canonicalJson(ApiJson.encodeToString(command.selected.sorted()))
                it[moveCount] = moves.size
                it[selectedCount] = command.selected.size
                it[passes] = proposal.passes
                it[settled] = proposal.settled
                it[format] = STORED_PROPOSAL_FORMAT
                it[document] = canonicalJson(ApiJson.encodeToString(proposal))
                it[checkDocument] = check?.let { stored -> canonicalJson(ApiJson.encodeToString(stored)) }
                it[createdByUserId] = userId
                it[createdAt] = nowMillis()
            }[SavedProposals.id].value
            val pruned = SavedProposals.select(SavedProposals.id).orderBy(SavedProposals.id to SortOrder.DESC)
                .limit(PRUNE_WINDOW).offset(MAX_SAVED_PROPOSALS.toLong()).toList().map { it[SavedProposals.id].value }
            if (pruned.isNotEmpty()) SavedProposals.deleteWhere { id inList pruned }
            val header = SavedProposals.select(SAVED_HEADER_COLUMNS).where { SavedProposals.id eq rowId }.toList().single().toSavedHeader()
            SavedProposalSaved(header.toSummary(creatorsOf(listOf(userId)), actor), pruned.sorted())
        }

    /** The newest [MAX_SAVED_PROPOSALS] proposals' facts, newest first (`id` descending: ids grow with the saves), no document. */
    suspend fun list(actor: PlanActor): List<SavedProposalSummary> = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val headers = SavedProposals.select(SAVED_HEADER_COLUMNS).orderBy(SavedProposals.id to SortOrder.DESC)
            .limit(MAX_SAVED_PROPOSALS).toList().map { it.toSavedHeader() }
        val creators = creatorsOf(headers.mapNotNull { it.createdByUserId })
        headers.map { it.toSummary(creators, actor) }
    }

    /**
     * One proposal with its [SavedProposalState] and documents, or null for an unknown id (the route's 404): ONE read-only snapshot, so
     * the row and the state read the same plan. A row of another [STORED_PROPOSAL_FORMAT] is UNREADABLE (no state, no documents).
     */
    suspend fun read(id: UInt, actor: PlanActor): SavedProposalRecord? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val row = SavedProposals.selectAll().where { SavedProposals.id eq id }.toList().singleOrNull() ?: return@suspendTransaction null
        val header = row.toSavedHeader()
        // Another format, or a document this build cannot decode, is UNREADABLE (never a 500): the row stays listable and deletable.
        val stored = if (row[SavedProposals.format] == STORED_PROPOSAL_FORMAT) decodeStored(row) else null
        val state = if (stored != null) {
            savedProposalState(header.teamIds, row[SavedProposals.scopeHash], header.planRevision)
        } else {
            SavedProposalState.UNREADABLE
        }
        SavedProposalRecord(
            id = header.id,
            name = header.name,
            asOf = header.asOf,
            planRevision = header.planRevision,
            createdAt = header.createdAt,
            createdBy = creatorsOf(listOfNotNull(header.createdByUserId))[header.createdByUserId],
            teams = header.teams,
            moveCount = header.moveCount,
            selectedCount = header.selectedCount,
            passes = header.passes,
            settled = header.settled,
            state = state,
            selectedMilestoneIds = ApiJson.decodeFromString<List<UInt>>(row[SavedProposals.selected]),
            proposal = stored?.first,
            check = stored?.second,
            can = SavedProposalCan(
                accept = PlanPermissions.canAcceptSavedProposal(actor, header.teamIds, state),
                delete = PlanPermissions.canDeleteSavedProposal(actor, header.teamIds),
            ),
        )
    }

    /** The row's two documents, or null when either does not decode (logged by id only: the text may hold plan names). */
    private fun decodeStored(row: ResultRow): Pair<CrossTeamProposal, ScheduleCheckResponse?>? = try {
        ApiJson.decodeFromString<CrossTeamProposal>(row[SavedProposals.document]) to
            row[SavedProposals.checkDocument]?.let { ApiJson.decodeFromString<ScheduleCheckResponse>(it) }
    } catch (e: SerializationException) {
        logger.warn("saved proposal {} does not decode ({})", row[SavedProposals.id].value, e::class.simpleName)
        null
    }

    /** The proposal's name and stored teams (the delete's guard and audit read them), or null for an unknown id. */
    internal suspend fun headerOf(id: UInt): SavedHeader? = suspendTransaction(database, readOnly = true) {
        SavedProposals.select(SAVED_HEADER_COLUMNS).where { SavedProposals.id eq id }.toList().singleOrNull()?.toSavedHeader()
    }

    /** Removes the row; the affected count is 0 when it is already gone (the route's 404). */
    suspend fun delete(id: UInt): Int = suspendTransaction(database) { SavedProposals.deleteWhere { SavedProposals.id eq id } }
}
