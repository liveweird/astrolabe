package ch.nokillswit

import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.DiscoveredLevel
import ch.nokillswit.jira.DiscoveryMarkers
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraJql
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraMappingState
import ch.nokillswit.jira.MappingResolution
import ch.nokillswit.jira.StoredMapping
import ch.nokillswit.jira.resolveEffectiveMapping
import ch.nokillswit.jira.sweepTypeIds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The mapping resolution the bind and the run share, and the sweep's type list, as pure functions. */
class JiraEffectiveMappingTest {
    private fun discovery(types: List<DiscoveredIssueType>, levels: List<DiscoveredLevel>) = JiraDiscovery(
        discoveredAt = 1, fieldCount = 0, issueTypeCount = types.size, fieldsTruncated = false, fields = emptyList(), issueTypes = types,
        levels = levels, markers = DiscoveryMarkers(),
    )

    private val epic = DiscoveredIssueType("10004", "Epic", 1, false)
    private val initiative = DiscoveredIssueType("10005", "Initiative", 2, false)
    private val milestoneOnly = JiraMapping(JiraMappingLevels(milestone = JiraLevelMapping(1, JiraLevelFields())))

    @Test
    fun `an unreadable stored mapping and a stale one are resolved without throwing, and the defaults apply when none is stored`() {
        val site = discovery(listOf(epic), listOf(DiscoveredLevel(1, listOf("Epic"))))
        assertEquals(MappingResolution.Unreadable, resolveEffectiveMapping(JiraMappingState(StoredMapping.Unreadable, site), site))
        val stale = JiraMapping(JiraMappingLevels(milestone = JiraLevelMapping(7, JiraLevelFields())))
        val invalid = assertIs<MappingResolution.Invalid>(resolveEffectiveMapping(JiraMappingState(StoredMapping.Valid(stale), site), site))
        assertTrue("hierarchy level 7" in invalid.problem, invalid.problem)
        val defaults = assertIs<MappingResolution.Usable>(resolveEffectiveMapping(JiraMappingState(StoredMapping.Unset, site), site))
        assertEquals(1, defaults.mapping.levels.milestone.hierarchyLevel)
        val state = JiraMappingState(StoredMapping.Valid(milestoneOnly), site)
        val stored = assertIs<MappingResolution.Usable>(resolveEffectiveMapping(state, site))
        assertEquals(milestoneOnly, stored.mapping)
    }

    @Test
    fun `the sweep names the types of every mapped level, and is null when the snapshot has none for one`() {
        val full = JiraMapping(
            JiraMappingLevels(
                project = JiraLevelMapping(2, JiraLevelFields()), milestone = JiraLevelMapping(1, JiraLevelFields()),
            ),
        )
        val site = discovery(listOf(epic, initiative), listOf(DiscoveredLevel(1, listOf("Epic")), DiscoveredLevel(2, listOf("Initiative"))))
        assertEquals(listOf("10005", "10004"), sweepTypeIds(full, site), "top level first, each id once")
        assertEquals(listOf("10004"), sweepTypeIds(milestoneOnly, site))
        // The snapshot's issue-type list can be cut while its level grouping is complete: the mapping validates, the type list is empty.
        val cut = discovery(emptyList(), listOf(DiscoveredLevel(1, listOf("Epic"))))
        assertNull(sweepTypeIds(milestoneOnly, cut))
        assertFailsWith<IllegalArgumentException> { JiraJql.scopeAndTypes(listOf("E2E"), emptyList()) }
        // A site's odd id (not digits) would make scopeAndTypes throw: the mapping resolves to no usable list instead.
        val odd = discovery(listOf(DiscoveredIssueType("1x4", "Epic", 1, false)), listOf(DiscoveredLevel(1, listOf("Epic"))))
        assertNull(sweepTypeIds(milestoneOnly, odd))
    }

    @Test
    fun `the run's queries are the scope, ordered, with the type list or the relative watermark`() {
        assertEquals(
            """project in ("CE","E2E") AND issuetype in (10004) ORDER BY id ASC""",
            JiraJql.full(listOf("CE", "E2E"), listOf("10004")),
        )
        assertEquals(
            """project in ("CE") AND issuetype in (10004,10005) ORDER BY id ASC""",
            JiraJql.sweep(listOf("CE"), listOf("10004", "10005")),
        )
        assertEquals("""project in ("CE") AND updated >= "-25m" ORDER BY updated ASC""", JiraJql.incremental(listOf("CE"), 25))
    }
}
