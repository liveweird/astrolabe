package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.math.BigDecimal
import java.time.LocalDate

/*
 * The auto-proposal's scheduling kernel (v0.8.0; `planning-model.md` "The auto-proposal"): pure functions, no I/O, no clock, no
 * randomness - the calendar, the clock date and every row are parameters. The service (C2) loads one snapshot and calls [propose] and
 * [postCheck]; nothing here moves a date.
 *
 * "Never exceeds capacity" is checked on two levels (see [ScheduleLedger]): every day (`used + rate <= dailyCap`) and every ISO week a
 * candidate touches (`weekUsed + rate * days <= weekCap`, exact, over ALL the week's working days). Fixed load that overbooks a day, or
 * sits on a day without capacity, is what makes the second level necessary: the daily test alone would let such a week overflow.
 */

/** One of the team's milestones as the scheduler sees it: [span] null = unscheduled; [key] is its place in the team's effective order. */
data class TeamScheduleItem(val id: UInt, val projectId: UInt, val span: DaySpan?, val estimateMd: BigDecimal, val key: OrderKey)

/**
 * Everything a run reads. [asOf] is the viewer's calendar day: a team milestone is MOVABLE when unscheduled or when its start is after
 * it, FIXED (in progress or past) otherwise. [team] holds ALL of the team's active milestones, [plan] every active milestone of the plan
 * (the other teams' are fixed constraints) and [links] every active link. [horizonWeeks] counts from the team's first usable day.
 */
data class ScheduleInputs(
    val asOf: LocalDate,
    val teamId: UInt,
    val team: List<TeamScheduleItem>,
    val periods: List<CapacityPeriod>,
    val plan: Collection<PlanMilestoneFact>,
    val links: Collection<PlanLinkFact>,
    val calendar: WorkingCalendar,
    val horizonWeeks: Int = MAX_LOAD_WEEKS,
)

/** A movable milestone's proposed span [to] and the span it has now ([from], null = unscheduled); `to == from` = it stays. */
data class Placement(val milestoneId: UInt, val from: DaySpan?, val to: DaySpan)

/** Why a movable milestone got no span: no usable day at or after its earliest start, or no span that fits before the horizon. */
enum class UnplacedReason { NO_CAPACITY, NO_ROOM }

data class Unplaced(val milestoneId: UInt, val reason: UnplacedReason)

/**
 * What a run answers. [placements] and [unplaced] hold every MOVABLE milestone, in the team's effective order (not the placement
 * order). [spansAfter] is the team's milestones' spans after the run (fixed + placed; an unplaced one is absent), the post-check's input.
 */
data class ScheduleProposalResult(
    val placements: List<Placement>,
    val unplaced: List<Unplaced>,
    val spansAfter: Map<UInt, DaySpan>,
)

/** One link's status on the stored spans ([before]) beside its full check on the spans after the run ([after]). */
data class ScheduleLinkCheck(val linkId: UInt, val before: DependencyStatus, val after: DependencyCheck)

/** The post-check: the team's weekly load as it would be after accepting every move, and the affected links, violated-after first. */
data class ScheduleProposalCheck(val weeks: List<WeekLoad>, val weeksTruncated: Boolean, val links: List<ScheduleLinkCheck>)

object ScheduleKernels {
    /**
     * Places the team's movable milestones greedily in the team's effective order (after the milestones they wait for), each on the
     * earliest span that fits per day within capacity and the WIP limit and after its dependencies. See `planning-model.md`.
     */
    fun propose(inputs: ScheduleInputs): ScheduleProposalResult = ProposalRun(inputs).run()

