package ch.nokillswit.people

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * The people directory (V10): the people who own plan nodes and manage teams. A person is not a login — the optional
 * [PersonCreateRequest.userId] links an Astrolabe account (set by an ADMIN; the person-to-user link in
 * `.claude/docs/planning-model.md`), so an external owner can exist without one. ADMIN curates the directory;
 * every signed-in user reads it, emails included (the owner pickers need it).
 */
const val MAX_PERSON_NAME_LENGTH = 100
const val MAX_PERSON_EMAIL_LENGTH = 254

@Serializable
data class PersonCreateRequest(
    val name: String,
    /** Optional mailbox, unique among ACTIVE people when set (case-insensitive); blank = none. */
    val email: String? = null,
    /** Optional login — an ACTIVE user (400 otherwise) not already linked to another active person (409). */
    val userId: UInt? = null,
)

@Serializable
data class PersonUpdateRequest(
    val name: String,
    /** PUT is a full replace: omitted = unset. */
    val email: String? = null,
    /** PUT is a full replace: omitted = unlinked. An ACTIVE user (400 otherwise). */
    val userId: UInt? = null,
)

@Serializable
data class PersonResponse(
    val id: UInt,
    val name: String,
    val email: String?,
    /** The linked login as an ACTIVE user; null when unset OR when the linked user was soft-deleted. */
    val userId: UInt?,
    val userEmail: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

/** The list row — the same shape as the detail. */
@Serializable
data class PersonListItem(
    val id: UInt,
    val name: String,
    val email: String?,
    val userId: UInt?,
    val userEmail: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

typealias PersonPageResponse = PageResponse<PersonListItem>

data class PersonListFilter(
    val name: String? = null,
    val email: String? = null,
)

/** `affected` is the updated-row count (0 → 404); `userFrom` the STORED link before the write (the audit delta). */
data class PersonUpdateOutcome(val affected: Int, val userFrom: UInt?)

data class PersonListResult(val items: List<PersonListItem>, val total: Long)

/** The optional email: trimmed, control characters a 400, blank = absent. */
private fun sanitizedEmail(raw: String?): String? =
    raw?.let { sanitizeSingleLine(it, "Email") }?.takeIf { it.isNotBlank() }

/** Trims the scalars (the sanitizer convention — control characters are a 400). */
fun sanitizedPersonCreate(request: PersonCreateRequest): PersonCreateRequest = PersonCreateRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    email = sanitizedEmail(request.email),
    userId = request.userId,
)

fun sanitizedPersonUpdate(request: PersonUpdateRequest): PersonUpdateRequest = PersonUpdateRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    email = sanitizedEmail(request.email),
    userId = request.userId,
)

/** The person rules — enforced by the route AND re-checked by the service. */
fun validatePerson(name: String, email: String?) {
    requireNameAndDescription(name, null, MAX_PERSON_NAME_LENGTH, 0)
    if (email != null) {
        if (email.length > MAX_PERSON_EMAIL_LENGTH) {
            throw BadRequestException("Email must be at most $MAX_PERSON_EMAIL_LENGTH characters")
        }
        if ('@' !in email) throw BadRequestException("Email must contain '@'")
    }
}

fun validatePersonCreate(request: PersonCreateRequest) = validatePerson(request.name, request.email)

fun validatePersonUpdate(request: PersonUpdateRequest) = validatePerson(request.name, request.email)
