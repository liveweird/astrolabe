package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** A milestone as the roadmap kernels see it: its project, its team and its dates ([span] null = unscheduled). */
data class PlanMilestoneFact(val id: UInt, val projectId: UInt, val teamId: UInt, val span: DaySpan?)

/** A project as the roadmap kernels see it: its place in the global rank (null = unranked) and its target window (null = none). */
data class PlanProjectFact(val id: UInt, val rankPosition: Int?, val target: DaySpan?)

/** A stored link as the roadmap kernels see it. */
data class PlanLinkFact(val id: UInt, val predecessor: EndpointRef, val successor: EndpointRef, val type: DependencyType, val lagDays: Int)

/**
 * A stored link whose two ends resolve to known projects, with the project each end sits in and its [check] on the planned dates
 * ([RoadmapKernels.checkedLinks]). A link inside one project has equal project ids.
 */
data class CheckedLink(
    val link: PlanLinkFact,
    val predecessorProjectId: UInt,
    val successorProjectId: UInt,
    val check: DependencyCheck,
)

/**
 * The order of a project's flags: WARNING before INFO, then the kind, the team and the other project (ids start at 1), then a Jira
 * flag's deviation kind (the kernel's own order).
 */
val FLAG_ORDER: Comparator<PlanFlag> =
    compareBy({ it.severity }, { it.kind }, { it.teamId ?: 0u }, { it.otherProjectId ?: 0u }, { it.deviation?.kind })

/**
 * The roadmap and programs views' arithmetic as pure functions (no I/O, no clock), the idiom of [SpanKernels] and [LoadKernels]: the
 * derived spans, the drift flags, the rank-inversion flags, the rolled-up links and the flag roll-up. Dates are the STORED calendar
 * days (the inversion rule never looks at working days); the link checks are [DependencyKernels]'s, on working days.
 */
object RoadmapKernels {
    /**
     * Each project's derived span ([SpanKernels.derivedSpan]) over its scheduled milestones. A project with none scheduled is ABSENT
     * from the map (read as no span).
     */
    fun projectSpans(milestones: Collection<PlanMilestoneFact>): Map<UInt, DaySpan> =
        milestones.filter { it.span != null }
            .groupBy({ it.projectId }) { checkNotNull(it.span) }
            .mapValues { (_, spans) -> checkNotNull(SpanKernels.derivedSpan(spans)) }

    /**
     * The drift flags of a project whose derived [span] is measured against its [target] window (none unless both exist): the end
     * later than the target end is a WARNING ([FlagKind.DRIFT_END_LATE]); a start later than the target start
     * ([FlagKind.DRIFT_START_LATE]) and an end ahead of the target end ([FlagKind.DRIFT_END_EARLY]) are INFO; an early start, an
     * on-target edge and a missing window or span raise nothing.
     */
    fun driftFlags(span: DaySpan?, target: DaySpan?): List<PlanFlag> {
        val drift = SpanKernels.drift(span, target) ?: return emptyList()
        return buildList {
            if (drift.endDays > 0) add(PlanFlag(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, drift.endDays.toInt(), null, null))
            if (drift.startDays > 0) add(PlanFlag(FlagKind.DRIFT_START_LATE, FlagSeverity.INFO, drift.startDays.toInt(), null, null))
            if (drift.endDays < 0) add(PlanFlag(FlagKind.DRIFT_END_EARLY, FlagSeverity.INFO, (-drift.endDays).toInt(), null, null))
        }
    }

