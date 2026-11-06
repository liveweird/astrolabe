package ch.nokillswit.jira

/** Jira's hierarchy levels the defaults aim at: an Epic is 1 (a milestone), an Initiative 2 (a project), the Premium level above it 3. */
private const val EPIC_LEVEL = 1
private const val STORY_LEVEL = 0
private const val INITIATIVE_LEVEL = 2
private const val PROGRAM_LEVEL = 3

/**
 * The mapping a site gets until an admin saves one - PURE, derived only from the stored discovery's markers (`resolveMarkers` already did
 * the name and `schema.custom` matching, so nothing is re-derived here). Jira Plans' fields lead (A1: "Target start"/"Target end"), then
 * the classic ones: start = Target start, else Start date; end = Target end, else `duedate`; a candidate counts only when it is a `date`
 * field (the validator refuses anything else, A5), so a default is always savable. The estimate is the story-points field (first by the
 * site's order: "Story Points" and "Story point estimate" both match, the first listed wins) on the MILESTONE only - program and project
 * figures are derived from their milestones. Levels: milestone = Epic (1) if the site has one, else Story/Task/Bug (0); project = 2 and
 * program = 3 when present. The Team field is the `atlassian-team` one. The unit is POINTS with no factor: nothing assumes points convert.
 */
object JiraMappingDefaults {
    fun resolve(discovery: JiraDiscovery): JiraMapping {
        val markers = discovery.markers
        val start = firstDate(markers.targetStart, markers.startDate)
        val end = firstDate(markers.targetEnd, markers.dueDate)
        val estimate = markers.storyPoints?.takeIf { it.type == "number" }?.id
        fun level(hierarchyLevel: Int, withEstimate: Boolean) = JiraLevelMapping(
            hierarchyLevel,
            JiraLevelFields(start, end, estimate.takeIf { withEstimate }),
        )
        val milestoneLevel = if (discovery.hasLevel(EPIC_LEVEL)) EPIC_LEVEL else STORY_LEVEL
        return JiraMapping(
            levels = JiraMappingLevels(
                program = PROGRAM_LEVEL.takeIf(discovery::hasLevel)?.let { level(it, withEstimate = false) },
                project = INITIATIVE_LEVEL.takeIf(discovery::hasLevel)?.let { level(it, withEstimate = false) },
                milestone = level(milestoneLevel, withEstimate = true),
            ),
            estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, null),
            teamFieldId = markers.team?.id,
        )
    }

    private fun firstDate(vararg candidates: DiscoveredField?): String? = candidates.firstOrNull { it?.type == "date" }?.id
}
