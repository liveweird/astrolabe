package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar

/**
 * The comparison view's assembly as a pure function (no I/O, no clock), the [ProgramsTree] idiom: the frozen rows and the live rows
 * go through [BaselineKernels] once per milestone and once per project, and the answer keeps only the milestone rows that CHANGED
 * (every kind but UNCHANGED, or a different estimate - `planning-model.md` "Baselines") while the totals and each project's counts
 * cover every row.
 */
internal object BaselineComparison {
    /** One milestone on either or both sides, with its movement and the project it belongs to (the live one when it exists). */
    private class Row(val frozen: FrozenMilestoneRow?, val live: MilestoneCapture?, val movement: Movement) {
        val projectId: UInt = checkNotNull(live?.projectId ?: frozen?.projectId)
        val span: DaySpan? get() = live?.span ?: frozen?.span
    }

    fun assemble(
        revision: Long,
        baseline: BaselineResponse,
        frozenProjects: List<FrozenProjectRow>,
        liveProjects: List<RoadmapProject>,
        liveSpans: Map<UInt, DaySpan>,
        frozenMilestones: List<FrozenMilestoneRow>,
        liveMilestones: List<MilestoneCapture>,
        teamNames: Map<UInt, String>,
        calendar: WorkingCalendar,
    ): BaselineView {
        val rows = milestoneRows(frozenMilestones, liveMilestones, calendar)
        val rowsByProject = rows.groupBy { it.projectId }
        val frozenById = frozenProjects.associateBy { it.id }
        val liveById = liveProjects.associateBy { it.id }
        val built = (frozenById.keys + liveById.keys).map { id ->
            projectRow(id, frozenById[id], liveById[id], liveSpans[id], rowsByProject[id].orEmpty(), calendar)
        }.sortedWith(
            compareBy(
                { it.first.workStreamName.lowercase() }, { it.first.programName.lowercase() },
                { it.first.name.lowercase() }, { it.first.projectId },
            ),
        )
        val projects = built.map { it.first }
        val position = projects.withIndex().associate { (index, p) -> p.projectId to index }
        val changed = rows.filter { it.movement.kind != MovementKind.UNCHANGED || estimateChanged(it.movement.estimateDelta) }
            .sortedWith(
                compareBy<Row>(
                    { position.getValue(it.projectId) }, { it.span == null }, { it.span?.start }, { it.span?.end },
                    { (it.live?.name ?: it.frozen?.name).orEmpty().lowercase() }, { it.live?.id ?: it.frozen?.id },
                ),
            )
        return BaselineView(
            revision = revision,
            baseline = baseline,
            totals = BaselineViewTotals(
                milestones = BaselineKernels.totals(rows.map { it.movement }).toView(),
                projects = BaselineKernels.totals(built.map { it.second }).toView(),
            ),
            projects = projects,
            milestones = changed.map { it.toView(teamNames) },
        )
    }

    private fun milestoneRows(
        frozen: List<FrozenMilestoneRow>,
        live: List<MilestoneCapture>,
        calendar: WorkingCalendar,
    ): List<Row> {
        val frozenById = frozen.associateBy { it.id }
        val liveById = live.associateBy { it.id }
        return (frozenById.keys + liveById.keys).map { id ->
            val then = frozenById[id]
            val now = liveById[id]
            val movement = BaselineKernels.milestoneMovement(
                then?.toKernel(),
                now?.let { LiveMilestone(it.id, it.projectId, it.teamId, it.name, it.estimateMd, it.span) },
                calendar,
            )
            Row(then, now, movement)
        }
    }

    private fun projectRow(
        id: UInt,
        then: FrozenProjectRow?,
        now: RoadmapProject?,
        liveSpan: DaySpan?,
        rows: List<Row>,
        calendar: WorkingCalendar,
    ): Pair<BaselineViewProject, Movement> {
        val movement = when {
            then == null -> Movement(MovementKind.ADDED, null, null, null)
            now == null -> Movement(MovementKind.REMOVED, null, null, null)
            else -> BaselineKernels.spanMovement(then.span, liveSpan, calendar)
        }
        val view = BaselineViewProject(
            projectId = id,
            name = (now?.name ?: then?.name).orEmpty(),
            programName = (now?.programName ?: then?.programName).orEmpty(),
            workStreamName = (now?.workStreamName ?: then?.workStreamName).orEmpty(),
            rankThen = then?.rankPosition,
            rankNow = now?.rankPosition,
            baselineSpan = then?.span?.toDateSpan(),
            span = liveSpan?.toDateSpan(),
            movement = movement.toView(),
            counts = BaselineKernels.totals(rows.map { it.movement }).toView(),
        )
        return view to movement
    }

    private fun Row.toView(teamNames: Map<UInt, String>): BaselineViewMilestone {
        val teamId = checkNotNull(live?.teamId ?: frozen?.teamId)
        return BaselineViewMilestone(
            milestoneId = checkNotNull(live?.id ?: frozen?.id),
            name = checkNotNull(live?.name ?: frozen?.name),
            projectId = projectId,
            teamId = teamId,
            teamName = teamNames.getValue(teamId),
            frozen = frozen?.let { BaselineFigures(it.span?.start?.toString(), it.span?.end?.toString(), it.estimateMd.toDouble()) },
            live = live?.let { BaselineFigures(it.span?.start?.toString(), it.span?.end?.toString(), it.estimateMd.toDouble()) },
            movement = movement.toView(),
        )
    }
}
