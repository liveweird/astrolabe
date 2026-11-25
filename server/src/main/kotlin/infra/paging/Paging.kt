package ch.nokillswit.infra.paging

import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.BadRequestException
import io.r2dbc.spi.IsolationLevel
import org.jetbrains.exposed.v1.core.Column
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.r2dbc.Query
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcTransaction
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

const val DEFAULT_PAGE_SIZE = 20
const val MAX_PAGE_SIZE = 100

data class SortField(val name: String, val descending: Boolean)

data class PageRequest(
    val page: Int,
    val pageSize: Int,
    val sort: List<SortField>,
)

/**
 * One read-only snapshot for a list's count, page rows and any batched projections of those rows.
 * API-LIST-001 requires the count and items to describe the same committed database state.
 */
suspend fun <T> pagedRead(database: R2dbcDatabase, block: suspend R2dbcTransaction.() -> T): T =
    suspendTransaction(database, IsolationLevel.REPEATABLE_READ, readOnly = true, statement = block)

fun ApplicationCall.parsePaging(
    sortable: Set<String>,
    defaultSort: List<SortField> = listOf(SortField("id", descending = false)),
): PageRequest {
    val params = request.queryParameters

    val page = params.singleValue("page")?.let { raw ->
        val parsed = raw.toIntOrNull() ?: throw BadRequestException("page must be a positive integer")
        if (parsed < 1) throw BadRequestException("page must be >= 1")
        parsed
    } ?: 1

    val pageSize = params.singleValue("pageSize")?.let { raw ->
        val parsed = raw.toIntOrNull() ?: throw BadRequestException("pageSize must be an integer")
        if (parsed < 1 || parsed > MAX_PAGE_SIZE) {
            throw BadRequestException("pageSize must be between 1 and $MAX_PAGE_SIZE")
        }
        parsed
    } ?: DEFAULT_PAGE_SIZE

    val sortParam = params.singleValue("sort")
    val requested = if (sortParam.isNullOrBlank()) {
        defaultSort
    } else {
        sortParam.split(',').map { raw ->
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) throw BadRequestException("sort contains an empty field")
            val descending = trimmed.startsWith('-')
            val field = if (descending) trimmed.drop(1) else trimmed
            if (field !in sortable) {
                throw BadRequestException("Unknown sort field: $field (allowed: ${sortable.sorted().joinToString()})")
            }
            SortField(field, descending)
        }
    }
    val withTiebreaker = if (requested.any { it.name == "id" }) requested else requested + SortField("id", false)
    return PageRequest(page = page, pageSize = pageSize, sort = withTiebreaker)
}

/**
 * Orders, limits and offsets [this] by [req]. A field named in [nullsLast] sorts its NULLs after every value in BOTH directions
 * (`ASC NULLS LAST` / `DESC NULLS LAST`; PostgreSQL's `DESC` default would put them first); the rest keep the database default.
 */
fun Query.applyPaging(req: PageRequest, columns: Map<String, Column<*>>, nullsLast: Set<String> = emptySet()): Query {
    val order = req.sort.map { sf ->
        val column = columns[sf.name]
            ?: error("Sort field '${sf.name}' has no mapped column (paging helper invariant violated)")
        val keepNullsLast = sf.name in nullsLast
        column to when {
            sf.descending && keepNullsLast -> SortOrder.DESC_NULLS_LAST
            sf.descending -> SortOrder.DESC
            keepNullsLast -> SortOrder.ASC_NULLS_LAST
            else -> SortOrder.ASC
        }
    }
    return orderBy(*order.toTypedArray())
        .limit(req.pageSize)
        .offset(((req.page - 1).toLong()) * req.pageSize)
}
