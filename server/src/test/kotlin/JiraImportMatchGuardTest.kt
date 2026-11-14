package ch.nokillswit

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.jira.ImportRead
import ch.nokillswit.jira.ImportSnapshot
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportItem
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.requireResolvedTargets
import ch.nokillswit.users.UserRole
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The resolved-target guard over a confirmed suggested match (1.15): the BIND answers FIRST for the CREATE it replaces - the parent's chain
 * (the work stream for a program), the CREATE wording - so a blind `matches` entry is no oracle and no way from a `403` to a `200` for a
 * caller who owns only the matched node. Pure: the rows come from the kernel, the chains are written out.
 */
class JiraImportMatchGuardTest {
    private val tree = ImportTree(
        programs = listOf(node(7u, "Platform program")),
        projects = listOf(node(10u, "Initiative North", 7u)),
        milestones = emptyList(),
    )
    private val streamOwner = 100u
    private val programOwner = 101u
    private val nodeOwner = 102u // owns project 10 only
    private val read = ImportRead(
        1, ImportSnapshot(tree, listOf("Platform program"), emptyList(), listOf(PLATFORM), null, WorkingCalendar.MON_FRI),
        OwnerChain(listOf(streamOwner)),
        mapOf(
            (JiraLevel.PROGRAM to 7u) to OwnerChain(listOf(streamOwner, programOwner)),
            (JiraLevel.PROJECT to 10u) to OwnerChain(listOf(streamOwner, programOwner, nodeOwner)),
        ),
    )

    private fun user(id: UInt) = CallerPrincipal(userId = id, email = "u$id@test", roles = emptySet())
    private val admin = CallerPrincipal(userId = 1u, email = "admin@test", roles = setOf(UserRole.ADMIN))

    private fun items(matches: Map<String, UInt>, program: Boolean = false): List<JiraImportItem> {
        val issues = if (program) {
            listOf(issue("100", JIRA_PROGRAM, "Platform Program Renamed"))
        } else {
            listOf(issue("100", JIRA_PROGRAM, "Platform program"), issue("200", JIRA_PROJECT, "North initiative", parent = "100"))
        }
        val holders = if (program) emptyList() else listOf(holder("100", JiraLevel.PROGRAM, 7u, "Platform program"))
        return ImportCase(issues, tree = tree, holders = holders, defaults = JiraImportDefaults(teamId = PLATFORM.id), matches = matches)
            .plan().rows.map { it.item }
    }

    private fun refusal(person: UInt, rows: List<JiraImportItem>): String? = try {
        requireResolvedTargets(user(person), person, rows, read, guardedByName = false)
        null
    } catch (denied: ForbiddenException) {
        denied.message
    }

    @Test
    fun `a blind matches entry gives a caller the same 403 sentence as without it - the node's own owner and a stranger alike`() {
        val plain = items(emptyMap())
        val confirmed = items(mapOf("200" to 10u))
        assertEquals(JiraImportAction.BIND, confirmed.single { it.jiraId == "200" }.action, "the entry made it a BIND")
        for (person in listOf(nodeOwner, 999u)) {
            val without = refusal(person, plain)
            assertEquals("You do not own program Platform program, under which IMP-200 would be created", without, "person $person")
            assertEquals(without, refusal(person, confirmed), "person $person")
        }
    }

    @Test
    fun `whoever may create the row may also bind it, and an administrator always may`() {
        val confirmed = items(mapOf("200" to 10u))
        for (person in listOf(streamOwner, programOwner)) assertEquals(null, refusal(person, confirmed), "person $person")
        requireResolvedTargets(admin, null, confirmed, read, guardedByName = false)
    }

    @Test
    fun `a confirmed PROGRAM bind is guarded as the program it replaces would be - by the work stream`() {
        val plain = items(emptyMap(), program = true)
        val confirmed = items(mapOf("100" to 7u), program = true)
        assertEquals(JiraImportAction.BIND, confirmed.single().action)
        val without = refusal(programOwner, plain)
        assertEquals("You do not own the work stream, under which IMP-100 would be created", without)
        assertEquals(without, refusal(programOwner, confirmed), "the program's owner is not the stream's")
        assertEquals(null, refusal(streamOwner, confirmed))
    }

    @Test
    fun `a plain BIND by name is still guarded on its target only`() {
        val byName = ImportCase(
            listOf(issue("100", JIRA_PROGRAM, "Platform program"), issue("200", JIRA_PROJECT, "Initiative North", parent = "100")),
            tree = tree, holders = listOf(holder("100", JiraLevel.PROGRAM, 7u, "Platform program")),
        ).plan().rows.map { it.item }
        assertEquals(JiraImportAction.BIND, byName.single { it.jiraId == "200" }.action)
        assertEquals(null, refusal(nodeOwner, byName), "the node's owner binds the node, as before 1.15")
    }
}
