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
 * read: the kernels, the fingerprints, each line's acknowledgement state and the caller's `can`. Shared by the view, the acknowledge
 * (one binding, inside its locked transaction) and - from 1.3's C5 - the timeline flag fold.
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
 * The fingerprint of ONE deviation (1.12): the SHA-256 of its canonical JSON (`{kind, severity, detail}`, severity included), what a
 * per-line acknowledgement is stored with and compared against. It never reaches the wire (the client echoes the LIST's).
 */
internal fun fingerprintOf(deviation: Deviation): String = fingerprintOf(Deviation.serializer(), deviation)

/**
 * One kernel deviation with the state of its own acknowledgement (1.12): [acknowledgement] is null until someone acknowledged THIS
 * kind, and its `current` says whether the stored per-line fingerprint still equals the deviation's now. A line is OPEN unless its
 * acknowledgement is current.
 */
internal class LineState(val deviation: Deviation, val acknowledgement: DeviationAcknowledgement?) {
    val current: Boolean get() = acknowledgement?.current == true
    val open: Boolean get() = !current

    fun toWire() = DeviationLine(deviation.kind, deviation.severity, deviation.detail, acknowledgement)
}

/**
 * The item-level `acknowledgement` the old web UI reads (DEPRECATED since 1.12): null while no listed line is stamped, else the newest
 * stamp among them, `current` = every listed line is currently acknowledged.
 */
private fun summaryOf(shown: List<LineState>): DeviationAcknowledgement? {
    val newest = shown.mapNotNull { it.acknowledgement }.maxByOrNull { it.at } ?: return null
    return DeviationAcknowledgement(newest.at, newest.by, current = shown.all { it.current })
}

/**
 * A live binding's computed row. [lines] is the kernel's FULL list with each line's acknowledgement state (what
 * [DeviationItem.fingerprint] hashes); [shown] the part the item LISTS (`ESTIMATE_NOT_COMPARABLE` only on request). A binding is OPEN
 * while at least one listed line is open, i.e. has no CURRENT acknowledgement (1.12: the acknowledgements are per line).
 */
internal class Candidate(
    val item: DeviationItem,
    val node: NodeRow,
    val bindingId: UInt,
    val lines: List<LineState>,
    val shown: List<LineState>,
    /** The epic's census roll-up (milestone bindings; null = none): what the timeline fold carries onto the link. */
    val rollup: ChildRollup?,
) {
    /** The kernel's full list (what [DeviationItem.fingerprint] hashes), without the acknowledgement states. */
    val all: List<Deviation> get() = lines.map { it.deviation }

    val open: Boolean get() = shown.any { it.open }

    /** The wire reason of a gone binding ([wireGoneReason]) says the issue is still in Jira, out of scope: `MOVED_OUT` or `NOT_LISTED`. */
    val stillInJira: Boolean
        get() = all.any { it.kind == DeviationKind.GONE && (it.detail.jira == GONE_MOVED_OUT || it.detail.jira == GONE_NOT_LISTED) }

    /**
     * At least one LISTED line is currently acknowledged: what `acknowledged=true` lists and `totals.acknowledged` counts. Decided on
     * [shown], not on the full list: a hidden `ESTIMATE_NOT_COMPARABLE` stamp does not make a binding whose every visible line is open
     * an "acknowledged" one (it surfaces under `all=true` only).
     */
    val hasCurrentAck: Boolean get() = shown.any { it.current }

    /** Whether the kind and severity chips each match one of [lines] (an unset chip matches). */
    private fun chipsMatch(filter: DeviationFilter, lines: List<LineState>): Boolean =
        (filter.kind == null || lines.any { it.deviation.kind == filter.kind }) &&
            (filter.severity == null || lines.any { it.deviation.severity == filter.severity })

    /** Every filter but the acknowledgement state (the chips read any listed line): what the totals count over. */
    fun matchesScope(filter: DeviationFilter): Boolean =
        (filter.connectionId == null || item.connectionId == filter.connectionId) &&
            (filter.level == null || item.level == filter.level) &&
            (filter.workStreamId == null || node.workStreamId == filter.workStreamId) &&
            (filter.programId == null || node.programId == filter.programId) &&
            (filter.projectId == null || node.projectId == filter.projectId) &&
            (filter.teamId == null || node.teamId == filter.teamId) &&
            chipsMatch(filter, shown)

    /**
     * Whether the binding is listed. By default the OPEN ones; `acknowledged=true` the ones with a CURRENTLY acknowledged line;
     * `acknowledged=false` the open ones (plus clean ones when everything is listed); an [includeAll][DeviationFilter.includeAll]
     * listing without the filter keeps every state. **A kind or severity chip matches the lines of the selected Status** (1.12, D11):
     * the OPEN lines under the default and `acknowledged=false`, the CURRENTLY acknowledged ones under `acknowledged=true`, any listed
     * line under `all` without a status. A listed binding shows EVERY listed line with its own state, whatever the filter.
     */
    fun matches(filter: DeviationFilter): Boolean {
        val statusLines = when {
            filter.acknowledged == true -> shown.filter { it.current }
            filter.acknowledged == false || !filter.includeAll -> shown.filter { it.open }
            else -> shown
        }
        if (!matchesScope(filter) || !chipsMatch(filter, statusLines)) return false
        return when (filter.acknowledged) {
            true -> hasCurrentAck
            false -> open || (filter.includeAll && shown.isEmpty())
            null -> filter.includeAll || open
        }
    }
}

/** An open warning first, then work stream, program, project, level (program, project, milestone), name, binding id. */
internal val CANDIDATE_ORDER: Comparator<Candidate> = compareBy<Candidate>(
    { c -> if (c.shown.any { it.open && it.deviation.severity == DeviationSeverity.WARNING }) 0 else 1 },
    { it.node.workStreamName.lowercase() },
    { it.node.programName.orEmpty().lowercase() },
    { it.node.projectName.orEmpty().lowercase() },
    { it.node.ref.level },
    { it.node.name.lowercase() },
    { it.bindingId },
)

/** The kernels' view of the observation: its stored gone reason refined into the wire one against the connection's CURRENT keys. */
private fun StoredObservation.wireIssue(projectKeys: Collection<String>): ObservedIssue =
    issue.copy(goneReason = wireGoneReason(issue.goneReason, goneProbedAt, goneProbedKey, projectKeys))

/**
 * Everything one computation reads, so the per-binding step is a method with a short signature. [boundTo] is the plan node each
 * binding's issue is bound to, per connection ([loadBoundTo]); [actor] null = an anonymous computation (`can.acknowledge` false);
 * [stored] is the per-line acknowledgements by binding and kind ([JiraAcknowledgeService.Acknowledgements.storedOf]); [creators] names
 * the logins that acknowledged.
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
    private val stored: Map<UInt, Map<DeviationKind, StoredLineAck>>,
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
            issue = stored?.wireIssue(connection.projectKeys),
            plan = plan,
            mapping = connection.levels?.get(row.ref.level),
            parentBoundTo = parentIssueId?.let { boundTo[row.connectionId to it] },
            calendar = calendar,
            asOf = asOf,
            rollup = rollup,
            unlinked = coverage.unlinked[row.id],
        )
        val lines = all.map { lineOf(row.id, it) }
        val shown = if (listNotComparable) lines else lines.filter { it.deviation.kind != DeviationKind.ESTIMATE_NOT_COMPARABLE }
        val fingerprint = fingerprintOf(all)
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
            deviations = shown.map(LineState::toWire),
            fingerprint = fingerprint,
            acknowledgement = summaryOf(shown),
            can = DeviationCan(
                acknowledge = actor?.let { PlanPermissions.canAcknowledgeDeviations(it, node.chain, node.teamId) } == true,
            ),
        )
        return Candidate(item, node, row.id, lines, shown, rollup = rollup)
    }

    /** [deviation] with its stored acknowledgement; the line's fingerprint is hashed only when there is one to compare with. */
    private fun lineOf(bindingId: UInt, deviation: Deviation): LineState {
        val ack = stored[bindingId]?.get(deviation.kind) ?: return LineState(deviation, null)
        val wire = DeviationAcknowledgement(ack.at, creators[ack.byUserId]?.name, ack.fingerprint == fingerprintOf(deviation))
        return LineState(deviation, wire)
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
