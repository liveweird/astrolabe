package ch.nokillswit.jira

import ch.nokillswit.infra.json.fingerprintOf
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.BaselineCreator
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.Deviation
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.PlanPermissions
import kotlinx.serialization.builtins.ListSerializer
import java.time.LocalDate

/*
 * The per-binding step of the deviations computation (`DeviationViewService.computeInTransaction`), pure over what the row loaders
 * read: the kernels, the fingerprint, the acknowledgement state and the caller's `can`. Shared by the view, the acknowledge (one
 * binding, inside its locked transaction) and - from 1.3's C5 - the timeline flag fold.
 */

/**
 * The fingerprint of a deviation list: the SHA-256 (lower-case hex) of its canonical JSON (`[{kind, severity, detail}]` in the
 * kernel's order), through the shared [fingerprintOf] of `infra/json`. Equal lists give equal fingerprints across reads and processes;
 * any change to a kind, a severity or a detail changes it. The EMPTY list has one too ([fingerprintOf] of `[]`), but nothing is ever
 * acknowledged against it.
 */
internal fun fingerprintOf(deviations: List<Deviation>): String =
    fingerprintOf(ListSerializer(Deviation.serializer()), deviations)

/**
 * A live binding's computed row. [all] is the kernel's FULL list (what [DeviationItem.fingerprint] hashes); [shown] the part the
 * item LISTS (`ESTIMATE_NOT_COMPARABLE` only on request). A binding is OPEN while it lists a deviation and its acknowledgement is not
 * [currentAck].
 */
internal class Candidate(
    val item: DeviationItem,
    val node: NodeRow,
    val bindingId: UInt,
    val all: List<Deviation>,
    val shown: List<Deviation>,
    val currentAck: Boolean,
    /** The epic's census roll-up (milestone bindings; null = none): what the timeline fold carries onto the link. */
    val rollup: ChildRollup?,
) {
    val open: Boolean get() = shown.isNotEmpty() && !currentAck

    /** Every filter but the acknowledgement state: what `totals.acknowledged` counts over. */
    fun matchesScope(filter: DeviationFilter): Boolean =
        (filter.connectionId == null || item.connectionId == filter.connectionId) &&
            (filter.level == null || item.level == filter.level) &&
            (filter.workStreamId == null || node.workStreamId == filter.workStreamId) &&
            (filter.programId == null || node.programId == filter.programId) &&
            (filter.projectId == null || node.projectId == filter.projectId) &&
            (filter.teamId == null || node.teamId == filter.teamId) &&
            (filter.kind == null || shown.any { it.kind == filter.kind }) &&
            (filter.severity == null || shown.any { it.severity == filter.severity })

    /**
     * Whether the binding is listed. By default the OPEN ones; `acknowledged=true` the CURRENTLY acknowledged ones; `acknowledged=false`
     * the ones without a current acknowledgement (the open ones, plus clean ones when everything is listed); an
     * [includeAll][DeviationFilter.includeAll] listing without the filter keeps every state.
     */
    fun matches(filter: DeviationFilter): Boolean = matchesScope(filter) && when (filter.acknowledged) {
        true -> currentAck
        false -> !currentAck && (filter.includeAll || shown.isNotEmpty())
        null -> filter.includeAll || open
    }
}

/** Warnings first, then work stream, program, project, level (program, project, milestone), name, binding id. */
internal val CANDIDATE_ORDER: Comparator<Candidate> = compareBy<Candidate>(
    { c -> if (c.shown.any { it.severity == DeviationSeverity.WARNING }) 0 else 1 },
    { it.node.workStreamName.lowercase() },
    { it.node.programName.orEmpty().lowercase() },
    { it.node.projectName.orEmpty().lowercase() },
    { it.node.ref.level },
    { it.node.name.lowercase() },
    { it.bindingId },
)

/**
 * Everything one computation reads, so the per-binding step is a method with a short signature. [boundTo] is the plan node each
 * binding's issue is bound to, per connection ([loadBoundTo]); [actor] null = an anonymous computation (`can.acknowledge` false);
 * [creators] names the logins that acknowledged.
 */
internal class World(
    val connections: Map<UInt, ConnectionFacts>,
    val nodes: Map<PlanRef, NodeRow>,
    val spans: Map<PlanRef, DaySpan>,
    private val boundTo: Map<Pair<UInt, String>, PlanRef>,
    private val coverage: Coverage,
    val calendar: WorkingCalendar,
    val asOf: LocalDate,
    private val actor: PlanActor?,
    private val creators: Map<UInt, BaselineCreator>,
) {
    fun candidate(row: BindingRow, listNotComparable: Boolean): Candidate? {
        val connection = connections[row.connectionId] ?: return null
        val node = nodes[row.ref] ?: return null
        val span = spans[row.ref]
        val plan = planSide(node, span, connection.levels?.keys)
        val stored = row.observation
        val parentIssueId = stored?.issue?.parentIssueId
        // A gone issue raises GONE alone and its children are stale with it: no roll-up beside it.
        val rollup = coverage.rollups[row.id]?.takeUnless { stored?.issue?.gone == true }
        val all = JiraDeviationKernels.deviations(
            level = row.ref.level,
            issue = stored?.issue,
            plan = plan,
            mapping = connection.levels?.get(row.ref.level),
            parentBoundTo = parentIssueId?.let { boundTo[row.connectionId to it] },
            calendar = calendar,
            asOf = asOf,
            rollup = rollup,
            unlinked = coverage.unlinked[row.id],
        )
        val shown = if (listNotComparable) all else all.filter { it.kind != DeviationKind.ESTIMATE_NOT_COMPARABLE }
        val fingerprint = fingerprintOf(all)
        val ack = row.ack?.let { DeviationAcknowledgement(it.at, it.byUserId?.let(creators::get)?.name, it.fingerprint == fingerprint) }
        val item = DeviationItem(
            bindingId = row.id,
            connectionId = row.connectionId,
            level = row.ref.level,
            node = node.toWire(),
            jira = row.toJira(connection.siteUrl, rollup),
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
            fingerprint = fingerprint,
            acknowledgement = ack,
            can = DeviationCan(
                acknowledge = actor?.let { PlanPermissions.canAcknowledgeDeviations(it, node.chain, node.teamId) } == true,
            ),
        )
        return Candidate(item, node, row.id, all, shown, currentAck = ack?.current == true, rollup = rollup)
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

private fun BindingRow.toJira(siteUrl: String, rollup: ChildRollup?): DeviationJira {
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
        rollup = rollup?.toWire(),
    )
}
