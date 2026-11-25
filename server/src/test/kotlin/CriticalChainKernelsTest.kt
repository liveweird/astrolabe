package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.ChainRef
import ch.nokillswit.planning.CriticalChain
import ch.nokillswit.planning.CriticalPathKernels
import ch.nokillswit.planning.CriticalPathResult
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.PlanLinkFact
import ch.nokillswit.planning.PlanMilestoneFact
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The chain THROUGH seed milestones (1.27, `CriticalPathKernels.analyseAll(…, chainSeeds)`), every vector counted by hand on 2027-02
 * (2027-02-01 a Monday; with `k` its working-day index a week is five indices: Feb 1-5 = `[k, k+5)`, Feb 8-12 = `[k+5, k+10)`,
 * Feb 15-19 = `[k+10, k+15)`, Feb 22-26 = `[k+15, k+20)`). The viewed project is P = 3 and the seeds stand for the team's milestones;
 * X = 1, Y = 2, Z = 4, W = 5, V = 7 and Q = 8 are other projects. Milestone ids are below 100, link ids from 101. Finish-to-start
 * links between consecutive weeks have slack 0, so every chain below is back to back, and a milestone that ends P's span is critical.
 */
class CriticalChainKernelsTest {
    private val p = 3u
    private val x = 1u
    private val y = 2u
    private val w = 5u
    private val v = 7u
    private val q = 8u

    private val week1 = "2027-02-01" to "2027-02-05"
    private val week2 = "2027-02-08" to "2027-02-12"
    private val week3 = "2027-02-15" to "2027-02-19"
    private val week4 = "2027-02-22" to "2027-02-26"

    private fun m(id: UInt, project: UInt, weeks: Pair<String, String>) =
        PlanMilestoneFact(id, project, 1u, DaySpan(LocalDate.parse(weeks.first), LocalDate.parse(weeks.second)))

    private fun fs(id: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType = DependencyType.FS, lag: Int = 0) =
        PlanLinkFact(id, pred, succ, type, lag)

    private fun ms(id: UInt) = milestoneRef(id)

    private fun analyse(
        root: UInt,
        seeds: Set<UInt>,
        milestones: List<PlanMilestoneFact>,
        links: List<PlanLinkFact>,
    ): CriticalPathResult = CriticalPathKernels.analyseAll(listOf(root), milestones, links, WorkingCalendar.MON_FRI, seeds).getValue(root)

    private fun chain(root: UInt, seeds: Set<UInt>, milestones: List<PlanMilestoneFact>, links: List<PlanLinkFact>) =
        analyse(root, seeds, milestones, links).chain

    private fun hops(ref: EndpointRef, hops: Int) = ChainRef(ref, hops)

    /** x1 -> y1 -> p1 in three projects, p1 (the seed in most vectors) ending P. */
    private val line = listOf(m(1u, x, week1), m(2u, y, week2), m(3u, p, week3))
    private val lineLinks = listOf(fs(101u, ms(1u), ms(2u)), fs(102u, ms(2u), ms(3u)))

    @Test
    fun `a one hop bridge - the neighbour is a member at one hop and its link is on the chain`() {
        val r = chain(p, setOf(2u), listOf(m(1u, x, week1), m(2u, p, week2)), listOf(fs(101u, ms(1u), ms(2u))))
        assertEquals(CriticalChain(listOf(hops(ms(1u), 1)), setOf(101u)), r)
    }

    @Test
    fun `a two hop bridge across three projects - both members, the nearer first, both links`() {
        val r = chain(p, setOf(3u), line, lineLinks)
        assertEquals(listOf(hops(ms(2u), 1), hops(ms(1u), 2)), r.members)
        assertEquals(setOf(101u, 102u), r.linkIds)
    }

    @Test
    fun `the chain goes through another project's whole end - the project is a member, its milestone met only by containment is not`() {
        // x1 -> project V (its start), V holds v1 alone (Feb 8-12), project V (its end) -> p1: the whole-project ends are the links' ends.
        val milestones = listOf(m(1u, x, week1), m(2u, v, week2), m(3u, p, week3))
        val links = listOf(fs(101u, ms(1u), projectRef(v)), fs(102u, projectRef(v), ms(3u)))
        val r = chain(p, setOf(3u), milestones, links)
        assertEquals(listOf(hops(projectRef(v), 1), hops(ms(1u), 2)), r.members, "v1 is named by no link: containment stays implicit")
        assertEquals(setOf(101u, 102u), r.linkIds)
    }

