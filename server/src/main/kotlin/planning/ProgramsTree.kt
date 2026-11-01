package ch.nokillswit.planning

import java.time.LocalDate

/** An ACTIVE work stream as the programs tree sees it. */
data class PlanStreamFact(val id: UInt, val name: String, val ownerName: String, val startDate: LocalDate, val endDate: LocalDate?)

/** An ACTIVE program as the programs tree sees it. */
data class PlanProgramFact(val id: UInt, val workStreamId: UInt, val name: String, val ownerName: String)

/**
 * The programs view's assembly as a pure function (no I/O), the [RoadmapKernels] idiom: it orders the levels, rolls the derived spans
 * up ([SpanKernels.derivedSpan]: project spans -> program -> work stream) and the flag counts ([RoadmapKernels.flagCounts]).
 */
object ProgramsTree {
    /**
     * The tree over [streams], [programs] and the roadmap's [projects] ([spans]: each project's derived span, absent = none).
     * Order: open work streams before closed ones, streams and programs by name (case-insensitive) then id; the projects of a program
     * by rank (ranked first), then name and id. A program without projects and a stream without programs stay in the tree, with a
     * null span and zero counts. A program whose stream, or a project whose program, is not listed is dropped.
     */
    fun assemble(
        streams: Collection<PlanStreamFact>,
        programs: Collection<PlanProgramFact>,
        projects: Collection<RoadmapProject>,
        spans: Map<UInt, DaySpan>,
    ): List<ProgramsWorkStream> {
        val projectsByProgram = projects.groupBy { it.programId }
        val programsByStream = programs.groupBy { it.workStreamId }
        return streams
            .sortedWith(compareBy({ it.endDate != null }, { it.name.lowercase() }, { it.id }))
            .map { stream ->
                val nodes = programsByStream[stream.id].orEmpty()
                    .sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
                    .map { program -> programNode(program, projectsByProgram[program.id].orEmpty(), spans) }
                ProgramsWorkStream(
                    id = stream.id,
                    name = stream.name,
                    ownerName = stream.ownerName,
                    startDate = stream.startDate.toString(),
                    endDate = stream.endDate?.toString(),
                    span = SpanKernels.derivedSpan(nodes.mapNotNull { it.second })?.toWire(),
                    flags = RoadmapKernels.flagCounts(nodes.flatMap { node -> node.first.projects.flatMap { it.flags } }),
                    programs = nodes.map { it.first },
                )
            }
    }

    /** One program with the [DaySpan] it derived (the stream's input), so the stream never re-parses the wire dates. */
    private fun programNode(
        program: PlanProgramFact,
        projects: List<RoadmapProject>,
        spans: Map<UInt, DaySpan>,
    ): Pair<ProgramsProgram, DaySpan?> {
        val ordered = projects.sortedWith(compareBy({ it.rankPosition ?: Int.MAX_VALUE }, { it.name.lowercase() }, { it.id }))
        val span = SpanKernels.derivedSpan(ordered.mapNotNull { spans[it.id] })
        val node = ProgramsProgram(
            id = program.id,
            name = program.name,
            ownerName = program.ownerName,
            span = span?.toWire(),
            flags = RoadmapKernels.flagCounts(ordered.flatMap { it.flags }),
            projects = ordered,
        )
        return node to span
    }

    private fun DaySpan.toWire() = DateSpan(start.toString(), end.toString())
}
