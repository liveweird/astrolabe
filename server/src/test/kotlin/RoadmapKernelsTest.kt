package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CheckedLink
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.FLAG_ORDER
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.FlaggedRange
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.PlanProjectFact
import ch.nokillswit.planning.RoadmapKernels
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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

    // The checked links (1.18): what the roll-up folds, kept per link.
    private fun checked(vararg links: PlanLinkFact): List<CheckedLink> =
        RoadmapKernels.checkedLinks(links.toList(), projects, milestones, spans, WorkingCalendar.MON_FRI)

    @Test
    fun `a link inside one project is listed with its check, which the roll-up then skips`() {
        val inside = checked(link(40u, milestoneEnd(1u), milestoneEnd(6u))).single()
        assertEquals(1u to 1u, inside.predecessorProjectId to inside.successorProjectId)
        assertEquals(DependencyStatus.UNSCHEDULED, inside.check.status, "m6 is unscheduled")
        assertTrue(RoadmapKernels.aggregate(listOf(inside)).isEmpty())
        val violated = checked(link(41u, milestoneEnd(2u), milestoneEnd(2u))).single()
        assertEquals(DependencyStatus.VIOLATED, violated.check.status, "an end cannot follow itself")
    }

    @Test
    fun `an end that resolves to no known project drops the link, the others keep the input order`() {
        val all = checked(
            link(50u, projectEnd(1u), projectEnd(99u)),
            link(51u, milestoneEnd(99u), milestoneEnd(1u)),
            link(52u, projectEnd(2u), projectEnd(1u)),
            link(53u, milestoneEnd(1u), milestoneEnd(2u)),
        )
        assertEquals(listOf(52u, 53u), all.map { it.link.id })
        assertEquals(listOf(2u to 1u, 1u to 2u), all.map { it.predecessorProjectId to it.successorProjectId })
    }

    @Test
    fun `a project end takes the project's derived span and an unscheduled end reads UNSCHEDULED`() {
        // P1 02-01..02-05 -> P2 02-08..02-12 is fine on the derived spans; the same link read on a milestone of P1 is the same days.
        assertEquals(DependencyStatus.OK, checked(link(60u, projectEnd(1u), projectEnd(2u))).single().check.status)
        assertEquals(DependencyStatus.OK, checked(link(61u, milestoneEnd(1u), projectEnd(2u))).single().check.status)
        assertEquals(DependencyStatus.VIOLATED, checked(link(62u, projectEnd(2u), projectEnd(1u))).single().check.status)
        assertEquals(DependencyStatus.UNSCHEDULED, checked(link(63u, projectEnd(1u), projectEnd(3u))).single().check.status)
        assertEquals(DependencyStatus.UNSCHEDULED, checked(link(64u, milestoneEnd(1u), milestoneEnd(3u))).single().check.status)
    }

    @Test
    fun `links inside one project and links outside the plan, mixed in anywhere, leave the roll-up unchanged`() {
        val links = arrayOf(
            link(70u, milestoneEnd(1u), milestoneEnd(2u)),
            link(71u, milestoneEnd(1u), projectEnd(2u)),
            link(72u, projectEnd(1u), milestoneEnd(2u)),
            link(73u, milestoneEnd(1u), milestoneEnd(3u)),
            link(74u, projectEnd(1u), projectEnd(2u)),
            link(75u, milestoneEnd(2u), milestoneEnd(1u)),
            link(76u, milestoneEnd(2u), milestoneEnd(3u)),
            link(77u, projectEnd(1u), projectEnd(99u)),
            link(78u, projectEnd(3u), projectEnd(1u)),
        )
        val noise = arrayOf(
            link(80u, milestoneEnd(1u), milestoneEnd(6u)),
            link(81u, milestoneEnd(2u), milestoneEnd(2u)),
            link(82u, milestoneEnd(99u), milestoneEnd(1u)),
        )
        val crossOnly = RoadmapKernels.aggregate(checked(*links))
        assertTrue(crossOnly.isNotEmpty())
        // The noise interleaved at the front, the middle and the end: the fold over the kept checks reads the same.
        val mixed = arrayOf(noise[0], *links.copyOfRange(0, 4), noise[1], *links.copyOfRange(4, links.size), noise[2])
        assertEquals(crossOnly, RoadmapKernels.aggregate(checked(*mixed)))
        // Every in-plan link is kept with its check; the two with an end outside the plan (77, 82) are dropped.
        assertEquals(mixed.size - 2, checked(*mixed).size)
    }

    // ---------------------------------------------------------------------------------------------------------------- capacity flags

    private fun range(start: String, end: String, severity: FlagSeverity) =
        FlaggedRange(LocalDate.parse(start), LocalDate.parse(end), severity)

    private fun capacity(teamId: UInt, severity: FlagSeverity, count: Int) =
        PlanFlag(FlagKind.FLOW_CAPACITY_MILESTONES, severity, teamId = teamId, count = count)

    private val sprint = range("2027-03-08", "2027-03-19", FlagSeverity.WARNING)

    @Test
    fun `a milestone inside a range raises ONE flag with its team and count 1, a project it is not on gets none`() {
        val flags = RoadmapKernels.capacityFlags(
            listOf(ms(1u, 10u, 5u, "2027-03-10", "2027-03-12"), ms(2u, 11u, 6u, "2027-03-10", "2027-03-12")),
            mapOf(5u to listOf(sprint)),
        )
        assertEquals(mapOf(10u to listOf(capacity(5u, FlagSeverity.WARNING, 1))), flags)
        val flag = flags.getValue(10u).single()
        assertEquals(listOf(null, null, null), listOf(flag.days, flag.otherProjectId, flag.deviation), "only team and count are set")
    }

    @Test
    fun `touching the range by a single day at either end counts, one day outside does not (both ends inclusive)`() {
        val ranges = mapOf(5u to listOf(sprint))
        fun hits(start: String, end: String) =
            RoadmapKernels.capacityFlags(listOf(ms(1u, 10u, 5u, start, end)), ranges).containsKey(10u)
        assertTrue(hits("2027-03-01", "2027-03-08"), "ends on the range's first day")
        assertTrue(hits("2027-03-19", "2027-03-26"), "starts on the range's last day")
        assertTrue(hits("2027-03-01", "2027-03-26"), "wraps the range")
        assertTrue(hits("2027-03-08", "2027-03-08"), "a one-day milestone on the first day")
        assertEquals(false, hits("2027-03-01", "2027-03-07"), "ends the day before")
        assertEquals(false, hits("2027-03-20", "2027-03-26"), "starts the day after")
    }

    @Test
    fun `an unscheduled milestone raises nothing`() {
        assertEquals(emptyMap(), RoadmapKernels.capacityFlags(listOf(ms(1u, 10u, 5u, null)), mapOf(5u to listOf(sprint))))
    }

    @Test
    fun `two milestones of one project on one team make count 2, in a range of another team they make none`() {
        val milestones = listOf(
            ms(1u, 10u, 5u, "2027-03-08", "2027-03-09"),
            ms(2u, 10u, 5u, "2027-03-15", "2027-03-16"),
            ms(3u, 10u, 5u, "2027-04-05", "2027-04-06"),
            ms(4u, 10u, 6u, "2027-03-08", "2027-03-09"),
        )
        assertEquals(
            mapOf(10u to listOf(capacity(5u, FlagSeverity.WARNING, 2))),
            RoadmapKernels.capacityFlags(milestones, mapOf(5u to listOf(sprint))),
            "the third lies outside, the fourth is on a team that has no range",
        )
    }

    @Test
    fun `two teams make two flags in team order, each with its own count and worst severity`() {
        val milestones = listOf(
            ms(1u, 10u, 9u, "2027-03-08", "2027-03-09"),
            ms(2u, 10u, 5u, "2027-03-08", "2027-03-09"),
            ms(3u, 10u, 5u, "2027-03-22", "2027-03-23"),
        )
        val ranges = mapOf(
            9u to listOf(sprint),
            5u to listOf(range("2027-03-22", "2027-03-26", FlagSeverity.INFO)),
        )
        assertEquals(
            mapOf(10u to listOf(capacity(5u, FlagSeverity.INFO, 1), capacity(9u, FlagSeverity.WARNING, 1))),
            RoadmapKernels.capacityFlags(milestones, ranges),
        )
    }

    @Test
    fun `the severity is the worst among the ranges any of the milestones meets`() {
        val ranges = mapOf(5u to listOf(range("2027-03-01", "2027-03-05", FlagSeverity.INFO), sprint))
        val one = RoadmapKernels.capacityFlags(listOf(ms(1u, 10u, 5u, "2027-03-01", "2027-03-12")), ranges)
        assertEquals(FlagSeverity.WARNING, one.getValue(10u).single().severity, "one milestone meets both: the worst")
        val two = RoadmapKernels.capacityFlags(
            listOf(ms(1u, 10u, 5u, "2027-03-02", "2027-03-03"), ms(2u, 10u, 5u, "2027-03-10", "2027-03-11")),
            ranges,
        )
        assertEquals(capacity(5u, FlagSeverity.WARNING, 2), two.getValue(10u).single(), "two milestones, one INFO and one WARNING")
        val onlyInfo = RoadmapKernels.capacityFlags(listOf(ms(1u, 10u, 5u, "2027-03-02", "2027-03-03")), ranges)
        assertEquals(capacity(5u, FlagSeverity.INFO, 1), onlyInfo.getValue(10u).single())
    }

    @Test
    fun `no ranges at all, or only empty ones, answer an empty map`() {
        val milestones = listOf(ms(1u, 10u, 5u, "2027-03-08", "2027-03-09"))
        assertEquals(emptyMap(), RoadmapKernels.capacityFlags(milestones, emptyMap()))
        assertEquals(emptyMap(), RoadmapKernels.capacityFlags(milestones, mapOf(5u to emptyList())))
        assertEquals(emptyMap(), RoadmapKernels.capacityFlags(emptyList(), mapOf(5u to listOf(sprint))))
    }

    @Test
    fun `the new kind sorts after every other kind of its severity and by team`() {
        val flags = listOf(capacity(9u, FlagSeverity.WARNING, 1), capacity(5u, FlagSeverity.WARNING, 1), endLate(2), info(3, 2u))
            .sortedWith(FLAG_ORDER)
        assertEquals(listOf(endLate(2), capacity(5u, FlagSeverity.WARNING, 1), capacity(9u, FlagSeverity.WARNING, 1), info(3, 2u)), flags)
    }

    // ---------------------------------------------------------------------------------------------------------------- counts

    @Test
    fun `the roll-up counts warnings and infos`() {
        assertEquals(FlagCounts(0, 0), RoadmapKernels.flagCounts(emptyList()))
        val flags = listOf(warning(7, 1u, 1u), info(3, 2u), endLate(2), info(1, 3u), info(2, 4u))
        assertEquals(FlagCounts(2, 3), RoadmapKernels.flagCounts(flags))
    }
}
