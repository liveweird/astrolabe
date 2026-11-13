package ch.nokillswit.jira

import ch.nokillswit.infra.validation.LAST_PLAN_DAY
import ch.nokillswit.planning.MilestoneSpan
import ch.nokillswit.planning.TargetWindow
import java.time.LocalDate
import java.util.Locale
import kotlin.math.abs

/** The first year a plan date may have (`parseIsoDate`'s calendar: 1900-2999). */
private const val FIRST_PLAN_YEAR = 1900

/** Where a created row lands. [nodeId] is null for the new node of another row; [rowJiraId] names the batch row a parent depends on. */
private class Parent(val kind: JiraImportParentKind, val nodeId: UInt?, val nodeName: String, val rowJiraId: String?) {
    /** The sibling scope: every row landing under the same node (or under the same new row) shares a name space. */
    val key: String get() = nodeId?.let { "node$it" } ?: "row$rowJiraId"

    fun toWire() = JiraImportParent(kind, nodeId, nodeName, rowJiraId)
}

/** The parent search's answer: a [parent], or none ([skipped] = the Jira parent is in the browse and its row was skipped). */
private class ParentLookup(val parent: Parent?, val skipped: Boolean = false)

/** A milestone's dates after the rules: the span to write (null = unscheduled) and the one info that says why. */
private class DatesVerdict(val span: MilestoneSpan?, val info: JiraImportInfo?)

/** A created project's window verdict (1.14): the [window] to write, else the [info] saying why not (none when Jira has no dates). */
private class WindowVerdict(val window: TargetWindow?, val info: JiraImportInfo?)

/** The numeric Jira ids order as numbers (never lexicographically): shorter first, then by digits. */
internal val ID_ORDER: Comparator<String> = compareBy<String>({ it.length }, { it })

/**
 * One run of the kernel (`JiraImportKernels.plan`); the state is the claims the earlier rows of the batch have made.
 *
 * THE PARENT RULE reads only the issue's DIRECT Jira parent (`fields.parent` holds nothing further), and only at the parent's plan
 * level (project for a milestone, program for a project). The real browse reads only the issue types of the MAPPED levels, so a level
 * the mapping skips is never in the browse: an epic under an unmapped initiative under a mapped program has a direct parent that is
 * not at the project level, which makes it a genuine orphan - the default parent, else NO_PARENT. (Jira levels only rise up the chain
 * and mapped levels are never adjacent to a browsed one in between, so walking further up could never find the wanted level.)
 * A direct parent that IS in the browse but has no usable row (any skip but ALREADY_BOUND, whatever the ids' order) makes the child
 * PARENT_SKIPPED, never a default. In an apply only a WRITTEN row keeps its [ImportRow.releases] (use [ImportPlan.releases]).
 */
internal class ImportPlanner(private val input: ImportInput) {
    private val mapping = input.mapping
    private val snapshot = input.snapshot
    private val tree = snapshot.tree
    /** More issues were in scope than the cap: parents may have been cut away, see [ImportPlan.truncated]. */
    private val truncated = input.browse.truncated || input.browse.issues.size > MAX_IMPORT_ITEMS
    private val kept = input.browse.issues.distinctBy { it.observation.issueId }
        .sortedWith(compareBy(ID_ORDER) { it.observation.issueId }).take(MAX_IMPORT_ITEMS)
    private val byId = kept.associateBy { it.observation.issueId }
    private val holders = snapshot.holders.groupBy { it.issueId }
    private val ticks = input.ticks.orEmpty().associateBy { it.jiraId }
    private val teamsById = snapshot.teams.associateBy { it.id }
    private val teamsByFold = snapshot.teams.sortedBy { it.id }
        .groupBy { JiraImportKernels.foldName(it.name) }.mapValues { it.value.first() }
    private val programNames = snapshot.allProgramNames.mapTo(HashSet()) { it.lowercase(Locale.ROOT) }
    private val milestoneHasDateFields = mapping.levels.milestone.fields.let { it.start != null || it.end != null }

    private val rowsById = LinkedHashMap<String, ImportRow>()
    private val claimedNodes = HashSet<Pair<JiraLevel, UInt>>()
    private val takenNames = HashSet<Pair<String, String>>()
    private val unmatchedTeams = HashSet<String>()
    private val naturalTeams = HashMap<String, UInt?>()
    private val projectsByParent = tree.projects.groupBy { it.parentId }
    private val milestonesByParent = tree.milestones.groupBy { it.parentId }
    private val nodeIdsByLevel = mapOf(
        JiraLevel.PROGRAM to tree.programs.mapTo(HashSet()) { it.id },
        JiraLevel.PROJECT to tree.projects.mapTo(HashSet()) { it.id },
        JiraLevel.MILESTONE to tree.milestones.mapTo(HashSet()) { it.id },
    )

