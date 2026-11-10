package ch.nokillswit.jira

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.json.parseStringArray
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.RoadmapKernels
import ch.nokillswit.planning.SpanKernels
import ch.nokillswit.planning.WorkStreamService
import ch.nokillswit.planning.milestoneFacts
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.teams.TeamService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import java.math.BigDecimal
import java.time.LocalDate

/*
 * The row loading of `GET /views/deviations`, split out of `DeviationViewService` to keep both small. Every function runs INSIDE the
 * caller's transaction - the view's read-only REPEATABLE READ one, or the acknowledge's write (for one binding) - and takes no lock of
 * its own. Every read of bindings filters
 * `Bindings.active()` and joins the connection ACTIVE (a deleted connection's rows stay in the tables). A DISABLED connection's
 * bindings stay visible: they still block their node and their issue, so they must stay seen and unlinkable; their staleness shows
 * through the observation's `observedAt` and the connection's `lastRun`.
 */

private val bindings = JiraBindingService.Bindings
private val connections = JiraConnectionService.Connections
private val observations = JiraObservations
private val milestones = MilestoneService.Milestones
private val projects = ProjectService.Projects
private val programs = ProgramService.Programs
private val streams = WorkStreamService.WorkStreams
private val teams = TeamService.Teams

/**
 * An ACTIVE connection (enabled or not) as the view needs it. [levels] is the CURRENT effective mapping per plan level, or null when
 * it cannot
 * be resolved (no discovery, an unreadable or stale document): no level or estimate comparison is made then, and `mappingOk` is false.
 */
internal class ConnectionFacts(
    val id: UInt,
    val name: String,
    val siteUrl: String,
    val enabled: Boolean,
    /** The connection's configured Jira project keys: the import's scope options (project keys are not secrets). */
    val projectKeys: List<String>,
    val levels: Map<JiraLevel, DeviationMapping>?,
    /** The poll facts the status derives from (`SyncStatusKernels`). */
    val connector: ConnectorConnection,
)

/**
 * Every ACTIVE connection, enabled or not, by id; [onlyId] narrows to one, [onlyIds] to those (an empty collection reads nothing, and no
 * statement is issued). The discovery blob is decoded here only to resolve the mapping, and never leaves.
 */
internal suspend fun loadConnections(onlyId: UInt? = null, onlyIds: Collection<UInt>? = null): List<ConnectionFacts> =
    if (onlyIds?.isEmpty() == true) emptyList() else connections.select(
        connections.id, connections.name, connections.siteUrl, connections.enabled, connections.projectKeys, connections.mapping,
        connections.discovery, connections.pollIntervalMinutes, connections.mappingChangedAt, connections.updatedAt,
        connections.discoveredAt,
    ).where {
        val one = onlyId?.let { connections.id eq it } ?: Op.TRUE
        val several = onlyIds?.let { connections.id inList it } ?: Op.TRUE
        connections.active() and one and several
    }.orderBy(connections.id).toList().map { row ->
            val discovery = row[connections.discovery]?.let(::parseStoredDiscoveryOrNull)
            val state = JiraMappingState(parseStoredMapping(row[connections.mapping]), discovery)
            val usable = discovery?.let { resolveEffectiveMapping(state, it) } as? MappingResolution.Usable
            val levels = usable?.mapping?.let(::deviationLevels)
            ConnectionFacts(
                row[connections.id].value, row[connections.name], row[connections.siteUrl], row[connections.enabled],
                parseStringArray(row[connections.projectKeys]), levels, row.toConnectorConnection(),
            )
        }

private fun deviationLevels(mapping: JiraMapping): Map<JiraLevel, DeviationMapping> =
    mapping.mappedLevels().associate { (level, mapped) ->
        level to DeviationMapping(mapped.hierarchyLevel, mapping.estimate.unit, mapping.estimate.manDaysPerUnit)
    }

/** The latest observation of a binding: what the kernels compare ([issue]) and what the row shows besides. */
internal class StoredObservation(
    val issue: ObservedIssue,
    val typeName: String?,
    val statusName: String?,
    val teamName: String?,
    val observedAt: Long,
)

/** The acknowledgement columns of a binding row (all null = never acknowledged; [byUserId] is also null once nobody is recorded). */
internal class StoredAck(val fingerprint: String, val at: Long, val byUserId: UInt?)

/** An ACTIVE binding of an active connection; [observation] is null for a binding no bind or run ever observed. */
internal class BindingRow(
    val id: UInt,
    val connectionId: UInt,
    val ref: PlanRef,
    val issueId: String,
    val issueKey: String,
    val observation: StoredObservation?,
    val ack: StoredAck? = null,
)

