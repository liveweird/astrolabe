package ch.nokillswit

import ch.nokillswit.planning.DeviationDetail
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.FlagDeviation
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.PlanFlag
import io.ktor.serialization.kotlinx.json.DefaultJson
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The slimmer Jira blocks (1.15), pure: a flag's null members and an evidence detail's null members are NOT on the wire, a set one is,
 * and the evidence repeats no severity. [json] is Ktor's own `DefaultJson` (the app's response setting: defaults encoded, nulls
 * explicit), so a member that is absent here is absent in the answer only because of its `@EncodeDefault(NEVER)`.
 */
class PlanFlagWireTest {
    private val json = DefaultJson

    private fun keys(flag: PlanFlag) = json.encodeToJsonElement(PlanFlag.serializer(), flag).jsonObject.keys

    @Test
    fun `a flag carries only the members it has - kind and severity always`() {
        assertEquals(setOf("kind", "severity"), keys(PlanFlag(FlagKind.NO_WORKING_DAY, FlagSeverity.WARNING)))
        assertEquals(setOf("kind", "severity", "days"), keys(PlanFlag(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING, days = 3)))
        assertEquals(
            setOf("kind", "severity", "days", "teamId", "otherProjectId"),
            keys(PlanFlag(FlagKind.RANK_INVERSION, FlagSeverity.WARNING, days = 2, teamId = 4u, otherProjectId = 9u)),
        )
        assertEquals(setOf("kind", "severity", "count"), keys(PlanFlag(FlagKind.JIRA_MILESTONES, FlagSeverity.INFO, count = 3)))
    }

    @Test
    fun `an evidence has a kind and a detail but no severity, and a detail has only its set members`() {
        val renamed = PlanFlag(
            FlagKind.JIRA_DEVIATION, FlagSeverity.INFO,
            deviation = FlagDeviation(DeviationKind.RENAMED, DeviationDetail(jira = "Jira name", plan = "Plan name")),
        )
        val wire = json.encodeToJsonElement(PlanFlag.serializer(), renamed).jsonObject
        assertEquals(setOf("kind", "severity", "deviation"), wire.keys)
        val evidence = wire.getValue("deviation").jsonObject
        assertEquals(setOf("kind", "detail"), evidence.keys)
        assertEquals(setOf("jira", "plan"), evidence.getValue("detail").jsonObject.keys)

        val ended = FlagDeviation(DeviationKind.END_DIFFERS, DeviationDetail("2044-02-04", "2044-02-09", days = 3, count = 1))
        assertEquals(
            setOf("jira", "plan", "days", "count"),
            json.encodeToJsonElement(FlagDeviation.serializer(), ended).jsonObject.getValue("detail").jsonObject.keys,
        )
        assertEquals(
            emptySet(),
            json.encodeToJsonElement(FlagDeviation.serializer(), FlagDeviation(DeviationKind.UNSCHEDULED_IN_PLAN, DeviationDetail()))
                .jsonObject.getValue("detail").jsonObject.keys,
        )
    }
}