    fun run(): ImportPlan {
        val ordered = kept.sortedWith(
            compareBy<ImportBrowsedIssue> { (levelOf(it) ?: nearestLevel(it)).ordinal }.thenBy(ID_ORDER) { it.observation.issueId },
        )
        val planned = ordered.map(::planRow)
        val vanished = ticks.keys.filter { it !in rowsById }
        val rows = if (input.ticks == null) planned else applyTicks(planned)
        // Sorted, then one entry per fold ("Zulu" and "zulu" are one name): the first spelling in sort order is kept.
        val unmatched = unmatchedTeams.sorted().distinctBy(JiraImportKernels::foldName)
        return ImportPlan(input.asOf, rows, truncated, unmatched, vanished)
    }

    private fun levelOf(issue: ImportBrowsedIssue): JiraLevel? = mapping.levelAt(issue.observation.hierarchyLevel)

    /** The mapped level nearest the issue's Jira level (a tie goes to the deeper one; none known = milestone): where an unmapped sorts. */
    private fun nearestLevel(issue: ImportBrowsedIssue): JiraLevel {
        val actual = issue.observation.hierarchyLevel ?: return JiraLevel.MILESTONE
        return mapping.mappedLevels().reversed().minBy { abs(it.second.hierarchyLevel - actual) }.first
    }

    private fun planRow(issue: ImportBrowsedIssue): ImportRow {
        val obs = issue.observation
        val name = JiraImportKernels.importName(obs.summary, obs.issueKey)
        val level = levelOf(issue) ?: return skip(issue, nearestLevel(issue), name, JiraImportReason.LEVEL_UNMAPPED)
        val held = holders[obs.issueId].orEmpty()
        held.firstOrNull { it.live }?.let { holder ->
            val target = JiraImportTarget(holder.nodeId, holder.nodeName, holder.level, holder.connectionId)
            return skip(issue, level, name, JiraImportReason.ALREADY_BOUND, target)
        }
        val lookup = if (level == JiraLevel.PROGRAM) null else parentOf(issue, level)
        if (lookup?.skipped == true) return skip(issue, level, name, JiraImportReason.PARENT_SKIPPED)
        if (lookup != null && lookup.parent == null) return skip(issue, level, name, JiraImportReason.NO_PARENT)
        return decide(issue, level, name, lookup?.parent, held.filterNot { it.live })
    }

    // ---- the name verdict: BIND, NAME_TAKEN or CREATE --------------------------------------------------------------------------

    private fun decide(
        issue: ImportBrowsedIssue,
        level: JiraLevel,
        name: ImportName,
        parent: Parent?,
        releases: List<ImportHolder>,
    ): ImportRow {
        val lower = name.text.lowercase(Locale.ROOT)
        // The slot is per CHILD level: node ids of different levels overlap (program 3 and project 3), and so do their name spaces.
        val slot = "$level/${parent?.key.orEmpty()}"
        val existing = siblings(level, parent).firstOrNull { it.name.lowercase(Locale.ROOT) == lower }
        val taken = existing != null || (level == JiraLevel.PROGRAM && lower in programNames) || (slot to lower) in takenNames
        if (existing != null && !existing.bound && claimedNodes.add(level to existing.id)) {
            val item = base(issue, level, name).copy(
                action = JiraImportAction.BIND,
                target = JiraImportTarget(existing.id, existing.name),
                parent = parent?.toWire(),
            )
            return register(ImportRow(item, issue.observation, null, null, releases, null))
        }
        if (taken) return skip(issue, level, name, JiraImportReason.NAME_TAKEN)
        val row = if (level == JiraLevel.MILESTONE) {
            createMilestone(issue, name, parent, releases)
        } else {
            createNode(issue, level, name, parent, releases)
        }
        if (row.item.action == JiraImportAction.CREATE) takenNames.add(slot to lower)
        return row
    }

    private fun siblings(level: JiraLevel, parent: Parent?): List<ImportPlanNode> = when (level) {
        JiraLevel.PROGRAM -> tree.programs
        JiraLevel.PROJECT -> parent?.nodeId?.let { projectsByParent[it] }.orEmpty()
        JiraLevel.MILESTONE -> parent?.nodeId?.let { milestonesByParent[it] }.orEmpty()
    }

    private fun createNode(
        issue: ImportBrowsedIssue,
        level: JiraLevel,
        name: ImportName,
        parent: Parent?,
        releases: List<ImportHolder>,
    ): ImportRow {
        val verdict = if (level == JiraLevel.PROJECT) windowFor(issue.observation) else WindowVerdict(null, null)
        val base = base(issue, level, name)
        val item = base.copy(
            action = JiraImportAction.CREATE,
            parent = parent?.toWire(),
            // The window that WILL be written, shown the way a milestone's dates are; none when it is not copied.
            startDate = verdict.window?.start?.toString(),
            endDate = verdict.window?.end?.toString(),
            infos = base.infos + listOfNotNull(verdict.info),
        )
        return register(ImportRow(item, issue.observation, null, null, releases, null, verdict.window))
    }

