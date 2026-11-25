package ch.nokillswit.infra.db

import ch.nokillswit.auth.PasswordResetService
import ch.nokillswit.auth.PasswordResetServiceKey
import ch.nokillswit.auth.TokenBlocklistService
import ch.nokillswit.auth.TokenBlocklistServiceKey
import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import ch.nokillswit.flow.CapacityAcknowledgeService
import ch.nokillswit.flow.CapacityAcknowledgeServiceKey
import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.CapacityDeviationServiceKey
import ch.nokillswit.flow.CapacityImportService
import ch.nokillswit.flow.CapacityImportServiceKey
import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.FlowConnectionServiceKey
import ch.nokillswit.flow.FlowFlagSource
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.FlowMirrorStoreKey
import ch.nokillswit.flow.FlowOriginsKey
import ch.nokillswit.flow.FlowTeamBindingService
import ch.nokillswit.flow.FlowTeamBindingServiceKey
import ch.nokillswit.flow.FlowTeamService
import ch.nokillswit.flow.FlowTeamServiceKey
import ch.nokillswit.infra.crypto.FieldCipherKey
import ch.nokillswit.infra.outbound.FlowBaseUrlVerdict
import ch.nokillswit.jira.DeviationViewService
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraAcknowledgeService
import ch.nokillswit.jira.JiraAcknowledgeServiceKey
import ch.nokillswit.jira.JiraBindingService
import ch.nokillswit.jira.JiraBindingServiceKey
import ch.nokillswit.jira.JiraConnectionService
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.jira.JiraImportService
import ch.nokillswit.jira.JiraImportServiceKey
import ch.nokillswit.jira.JiraMappingStore
import ch.nokillswit.jira.JiraMappingStoreKey
import ch.nokillswit.jira.JiraTestRecorder
import ch.nokillswit.jira.JiraTestRecorderKey
import ch.nokillswit.people.PersonService
import ch.nokillswit.people.PersonServiceKey
import ch.nokillswit.planning.BaselineService
import ch.nokillswit.planning.BaselineServiceKey
import ch.nokillswit.planning.BaselineViewService
import ch.nokillswit.planning.BaselineViewServiceKey
import ch.nokillswit.planning.CompositeExternalFlagSource
import ch.nokillswit.planning.CrossTeamProposalService
import ch.nokillswit.planning.CrossTeamProposalServiceKey
import ch.nokillswit.planning.DependencyListViewService
import ch.nokillswit.planning.DependencyListViewServiceKey
import ch.nokillswit.planning.DependencyService
import ch.nokillswit.planning.DependencyServiceKey
import ch.nokillswit.planning.HomeViewService
import ch.nokillswit.planning.HomeViewServiceKey
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.MilestoneServiceKey
import ch.nokillswit.planning.PlanOrderService
import ch.nokillswit.planning.PlanOrderServiceKey
import ch.nokillswit.planning.PlanViewService
import ch.nokillswit.planning.PlanViewServiceKey
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProgramServiceKey
import ch.nokillswit.planning.ProgramsViewService
import ch.nokillswit.planning.ProgramsViewServiceKey
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.ProjectServiceKey
import ch.nokillswit.planning.ProjectViewService
import ch.nokillswit.planning.ProjectViewServiceKey
import ch.nokillswit.planning.RoadmapService
import ch.nokillswit.planning.PublicHolidayService
import ch.nokillswit.planning.PublicHolidayServiceKey
import ch.nokillswit.planning.RoadmapServiceKey
import ch.nokillswit.planning.SavedProposalService
import ch.nokillswit.planning.SavedProposalServiceKey
import ch.nokillswit.planning.RoadmapViewService
import ch.nokillswit.planning.RoadmapViewServiceKey
import ch.nokillswit.planning.ScheduleProposalService
import ch.nokillswit.planning.ScheduleProposalServiceKey
import ch.nokillswit.planning.TeamLoadViewService
import ch.nokillswit.planning.TeamLoadViewServiceKey
import ch.nokillswit.planning.TeamOrderService
import ch.nokillswit.planning.TeamOrderServiceKey
import ch.nokillswit.planning.TeamScheduleService
import ch.nokillswit.planning.TeamScheduleServiceKey
import ch.nokillswit.planning.TeamViewService
import ch.nokillswit.planning.TeamViewServiceKey
import ch.nokillswit.planning.WorkStreamService
import ch.nokillswit.planning.WorkStreamServiceKey
import ch.nokillswit.sync.SyncConnectors
import ch.nokillswit.sync.SyncConnectorsKey
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.teams.CapacityWriteListeners
import ch.nokillswit.teams.CapacityWriteListenersKey
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.teams.TeamCapacityServiceKey
import ch.nokillswit.teams.TeamService
import ch.nokillswit.teams.TeamServiceKey
import ch.nokillswit.users.UserService
import ch.nokillswit.users.UserServiceKey
import io.ktor.server.application.*
import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase

