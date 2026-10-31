package ch.nokillswit

import ch.nokillswit.telemetry.HeavyReader
import ch.nokillswit.telemetry.TelemetryMetrics
import ch.nokillswit.telemetry.storageReadings
import kotlinx.coroutines.runBlocking
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val HEAVY_TIMEOUT_SECONDS = 30

/**
 * The storage collector (`telemetry/StorageCollectors.kt`) over the shared container: the database size and the per-schema sizes of
 * `public` and `ops`, graded against an independent `pg_total_relation_size` sum over plain JDBC.
 */
class StorageReadingsTest {
    private val reader = HeavyReader(telemetryStore(), HEAVY_TIMEOUT_SECONDS)

    private fun independentSchemaBytes(schema: String): Long = PostgresTestSupport.connect().use { conn ->
        conn.createStatement().use { st ->
            st.executeQuery(
                "SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) FROM pg_class c " +
                    "JOIN pg_namespace n ON n.oid = c.relnamespace " +
                    "WHERE n.nspname = '$schema' AND c.relkind IN ('r', 'm')",
            ).use { rs -> rs.next(); rs.getLong(1) }
        }
    }

    @Test
    fun `the storage reading reports the database and each schema`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val readings = reader.storageReadings()
        val total = readings.single { it.metric == TelemetryMetrics.DB_SIZE }.value
        val bySchema = readings.filter { it.metric == TelemetryMetrics.DB_SCHEMA_SIZE }.associate { it.label to it.value }
        assertEquals(setOf("public", "ops"), bySchema.keys)
        assertTrue(bySchema.values.all { it > 0 }, "$bySchema: both schemas hold tables here")
        assertTrue(bySchema.values.sum() < total, "the schemas are part of the database ($bySchema of $total)")
        for ((schema, reported) in bySchema) {
            val independent = independentSchemaBytes(schema)
            assertTrue(abs(independent - reported) <= 0.05 * independent, "$schema: $independent vs $reported")
        }
    }
}
