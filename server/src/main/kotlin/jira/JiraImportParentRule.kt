package ch.nokillswit.jira

/** Where a created row lands. [nodeId] is null for the new node of another row; [rowJiraId] names the batch row a parent depends on. */
internal class Parent(val kind: JiraImportParentKind, val nodeId: UInt?, val nodeName: String, val rowJiraId: String?) {
    /** The sibling scope: every row landing under the same node (or under the same new row) shares a name space. */
    val key: String get() = nodeId?.let { "node$it" } ?: "row$rowJiraId"

    fun toWire() = JiraImportParent(kind, nodeId, nodeName, rowJiraId)
}

/**
 * The parent search's answer: a [parent], or none ([skipped] = the Jira parent is in the browse and its row was skipped; [outsideRoot] =
 * the parent is an existing plan node outside a rooted import's subtree).
 */
internal class ParentLookup(val parent: Parent?, val skipped: Boolean = false, val outsideRoot: Boolean = false)

/**
 * The parent search of one planner run ([ImportPlanner], split out like [ImportTicks]): where a row's created node lands, the root rule
 * and the default parent. [rowsById] is the planner's own live map of the rows decided so far (read here, written there); [byId] the browse
 * by Jira id, [holders] the bindings' holders by Jira id.
 *
 * THE PARENT RULE reads only the issue's DIRECT Jira parent (`fields.parent` holds nothing further), and only at the parent's plan
 * level (project for a milestone, program for a project). The real browse reads only the issue types of the MAPPED levels, so a level
 * the mapping skips is never in the browse: an epic under an unmapped initiative under a mapped program has a direct parent that is
 * not at the project level, which makes it a genuine orphan - the default parent, else NO_PARENT. (Jira levels only rise up the chain
 * and mapped levels are never adjacent to a browsed one in between, so walking further up could never find the wanted level.)
 * A direct parent that IS in the browse but has no usable row (any skip but ALREADY_BOUND, whatever the ids' order) makes the child
 * PARENT_SKIPPED, never a default.
 *
 * THE ROOT RULE (1.15, [ImportInput.root]): an import started from a linked item writes only under that item, for every caller. Whenever
 * a row's resolved parent is an EXISTING plan node outside the root's subtree (see [isOutsideRoot]) the row is OUTSIDE_ROOT, never
 * created or bound there. A parent that is a NEW row of the batch needs no check (that row was checked).
 */
