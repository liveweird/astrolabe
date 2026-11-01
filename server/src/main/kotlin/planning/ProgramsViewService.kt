package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val ProgramsViewServiceKey = AttributeKey<ProgramsViewService>("ProgramsViewService")

/**
 * The programs document (`GET /views/programs`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the roadmap view's protocol)
 * that takes the PLAN revision FIRST, then the roadmap's rows ([loadRoadmapSnapshot]: the SAME loaders and kernel run, so the project
 * rows, `teams` and `links` equal the roadmap view's for the same plan) and the active work streams and programs (so EMPTY ones
 * appear), and folds them with the pure [ProgramsTree]. Reads `WorkStreams ⋈ People` and `Programs ⋈ People` on top of the roadmap
 * view's reads (`PublicHolidays` among them) and writes nothing (`persistence.md`).
 */
class ProgramsViewService(private val database: R2dbcDatabase) {
    suspend fun view(actor: PlanActor): ProgramsView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val snapshot = loadRoadmapSnapshot(actor)
        val tree = ProgramsTree.assemble(streamFacts(), programFacts(), snapshot.projects, snapshot.spans)
        ProgramsView(revision, snapshot.teams, snapshot.links, tree)
    }
}

/**
 * Every ACTIVE work stream with its owner's name (one batched lookup, the `ownerNames` reasoning). Streams and programs are read
 * apart from the projects' join so one without projects is not lost.
 */
private suspend fun streamFacts(): List<PlanStreamFact> {
    val streams = WorkStreamService.WorkStreams
    val rows = streams.selectAll().where { streams.active() }.toList()
    val owners = ownerNames(rows.map { it[streams.ownerPersonId].value })
    return rows.map { row ->
        PlanStreamFact(
            id = row[streams.id].value,
            name = row[streams.name],
            ownerName = owners.getValue(row[streams.ownerPersonId].value),
            startDate = row[streams.startDate],
            endDate = row[streams.endDate],
        )
    }
}

/** Every ACTIVE program with its owner's name; one whose work stream is deleted is dropped by [ProgramsTree.assemble]. */
private suspend fun programFacts(): List<PlanProgramFact> {
    val programs = ProgramService.Programs
    val rows = programs.selectAll().where { programs.active() }.toList()
    val owners = ownerNames(rows.map { it[programs.ownerPersonId].value })
    return rows.map { row ->
        PlanProgramFact(
            id = row[programs.id].value,
            workStreamId = row[programs.workStreamId].value,
            name = row[programs.name],
            ownerName = owners.getValue(row[programs.ownerPersonId].value),
        )
    }
}
