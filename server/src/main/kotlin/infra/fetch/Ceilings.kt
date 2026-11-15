package ch.nokillswit.infra.fetch

// The page ceiling of the loops that follow an upstream's paging. Every failure is a `FetchException` of the caller's
// [FetchSource]. (Flow's answer and run ceilings, its halving of an oversized batch and its single-id `SkipBudget` are stream-only
// and not ported: Astrolabe reads whole pages, so an oversized response simply fails the run with `LIMIT_EXCEEDED`.)

/** The typed failure of the page ceiling: `LIMIT_EXCEEDED`, so it ends the run. */
internal fun answerCeilingExceeded(source: FetchSource, endpoint: String, what: String) =
    FetchException(source, FetchCodes.LIMIT_EXCEEDED, null, endpoint, "answer ceiling: $what")

/**
 * The page ceiling alone, for a loop that follows a host's paging and holds nothing (or something else bounds what it holds):
 * call [next] before fetching each page and the [maxPages]+1th throws `LIMIT_EXCEEDED`. One object per answer (or per run, for a
 * feed), never shared across loops.
 */
internal class PageCeiling(
    private val source: FetchSource,
    private val endpoint: String,
    private val maxPages: Int,
    private val what: String = "pages",
) {
    private var pages = 0

    fun next() {
        if (++pages > maxPages) throw answerCeilingExceeded(source, endpoint, "more than $maxPages $what")
    }
}