/** The connected database itself — read by the readiness probe (plugins/Health.kt); services get
 *  it injected, and `ConnectionPoolTest` opens transactions directly against the SAME pool the
 *  app's services use to observe `pg_stat_activity` bounded by `postgres.pool.maxSize`. */
val R2dbcDatabaseKey = AttributeKey<R2dbcDatabase>("R2dbcDatabase")

/**
 * The DI composition root: connects the one R2DBC database (through the bounded pool of `ConnectionPool.kt`) and
 * publishes every service into [Application.attributes]. Feature modules read their services back
 * via the AttributeKey — application.yaml runs this module before any route module, so the keys
 * are always present. The wiring is split by concern into the private `wire…` functions below; their order is
 * load-bearing (a later group takes what an earlier one answers), and so is the order of the boot-validated config reads.
 */
suspend fun Application.configureDatabase() {
    val database = connectPooled()
    attributes.put(R2dbcDatabaseKey, database)
    val (teamService, teamCapacity) = wireRegistries(database)
    wirePlan(database)
    val syncRuns = wireSync(database)
    val deviationView = wireJira(database, syncRuns, teamService)
    val capacityDeviations = wireFlow(database, syncRuns, teamCapacity)
    wirePlanViews(database, deviationView, capacityDeviations)
    wireAuth(database)
}

/** The registries (users, people, teams and their capacity); answers the team service and the capacity service the later groups take. */
private fun Application.wireRegistries(database: R2dbcDatabase): Pair<TeamService, TeamCapacityService> {
    attributes.put(UserServiceKey, UserService(database))
    attributes.put(PersonServiceKey, PersonService(database))
    val teamService = TeamService(database)
    attributes.put(TeamServiceKey, teamService)
    // Empty: a connector's module (`configureFlow`) registers its part in a capacity write (the lock before the team row, the settle).
    val capacityListeners = CapacityWriteListeners()
    attributes.put(CapacityWriteListenersKey, capacityListeners)
    val teamCapacity = TeamCapacityService(database, capacityListeners)
    attributes.put(TeamCapacityServiceKey, teamCapacity)
    return teamService to teamCapacity
}

/** The plan itself (work streams to baselines, ranks, schedules, holidays); needs nothing earlier. */
private fun Application.wirePlan(database: R2dbcDatabase) {
    attributes.put(WorkStreamServiceKey, WorkStreamService(database))
    attributes.put(ProgramServiceKey, ProgramService(database))
    attributes.put(ProjectServiceKey, ProjectService(database))
    attributes.put(MilestoneServiceKey, MilestoneService(database))
    attributes.put(DependencyServiceKey, DependencyService(database))
    attributes.put(PlanViewServiceKey, PlanViewService(database))
    attributes.put(RoadmapServiceKey, RoadmapService(database))
    attributes.put(TeamOrderServiceKey, TeamOrderService(database))
    attributes.put(PlanOrderServiceKey, PlanOrderService(database))
    attributes.put(TeamScheduleServiceKey, TeamScheduleService(database))
    attributes.put(ScheduleProposalServiceKey, ScheduleProposalService(database))
    attributes.put(CrossTeamProposalServiceKey, CrossTeamProposalService(database))
    attributes.put(PublicHolidayServiceKey, PublicHolidayService(database))
    attributes.put(BaselineServiceKey, BaselineService(database))
    attributes.put(BaselineViewServiceKey, BaselineViewService(database))
    attributes.put(SavedProposalServiceKey, SavedProposalService(database))
}

/** The connector-agnostic sync side: the run registry (answered, both connectors' registries read it) and the empty connector registry. */
private fun Application.wireSync(database: R2dbcDatabase): SyncRunService {
    // The run registry (V21 `sync_runs`) comes first: the connection registry reads each connection's newest run from it.
    val maxRunMinutes = requireConfigInt(environment.config, "sync.maxRunMinutes", min = 1, max = 60)
    val syncRuns = SyncRunService(database, maxRunMinutes)
    attributes.put(SyncRunServiceKey, syncRuns)
    // The empty connector registry the connectors' modules fill (`configureJira`).
    attributes.put(SyncConnectorsKey, SyncConnectors())
    return syncRuns
}