    /**
     * The rank-inversion flags, by the project they are raised ON (the lower-ranked B; [PlanFlag.otherProjectId] is the higher-ranked A).
     * Only RANKED projects carry them. The WARNING, per team T: the ranked projects with scheduled work on T in rank order, and each
     * ADJACENT pair (A, B) where B's work on T starts STRICTLY before A's raises one flag - `startOn(T, p)` is the earliest stored
     * `start_date` over p's scheduled milestones on T, `days` the difference, a tie no inversion. A chain A > B > C all inverted reads
     * as two flags (B against A, C against B). The INFO, over the ranked projects that have a derived span in rank order: each ADJACENT
     * pair that shares NO team with scheduled work and whose B span starts strictly before A's ([PlanFlag.teamId] null, `days` between
     * the two span starts). A flag is never raised for a project without scheduled work on the team.
     */
    fun inversionFlags(
        projects: Collection<PlanProjectFact>,
        milestones: Collection<PlanMilestoneFact>,
    ): Map<UInt, List<PlanFlag>> {
        val rank = projects.mapNotNull { p -> p.rankPosition?.let { p.id to it } }.toMap()
        val scheduled = milestones.filter { it.span != null && it.projectId in rank }
        val startOn = scheduled.groupBy { it.teamId to it.projectId }.mapValues { (_, own) -> own.minOf { checkNotNull(it.span).start } }
        val flags = mutableMapOf<UInt, MutableList<PlanFlag>>()
        for ((teamId, onTeam) in scheduled.groupBy { it.teamId }) {
            val ordered = onTeam.map { it.projectId }.distinct().sortedBy { rank.getValue(it) }
            for ((a, b) in ordered.zipWithNext()) {
                val earlier = days(startOn.getValue(teamId to b), startOn.getValue(teamId to a)) ?: continue
                flags.getOrPut(b) { mutableListOf() }.add(PlanFlag(FlagKind.RANK_INVERSION, FlagSeverity.WARNING, earlier, teamId, a))
            }
        }
        val spans = projectSpans(scheduled)
        val teamsOf = scheduled.groupBy({ it.projectId }) { it.teamId }.mapValues { it.value.toSet() }
        val ranked = rank.keys.filter { it in spans }.sortedBy { rank.getValue(it) }
        for ((a, b) in ranked.zipWithNext()) {
            if (teamsOf.getValue(a).any { it in teamsOf.getValue(b) }) continue
            val earlier = days(spans.getValue(b).start, spans.getValue(a).start) ?: continue
            flags.getOrPut(b) { mutableListOf() }.add(PlanFlag(FlagKind.RANK_INVERSION, FlagSeverity.INFO, earlier, null, a))
        }
        return flags
    }

    /** How many calendar days [early] lies before [late], or null unless it is strictly before. */
    private fun days(early: LocalDate, late: LocalDate): Int? = ChronoUnit.DAYS.between(early, late).toInt().takeIf { it > 0 }

    /**
     * The Flow capacity flags of the projects (1.23), by project id: per (project, team), ONE [FlagKind.FLOW_CAPACITY_MILESTONES] when
     * at least one SCHEDULED milestone of the project on that team lies in days an open capacity difference of the team covers. A
     * milestone meets a range of its own team when the two share a calendar day, both ends inclusive (the weeks strip's test,
     * [withFlaggedRanges]); an unscheduled milestone has no days and meets nothing. [teamRanges] are the answer's day ranges by team id
     * (a team without an entry has none, so a project is never flagged for a team that has nothing open). The flag's `count` is the
     * project's milestones on that team that meet a range, its severity the worst among the ranges any of them meets; the flags of a
     * project come in team order ([FLAG_ORDER] places them among the project's others).
     */
    fun capacityFlags(
        milestones: Collection<PlanMilestoneFact>,
        teamRanges: Map<UInt, List<FlaggedRange>>,
    ): Map<UInt, List<PlanFlag>> {
        if (teamRanges.values.all { it.isEmpty() }) return emptyMap()
        val hits = milestones.mapNotNull { m ->
            val span = m.span ?: return@mapNotNull null
            val met = teamRanges[m.teamId].orEmpty().filter { !it.start.isAfter(span.end) && !it.end.isBefore(span.start) }
            if (met.isEmpty()) null else Triple(m.projectId, m.teamId, met.minOf { it.severity })
        }
        return hits.groupBy { it.first }.mapValues { (_, own) ->
            own.groupBy { it.second }.toSortedMap().map { (teamId, onTeam) ->
                PlanFlag(
                    kind = FlagKind.FLOW_CAPACITY_MILESTONES,
                    severity = onTeam.minOf { it.third },
                    teamId = teamId,
                    count = onTeam.size,
                )
            }
        }
    }

    /**
     * The teams whose Flow comparison is PENDING (1.26.0), by project id: the distinct team ids ([pendingTeams]), ascending, of the
     * project's SCHEDULED milestones (an unscheduled one has no days to compare, as in [capacityFlags]). A project with none is absent.
     */
    fun flowPendingTeams(milestones: Collection<PlanMilestoneFact>, pendingTeams: Set<UInt>): Map<UInt, List<UInt>> =
        if (pendingTeams.isEmpty()) {
            emptyMap()
        } else {
            milestones.filter { it.span != null && it.teamId in pendingTeams }
                .groupBy({ it.projectId }) { it.teamId }.mapValues { (_, ids) -> ids.distinct().sorted() }
        }

