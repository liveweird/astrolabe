package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import kotlinx.serialization.json.JsonObject

// The filtered browse's parent reads (1.13.2). The filter narrows EVERY mapped level in the search, so a done or quiet parent of an item
// that is read is not in the listing; the planner would put the child under the default parent (or skip it). Each such direct parent is
// fetched BY ID (`GET /issue/{id}`, the gone probe's call), at most twice along a chain (three mapped levels), and kept. Only the import
// browse does this; nothing here touches the plan or stores anything.

/** The filter and what a round of reads asks the plan side: which of a list of issue ids a live binding already holds. */
internal class ImportBrowseFilter(val filter: JiraImportFilter, val liveHeld: suspend (Collection<String>) -> Set<String>)

/** One chain step of the mapping is read per round: a milestone's project, then that project's program. */
private const val PARENT_ROUNDS = 2

/** [childId] names [parentId] as its direct Jira parent, which sits at plan level [wanted] (and is neither a row nor tried yet). */
internal class ParentCandidate(val childId: String, val parentId: String, val wanted: JiraLevel)

/** The plan level directly above [level]; null for a program (the picked work stream is its parent, never an issue). */
private fun levelAbove(level: JiraLevel?): JiraLevel? = when (level) {
    JiraLevel.MILESTONE -> JiraLevel.PROJECT
    JiraLevel.PROJECT -> JiraLevel.PROGRAM
    else -> null
}

/**
 * The (child, parent) pairs whose parent is a candidate for a read by id (pure): the child sits at a mapped level below the top one, the
 * level directly above it is mapped, it names a direct parent (`fields.parent.id`) that is not among [known] (the rows already held), the
 * parent's key when the child carries it is inside [keys] (`isInScope`: a parent of another project stays outside the import) and its
 * level when the child's `parent` member tells it is the wanted one (when it does not, the parent is read anyway: the read never depends on
 * the type object being complete). Whether either is already linked, or already tried, is [parentsToRead]'s.
 */
internal fun parentCandidates(
    children: Collection<ImportBrowsedIssue>,
    known: Set<String>,
    mapping: JiraMapping,
    discovery: JiraDiscovery,
    keys: List<String>,
): List<ParentCandidate> {
    val mapped = mapping.mappedLevels().mapTo(HashSet()) { it.first }
    return children.mapNotNull { child ->
        val observation = child.observation
        val wanted = levelAbove(mapping.levelAt(observation.hierarchyLevel))?.takeIf { it in mapped }
        val parentId = observation.parentIssueId?.takeIf { it !in known }
        val parentKey = observation.parentIssueKey
        val level = discovery.hierarchyLevelOf(child.parentTypeId, child.parentTypeHierarchyLevel)
        val fits = wanted != null && parentId != null && (parentKey == null || isInScope(parentKey, keys)) &&
            (level == null || mapping.levelAt(level) == wanted)
        if (fits) ParentCandidate(observation.issueId, checkNotNull(parentId), checkNotNull(wanted)) else null
    }
}

/**
 * The parent ids a round reads, in ascending numeric order, each once (pure): a candidate whose child is itself linked to a live node
 * (the planner makes it `ALREADY_BOUND` before it looks for a parent) or whose parent is linked (the planner lands the child through that
 * link) costs no read, and neither does a parent [tried] before.
 */
internal fun parentsToRead(candidates: List<ParentCandidate>, linked: Set<String>, tried: Set<String>): List<String> =
    candidates.filter { it.childId !in linked && it.parentId !in linked && it.parentId !in tried }
        .map { it.parentId }.distinct().sortedWith(ID_ORDER)

/** What one by-id read of a parent came to. */
private sealed interface Fetched {
    class Kept(val issue: ImportBrowsedIssue) : Fetched

    /** A readable issue that is no parent for this import (another project or level): its child is the orphan it would be today. */
    data object Dropped : Fetched

    /** `404` (deleted, or not visible to the connection's account), or a `200` that is not the issue asked for: it cannot be read. */
    data object Unreadable : Fetched
}

