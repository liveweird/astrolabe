package ch.nokillswit.users

import ch.nokillswit.audit.audit
import ch.nokillswit.auth.hashPassword
import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireSelfOrAdmin
import ch.nokillswit.infra.paging.optionalBoolean
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
import ch.nokillswit.infra.validation.canonicalEmail
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.people.PersonCreateRequest
import ch.nokillswit.people.PersonService
import ch.nokillswit.people.PersonServiceKey
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable

/** Minimum accepted password length for create and change. */
const val MIN_PASSWORD_LENGTH = 10

/** Audit format for a roles/features/permissions set: comma-joined sorted names, "" = empty set. */
internal fun <T : Enum<T>> Set<T>.joinedNames(): String = map { it.name }.sorted().joinToString(",")

/**
 * Name and email are identity/security-relevant (email is the login identifier); the
 * `user.updated` event carries deltas only for the fields that actually changed — and is
 * skipped entirely when neither did.
 */
private fun auditUserUpdated(byUserId: UInt, targetUserId: UInt, existing: User, name: String, email: String) {
    if (name == existing.name && email == existing.email) return
    val fields = mutableListOf<Pair<String, Any?>>(
        "byUserId" to byUserId.toLong(),
        "targetUserId" to targetUserId.toLong(),
    )
    if (name != existing.name) {
        fields += "nameFrom" to existing.name
        fields += "nameTo" to name
    }
    if (email != existing.email) {
        fields += "emailFrom" to existing.email
        fields += "emailTo" to email
    }
    audit("user.updated", *fields.toTypedArray())
}

@Serializable
@Resource("/api/v1/users")
class Users {
    @Serializable
    @Resource("{id}")
    class Id(val parent: Users = Users(), val id: UInt) {
        @Serializable
        @Resource("password")
        class Password(val parent: Id)

        @Serializable
        @Resource("features")
        class Features(val parent: Id)

        @Serializable
        @Resource("language")
        class Language(val parent: Id)

        @Serializable
        @Resource("permissions")
        class Permissions(val parent: Id)
    }
}

fun Application.configureUserRoutes() {
    val userService = attributes[UserServiceKey]
    val personService = attributes[PersonServiceKey]
    attributes.put(PasswordChangeThrottleKey, passwordChangeThrottle())

    routing {
        authenticate {
            userList(userService)
            userCreate(userService, personService)
            userReadUpdateDelete(userService)
            userPassword(userService)
            userFeaturesAndLanguage(userService)
            userPermissions(userService)
        }
    }
}

private fun Route.userList(userService: UserService) {
    // Management surface: ADMIN-only end to end (list included) — regular users only
    // keep the self password change below.
    get<Users> {
        requireAdmin(call.caller())
        val paging = call.parsePaging(sortable = USER_SORT_FIELDS)
        val params = call.request.queryParameters
        val feature = params.optionalEnum<Feature>("feature")
        val featureEnabled = params.optionalBoolean("featureEnabled")
        // The pair rule: the flag-state filter is meaningless as a lone half.
        if ((feature == null) != (featureEnabled == null)) {
            throw BadRequestException("feature and featureEnabled must be supplied together")
        }
        val filter = UserListFilter(
            name = params.optionalString("name"),
            email = params.optionalString("email"),
            role = params.optionalEnum<UserRole>("role"),
            feature = feature,
            featureEnabled = featureEnabled,
        )
        val result = userService.list(filter, paging)
        call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
    }
}

