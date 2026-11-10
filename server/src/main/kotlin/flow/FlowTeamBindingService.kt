package ch.nokillswit.flow

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.teams.TeamGuard
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.statements.StatementType
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val FlowTeamBindingServiceKey = AttributeKey<FlowTeamBindingService>("FlowTeamBindingService")

/** An ACTIVE binding of an Astrolabe team to a Flow team of a connection (the id of the Flow team is the key; the name is display only). */
data class FlowTeamBindingRow(
    val id: UInt,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    /** The Flow team's name when it was linked: a rename in Flow does not change it, the binding follows [flowTeamId]. */
    val flowTeamName: String,
    val createdAt: Long,
)

/** A [FlowTeamBindingRow] with its ACTIVE Astrolabe team's name. */
data class FlowTeamBindingWithTeam(val binding: FlowTeamBindingRow, val teamName: String)

/**
 * The key of the transaction-scoped advisory lock every link and every "Link all suggested" takes first (the ASCII bytes of "AstroFBT").
 * Both are human clicks, a few milliseconds each, so ONE global lock serializes them: the two uniqueness checks below are then exact
 * over rows that may not exist yet (a row lock cannot do that), and the partial unique indexes stay a backstop.
 */
internal const val FLOW_BIND_LOCK_KEY = 0x417374726F464254L

private const val TEAM_NOT_FOUND = "Team not found"
private const val BINDING_NOT_FOUND = "Flow team binding not found"
private const val CONNECTION_NOT_FOUND = "Flow connection not found"

/** An ACTIVE binding with its Astrolabe team's name; [teamName] is null when that team was soft-deleted (a dead holder). */
private class Holder(
    val id: UInt,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val flowTeamName: String,
    val teamName: String?,
)

/**
 * The team bindings (V24 `flow_team_bindings`): the 1:1 link of an Astrolabe team to a Flow team that feeds the roster and the capacity
 * import. Not plan state: no plan lock, no revision. Soft-deleted = unlinked. The service OWNS the table and READS `teams` (active names)
 * and the connection registry and the mirror (existence, enabled, the Flow team's name); it writes none of them. A soft-deleted team keeps
 * its ACTIVE binding (`teams/` may not name `flow/`), so the link and the match release a dead team's holder of a Flow team in their own
 * transaction, and every read ([bindingsOf], [teamIdOf], the panel) filters on ACTIVE teams.
 * [FlowConnectionService.delete] soft-deletes a connection's bindings in its own transaction through [Bindings].
 *
 * Lock order of a link or a match: the bind lock, the connection row `FOR SHARE` (a connection delete or a run's mirror replace waits, or
 * has won and this is a 404/400), the team row(s) `FOR SHARE`, the manager guard (its own `FOR SHARE` on the team and the manager's
 * person), then the binding rows `FOR NO KEY UPDATE`, then the inserts. A connection delete takes the connection row, then writes the
 * bindings. [unbind] is the one path that takes a binding row FIRST (it is addressed by the binding): the binding row `FOR NO KEY
 * UPDATE`, then the guard's team and person rows `FOR SHARE`, then the soft delete. It takes neither the bind lock nor the connection
 * row, and a `FOR SHARE` on the team never waits for a binding row (a team delete locks the team row and touches no binding), so no
 * lock cycle exists between it and a link, a match, a connection delete or a team delete. [CapacityAcknowledgeService] (1.9) is the second
 * binding-first path, in the same shape and with the same argument (binding row, then the guard's rows, then its own acknowledgement rows).
 */
class FlowTeamBindingService(private val database: R2dbcDatabase) {
    object Bindings : UIntIdTable("flow_team_bindings"), SoftDeletable {
        val connectionId = reference("connection_id", FlowConnectionService.Connections)

        /** No `ON DELETE` rule: teams are only soft-deleted. */
        val teamId = reference("team_id", TeamService.Teams)
        val flowTeamId = integer("flow_team_id")
        val flowTeamName = varchar("flow_team_name", length = FLOW_TEAM_NAME_WIDTH)

