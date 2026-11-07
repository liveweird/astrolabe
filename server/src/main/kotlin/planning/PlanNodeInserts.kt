package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import java.math.BigDecimal

/*
 * The insert blocks of the three plan-node `create`s, in one place so the Jira import (1.2) writes the same rows the routes do. Each runs
 * INSIDE the caller's transaction - the caller holds `withPlanWrite` and has already re-read the parent chain, run its guard and checked
 * the owner (`requireActiveOwner`) or team ([requireActiveTeam]) - and answers the new row's id. None opens a transaction of its own.
 */

/** Inserts a program under [workStreamId]; the name's uniqueness is the partial index's 409 (`uq_programs_name_active`). */
internal suspend fun insertProgramRow(workStreamId: UInt, name: String, description: String?, ownerPersonId: UInt, stamp: Long): UInt {
    val programs = ProgramService.Programs
    return programs.insert {
        it[programs.workStreamId] = workStreamId
        it[programs.name] = name
        it[programs.description] = description
        it[programs.ownerPersonId] = ownerPersonId
        it[programs.createdAt] = stamp
        it[programs.updatedAt] = stamp
    }[programs.id].value
}

/** Inserts a project under [programId] with an optional validated [window]; the name's uniqueness is the partial index's 409. */
internal suspend fun insertProjectRow(
    programId: UInt,
    name: String,
    description: String?,
    ownerPersonId: UInt,
    window: TargetWindow?,
    stamp: Long,
): UInt {
    val projects = ProjectService.Projects
    return projects.insert {
        it[projects.programId] = programId
        it[projects.name] = name
        it[projects.description] = description
        it[projects.ownerPersonId] = ownerPersonId
        it[projects.targetStart] = window?.start
        it[projects.targetEnd] = window?.end
        it[projects.createdAt] = stamp
        it[projects.updatedAt] = stamp
    }[projects.id].value
}

/** Inserts an UNSCHEDULED milestone under [projectId]; [scheduleRevision] is the plan revision the write will commit as. */
internal suspend fun insertMilestoneRow(
    projectId: UInt,
    teamId: UInt,
    name: String,
    description: String?,
    estimate: BigDecimal,
    scheduleRevision: Long,
    stamp: Long,
): UInt {
    val milestones = MilestoneService.Milestones
    return milestones.insert {
        it[milestones.projectId] = projectId
        it[milestones.teamId] = teamId
        it[milestones.name] = name
        it[milestones.description] = description
        it[milestones.estimateMd] = estimate
        it[milestones.scheduleRevision] = scheduleRevision
        it[milestones.createdAt] = stamp
        it[milestones.updatedAt] = stamp
    }[milestones.id].value
}

/**
 * The team of a new or changed milestone must be ACTIVE - a client-supplied FK is a 400, never a 500 from the constraint. The check
 * locks the team row `FOR SHARE`, which conflicts with `TeamService.delete`'s `lockActiveForWrite` (`FOR NO KEY UPDATE`): a delete
 * racing this write either commits first (the team reads inactive here, 400) or waits for this transaction and then counts the
 * milestone (409) - never an active milestone left on a deleted team. The plan lock held by the caller does not cover teams.
 */
internal suspend fun requireActiveTeam(teamId: UInt) {
    val teams = TeamService.Teams
    val exists = teams.select(teams.id)
        .where { (teams.id eq teamId) and teams.active() }
        .forUpdate(ForUpdateOption.PostgreSQL.ForShare)
        .toList()
        .isNotEmpty()
    if (!exists) throw BadRequestException("Unknown or deleted team ids: $teamId")
}
