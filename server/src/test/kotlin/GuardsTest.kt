package ch.nokillswit

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireFeatureEnabled
import ch.nokillswit.authz.requireAncestorOwnerOrAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.authz.requireOwnerOrTeamManagerOrAdmin
import ch.nokillswit.authz.requireRoadmapEditorOrAdmin
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.authz.requireSelfOrAdmin
import ch.nokillswit.authz.requireTeamManagerOfAllOrAdmin
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Pure unit tests for the authz guards (no server, no database). */
class GuardsTest {

    private val admin = CallerPrincipal(userId = 1u, email = "admin@test", roles = setOf(UserRole.ADMIN))
    private val user = CallerPrincipal(userId = 2u, email = "user@test", roles = emptySet())

    @Test
    fun `isAdmin reflects the ADMIN role`() {
        assertTrue(admin.isAdmin())
        assertFalse(user.isAdmin())
    }

    @Test
    fun `requireFeatureEnabled rejects a caller whose set carries the feature`() {
        requireFeatureEnabled(user, ch.nokillswit.users.Feature.MFA)
        val gated = CallerPrincipal(
            userId = 3u,
            email = "gated@test",
            roles = emptySet(),
            disabledFeatures = setOf(ch.nokillswit.users.Feature.MFA),
        )
        assertFailsWith<ForbiddenException> { requireFeatureEnabled(gated, ch.nokillswit.users.Feature.MFA) }
    }

    @Test
    fun `requireAdmin passes an admin and rejects a regular user`() {
        requireAdmin(admin)
        assertFailsWith<ForbiddenException> { requireAdmin(user) }
    }

    @Test
    fun `requireSelfOrAdmin allows self, allows admin on anyone, rejects a third party`() {
        requireSelfOrAdmin(user, targetUserId = 2u)
        requireSelfOrAdmin(admin, targetUserId = 2u)
        assertFailsWith<ForbiddenException> { requireSelfOrAdmin(user, targetUserId = 3u) }
    }

    @Test
    fun `requireTeamManagerOrAdmin passes an admin without consulting the lookup, passes the manager, rejects everyone else uniformly`() =
        runBlocking<Unit> {
            val asked = mutableListOf<Pair<UInt, UInt>>()
            val managerOfTeam7: suspend (UInt, UInt) -> Boolean = { team, who ->
                asked += team to who
                team == 7u && who == user.userId
            }
            requireTeamManagerOrAdmin(admin, teamId = 7u, isManager = managerOfTeam7)
            requireTeamManagerOrAdmin(admin, teamId = 999u, isManager = managerOfTeam7)
            assertEquals(emptyList(), asked, "an admin never reaches the lookup")

            requireTeamManagerOrAdmin(user, teamId = 7u, isManager = managerOfTeam7)
            val stranger = CallerPrincipal(userId = 9u, email = "stranger@test", roles = emptySet())
            assertFailsWith<ForbiddenException> { requireTeamManagerOrAdmin(stranger, teamId = 7u, isManager = managerOfTeam7) }
            // The manager of ANOTHER team, and an unknown team, fail the same way (the lookup answers false).
            assertFailsWith<ForbiddenException> { requireTeamManagerOrAdmin(user, teamId = 8u, isManager = managerOfTeam7) }
            assertFailsWith<ForbiddenException> { requireTeamManagerOrAdmin(user, teamId = 999999u, isManager = managerOfTeam7) }
        }

    @Test
    fun `requireTeamManagerOrAdmin fails closed - a lookup failure propagates for a non-admin and is never reached for an admin`() =
        runBlocking<Unit> {
            val broken: suspend (UInt, UInt) -> Boolean = { _, _ -> error("database unavailable") }
            requireTeamManagerOrAdmin(admin, teamId = 7u, isManager = broken)
            val failure = assertFailsWith<IllegalStateException> { requireTeamManagerOrAdmin(user, teamId = 7u, isManager = broken) }
            assertEquals("database unavailable", failure.message)
        }

