package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.FLAG_ORDER
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.PlanProjectFact
import ch.nokillswit.planning.RoadmapKernels
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The pure roadmap arithmetic (no server, no database): table-driven, dates on the 2027 calendar - 2027-02-01 and 2027-03-01 are
 * Mondays, so every `+7` below is exactly one week and 2027-02-01..02-05 / 02-08..02-12 are whole working weeks.
 */
class RoadmapKernelsTest {
    private fun span(start: String, end: String) = DaySpan(LocalDate.parse(start), LocalDate.parse(end))

    private fun ms(id: UInt, project: UInt, team: UInt, start: String?, end: String? = start) =
        PlanMilestoneFact(id, project, team, if (start != null && end != null) span(start, end) else null)

    private fun pj(id: UInt, rank: Int?, target: DaySpan? = null) = PlanProjectFact(id, rank, target)

    private fun inversion(severity: FlagSeverity, days: Int, teamId: UInt?, other: UInt) =
        PlanFlag(FlagKind.RANK_INVERSION, severity, days, teamId, other)

    private fun warning(days: Int, teamId: UInt, other: UInt) = inversion(FlagSeverity.WARNING, days, teamId, other)

    private fun info(days: Int, other: UInt) = inversion(FlagSeverity.INFO, days, null, other)

    // ---------------------------------------------------------------------------------------------------------------- spans

    @Test
    fun `a project's span runs from its earliest start to its latest end over scheduled milestones only`() {
        val spans = RoadmapKernels.projectSpans(
            listOf(
                ms(1u, 1u, 1u, "2027-03-08", "2027-03-12"),
                ms(2u, 1u, 2u, "2027-03-01", "2027-03-05"),
                ms(3u, 1u, 1u, null),
                ms(4u, 2u, 1u, null),
                ms(5u, 3u, 1u, "2027-04-05", "2027-04-09"),
            ),
        )
        assertEquals(mapOf(1u to span("2027-03-01", "2027-03-12"), 3u to span("2027-04-05", "2027-04-09")), spans)
        assertNull(spans[2u], "a project with nothing scheduled has no span")
    }

    // ---------------------------------------------------------------------------------------------------------------- drift

    private class DriftCase(val label: String, val span: DaySpan?, val target: DaySpan?, val flags: List<PlanFlag>)

    private val window = span("2027-03-01", "2027-03-31")

    private fun endLate(days: Int) = PlanFlag(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, days, null, null)

    private fun startLate(days: Int) = PlanFlag(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, days, null, null)

    private fun endEarly(days: Int) = PlanFlag(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, days, null, null)

    private fun drift(kind: FlagKind, severity: FlagSeverity, days: Int) = PlanFlag(kind, severity, days, null, null)

    @Test
    fun `drift flags - a late end warns, a late start or an early finish informs, an early start and the target raise nothing`() {
        val cases = listOf(
            DriftCase("late end", span("2027-03-01", "2027-04-07"), window, listOf(endLate(7))),
            DriftCase("late start", span("2027-03-08", "2027-03-31"), window, listOf(startLate(7))),
            DriftCase("early end", span("2027-03-01", "2027-03-26"), window, listOf(drift(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, 5))),
            DriftCase("early start", span("2027-02-22", "2027-03-31"), window, emptyList()),
            DriftCase("on target", window, window, emptyList()),
            DriftCase(
                "late start and late end",
                span("2027-03-08", "2027-04-07"),
                window,
                listOf(drift(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, 7), drift(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, 7)),
            ),
            DriftCase(
                "late start and early end",
                span("2027-03-08", "2027-03-26"),
                window,
                listOf(drift(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, 7), drift(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, 5)),
            ),
            DriftCase("early start and early end", span("2027-02-22", "2027-03-26"), window, listOf(endEarly(5))),
            DriftCase("no window", span("2027-03-01", "2027-04-07"), null, emptyList()),
            DriftCase("no span", null, window, emptyList()),
            DriftCase("neither", null, null, emptyList()),
        )
        for (case in cases) assertEquals(case.flags, RoadmapKernels.driftFlags(case.span, case.target), case.label)
    }

    // ------------------------------------------------------------------------------------------------------------ inversions

    private class InversionCase(
        val label: String,
        val projects: List<PlanProjectFact>,
        val milestones: List<PlanMilestoneFact>,
        val expected: Map<UInt, List<PlanFlag>>,
    )