    @Test
    fun `a sibling branch that only shares a point with the chain is left out - backward and forward closures are never mixed`() {
        // y1 feeds p1 (the seed) and p2 (also Feb 15-19, so it ends P as well and is critical): p2 is a sibling of the seed.
        val milestones = line + m(4u, p, week3)
        val links = lineLinks + fs(103u, ms(2u), ms(4u))
        val r = chain(p, setOf(3u), milestones, links)
        assertEquals(listOf(hops(ms(2u), 1), hops(ms(1u), 2)), r.members)
        assertEquals(setOf(101u, 102u), r.linkIds, "y1 -> p2 is critical and is not on a path THROUGH p1")
        // A seed on each branch brings both in.
        assertEquals(setOf(101u, 102u, 103u), chain(p, setOf(3u, 4u), milestones, links).linkIds)
        assertEquals(setOf(101u, 103u), chain(p, setOf(4u), milestones, links).linkIds)
    }

    @Test
    fun `forward from the seed to the project's end - the milestones it drives, and no branch that leaves the project's chain`() {
        // p1 (Feb 1-5, the seed) -> w1 (Feb 8-12) -> p3 (Feb 15-19, ends P); p1 -> s1 (project Z, Feb 8-12) drives nothing toward P.
        val milestones = listOf(m(1u, p, week1), m(2u, w, week2), m(3u, p, week3), m(4u, 4u, week2))
        val links = listOf(fs(101u, ms(1u), ms(2u)), fs(102u, ms(2u), ms(3u)), fs(103u, ms(1u), ms(4u)))
        val r = chain(p, setOf(1u), milestones, links)
        assertEquals(listOf(hops(ms(2u), 1), hops(ms(3u), 2)), r.members, "s1 has no float toward P: it is no member")
        assertEquals(setOf(101u, 102u), r.linkIds)
    }

    @Test
    fun `a seed of another project that drives P's end brings its forward chain into P's analysis`() {
        // The team's milestone x1 is in project X, upstream of P: forward from it, y1 then p1 up to P's end.
        val r = chain(p, setOf(1u), line, lineLinks)
        assertEquals(listOf(hops(ms(2u), 1), hops(ms(3u), 2)), r.members)
        assertEquals(setOf(101u, 102u), r.linkIds)
    }

    @Test
    fun `a violated link ends the chain at the violation`() {
        // x1 (Feb 8-12) -> y1 (Feb 8-12): the finish is after the start, slack -5: left out, so x1 is no member.
        val milestones = listOf(m(1u, x, week2), m(2u, y, week2), m(3u, p, week3))
        val r = chain(p, setOf(3u), milestones, lineLinks)
        assertEquals(CriticalChain(listOf(hops(ms(2u), 1)), setOf(102u)), r)
    }

    @Test
    fun `a seed with no zero-float point has no chain, and neither has a seed nothing drives`() {
        // p1 (Feb 15-19) has 5 working days of float: p2 ends P a week later. The link into p1 has slack 0 but its `to` point does not.
        val milestones = listOf(m(1u, y, week2), m(2u, p, week3), m(3u, p, week4))
        val links = listOf(fs(101u, ms(1u), ms(2u)))
        assertEquals(CriticalChain.NONE, chain(p, setOf(2u), milestones, links))
        assertEquals(5L, analyse(p, emptySet(), milestones, links).slackByMilestone[2u])
        assertEquals(CriticalChain.NONE, chain(p, setOf(3u), milestones, links), "p2 ends P and no link names it")
        assertEquals(CriticalChain.NONE, chain(p, setOf(99u), milestones, links), "an id that is no milestone of the plan")
    }

    @Test
    fun `a seed downstream of the viewed project's end contributes nothing`() {
        // Toward Y's end p1 is downstream: it has no float there, so it seeds nothing.
        assertEquals(CriticalChain.NONE, chain(y, setOf(3u), line, lineLinks))
        assertEquals(listOf(hops(ms(1u), 1)), chain(y, setOf(2u), line, lineLinks).members)
    }

    @Test
    fun `two zero-slack predecessors of the seed are both members at one hop, ordered by kind and id`() {
        val milestones = listOf(m(1u, x, week2), m(2u, y, week2), m(3u, p, week3))
        val links = listOf(fs(101u, ms(1u), ms(3u)), fs(102u, ms(2u), ms(3u)))
        val r = chain(p, setOf(3u), milestones, links)
        assertEquals(listOf(hops(ms(1u), 1), hops(ms(2u), 1)), r.members)
        assertEquals(setOf(101u, 102u), r.linkIds)
    }