/**
 * Which ACTIVE bindings of an ACTIVE connection one computation reads. Every member narrows (null = no restriction on that axis);
 * [programIds], [projectIds] and [milestoneIds] together name the nodes (a binding on ANY of the named ones matches), so a named
 * level excludes the unnamed ones. A named EMPTY collection names nothing: it matches no binding (never "every one"), and a scope
 * whose only named collections are empty reads nothing. [levels] keeps the bindings of those plan levels only, which is how a caller
 * asks for EVERY binding of some levels (the timeline fold: projects and milestones, never programs). The acknowledge reads ONE
 * [bindingId]; the timeline fold (1.3) reads the nodes of the rows a view answers.
 */
internal class DeviationScope(
    val connectionId: UInt? = null,
    val programIds: Collection<UInt>? = null,
    val projectIds: Collection<UInt>? = null,
    val milestoneIds: Collection<UInt>? = null,
    val bindingId: UInt? = null,
    val levels: Set<JiraLevel>? = null,
    /** Resolve only the connections the bindings read reference (the timeline fold), not every active one (the view lists them all). */
    val referencedConnectionsOnly: Boolean = false,
) {
    /** Whether the bindings read are a PART of a connection's bindings: a parent issue's own binding then needs its own lookup. */
    val restrictsBindings: Boolean
        get() = bindingId != null || programIds != null || projectIds != null || milestoneIds != null || levels != null
}

private fun DeviationScope.predicate(): Op<Boolean> {
    var predicate: Op<Boolean> = bindings.active() and connections.active()
    connectionId?.let { predicate = predicate and (bindings.connectionId eq it) }
    bindingId?.let { predicate = predicate and (bindings.id eq it) }
    levels?.let { kept -> predicate = predicate and (bindings.level inList kept.map { it.name }) }
    val named = listOfNotNull<Op<Boolean>>(
        programIds?.let { bindings.programId inList it },
        projectIds?.let { bindings.projectId inList it },
        milestoneIds?.let { bindings.milestoneId inList it },
    )
    if (named.isNotEmpty()) predicate = predicate and named.reduce { a, b -> a or b }
    return predicate
}

internal suspend fun loadBindings(scope: DeviationScope = DeviationScope()): List<BindingRow> =
    bindings.innerJoin(connections, { bindings.connectionId }, { connections.id })
        .leftJoin(observations, { bindings.id }, { observations.bindingId })
        .select(
            bindings.id, bindings.connectionId, bindings.level, bindings.programId, bindings.projectId, bindings.milestoneId,
            bindings.jiraIssueId, bindings.jiraIssueKey, bindings.ackFingerprint, bindings.ackAt, bindings.ackByUserId,
            observations.observedAt, observations.summary, observations.typeName, observations.hierarchyLevel, observations.statusName,
            observations.statusCategory, observations.parentIssueId, observations.parentIssueKey, observations.startDate,
            observations.endDate, observations.estimate, observations.estimateUnit, observations.teamName, observations.gone,
            observations.goneReason,
        )
        .where { scope.predicate() }.orderBy(bindings.id).toList().map { row ->
            val fingerprint = row[bindings.ackFingerprint]
            BindingRow(
                row[bindings.id].value, row[bindings.connectionId].value, row.planRef(),
                row[bindings.jiraIssueId], row[bindings.jiraIssueKey], row.storedObservation(),
                ack = fingerprint?.let {
                    StoredAck(it, checkNotNull(row[bindings.ackAt]) { "ck_jira_bindings_ack" }, row[bindings.ackByUserId]?.value)
                },
            )
        }

private fun ResultRow.planRef(): PlanRef {
    val level = JiraLevel.valueOf(this[bindings.level])
    return PlanRef(level, checkNotNull(nodeIdOf(this)) { "ck_jira_bindings_node: exactly one node column is set" })
}

/**
 * The plan node each LIVE binding's issue is bound to, per (connection, issue id): where an observed PARENT issue's own binding
 * points. For a computation over ALL of a connection's bindings that is just [live]; for a scoped one the parents' bindings are not
 * among them, so they are looked up (ACTIVE binding of an ACTIVE connection, its node LIVE like every other binding's), which keeps
 * `PARENT_MISMATCH` - and so the fingerprint - identical to the full view's.
 */
