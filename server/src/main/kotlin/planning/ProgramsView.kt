@file:OptIn(ExperimentalSerializationApi::class)

package ch.nokillswit.planning

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/**
 * `GET /api/v1/views/programs` — the plan tree for the programs timeline in one document (the documented view-endpoint shape
 * exception, `list-endpoints.md`; bounded by the plan's scale: ~5 work streams, ~20 programs, ~100 projects). Work stream -> program ->
 * project, EMPTY programs and work streams included. Every project is the roadmap's [RoadmapProject] (one schema: the same span, drift,
 * flags and `can.editTargetWindow`), [teams] and [links] are the roadmap's, from the same snapshot. A program's and a work stream's
 * `span` is DERIVED (never stored) from the level below and their `flags` roll the projects' flags up.
 */
@Serializable
data class ProgramsView(
    /**
     * The PLAN revision read FIRST (informational: no flow on the programs page sends it back;
     * the ranking's revision lives on the roadmap view).
     */
    val revision: Long,
    val teams: List<RoadmapTeam>,
    val links: List<RoadmapLink>,
    val workStreams: List<ProgramsWorkStream>,
    /** The Jira connections a binding in scope links to (empty without a binding), once per document ([JiraSite]). */
    val jiraSites: List<JiraSite> = emptyList(),
    /**
     * Present only for `?baseline=N`: the baseline the projects', programs' and work streams' `baseline` blocks compare to, and
     * (the roadmap's [RoadmapBaseline]) the baseline's projects that are gone now.
     */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: RoadmapBaseline? = null,
    /**
     * Present only for `?criticalPath=N` (1.16): the chain toward project N, the roadmap's [RoadmapCriticalPath] from the same step
     * over the same rows, for the programs page's picker and panel.
     */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val criticalPath: RoadmapCriticalPath? = null,
)

/**
 * A work stream: [startDate] and [endDate] are its own stored dates (the end only when closed), [span] the derived span over its
 * programs' spans (null while none of its projects is scheduled), [flags] the counts over all its projects' flags.
 */
@Serializable
data class ProgramsWorkStream(
    val id: UInt,
    val name: String,
    val ownerName: String,
    val startDate: String,
    val endDate: String?,
    val span: DateSpan?,
    val flags: FlagCounts,
    val programs: List<ProgramsProgram>,
    /** Present only for `?baseline=N` and a work stream with at least one project the baseline froze: [SpanBaseline] over its programs. */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: SpanBaseline? = null,
)

/** A program: [span] is derived from its projects' spans, [flags] counts its projects' flags; programs carry no target window. */
@Serializable
data class ProgramsProgram(
    val id: UInt,
    val name: String,
    val ownerName: String,
    val span: DateSpan?,
    val flags: FlagCounts,
    val projects: List<RoadmapProject>,
    /** Present only for `?baseline=N` and a program with at least one project the baseline froze: [SpanBaseline] over those projects. */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: SpanBaseline? = null,
)
