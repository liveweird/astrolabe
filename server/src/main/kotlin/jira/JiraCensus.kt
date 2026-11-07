package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.LIMIT_EXCEEDED_CODE
import ch.nokillswit.sync.ClaimedRun
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

private const val MILLIS_PER_HOUR = 3_600_000L

/** The run's search, as the census calls it: the observer's shared pager with its per-page stop and call tally. */
internal typealias CensusSearch = suspend (jql: () -> String, fields: String, onPage: suspend (JsonArray) -> Unit) -> Unit

/** The numeric id of a search entry (`{"id": "10001"}`), or null for anything else. */
internal fun idOf(element: JsonElement?): String? =
    ((element as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull?.takeIf(ISSUE_ID_PATTERN::matches)

/** How a run lists the child level: every issue in full, the ids only, or not at all. */
internal enum class ChildPass { FULL, SWEEP, NONE }

/**
 * One run's census (`jira_issues`, V23): the mapped levels' issues the run's read pages through anyway, plus the CHILD level - the stories
 * under the milestone level - that the roll-ups count. It observes every page entry ([observe]), prunes what the sweeps no longer list and
 * reads the children ([complete]); the reads and the writes are the run's own (a short transaction per chunk, never across a call,
 * never the plan lock). The child level is `milestone.hierarchyLevel - 1` when that is not below 0 and the site has non-sub-task types
 * there with ids a JQL clause can name; a milestone mapped to level 0 has none. A row is kept only for a type the run's sweeps ask for
 * ([mappedTypeIds] and the child types): an issue of any other type is invisible to the sweeps and would flap in and out of the mirror.
 * Nothing it logs names an issue: counts and codes only.
 */
internal class JiraCensus(
    private val store: JiraIssueStore,
    private val run: ClaimedRun,
    private val keys: List<String>,
    private val discovery: JiraDiscovery,
    mapping: JiraMapping,
    /** The type ids of the mapped levels (the mapped sweep's clause). */
    mappedTypeIds: List<String>,
    private val now: () -> Long,
    /** The rows one write transaction carries ([RUN_CHUNK]); a test shrinks it. */
    private val chunkSize: Int = RUN_CHUNK,
) {
    private val mappedLevels: Set<Int> = mapping.mappedLevels().map { it.second.hierarchyLevel }.toSet()

    /** The Jira hierarchy level whose issues roll up into a milestone's epic, or null (none / no usable type id). */
    val childLevel: Int? = (mapping.levels.milestone.hierarchyLevel - 1).takeIf { it >= 0 && childTypeIdsAt(it).isNotEmpty() }
    val childTypeIds: List<String> = childLevel?.let(::childTypeIdsAt).orEmpty()
    private val censusLevels: Set<Int> = mappedLevels + listOfNotNull(childLevel)
    private val keptTypes: Set<String> = (mappedTypeIds + childTypeIds).toSet()

    /** The story-points field the reads name beside the system fields: the discovery's number-typed marker, if its id is plausible. */
    private val pointsFieldId: String? =
        discovery.markers.storyPoints?.takeIf { it.type == "number" }?.id?.takeIf(FIELD_ID_PATTERN::matches)
    val childFields: String = (listOf(ISSUE_SYSTEM_FIELDS) + listOfNotNull(pointsFieldId)).joinToString(",")

    private val buffer = LinkedHashMap<String, CensusIssue>()
    private val seen = HashSet<String>()
    private var mappedWritten = 0
    private var childWritten = 0
    private var pruned = 0

    private fun childTypeIdsAt(level: Int): List<String> =
        discovery.typeIdsAtLevel(level).takeIf { ids -> ids.all(JiraJql::isTypeId) }.orEmpty()

    /**
     * The mapped read's `fields` plus the story-points field: the incremental window returns stories too, and a story's points come from
     * the marker whatever field the milestone's estimate is mapped to (else an update would store its points as null).
     */
    fun withPointsField(fields: String): String =
        if (pointsFieldId == null || pointsFieldId in fields.split(',')) fields else "$fields,$pointsFieldId"

    /** Whether the child level is due for its id sweep: never swept, or [censusHours] or more since the stamp. */
    fun due(censusAt: Long?, censusHours: Int): Boolean = censusAt == null || now() - censusAt >= censusHours * MILLIS_PER_HOUR

    /** Buffers an entry as a census row when its level and type are the census's (every entry, bound or not), flushing per chunk. */
    suspend fun observe(issue: JsonObject) {
        val row = CensusIssue.of(issue, discovery, pointsFieldId, now())
            ?.takeIf { it.hierarchyLevel in censusLevels && it.typeId in keptTypes } ?: return
        seen += row.issueId
        buffer[row.issueId] = row
        if (buffer.size >= chunkSize) flush()
    }

    /** Writes what is buffered (one transaction); a connection deleted since the run started writes nothing. */
    suspend fun flush() {
        if (buffer.isEmpty()) return
        val rows = buffer.values.toList()
        buffer.clear()
        if (store.upsert(run.connectionId, rows) == 0) return
        childWritten += rows.count { it.hierarchyLevel == childLevel }
        mappedWritten += rows.count { it.hierarchyLevel != childLevel }
    }

    /**
     * After the run's mapped read and sweep: flush, prune the mirror rows the sweep no longer lists at the mapped levels (an empty listing
     * prunes too: the sweep's WARN covers it) and, on a [fullRead], the rows of a level that is no census level any more, then list the
     * children - in full on a [fullRead], as an id sweep when [due]. `census_at` is stamped with the run's start after a full read
     * (even without a child level, else it stays null and every run is full) or a completed sweep; it is CLEARED instead when a sweep
     * listed an in-scope id the mirror lacks and this run did not read (rows lost to an earlier false-empty or partial listing, or
     * issues that arrived unseen), so the next run is full and re-seeds. A failing children pass (a typed failure other than the ceiling)
     * never fails the run: it warns with the code and counts, skips its prune and the stamp, and the next run tries again; a
     * deleted or disabled connection still ends the run (the observer's per-page stop).
     */
    suspend fun complete(search: CensusSearch, inScope: Set<String>, fullRead: Boolean, censusAt: Long?, censusHours: Int) {
        flush()
        val index = store.index(run.connectionId)
        var gap = !fullRead && inScope.any { it !in index && it !in seen }
        prune(index) { id, level -> level in mappedLevels && id !in inScope }
        if (fullRead) prune(index) { _, level -> level !in censusLevels }
        val pass = when {
            childTypeIds.isEmpty() -> ChildPass.NONE
            fullRead -> ChildPass.FULL
            due(censusAt, censusHours) -> ChildPass.SWEEP
            else -> ChildPass.NONE
        }
        var stamp = fullRead
        try {
            when (pass) {
                ChildPass.FULL -> readChildren(search, index)
                ChildPass.SWEEP -> gap = sweepChildren(search, index) || gap
                ChildPass.NONE -> Unit
            }
            stamp = stamp || pass != ChildPass.NONE
        } catch (failure: FetchException) {
            log.warn("Sync run {} children census failed: {} (roll-ups may be incomplete, retried by the next run)", run.id, failure.code)
            stamp = false
        }
        if (gap) store.stampCensus(run.connectionId, null) else if (stamp) store.stampCensus(run.connectionId, run.startedAt)
        log.info("Sync run {} census: issues={} children={} pruned={} childPass={}", run.id, mappedWritten, childWritten, pruned, pass)
    }

    /** The typed full read of the child level: every row upserted, then the child rows not read pruned - unless a ceiling cut it. */
    private suspend fun readChildren(search: CensusSearch, index: Map<String, Int>) {
        var pages = 0
        var count = 0
        val finished = try {
            listing(search, { JiraJql.full(keys, childTypeIds) }, childFields) { issues ->
                pages++
                count += issues.size
                issues.forEach { (it as? JsonObject)?.let { issue -> observe(issue) } }
            }
        } finally {
            flush() // what was read before a failure is kept (whole rows, a short transaction)
        }
        finish(finished, pages, count, index) { _, level -> level == childLevel }
    }

    /**
     * The id-only typed listing of the child level: the child rows neither listed nor seen this run are pruned (unless truncated).
     * True when it listed an id the mirror lacks and this run did not read.
     */
    private suspend fun sweepChildren(search: CensusSearch, index: Map<String, Int>): Boolean {
        var pages = 0
        val listed = HashSet<String>()
        val finished = listing(search, { JiraJql.sweep(keys, childTypeIds) }, "id") { issues ->
            pages++
            issues.forEach { idOf(it)?.let(listed::add) }
        }
        finish(finished, pages, listed.size, index) { id, level -> level == childLevel && id !in listed }
        return finished && listed.any { it !in index && it !in seen }
    }

    /** A finished listing prunes the child rows it did not see; a truncated one keeps everything and warns (counts only). */
    private suspend fun finish(finished: Boolean, pages: Int, count: Int, index: Map<String, Int>, doomed: (String, Int) -> Boolean) {
        if (finished) {
            prune(index, doomed)
        } else {
            log.warn(
                "Sync run {} children census truncated at {} pages after {} child issue(s) (a listing or response ceiling): " +
                    "roll-ups may be incomplete",
                run.id, pages, count,
            )
        }
    }

    /**
     * Runs one listing; false when a ceiling (`LIMIT_EXCEEDED`: the 200 pages, or a response past the byte cap) cut it - the children's
     * read keeps what it has (the mapped read keeps its own rule). Any other failure propagates to [complete].
     */
    private suspend fun listing(search: CensusSearch, jql: () -> String, fields: String, onPage: suspend (JsonArray) -> Unit): Boolean =
        try {
            search(jql, fields, onPage)
            true
        } catch (failure: FetchException) {
            if (failure.code == LIMIT_EXCEEDED_CODE) false else throw failure
        }

    /** Deletes the [index] rows that are [doomed] and not seen this run, in [chunkSize] batches. */
    private suspend fun prune(index: Map<String, Int>, doomed: (String, Int) -> Boolean) {
        val stale = index.filter { (id, level) -> id !in seen && doomed(id, level) }.keys
        stale.chunked(chunkSize).forEach { pruned += store.delete(run.connectionId, it) }
    }
}