    /**
     * The post-check of a [result]: [ScheduleProposalCheck.weeks] from the view's own [weeklyLoad] over the team's spans after the run,
     * and the links with a milestone end among the team's milestones or a project end whose derived span changed, checked before and
     * after.
     */
    fun postCheck(inputs: ScheduleInputs, result: ScheduleProposalResult): ScheduleProposalCheck {
        val calendar = inputs.calendar
        val items = inputs.team.mapNotNull { item -> result.spansAfter[item.id]?.let { LoadItem(it, item.estimateMd) } }
        val window = loadWindow(items.map { it.span })
        val weeks = weeklyLoad(items, inputs.periods.sortedBy { it.effectiveFrom }, window?.span, calendar)
        return ScheduleProposalCheck(weeks, window?.truncated ?: false, linkChecks(inputs, result.spansAfter))
    }

    private fun linkChecks(inputs: ScheduleInputs, spansAfter: Map<UInt, DaySpan>): List<ScheduleLinkCheck> {
        val teamIds = inputs.team.map { it.id }.toSet()
        val before = PlanValues()
        val after = PlanValues()
        for (fact in inputs.plan.sortedBy { it.id }) {
            val span = fact.span
            if (fact.teamId != inputs.teamId && span != null) {
                before.put(fact.id, fact.projectId, span)
                after.put(fact.id, fact.projectId, span)
            }
        }
        for (item in inputs.team) {
            item.span?.let { before.put(item.id, item.projectId, it) }
            spansAfter[item.id]?.let { after.put(item.id, item.projectId, it) }
        }
        val checks = inputs.links.sortedBy { it.id }.filter { link ->
            listOf(link.predecessor, link.successor).any { end ->
                if (end.kind == EndpointKind.MILESTONE) end.id in teamIds else before.spanOf(end) != after.spanOf(end)
            }
        }.map { link ->
            val statusBefore = DependencyKernels.check(
                link.type, link.lagDays, before.spanOf(link.predecessor), before.spanOf(link.successor), inputs.calendar,
            ).status
            val checkAfter = DependencyKernels.check(
                link.type, link.lagDays, after.spanOf(link.predecessor), after.spanOf(link.successor), inputs.calendar,
            )
            ScheduleLinkCheck(link.id, statusBefore, checkAfter)
        }
        return checks.sortedBy { if (it.after.status == DependencyStatus.VIOLATED) 0 else 1 }
    }
}

/**
 * One run of [ScheduleKernels.propose]: the sorted inputs and the FIXPOINT around [Pass]. A scheduled movable milestone that ends up
 * unplaced keeps its stored dates when the proposal is accepted, so its load is real: it is PINNED (treated as fixed at its stored
 * dates, which also feed link values) and the pass repeats, until no further one fails. The pinned set only grows, so there are at
 * most `|movable| + 1` passes. An unscheduled milestone that stays unplaced needs nothing.
 */
private class ProposalRun(private val inputs: ScheduleInputs) {
    private val team = effectiveOrder(inputs.team) { it.key }

    fun run(): ScheduleProposalResult {
        requireAcyclicPlan(containment(), inputs.links.sortedBy { it.id })
        val pinned = HashSet<UInt>()
        val reasons = HashMap<UInt, UnplacedReason>()
        while (true) {
            val pass = Pass(inputs, team, pinned).apply { execute() }
            reasons.putAll(pass.unplaced)
            val failed = team.filter { it.id in pass.unplaced && it.span != null && it.id !in pinned }.map { it.id }
            if (failed.isEmpty()) return pass.result(reasons)
            pinned.addAll(failed)
        }
    }

    /** Every milestone's containment: the plan's and the team's (a team row missing from the plan facts still counts). */
    private fun containment(): List<ContainmentLink> {
        val projectOf = LinkedHashMap<UInt, UInt>()
        inputs.plan.sortedBy { it.id }.forEach { projectOf[it.id] = it.projectId }
        team.forEach { projectOf[it.id] = it.projectId }
        return projectOf.map { (milestone, project) -> ContainmentLink(milestone, project) }
    }
}

