package ch.nokillswit.jira

import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.SNAPSHOT
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
 * the bound projects and programs, and runs the pure [JiraDeviationKernels] over each binding. It takes no lock, writes nothing and moves
 * no revision (observations are not plan state). Reads `jira_connections`, `jira_bindings`, `jira_observations`, `sync_runs`, the plan's
 * tree and `milestones` ⋈ `teams`, and `public_holidays` (`persistence.md`).
 *
 * [clock] is the view's "today" (`asOf`, a UTC date) and the age of the newest run; [maxItems] the cap (a test lowers it).
 */
class DeviationViewService(
    private val database: R2dbcDatabase,
    private val runs: SyncRunService,
    private val clock: () -> Long = ::nowMillis,
    private val maxItems: Int = MAX_DEVIATION_ITEMS,
) {
    suspend fun view(filter: DeviationFilter): DeviationView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val now = clock()
        val asOf = LocalDate.ofInstant(Instant.ofEpochMilli(now), ZoneOffset.UTC)
        val calendar = loadWorkingCalendar()
        val connections = loadConnections()
        val recentRuns = runs.recentRunsInTransaction(SyncKind.JIRA, connections.map { it.id })
        val bindings = loadBindings()
        val nodes = loadNodes(bindings.map { it.ref })
        val live = bindings.filter { it.ref in nodes }
        val world = World(connections.associateBy { it.id }, nodes, loadDerivedSpans(nodes.values), live, calendar, asOf)
        // The estimate noise is listed only on request: the implied `all` of a project or team chip must not switch it on.
        val listNotComparable = filter.all == true || filter.kind == DeviationKind.ESTIMATE_NOT_COMPARABLE
        val candidates = live.mapNotNull { world.candidate(it, listNotComparable) }
            .filter { it.matches(filter) }
            .sortedWith(CANDIDATE_ORDER)
        DeviationView(
            revision = revision,
            asOf = asOf.toString(),
            connections = connections.sortedWith(compareBy<ConnectionFacts>({ it.name.lowercase() }, { it.id }))
                .map { it.toWire(recentRuns.getValue(it.id), now) },
            totals = DeviationTotals(
                warnings = candidates.sumOf { c -> c.shown.count { it.severity == DeviationSeverity.WARNING } },
                infos = candidates.sumOf { c -> c.shown.count { it.severity == DeviationSeverity.INFO } },
                bindings = candidates.size,
                gone = candidates.count { it.item.jira.gone },
            ),
            items = candidates.take(maxItems).map { it.item },
            truncated = candidates.size > maxItems,
        )
    }

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

/** A binding's finished row and the deviations it LISTS ([shown]: `ESTIMATE_NOT_COMPARABLE` only on request). */
private class Candidate(val item: DeviationItem, val node: NodeRow, val bindingId: UInt, val shown: List<Deviation>) {
    fun matches(filter: DeviationFilter): Boolean =
        (filter.connectionId == null || item.connectionId == filter.connectionId) &&
            (filter.level == null || item.level == filter.level) &&
            (filter.workStreamId == null || node.workStreamId == filter.workStreamId) &&
            (filter.programId == null || node.programId == filter.programId) &&
            (filter.projectId == null || node.projectId == filter.projectId) &&
            (filter.teamId == null || node.teamId == filter.teamId) &&
            (filter.kind == null || shown.any { it.kind == filter.kind }) &&
            (filter.severity == null || shown.any { it.severity == filter.severity }) &&
            (filter.includeAll || shown.isNotEmpty())
}

/** Warnings first, then work stream, program, project, level (program, project, milestone), name, binding id. */
private val CANDIDATE_ORDER: Comparator<Candidate> = compareBy<Candidate>(
    { c -> if (c.shown.any { it.severity == DeviationSeverity.WARNING }) 0 else 1 },
    { it.node.workStreamName.lowercase() },
    { it.node.programName.orEmpty().lowercase() },
    { it.node.projectName.orEmpty().lowercase() },
    { it.node.ref.level },
    { it.node.name.lowercase() },
    { it.bindingId },
)

