package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val PlanViewServiceKey = AttributeKey<PlanViewService>("PlanViewService")

/**
 * The plan tree (`GET /views/plan`): ONE read transaction that takes the revision FIRST and the rows after (no isolation upgrade —
 * a row newer than the revision only makes a later PUT carrying that revision answer a conservative 409), then folds the three levels
 * together in memory (bounded by the plan's scale) with the caller's `can` flags from [PlanPermissions]. Order: open work streams
 * before closed ones, every level by name (case-insensitive, then id).
 */
class PlanViewService(private val database: R2dbcDatabase) {
    suspend fun view(actor: PlanActor): PlanView = suspendTransaction(database) {
        val revision = readPlanRevision()
        val streams = WorkStreamService.WorkStreams
        val programs = ProgramService.Programs
        val projects = ProjectService.Projects
        val streamRows = streams.selectAll().where { streams.active() }.toList()
        val programRows = programs.selectAll().where { programs.active() }.toList()
        val projectRows = projects.selectAll().where { projects.active() }.toList()
        val names = ownerNames(
            streamRows.map { it[streams.ownerPersonId].value } +
                programRows.map { it[programs.ownerPersonId].value } +
                projectRows.map { it[projects.ownerPersonId].value },
        )
        val projectsByProgram = projectRows.groupBy { it[projects.programId].value }
        val programsByStream = programRows.groupBy { it[programs.workStreamId].value }

        val tree = streamRows
            .sortedWith(
                compareBy<ResultRow>({ it[streams.endDate] != null }, { it[streams.name].lowercase() }, { it[streams.id].value }),
            )
            .map { stream ->
                val streamId = stream[streams.id].value
                val streamChain = OwnerChain(listOf(stream[streams.ownerPersonId].value))
                val programNodes = programsByStream[streamId].orEmpty()
                    .sortedWith(compareBy<ResultRow>({ it[programs.name].lowercase() }, { it[programs.id].value }))
                    .map { program ->
                        val programId = program[programs.id].value
                        val programChain = OwnerChain(streamChain.owners + program[programs.ownerPersonId].value)
                        val projectNodes = projectsByProgram[programId].orEmpty()
                            .sortedWith(compareBy<ResultRow>({ it[projects.name].lowercase() }, { it[projects.id].value }))
                            .map { project ->
                                val projectChain = OwnerChain(programChain.owners + project[projects.ownerPersonId].value)
                                PlanProject(
                                    id = project[projects.id].value,
                                    programId = programId,
                                    workStreamId = streamId,
                                    name = project[projects.name],
                                    description = project[projects.description],
                                    ownerPersonId = project[projects.ownerPersonId].value,
                                    ownerName = names.getValue(project[projects.ownerPersonId].value),
                                    targetStart = project[projects.targetStart]?.toString(),
                                    targetEnd = project[projects.targetEnd]?.toString(),
                                    createdAt = project[projects.createdAt],
                                    updatedAt = project[projects.updatedAt],
                                    can = PlanProjectCan(
                                        edit = PlanPermissions.canManage(actor, projectChain),
                                        delete = PlanPermissions.canManage(actor, projectChain),
                                        editTargetWindow = PlanPermissions.canEditTargetWindow(actor, projectChain),
                                        move = PlanPermissions.canMove(actor, projectChain),
                                    ),
                                )
                            }
                        PlanProgram(
                            id = programId,
                            workStreamId = streamId,
                            name = program[programs.name],
                            description = program[programs.description],
                            ownerPersonId = program[programs.ownerPersonId].value,
                            ownerName = names.getValue(program[programs.ownerPersonId].value),
                            createdAt = program[programs.createdAt],
                            updatedAt = program[programs.updatedAt],
                            can = PlanProgramCan(
                                edit = PlanPermissions.canManage(actor, programChain),
                                delete = PlanPermissions.canManage(actor, programChain),
                                createProject = PlanPermissions.canManage(actor, programChain),
                                move = PlanPermissions.canMove(actor, programChain),
                            ),
                            projects = projectNodes,
                        )
                    }
                PlanWorkStream(
                    id = streamId,
                    name = stream[streams.name],
                    description = stream[streams.description],
                    ownerPersonId = stream[streams.ownerPersonId].value,
                    ownerName = names.getValue(stream[streams.ownerPersonId].value),
                    startDate = stream[streams.startDate].toString(),
                    endDate = stream[streams.endDate]?.toString(),
                    createdAt = stream[streams.createdAt],
                    updatedAt = stream[streams.updatedAt],
                    can = PlanWorkStreamCan(
                        edit = PlanPermissions.canManage(actor, streamChain),
                        delete = PlanPermissions.canManage(actor, streamChain),
                        createProgram = PlanPermissions.canManage(actor, streamChain),
                    ),
                    programs = programNodes,
                )
            }
        PlanView(revision, PlanViewCan(PlanPermissions.canCreateWorkStream(actor)), tree)
    }
}
