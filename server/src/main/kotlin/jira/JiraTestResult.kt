package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.ConnectionTestRow
import kotlinx.serialization.Serializable

/**
 * The Test-connection answer: the rows, the cloud id once `tenant_info` succeeded, and - on the stored-token variant - the instant of the
 * field/issue-type snapshot now stored on the connection (this test's, or an earlier one's).
 */
@Serializable
data class JiraTestResult(
    val rows: List<ConnectionTestRow>,
    val cloudId: String? = null,
    val discoveredAt: Long? = null,
    /** Whether the result was stored on the connection: false for an ad-hoc test, or when an edit of the connection raced the test. */
    val recorded: Boolean = false,
) {
    /** What the UI calls a pass: every REQUIRED row is ok. */
    val passed: Boolean get() = rows.none { it.required && !it.ok }
}
