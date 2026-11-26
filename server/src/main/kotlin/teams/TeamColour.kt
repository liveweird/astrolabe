package ch.nokillswit.teams

/**
 * A team's colour (V35): one key of a fixed palette of twelve, in ASSIGNMENT order. The keys are stored by name (`teams.colour`,
 * `ck_teams_colour`) and are never renamed or removed; the SPA draws each in a light and a dark shade (`.claude/docs/team-colours.md`).
 * The order is the migration's backfill order and the tie-break of [leastUsed].
 */
enum class TeamColour {
    INDIGO,
    TEAL,
    LIME,
    RASPBERRY,
    GRAPE,
    PINK,
    VIOLET,
    COBALT,
    AZURE,
    LAVENDER,
    SAPPHIRE,
    GREEN,
    ;

    companion object {
        /**
         * The colour the fewest of [counts] (teams per colour, a colour absent = 0) name; a tie goes to the earlier palette position.
         * Pure: the caller counts the ACTIVE teams.
         */
        fun leastUsed(counts: Map<TeamColour, Int>): TeamColour =
            entries.minWith(compareBy<TeamColour> { counts[it] ?: 0 }.thenBy { it.ordinal })
    }
}
