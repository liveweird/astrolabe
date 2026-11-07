package ch.nokillswit.jira

import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.planning.creatorsOf
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.planning.readPlanRevision
import ch.nokillswit.sync.RunFact
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncStatusKernels
import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

val DeviationViewServiceKey = AttributeKey<DeviationViewService>("DeviationViewService")

/**
 * The deviations document (`GET /views/deviations`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the timeline views' protocol)
 * that takes the PLAN revision FIRST, then the working calendar, the connections (with their effective mapping resolved NOW against
 * the discovery), their newest runs, the bindings left-joined to their observations, the live nodes they sit on and the derived spans of
 * the bound projects and programs, and runs the pure [JiraDeviationKernels] over each binding; the connections' newest runs are read
 * AFTER the bindings are computed (they only feed the connections' `status`). It takes no lock, writes nothing and moves no revision
 * (observations are not plan state). Reads `jira_connections`, `jira_bindings`, `jira_observations`, `sync_runs`, the plan's tree
 * (names, the owner columns of the stream, program and project for `can.acknowledge`) and `milestones` ⋈ `teams`, `users` and `people`
 * (`creatorsOf`: who acknowledged) and `public_holidays` (`persistence.md`).
 *
 * [clock] is the view's "today" (`asOf`, a UTC date) and the age of the newest run; [maxItems] the cap (a test lowers it). The
 * computation itself ([computeInTransaction]) runs in whatever transaction the caller holds, which is how the acknowledge (1.3)
 * recomputes one binding inside its own write.
 */
class DeviationViewService(
    private val database: R2dbcDatabase,
    private val runs: SyncRunService,
    private val clock: () -> Long = ::nowMillis,
    private val maxItems: Int = MAX_DEVIATION_ITEMS,
) {
    /** [actor] null = an anonymous reader (every `can.acknowledge` false); the route resolves it once per request. */
    suspend fun view(filter: DeviationFilter, actor: PlanActor? = null): DeviationView =
        suspendTransaction(database, SNAPSHOT, readOnly = true) {
            val revision = readPlanRevision()
            val now = clock()
            val asOf = asOfOf(now)
            val calendar = loadWorkingCalendar()
            // The estimate noise is listed only on request: the implied `all` of a project or team chip must not switch it on.
            val listNotComparable = filter.all == true || filter.kind == DeviationKind.ESTIMATE_NOT_COMPARABLE
            val computed = computeInTransaction(DeviationScope(), actor, calendar, asOf, listNotComparable)
            val recentRuns = runs.recentRunsInTransaction(SyncKind.JIRA, computed.connections.map { it.id })
            val inScope = computed.candidates.filter { it.matchesScope(filter) }
            val listed = computed.candidates.filter { it.matches(filter) }.sortedWith(CANDIDATE_ORDER)
            // The open counts share `acknowledged`'s basis (every filter but the acknowledgement state): meaningful on `acknowledged=true`.
            val open = inScope.filter { it.open }
            DeviationView(
                revision = revision,
                asOf = asOf.toString(),
                connections = computed.connections.sortedWith(compareBy<ConnectionFacts>({ it.name.lowercase() }, { it.id }))
                    .map { it.toWire(recentRuns.getValue(it.id), now) },
                totals = DeviationTotals(
                    warnings = open.sumOf { c -> c.shown.count { it.severity == DeviationSeverity.WARNING } },
                    infos = open.sumOf { c -> c.shown.count { it.severity == DeviationSeverity.INFO } },
                    bindings = listed.size,
                    gone = open.count { it.item.jira.gone },
                    acknowledged = inScope.count { it.currentAck },
                ),
                items = listed.take(maxItems).map { it.item },
                truncated = listed.size > maxItems,
            )
        }

    /**
     * The deviations of the bindings in [scope], computed INSIDE the caller's transaction: the view's snapshot, or the acknowledge's
     * write, which recomputes the ONE binding it is about to stamp against the very rows it holds locked. The live nodes, their derived
     * spans, the parents' bindings and the acknowledging logins' names are read here; [calendar] and [asOf] are the caller's (the
     * view reads them first, in its snapshot's order). A binding whose node or any ancestor is soft-deleted, or whose connection is
     * deleted, is absent from [Computed.candidates] (hidden, exactly as the view hides it).
     */
    internal suspend fun computeInTransaction(
        scope: DeviationScope,
        actor: PlanActor?,
        calendar: WorkingCalendar,
        asOf: LocalDate,
        listNotComparable: Boolean = false,
    ): Computed {
        val connections = loadConnections(scope.connectionId)
        val bindings = loadBindings(scope)
        val nodes = loadNodes(bindings.map { it.ref })
        val live = bindings.filter { it.ref in nodes }
        val creators = creatorsOf(live.mapNotNull { it.ack?.byUserId })
        val world = World(
            connections.associateBy { it.id }, nodes, loadDerivedSpans(nodes.values), loadBoundTo(scope, live),
            calendar, asOf, actor, creators,
        )
        return Computed(connections, live.mapNotNull { world.candidate(it, listNotComparable) })
    }

    /**
     * The ONE binding [bindingId] computed in the caller's transaction against the live calendar and this service's clock: null when it
     * is hidden (inactive, its node or an ancestor dead, its connection deleted). The acknowledge's stale check.
     */
    internal suspend fun computeBindingInTransaction(bindingId: UInt, connectionId: UInt): Candidate? {
        val asOf = asOfOf(clock())
        val scope = DeviationScope(connectionId = connectionId, bindingId = bindingId)
        return computeInTransaction(scope, null, loadWorkingCalendar(), asOf).candidates.singleOrNull()
    }

    private fun asOfOf(now: Long): LocalDate = LocalDate.ofInstant(Instant.ofEpochMilli(now), ZoneOffset.UTC)

    /** The status is derived against the view's own clock (an unfinished row older than the claim window was interrupted). */
    private fun ConnectionFacts.toWire(recent: List<RunFact>, now: Long): DeviationConnection {
        val status = SyncStatusKernels.derive(connector, recent, now, runs.maxRunMinutes)
        return DeviationConnection(
            id = id,
            name = name,
            siteUrl = siteUrl,
            enabled = enabled,
            mappingOk = levels != null,
            lastRun = status.lastRun,
            status = status,
        )
    }
}

/** What [DeviationViewService.computeInTransaction] read: the ACTIVE connections (or the scoped one) and the computed live bindings. */
internal class Computed(val connections: List<ConnectionFacts>, val candidates: List<Candidate>)