        /** The linking login's id (`users.id` is BIGINT; V24 has the FK, no `users` import here: `flow/` names no `users` type). */
        val createdByUserId = long("created_by_user_id")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The ACTIVE bindings of one connection in id order, of ACTIVE teams only: a team's soft delete leaves its binding active (`teams/`
     * may not name `flow/`), so a binding of a dead team is not a binding to anyone reading. A bound team's `gone` is derived from the
     * mirror at read time, never stored.
     */
    suspend fun bindingsOf(connectionId: UInt): List<FlowTeamBindingRow> = suspendTransaction(database) {
        val teams = TeamService.Teams
        Bindings.innerJoin(teams).selectAll()
            .where { (Bindings.connectionId eq connectionId) and Bindings.active() and teams.active() }
            .orderBy(Bindings.id to SortOrder.ASC).toList().map {
                FlowTeamBindingRow(
                    id = it[Bindings.id].value,
                    connectionId = connectionId,
                    teamId = it[Bindings.teamId].value,
                    flowTeamId = it[Bindings.flowTeamId],
                    flowTeamName = it[Bindings.flowTeamName],
                    createdAt = it[Bindings.createdAt],
                )
            }
    }

    /**
     * The ACTIVE bindings of ACTIVE teams on any of [connectionIds] (narrowed to [teamId] when given) with the team's name, in binding id
     * order - [bindingsOf]'s predicate in ONE statement for many connections (the capacity deviation view's read, inside its snapshot).
     */
    suspend fun activeBindingsWithTeams(connectionIds: Collection<UInt>, teamId: UInt?): List<FlowTeamBindingWithTeam> {
        if (connectionIds.isEmpty()) return emptyList()
        return suspendTransaction(database) {
            val teams = TeamService.Teams
            Bindings.innerJoin(teams).selectAll()
                .where {
                    (Bindings.connectionId inList connectionIds) and Bindings.active() and teams.active() and
                        (teamId?.let { Bindings.teamId eq it } ?: Op.TRUE)
                }
                .orderBy(Bindings.id to SortOrder.ASC).toList().map {
                    FlowTeamBindingWithTeam(
                        FlowTeamBindingRow(
                            id = it[Bindings.id].value,
                            connectionId = it[Bindings.connectionId].value,
                            teamId = it[Bindings.teamId].value,
                            flowTeamId = it[Bindings.flowTeamId],
                            flowTeamName = it[Bindings.flowTeamName],
                            createdAt = it[Bindings.createdAt],
                        ),
                        teamName = it[teams.name],
                    )
                }
        }
    }