/** Everything one view computation reads, so the per-binding step is a method with a short signature. */
private class World(
    val connections: Map<UInt, ConnectionFacts>,
    val nodes: Map<PlanRef, NodeRow>,
    val spans: Map<PlanRef, DaySpan>,
    live: List<BindingRow>,
    val calendar: WorkingCalendar,
    val asOf: LocalDate,
) {
    /** The plan node each LIVE binding's issue is bound to, per connection: where a parent issue's own binding points. */
    private val boundTo: Map<Pair<UInt, String>, PlanRef> = live.associate { (it.connectionId to it.issueId) to it.ref }

    fun candidate(row: BindingRow, listNotComparable: Boolean): Candidate? {
        val connection = connections[row.connectionId] ?: return null
        val node = nodes[row.ref] ?: return null
        val span = spans[row.ref]
        val plan = planSide(node, span, connection.levels?.keys)
        val stored = row.observation
        val parentIssueId = stored?.issue?.parentIssueId
        val all = JiraDeviationKernels.deviations(
            level = row.ref.level,
            issue = stored?.issue,
            plan = plan,
            mapping = connection.levels?.get(row.ref.level),
            parentBoundTo = parentIssueId?.let { boundTo[row.connectionId to it] },
            calendar = calendar,
            asOf = asOf,
        )
        val shown = if (listNotComparable) all else all.filter { it.kind != DeviationKind.ESTIMATE_NOT_COMPARABLE }
        val item = DeviationItem(
            bindingId = row.id,
            connectionId = row.connectionId,
            level = row.ref.level,
            node = node.toWire(),
            jira = row.toJira(connection.siteUrl),
            plan = DeviationPlan(
                start = plan.start?.toString(),
                end = plan.end?.toString(),
                estimateMd = plan.estimateMd?.toDouble(),
                targetStart = plan.targetStart?.toString(),
                targetEnd = plan.targetEnd?.toString(),
                spanStart = span?.start?.toString(),
                spanEnd = span?.end?.toString(),
            ),
            deviations = shown,
        )
        return Candidate(item, node, row.id, shown)
    }

    /**
     * A milestone compares its stored dates; a project or program its derived span. [mapped] are the plan levels the connection's
     * mapping reads (null = the mapping does not resolve). The EXPECTED parent of an issue is the nearest ancestor whose level is
     * mapped: a milestone's is its project, else - with the project level unmapped, which the validator allows - its program; a
     * project's is its program. With none mapped, or no mapping to tell, there is no parent to compare (an Epic's parent would be
     * bound to a node of another level, and every milestone would warn).
     */
    private fun planSide(node: NodeRow, span: DaySpan?, mapped: Set<JiraLevel>?): PlanSide {
        fun program() = node.programId?.let { PlanParent(PlanRef(JiraLevel.PROGRAM, it), node.programName.orEmpty()) }
        fun project() = node.projectId?.let { PlanParent(PlanRef(JiraLevel.PROJECT, it), node.projectName.orEmpty()) }
        val parent = when {
            mapped == null -> null
            node.ref.level == JiraLevel.PROJECT -> program().takeIf { JiraLevel.PROGRAM in mapped }
            node.ref.level == JiraLevel.MILESTONE -> when {
                JiraLevel.PROJECT in mapped -> project()
                JiraLevel.PROGRAM in mapped -> program()
                else -> null
            }
            else -> null
        }
        val milestone = node.ref.level == JiraLevel.MILESTONE
        return PlanSide(
            name = node.name,
            start = if (milestone) node.fields.start else span?.start,
            end = if (milestone) node.fields.end else span?.end,
            targetStart = node.fields.targetStart,
            targetEnd = node.fields.targetEnd,
            estimateMd = node.fields.estimateMd,
            parent = parent,
        )
    }
}

private fun NodeRow.toWire() = DeviationNode(
    kind = ref.level,
    id = ref.id,
    name = name,
    projectId = projectId,
    projectName = projectName,
    programId = programId,
    programName = programName,
    workStreamId = workStreamId,
    workStreamName = workStreamName,
    teamId = teamId,
    teamName = teamName,
)

private fun BindingRow.toJira(siteUrl: String): DeviationJira {
    val seen = observation
    val issue = seen?.issue
    return DeviationJira(
        issueId = issueId,
        key = issueKey,
        url = "$siteUrl/browse/$issueKey",
        summary = issue?.summary,
        typeName = seen?.typeName,
        hierarchyLevel = issue?.hierarchyLevel,
        statusName = seen?.statusName,
        statusCategory = issue?.statusCategory,
        start = issue?.startDate?.toString(),
        end = issue?.endDate?.toString(),
        estimate = issue?.estimate?.toDouble(),
        estimateUnit = issue?.estimateUnit,
        parentKey = issue?.parentIssueKey,
        teamName = seen?.teamName,
        observedAt = seen?.observedAt,
        gone = issue?.gone == true,
    )
}
