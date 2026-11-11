package ch.nokillswit

import ch.nokillswit.infra.time.MILLIS_PER_DAY
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraObservation
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.admits
import ch.nokillswit.jira.isActive
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The import filter's pure rule (1.13.2): `admits` and `isActive`. No database, no site. */
class JiraImportFilterTest {
    private val now = 1_800_000_000_000L

    private fun observed(category: JiraStatusCategory = JiraStatusCategory.TODO, updated: Long? = now): JiraObservation =
        issue("1", JIRA_EPIC).observation.copy(statusCategory = category, jiraUpdatedAt = updated)

    @Test
    fun `a done item is left out only when excludeDone is on`() {
        val done = observed(JiraStatusCategory.DONE)
        assertFalse(JiraImportFilter(excludeDone = true).admits(done, now))
        assertTrue(JiraImportFilter(excludeDone = false, updatedWithinDays = 30).admits(done, now))
        for (open in listOf(JiraStatusCategory.TODO, JiraStatusCategory.IN_PROGRESS)) {
            assertTrue(JiraImportFilter(excludeDone = true).admits(observed(open), now), "$open")
        }
    }

    @Test
    fun `an unknown status category is not done`() {
        assertTrue(JiraImportFilter(excludeDone = true).admits(observed(JiraStatusCategory.UNKNOWN), now))
    }

    @Test
    fun `an item updated exactly N days ago is kept, one a millisecond older is left out`() {
        val filter = JiraImportFilter(updatedWithinDays = 30)
        assertTrue(filter.admits(observed(updated = now - 30 * MILLIS_PER_DAY), now))
        assertFalse(filter.admits(observed(updated = now - 30 * MILLIS_PER_DAY - 1), now))
        assertTrue(filter.admits(observed(updated = now - 29 * MILLIS_PER_DAY), now))
    }

    @Test
    fun `a missing updated stamp is admitted and so is a stamp in the future`() {
        val filter = JiraImportFilter(excludeDone = true, updatedWithinDays = 1)
        assertTrue(filter.admits(observed(updated = null), now))
        assertTrue(filter.admits(observed(updated = now + 10 * MILLIS_PER_DAY), now))
    }

    @Test
    fun `both members apply together`() {
        val filter = JiraImportFilter(excludeDone = true, updatedWithinDays = 30)
        assertFalse(filter.admits(observed(JiraStatusCategory.DONE, now), now), "done and recent")
        assertFalse(filter.admits(observed(JiraStatusCategory.TODO, now - 31 * MILLIS_PER_DAY), now), "open and quiet")
        assertTrue(filter.admits(observed(JiraStatusCategory.TODO, now - MILLIS_PER_DAY), now))
    }

    @Test
    fun `an inactive filter admits everything and reads as inactive`() {
        val nothing = JiraImportFilter()
        val worst = observed(JiraStatusCategory.DONE, updated = 0)
        assertTrue(nothing.admits(worst, now))
        assertFalse(nothing.isActive())
        assertFalse((null as JiraImportFilter?).isActive())
        assertTrue(JiraImportFilter(excludeDone = true).isActive())
        assertTrue(JiraImportFilter(updatedWithinDays = 5).isActive())
    }
}
