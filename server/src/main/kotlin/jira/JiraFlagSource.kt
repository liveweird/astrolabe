package ch.nokillswit.jira

import ch.nokillswit.planning.Deviation
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlagSource
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FLAG_ORDER
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.JiraLink
import ch.nokillswit.planning.JiraSite
import ch.nokillswit.planning.NodeExternal
import ch.nokillswit.planning.PlanFlag

/**
 * The Jira side of the timeline views' [ExternalFlagSource] seam (1.3): the project and milestone rows of a view get their Jira link
 * and their flags from the SAME computation the deviations view runs ([DeviationViewService.computeInTransaction], scoped to the
 * requested nodes), INSIDE the view's own snapshot transaction. It reads only (the deviations tables, `persistence.md`) and takes no
 * lock.
 *
 * What a row gets:
 * - a binding through a DISABLED connection is invisible: no link, no flag, no site (the registry's `enabled` switch stops the
 *   timeline from drawing a source nobody refreshes; its bindings still list on the Deviations page);
 * - [JiraLink] otherwise, whatever the deviations: the observed dates are null when the item was never observed or is `gone`;
 * - one [FlagKind.JIRA_DEVIATION] per deviation while the binding is OPEN (it deviates and its acknowledgement is not CURRENT; an
 *   acknowledgement that went stale raises again), at the deviation's severity; `ESTIMATE_NOT_COMPARABLE` ("a figure exists and cannot
 *   be compared") raises nothing;
 * - on a PROJECT, one [FlagKind.JIRA_MILESTONES] over its milestones that raised a flag: `count` of those milestones, the worst
 *   severity among their deviations. Never one flag per milestone; the detail lives on the project view's rows.
 */
internal class JiraFlagSource(private val deviations: DeviationViewService) : ExternalFlagSource {
    override suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags {
        if (request.isEmpty) return ExternalFlags()
        val scope = DeviationScope(
            levels = setOf(JiraLevel.PROJECT, JiraLevel.MILESTONE),
            projectIds = request.projectIds,
            milestoneIds = request.milestoneIds,
            referencedConnectionsOnly = true,
        )
        val computed = deviations.computeInTransaction(scope, null, request.calendar, deviations.today())
        val enabled = computed.connections.filter { it.enabled }.associateBy { it.id }
        val rows = computed.candidates.filter { it.item.connectionId in enabled }.map { FlagRow(it, it.link(), it.raised()) }

        val milestones = rows.filter { it.candidate.node.ref.level == JiraLevel.MILESTONE }
        val named = request.projectIds?.toSet()
        val rollUps = milestones.filter { it.flags.isNotEmpty() }.groupBy { checkNotNull(it.candidate.node.projectId) }
            .filterKeys { named == null || it in named }
            .mapValues { (_, raising) -> rollUp(raising) }
        val ownProjects = rows.filter { it.candidate.node.ref.level == JiraLevel.PROJECT }.associateBy { it.candidate.node.ref.id }

        val projects = (ownProjects.keys + rollUps.keys).associateWith { id ->
            val own = ownProjects[id]
            NodeExternal(own?.link, (own?.flags.orEmpty() + listOfNotNull(rollUps[id])).sortedWith(FLAG_ORDER))
        }
        val sites = rows.map { it.link.connectionId }.distinct().sorted().map { JiraSite(it, enabled.getValue(it).siteUrl) }
        return ExternalFlags(
            projects = projects,
            milestones = milestones.associate { it.candidate.node.ref.id to NodeExternal(it.link, it.flags) },
            sites = sites,
        )
    }

    /** A live binding of an enabled connection: its link and the flags it raises ([flags] empty = clean, acknowledged or noise only). */
    private class FlagRow(val candidate: Candidate, val link: JiraLink, val flags: List<PlanFlag>)

    private fun Candidate.link(): JiraLink {
        val seen = item.jira
        return JiraLink(
            item.bindingId, item.connectionId, seen.key,
            start = seen.start.takeUnless { seen.gone },
            end = seen.end.takeUnless { seen.gone },
        )
    }

    /** The flags an OPEN binding raises, in [FLAG_ORDER]: the kernel's full list minus the estimate noise; none while acknowledged. */
    private fun Candidate.raised(): List<PlanFlag> =
        if (currentAck) {
            emptyList()
        } else {
            all.filter { it.kind != DeviationKind.ESTIMATE_NOT_COMPARABLE }.map { it.toFlag() }.sortedWith(FLAG_ORDER)
        }

    private fun Deviation.toFlag() = PlanFlag(
        kind = FlagKind.JIRA_DEVIATION,
        severity = if (severity == DeviationSeverity.WARNING) FlagSeverity.WARNING else FlagSeverity.INFO,
        days = null,
        teamId = null,
        otherProjectId = null,
        deviation = this,
    )

    /** One project's roll-up over the milestones in [raising]: how many, at the worst severity any of them raised. */
    private fun rollUp(raising: List<FlagRow>): PlanFlag = PlanFlag(
        kind = FlagKind.JIRA_MILESTONES,
        severity = raising.flatMap { it.flags }.minOf { it.severity },
        days = null,
        teamId = null,
        otherProjectId = null,
        count = raising.size,
    )
}
