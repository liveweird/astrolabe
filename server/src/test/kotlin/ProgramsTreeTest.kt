package ch.nokillswit

import ch.nokillswit.planning.DateSpan
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.FlagCounts
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.PlanOrder
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.PlanProgramFact
import ch.nokillswit.planning.PlanStreamFact
import ch.nokillswit.planning.ProgramSlot
import ch.nokillswit.planning.ProgramsTree
import ch.nokillswit.planning.RoadmapProject
import ch.nokillswit.planning.RoadmapProjectCan
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The pure programs-tree assembly (no server, no database): the ordering of every level and the span and flag roll-ups. */
class ProgramsTreeTest {
    private fun day(date: String) = LocalDate.parse(date)

    private fun span(start: String, end: String) = DaySpan(day(start), day(end))

    private fun stream(id: UInt, name: String, endDate: String? = null) =
        PlanStreamFact(id, name, 7u, "owner", day("2026-01-01"), endDate?.let(::day))

    private fun program(id: UInt, streamId: UInt, name: String) = PlanProgramFact(id, streamId, name, 7u, "owner")

    private fun flag(severity: FlagSeverity) = PlanFlag(
        if (severity == FlagSeverity.WARNING) FlagKind.DRIFT_END_LATE else FlagKind.DRIFT_START_LATE, severity, 1, null, null,
    )

    private fun project(
        id: UInt,
        programId: UInt,
        name: String = "p$id",
        rank: Int? = null,
        flags: List<FlagSeverity> = emptyList(),
    ) = RoadmapProject(
        id = id, name = name, programId = programId, programName = "program", workStreamId = 1u, workStreamName = "stream",
        ownerPersonId = 1u, ownerName = "owner", targetStart = null, targetEnd = null, rankPosition = rank, teamIds = emptyList(),
        span = null, drift = null, flags = flags.map(::flag), can = RoadmapProjectCan(editTargetWindow = false),
    )

    @Test
    fun `streams are open first then closed, every level by lowercase name then id`() {
        val tree = ProgramsTree.assemble(
            streams = listOf(
                stream(1u, "aaa-closed", endDate = "2026-06-30"),
                stream(3u, "Charlie"),
                stream(2u, "bravo"),
                stream(5u, "alpha"),
                stream(4u, "ALPHA"),
            ),
            programs = listOf(program(11u, 2u, "Zed"), program(12u, 2u, "apple"), program(14u, 2u, "Zed"), program(13u, 2u, "Banana")),
            projects = emptyList(),
            spans = emptyMap(),
        )
        assertEquals(listOf(4u, 5u, 2u, 3u, 1u), tree.map { it.id }, "alpha ties by id, closed last")
        assertEquals(listOf(12u, 13u, 11u, 14u), tree.single { it.id == 2u }.programs.map { it.id })
        assertEquals("2026-06-30", tree.last().endDate)
        assertNull(tree.first().endDate)
    }

