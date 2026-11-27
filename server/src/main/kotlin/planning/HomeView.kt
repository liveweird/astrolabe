package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/** The most rows one list of [HomeMe] holds (the plan's scale is about 100 projects, so nothing is cut in practice). */
const val MAX_HOME_ROWS = 100

/**
 * `GET /api/v1/views/home` (1.18.0) — the plan's figures and the caller's own items in one document (the documented view-endpoint
 * shape exception, `list-endpoints.md`). Every figure is one an existing page shows or one of its kernels derives ([HomeKernels]), so
 * Home can never disagree with the page it links to. [revision] is the PLAN's, read first (informational: Home offers no write, so
 * the document has no `can`). [me] is null for a login without an ACTIVE linked person. [jiraSites] is the roadmap's member, entry
 * for entry. No defaults: the response encoder writes every member.
 */
@Serializable
data class HomeView(val revision: Long, val plan: HomePlan, val me: HomeMe?, val jiraSites: List<JiraSite>)

/**
 * The whole plan in figures. [workStreams], [programs] and [projects] repeat the Programs page's facts line with nothing picked;
 * [milestones] and [unscheduledMilestones] the project and team pages' unscheduled trays summed; [rankedProjects] and
 * [unrankedProjects] the Roadmap's facts line with nothing filtered; [flags] the warnings and infos both facts lines count; [conflicts]
 * the violated dependencies (the red badge of the project and team pages), each link once, a link inside one project included.
 * [overloadedTeams] and [wipExceededTeams] (Q1 b) are how many teams have at least one week the team page flags orange: overloaded,
 * and over the WIP limit.
 */
@Serializable
data class HomePlan(
    val workStreams: Int,
    val programs: Int,
    val projects: Int,
    val rankedProjects: Int,
    val unrankedProjects: Int,
    val milestones: Int,
    val unscheduledMilestones: Int,
    val flags: FlagCounts,
    val conflicts: Int,
    val overloadedTeams: Int,
    val wipExceededTeams: Int,
)

/**
 * What the caller's linked person manages through the owner chain (1.23: the work streams they own, the programs and projects they own
 * or that sit under a work stream or program they own; each program and project row says whose it is) and the teams that person
 * manages, each list capped at [MAX_HOME_ROWS] in its order; [truncated] says a list was cut.
 */
@Serializable
data class HomeMe(
    val personId: UInt,
    val name: String,
    val workStreams: List<HomeWorkStream>,
    val programs: List<HomeProgram>,
    val projects: List<HomeProject>,
    val teams: List<HomeTeam>,
    val truncated: Boolean,
)

/** A work stream's row on the Programs page: [endDate] is set only when it is closed; [flags] roll its projects' up. */
@Serializable
data class HomeWorkStream(val id: UInt, val name: String, val endDate: String?, val programs: Int, val projects: Int, val flags: FlagCounts)

/**
 * A program's row on the Programs page: its [projects] and their rolled-up [flags]. [workStreamId] is its work stream's and
 * [ownerPersonId]/[ownerName] the program's owner (the ids let the page link the names); [direct] says the caller's person is that
 * owner (false: the row is listed because the person owns its work stream).
 */
@Serializable
data class HomeProgram(
    val id: UInt,
    val name: String,
    val workStreamId: UInt,
    val workStreamName: String,
    val ownerPersonId: UInt,
    val ownerName: String,
    val direct: Boolean,
    val projects: Int,
    val flags: FlagCounts,
)

/**
 * A project's Roadmap row ([flags] are the warnings and infos the Roadmap counts, Jira's included; [rankPosition] is null while
 * unranked) with the project page's milestone figures and its red conflicts badge. [programId] is its program's and
 * [ownerPersonId]/[ownerName] the project's owner; [direct] says the caller's person is that owner (false: the row is listed because
 * the person owns its program or work stream).
 */
@Serializable
data class HomeProject(
    val id: UInt,
    val name: String,
    val programId: UInt,
    val programName: String,
    val ownerPersonId: UInt,
    val ownerName: String,
    val direct: Boolean,
    val rankPosition: Int?,
    val milestones: Int,
    val unscheduledMilestones: Int,
    val flags: FlagCounts,
    val conflicts: Int,
)

/**
 * The figures of the team page's header: its milestones, the unscheduled ones, [conflicts], the weeks it flags orange
 * ([overloadedWeeks], [wipExceededWeeks]), the open Jira deviations of its milestones ([jira]: the chip's rule) and [flags], the
 * team view's `team.flags` (at most one Flow flag: [FlagKind.FLOW_CAPACITY] or the neutral [FlagKind.FLOW_CAPACITY_PENDING]).
 */
@Serializable
data class HomeTeam(
    val id: UInt,
    val name: String,
    val milestones: Int,
    val unscheduledMilestones: Int,
    val conflicts: Int,
    val overloadedWeeks: Int,
    val wipExceededWeeks: Int,
    val jira: FlagCounts,
    val flags: List<PlanFlag>,
)
