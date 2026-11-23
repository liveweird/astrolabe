package ch.nokillswit.users

import ch.nokillswit.audit.audit
import ch.nokillswit.auth.hashPassword
import ch.nokillswit.auth.verifyPassword
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.authz.requireSelfOrAdmin
import ch.nokillswit.plugins.RateLimits
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.*
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.resources.put
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

// The per-account settings routes (password, features, language, permissions) of `/api/v1/users/{id}`; the `Users.Id.*` resources
// are declared in UserRoutes.kt and the routes are registered by `configureUserRoutes` there, in the same order and under the same
// `authenticate {}` as before the split.

internal fun Route.userPassword(userService: UserService) {
    // The per-USER bucket (keyed by the CALLER, `RateLimits.PASSWORD_CHANGE`) sits on the route node, so it runs before the handler:
    // before the guard, the lock preflight, the body and the bcrypt verify. A flood from one account is a 429 that costs no hash.
    rateLimit(RateLimitName(RateLimits.PASSWORD_CHANGE)) {
        userPasswordPut(userService)
    }
}

private fun Route.userPasswordPut(userService: UserService) {
    put<Users.Id.Password> { route ->
        val caller = call.caller()
        requireSelfOrAdmin(caller, route.parent.id)
        val isSelf = caller.userId == route.parent.id
        // Read at request time (a test may swap it). The throttle's key is the PATH id, so its 429 needs nothing from the
        // payload and rides BEFORE the body decodes, like the guard (403 -> 429 -> 400): a locked account never pays bcrypt.
        val throttle = call.application.attributes[PasswordChangeThrottleKey]
        if (isSelf) throttle.requireNotLocked(caller.userId)
        val req = call.receive<PasswordUpdateRequest>()
        // The new password is validated BEFORE the current one is verified (a deliberate exception to "403 wins over 400"):
        // were it after, `{currentPassword: <guess>, password: <too short>}` would answer 400 on a right guess and 403 on a
        // wrong one, a free oracle that neither counts nor audits. Refused here, nothing is revealed, no bcrypt is paid and
        // no counter is touched. (The SPA validates the same rule client-side first, so it never sends that pair.)
        validatePassword(req.password)
        // Changing one's OWN password always requires the current one (even for an admin); an admin resetting somebody
        // else's does not (and never feeds the throttle: it clears it). Read before update so a wrong current password
        // never mutates anything.
        if (isSelf) {
            val existing = userService.read(route.parent.id).orNotFound("User")
            if (req.currentPassword == null || !verifyPassword(req.currentPassword, existing.passwordHash)) {
                throttle.denyWrongCurrent(caller.userId)
            }
            throttle.recordSuccess(caller.userId)
        }
        userService.updatePassword(route.parent.id, hashPassword(req.password)).orNotFound("User")
        // An admin's reset proves nothing about the account's owner yet ends every session: it also lifts a lock.
        if (!isSelf) throttle.clear(route.parent.id)
        audit(
            "password.changed",
            "targetUserId" to route.parent.id.toLong(),
            "byUserId" to caller.userId.toLong(),
            "selfChange" to isSelf,
        )
        call.respond(HttpStatusCode.NoContent)
    }
}

internal fun Route.userFeaturesAndLanguage(userService: UserService) {
    put<Users.Id.Features> { route ->
        val caller = call.caller()
        // Guard before receive: a non-admin's malformed body is 403, not 400. Self-change
        // is deliberately allowed — the users routes are never feature-gated, so an admin
        // can always adjust their own flags back. An unknown feature name fails enum
        // decoding -> BadRequestException -> 400.
        requireAdmin(caller)
        val req = call.receive<UserFeaturesUpdateRequest>()
        val existing = userService.read(route.parent.id).orNotFound("User")
        val requested = req.disabledFeatures.toSet()
        if (userService.setDisabledFeatures(route.parent.id, requested) == 0) {
            throw NotFoundException("User not found")
        }
        if (requested != existing.disabledFeatures) {
            audit(
                "user.features_changed",
                "byUserId" to caller.userId.toLong(),
                "targetUserId" to route.parent.id.toLong(),
                // Named like user.updated's nameFrom/nameTo (the audit convention).
                "featuresFrom" to existing.disabledFeatures.joinedNames(),
                "featuresTo" to requested.joinedNames(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
    // Per-user language (V1, Lettuce's model verbatim): self or ADMIN — the header
    // language switcher is the self-service writer (switching while signed in also
    // saves here); an admin may fix a mis-set language. Idempotent; guard before
    // receive/validate so 403 wins over 400.
    put<Users.Id.Language> { route ->
        val caller = call.caller()
        requireSelfOrAdmin(caller, route.parent.id)
        val req = call.receive<UserLanguageUpdateRequest>()
        validateLanguage(req.language)
        val existing = userService.read(route.parent.id).orNotFound("User")
        if (userService.setLanguage(route.parent.id, req.language) == 0) {
            throw NotFoundException("User not found")
        }
        if (req.language != existing.language) {
            audit(
                "user.language_changed",
                "byUserId" to caller.userId.toLong(),
                "targetUserId" to route.parent.id.toLong(),
                "from" to existing.language,
                "to" to req.language,
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
}

internal fun Route.userPermissions(userService: UserService) {
    put<Users.Id.Permissions> { route ->
        val caller = call.caller()
        // Guard before receive: a non-admin's malformed body is 403, not 400. Self-change is allowed (the
        // features precedent; an admin passes every permission check anyway). An unknown permission name fails
        // enum decoding -> BadRequestException -> 400. A wholesale replace, idempotent: a same-set re-PUT is 204
        // and audits nothing. The previous set comes back from the locked replace, so the event is exact.
        requireAdmin(caller)
        val req = call.receive<UserPermissionsUpdateRequest>()
        val requested = req.permissions.toSet()
        val previous = userService.replacePermissions(route.parent.id, requested)
            ?: throw NotFoundException("User not found")
        if (requested != previous) {
            audit(
                "user.permissions_changed",
                "byUserId" to caller.userId.toLong(),
                "targetUserId" to route.parent.id.toLong(),
                "permissionsFrom" to previous.joinedNames(),
                "permissionsTo" to requested.joinedNames(),
            )
        }
        call.respond(HttpStatusCode.NoContent)
    }
}
