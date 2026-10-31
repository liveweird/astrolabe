package ch.nokillswit

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.authz.requireRoadmapEditorOrAdmin
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.PlanPermissions
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The `can:{}` kernel against the guards it mirrors (no server, no database): for every kind of actor and every chain position,
 * the flag the plan view would show equals "the guard the route runs lets this caller through". A guard that changes without the
 * kernel (or the reverse) turns this table red — the UI can never offer what the server refuses.
 */
class PlanPermissionsTest {
    private val stream = 10u
    private val program = 20u
    private val project = 30u
    private val outsider = 99u

    private data class Actor(val label: String, val caller: CallerPrincipal, val personId: UInt?, val granted: Boolean)

    private fun user(id: UInt) = CallerPrincipal(userId = id, email = "u$id@test", roles = emptySet())
    private val adminCaller = CallerPrincipal(userId = 1u, email = "admin@test", roles = setOf(UserRole.ADMIN))

    private val actors = listOf(
        Actor("admin", adminCaller, personId = null, granted = false),
        Actor("admin with an unrelated person", adminCaller, personId = outsider, granted = false),
        Actor("stream owner", user(2u), stream, false),
        Actor("program owner", user(3u), program, false),
        Actor("project owner", user(4u), project, false),
        Actor("stranger with a person", user(5u), outsider, false),
        Actor("person-less login", user(6u), null, false),
        Actor("roadmap editor, no person", user(7u), null, true),
        Actor("roadmap editor, stranger person", user(8u), outsider, true),
        Actor("project owner who is also a roadmap editor", user(9u), project, true),
    )

    private val chains = listOf(
        "work stream" to OwnerChain(listOf(stream)),
        "program" to OwnerChain(listOf(stream, program)),
        "project" to OwnerChain(listOf(stream, program, project)),
        "project whose owner is also the program owner" to OwnerChain(listOf(stream, program, program)),
        "project whose owner is also the stream owner" to OwnerChain(listOf(stream, program, stream)),
    )

    private fun allowed(block: () -> Unit): Boolean = try {
        block()
        true
    } catch (_: ForbiddenException) {
        false
    }

    private fun Actor.asPlanActor() = PlanActor(
        isAdmin = caller.roles.isNotEmpty(),
        personId = personId,
        roadmapEditor = granted && caller.roles.isEmpty(), // the route reads the grant only for a non-admin
    )

    @Test
    fun `the manage flag equals requireOwnerOrAdmin for every actor at every chain position`() {
        var cells = 0
        for (actor in actors) for ((level, chain) in chains) {
            val guard = allowed { requireOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canManage(actor.asPlanActor(), chain), "${actor.label} at the $level")
            cells++
        }
        assertEquals(actors.size * chains.size, cells)
    }

    @Test
    fun `the create-work-stream flag equals requireAdmin`() {
        for (actor in actors) {
            assertEquals(allowed { requireAdmin(actor.caller) }, PlanPermissions.canCreateWorkStream(actor.asPlanActor()), actor.label)
        }
    }

    @Test
    fun `the target-window flag equals requireTargetWindowEditorOrAdmin - the project's own owner alone is refused`() {
        val projectChain = chains.first { it.first == "project" }.second
        for (actor in actors) for ((level, chain) in chains.filter { it.second.owners.size == 3 }) {
            val lookup: suspend (UInt, Permission) -> Boolean =
                { _, permission -> actor.granted && permission == Permission.ROADMAP_EDITOR }
            val guard = allowed {
                runBlocking { requireTargetWindowEditorOrAdmin(actor.caller, actor.personId, chain, lookup) }
            }
            assertEquals(guard, PlanPermissions.canEditTargetWindow(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        // The named cases the table covers, spelled out so a regression reads plainly.
        val ownerOnly = Actor("project owner", user(4u), project, false)
        assertEquals(false, PlanPermissions.canEditTargetWindow(ownerOnly.asPlanActor(), projectChain))
        val programOwner = Actor("program owner", user(3u), program, false)
        assertTrue(PlanPermissions.canEditTargetWindow(programOwner.asPlanActor(), projectChain))
    }

    @Test
    fun `the edit-rank flag equals requireRoadmapEditorOrAdmin - ownership alone never ranks`() {
        for (actor in actors) {
            val lookup: suspend (UInt, Permission) -> Boolean =
                { _, permission -> actor.granted && permission == Permission.ROADMAP_EDITOR }
            val guard = allowed { runBlocking { requireRoadmapEditorOrAdmin(actor.caller, lookup) } }
            assertEquals(guard, PlanPermissions.canEditRank(actor.asPlanActor()), actor.label)
        }
        assertEquals(false, PlanPermissions.canEditRank(Actor("project owner", user(4u), project, false).asPlanActor()))
    }
}
