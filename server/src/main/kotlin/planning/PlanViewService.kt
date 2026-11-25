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
 * The plan tree (`GET /views/plan`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the timeline views' protocol) that takes
 * the revision FIRST and the rows after, takes no lock and writes nothing, so the revision, the three levels and the owners' names are
 * one snapshot and a write committing between the selects cannot tear the tree. They are folded together in memory (bounded by the
 * plan's scale) with the caller's `can` flags from [PlanPermissions]. The shared order tables ([readPlanOrder]) are read in the same
 * snapshot, right after the revision, in four selects whatever the number of streams: the work streams and each stream's programs
 * follow [PlanOrderKernels] (no stored row = by name, case-insensitive then id, closed streams last always); the projects stay by name.
 */
class PlanViewService(private val database: R2dbcDatabase) {
    suspend fun view(actor: PlanActor): PlanView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val order = readPlanOrder()
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

        val tree = PlanOrderKernels
            .orderWorkStreams(streamRows, order.order, { it[streams.id].value }, { it[streams.name] }, { it[streams.endDate] != null })
            .map { stream ->
                val streamId = stream[streams.id].value
                val streamChain = OwnerChain(listOf(stream[streams.ownerPersonId].value))
                val programNodes = PlanOrderKernels
                    .orderPrograms(
                        programsByStream[streamId].orEmpty(), order.order,
                        { it[programs.id].value }, { it[programs.workStreamId].value }, { it[programs.name] },
                    )
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
                                        createMilestone = PlanPermissions.canCreateMilestone(actor, projectChain),
                                        createDependency = PlanPermissions.canCreateDependency(actor, projectChain),
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
                        orderPrograms = PlanPermissions.canOrderPrograms(actor, streamChain),
                    ),
                    programOrderRevision = order.programRevision(streamId),
                    programs = programNodes,
                )
            }
        val can = PlanViewCan(PlanPermissions.canCreateWorkStream(actor), PlanPermissions.canOrderWorkStreams(actor))
        PlanView(revision, order.workStreamRevision, can, tree)
    }
}
