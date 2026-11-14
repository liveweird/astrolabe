package ch.nokillswit.jira

/**
 * The suggested match of the import preview (1.15): which CREATE row looks like which unlinked plan item, by a deliberately STRICT rule.
 * Pure and deterministic: integer arithmetic over the names folded by [JiraImportKernels.foldName], no weights, and the answer never
 * depends on the order of the rows or of the nodes.
 *
 * Two names are [similar] when they have the same WORDS (a word is a run of letters and digits after the fold, so case, accents,
 * punctuation and word order do not count); the longer name may only ADD words (the shorter one's words all occur in it, as a multiset);
 * the shorter holds at least half of the longer's letters; and the NUMBERING words (those with a number character - any Unicode `\p{N}`,
 * the class the words are split on, so "x²" is numbering too -, a single character, or a Roman numeral from ii to ix; "i", "v" and "x"
 * are single characters anyway) are the same multiset on both sides: "Team A" is never "Team B", "Phase" never "Phase II". A Roman
 * numeral ABOVE ix is an ordinary word: "Phase" / "Phase XII" ARE similar (the longer name only adds a word), while "Phase XII" /
 * "Phase II" are not (numbering differs). A replaced word and a typo are NOT matched (a later, typo-tolerant version is a backlog
 * item). A row is paired with a node only when the pair is unique both ways inside its sibling scope: one candidate for the row, and the
 * row is the only one that candidate is similar to.
 *
 * WORK BUDGET: a scope whose comparisons would exceed [MAX_MATCH_WORK] gets no suggestion at all (deterministic: the work is a function
 * of the names alone), so thousands of siblings that share many words with thousands of rows cannot make a preview slow.
 */
internal object ImportNameMatch {
    private val NON_WORD = Regex("[^\\p{L}\\p{N}]+")
    private val ROMAN = setOf("ii", "iii", "iv", "vi", "vii", "viii", "ix")
    private val NUMBER = Regex("\\p{N}")

    /**
     * The most (row, node-sharing-a-word) pairs one scope may look at, summed over the rows' words (a word counts once per row). Past it
     * [pairs] answers nothing. 5,000,000 is about 2.5x the plan-sized vector of 2,000 rows against 1,000 siblings sharing one word.
     */
    const val MAX_MATCH_WORK = 5_000_000L

    /** A name taken apart once: its words with their counts, the numbering words (sorted) and the summed length of all words. */
    internal class Words(name: String) {
        val counts: Map<String, Int>
        val numbering: List<String>
        val letters: Int

        init {
            val words = words(name)
            counts = words.groupingBy { it }.eachCount()
            numbering = words.filter(::isNumbering).sorted()
            letters = words.sumOf { it.length }
        }

        val empty: Boolean get() = counts.isEmpty()
    }

    /** The words of [name]: folded, split on every run of non-letters and non-digits, empty parts dropped. */
    fun words(name: String): List<String> = JiraImportKernels.foldName(name).split(NON_WORD).filter { it.isNotEmpty() }

    private fun isNumbering(word: String): Boolean = word.length == 1 || NUMBER.containsMatchIn(word) || word in ROMAN

    fun similar(a: String, b: String): Boolean = similar(Words(a), Words(b))

    internal fun similar(a: Words, b: Words): Boolean {
        if (a.empty || b.empty || a.numbering != b.numbering) return false
        val (shorter, longer) = if (a.letters <= b.letters) a to b else b to a
        if (2 * shorter.letters < longer.letters) return false
        return shorter.counts.all { (word, count) -> (longer.counts[word] ?: 0) >= count }
    }

    /**
     * The pairs of one sibling scope, keyed by the row's id: a [rows] entry (id, name) maps to a [nodes] entry's id only when it is the
     * ONLY node similar to the row and the row is the ONLY row similar to that node. Nodes are looked up through a word index, so a row
     * is compared only with the nodes it shares a word with. Past [MAX_MATCH_WORK] the scope gets no pair at all.
     */
    fun <R, N> pairs(rows: List<Pair<R, String>>, nodes: List<Pair<N, String>>): Map<R, N> {
        val preparedNodes = nodes.map { Words(it.second) }
        val index = HashMap<String, MutableList<Int>>()
        preparedNodes.forEachIndexed { at, words -> words.counts.keys.forEach { index.getOrPut(it) { ArrayList() }.add(at) } }
        val preparedRows = rows.map { Words(it.second) }
        val work = preparedRows.sumOf { words -> words.counts.keys.sumOf { (index[it]?.size ?: 0).toLong() } }
        if (work > MAX_MATCH_WORK) return emptyMap()
        val candidates = preparedRows.map { words ->
            words.counts.keys.flatMap { index[it].orEmpty() }.distinct().filter { similar(words, preparedNodes[it]) }
        }
        val rowsPerNode = IntArray(nodes.size)
        candidates.forEach { list -> list.forEach { rowsPerNode[it]++ } }
        val pairs = LinkedHashMap<R, N>()
        rows.forEachIndexed { at, (id, _) ->
            val only = candidates[at].singleOrNull()
            if (only != null && rowsPerNode[only] == 1) pairs[id] = nodes[only].first
        }
        return pairs
    }

    /** [row] (a CREATE) as it is shown with a suggestion for [node]: nothing else about it changes. */
    fun suggested(row: ImportRow, node: ImportPlanNode): ImportRow =
        row.copy(item = row.item.copy(suggestion = JiraImportSuggestion(node.id, node.name)))

    /**
     * [row] (a CREATE) as the BIND to [node] the user confirmed: the natural BIND row's shape (no estimate, dates, team, window or
     * schedule; the parent stays) with the infos a BIND keeps and [JiraImportInfo.MATCH_CONFIRMED]. Its releases (dead holders of the
     * issue) stay: a BIND releases them as a CREATE does.
     */
    fun confirmed(row: ImportRow, node: ImportPlanNode): ImportRow {
        val kept = row.item.infos.filter { it in BIND_INFOS }
        val item = row.item.copy(
            action = JiraImportAction.BIND,
            target = JiraImportTarget(node.id, node.name),
            estimateMd = null,
            startDate = null,
            endDate = null,
            team = null,
            canSchedule = false,
            scheduled = false,
            infos = kept + JiraImportInfo.MATCH_CONFIRMED,
            suggestion = null,
        )
        return row.copy(item = item, estimate = null, span = null, window = null)
    }

    private val BIND_INFOS = setOf(JiraImportInfo.NAME_TRUNCATED, JiraImportInfo.KEPT_AS_PARENT, JiraImportInfo.PARENT_UNREADABLE)
}
