package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate

/** An ACTIVE work stream as the programs tree sees it. */
data class PlanStreamFact(val id: UInt, val name: String, val ownerName: String, val startDate: LocalDate, val endDate: LocalDate?)

/** An ACTIVE program as the programs tree sees it. */
data class PlanProgramFact(val id: UInt, val workStreamId: UInt, val name: String, val ownerName: String)

/**
 * What the `?baseline=` overlay rolls up: [frozenSpans] holds, for each CURRENT project the baseline also froze, the span it had (null =
 * nothing scheduled then); a project without a key is newer than the baseline and takes no part in the baseline roll-up.
 */
class TreeBaseline(val frozenSpans: Map<UInt, DaySpan?>, val calendar: WorkingCalendar)

/**
 * The programs view's assembly as a pure function (no I/O), the [RoadmapKernels] idiom: it orders the levels, rolls the derived spans
 * up ([SpanKernels.derivedSpan]: project spans -> program -> work stream) and the flag counts ([RoadmapKernels.flagCounts]).
 */
object ProgramsTree {
    /**
     * The tree over [streams], [programs] and the roadmap's [projects] ([spans]: each project's derived span, absent = none).
     * Order: open work streams before closed ones, streams and programs by name (case-insensitive) then id; the projects of a program
     * by rank (ranked first), then name and id. A program without projects and a stream without programs stay in the tree, with a
     * null span and zero counts. A program whose stream, or a project whose program, is not listed is dropped. With a [baseline], a
     * program's (stream's) `baseline` is the roll-up of its current projects' (programs') frozen spans against the live one, present
     * only when at least one project below it was frozen - the same derivation as the live span.
     */
    fun assemble(
        streams: Collection<PlanStreamFact>,
        programs: Collection<PlanProgramFact>,
        projects: Collection<RoadmapProject>,
        spans: Map<UInt, DaySpan>,
        baseline: TreeBaseline? = null,
    ): List<ProgramsWorkStream> {
        val projectsByProgram = projects.groupBy { it.programId }
        val programsByStream = programs.groupBy { it.workStreamId }
        return streams
            .sortedWith(compareBy({ it.endDate != null }, { it.name.lowercase() }, { it.id }))
            .map { stream ->
                val nodes = programsByStream[stream.id].orEmpty()
                    .sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
                    .map { program -> programNode(program, projectsByProgram[program.id].orEmpty(), spans, baseline) }
                ProgramsWorkStream(
                    id = stream.id,
                    name = stream.name,
                    ownerName = stream.ownerName,
                    startDate = stream.startDate.toString(),
                    endDate = stream.endDate?.toString(),
                    span = SpanKernels.derivedSpan(nodes.mapNotNull { it.span })?.toWire(),
                    flags = RoadmapKernels.flagCounts(nodes.flatMap { node -> node.program.projects.flatMap { it.flags } }),
                    programs = nodes.map { it.program },
                    baseline = baseline?.let { b -> nodes.filter { it.framed }.takeIf { it.isNotEmpty() }?.let { rollup(it, nodes, b) } },
                )
            }
    }

    /**
     * One program with the [DaySpan] it derived (the stream's input), so the stream never re-parses the wire dates; [frozenSpan] is
     * the baseline roll-up of its framed projects and [framed] whether any project below it was frozen at all.
     */
    private class ProgramNode(val program: ProgramsProgram, val span: DaySpan?, val frozenSpan: DaySpan?, val framed: Boolean)

    private fun programNode(
        program: PlanProgramFact,
        projects: List<RoadmapProject>,
        spans: Map<UInt, DaySpan>,
        baseline: TreeBaseline?,
    ): ProgramNode {
        val ordered = projects.sortedWith(compareBy({ it.rankPosition ?: Int.MAX_VALUE }, { it.name.lowercase() }, { it.id }))
        val span = SpanKernels.derivedSpan(ordered.mapNotNull { spans[it.id] })
        val framed = baseline?.let { b -> ordered.filter { it.id in b.frozenSpans } }.orEmpty()
        val frozenSpan = SpanKernels.derivedSpan(framed.mapNotNull { baseline?.frozenSpans?.get(it.id) })
        val node = ProgramsProgram(
            id = program.id,
            name = program.name,
            ownerName = program.ownerName,
            span = span?.toWire(),
            flags = RoadmapKernels.flagCounts(ordered.flatMap { it.flags }),
            projects = ordered,
            baseline = baseline?.takeIf { framed.isNotEmpty() }?.let { b ->
                SpanBaseline(frozenSpan?.toDateSpan(), BaselineKernels.spanMovement(frozenSpan, span, b.calendar).toView())
            },
        )
        return ProgramNode(node, span, frozenSpan, framed.isNotEmpty())
    }

    /** A work stream's baseline: its framed programs' frozen spans against the stream's live span (the derivation of its live span). */
    private fun rollup(framed: List<ProgramNode>, all: List<ProgramNode>, baseline: TreeBaseline): SpanBaseline {
        val frozen = SpanKernels.derivedSpan(framed.mapNotNull { it.frozenSpan })
        val live = SpanKernels.derivedSpan(all.mapNotNull { it.span })
        return SpanBaseline(frozen?.toDateSpan(), BaselineKernels.spanMovement(frozen, live, baseline.calendar).toView())
    }

    private fun DaySpan.toWire() = DateSpan(start.toString(), end.toString())
}