    private fun createMilestone(issue: ImportBrowsedIssue, name: ImportName, parent: Parent?, releases: List<ImportHolder>): ImportRow {
        val obs = issue.observation
        val team = teamFor(issue) ?: return skip(issue, JiraLevel.MILESTONE, name, JiraImportReason.NO_TEAM)
        val canSchedule = snapshot.canScheduleTeamIds?.contains(team.id) ?: true
        val estimate = JiraImportKernels.convertEstimate(obs.estimate, mapping.estimate)
        val dates = datesFor(obs, canSchedule)
        val infos = listOfNotNull(
            JiraImportInfo.NAME_TRUNCATED.takeIf { name.truncated },
            JiraImportInfo.ESTIMATE_NOT_CONVERTED.takeIf { estimate.notConverted },
            dates.info,
        ) + browseInfos(issue)
        val item = base(issue, JiraLevel.MILESTONE, name).copy(
            action = JiraImportAction.CREATE,
            parent = parent?.toWire(),
            estimateMd = estimate.manDays.toDouble(),
            startDate = obs.startDate?.takeIf { input.copyDates }?.toString(),
            endDate = obs.endDate?.takeIf { input.copyDates }?.toString(),
            team = team,
            canSchedule = canSchedule,
            scheduled = dates.span != null,
            infos = infos,
        )
        return register(ImportRow(item, obs, estimate.manDays, dates.span, releases, null))
    }

    // ---- skip rows and the shared item ----------------------------------------------------------------------------------------

    private fun base(issue: ImportBrowsedIssue, level: JiraLevel, name: ImportName): JiraImportItem {
        val obs = issue.observation
        return JiraImportItem(
            jiraId = obs.issueId,
            issueKey = obs.issueKey,
            summary = obs.summary.orEmpty(),
            typeName = obs.typeName,
            hierarchyLevel = obs.hierarchyLevel,
            parentJiraId = obs.parentIssueId,
            parentIssueKey = obs.parentIssueKey,
            level = level,
            action = JiraImportAction.SKIP,
            name = name.text,
            canSchedule = false,
            scheduled = false,
            infos = listOfNotNull(JiraImportInfo.NAME_TRUNCATED.takeIf { name.truncated }) + browseInfos(issue),
        )
    }

    /** The infos the filter's browse gives a row whatever its action: kept as a parent, its own parent unreadable. */
    private fun browseInfos(issue: ImportBrowsedIssue): List<JiraImportInfo> = listOfNotNull(
        JiraImportInfo.KEPT_AS_PARENT.takeIf { issue.keptAsParent },
        JiraImportInfo.PARENT_UNREADABLE.takeIf { issue.parentUnreadable },
    )

    private fun skip(
        issue: ImportBrowsedIssue,
        level: JiraLevel,
        name: ImportName,
        reason: JiraImportReason,
        target: JiraImportTarget? = null,
    ): ImportRow {
        val item = base(issue, level, name).copy(reason = reason, target = target)
        return register(ImportRow(item, issue.observation, null, null, emptyList(), null))
    }

    private fun register(row: ImportRow): ImportRow = row.also { rowsById[it.item.jiraId] = it }

    // ---- the parent ------------------------------------------------------------------------------------------------------------