    /**
     * Links [command]'s team to its Flow team in ONE transaction: the connection (unknown, deleted or disabled: `400`), the Flow team in
     * the mirror as it is now (`400`), the team row `FOR SHARE` (gone: `404`), then [guard] re-run against the locked state (`403`), then
     * the two uniqueness rules: the team's own active binding is a `409`; the Flow team's active bindings are a `409` unless their team
     * was deleted, in which case the holder is RELEASED (soft-deleted, reported in [FlowBindOutcome.released] for the route to audit after
     * the commit) and the link goes through.
     */
    suspend fun bind(command: FlowBindCommand, guard: TeamGuard): FlowBindOutcome = suspendTransaction(database) {
        takeBindLock()
        if (lockConnectionShared(command.connectionId) != true) throw BadRequestException(UNKNOWN_FLOW_CONNECTION)
        val flowName = FlowTeams.select(FlowTeams.name)
            .where { (FlowTeams.connectionId eq command.connectionId) and (FlowTeams.flowTeamId eq command.flowTeamId) }
            .toList().singleOrNull()?.get(FlowTeams.name) ?: throw BadRequestException(UNKNOWN_FLOW_TEAM)
        val teams = TeamService.Teams
        val teamName = teams.select(teams.name).where { (teams.id eq command.teamId) and teams.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().singleOrNull()?.get(teams.name)
            ?: throw NotFoundException(TEAM_NOT_FOUND)
        guard(command.teamId)
        lockedHolders(Bindings.teamId eq command.teamId).firstOrNull()?.let { other ->
            throw ConflictException("Team $teamName is already linked to Flow team ${other.flowTeamName}", FLOW_ALREADY_BOUND_PROBLEM)
        }
        val released = lockedHolders(
            (Bindings.connectionId eq command.connectionId) and (Bindings.flowTeamId eq command.flowTeamId),
        ).map { other ->
            other.teamName?.let { holder ->
                throw ConflictException("Flow team $flowName is already linked to team $holder", FLOW_ALREADY_BOUND_PROBLEM)
            }
            release(other)
        }
        val binding = insertBinding(command.connectionId, command.teamId, teamName, command.flowTeamId, flowName, command.byUserId)
        FlowBindOutcome(binding, released)
    }

    /**
     * Soft-deletes binding [id] (the row stays as history). The route read the binding's team first for the 404 -> 403 ordering; here the
     * row is locked, re-read (gone or its team dead: `404`) and [guard] runs again against the stored team.
     */
    suspend fun unbind(id: UInt, guard: TeamGuard): FlowUnboundBinding = suspendTransaction(database) {
        val binding = lockedHolders(Bindings.id eq id).singleOrNull()?.takeIf { it.teamName != null }
            ?: throw NotFoundException(BINDING_NOT_FOUND)
        guard(binding.teamId)
        release(binding, reason = "UNLINKED")
    }

    /** An ACTIVE binding of an ACTIVE team by id (the capacity import's lookup, inside its snapshot); null = gone, a `404`. */
    suspend fun bindingOf(id: UInt): FlowTeamBindingRow? = suspendTransaction(database) {
        val teams = TeamService.Teams
        Bindings.innerJoin(teams).selectAll().where { (Bindings.id eq id) and Bindings.active() and teams.active() }.toList()
            .singleOrNull()?.let {
                FlowTeamBindingRow(
                    id = id,
                    connectionId = it[Bindings.connectionId].value,
                    teamId = it[Bindings.teamId].value,
                    flowTeamId = it[Bindings.flowTeamId],
                    flowTeamName = it[Bindings.flowTeamName],
                    createdAt = it[Bindings.createdAt],
                )
            }
    }

    /** The Astrolabe team of an ACTIVE binding of an ACTIVE team (the unlink's read-before-guard lookup); null = `404` for every caller. */
    suspend fun teamIdOf(id: UInt): UInt? = bindingOf(id)?.teamId

    /**
     * "Link all suggested" (ADMIN, the route guards): in ONE transaction the connection is locked (deleted: `404`, disabled: `400`),
     * the dead teams' holders released, and every Flow team of the mirror that is not bound and whose name matches exactly one unbound
     * active Astrolabe team ([FlowTeamMatchKernels.suggest]) is bound to it. The rest is reported: `ALREADY_BOUND` or `NO_MATCH`.
     */
    suspend fun match(connectionId: UInt, byUserId: UInt): FlowMatchOutcome = suspendTransaction(database) {
        takeBindLock()
        when (lockConnectionShared(connectionId)) {
            null -> throw NotFoundException(CONNECTION_NOT_FOUND)
            false -> throw BadRequestException(UNKNOWN_FLOW_CONNECTION)
            true -> Unit
        }
        val released = lockedHolders(Bindings.connectionId eq connectionId).filter { it.teamName == null }.map { release(it) }
        val boundFlowIds = Bindings.select(Bindings.flowTeamId).where { Bindings.active() and (Bindings.connectionId eq connectionId) }
            .toList().map { it[Bindings.flowTeamId] }.toSet()
        val mirror = FlowTeams.select(FlowTeams.flowTeamId, FlowTeams.name).where { FlowTeams.connectionId eq connectionId }
            .orderBy(FlowTeams.name to SortOrder.ASC, FlowTeams.flowTeamId to SortOrder.ASC).toList()
            .map { it[FlowTeams.flowTeamId] to it[FlowTeams.name] }
        val boundTeamIds = Bindings.select(Bindings.teamId).where { Bindings.active() }.toList().map { it[Bindings.teamId].value }
        val teams = TeamService.Teams
        val candidates = teams.select(teams.id, teams.name)
            .where { teams.active() and (if (boundTeamIds.isEmpty()) Op.TRUE else teams.id notInList boundTeamIds) }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().map { it[teams.id].value to it[teams.name] }
        val suggestions = FlowTeamMatchKernels.suggest(mirror.filter { it.first !in boundFlowIds }, candidates)
        val teamNames = candidates.toMap()
        val made = mirror.mapNotNull { (flowId, flowName) ->
            suggestions[flowId]?.let { teamId ->
                insertBinding(connectionId, teamId, teamNames.getValue(teamId), flowId, flowName, byUserId)
            }
        }
        val linked = made.mapTo(HashSet()) { it.flowTeamId }
        val skipped = mirror.filter { it.first !in linked }.map { (flowId, _) ->
            FlowMatchSkipped(flowId, if (flowId in boundFlowIds) FlowMatchSkipReason.ALREADY_BOUND else FlowMatchSkipReason.NO_MATCH)
        }
        FlowMatchOutcome(FlowTeamMatchResponse(made.map { FlowMatchBound(it.id, it.teamId, it.flowTeamId) }, skipped), made, released)
    }

    private suspend fun R2dbcTransaction.takeBindLock() {
        exec("SELECT pg_advisory_xact_lock($FLOW_BIND_LOCK_KEY)", explicitStatementType = StatementType.SELECT) { 0 }?.toList()
    }

    /** Locks the ACTIVE connection `FOR SHARE` and answers whether it is enabled; null = missing or deleted. */
    private suspend fun lockConnectionShared(id: UInt): Boolean? {
        val connections = FlowConnectionService.Connections
        return connections.select(connections.enabled).where { (connections.id eq id) and connections.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().singleOrNull()?.get(connections.enabled)
    }

    /**
     * The ACTIVE bindings matching [predicate] in id order, locked `FOR NO KEY UPDATE` for the rest of the transaction, each with its
     * team's name (null = the team is deleted). The team rows are read, not locked: a deleted team stays deleted.
     */
    private suspend fun lockedHolders(predicate: Op<Boolean>): List<Holder> {
        val rows = Bindings.selectAll().where { Bindings.active() and predicate }.orderBy(Bindings.id)
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList()
        if (rows.isEmpty()) return emptyList()
        val teams = TeamService.Teams
        val live = teams.select(teams.id, teams.name)
            .where { (teams.id inList rows.map { it[Bindings.teamId].value }.distinct()) and teams.active() }
            .toList().associate { it[teams.id].value to it[teams.name] }
        return rows.map {
            val teamId = it[Bindings.teamId].value
            Holder(
                it[Bindings.id].value, it[Bindings.connectionId].value, teamId,
                it[Bindings.flowTeamId], it[Bindings.flowTeamName], live[teamId],
            )
        }
    }

    private suspend fun release(holder: Holder, reason: String = "TEAM_GONE"): FlowUnboundBinding {
        Bindings.update({ (Bindings.id eq holder.id) and Bindings.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        return FlowUnboundBinding(holder.id, holder.connectionId, holder.teamId, holder.flowTeamId, reason)
    }

    private suspend fun insertBinding(
        connectionId: UInt,
        teamId: UInt,
        teamName: String,
        flowTeamId: Int,
        flowTeamName: String,
        byUserId: UInt,
    ): FlowTeamBindingResponse {
        val stamp = nowMillis()
        val id = Bindings.insert {
            it[this.connectionId] = connectionId
            it[this.teamId] = teamId
            it[this.flowTeamId] = flowTeamId
            it[this.flowTeamName] = flowTeamName
            it[createdByUserId] = byUserId.toLong()
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Bindings.id].value
        return FlowTeamBindingResponse(id, connectionId, teamId, teamName, flowTeamId, flowTeamName, stamp)
    }
}