private fun Route.userCreate(userService: UserService, personService: PersonService) {
    post<Users> {
        val caller = call.caller()
        // Guarded BEFORE the body decodes — the guard needs nothing from the payload,
        // so a non-admin's malformed body stays 403, not the converter's 400.
        requireAdmin(caller)
        val req = call.receive<UserCreateRequest>()
        val name = sanitizeSingleLine(req.name, "Name")
        val email = canonicalEmail(req.email)
        validateNameAndEmail(name, email)
        validatePassword(req.password)
        validateLanguage(req.language)
        val role = rolesToStored(req.roles)
        // The password arrives client-generated and leaves this handler only as a
        // bcrypt hash — no response ever carries plaintext. A duplicate active email
        // rides the V1 partial index into the central 23505 → 409.
        val user = User(
            name = name,
            email = email,
            passwordHash = hashPassword(req.password),
            role = role,
            language = req.language ?: DEFAULT_LANGUAGE,
        )
        // alsoCreatePerson: the person rides the account's transaction through the people service's own create (its
        // validation, its 409s): a clash there rolls the account back and answers the people route's own problem.
        var personId: UInt? = null
        val alsoPerson: (suspend (UInt) -> Unit)? = if (req.alsoCreatePerson == true) {
            { newId -> personId = personService.create(PersonCreateRequest(name, email, newId)) }
        } else null
        val created = userService.createResponse(user, alsoInTransaction = alsoPerson)
        val id = created.id
        audit(
            "user.created",
            *buildList<Pair<String, Any?>> {
                add("byUserId" to caller.userId.toLong())
                add("newUserId" to id.toLong())
                add("email" to email)
                // As STORED (the request set folded through rolesToStored), not as requested.
                add("roles" to role.asAdditionalRoles().joinedNames())
                if (user.language != DEFAULT_LANGUAGE) add("language" to user.language)
            }.toTypedArray(),
        )
        personId?.let {
            audit("person.created", "byUserId" to caller.userId.toLong(), "personId" to it.toLong(), "name" to name,
                "userId" to id.toLong())
        }
        call.response.header(HttpHeaders.Location, call.application.href(Users.Id(id = id)))
        call.respond(HttpStatusCode.Created, created)
    }
}

private fun Route.userReadUpdateDelete(userService: UserService) {
    get<Users.Id> { route ->
        // Guard BEFORE read (the documented users idiom): an unauthorized caller gets a
        // uniform 403 whether or not the id exists.
        requireSelfOrAdmin(call.caller(), route.id)
        val user = userService.read(route.id).orNotFound("User")
        call.respond(HttpStatusCode.OK, user.toResponse(route.id))
    }
    put<Users.Id> { route ->
        val caller = call.caller()
        requireAdmin(caller)
        val req = call.receive<UserUpdateRequest>()
        // Payload validation FIRST — 400 wins over 404/409, like the sibling handlers.
        val name = sanitizeSingleLine(req.name, "Name")
        val email = canonicalEmail(req.email)
        validateNameAndEmail(name, email)
        val requestedRole = rolesToStored(req.roles)
        val existing = userService.read(route.id).orNotFound("User")
        // Last-admin protection: demoting the final active administrator would lock
        // everyone out of the management surface. The race-proof check runs inside
        // updateGuarded's transaction; this pre-check only exists for the audit read.
        if (existing.role == UserRole.ADMIN && requestedRole != UserRole.ADMIN &&
            userService.countActiveAdmins() <= 1
        ) {
            throw ConflictException("The last administrator cannot be demoted", LAST_ADMIN_PROBLEM)
        }
        when (userService.updateGuarded(route.id, name, email, requestedRole)) {
            UserService.GuardedMutation.NOT_FOUND -> throw NotFoundException("User not found")
            UserService.GuardedMutation.LAST_ADMIN ->
                throw ConflictException("The last administrator cannot be demoted", LAST_ADMIN_PROBLEM)
            UserService.GuardedMutation.DONE -> Unit
        }
        auditUserUpdated(caller.userId, route.id, existing, name = name, email = email)
        if (requestedRole != existing.role) {
            audit(
                "user.roles_changed",
                "byUserId" to caller.userId.toLong(),
                "targetUserId" to route.id.toLong(),
                // As STORED on both sides, and named like user.updated's nameFrom/nameTo.
                "rolesFrom" to existing.additionalRoles.joinedNames(),
                "rolesTo" to requestedRole.asAdditionalRoles().joinedNames(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    delete<Users.Id> { route ->
        val caller = call.caller()
        requireAdmin(caller)
        // Before the read, so it 403s uniformly: deleting your own account mid-session
        // is a lockout footgun, not a management action.
        if (caller.userId == route.id) {
            throw ForbiddenException("You cannot delete your own account")
        }
        // Existence (404) and the last-admin state (409) are decided inside ONE
        // transaction — same outcome order as before, without the check/mutate race.
        when (userService.deleteGuarded(route.id)) {
            UserService.GuardedMutation.NOT_FOUND -> throw NotFoundException("User not found")
            UserService.GuardedMutation.LAST_ADMIN ->
                throw ConflictException("The last administrator cannot be deleted", LAST_ADMIN_PROBLEM)
            UserService.GuardedMutation.DONE -> Unit
        }
        audit(
            "user.deleted",
            "byUserId" to caller.userId.toLong(),
            "targetUserId" to route.id.toLong(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
