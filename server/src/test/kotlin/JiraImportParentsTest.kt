package ch.nokillswit

import ch.nokillswit.jira.ImportBrowsedIssue
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.parentCandidates
import ch.nokillswit.jira.parentsToRead
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The pure rule of the filtered browse's parent reads (1.13.2): which direct parents are fetched by id. One case per condition under
 * which a parent is NOT read, the case where it is, and the ordering and de-duplication. The site: Epic = milestone (Jira level 1),
 * Initiative = project (2), Program = program (3); the import's keys are `IMP`.
 */
class JiraImportParentsTest {
    private val keys = listOf("IMP")

    /** A milestone (an epic) under [parent] (an initiative, when [parentLevel] is the default). */
    private fun epic(id: String, parent: String? = "20", parentLevel: Int? = JIRA_PROJECT, parentType: String? = null) =
        issue(id, JIRA_EPIC, parent = parent, parentLevel = parentLevel, parentType = parentType)

    private fun initiative(id: String, parent: String? = "30", parentLevel: Int? = JIRA_PROGRAM) =
        issue(id, JIRA_PROJECT, parent = parent, parentLevel = parentLevel)

    private fun candidates(
        vararg children: ImportBrowsedIssue,
        known: Set<String> = children.mapTo(HashSet()) { it.observation.issueId },
        mapping: ch.nokillswit.jira.JiraMapping = importMapping(),
    ) = parentCandidates(children.toList(), known, mapping, IMPORT_DISCOVERY, keys).map { Triple(it.childId, it.parentId, it.wanted) }

    @Test
    fun `a milestone whose project is missing reads it, a project whose program is missing reads it`() {
        assertEquals(listOf(Triple("1", "20", JiraLevel.PROJECT)), candidates(epic("1")))
        assertEquals(listOf(Triple("2", "30", JiraLevel.PROGRAM)), candidates(initiative("2")))
    }

    @Test
    fun `a program has no parent to read`() {
        assertEquals(emptyList(), candidates(issue("3", JIRA_PROGRAM, parent = "99", parentLevel = 4)))
    }

    @Test
    fun `an item with no parent reads nothing`() {
        assertEquals(emptyList(), candidates(epic("1", parent = null)))
    }

    @Test
    fun `a level below the top whose upper level the mapping skips reads nothing`() {
        assertEquals(emptyList(), candidates(epic("1"), mapping = importMapping(project = false)))
        assertEquals(emptyList(), candidates(initiative("2"), mapping = importMapping(program = false)))
    }

    @Test
    fun `a parent that is already a row is not read`() {
        val child = epic("1")
        assertEquals(emptyList(), candidates(child, known = setOf("1", "20")))
    }

    @Test
    fun `a parent whose key is outside the import's projects is not read, one without a key is`() {
        val other = epic("1").let { it.copy(observation = it.observation.copy(parentIssueKey = "OTHER-20")) }
        assertEquals(emptyList(), candidates(other))
        val keyless = epic("2").let { it.copy(observation = it.observation.copy(parentIssueKey = null)) }
        assertEquals(listOf("20"), candidates(keyless).map { it.second })
    }

    @Test
    fun `a parent the child's type object puts at another level is not read, one the object does not place is`() {
        assertEquals(emptyList(), candidates(epic("1", parentLevel = JIRA_EPIC)), "an epic under an epic")
        assertEquals(emptyList(), candidates(epic("2", parentLevel = JIRA_PROGRAM)), "an epic under a program: not the wanted level")
        assertEquals(listOf("20"), candidates(epic("3", parentLevel = null, parentType = null)).map { it.second }, "no type object at all")
        assertEquals(listOf("20"), candidates(epic("4", parentLevel = null, parentType = "10005")).map { it.second }, "resolved by type id")
        assertEquals(emptyList(), candidates(epic("5", parentLevel = null, parentType = "10004")), "resolved by type id to epic")
    }

    @Test
    fun `a linked child, a linked parent and a parent already tried cost no read, an open pair does`() {
        val pairs = parentCandidates(
            listOf(epic("1", parent = "21"), epic("2", parent = "22"), epic("3", parent = "23"), epic("4", parent = "24")),
            emptySet(), importMapping(), IMPORT_DISCOVERY, keys,
        )
        assertEquals(listOf("24"), parentsToRead(pairs, linked = setOf("1", "22"), tried = setOf("23")))
    }

    @Test
    fun `a parent two children name is read once, the ids come in ascending numeric order`() {
        val pairs = parentCandidates(
            listOf(epic("1", parent = "100"), epic("2", parent = "9"), epic("3", parent = "100"), epic("4", parent = "20")),
            emptySet(), importMapping(), IMPORT_DISCOVERY, keys,
        )
        assertEquals(listOf("9", "20", "100"), parentsToRead(pairs, emptySet(), emptySet()))
    }

    @Test
    fun `the second round asks only about the parents the first one added`() {
        // Round 1's children are the search's rows; round 2's are the parents it fetched: the first round's rows are not asked again.
        val program = issue("30", JIRA_PROGRAM)
        val fetchedProject = initiative("20", parent = "30")
        val rowsAfterRound1 = setOf("1", "20")
        assertEquals(
            listOf(Triple("20", "30", JiraLevel.PROGRAM)),
            parentCandidates(listOf(fetchedProject), rowsAfterRound1, importMapping(), IMPORT_DISCOVERY, keys)
                .map { Triple(it.childId, it.parentId, it.wanted) },
        )
        val ofProgram = parentCandidates(listOf(program), rowsAfterRound1, importMapping(), IMPORT_DISCOVERY, keys)
        assertEquals(emptyList(), ofProgram.map { it.parentId })
    }
}