    /**
     * Every link whose two ends resolve, checked, in the order of [links]. Each end resolves to its project (a milestone's own, a
     * project itself) and span (the milestone's dates, the project's derived span from [spans]); a link with an end whose project is not
     * among [projects] is dropped. A link INSIDE one project is kept (the roll-up [aggregate] skips it; the home figures count it).
     * Checked on [calendar]'s working days like the project view's ([DependencyKernels.check]).
     */
    fun checkedLinks(
        links: Collection<PlanLinkFact>,
        projects: Collection<PlanProjectFact>,
        milestones: Collection<PlanMilestoneFact>,
        spans: Map<UInt, DaySpan>,
        calendar: WorkingCalendar,
    ): List<CheckedLink> {
        val known = projects.map { it.id }.toSet()
        val milestoneById = milestones.associateBy { it.id }
        fun resolve(ref: EndpointRef): Pair<UInt, DaySpan?>? = when (ref.kind) {
            EndpointKind.PROJECT -> if (ref.id in known) ref.id to spans[ref.id] else null
            EndpointKind.MILESTONE -> milestoneById[ref.id]?.takeIf { it.projectId in known }?.let { it.projectId to it.span }
        }
        return links.mapNotNull { link ->
            val (predProject, predSpan) = resolve(link.predecessor) ?: return@mapNotNull null
            val (succProject, succSpan) = resolve(link.successor) ?: return@mapNotNull null
            CheckedLink(link, predProject, succProject, DependencyKernels.check(link.type, link.lagDays, predSpan, succSpan, calendar))
        }
    }

    /**
     * The links between PROJECTS, rolled up per ORDERED pair (predecessor project, successor project), ordered by that pair; a link
     * inside one project, or with an end whose project is not among [projects], is skipped. A PROJECT-to-PROJECT link is the pair's
     * `direct` entry; every other link counts in `milestoneLinks`. Checked like the project view's ([checkedLinks]); this is the
     * fold [aggregate] of them.
     */
    fun linkAggregates(
        links: Collection<PlanLinkFact>,
        projects: Collection<PlanProjectFact>,
        milestones: Collection<PlanMilestoneFact>,
        spans: Map<UInt, DaySpan>,
        calendar: WorkingCalendar,
    ): List<RoadmapLink> = aggregate(checkedLinks(links, projects, milestones, spans, calendar))

    /** The roll-up of already [checked] links per ordered project pair ([linkAggregates]'s second half; no I/O, no check is redone). */
    fun aggregate(checked: Collection<CheckedLink>): List<RoadmapLink> {
        val pairs = sortedMapOf<Pair<UInt, UInt>, Bundle>(compareBy<Pair<UInt, UInt>>({ it.first }, { it.second }))
        for (c in checked) {
            if (c.predecessorProjectId == c.successorProjectId) continue
            val link = c.link
            val bundle = pairs.getOrPut(c.predecessorProjectId to c.successorProjectId) { Bundle() }
            if (link.predecessor.kind == EndpointKind.PROJECT && link.successor.kind == EndpointKind.PROJECT) {
                bundle.direct = RoadmapDirectLink(link.id, link.type, link.lagDays, c.check)
            } else {
                bundle.count++
                if (c.check.status == DependencyStatus.VIOLATED) bundle.violated++
                if (c.check.status == DependencyStatus.UNSCHEDULED) bundle.unscheduled++
            }
        }
        return pairs.map { (pair, b) ->
            RoadmapLink(pair.first, pair.second, b.direct, RoadmapLinkBundle(b.count, b.violated, b.unscheduled))
        }
    }

    /** A pair's accumulator while the links are folded. */
    private class Bundle {
        var direct: RoadmapDirectLink? = null
        var count = 0
        var violated = 0
        var unscheduled = 0
    }

    /** The roll-up of a set of [flags]: how many are WARNINGs and how many INFOs. */
    fun flagCounts(flags: Collection<PlanFlag>): FlagCounts =
        FlagCounts(flags.count { it.severity == FlagSeverity.WARNING }, flags.count { it.severity == FlagSeverity.INFO })
}