    private fun parentOf(issue: ImportBrowsedIssue, level: JiraLevel): ParentLookup {
        // The filter's browse read the parent by id and could not read it: it exists inside the import's projects, so the default parent
        // (for a genuine orphan) is not its home either.
        if (issue.parentUnreadable) return ParentLookup(null)
        val wanted = if (level == JiraLevel.MILESTONE) JiraLevel.PROJECT else JiraLevel.PROGRAM
        val parentId = parentAtLevel(issue, wanted)
        if (parentId != null) {
            ancestorParent(parentId, wanted)?.let { return ParentLookup(it) }
            if (skippedAncestor(parentId)) return ParentLookup(null, skipped = true)
        }
        return ParentLookup(defaultParent(wanted))
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

    // ---- team, dates -----------------------------------------------------------------------------------------------------------

    /**
     * An apply override wins (an unknown team is NO_TEAM, never another one); else the name match; else the default team. The team
     * WITHOUT the override is remembered in [naturalTeams]: it is what a preview shows, so it is what an apply compares.
     */
    private fun teamFor(issue: ImportBrowsedIssue): JiraImportTeam? {
        val name = issue.observation.teamName
        val matched = name?.let { teamsByFold[JiraImportKernels.foldName(it)] }
        if (matched == null && !name.isNullOrBlank()) unmatchedTeams.add(name.trim())
        val natural = matched?.let { JiraImportTeam(it.id, it.name, JiraImportTeamRule.MATCHED) }
            ?: input.defaults.teamId?.let(teamsById::get)?.let { JiraImportTeam(it.id, it.name, JiraImportTeamRule.DEFAULT) }
        naturalTeams[issue.observation.issueId] = natural?.id
        val override = ticks[issue.observation.issueId]?.overrides?.teamId
        if (override != null) return teamsById[override]?.let { JiraImportTeam(it.id, it.name, JiraImportTeamRule.DEFAULT) }
        return natural
    }

    private fun datesFor(obs: JiraObservation, canSchedule: Boolean): DatesVerdict {
        if (!input.copyDates) return DatesVerdict(null, null)
        val start = obs.startDate
        val end = obs.endDate
        if (start == null || end == null) {
            return DatesVerdict(null, JiraImportInfo.DATES_INVALID.takeIf { milestoneHasDateFields })
        }
        return when {
            end.isBefore(start) || !inPlanYears(start) || !inPlanYears(end) -> DatesVerdict(null, JiraImportInfo.DATES_INVALID)
            !canSchedule -> DatesVerdict(null, JiraImportInfo.DATES_NOT_COPIED)
            !snapshot.calendar.containsWorkingDay(start, end) -> DatesVerdict(null, JiraImportInfo.NO_WORKING_DAY)
            else -> DatesVerdict(MilestoneSpan(start, end), null)
        }
    }

    /**
     * A created project's target window from Jira's dates (1.14): BOTH dates, in order and inside the plan's years, else none and the
     * row is created all the same. A Jira item with no dates at all says nothing (a project often has none); a lone date or a
     * reversed pair says [JiraImportInfo.TARGET_NOT_COPIED]. Who may set it is not asked here: whoever may create the project is the
     * stream's or the program's owner (or ADMIN), the project chain's ancestors, which `requireTargetWindowEditorOrAdmin` admits.
     */
    private fun windowFor(obs: JiraObservation): WindowVerdict {
        val start = obs.startDate
        val end = obs.endDate
        return when {
            !input.copyDates || (start == null && end == null) -> WindowVerdict(null, null)
            start == null || end == null || end.isBefore(start) || !inPlanYears(start) || !inPlanYears(end) ->
                WindowVerdict(null, JiraImportInfo.TARGET_NOT_COPIED)
            else -> WindowVerdict(TargetWindow(start, end), null)
        }
    }

    private fun inPlanYears(date: LocalDate): Boolean = date.year in FIRST_PLAN_YEAR..LAST_PLAN_DAY.year

    // ---- the apply: ticks over the decided rows --------------------------------------------------------------------------------

    private fun applyTicks(planned: List<ImportRow>): List<ImportRow> {
        val outcomes = HashMap<String, ImportApply>()
        return planned.map { row ->
            val tick = ticks[row.item.jiraId]
            val apply = if (tick == null) ImportApply.NotRequested else outcomeOf(row, tick, outcomes)
            outcomes[row.item.jiraId] = apply
            // Only a written row releases anything: nothing else may carry a release for a flatMap to find.
            row.copy(apply = apply, releases = row.releases.takeIf { apply == ImportApply.Write }.orEmpty())
        }
    }

    /** The kernel's own skip first, then a changed expectation, then a parent the client left out; else the row is written. */
    private fun outcomeOf(row: ImportRow, tick: JiraImportApplyItem, outcomes: Map<String, ImportApply>): ImportApply {
        val item = row.item
        item.reason?.let { return ImportApply.Skipped(it) }
        if (!matches(tick.expected, item)) return ImportApply.Skipped(JiraImportReason.CHANGED)
        val dependsOn = item.parent?.rowJiraId
        if (dependsOn != null && outcomes[dependsOn] != ImportApply.Write) return ImportApply.Skipped(JiraImportReason.PARENT_SKIPPED)
        return ImportApply.Write
    }

    private fun matches(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        expected.action == item.action && expected.level == item.level && expected.parentJiraId == item.parentJiraId &&
            expected.nodeId == item.target?.nodeId && landsWhereSeen(expected, item) && teamAsSeen(expected, item)

    /** A milestone CREATE keeps the team the preview showed (the natural one, before any override); other rows have no team. */
    private fun teamAsSeen(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        item.action != JiraImportAction.CREATE || item.level != JiraLevel.MILESTONE || expected.teamId == naturalTeams[item.jiraId]

    /** A CREATE lands under the parent the client saw: the same kind and, for an existing node, the same node. A BIND lands nowhere. */
    private fun landsWhereSeen(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        item.action != JiraImportAction.CREATE ||
            (expected.parent?.kind == item.parent?.kind && expected.parent?.nodeId == item.parent?.nodeId)
}
