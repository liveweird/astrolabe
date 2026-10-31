package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The plan's cross-table reads that every node service shares. All of them run INSIDE the caller's transaction (the services open
 * it): the chain lookups behind the read-before-guard routes, the owner-name resolution and the active-owner check. Chains are
 * resolved fresh per request and never cached.
 */

/**
 * The route's authorization, re-run INSIDE the plan lock against the chain re-read there ([PlanRouteDeps.ownerGuard] and
 * `windowGuard` build it: the caller's person re-resolved `FOR SHARE`, the grant re-read). The route's own guard before
 * `call.receive` stays for the 404 -> 403 -> 400 ordering, but a request can be held open between that guard and the write
 * (a slow body), so ownership, the person link and the grant are only trusted as of the lock. A [ch.nokillswit.authz.ForbiddenException]
 * thrown here rolls the transaction back (no revision bump) and is audited centrally as `authz.denied`.
 */
internal typealias PlanGuard = suspend (OwnerChain) -> Unit

/**
 * The owners of a work stream's chain (just the stream's own), or null when the stream is missing or deleted — the route's 404.
 */
internal suspend fun workStreamChain(id: UInt): OwnerChain? {
    val streams = WorkStreamService.WorkStreams
    return streams.select(streams.ownerPersonId)
        .where { (streams.id eq id) and streams.active() }
        .toList()
        .singleOrNull()
        ?.let { OwnerChain(listOf(it[streams.ownerPersonId].value)) }
}

/** The owners of a program's chain, work stream first, or null when the program or any ancestor is missing or deleted. */
internal suspend fun programChain(id: UInt): OwnerChain? {
    val streams = WorkStreamService.WorkStreams
    val programs = ProgramService.Programs
    return programs.innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(streams.ownerPersonId, programs.ownerPersonId)
        .where { (programs.id eq id) and programs.active() and streams.active() }
        .toList()
        .singleOrNull()
        ?.let { OwnerChain(listOf(it[streams.ownerPersonId].value, it[programs.ownerPersonId].value)) }
}

/** The owners of a project's chain, work stream first and the project's own last, or null when it or any ancestor is gone. */
internal suspend fun projectChain(id: UInt): OwnerChain? {
    val streams = WorkStreamService.WorkStreams
    val programs = ProgramService.Programs
    val projects = ProjectService.Projects
    return projects.innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(streams.ownerPersonId, programs.ownerPersonId, projects.ownerPersonId)
        .where { (projects.id eq id) and projects.active() and programs.active() and streams.active() }
        .toList()
        .singleOrNull()
        ?.let {
            OwnerChain(
                listOf(it[streams.ownerPersonId].value, it[programs.ownerPersonId].value, it[projects.ownerPersonId].value),
            )
        }
}

/**
 * One batched lookup of the display names of the owners [ids]. The name is read WITHOUT an `active()` filter on purpose: an
 * ACTIVE node's owner is always an active person (the owner check below on every write, and `PersonService.delete`'s 409 while a
 * person still owns a node), so the foreign key guarantees the row and a missing name would be a broken invariant, not a state.
 */
internal suspend fun ownerNames(ids: Collection<UInt>): Map<UInt, String> {
    if (ids.isEmpty()) return emptyMap()
    val people = PersonService.People
    return people.select(people.id, people.name)
        .where { people.id inList ids.distinct() }
        .map { it[people.id].value to it[people.name] }
        .toList()
        .toMap()
}

/**
 * The owner of a node being written must be an ACTIVE person — a client-supplied FK is a 400, never a 500 from the constraint.
 * The check locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE` (the same pairing
 * `TeamService` uses for a manager): a delete racing this write either commits first (the person reads inactive here, 400) or
 * waits for this transaction and then finds the node (409) — never an active node left owned by a deleted person. The plan lock
 * the caller already holds is a different lock and does not cover people (people are not plan state).
 */
internal suspend fun requireActiveOwner(personId: UInt) {
    val people = PersonService.People
    val exists = people.select(people.id)
        .where { (people.id eq personId) and people.active() }
        .forUpdate(ForUpdateOption.PostgreSQL.ForShare)
        .toList()
        .isNotEmpty()
    if (!exists) throw BadRequestException("Unknown or deleted owner ids: $personId")
}

/** Whether an ACTIVE work stream, program or project is owned by [personId] — the person-delete 409 (`PersonService.delete`). */
suspend fun ownsActivePlanNode(personId: UInt): Boolean {
    val streams = WorkStreamService.WorkStreams
    val programs = ProgramService.Programs
    val projects = ProjectService.Projects
    return streams.selectAll().where { (streams.ownerPersonId eq personId) and streams.active() }.count() > 0 ||
        programs.selectAll().where { (programs.ownerPersonId eq personId) and programs.active() }.count() > 0 ||
        projects.selectAll().where { (projects.ownerPersonId eq personId) and projects.active() }.count() > 0
}
