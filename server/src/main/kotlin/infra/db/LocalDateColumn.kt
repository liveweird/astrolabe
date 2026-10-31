package ch.nokillswit.infra.db

import kotlinx.datetime.toJavaLocalDate
import kotlinx.datetime.toKotlinLocalDate
import org.jetbrains.exposed.v1.core.Column
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.core.datetime.LocalDateColumnType

/**
 * A repo-local PostgreSQL `DATE` column holding a [java.time.LocalDate], because `exposed-r2dbc` 1.6.0 ships
 * no date module of its own (no `exposed-java-time` / `exposed-kotlin-datetime` on the classpath). It rides the
 * abstract [LocalDateColumnType] of `exposed-core` (an `IDateColumnType`, the hook the R2DBC `DateTimeTypeMapper`
 * recognises), implementing the two conversions to its `kotlinx.datetime.LocalDate` pivot.
 *
 * **The zone-free override.** The base class's `notNullValueToDB` is NOT zone-free: it builds a `java.sql.Date` from
 * `atStartOfDayIn(TimeZone.currentSystemDefault())`, and the mapper then calls `java.sql.Date.toLocalDate()` before
 * binding, so a write or a WHERE parameter passes through the JVM default zone and the Julian/Gregorian cutover
 * (verified against the 1.6.0 bytecode: UTC stored `1500-01-01` as `1499-12-23`, Pacific/Kiritimati stored
 * `1994-12-31` as `1995-01-01`, `0100-02-27` was a 500). [notNullValueToDB] therefore returns the `java.time.LocalDate`
 * itself: the mapper only unwraps a `java.sql.Date`/`Time`/`Timestamp`, so any other value reaches `Statement.bind`
 * unchanged and r2dbc-postgresql's native `LocalDateCodec` encodes the calendar date directly. [nonNullValueToString]
 * (the literal rendering) is the ISO `'YYYY-MM-DD'` for the same reason. Reads were never affected: the driver hands a
 * `java.time.LocalDate` back. Day precision end to end; nothing here ever sees an instant or a zone.
 * `LocalDateColumnTest` pins insert, update and WHERE parameters under swapped JVM zones, and `parseIsoDate`
 * additionally bounds years to 1900-2999 (`infra/validation/Dates.kt`). See `persistence.md` "The DATE column idiom".
 */
class JavaLocalDateColumnType : LocalDateColumnType<java.time.LocalDate>() {
    override fun toLocalDate(value: java.time.LocalDate): kotlinx.datetime.LocalDate = value.toKotlinLocalDate()

    override fun fromLocalDate(value: kotlinx.datetime.LocalDate): java.time.LocalDate = value.toJavaLocalDate()

    override fun notNullValueToDB(value: java.time.LocalDate): Any = value

    override fun nonNullValueToString(value: java.time.LocalDate): String = "'$value'"
}

/** Declares a `DATE` column holding a [java.time.LocalDate] (see [JavaLocalDateColumnType]). */
fun Table.localDate(name: String): Column<java.time.LocalDate> = registerColumn(name, JavaLocalDateColumnType())