internal suspend fun loadBoundTo(scope: DeviationScope, live: List<BindingRow>): Map<Pair<UInt, String>, PlanRef> {
    if (!scope.restrictsBindings) return live.associate { (it.connectionId to it.issueId) to it.ref }
    val wanted = live.mapNotNull { row -> row.observation?.issue?.parentIssueId?.let { row.connectionId to it } }.distinct()
    if (wanted.isEmpty()) return emptyMap()
    val anyParent = wanted.groupBy({ it.first }) { it.second }.map { (connection, issueIds) ->
        (bindings.connectionId eq connection) and (bindings.jiraIssueId inList issueIds)
    }.reduce { a, b -> a or b }
    val found = bindings.innerJoin(connections, { bindings.connectionId }, { connections.id })
        .select(bindings.connectionId, bindings.level, bindings.programId, bindings.projectId, bindings.milestoneId, bindings.jiraIssueId)
        .where { bindings.active() and connections.active() and anyParent }.toList()
        .associate { (it[bindings.connectionId].value to it[bindings.jiraIssueId]) to it.planRef() }
    val liveNodes = loadNodes(found.values)
    return found.filterValues { it in liveNodes }
}

private fun ResultRow.storedObservation(): StoredObservation? {
    val observedAt = getOrNull(observations.observedAt) ?: return null
    val estimate = getOrNull(observations.estimate)
    val unit = getOrNull(observations.estimateUnit)?.let { runCatching { JiraEstimateUnit.valueOf(it) }.getOrNull() }
    val category = getOrNull(observations.statusCategory)?.let { runCatching { JiraStatusCategory.valueOf(it) }.getOrNull() }
        ?: JiraStatusCategory.UNKNOWN
    val issue = ObservedIssue(
        summary = getOrNull(observations.summary),
        hierarchyLevel = getOrNull(observations.hierarchyLevel),
        statusCategory = category,
        parentIssueId = getOrNull(observations.parentIssueId),
        parentIssueKey = getOrNull(observations.parentIssueKey),
        startDate = getOrNull(observations.startDate),
        endDate = getOrNull(observations.endDate),
        estimate = estimate,
        estimateUnit = unit,
        gone = getOrNull(observations.gone) == true,
        goneReason = getOrNull(observations.goneReason),
    )
    return StoredObservation(
        issue, getOrNull(observations.typeName), getOrNull(observations.statusName), getOrNull(observations.teamName), observedAt,
    )
}

/** The plan fields of a node the kernels read: a milestone's dates and man-days, a project's target window. */
internal class NodeFields(
    val start: LocalDate? = null,
    val end: LocalDate? = null,
    val targetStart: LocalDate? = null,
    val targetEnd: LocalDate? = null,
    val estimateMd: BigDecimal? = null,
)

/** A LIVE plan node (it and every ancestor ACTIVE) with where it sits and the plan fields the kernels read. */
internal class NodeRow(
    val ref: PlanRef,
    val name: String,
    val workStreamId: UInt,
    val workStreamName: String,
    val programId: UInt?,
    val programName: String?,
    val projectId: UInt?,
    val projectName: String?,
    /** The owners above and at the node (work stream first; a milestone has the project's): who may acknowledge its binding. */
    val chain: OwnerChain,
    /** The team a milestone is for (null above the milestone level). */
    val team: NodeTeam? = null,
    val fields: NodeFields = NodeFields(),
) {
    val teamId: UInt? get() = team?.id
    val teamName: String? get() = team?.name
}

/** A milestone's team. */
internal class NodeTeam(val id: UInt, val name: String)

/**
 * The LIVE nodes among [refs], batched per level (three statements at most): a node whose own row or any ancestor is soft-deleted is
 * absent, so its binding is hidden exactly as the bindings list hides it.
 */
internal suspend fun loadNodes(refs: Collection<PlanRef>): Map<PlanRef, NodeRow> {
    fun ids(level: JiraLevel) = refs.filter { it.level == level }.map { it.id }.distinct()
    val nodes = HashMap<PlanRef, NodeRow>()
    ids(JiraLevel.PROGRAM).takeIf { it.isNotEmpty() }?.let { ids ->
        programs.innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(programs.id, programs.name, programs.ownerPersonId, streams.id, streams.name, streams.ownerPersonId)
            .where { (programs.id inList ids) and programs.active() and streams.active() }.toList().forEach { row ->
                val ref = PlanRef(JiraLevel.PROGRAM, row[programs.id].value)
                nodes[ref] = NodeRow(
                    ref, row[programs.name], row[streams.id].value, row[streams.name],
                    programId = ref.id, programName = row[programs.name], projectId = null, projectName = null,
                    chain = OwnerChain(listOf(row[streams.ownerPersonId].value, row[programs.ownerPersonId].value)),
                )
            }
    }
    ids(JiraLevel.PROJECT).takeIf { it.isNotEmpty() }?.let { ids ->
        projects.innerJoin(programs, { projects.programId }, { programs.id }).innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(
                projects.id, projects.name, projects.targetStart, projects.targetEnd, projects.ownerPersonId, programs.id, programs.name,
                programs.ownerPersonId, streams.id, streams.name, streams.ownerPersonId,
            )
            .where { (projects.id inList ids) and projects.active() and programs.active() and streams.active() }.toList().forEach { row ->
                val ref = PlanRef(JiraLevel.PROJECT, row[projects.id].value)
                nodes[ref] = NodeRow(
                    ref, row[projects.name], row[streams.id].value, row[streams.name],
                    programId = row[programs.id].value, programName = row[programs.name],
                    projectId = ref.id, projectName = row[projects.name], chain = projectChainOf(row),
                    fields = NodeFields(targetStart = row[projects.targetStart], targetEnd = row[projects.targetEnd]),
                )
            }
    }
    ids(JiraLevel.MILESTONE).takeIf { it.isNotEmpty() }?.let { ids ->
        nodes.putAll(loadMilestoneNodes(ids))
    }
    return nodes
}

