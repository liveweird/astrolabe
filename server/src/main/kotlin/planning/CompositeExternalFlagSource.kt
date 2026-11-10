package ch.nokillswit.planning

/**
 * Several [ExternalFlagSource]s behind one (1.9): the composition root builds `[Jira, Flow]` and hands the composite to the four
 * timeline views, so a view asks ONE source and neither tracker's package is named by `planning`. Every source gets the same
 * [ExternalFlagRequest] (and so the same snapshot) and each answers only what it knows; the answers are merged per node: the link is the
 * first non-null one ([NodeExternal.jira]), the flags are every source's, in [FLAG_ORDER]; per team the flags likewise and the ranges
 * concatenated; the [ExternalFlags.sites] are the union, one per connection, by connection id. A source with nothing to say adds nothing.
 */
class CompositeExternalFlagSource(private val sources: List<ExternalFlagSource>) : ExternalFlagSource {
    override suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags {
        val answers = sources.map { it.flagsInTransaction(request) }
        return ExternalFlags(
            projects = mergeNodes(answers.map { it.projects }),
            milestones = mergeNodes(answers.map { it.milestones }),
            sites = answers.flatMap { it.sites }.distinctBy { it.connectionId }.sortedBy { it.connectionId },
            teams = answers.flatMap { it.teams.keys }.distinct().associateWith { id ->
                val own = answers.mapNotNull { it.teams[id] }
                TeamExternal(own.flatMap { it.flags }.sortedWith(FLAG_ORDER), own.flatMap { it.ranges })
            },
        )
    }

    private fun mergeNodes(maps: List<Map<UInt, NodeExternal>>): Map<UInt, NodeExternal> =
        maps.flatMap { it.keys }.distinct().associateWith { id ->
            val own = maps.mapNotNull { it[id] }
            NodeExternal(own.firstNotNullOfOrNull { it.jira }, own.flatMap { it.flags }.sortedWith(FLAG_ORDER))
        }
}
