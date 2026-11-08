package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CriticalPathKernels
import ch.nokillswit.planning.CriticalPathResult
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyKernels
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import ch.nokillswit.planning.UpstreamEntity
import ch.nokillswit.planning.UpstreamRef
import ch.nokillswit.planning.orderUpstream
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The per-project critical path as a pure kernel (no server, no database), every figure counted by hand on 2027-02, 2027-02-01 a
 * Monday. With `k` the working-day index of that Monday, a week is five indices: Feb 1-5 = `[k, k+5)`, Feb 8-12 = `[k+5, k+10)`,
 * Feb 15-19 = `[k+10, k+15)`, Feb 22-26 = `[k+15, k+20)` (half-open: `E` is the last working day's index + 1). The viewed project is
 * P = 3; X = 1, Y = 2 and Z = 4 are the other projects. Milestone ids are below 100, link ids from 101.
 */
class CriticalPathKernelsTest {
    private val p = 3u
    private val x = 1u
    private val y = 2u
    private val z = 4u
    private val fs = DependencyType.FS

    private fun date(text: String) = LocalDate.parse(text)

    private fun m(id: UInt, project: UInt, start: String?, end: String? = start) =
        PlanMilestoneFact(id, project, 1u, if (start != null && end != null) DaySpan(date(start), date(end)) else null)

    private fun link(id: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType = fs, lag: Int = 0) =
        PlanLinkFact(id, pred, succ, type, lag)

    private fun analyse(
        milestones: List<PlanMilestoneFact>,
        links: List<PlanLinkFact> = emptyList(),
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
    ): CriticalPathResult = CriticalPathKernels.analyse(p, milestones, links, calendar)

    private fun CriticalPathResult.slack(id: UInt): Long? = slackByMilestone[id]

    private fun CriticalPathResult.entry(ref: EndpointRef): UpstreamRef = upstream.single { it.ref == ref }

    @Test
    fun `one milestone ends the project - zero slack, critical, no upstream`() {
        val r = analyse(listOf(m(1u, p, "2027-02-01", "2027-02-05")))
        assertEquals(0L, r.slack(1u))
        assertEquals(setOf(1u), r.criticalMilestones)
        assertTrue(r.upstream.isEmpty() && r.criticalDependencies.isEmpty())
    }

    @Test
    fun `a project with nothing scheduled has no figures, and an unscheduled milestone has no slack`() {
        assertEquals(CriticalPathResult.EMPTY, analyse(listOf(m(1u, p, null), m(2u, x, "2027-02-01", "2027-02-05"))))
        val r = analyse(listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, null)))
        assertEquals(mapOf(1u to 0L), r.slackByMilestone, "the unscheduled milestone is absent (the view shows null)")
        assertFalse(2u in r.criticalMilestones)
    }

    @Test
    fun `two back-to-back milestones - both critical, and the link between them`() {
        val r = analyse(
            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-08", "2027-02-12")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u))),
        )
        assertEquals(0L, r.slack(1u))
        assertEquals(0L, r.slack(2u))
        assertEquals(setOf(1u, 2u), r.criticalMilestones)
        assertEquals(setOf(101u), r.criticalDependencies)
        assertTrue(r.upstream.isEmpty(), "this project's own milestones are in the per-item fields, not in upstream")
    }

    @Test
    fun `a short parallel milestone has the difference of the ends as slack`() {
        val r = analyse(listOf(m(1u, p, "2027-02-01", "2027-02-12"), m(2u, p, "2027-02-01", "2027-02-05")))
        assertEquals(0L, r.slack(1u))
        assertEquals(5L, r.slack(2u), "E(long) - E(short) = (k+10) - (k+5)")
        assertEquals(setOf(1u), r.criticalMilestones)
    }

    @Test
    fun `a finish-to-start link with a two day gap gives the predecessor two days of slack, and a met lag none`() {
        val gap = analyse(
            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-10", "2027-02-26")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u))),
        )
        assertEquals(2L, gap.slack(1u), "S(2) = k+7, E(1) = k+5; the containment slack is 15")
        assertEquals(setOf(2u), gap.criticalMilestones)
        assertTrue(gap.criticalDependencies.isEmpty())
        val lagged = analyse(
            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-10", "2027-02-26")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u), lag = 2)),
        )
        assertEquals(0L, lagged.slack(1u), "FS lag 2 exactly met")
        assertEquals(setOf(101u), lagged.criticalDependencies)
    }

    @Test
    fun `start-to-start, finish-to-finish and start-to-finish links at zero and positive slack`() {
        // p1 = Feb 1-5 (S = k, E = k+5) is early, p2 ends the project: link slack = (to-point of p2) - (from-point of p1) - lag.
        data class Case(val type: DependencyType, val succStart: String, val lag: Int, val expectedSlack: Long)

        val cases = listOf(
            Case(DependencyType.SS, "2027-02-03", 2, 0), // S(p2) = k+2: 2 - 2
            Case(DependencyType.SS, "2027-02-03", 0, 2),
            Case(DependencyType.FF, "2027-02-03", 15, 0), // E(p2) = k+20, E(p1) = k+5: 15 - 15
            Case(DependencyType.FF, "2027-02-03", 13, 2),
            Case(DependencyType.SF, "2027-02-03", 20, 0), // E(p2) = k+20, S(p1) = k: 20 - 20
            Case(DependencyType.SF, "2027-02-03", 18, 2),
        )
        for (case in cases) {
            val r = analyse(
                listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, case.succStart, "2027-02-26")),
                listOf(link(101u, milestoneRef(1u), milestoneRef(2u), case.type, case.lag)),
            )
            assertEquals(case.expectedSlack, r.slack(1u), "${case.type} lag ${case.lag}")
            assertEquals(case.expectedSlack == 0L, 101u in r.criticalDependencies, "${case.type} lag ${case.lag}")
        }
    }

    @Test
    fun `a two hop chain across three projects - both members critical with their hops, both links driving`() {
        val r = analyse(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(2u), milestoneRef(3u))),
        )
        assertEquals(0L, r.slack(3u))
        assertEquals(setOf(UpstreamRef(milestoneRef(2u), 0, true, 1), UpstreamRef(milestoneRef(1u), 0, true, 2)), r.upstream.toSet())
        assertEquals(setOf(101u, 102u), r.criticalDependencies)
    }

    @Test
    fun `a slack on the far hop - the external milestone is upstream with slack, not critical, the near one is critical`() {
        val r = analyse(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-11", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(2u), milestoneRef(3u))),
        )
        assertEquals(UpstreamRef(milestoneRef(1u), 3, false, 2), r.entry(milestoneRef(1u)), "S(y1) = k+8, E(x1) = k+5")
        assertEquals(UpstreamRef(milestoneRef(2u), 0, true, 1), r.entry(milestoneRef(2u)))
        assertEquals(setOf(102u), r.criticalDependencies)
    }

    @Test
    fun `the fewest links wins when a member reaches the project by two routes`() {
        val r = analyse(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(
                link(101u, milestoneRef(1u), milestoneRef(2u)),
                link(102u, milestoneRef(2u), milestoneRef(3u)),
                link(103u, milestoneRef(1u), milestoneRef(3u)),
            ),
        )
        assertEquals(1, r.entry(milestoneRef(1u)).hops)
        assertEquals(1, r.entry(milestoneRef(2u)).hops)
    }

    @Test
    fun `a chain through a project entity - the project that ends it and its last milestone are critical, an earlier one has slack`() {
        // Y = {y1 Feb 1-5, y2 Feb 8-12}; link "Y finishes, then P starts"; P = {p1 Feb 15-19}.
        val r = analyse(
            listOf(m(1u, y, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, projectRef(y), projectRef(p))),
        )
        assertEquals(UpstreamRef(projectRef(y), 0, true, 1), r.entry(projectRef(y)))
        assertEquals(UpstreamRef(milestoneRef(2u), 0, true, 1), r.entry(milestoneRef(2u)))
        assertEquals(UpstreamRef(milestoneRef(1u), 5, false, 1), r.entry(milestoneRef(1u)), "E(Y) - E(y1) = (k+10) - (k+5)")
        assertEquals(setOf(101u), r.criticalDependencies)
        assertEquals(3, r.upstream.size, "only the linked project is listed, never one that merely contains upstream milestones")
    }

    @Test
    fun `a project is not listed for merely containing an upstream milestone`() {
        val r = analyse(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-08", "2027-02-12")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u))),
        )
        assertEquals(listOf(milestoneRef(1u)), r.upstream.map { it.ref })
    }

    @Test
    fun `a link into the project's START is critical only when its earliest milestone is`() {
        val earliestCritical = analyse(
            listOf(m(1u, x, "2027-02-08", "2027-02-12"), m(2u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, milestoneRef(1u), projectRef(p))),
        )
        assertEquals(UpstreamRef(milestoneRef(1u), 0, true, 1), earliestCritical.entry(milestoneRef(1u)))
        assertEquals(setOf(101u), earliestCritical.criticalDependencies)

        // p1 (Feb 15-16) starts the project but ends it early (E = k+12 against k+20); p2 (Feb 17-26) starts 2 working days later.
        val earliestShort = analyse(
            listOf(m(1u, x, "2027-02-08", "2027-02-12"), m(2u, p, "2027-02-15", "2027-02-16"), m(3u, p, "2027-02-17", "2027-02-26")),
            listOf(link(101u, milestoneRef(1u), projectRef(p))),
        )
        assertEquals(UpstreamRef(milestoneRef(1u), 2, false, 1), earliestShort.entry(milestoneRef(1u)), "min(0 + 8, 2 + 0)")
        assertTrue(earliestShort.criticalDependencies.isEmpty())
        assertEquals(8L, earliestShort.slack(2u))
    }

    @Test
    fun `a violated link is never driving and ends the chain at the violation`() {
        // x1 (Feb 8-12) FS y1 (Feb 8-12) is violated, y1 FS p1 holds: y1 is upstream, x1 is not.
        val upstreamViolation = analyse(
            listOf(m(1u, x, "2027-02-08", "2027-02-12"), m(2u, y, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(2u), milestoneRef(3u))),
        )
        assertEquals(listOf(milestoneRef(2u)), upstreamViolation.upstream.map { it.ref })
        assertEquals(setOf(102u), upstreamViolation.criticalDependencies)

        // A violated link INSIDE the project caps nothing: p1's slack is its containment slack, not a negative figure.
        val inside = analyse(
            listOf(m(1u, p, "2027-02-08", "2027-02-12"), m(2u, p, "2027-02-01", "2027-02-26")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u))),
        )
        assertEquals(10L, inside.slack(1u))
        assertTrue(inside.criticalDependencies.isEmpty())
    }

    @Test
    fun `an unscheduled end excludes the link`() {
        val r = analyse(
            listOf(m(1u, x, null), m(2u, p, "2027-02-08", "2027-02-12"), m(3u, p, "2027-02-01", "2027-02-05")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(3u), milestoneRef(1u))),
        )
        assertTrue(r.upstream.isEmpty() && r.criticalDependencies.isEmpty())
        assertEquals(5L, r.slack(3u), "pinned by nothing but its containment")
    }

    @Test
    fun `a downstream-only successor is absent, and a link into another project that never returns pins nothing`() {
        val r = analyse(
            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-08", "2027-02-26"), m(3u, z, "2027-02-08", "2027-02-12")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(3u))),
        )
        assertTrue(r.upstream.isEmpty())
        assertEquals(15L, r.slack(1u), "E(P) - E(p1) = (k+20) - (k+5), the link into Z caps nothing")
        assertFalse(1u in r.criticalMilestones)
        assertTrue(r.criticalDependencies.isEmpty())
    }

    @Test
    fun `a path that leaves the project and returns - the outside milestone is upstream with the right slack`() {
        val r = analyse(
            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, y, "2027-02-10", "2027-02-12"), m(3u, p, "2027-02-15", "2027-02-19")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(2u), milestoneRef(3u))),
        )
        assertEquals(UpstreamRef(milestoneRef(2u), 0, true, 1), r.entry(milestoneRef(2u)))
        assertEquals(2L, r.slack(1u), "S(y2) - E(p1) = (k+7) - (k+5); the containment slack is 10")
        assertEquals(setOf(102u), r.criticalDependencies)
    }

    @Test
    fun `ties - every milestone ending on the end is critical, and parallel zero-slack chains all are`() {
        val ends = analyse(listOf(m(1u, p, "2027-02-01", "2027-02-12"), m(2u, p, "2027-02-08", "2027-02-12")))
        assertEquals(setOf(1u, 2u), ends.criticalMilestones)

        val parallel = analyse(
            listOf(m(1u, x, "2027-02-01", "2027-02-05"), m(2u, x, "2027-02-01", "2027-02-05"), m(3u, p, "2027-02-08", "2027-02-12")),
            listOf(link(101u, milestoneRef(1u), milestoneRef(3u)), link(102u, milestoneRef(2u), milestoneRef(3u))),
        )
        assertEquals(setOf(milestoneRef(1u), milestoneRef(2u)), parallel.upstream.filter { it.critical }.map { it.ref }.toSet())
        assertEquals(setOf(101u, 102u), parallel.criticalDependencies)
    }

    @Test
    fun `a link's slack is actual minus required of the dependency check, for every type, lag and calendar`() {
        val holiday = WorkingCalendar(mapOf(date("2027-02-10") to "Test day"))
        val pred = DaySpan(date("2027-02-01"), date("2027-02-05"))
        val successors = listOf(
            "2027-02-08" to "2027-02-12",
            "2027-02-03" to "2027-02-26",
            "2027-02-05" to "2027-02-09",
            "2027-02-01" to "2027-02-12",
            "2027-02-15" to "2027-02-19",
        )
        for (calendar in listOf(WorkingCalendar.MON_FRI, holiday)) {
            for (type in DependencyType.entries) {
                for (lag in listOf(-3, 0, 2, 7)) {
                    for ((start, end) in successors) {
                        val succ = DaySpan(date(start), date(end))
                        val check = DependencyKernels.check(type, lag, pred, succ, calendar)
                        val r = CriticalPathKernels.analyse(
                            p,
                            listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, start, end)),
                            listOf(link(101u, milestoneRef(1u), milestoneRef(2u), type, lag)),
                            calendar,
                        )
                        val containment = calendar.workingDayIndex(succ.end) - calendar.workingDayIndex(pred.end)
                        val label = "$type lag $lag $start..$end"
                        if (check.status == DependencyStatus.VIOLATED) {
                            assertEquals(containment, r.slack(1u), "$label violated: the link is left out")
                            assertFalse(101u in r.criticalDependencies, label)
                        } else {
                            val slack = calendar.workingDayIndex(date(checkNotNull(check.actualDate))) -
                                calendar.workingDayIndex(date(checkNotNull(check.requiredDate)))
                            assertEquals(minOf(slack, containment), r.slack(1u), label)
                            assertEquals(slack == 0L, 101u in r.criticalDependencies, label)
                        }
                    }
                }
            }
        }
    }

    @Test
    fun `a holiday between two milestones takes the working day out of the slack`() {
        val milestones = listOf(m(1u, x, "2027-01-04", "2027-01-05"), m(2u, p, "2027-01-07", "2027-01-08"))
        val links = listOf(link(101u, milestoneRef(1u), milestoneRef(2u)))
        val without = analyse(milestones, links)
        assertEquals(1L, without.entry(milestoneRef(1u)).slackDays, "Wed 01-06 is a working day")
        assertTrue(without.criticalDependencies.isEmpty())

        val epiphany = WorkingCalendar(mapOf(date("2027-01-06") to "Epiphany"))
        val with = analyse(milestones, links, epiphany)
        assertEquals(UpstreamRef(milestoneRef(1u), 0, true, 1), with.entry(milestoneRef(1u)))
        assertEquals(setOf(101u), with.criticalDependencies)
    }

    @Test
    fun `an all-holiday milestone is a zero-length point`() {
        val closed = WorkingCalendar(mapOf(date("2027-02-03") to "A", date("2027-02-04") to "B"))
        val milestones = listOf(m(1u, p, "2027-02-01", "2027-02-02"), m(2u, p, "2027-02-03", "2027-02-04"), m(3u, p, "2027-02-05"))
        val free = analyse(milestones, calendar = closed)
        assertEquals(1L, free.slack(2u), "S = E = k+2 against the project's end k+3")
        assertEquals(1L, free.slack(1u))
        assertEquals(setOf(3u), free.criticalMilestones)

        val pinned = analyse(milestones, listOf(link(101u, milestoneRef(2u), milestoneRef(3u))), closed)
        assertEquals(0L, pinned.slack(2u), "FS from a zero-length point: S(3) = E(2) = k+2")
        assertEquals(setOf(101u), pinned.criticalDependencies)
    }

    @Test
    fun `a cyclic input fails closed`() {
        val milestones = listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-01", "2027-02-05"))
        val ss = DependencyType.SS
        val cycle = listOf(link(101u, milestoneRef(1u), milestoneRef(2u), ss), link(102u, milestoneRef(2u), milestoneRef(1u), ss))
        val failure = assertFailsWith<IllegalStateException> { analyse(milestones, cycle) }
        assertEquals("the active plan graph holds a cycle", failure.message)
    }

    @Test
    fun `analyseAll equals analyse per root - three roots on the three project chain, an empty root and a repeated id`() {
        val milestones = listOf(
            m(1u, x, "2027-02-01", "2027-02-05"),
            m(2u, y, "2027-02-08", "2027-02-12"),
            m(3u, p, "2027-02-15", "2027-02-19"),
        )
        val links = listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(2u), milestoneRef(3u)))
        val all = CriticalPathKernels.analyseAll(listOf(x, y, p, z, p), milestones, links, WorkingCalendar.MON_FRI)
        assertEquals(setOf(x, y, p, z), all.keys, "every requested id is a key, once")
        for (root in listOf(x, y, p, z)) {
            assertEquals(CriticalPathKernels.analyse(root, milestones, links, WorkingCalendar.MON_FRI), all.getValue(root), "root $root")
        }
        // Counted by hand: each root's own milestone ends it, and the chain upstream of it is critical with its hops.
        assertEquals(CriticalPathResult(mapOf(1u to 0L), setOf(1u), emptySet(), emptyList()), all.getValue(x))
        assertEquals(
            CriticalPathResult(mapOf(2u to 0L), setOf(2u), setOf(101u), listOf(UpstreamRef(milestoneRef(1u), 0, true, 1))),
            all.getValue(y),
        )
        val chain = setOf(UpstreamRef(milestoneRef(2u), 0, true, 1), UpstreamRef(milestoneRef(1u), 0, true, 2))
        assertEquals(chain, all.getValue(p).upstream.toSet())
        assertEquals(setOf(101u, 102u), all.getValue(p).criticalDependencies)
        assertEquals(CriticalPathResult.EMPTY, all.getValue(z), "nothing is scheduled in Z")
        assertTrue(CriticalPathKernels.analyseAll(emptyList(), milestones, links, WorkingCalendar.MON_FRI).isEmpty())
    }

    @Test
    fun `analyseAll walks each root on its own - slack toward one end does not leak into another`() {
        // x1 feeds y1 (tight) and p1 (a 3 day gap): toward Y's end x1 is critical, toward P's end it has slack.
        val milestones = listOf(
            m(1u, x, "2027-02-01", "2027-02-05"),
            m(2u, y, "2027-02-08", "2027-02-12"),
            m(3u, p, "2027-02-11", "2027-02-19"),
        )
        val links = listOf(link(101u, milestoneRef(1u), milestoneRef(2u)), link(102u, milestoneRef(1u), milestoneRef(3u)))
        val all = CriticalPathKernels.analyseAll(listOf(y, p), milestones, links, WorkingCalendar.MON_FRI)
        assertEquals(UpstreamRef(milestoneRef(1u), 0, true, 1), all.getValue(y).upstream.single())
        assertEquals(setOf(101u), all.getValue(y).criticalDependencies)
        val toP = all.getValue(p).upstream.single()
        assertEquals(UpstreamRef(milestoneRef(1u), 3, false, 1), toP, "S(p1) = k+8 against E(x1) = k+5")
        assertTrue(all.getValue(p).criticalDependencies.isEmpty())
        for (root in listOf(y, p)) {
            assertEquals(CriticalPathKernels.analyse(root, milestones, links, WorkingCalendar.MON_FRI), all.getValue(root))
        }
    }

    @Test
    fun `analyseAll fails closed on a cycle like analyse`() {
        val milestones = listOf(m(1u, p, "2027-02-01", "2027-02-05"), m(2u, p, "2027-02-01", "2027-02-05"))
        val ss = DependencyType.SS
        val cycle = listOf(link(101u, milestoneRef(1u), milestoneRef(2u), ss), link(102u, milestoneRef(2u), milestoneRef(1u), ss))
        val failure = assertFailsWith<IllegalStateException> {
            CriticalPathKernels.analyseAll(listOf(p), milestones, cycle, WorkingCalendar.MON_FRI)
        }
        assertEquals("the active plan graph holds a cycle", failure.message)
    }

    // --- the wire order and the cap (orderUpstream) -------------------------------------------------------------------------

    private fun entity(id: UInt, name: String, start: String, slack: Int, kind: EndpointKind = EndpointKind.MILESTONE) =
        UpstreamEntity(kind, id, name, y, "Y", start, "2027-03-31", slack, slack == 0, 1)

    @Test
    fun `the chain comes first from its origin, the rest by slack, and the cap cuts only the rest`() {
        val critical = listOf(
            entity(1u, "b", "2027-02-08", 0),
            entity(2u, "z", "2027-02-01", 0),
            entity(3u, "A", "2027-02-01", 0),
            entity(4u, "A", "2027-02-01", 0, EndpointKind.PROJECT),
        )
        val others = (1..105).map { entity(100u + it.toUInt(), "n$it", "2027-02-01", 107 - it) } +
            listOf(entity(300u, "tie-late", "2027-03-01", 1), entity(301u, "tie-early", "2027-02-01", 1))
        val path = orderUpstream(others.reversed() + critical.reversed())
        assertEquals(listOf(3u, 4u, 2u, 1u), path.upstream.take(4).map { it.id }, "start, then name case-insensitively, then kind")
        assertEquals(listOf(EndpointKind.MILESTONE, EndpointKind.PROJECT), path.upstream.take(2).map { it.kind })
        val rest = path.upstream.drop(4)
        assertEquals(100, rest.size)
        assertTrue(path.upstreamTruncated)
        assertEquals(listOf(1, 1), rest.take(2).map { it.slackDays })
        assertEquals(listOf(301u, 300u), rest.take(2).map { it.id }, "equal slack: by start date")
        assertEquals(rest.map { it.slackDays }, rest.map { it.slackDays }.sorted(), "slack ascending")
    }

    @Test
    fun `exactly the cap is not truncated and the critical chain is never cut`() {
        val exactly = orderUpstream((1..100).map { entity(it.toUInt(), "n$it", "2027-02-01", it) })
        assertEquals(100, exactly.upstream.size)
        assertFalse(exactly.upstreamTruncated)

        val chain = orderUpstream((1..130).map { entity(it.toUInt(), "c$it", "2027-02-01", 0) })
        assertEquals(130, chain.upstream.size)
        assertFalse(chain.upstreamTruncated)
        assertNull(orderUpstream(emptyList()).upstream.firstOrNull())
    }
}