    @Test
    fun `the shared order puts listed streams and programs first, closed streams stay last and projects keep their rank order`() {
        val order = PlanOrder(
            workStreams = mapOf(1u to 1, 3u to 2),
            programs = mapOf(14u to ProgramSlot(2u, 1), 13u to ProgramSlot(2u, 2), 12u to ProgramSlot(9u, 1)),
        )
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "aaa-closed", endDate = "2026-06-30"), stream(3u, "Charlie"), stream(2u, "bravo")),
            programs = listOf(program(11u, 2u, "Zed"), program(12u, 2u, "apple"), program(14u, 2u, "Yak"), program(13u, 2u, "Banana")),
            projects = listOf(project(1u, 14u, "zeta"), project(2u, 14u, "alpha", rank = 1)),
            spans = emptyMap(),
            order = order,
        )
        assertEquals(listOf(3u, 2u, 1u), tree.map { it.id }, "listed Charlie first, then bravo by name; closed last though listed first")
        val programs = tree.single { it.id == 2u }.programs
        assertEquals(listOf(14u, 13u, 12u, 11u), programs.map { it.id }, "listed 14, 13; apple's row names another stream: by name")
        assertEquals(listOf(2u, 1u), programs.first().projects.map { it.id }, "the ranked project first, as before")
    }

    @Test
    fun `projects are ranked first in rank order then by lowercase name and id`() {
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "s")),
            programs = listOf(program(10u, 1u, "p")),
            projects = listOf(
                project(1u, 10u, "zeta"),
                project(2u, 10u, "Alpha"),
                project(3u, 10u, "second", rank = 2),
                project(4u, 10u, "first", rank = 1),
                project(6u, 10u, "alpha"),
            ),
            spans = emptyMap(),
        )
        assertEquals(listOf(4u, 3u, 2u, 6u, 1u), tree.single().programs.single().projects.map { it.id })
    }

    @Test
    fun `an empty program and an empty stream stay, with no span and zero counts`() {
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "empty"), stream(2u, "withEmptyProgram")),
            programs = listOf(program(10u, 2u, "nothing")),
            projects = emptyList(),
            spans = emptyMap(),
        )
        assertEquals(2, tree.size)
        for (s in tree) {
            assertNull(s.span)
            assertEquals(FlagCounts(0, 0), s.flags)
        }
        val program = tree.last().programs.single()
        assertNull(program.span)
        assertEquals(FlagCounts(0, 0), program.flags)
        assertEquals(emptyList(), program.projects)
    }

    @Test
    fun `spans roll up project to program to stream, ignoring projects with none`() {
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "s")),
            programs = listOf(program(10u, 1u, "a"), program(11u, 1u, "b"), program(12u, 1u, "c")),
            projects = listOf(project(1u, 10u), project(2u, 10u), project(3u, 10u), project(4u, 11u), project(5u, 12u)),
            spans = mapOf(
                1u to span("2027-03-08", "2027-03-12"),
                2u to span("2027-03-01", "2027-03-05"),
                4u to span("2027-06-07", "2027-06-11"),
            ),
        )
        val s = tree.single()
        val (a, b, c) = s.programs
        assertEquals(DateSpan("2027-03-01", "2027-03-12"), a.span, "earliest start to latest end; the unscheduled project adds nothing")
        assertEquals(DateSpan("2027-06-07", "2027-06-11"), b.span)
        assertNull(c.span, "a program whose only project is unscheduled has no span")
        assertEquals(DateSpan("2027-03-01", "2027-06-11"), s.span)
    }

    @Test
    fun `flag counts roll up the warnings and infos of the projects`() {
        val w = FlagSeverity.WARNING
        val i = FlagSeverity.INFO
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "s")),
            programs = listOf(program(10u, 1u, "a"), program(11u, 1u, "b")),
            projects = listOf(
                project(1u, 10u, flags = listOf(w, i, i)),
                project(2u, 10u, flags = listOf(w)),
                project(3u, 11u, flags = listOf(i)),
            ),
            spans = emptyMap(),
        )
        val s = tree.single()
        assertEquals(FlagCounts(warnings = 2, infos = 2), s.programs[0].flags)
        assertEquals(FlagCounts(warnings = 0, infos = 1), s.programs[1].flags)
        assertEquals(FlagCounts(warnings = 2, infos = 3), s.flags)
    }

    @Test
    fun `a program without its stream and a project without its program are dropped`() {
        val tree = ProgramsTree.assemble(
            streams = listOf(stream(1u, "s")),
            programs = listOf(program(10u, 1u, "kept"), program(11u, 99u, "orphan")),
            projects = listOf(project(1u, 10u), project(2u, 77u)),
            spans = emptyMap(),
        )
        assertEquals(listOf(10u), tree.single().programs.map { it.id })
        assertEquals(listOf(1u), tree.single().programs.single().projects.map { it.id })
    }
}