/** The chain of a project, and of a milestone under it (no owner of its own): the stream's, the program's and the project's owner. */
private fun projectChainOf(row: ResultRow) =
    OwnerChain(listOf(row[streams.ownerPersonId].value, row[programs.ownerPersonId].value, row[projects.ownerPersonId].value))

private suspend fun loadMilestoneNodes(ids: List<UInt>): Map<PlanRef, NodeRow> =
    milestones.innerJoin(projects, { milestones.projectId }, { projects.id }).innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id }).innerJoin(teams, { milestones.teamId }, { teams.id })
        .select(
            milestones.id, milestones.name, milestones.startDate, milestones.endDate, milestones.estimateMd, milestones.teamId, teams.name,
            projects.id, projects.name, projects.ownerPersonId, programs.id, programs.name, programs.ownerPersonId, streams.id,
            streams.name, streams.ownerPersonId,
        )
        .where {
            (milestones.id inList ids) and milestones.active() and projects.active() and programs.active() and streams.active()
        }.toList().associate { row ->
            val ref = PlanRef(JiraLevel.MILESTONE, row[milestones.id].value)
            ref to NodeRow(
                ref, row[milestones.name], row[streams.id].value, row[streams.name],
                programId = row[programs.id].value, programName = row[programs.name],
                projectId = row[projects.id].value, projectName = row[projects.name], chain = projectChainOf(row),
                team = NodeTeam(row[milestones.teamId].value, row[teams.name]),
                fields = NodeFields(
                    start = row[milestones.startDate], end = row[milestones.endDate], estimateMd = row[milestones.estimateMd],
                ),
            )
        }

/**
 * The DERIVED span of each bound project (earliest start to latest end over its scheduled milestones, [RoadmapKernels.projectSpans])
 * and program (the same over its LIVE projects' spans, [SpanKernels.derivedSpan]); a node with nothing scheduled below is absent.
 * Reads nothing unless a project or program is bound.
 */
internal suspend fun loadDerivedSpans(nodes: Collection<NodeRow>): Map<PlanRef, DaySpan> {
    val boundProjects = nodes.filter { it.ref.level == JiraLevel.PROJECT }.map { it.ref.id }
    val boundPrograms = nodes.filter { it.ref.level == JiraLevel.PROGRAM }.map { it.ref.id }
    if (boundProjects.isEmpty() && boundPrograms.isEmpty()) return emptyMap()
    val projectsOfPrograms = if (boundPrograms.isEmpty()) {
        emptyMap()
    } else {
        projects.innerJoin(programs, { projects.programId }, { programs.id }).innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(projects.id, projects.programId)
            .where { (projects.programId inList boundPrograms) and projects.active() and programs.active() and streams.active() }
            .toList().groupBy({ it[projects.programId].value }) { it[projects.id].value }
    }
    val wanted = (boundProjects + projectsOfPrograms.values.flatten()).toSet()
    val spans = if (wanted.isEmpty()) emptyMap() else RoadmapKernels.projectSpans(milestoneFacts(wanted).map { it.fact })
    val result = HashMap<PlanRef, DaySpan>()
    boundProjects.forEach { id -> spans[id]?.let { result[PlanRef(JiraLevel.PROJECT, id)] = it } }
    projectsOfPrograms.forEach { (programId, projectIds) ->
        SpanKernels.derivedSpan(projectIds.mapNotNull { spans[it] })?.let { result[PlanRef(JiraLevel.PROGRAM, programId)] = it }
    }
    return result
}