internal class ImportParentRule(
    private val input: ImportInput,
    private val byId: Map<String, ImportBrowsedIssue>,
    private val holders: Map<String, List<ImportHolder>>,
    private val rowsById: Map<String, ImportRow>,
) {
    private val mapping = input.mapping
    private val tree = input.snapshot.tree

    /** The projects of a PROGRAM root (a milestone may land only under one of them). */
    private val rootProjectIds: Set<UInt> = input.root?.takeIf { it.level == JiraLevel.PROGRAM }
        ?.let { root -> tree.projects.filter { it.parentId == root.nodeId }.mapTo(HashSet()) { it.id } }.orEmpty()
    private val nodeIdsByLevel = mapOf(
        JiraLevel.PROGRAM to tree.programs.mapTo(HashSet()) { it.id },
        JiraLevel.PROJECT to tree.projects.mapTo(HashSet()) { it.id },
        JiraLevel.MILESTONE to tree.milestones.mapTo(HashSet()) { it.id },
    )

    fun parentOf(issue: ImportBrowsedIssue, level: JiraLevel): ParentLookup {
        // The filter's browse read the parent by id and could not read it: it exists inside the import's projects, so the default parent
        // (for a genuine orphan) is not its home either.
        if (issue.parentUnreadable) return ParentLookup(null)
        val wanted = if (level == JiraLevel.MILESTONE) JiraLevel.PROJECT else JiraLevel.PROGRAM
        val parentId = parentAtLevel(issue, wanted)
        if (parentId != null) {
            ancestorParent(parentId, wanted)?.let { return lookupOf(it, wanted) }
            if (skippedAncestor(parentId)) return ParentLookup(null, skipped = true)
        }
        return defaultParent(wanted)?.let { lookupOf(it, wanted) } ?: ParentLookup(null)
    }

    /** The one place the root rule is applied: [parent] (a level-[wanted] node) as the answer, or the OUTSIDE_ROOT verdict. */
    private fun lookupOf(parent: Parent, wanted: JiraLevel): ParentLookup =
        if (isOutsideRoot(parent, wanted)) ParentLookup(null, outsideRoot = true) else ParentLookup(parent)

    /**
     * Whether an EXISTING [parent] at plan level [wanted] lies outside the rooted import's subtree: a project-level row must sit under the
     * root program itself, a milestone-level row under a project of the root program (PROGRAM root) or under the root project (PROJECT
     * root). A project-level row under a PROJECT root has no valid parent. Always false for a whole-scope import and for a new row.
     */
    private fun isOutsideRoot(parent: Parent, wanted: JiraLevel): Boolean {
        val root = input.root ?: return false
        val nodeId = parent.nodeId ?: return false
        return when {
            wanted == JiraLevel.PROGRAM -> root.level != JiraLevel.PROGRAM || nodeId != root.nodeId
            root.level == JiraLevel.PROGRAM -> nodeId !in rootProjectIds
            else -> nodeId != root.nodeId
        }
    }

    /**
     * Whether the parent is in the browse with no usable row: a row the kernel skipped (NAME_TAKEN, NO_PARENT, LEVEL_UNMAPPED, or itself
     * PARENT_SKIPPED, so the skip cascades), or none yet because its level is unknown and it sorts after the child. Its children are
     * never re-homed under a default. A row ALREADY_BOUND outside the stream is not such a row (the plan's literal order: default, else
     * NO_PARENT); a parent outside the browse is a genuine orphan's.
     */
    private fun skippedAncestor(ancestorId: String): Boolean {
        val item = rowsById[ancestorId]?.item ?: return ancestorId in byId
        return item.action == JiraImportAction.SKIP && item.reason != JiraImportReason.ALREADY_BOUND
    }

    /**
     * The id of the issue's direct Jira parent when it is at plan level [wanted]. A browsed parent's level is its own observation's; a
     * parent outside the browse has only the type object on its child's `parent` member, resolved through the discovery by type id when
     * the object carries no `hierarchyLevel` (also the fallback for a browsed parent whose own level is unknown).
     */
    private fun parentAtLevel(issue: ImportBrowsedIssue, wanted: JiraLevel): String? {
        val parentId = issue.observation.parentIssueId ?: return null
        val hierarchyLevel = byId[parentId]?.observation?.hierarchyLevel
            ?: input.discovery.hierarchyLevelOf(issue.parentTypeId, issue.parentTypeHierarchyLevel)
        return parentId.takeIf { mapping.levelAt(hierarchyLevel) == wanted }
    }

    private fun ancestorParent(ancestorId: String, wanted: JiraLevel): Parent? {
        val holder = holders[ancestorId].orEmpty().firstOrNull { it.live && it.level == wanted && underStream(it) }
        if (holder != null) return Parent(JiraImportParentKind.EXISTING, holder.nodeId, holder.nodeName, null)
        val item = rowsById[ancestorId]?.item ?: return null
        return when (item.action) {
            JiraImportAction.CREATE -> Parent(JiraImportParentKind.NEW_ROW, null, item.name, ancestorId)
            JiraImportAction.BIND -> item.target?.let { Parent(JiraImportParentKind.EXISTING, it.nodeId, it.nodeName, ancestorId) }
            JiraImportAction.SKIP -> null
        }
    }

    private fun underStream(holder: ImportHolder): Boolean = nodeIdsByLevel.getValue(holder.level).contains(holder.nodeId)

    private fun defaultParent(wanted: JiraLevel): Parent? {
        val (id, nodes) = when (wanted) {
            JiraLevel.PROGRAM -> input.defaults.programId to tree.programs
            else -> input.defaults.projectId to tree.projects
        }
        return nodes.firstOrNull { it.id == id }?.let { Parent(JiraImportParentKind.DEFAULT, it.id, it.name, null) }
    }
}