/** The Jira side; needs the run registry and the team service; answers the deviation view service the flag source and the views take. */
private fun Application.wireJira(database: R2dbcDatabase, syncRuns: SyncRunService, teamService: TeamService): DeviationViewService {
    // The Jira registry owns the first encrypted-at-rest column (V21); the cipher comes from configureCrypto, registered before Database.
    attributes.put(JiraConnectionServiceKey, JiraConnectionService(database, attributes[FieldCipherKey], syncRuns))
    // The two stores split out of the registry service: neither is given the cipher, neither selects `api_token`.
    attributes.put(JiraTestRecorderKey, JiraTestRecorder(database))
    attributes.put(JiraMappingStoreKey, JiraMappingStore(database))
    val jiraBindings = JiraBindingService(database)
    attributes.put(JiraBindingServiceKey, jiraBindings)
    attributes.put(JiraImportServiceKey, JiraImportService(database, teamService, jiraBindings))
    val deviationView = DeviationViewService(database, syncRuns)
    attributes.put(DeviationViewServiceKey, deviationView)
    attributes.put(JiraAcknowledgeServiceKey, JiraAcknowledgeService(database, deviationView))
    return deviationView
}

/** The Flow side; needs the run registry and the capacity service; answers the capacity deviation service the flag source takes. */
private fun Application.wireFlow(
    database: R2dbcDatabase,
    syncRuns: SyncRunService,
    teamCapacity: TeamCapacityService,
): CapacityDeviationService {
    // The Flow registry (V24) is the second encrypted-at-rest service; its mirror and bindings come with it. A registry write is judged by
    // the operator's origin rule (`FlowOrigins.baseUrlVerdict`), which `configureFlow` builds from `flow.*` AFTER this module: the lookup
    // is per call, and an absent rule refuses (fail closed), so a connection can never name an origin the transport would refuse.
    val flowBaseUrlVerdict = { url: String -> attributes.getOrNull(FlowOriginsKey)?.baseUrlVerdict(url) ?: FlowBaseUrlVerdict.NOT_LISTED }
    attributes.put(FlowConnectionServiceKey, FlowConnectionService(database, attributes[FieldCipherKey], syncRuns, flowBaseUrlVerdict))
    val flowConnections = attributes[FlowConnectionServiceKey]
    val flowMirror = FlowMirrorStore(database)
    attributes.put(FlowMirrorStoreKey, flowMirror)
    val flowBindings = FlowTeamBindingService(database)
    attributes.put(FlowTeamBindingServiceKey, flowBindings)
    attributes.put(FlowTeamServiceKey, FlowTeamService(database, flowConnections, flowMirror))
    attributes.put(CapacityImportServiceKey, CapacityImportService(database, flowBindings, flowMirror, teamCapacity))
    val capacityDeviations = CapacityDeviationService(database, flowBindings, flowMirror, teamCapacity, syncRuns)
    attributes.put(CapacityDeviationServiceKey, capacityDeviations)
    attributes.put(CapacityAcknowledgeServiceKey, CapacityAcknowledgeService(database, capacityDeviations, flowBindings))
    return capacityDeviations
}

/** The views that read the external flags; needs the Jira deviation view service and the Flow capacity deviation service. */
private fun Application.wirePlanViews(
    database: R2dbcDatabase,
    deviationView: DeviationViewService,
    capacityDeviations: CapacityDeviationService,
) {
    // The four timeline views read the Jira links and flags (and, since 1.9, the team view's Flow capacity flag; since 1.23 also the
    // every-team Flow read of the Roadmap, Programs and Home, which folds into their project rows) through planning's seam, inside their
    // own snapshot; the composite merges the two sources.
    val jiraFlags = CompositeExternalFlagSource(listOf(JiraFlagSource(deviationView), FlowFlagSource(capacityDeviations)))
    attributes.put(ProjectViewServiceKey, ProjectViewService(database, jiraFlags))
    attributes.put(RoadmapViewServiceKey, RoadmapViewService(database, jiraFlags))
    attributes.put(ProgramsViewServiceKey, ProgramsViewService(database, jiraFlags))
    attributes.put(TeamViewServiceKey, TeamViewService(database, jiraFlags))
    attributes.put(HomeViewServiceKey, HomeViewService(database, jiraFlags))
    attributes.put(TeamLoadViewServiceKey, TeamLoadViewService(database))
    attributes.put(DependencyListViewServiceKey, DependencyListViewService(database))
}

/** The login side: the revoked-token blocklist and the persisted password-reset links, each with its boot-validated config read. */
private fun Application.wireAuth(database: R2dbcDatabase) {
    attributes.put(
        TokenBlocklistServiceKey,
        TokenBlocklistService(
            database,
            replayGraceMillis = requireConfigLong(
                environment.config, "security.refresh.replayGraceSeconds", min = 0, max = 600,
            ) * 1000,
        ),
    )
    // Persisted single-use reset links (V35): the lifetime is boot-validated, 1 second .. 1 hour.
    attributes.put(
        PasswordResetServiceKey,
        PasswordResetService(
            database,
            ttlMillis = requireConfigLong(environment.config, "security.passwordReset.tokenTtlSeconds", min = 1, max = 3600) * 1000,
        ),
    )
}
