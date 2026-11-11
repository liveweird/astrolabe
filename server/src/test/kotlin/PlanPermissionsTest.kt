package ch.nokillswit

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireAncestorOwnerOrAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.authz.requireOwnerOrTeamManagerOrAdmin
import ch.nokillswit.authz.requireRoadmapEditorOrAdmin
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.authz.requireTeamManagerOfAllOrAdmin
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.PlanPermissions
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    private val teamA = 100u
    private val teamB = 101u
    private val teamC = 102u

    /** [managed] = the ACTIVE teams the actor manages (what `TeamService.activeManagedTeamIds` would answer for a non-admin). */
    private data class Actor(
        val label: String,
        val caller: CallerPrincipal,
        val personId: UInt?,
        val granted: Boolean,
        val managed: Set<UInt> = emptySet(),
    )

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
        Actor("manager of team A, no person", user(10u), null, false, setOf(teamA)),
        Actor("manager of teams A and B, stranger person", user(11u), outsider, false, setOf(teamA, teamB)),
        Actor("project owner who also manages team A", user(12u), project, false, setOf(teamA)),
        Actor("stream owner who also manages team B", user(13u), stream, false, setOf(teamB)),
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
        managedTeamIds = if (caller.roles.isEmpty()) managed else emptySet(), // nor are the managed teams looked up for an admin
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
    fun `the move flag equals requireAncestorOwnerOrAdmin - the node's own owner alone is refused`() {
        for (actor in actors) for ((level, chain) in chains) {
            val guard = allowed { requireAncestorOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canMove(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        val projectChain = chains.first { it.first == "project" }.second
        val ownerOnly = Actor("project owner", user(4u), project, false)
        assertFalse(PlanPermissions.canMove(ownerOnly.asPlanActor(), projectChain))
        assertTrue(PlanPermissions.canMove(Actor("program owner", user(3u), program, false).asPlanActor(), projectChain))
        val streamChain = chains.first { it.first == "work stream" }.second
        assertFalse(PlanPermissions.canMove(Actor("stream owner", user(2u), stream, false).asPlanActor(), streamChain))
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

    @Test
    fun `the manage-baselines flag equals requireRoadmapEditorOrAdmin - it is the rank arithmetic under its own name`() {
        for (actor in actors) {
            val lookup: suspend (UInt, Permission) -> Boolean =
                { _, permission -> actor.granted && permission == Permission.ROADMAP_EDITOR }
            val guard = allowed { runBlocking { requireRoadmapEditorOrAdmin(actor.caller, lookup) } }
            assertEquals(guard, PlanPermissions.canManageBaselines(actor.asPlanActor()), actor.label)
            val planActor = actor.asPlanActor()
            assertEquals(PlanPermissions.canEditRank(planActor), PlanPermissions.canManageBaselines(planActor), actor.label)
        }
        assertFalse(PlanPermissions.canManageBaselines(Actor("project owner", user(4u), project, false).asPlanActor()), "ownership alone")
        assertFalse(PlanPermissions.canManageBaselines(Actor("team manager", user(10u), null, false, setOf(teamA)).asPlanActor()))
    }

    @Test
    fun `the create-milestone flag equals requireOwnerOrAdmin on the project's chain - it is the manage arithmetic`() {
        for (actor in actors) for ((level, chain) in chains.filter { it.second.owners.size == 3 }) {
            val guard = allowed { requireOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canCreateMilestone(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        val projectChain = chains.first { it.first == "project" }.second
        // A team manager who owns nothing on the chain creates no milestone; the project's own owner does.
        val manager = actors.first { it.label == "manager of team A, no person" }
        assertFalse(PlanPermissions.canCreateMilestone(manager.asPlanActor(), projectChain))
        assertTrue(PlanPermissions.canCreateMilestone(actors.first { it.label == "project owner" }.asPlanActor(), projectChain))
    }

    @Test
    fun `the create-dependency flag equals requireOwnerOrAdmin on the successor's chain - the predecessor's owner is refused`() {
        for (actor in actors) for ((level, chain) in chains.filter { it.second.owners.size == 3 }) {
            val guard = allowed { requireOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canCreateDependency(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        // The link's predecessor lives in ANOTHER project: its owner appears on no part of the successor's chain, so the flag is off.
        val successorChain = OwnerChain(listOf(stream, program, project))
        val predecessorOwner = Actor("owner of the predecessor's project", user(14u), outsider, false)
        assertFalse(PlanPermissions.canCreateDependency(predecessorOwner.asPlanActor(), successorChain))
        val manager = actors.first { it.label == "manager of team A, no person" }
        assertFalse(PlanPermissions.canCreateDependency(manager.asPlanActor(), successorChain), "a team manager as such has no say")
    }

    @Test
    fun `the delete-dependency flag equals requireOwnerOrAdmin on the successor's project chain`() {
        for (actor in actors) for ((level, chain) in chains.filter { it.second.owners.size == 3 }) {
            val guard = allowed { requireOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canDeleteDependency(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        val successorChain = OwnerChain(listOf(stream, program, project))
        val ownerOfSuccessor = actors.first { it.label == "project owner" }
        assertTrue(PlanPermissions.canDeleteDependency(ownerOfSuccessor.asPlanActor(), successorChain))
        assertFalse(PlanPermissions.canDeleteDependency(ownerOfSuccessor.asPlanActor(), OwnerChain(listOf(stream, program, outsider))))
    }

    @Test
    fun `the edit-dependency flag equals requireOwnerOrAdmin on the successor's project chain`() {
        for (actor in actors) for ((level, chain) in chains.filter { it.second.owners.size == 3 }) {
            val guard = allowed { requireOwnerOrAdmin(actor.caller, actor.personId, chain) }
            assertEquals(guard, PlanPermissions.canEditDependency(actor.asPlanActor(), chain), "${actor.label} at the $level")
        }
        val successorChain = OwnerChain(listOf(stream, program, project))
        val ownerOfSuccessor = actors.first { it.label == "project owner" }
        assertTrue(PlanPermissions.canEditDependency(ownerOfSuccessor.asPlanActor(), successorChain))
        assertFalse(PlanPermissions.canEditDependency(ownerOfSuccessor.asPlanActor(), OwnerChain(listOf(stream, program, outsider))))
    }

    @Test
    fun `the schedule flag equals requireTeamManagerOrAdmin for every actor and team - ownership never schedules`() {
        var cells = 0
        for (actor in actors) for (team in listOf(teamA, teamB, teamC)) {
            val lookup: suspend (UInt, UInt) -> Boolean = { teamId, userId -> userId == actor.caller.userId && teamId in actor.managed }
            val guard = allowed { runBlocking { requireTeamManagerOrAdmin(actor.caller, team, lookup) } }
            assertEquals(guard, PlanPermissions.canSchedule(actor.asPlanActor(), team), "${actor.label} on team $team")
            cells++
        }
        assertEquals(actors.size * 3, cells)
        val projectOwner = actors.first { it.label == "project owner" }.asPlanActor()
        assertFalse(PlanPermissions.canSchedule(projectOwner, teamA), "the project owner, as such, schedules nothing")
        val ownerAndManager = actors.first { it.label == "project owner who also manages team A" }.asPlanActor()
        assertTrue(PlanPermissions.canSchedule(ownerAndManager, teamA))
        assertFalse(PlanPermissions.canSchedule(ownerAndManager, teamB), "only the managed team")
        assertTrue(PlanPermissions.canSchedule(actors.first { it.label == "admin" }.asPlanActor(), teamC), "ADMIN schedules every team")
    }

    @Test
    fun `the acknowledge flag equals requireOwnerOrTeamManagerOrAdmin for every actor, chain and team - a manager counts on a team only`() {
        var cells = 0
        for (actor in actors) for ((level, chain) in chains) for (team in listOf(null, teamA, teamB, teamC)) {
            val lookup: suspend (UInt, UInt) -> Boolean = { teamId, userId -> userId == actor.caller.userId && teamId in actor.managed }
            val guard = allowed {
                runBlocking { requireOwnerOrTeamManagerOrAdmin(actor.caller, actor.personId, chain, team, lookup) }
            }
            val flag = PlanPermissions.canAcknowledgeDeviations(actor.asPlanActor(), chain, team)
            assertEquals(guard, flag, "${actor.label} at the $level, team $team")
            cells++
        }
        assertEquals(actors.size * chains.size * 4, cells)
        val projectChain = chains.first { it.first == "project" }.second
        val manager = actors.first { it.label == "manager of team A, no person" }.asPlanActor()
        assertTrue(PlanPermissions.canAcknowledgeDeviations(manager, projectChain, teamA), "the milestone's team manager")
        assertFalse(PlanPermissions.canAcknowledgeDeviations(manager, projectChain, teamB), "another team's manager")
        assertFalse(PlanPermissions.canAcknowledgeDeviations(manager, projectChain, null), "a program or project binding has no team")
    }

    @Test
    fun `the capacity and order flags equal requireTeamManagerOrAdmin - they are the schedule arithmetic under their own names`() {
        for (actor in actors) for (team in listOf(teamA, teamB, teamC)) {
            val lookup: suspend (UInt, UInt) -> Boolean = { teamId, userId -> userId == actor.caller.userId && teamId in actor.managed }
            val guard = allowed { runBlocking { requireTeamManagerOrAdmin(actor.caller, team, lookup) } }
            assertEquals(guard, PlanPermissions.canEditCapacity(actor.asPlanActor(), team), "${actor.label} edits capacity of team $team")
            assertEquals(guard, PlanPermissions.canEditTeamOrder(actor.asPlanActor(), team), "${actor.label} edits the order of team $team")
        }
        val projectOwner = actors.first { it.label == "project owner" }.asPlanActor()
        assertFalse(PlanPermissions.canEditCapacity(projectOwner, teamA), "the project owner, as such, sets no capacity")
        assertFalse(PlanPermissions.canEditTeamOrder(projectOwner, teamA), "nor orders the team")
        val manager = actors.first { it.label == "project owner who also manages team A" }.asPlanActor()
        assertTrue(PlanPermissions.canEditCapacity(manager, teamA))
        assertFalse(PlanPermissions.canEditTeamOrder(manager, teamB), "only the managed team")
    }

    @Test
    fun `a team set passes requireTeamManagerOfAllOrAdmin exactly when every member's schedule flag holds`() {
        val sets = listOf(listOf(teamA), listOf(teamB), listOf(teamA, teamB), listOf(teamB, teamC), listOf(teamA, teamB, teamC))
        var cells = 0
        for (actor in actors) for (set in sets) {
            val lookup: suspend (UInt) -> Set<UInt> = { userId -> if (userId == actor.caller.userId) actor.managed else emptySet() }
            val guard = allowed { runBlocking { requireTeamManagerOfAllOrAdmin(actor.caller, set, lookup) } }
            val flags = set.all { PlanPermissions.canSchedule(actor.asPlanActor(), it) }
            assertEquals(flags, guard, "${actor.label} on $set")
            cells++
        }
        assertEquals(actors.size * sets.size, cells)
        val twoTeams = actors.first { it.label == "manager of teams A and B, stranger person" }.asPlanActor()
        assertTrue(listOf(teamA, teamB).all { PlanPermissions.canSchedule(twoTeams, it) })
        assertFalse(listOf(teamA, teamB, teamC).all { PlanPermissions.canSchedule(twoTeams, it) }, "one team short refuses the set")
    }
}