    @Test
    fun `requireRoadmapEditorOrAdmin never consults the lookup for an admin, passes a grant holder and rejects everyone else`() =
        runBlocking<Unit> {
            val asked = mutableListOf<Pair<UInt, Permission>>()
            val grantedToUser: suspend (UInt, Permission) -> Boolean = { who, permission ->
                asked += who to permission
                who == user.userId && permission == Permission.ROADMAP_EDITOR
            }
            requireRoadmapEditorOrAdmin(admin, grantedToUser)
            assertEquals(emptyList(), asked, "an admin never reaches the lookup")

            requireRoadmapEditorOrAdmin(user, grantedToUser)
            assertEquals(listOf(user.userId to Permission.ROADMAP_EDITOR), asked)
            val stranger = CallerPrincipal(userId = 9u, email = "stranger@test", roles = emptySet())
            assertFailsWith<ForbiddenException> { requireRoadmapEditorOrAdmin(stranger, grantedToUser) }
        }

    @Test
    fun `requireRoadmapEditorOrAdmin fails closed - a lookup failure propagates for a non-admin`() = runBlocking<Unit> {
        val broken: suspend (UInt, Permission) -> Boolean = { _, _ -> error("database unavailable") }
        requireRoadmapEditorOrAdmin(admin, broken)
        val failure = assertFailsWith<IllegalStateException> { requireRoadmapEditorOrAdmin(user, broken) }
        assertEquals("database unavailable", failure.message)
    }

    @Test
    fun `OwnerChain ancestors drop the node's own owner`() {
        assertEquals(listOf(10u, 20u), OwnerChain(listOf(10u, 20u, 30u)).ancestors.owners)
        assertEquals(emptyList(), OwnerChain(listOf(10u)).ancestors.owners)
        assertEquals(emptyList(), OwnerChain(emptyList()).ancestors.owners)
    }

    @Test
    fun `requireOwnerOrAdmin - admin ignores the chain, an owner at or above passes, a person-less caller and a stranger do not`() {
        val chain = OwnerChain(listOf(10u, 20u, 30u)) // work stream, program, project
        requireOwnerOrAdmin(admin, callerPersonId = null, chain = chain)
        requireOwnerOrAdmin(admin, callerPersonId = 999u, chain = OwnerChain(emptyList()))
        requireOwnerOrAdmin(user, callerPersonId = 30u, chain = chain) // the node's own owner
        requireOwnerOrAdmin(user, callerPersonId = 20u, chain = chain) // an owner above
        requireOwnerOrAdmin(user, callerPersonId = 10u, chain = chain)
        assertFailsWith<ForbiddenException> { requireOwnerOrAdmin(user, callerPersonId = null, chain = chain) }
        assertFailsWith<ForbiddenException> { requireOwnerOrAdmin(user, callerPersonId = 99u, chain = chain) }
        assertFailsWith<ForbiddenException> { requireOwnerOrAdmin(user, callerPersonId = 10u, chain = OwnerChain(emptyList())) }
    }

    @Test
    fun `requireOwnerOrTeamManagerOrAdmin - admin, an owner and the team's manager pass, the lookup is asked only when it can matter`() =
        runBlocking<Unit> {
            val chain = OwnerChain(listOf(10u, 20u, 30u))
            val asked = mutableListOf<Pair<UInt, UInt>>()
            val managerOfTeam7: suspend (UInt, UInt) -> Boolean = { team, who ->
                asked += team to who
                team == 7u && who == user.userId
            }
            requireOwnerOrTeamManagerOrAdmin(admin, null, chain, 7u, managerOfTeam7)
            requireOwnerOrTeamManagerOrAdmin(user, 20u, chain, 7u, managerOfTeam7) // an owner above
            requireOwnerOrTeamManagerOrAdmin(user, 30u, chain, null, managerOfTeam7) // the node's own owner, no team
            assertEquals(emptyList(), asked, "an admin and an owner never reach the lookup")

            // The manager of the milestone's team, with no person or an unrelated one.
            requireOwnerOrTeamManagerOrAdmin(user, null, chain, 7u, managerOfTeam7)
            requireOwnerOrTeamManagerOrAdmin(user, 99u, chain, 7u, managerOfTeam7)
            assertEquals(listOf(7u to user.userId, 7u to user.userId), asked)

            // A program or project binding has no team: the manager as such is refused and the lookup is not asked.
            assertFailsWith<ForbiddenException> { requireOwnerOrTeamManagerOrAdmin(user, null, chain, null, managerOfTeam7) }
            assertEquals(2, asked.size, "no team, no question")
            // Another team's manager, and a stranger who manages nothing.
            assertFailsWith<ForbiddenException> { requireOwnerOrTeamManagerOrAdmin(user, 99u, chain, 8u, managerOfTeam7) }
            val stranger = CallerPrincipal(userId = 9u, email = "stranger@test", roles = emptySet())
            assertFailsWith<ForbiddenException> { requireOwnerOrTeamManagerOrAdmin(stranger, 99u, chain, 7u, managerOfTeam7) }
            assertFailsWith<ForbiddenException> { requireOwnerOrTeamManagerOrAdmin(stranger, null, chain, 7u, managerOfTeam7) }
        }

