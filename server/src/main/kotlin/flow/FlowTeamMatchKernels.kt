package ch.nokillswit.flow

import java.util.Locale

/**
 * The team binding's match by name (pure, no clock, no database): which Flow team belongs to which Astrolabe team by NAME alone.
 *
 * - The fold is trim, collapse every run of whitespace (Unicode: a no-break space too) to one space, lowercase. **Accents count**:
 *   "Płatności" and "Platnosci" are
 *   different teams (a wrong automatic link is worse than a missing one; the person links the rest by hand).
 * - A Flow team has a suggestion when its folded name equals the folded name of EXACTLY ONE of [FlowTeamMatchKernels.suggest]'s
 *   candidate teams. The caller passes only the UNBOUND Flow teams and the UNBOUND, ACTIVE Astrolabe teams, so a bound team is never
 *   re-suggested and a team whose name two candidates share (Astrolabe's own index is case-insensitive, but a name that differs only in
 *   whitespace is allowed) gets no suggestion.
 * - The rule is symmetric: two Flow teams that fold to the same name suggest nothing (Flow keeps names unique among its active teams, but
 *   case and spacing are not part of that), so "Link all suggested" can never ask for one Astrolabe team twice.
 */
object FlowTeamMatchKernels {
    // Unicode-aware: `\s` alone misses U+00A0 (a no-break space pasted from a document) and the other `Z` separators.
    private val WHITESPACE = Regex("[\\s\\p{Z}]+")

    /** The comparison form of a team name. */
    fun fold(name: String): String = name.trim().replace(WHITESPACE, " ").lowercase(Locale.ROOT)

    /** Flow team id to the id of the one Astrolabe team it matches; a Flow team without a unique counterpart is absent from the map. */
    fun suggest(flowTeams: List<Pair<Int, String>>, teams: List<Pair<UInt, String>>): Map<Int, UInt> {
        val teamsByName = teams.groupBy({ fold(it.second) }, { it.first })
        val flowByName = flowTeams.groupBy({ fold(it.second) }, { it.first })
        val suggestions = LinkedHashMap<Int, UInt>()
        for ((name, flowIds) in flowByName) {
            val candidates = teamsByName[name] ?: continue
            if (flowIds.size == 1 && candidates.size == 1) suggestions[flowIds.single()] = candidates.single()
        }
        return suggestions
    }
}
