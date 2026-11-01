package ch.nokillswit.planning

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.insertRowsIgnoringConflicts
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.LocalDate

val PublicHolidayServiceKey = AttributeKey<PublicHolidayService>("PublicHolidayService")

/**
 * The public-holiday dictionary (`public_holidays`, V19): flat ADMIN-curated dates, HARD-deleting (the registry exception to the
 * soft-delete convention, `.claude/docs/persistence.md`). The dictionary is plan state (`planning-model.md` "The calendar"): every
 * write runs in [withPlanWrite] — the plan lock, then the block, then exactly one revision bump — and stamps nothing else, so a held
 * view carries an older revision while no client write it sends is staled. A rejected write (a duplicate date's 23505, a missing id's
 * 404) throws inside the block and rolls the whole transaction back, bump included. The writes answer the [PlanWrite] so the route can
 * audit the revision they left behind.
 */
class PublicHolidayService(private val database: R2dbcDatabase) {
    object PublicHolidays : UIntIdTable("public_holidays") {
        val holidayDate = localDate("holiday_date")
        val name = varchar("name", MAX_PUBLIC_HOLIDAY_NAME_LENGTH)
        val createdAt = long("created_at")
    }

    /** The whole dictionary, oldest date first (dates are unique, so the order is total). */
    suspend fun list(): List<PublicHolidayResponse> = suspendTransaction(database) {
        PublicHolidays.selectAll().orderBy(PublicHolidays.holidayDate to SortOrder.ASC).toList().map { it.toResponse() }
    }

    /**
     * Inserts a holiday (sanitized and its shape re-checked here, before the lock — both idempotent after the route's pass); a duplicate
     * date is the unique index's 23505 -> the central 409.
     */
    suspend fun create(request: PublicHolidayCreateRequest): PlanWrite<PublicHolidayResponse> {
        val values = validatePublicHoliday(sanitizedPublicHoliday(request))
        return database.withPlanWrite {
            val id = PublicHolidays.insert {
                it[holidayDate] = values.date
                it[name] = values.name
                it[createdAt] = nowMillis()
            }[PublicHolidays.id].value
            PublicHolidayResponse(id, values.date.toString(), values.name)
        }
    }

    /** Hard-deletes a holiday; a missing id is the 404 (rolled back, so no bump). The answer is the removed row. */
    suspend fun delete(id: UInt): PlanWrite<PublicHolidayResponse> = database.withPlanWrite {
        val existing = PublicHolidays.selectAll().where { PublicHolidays.id eq id }.toList().singleOrNull()?.toResponse()
            ?: throw NotFoundException("Public holiday not found")
        PublicHolidays.deleteWhere { PublicHolidays.id eq id }
        existing
    }

    /**
     * Adds the [preset]'s holidays of [year] that the dictionary does not hold yet. Under the plan lock (so no other holiday writer
     * interleaves) it reads which of the set's dates exist, inserts the rest in one multi-row statement and reads them back with their
     * ids. An existing row keeps its name; re-applying adds nothing — and still bumps the revision, the conservative rule.
     */
    suspend fun applyPreset(preset: HolidayPreset, year: Int): PlanWrite<HolidayPresetResponse> {
        val wanted = presetHolidays(preset, year)
        val dates = wanted.map { it.first }
        return database.withPlanWrite {
            val existing = PublicHolidays.selectAll().where { PublicHolidays.holidayDate inList dates }
                .toList().map { it[PublicHolidays.holidayDate] }.toSet()
            val missing = wanted.filter { it.first !in existing }
            PublicHolidays.insertRowsIgnoringConflicts(missing) { (date, holidayName) ->
                this[PublicHolidays.holidayDate] = date
                this[PublicHolidays.name] = holidayName
                this[PublicHolidays.createdAt] = nowMillis()
            }
            val added = if (missing.isEmpty()) {
                emptyList()
            } else {
                PublicHolidays.selectAll().where { PublicHolidays.holidayDate inList missing.map { it.first } }
                    .orderBy(PublicHolidays.holidayDate to SortOrder.ASC).toList().map { it.toResponse() }
            }
            HolidayPresetResponse(added, existing.sorted().map { it.toString() })
        }
    }

    private fun presetHolidays(preset: HolidayPreset, year: Int): List<Pair<LocalDate, String>> {
        validatePresetYear(year)
        return when (preset) {
            HolidayPreset.POLISH -> PolishHolidays.of(year)
        }
    }

    private fun ResultRow.toResponse() = PublicHolidayResponse(
        id = this[PublicHolidays.id].value,
        date = this[PublicHolidays.holidayDate].toString(),
        name = this[PublicHolidays.name],
    )
}