/**
 * The parent reads of ONE browse: at most [MAX_IMPORT_PARENT_READS] by id, one after the other, [beforeRead] (the connection's liveness)
 * before each; the rows (what the search kept plus every parent kept) never pass [cap]. Past either bound [readInto] answers `true` and
 * the browse is truncated. A `404` flags the child ([ImportBrowsedIssue.parentUnreadable]) and is never retried; any other failure
 * (a `403` included: it says nothing of the one issue, the account's scope is wrong) leaves as the [FetchException] the route answers
 * `502`. A fetched document is used only when its `id` is the one asked for,
 * its key is inside [keys] and its level is the wanted one of a child that named it.
 */
internal class ParentReads(
    private val client: JiraClient,
    private val filter: ImportBrowseFilter,
    private val mapping: JiraMapping,
    private val discovery: JiraDiscovery,
    private val keys: List<String>,
    private val now: Long,
    private val beforeRead: suspend () -> Unit,
    private val cap: Int,
) {
    private val fields = observationFields(mapping)
    private val tried = HashSet<String>()
    private val unreadable = HashSet<String>()
    private var reads = 0

    /** Adds the missing parents of [rows] to it, two rounds at most; whether a bound stopped the reading. */
    suspend fun readInto(rows: LinkedHashMap<String, ImportBrowsedIssue>): Boolean {
        var children: List<ImportBrowsedIssue> = rows.values.toList()
        repeat(PARENT_ROUNDS) {
            val candidates = parentCandidates(children, rows.keys, mapping, discovery, keys)
            if (candidates.isEmpty()) return false
            val linked = filter.liveHeld(candidates.flatMap { listOf(it.childId, it.parentId) }.distinct())
            val added = ArrayList<ImportBrowsedIssue>()
            val wanted = candidates.groupBy({ it.parentId }, { it.wanted })
            for (parentId in parentsToRead(candidates, linked, tried)) {
                if (reads >= MAX_IMPORT_PARENT_READS || rows.size >= cap) {
                    // The 404s of this round are real verdicts: their children are flagged even though the browse is cut here.
                    flagUnreadable(candidates, linked, rows)
                    return true
                }
                beforeRead()
                reads++
                tried += parentId
                when (val read = fetch(parentId, wanted.getValue(parentId).toSet())) {
                    is Fetched.Kept -> {
                        rows[parentId] = read.issue
                        added += read.issue
                    }
                    Fetched.Dropped -> Unit
                    Fetched.Unreadable -> unreadable += parentId
                }
            }
            flagUnreadable(candidates, linked, rows)
            children = added
        }
        return false
    }

    private suspend fun fetch(id: String, wanted: Set<JiraLevel>): Fetched {
        val document = try {
            client.issue(id, fields)
        } catch (failure: FetchException) {
            // Only a 404 is a verdict on this one issue; a 403 (FORBIDDEN_SCOPE) says the account lacks the scope, as for the search.
            if (goneReasonFor(failure.code) == GONE_DELETED) return Fetched.Unreadable else throw failure
        }
        return kept(document, id, wanted)
    }

    private fun kept(document: JsonObject, id: String, wanted: Set<JiraLevel>): Fetched {
        if (document["id"].text(MAX_ID) != id) return Fetched.Unreadable
        val issue = browsedIssue(document, mapping, discovery, now) ?: return Fetched.Dropped
        val observation = issue.observation
        if (!isInScope(observation.issueKey, keys) || mapping.levelAt(observation.hierarchyLevel) !in wanted) return Fetched.Dropped
        return Fetched.Kept(issue.copy(keptAsParent = !filter.filter.admits(observation, now)))
    }

    private fun flagUnreadable(candidates: List<ParentCandidate>, linked: Set<String>, rows: LinkedHashMap<String, ImportBrowsedIssue>) {
        for (candidate in candidates) {
            if (candidate.parentId in unreadable && candidate.childId !in linked) {
                rows.computeIfPresent(candidate.childId) { _, child -> child.copy(parentUnreadable = true) }
            }
        }
    }
}
