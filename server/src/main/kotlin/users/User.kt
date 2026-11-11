package ch.nokillswit.users

import ch.nokillswit.infra.maskedSecret
import kotlinx.serialization.Serializable

/**
 * The stored account role. Unlike a plain capability set, storage is a single column with a
 * CHECK constraint (V1): every account is exactly one of these, [USER] being the baseline.
 * On the wire (JWT `roles` claim, LoginResponse.roles) only ADDITIONAL roles travel — a
 * regular user serializes as the empty array — so adding a future role never changes the
 * shape for existing accounts.
 *
 * [ADMIN] — the management role: may reset any user's password (and future admin surfaces).
 * [USER] — the implicit baseline; never transmitted.
 */
@Serializable
enum class UserRole { ADMIN, USER }

/**
 * Per-user feature flags (V5) — stored as the DISABLED set (`user_disabled_features`,
 * no row = enabled), replaced wholesale by `PUT /users/{id}/features` (ADMIN). The Kotlin
 * enum is the whitelist — a future gateable feature is just a new value here (no migration).
 * [MFA] is the one INVERTED-DEFAULT, login-scoped flag: every user starts with the disabled
 * row present (the V5 seed + the `UserService.create` chokepoint), so email MFA is opt-in;
 * it gates the LOGIN FLOW only — no route names it in `requireFeatureEnabled` (which awaits
 * its first area-gating consumer).
 */
@Serializable
enum class Feature { MFA }

/**
 * Per-user permissions (V11) — a GRANT set (`user_permissions`, a row = held, no row = not held), the opposite
 * polarity of [Feature]'s disabled set, replaced wholesale by `PUT /users/{id}/permissions` (ADMIN). They are
 * read from the database on EVERY request (`UserService.hasPermission`) and never ride a JWT, so a grant or a
 * revoke takes effect on the very next request (`authorization.md` "Roles vs permissions"). The Kotlin enum is
 * the whitelist — a future permission is just a new value here (no migration).
 * [ROADMAP_EDITOR] — may rank the projects (the global roadmap) and set any project's target window.
 */
@Serializable
enum class Permission { ROADMAP_EDITOR }

@Serializable
data class User(
    val name: String,
    val email: String,
    val passwordHash: String,
    val role: UserRole = UserRole.USER,
    // Per-user feature flags (V5) — the DISABLED set, empty = full access. Rides the domain
    // object like the role so /login and /refresh mint the claim from the same read. Never
    // client-settable via PUT — replaced only by PUT /users/{id}/features (ADMIN).
    val disabledFeatures: Set<Feature> = emptySet(),
    // Epoch millis of the last password change (0 = never). Retained as account metadata;
    // refresh invalidation uses the exact monotonic revision below.
    val passwordChangedAt: Long = 0,
    // Incremented atomically with every password mutation and copied into refresh tokens.
    // Equality on /refresh avoids timestamp precision and clock-ordering ambiguity.
    val credentialRevision: Long = 0,
    // Per-user language (V1, Lettuce's V61): the UI language at sign-in and the language
    // of every email sent to the user. Set at create; never client-settable via the
    // whole-user PUT — changed only by PUT /users/{id}/language (target user or ADMIN).
    val language: String = "en",
    // Per-user permissions (V11) — the GRANT set, empty = none. Informational on the domain object (what the
    // admin sees in UserResponse); a guard never reads it, it asks UserService.hasPermission in the database.
    val permissions: Set<Permission> = emptySet(),
    // The id of the ACTIVE person linked to this login (people.user_id), read with the account; null = none. Informational only.
    val personId: UInt? = null,
) {
    // The bcrypt hash is a credential in its own right (offline cracking), so it never renders.
    override fun toString(): String =
        "User(name=$name, email=$email, passwordHash=${maskedSecret(passwordHash)}, role=$role, " +
            "disabledFeatures=$disabledFeatures, passwordChangedAt=$passwordChangedAt, " +
            "credentialRevision=$credentialRevision, language=$language, permissions=$permissions)"

    /** The wire/claim shape: additional roles only — empty for a regular user. */
    val additionalRoles: Set<UserRole>
        get() = role.asAdditionalRoles()
}

/** The wire/audit shape of one stored role: additional roles only — empty for the baseline. */
fun UserRole.asAdditionalRoles(): Set<UserRole> =
    if (this == UserRole.ADMIN) setOf(UserRole.ADMIN) else emptySet()

@Serializable
data class UserCreateRequest(
    val name: String,
    val email: String,
    // Client-generated (the SPA's utils/password.ts) and shown to the admin exactly once —
    // the server stores only the bcrypt hash and never returns plaintext.
    val password: String,
    val roles: List<UserRole>? = null,
    /** Create-only (the whole-user PUT never touches it); omitted = English. */
    val language: String? = null,
    /**
     * Create-only: true also creates a person with this login's name and email, linked to it, in the same transaction
     * (the people directory's own rules apply: a clash on the person side fails the whole request). Omitted = false.
     */
    val alsoCreatePerson: Boolean? = null,
) {
    override fun toString(): String =
        "UserCreateRequest(name=$name, email=$email, password=${maskedSecret(password)}, roles=$roles, " +
            "language=$language, alsoCreatePerson=$alsoCreatePerson)"
}

@Serializable
data class UserUpdateRequest(
    val name: String,
    val email: String,
    val roles: List<UserRole>,
)

@Serializable
data class UserResponse(
    val id: UInt,
    val name: String,
    val email: String,
    /** Additional roles only — empty for a regular user (the standing wire shape). */
    val roles: List<UserRole>,
    /** Per-user feature flags (V5) — the admin-disabled set; empty = full access. */
    val disabledFeatures: List<Feature>,
    /** The stored per-user language (V1) — the ONE synced language (UI + emails). */
    val language: String,
    /** Per-user permissions (V11) — the granted set; empty = none. */
    val permissions: List<Permission>,
    /** The id of the ACTIVE person linked to this login (`people.user_id`); null when there is none. */
    val personId: UInt? = null,
)

fun User.toResponse(id: UInt) = UserResponse(
    id = id,
    name = name,
    email = email,
    roles = additionalRoles.sortedBy { it.name },
    disabledFeatures = disabledFeatures.sortedBy { it.name },
    language = language,
    permissions = permissions.sortedBy { it.name },
    personId = personId,
)

/** Body of PUT /users/{id}/language (target user or ADMIN — the switcher's save). */
@Serializable
data class UserLanguageUpdateRequest(val language: String)

/** Wholesale replacement of a user's disabled-feature set (PUT /users/{id}/features). */
@Serializable
data class UserFeaturesUpdateRequest(val disabledFeatures: List<Feature>)

/** Wholesale replacement of a user's granted-permission set (PUT /users/{id}/permissions). */
@Serializable
data class UserPermissionsUpdateRequest(val permissions: List<Permission>)

typealias UserPageResponse = ch.nokillswit.infra.paging.PageResponse<UserResponse>

/** The single stored role from a wire roles set: ADMIN present wins, else the baseline. */
fun rolesToStored(roles: Collection<UserRole>?): UserRole =
    if (roles != null && UserRole.ADMIN in roles) UserRole.ADMIN else UserRole.USER

@Serializable
data class PasswordUpdateRequest(
    val password: String,
    // Required when a caller changes their OWN password (even an admin); not required
    // for an admin resetting somebody else's.
    val currentPassword: String? = null,
) {
    override fun toString(): String =
        "PasswordUpdateRequest(password=${maskedSecret(password)}, currentPassword=${maskedSecret(currentPassword)})"
}