    private val inversionCases = listOf(
        InversionCase(
            "B starts a week before A on their shared team",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(ms(1u, 1u, 1u, "2027-03-08"), ms(2u, 2u, 1u, "2027-03-01")),
            mapOf(2u to listOf(warning(7, 1u, 1u))),
        ),
        InversionCase(
            "in rank order is no inversion, and neither is a tie",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-01"), ms(2u, 2u, 1u, "2027-03-08"), ms(3u, 3u, 1u, "2027-03-08")),
            emptyMap(),
        ),
        InversionCase(
            "a chain A > B > C all inverted reads as two flags - adjacent pairs only, never C against A",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-15"), ms(2u, 2u, 1u, "2027-03-08"), ms(3u, 3u, 1u, "2027-03-01")),
            mapOf(2u to listOf(warning(7, 1u, 1u)), 3u to listOf(warning(7, 1u, 2u))),
        ),
        InversionCase(
            "a non-adjacent inversion is not flagged: C starts before A but after its immediate predecessor B",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-15"), ms(2u, 2u, 1u, "2027-03-01"), ms(3u, 3u, 1u, "2027-03-08")),
            mapOf(2u to listOf(warning(14, 1u, 1u))),
        ),
        InversionCase(
            "the project's earliest start on the team counts, and a project on two teams is judged per team",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(
                ms(1u, 1u, 1u, "2027-03-08"),
                ms(2u, 1u, 2u, "2027-03-01"),
                ms(3u, 2u, 1u, "2027-03-15"),
                ms(4u, 2u, 1u, "2027-03-01"),
                ms(5u, 2u, 2u, "2027-03-08"),
            ),
            mapOf(2u to listOf(warning(7, 1u, 1u))),
        ),
        InversionCase(
            "a project inverted on two teams carries one flag per (pair, team)",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(
                ms(1u, 1u, 1u, "2027-03-08"),
                ms(2u, 1u, 2u, "2027-03-15"),
                ms(3u, 2u, 1u, "2027-03-01"),
                ms(4u, 2u, 2u, "2027-03-01"),
            ),
            mapOf(2u to listOf(warning(7, 1u, 1u), warning(14, 2u, 1u))),
        ),
        InversionCase(
            "unranked projects neither carry flags nor sit between ranked ones",
            listOf(pj(1u, 1), pj(2u, null), pj(3u, 2)),
            listOf(ms(1u, 1u, 1u, "2027-03-08"), ms(2u, 2u, 1u, "2027-03-01"), ms(3u, 3u, 1u, "2027-03-15")),
            emptyMap(),
        ),
        InversionCase(
            "unscheduled milestones are ignored - the unscheduled project is not on the team's list",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(ms(1u, 1u, 1u, null), ms(2u, 2u, 1u, "2027-03-01")),
            emptyMap(),
        ),
        InversionCase(
            "adjacency is per team (a project without work on the team does not separate the pair) and the INFO is judged overall",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-08"), ms(2u, 2u, 2u, "2027-04-05"), ms(3u, 3u, 1u, "2027-03-01")),
            // Team 1: P3 against P1 (7 days). Overall: P3 shares no team with its rank neighbour P2 and starts 35 days before it.
            mapOf(3u to listOf(warning(7, 1u, 1u), info(35, 2u))),
        ),
        InversionCase(
            "no shared team: the adjacent pair is an INFO when B's span starts first",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(ms(1u, 1u, 1u, "2027-03-08", "2027-03-12"), ms(2u, 2u, 2u, "2027-03-01", "2027-03-05")),
            mapOf(2u to listOf(info(7, 1u))),
        ),
        InversionCase(
            "no shared team: B later than A, or a tie, is no INFO",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-01"), ms(2u, 2u, 2u, "2027-03-08"), ms(3u, 3u, 3u, "2027-03-08")),
            emptyMap(),
        ),
        InversionCase(
            "the INFO pairs are adjacent among the ranked projects that have a span",
            listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3)),
            listOf(ms(1u, 1u, 1u, "2027-03-08"), ms(2u, 2u, 2u, null), ms(3u, 3u, 3u, "2027-03-01")),
            mapOf(3u to listOf(info(7, 1u))),
        ),
        InversionCase(
            "a shared team rules the INFO out even when B's whole span starts first through another team",
            listOf(pj(1u, 1), pj(2u, 2)),
            listOf(ms(1u, 1u, 1u, "2027-03-08"), ms(2u, 2u, 1u, "2027-03-15"), ms(3u, 2u, 2u, "2027-03-01")),
            emptyMap(),
        ),
    )

    @Test
    fun `rank inversion flags follow the adjacent-pairs-per-team rule`() {
        for (case in inversionCases) {
            val flags = RoadmapKernels.inversionFlags(case.projects, case.milestones)
            assertEquals(case.expected, flags.filterValues { it.isNotEmpty() }.mapValues { (_, v) -> v.sortedWith(FLAG_ORDER) }, case.label)
        }
    }

    @Test
    fun `flags sort WARNING first, then by kind, team and other project`() {
        val flags = listOf(
            info(3, 9u),
            drift(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, 2),
            warning(5, 2u, 4u),
            drift(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, 1),
            warning(6, 1u, 7u),
            warning(4, 2u, 3u),
        )
        assertEquals(
            listOf(
                drift(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, 1),
                warning(6, 1u, 7u),
                warning(4, 2u, 3u),
                warning(5, 2u, 4u),
                drift(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, 2),
                info(3, 9u),
            ),
            flags.sortedWith(FLAG_ORDER),
        )
    }

    // ---------------------------------------------------------------------------------------------------------------- links

    private fun milestoneEnd(id: UInt) = EndpointRef(EndpointKind.MILESTONE, id)

    private fun projectEnd(id: UInt) = EndpointRef(EndpointKind.PROJECT, id)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType = DependencyType.FS) =
        PlanLinkFact(id, pred, succ, type, 0)

    // P1: m1 02-01..02-05 (+ m6 unscheduled) -> span 02-01..02-05; P2: m2 02-08..02-12, m3 unscheduled -> 02-08..02-12;
    // P3: nothing scheduled.
    private val projects = listOf(pj(1u, 1), pj(2u, 2), pj(3u, 3))
    private val milestones = listOf(
        ms(1u, 1u, 1u, "2027-02-01", "2027-02-05"),
        ms(2u, 2u, 1u, "2027-02-08", "2027-02-12"),
        ms(3u, 2u, 1u, null),
        ms(4u, 3u, 1u, null),
        ms(6u, 1u, 1u, null),
    )
    private val spans = RoadmapKernels.projectSpans(milestones)

    private fun aggregate(vararg links: PlanLinkFact) =
        RoadmapKernels.linkAggregates(links.toList(), projects, milestones, spans, WorkingCalendar.MON_FRI)

    @Test
    fun `a project-to-project link is the pair's direct entry, checked on the derived spans`() {
        val ok = aggregate(link(10u, projectEnd(1u), projectEnd(2u))).single()
        assertEquals(1u to 2u, ok.predecessorProjectId to ok.successorProjectId)
        val direct = checkNotNull(ok.direct)
        assertEquals(10u, direct.id)
        assertEquals(DependencyType.FS, direct.type)
        assertEquals(DependencyStatus.OK, direct.check.status)
        assertEquals(0, ok.milestoneLinks.count)

        val violated = checkNotNull(aggregate(link(11u, projectEnd(2u), projectEnd(1u))).single().direct)
        assertEquals(DependencyStatus.VIOLATED, violated.check.status)
        assertEquals(10, violated.check.shortfallDays)

        val unscheduled = checkNotNull(aggregate(link(12u, projectEnd(1u), projectEnd(3u))).single().direct)
        assertEquals(DependencyStatus.UNSCHEDULED, unscheduled.check.status, "a project with nothing scheduled has no span")
    }

    @Test
    fun `milestone links roll up per ordered pair - milestone to milestone, milestone to project, both directions`() {
        val links = aggregate(
            link(20u, milestoneEnd(1u), milestoneEnd(2u)),
            link(21u, milestoneEnd(1u), projectEnd(2u)),
            link(22u, projectEnd(1u), milestoneEnd(2u)),
            link(23u, milestoneEnd(1u), milestoneEnd(3u)),
            link(24u, projectEnd(1u), projectEnd(2u)),
            link(25u, milestoneEnd(2u), milestoneEnd(1u)),
        )
        assertEquals(listOf(1u to 2u, 2u to 1u), links.map { it.predecessorProjectId to it.successorProjectId })
        val forward = links.first()
        assertEquals(24u, forward.direct?.id, "the project-to-project link is direct, not counted in the bundle")
        assertEquals(4, forward.milestoneLinks.count)
        assertEquals(0, forward.milestoneLinks.violated)
        assertEquals(1, forward.milestoneLinks.unscheduled, "the link to the unscheduled milestone m3")
        val backward = links.last()
        assertNull(backward.direct)
        assertEquals(1, backward.milestoneLinks.count)
        assertEquals(1, backward.milestoneLinks.violated)
        assertEquals(0, backward.milestoneLinks.unscheduled)
    }

    @Test
    fun `links inside one project, or with an end outside the plan, are skipped and the pairs are ordered`() {
        val links = aggregate(
            link(30u, milestoneEnd(2u), milestoneEnd(3u)),
            link(31u, milestoneEnd(2u), projectEnd(2u)),
            link(32u, projectEnd(1u), projectEnd(99u)),
            link(33u, milestoneEnd(99u), milestoneEnd(1u)),
            link(34u, projectEnd(3u), projectEnd(1u)),
            link(35u, projectEnd(2u), projectEnd(3u)),
            link(36u, projectEnd(1u), projectEnd(2u)),
        )
        assertEquals(listOf(1u to 2u, 2u to 3u, 3u to 1u), links.map { it.predecessorProjectId to it.successorProjectId })
    }

    // ---------------------------------------------------------------------------------------------------------------- counts

    @Test
    fun `the roll-up counts warnings and infos`() {
        assertEquals(FlagCounts(0, 0), RoadmapKernels.flagCounts(emptyList()))
        val flags = listOf(warning(7, 1u, 1u), info(3, 2u), endLate(2), info(1, 3u), info(2, 4u))
        assertEquals(FlagCounts(2, 3), RoadmapKernels.flagCounts(flags))
    }
}
