package ch.nokillswit.telemetry

/** The schemas whose size the storage collector reports. */
private val SIZED_SCHEMAS = listOf("public", "ops")

private fun sqlList(values: List<String>) = values.joinToString(",") { "'$it'" }

/**
 * `db.size` (`pg_database_size`) and `db.schema.size` per schema: the sum of `pg_total_relation_size` (heap, TOAST and indexes) over
 * its tables and materialized views. A schema without relations reads 0. Catalog reads only - it touches no table's rows - so it
 * needs no other package's service (`persistence.md` "Telemetry (V9)"). Two statements, each in a transaction of its own.
 */
internal suspend fun HeavyReader.storageReadings(): List<Reading> {
    val total = read { query("SELECT pg_database_size(current_database())") { it.get(0, Long::class.javaObjectType) ?: 0L }.single() }
    val bySchema = read {
        query(
            """
            SELECT n.nspname, COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN (${sqlList(SIZED_SCHEMAS)}) AND c.relkind IN ('r', 'm')
            GROUP BY n.nspname
            """.trimIndent(),
        ) { it.get(0, String::class.java).orEmpty() to (it.get(1, Long::class.javaObjectType) ?: 0L) }.toMap()
    }
    return listOf(Reading(TelemetryMetrics.DB_SIZE, total.toDouble())) +
        SIZED_SCHEMAS.map { Reading(TelemetryMetrics.DB_SCHEMA_SIZE, (bySchema[it] ?: 0L).toDouble(), it) }
}