    @Test
    fun `requireOwnerOrTeamManagerOrAdmin fails closed - a lookup failure propagates for a caller who owns nothing`() = runBlocking<Unit> {
        val chain = OwnerChain(listOf(10u, 20u, 30u))
        val broken: suspend (UInt, UInt) -> Boolean = { _, _ -> error("database unavailable") }
        requireOwnerOrTeamManagerOrAdmin(admin, null, chain, 7u, broken)
        requireOwnerOrTeamManagerOrAdmin(user, 10u, chain, 7u, broken)
        // No team: nothing to ask, so the verdict is the owner arithmetic's own 403, not the failure.
        assertFailsWith<ForbiddenException> { requireOwnerOrTeamManagerOrAdmin(user, 99u, chain, null, broken) }
        val failure = assertFailsWith<IllegalStateException> { requireOwnerOrTeamManagerOrAdmin(user, 99u, chain, 7u, broken) }
        assertEquals("database unavailable", failure.message)
    }

    @Test
    fun `requireTeamManagerOfAllOrAdmin - admin passes unasked, a manager only when EVERY listed team is theirs`() =
        runBlocking<Unit> {
            val asked = mutableListOf<UInt>()
            val managed: suspend (UInt) -> Set<UInt> = { who -> asked += who; setOf(10u, 11u) }
            requireTeamManagerOfAllOrAdmin(admin, listOf(1u, 2u, 3u), managed)
            assertEquals(emptyList(), asked, "ADMIN short-circuits before the lookup")

            requireTeamManagerOfAllOrAdmin(user, listOf(10u, 11u), managed)
            requireTeamManagerOfAllOrAdmin(user, listOf(11u), managed)
            assertEquals(listOf(user.userId, user.userId), asked, "one lookup per call, whatever the set's size")

            for (set in listOf(listOf(10u, 12u), listOf(12u, 10u), listOf(12u), listOf(10u, 11u, 99u))) {
                val refused = assertFailsWith<ForbiddenException> { requireTeamManagerOfAllOrAdmin(user, set, managed) }
                assertEquals("Team manager or admin role required", refused.message, "the single-team guard's words: a uniform 403 ($set)")
            }
            assertEquals(2 + 4, asked.size, "each refused call asked once too")
        }

    @Test
    fun `requireTeamManagerOfAllOrAdmin fails closed - a throwing lookup propagates for a non-admin, a manager of nothing is refused`() =
        runBlocking<Unit> {
            val broken: suspend (UInt) -> Set<UInt> = { error("database unavailable") }
            requireTeamManagerOfAllOrAdmin(admin, listOf(1u), broken)
            assertEquals("database unavailable", assertFailsWith<IllegalStateException> {
                requireTeamManagerOfAllOrAdmin(user, listOf(1u), broken)
            }.message)
            assertFailsWith<ForbiddenException> { requireTeamManagerOfAllOrAdmin(user, listOf(1u)) { emptySet() } }
        }

