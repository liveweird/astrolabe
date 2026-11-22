package ch.nokillswit.flow

import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.RunProblem
import ch.nokillswit.sync.RunProgress
import ch.nokillswit.sync.SyncErrorCodes
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.runWithTally
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import org.slf4j.LoggerFactory
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId

val FlowObserverKey = AttributeKey<FlowObserver>("FlowObserver")

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

/** `400` text of a manual request for a connection that cannot run now (unknown, deleted or disabled). */
const val UNKNOWN_FLOW_CONNECTION = "Unknown or disabled Flow connection"

/**
 * The Flow connector's run (`flow-sync.md` "The run"): ONE `GET /integration/teams?sprintsSince=` and, from that single document, a
 * wholesale replacement of the connection's mirror ([FlowMirrorStore.replace], whose transaction also prunes the capacity
 * acknowledgements whose row left the list: [CapacityAcknowledgeService.pruneConnectionInTransaction]). It OBSERVES: nothing is ever
 * written to Flow, no plan lock is taken, no plan revision moves, and no database transaction is open across the Flow call (the token
 * is read in its own short transaction before it, the mirror written in another after it).
 *
 * Every problem of the run itself is a typed [SyncResult.failed]: a [FetchException] keeps its code (a revoked token is
 * `AUTHENTICATION_FAILED`, an outage `UPSTREAM_UNAVAILABLE`, a throttle `RATE_LIMITED`; the registry's doubling back-off and its jitter
 * then apply, and the mirror keeps its LAST document), an undecryptable token is `TOKEN_UNREADABLE`, a connection deleted or disabled
 * while the call was in flight is `CONNECTION_GONE` / `CONNECTION_DISABLED` and writes nothing.
 */
class FlowObserver internal constructor(
    private val connector: FlowConnector,
    private val connections: FlowConnectionService,
    private val mirror: FlowMirrorStore,
    private val bindings: FlowTeamBindingService,
    /** REQUIRED (no default): the run prunes the capacity acknowledgements in the mirror's transaction; a wiring slip must not compile. */
    private val acknowledgements: CapacityAcknowledgeService,
    private val now: () -> Long = ::nowMillis,
) : Connector {
    override val kind = SyncKind.FLOW

    override suspend fun requireRunnable(connectionId: UInt) {
        if (!connections.isRunnable(connectionId)) throw BadRequestException(UNKNOWN_FLOW_CONNECTION)
    }

    override suspend fun lockActiveInTransaction(connectionId: UInt) {
        if (!connections.lockActiveInTransaction(connectionId)) throw BadRequestException(UNKNOWN_FLOW_CONNECTION)
    }

    /** The scheduler's poll rows (no token): `FlowConnectionService.pollRows`. */
    override suspend fun connections(): List<ConnectorConnection> = connections.pollRows()

    override suspend fun connections(queryTimeoutSeconds: Int): List<ConnectorConnection> = connections.pollRows(queryTimeoutSeconds)

    override suspend fun run(run: ClaimedRun): SyncResult {
        val progress = RunProgress()
        return runWithTally(run, progress, FLOW_SOURCE.label) { execute(run, progress) }
    }

    private suspend fun execute(run: ClaimedRun, progress: RunProgress) {
        val target = connections.readForRun(run.connectionId) ?: throw RunProblem(SyncErrorCodes.CONNECTION_GONE, GONE_DETAIL)
        if (!target.enabled) throw RunProblem(SyncErrorCodes.CONNECTION_DISABLED, DISABLED_DETAIL)
        val token = target.apiToken ?: throw RunProblem(
            SyncErrorCodes.TOKEN_UNREADABLE, "The stored service token cannot be decrypted - ask an administrator to enter it again",
        )
        val sprintsSince = sprintsSince(target)
        progress.calls++
        val document = connector.client(target.baseUrl, token).teams(sprintsSince)
        val teams = document.items.distinctBy { it.id }
        // A document cut at the team cap omits teams that still exist: they stay in the mirror (neither replaced nor deleted), never gone.
        // The call may have outlived the connection, so the store judges it under the connection's row lock, the same instant it writes:
        // a deleted one (its token destroyed, its mirror removed) or one switched off meanwhile gets nothing stored.
        // The same transaction prunes the capacity acknowledgements whose row left the list (1.10). A sprints-truncated document judges
        // no SPRINT key (a sprint missing from it was merely not sent; the cap is per document, across all teams) but still prunes what
        // does not depend on sprints: a returned team's own row, an unlinked binding, a deleted team.
        var cleared: List<ClearedCapacityAcks> = emptyList()
        val prune: suspend () -> Unit = {
            cleared = acknowledgements.pruneConnectionInTransaction(run.connectionId, sprintsJudgeable = !document.sprintsTruncated)
        }
        val write = mirror.replace(
            run.connectionId,
            teams.map { it.toMirrorTeam() },
            now(),
            keepAbsentTeams = document.teamsTruncated,
            sprintsComplete = !document.sprintsTruncated,
            afterWrite = prune,
        )
        when (write) {
            FlowMirrorWrite.WRITTEN -> reportCleared(run, cleared)
            FlowMirrorWrite.GONE -> throw RunProblem(SyncErrorCodes.CONNECTION_GONE, GONE_DETAIL)
            FlowMirrorWrite.DISABLED -> throw RunProblem(SyncErrorCodes.CONNECTION_DISABLED, DISABLED_DETAIL)
        }
        progress.observed = teams.size
        if (document.sprintsTruncated) {
            log.warn("Sync run {} Flow document truncated at {} sprints: the mirror keeps what Flow sent", run.id, FLOW_SPRINT_CAP)
        }
        if (document.teamsTruncated) {
            log.warn(
                "Sync run {} Flow document truncated at {} teams: the mirror keeps the teams it already had, none is counted gone",
                run.id, FLOW_TEAM_CAP,
            )
        } else {
            val present = teams.mapTo(HashSet()) { it.id }
            progress.gone = bindings.bindingsOf(run.connectionId).count { it.flowTeamId !in present }
        }
    }

    /** After the commit (a line inside the transaction could describe a rollback): one audit line per binding that lost rows, one INFO. */
    private fun reportCleared(run: ClaimedRun, cleared: List<ClearedCapacityAcks>) {
        if (cleared.isEmpty()) return
        cleared.forEach {
            auditCapacityAcksCleared(it.bindingId, it.sprintIds, run.connectionId, run.byUserId, via = "run", runId = run.id)
        }
        log.info("Sync run {} cleared {} capacity acknowledgement(s) whose row left the list", run.id, cleared.sumOf { it.sprintIds.size })
    }

    /** Today in the connection's zone minus `flow.sprintsSinceDays`: the oldest sprint the run asks Flow for. */
    private fun sprintsSince(target: FlowConnectionTarget) = try {
        Instant.ofEpochMilli(now()).atZone(ZoneId.of(target.timeZone)).toLocalDate().minusDays(connector.sprintsSinceDays.toLong())
    } catch (_: DateTimeException) {
        throw RunProblem(FlowRunCodes.TIME_ZONE_INVALID, "The connection's time zone is not known to this server")
    }

    private companion object {
        const val GONE_DETAIL = "The Flow connection was deleted during the run"
        const val DISABLED_DETAIL = "The Flow connection is disabled"
    }
}