/** One placement pass: the shared record of dates, the ledger and the outcome per movable milestone, given the [pinned] ones. */
private class Pass(private val inputs: ScheduleInputs, private val team: List<TeamScheduleItem>, private val pinned: Set<UInt>) {
    private val calendar = inputs.calendar
    private val periods = inputs.periods.sortedBy { it.effectiveFrom }
    private val links = inputs.links.sortedBy { it.id }
    private val values = PlanValues()
    private val placed = HashMap<UInt, Placement>()
    val unplaced = HashMap<UInt, UnplacedReason>()

    /** Fixed = started on or before `asOf`, or pinned by an earlier pass (stored dates stand). */
    private fun isFixed(item: TeamScheduleItem) = item.span != null && (item.span.start <= inputs.asOf || item.id in pinned)

    fun execute() {
        val (fixed, movable) = team.partition(::isFixed)
        for (fact in inputs.plan.sortedBy { it.id }) {
            if (fact.teamId != inputs.teamId && fact.span != null) values.put(fact.id, fact.projectId, fact.span)
        }
        fixed.forEach { values.put(it.id, it.projectId, checkNotNull(it.span)) }

        val firstDay = calendar.nextWorkingDayOnOrAfter(inputs.asOf.plusDays(1))
        val firstUsable = usableDayOnOrAfter(firstDay, periods, calendar)
        val ledger = firstUsable?.let { ScheduleLedger(it, periods, calendar, inputs.horizonWeeks) }
        if (ledger != null) fixed.forEach { bookFixed(ledger, it) }

        val constraints = ScheduleConstraints(links, movable, values, calendar)
        for (m in constraints.placementOrder()) {
            val bounds = constraints.bounds(m)
            val earliest = maxOf(calendar.workingDayIndex(firstDay), bounds.startIndex ?: Long.MIN_VALUE)
            val start = usableDayOnOrAfter(calendar.workingDayOfIndex(earliest), periods, calendar)
            if (start == null || ledger == null) {
                unplaced[m.id] = UnplacedReason.NO_CAPACITY
                continue
            }
            val slot = ledger.findSlot(calendar.workingDayIndex(start), m.estimateMd, bounds.endIndex)
            if (slot == null) unplaced[m.id] = UnplacedReason.NO_ROOM else commit(ledger, m, slot)
        }
    }

    /** A fixed (in progress) milestone books its effective working days at the even rate `E / n`, like the team view's spread. */
    private fun bookFixed(ledger: ScheduleLedger, item: TeamScheduleItem) {
        val span = checkNotNull(item.span)
        val first = calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(span.start))
        val last = calendar.workingDayIndex(calendar.previousWorkingDayOnOrBefore(span.end))
        if (last >= first) ledger.add(first, last, exactOf(item.estimateMd).over((last - first + 1).toInt()))
    }

    private fun commit(ledger: ScheduleLedger, m: TeamScheduleItem, slot: Slot) {
        val span = DaySpan(ledger.dateOf(slot.first), ledger.dateOf(slot.last))
        ledger.add(slot.first, slot.last, slot.rate)
        values.put(m.id, m.projectId, span)
        placed[m.id] = Placement(m.id, m.span, span)
    }

    /** The answer in the team's order; [reasons] also holds the pinned milestones, which stay listed as unplaced. */
    fun result(reasons: Map<UInt, UnplacedReason>): ScheduleProposalResult {
        val spansAfter = LinkedHashMap<UInt, DaySpan>()
        for (item in team) {
            val span = placed[item.id]?.to ?: item.span?.takeIf { isFixed(item) }
            if (span != null) spansAfter[item.id] = span
        }
        return ScheduleProposalResult(
            placements = team.mapNotNull { placed[it.id] },
            unplaced = team.mapNotNull { m -> reasons[m.id]?.takeIf { m.id in unplaced || m.id in pinned }?.let { Unplaced(m.id, it) } },
            spansAfter = spansAfter,
        )
    }
}