    @Test
    fun `requireAncestorOwnerOrAdmin - only an owner ABOVE the node passes, the node's own owner and a stranger do not`() {
        val chain = OwnerChain(listOf(10u, 20u, 30u))
        requireAncestorOwnerOrAdmin(admin, callerPersonId = null, chain = chain)
        requireAncestorOwnerOrAdmin(user, callerPersonId = 20u, chain = chain)
        requireAncestorOwnerOrAdmin(user, callerPersonId = 10u, chain = chain)
        assertFailsWith<ForbiddenException> { requireAncestorOwnerOrAdmin(user, callerPersonId = 30u, chain = chain) }
        assertFailsWith<ForbiddenException> { requireAncestorOwnerOrAdmin(user, callerPersonId = null, chain = chain) }
        assertFailsWith<ForbiddenException> { requireAncestorOwnerOrAdmin(user, callerPersonId = 99u, chain = chain) }
        assertFailsWith<ForbiddenException> { requireAncestorOwnerOrAdmin(user, callerPersonId = 10u, chain = OwnerChain(listOf(10u))) }
    }

    @Test
    fun `an owner who repeats on the chain counts as an owner above the project`() = runBlocking<Unit> {
        val noGrant: suspend (UInt, Permission) -> Boolean = { _, _ -> false }
        // The program owner also owns the project: [stream, program, program].
        requireTargetWindowEditorOrAdmin(user, 20u, OwnerChain(listOf(10u, 20u, 20u)), noGrant)
        requireOwnerOrAdmin(user, callerPersonId = 20u, chain = OwnerChain(listOf(10u, 20u, 20u)))
        // The stream owner also owns the project: [stream, program, stream].
        requireTargetWindowEditorOrAdmin(user, 10u, OwnerChain(listOf(10u, 20u, 10u)), noGrant)
        // Owning ONLY the project (a distinct last owner) is still refused.
        assertFailsWith<ForbiddenException> { requireTargetWindowEditorOrAdmin(user, 30u, OwnerChain(listOf(10u, 20u, 30u)), noGrant) }
    }

    @Test
    fun `requireTargetWindowEditorOrAdmin - admin, an ancestor owner without the lookup, a grant, never the project's own owner alone`() =
        runBlocking<Unit> {
            val chain = OwnerChain(listOf(10u, 20u, 30u))
            val asked = mutableListOf<UInt>()
            val noGrant: suspend (UInt, Permission) -> Boolean = { who, _ -> asked += who; false }
            requireTargetWindowEditorOrAdmin(admin, null, chain, noGrant)
            requireTargetWindowEditorOrAdmin(user, 20u, chain, noGrant) // program owner
            requireTargetWindowEditorOrAdmin(user, 10u, chain, noGrant) // work stream owner
            assertEquals(emptyList(), asked, "admin and ancestor owners never reach the lookup")

            // The project's own owner is deliberately not an ancestor: alone they are refused.
            assertFailsWith<ForbiddenException> { requireTargetWindowEditorOrAdmin(user, 30u, chain, noGrant) }
            assertFailsWith<ForbiddenException> { requireTargetWindowEditorOrAdmin(user, null, chain, noGrant) }
            assertEquals(listOf(user.userId, user.userId), asked)

            // ... unless they also hold the grant.
            val granted: suspend (UInt, Permission) -> Boolean = { who, permission ->
                who == user.userId && permission == Permission.ROADMAP_EDITOR
            }
            requireTargetWindowEditorOrAdmin(user, 30u, chain, granted)
            requireTargetWindowEditorOrAdmin(user, null, chain, granted)
        }

    @Test
    fun `requireTargetWindowEditorOrAdmin fails closed - a throwing lookup propagates for a caller who is no ancestor owner`() =
        runBlocking<Unit> {
            val chain = OwnerChain(listOf(10u, 20u, 30u))
            val broken: suspend (UInt, Permission) -> Boolean = { _, _ -> error("database unavailable") }
            requireTargetWindowEditorOrAdmin(admin, null, chain, broken)
            requireTargetWindowEditorOrAdmin(user, 20u, chain, broken)
            val failure = assertFailsWith<IllegalStateException> {
                requireTargetWindowEditorOrAdmin(user, 30u, chain, broken)
            }
            assertEquals("database unavailable", failure.message)
        }
}