    @Test
    fun `a start-to-start link is on the chain through the start point alone`() {
        val milestones = listOf(m(1u, x, week1), m(2u, p, week1))
        val r = chain(p, setOf(2u), milestones, listOf(fs(101u, ms(1u), ms(2u), DependencyType.SS)))
        assertEquals(CriticalChain(listOf(hops(ms(1u), 1)), setOf(101u)), r)
    }

    @Test
    fun `a finish-to-finish link with a lag is on the chain through the end points`() {
        // E(x1) = k+5, E(p1) = k+10: FF slack = 5 - lag, so lag 5 is met exactly (and lag 3 leaves slack 2: critical edges need 0).
        val milestones = listOf(m(1u, x, week1), m(2u, p, week2))
        val met = chain(p, setOf(2u), milestones, listOf(fs(101u, ms(1u), ms(2u), DependencyType.FF, lag = 5)))
        assertEquals(CriticalChain(listOf(hops(ms(1u), 1)), setOf(101u)), met)
        assertEquals(CriticalChain.NONE, chain(p, setOf(2u), milestones, listOf(fs(101u, ms(1u), ms(2u), DependencyType.FF, lag = 3))))
    }

    @Test
    fun `a start-to-finish link with a lag is on the chain through x1's start and p1's end`() {
        // S(x1) = k, E(p1) = k+10: SF slack = 10 - lag; lag 10 is met exactly.
        val milestones = listOf(m(1u, x, week1), m(2u, p, week2))
        val r = chain(p, setOf(2u), milestones, listOf(fs(101u, ms(1u), ms(2u), DependencyType.SF, lag = 10)))
        assertEquals(CriticalChain(listOf(hops(ms(1u), 1)), setOf(101u)), r)
    }

    @Test
    fun `a link into the end of the seed's own project is no part of the chain - the closure never turns around`() {
        // s1 (Feb 8-12) is V's only milestone, so it ends V; x1 (Feb 1-5) FF-links to V's end with lag 5 (slack 0, E(V) = k+10) and V's
        // end drives p1 (Feb 15-19). The chain through s1 is s1 -> V -> p1. Link 101 ends at E(V), a point s1 itself drives (forward
        // closure), but x1 is no predecessor of s1: its `to` is in the forward set only, so it stays out and x1 is no member.
        val milestones = listOf(m(1u, v, week2), m(2u, x, week1), m(3u, p, week3))
        val links = listOf(
            fs(101u, ms(2u), projectRef(v), DependencyType.FF, lag = 5),
            fs(102u, projectRef(v), ms(3u)),
        )
        val r = chain(p, setOf(1u), milestones, links)
        assertEquals(CriticalChain(listOf(hops(projectRef(v), 0), hops(ms(3u), 1)), setOf(102u)), r)
        // The sibling's own seed brings it in: x1 as the team's milestone makes 101 a path through a seed.
        assertEquals(setOf(101u, 102u), chain(p, setOf(1u, 2u), milestones, links).linkIds)
    }

    @Test
    fun `a project that holds the seed is named by a link at zero hops - the seed's end is the project's end`() {
        // Toward Q's end: p1 (Feb 1-5) is P's only milestone, so P (its end) -> q1 (Feb 8-12) is the whole project driving q1.
        val milestones = listOf(m(1u, p, week1), m(2u, q, week2))
        val r = chain(q, setOf(1u), milestones, listOf(fs(101u, projectRef(p), ms(2u))))
        assertEquals(listOf(hops(projectRef(p), 0), hops(ms(2u), 1)), r.members)
        assertEquals(setOf(101u), r.linkIds)
    }

    @Test
    fun `seeds change the chain and nothing else - every other member of every result is what it was without them`() {
        val milestones = line + m(4u, p, week3)
        val links = lineLinks + fs(103u, ms(2u), ms(4u))
        val roots = listOf(x, y, p, 6u)
        val plain = CriticalPathKernels.analyseAll(roots, milestones, links, WorkingCalendar.MON_FRI)
        val seeded = CriticalPathKernels.analyseAll(roots, milestones, links, WorkingCalendar.MON_FRI, setOf(3u, 4u))
        assertEquals(plain, seeded.mapValues { (_, r) -> r.copy(chain = CriticalChain.NONE) })
        assertTrue(plain.values.all { it.chain == CriticalChain.NONE }, "no seeds, no chain")
        assertTrue(seeded.getValue(p).chain.members.isNotEmpty())
        assertEquals(CriticalChain.NONE, seeded.getValue(6u).chain, "a root with nothing scheduled")
    }
}
