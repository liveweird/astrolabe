package ch.nokillswit.users

import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.infra.paging.pagedRead
import ch.nokillswit.infra.validation.canonicalEmail
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val UserServiceKey = AttributeKey<UserService>("UserService")

data class UserListFilter(
    val name: String? = null,
    val email: String? = null,
    val role: UserRole? = null,
    /**
     * Feature-flag state filter — the pair travels together (the route 400s a lone half):
     * [feature] names the flag, [featureEnabled] the state to match.
     */
    val feature: Feature? = null,
    val featureEnabled: Boolean? = null,
)

data class UserListResult(
    val items: List<UserResponse>,
    val total: Long,
)

// Deliberately no "role": the wire shape is a set, and a set has no order (the Lettuce rule).
private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to UserService.Users.id,
    "name" to UserService.Users.name,
    "email" to UserService.Users.email,
)

/** The ONE sortable whitelist — the route's `parsePaging` argument derives from the column map
 *  above, so the two can never drift apart (a mismatch used to be a runtime 500). */
val USER_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

class UserService(private val database: R2dbcDatabase) {
    object Users : UIntIdTable("users"), SoftDeletable {
        val name = varchar("name", length = 50)
        // Uniqueness is enforced by a partial unique index (active rows only) in migration V1,
        // so a soft-deleted user frees its email. Exposed table defs are query-only (not DDL),
        // so this column carries no `.uniqueIndex()`.
        val email = varchar("email", length = 254)
        val passwordHash = varchar("password_hash", length = 255)
        // Single-column role storage (CHECK in V1); UserRole.USER is the baseline.
        val role = varchar("role", length = 20).default(UserRole.USER.name)
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
        val passwordChangedAt = long("password_changed_at").default(0)
        val credentialRevision = long("credential_revision").default(0)
        // Per-user language (V1): sign-in UI language + the language of every email sent
        // to the user. No CHECK — SUPPORTED_LANGUAGES is the whitelist.
        val language = varchar("language", length = 10).default("en")
    }

    // Per-user feature flags (V5) — the DISABLED set; no row = enabled.
    object UserDisabledFeatures : Table("user_disabled_features") {
        val userId = reference("user_id", Users)
        val feature = varchar("feature", length = 30)
        override val primaryKey = PrimaryKey(userId, feature)
    }

    // Per-user permissions (V11) — the GRANT set; a row = held. Hard-deleted join table (a wholesale replace).
    object UserPermissions : Table("user_permissions") {
        val userId = reference("user_id", Users)
        val permission = varchar("permission", length = 30)
        override val primaryKey = PrimaryKey(userId, permission)
    }

    /**
     * Inserts the account. [alsoInTransaction], when given, runs with the new id INSIDE the same transaction (after the
     * MFA row), so a companion write (`POST /users`' linked person) commits with the account or not at all: whatever
     * it throws rolls the account back too.
     */
    suspend fun create(
        user: User,
        alsoInTransaction: (suspend (id: UInt) -> Unit)? = null,
    ): UInt = createResult(user, alsoInTransaction) { it }

    /** The just-inserted account as committed, including seeded grants and an optional linked person from the same transaction. */
    internal suspend fun createResponse(
        user: User,
        alsoInTransaction: (suspend (id: UInt) -> Unit)? = null,
    ): UserResponse = createResult(user, alsoInTransaction) { id ->
        checkNotNull(readInTransaction(id)) { "the user just inserted is readable" }.toResponse(id)
    }

    private suspend fun <T> createResult(
        user: User,
        alsoInTransaction: (suspend (id: UInt) -> Unit)?,
        result: suspend (UInt) -> T,
    ): T = suspendTransaction(database) {
        // Re-checked service-side so direct callers stay guarded (the feature-template rule);
        // the plaintext-password rules can't apply here — only the bcrypt hash arrives.
        validateNameAndEmail(user.name, user.email)
        validateLanguage(user.language)
        val newRecord = Users.insert {
            it[name] = user.name
            it[email] = canonicalEmail(user.email)
            it[passwordHash] = user.passwordHash
            it[role] = user.role.name
            it[language] = user.language
        }
        val id = newRecord[Users.id].value
        // MFA is the one inverted-default flag (opt-in): every new user starts with the
        // disabled row present, mirroring the V5 seed for pre-existing users. All creation
        // paths (admin create, test seeds) funnel through here.
        UserDisabledFeatures.insert {
            it[UserDisabledFeatures.userId] = id
            it[UserDisabledFeatures.feature] = Feature.MFA.name
        }
        alsoInTransaction?.invoke(id)
        result(id)
    }

    suspend fun read(id: UInt): User? = suspendTransaction(database) {
        readInTransaction(id)
    }

    private suspend fun readInTransaction(id: UInt): User? =
        Users.selectAll()
            .where { (Users.id eq id) and Users.active() }
            .toList()
            .singleOrNull()
            ?.let {
                val id = it[Users.id].value
                it.toUser(UserGrants.featuresOf(id), UserGrants.permissionsOf(id), linkedPersonIds(listOf(id))[id])
            }

    suspend fun findWithIdByEmail(email: String): Pair<UInt, User>? = suspendTransaction(database) {
        // Stored emails are canonical; folding the argument too is defense-in-depth so a
        // caller that skipped canonicalEmail still matches.
        Users.selectAll()
            .where { (Users.email eq canonicalEmail(email)) and Users.active() }
            .toList()
            .singleOrNull()
            ?.let {
                val id = it[Users.id].value
                id to it.toUser(UserGrants.featuresOf(id), UserGrants.permissionsOf(id))
            }
    }

    // The plaintext rules (min length, bcrypt byte ceiling) are route-side by necessity:
    // only the bcrypt hash ever reaches the service.
    suspend fun updatePassword(id: UInt, passwordHash: String): Int = suspendTransaction(database) {
        updatePasswordInTransaction(id, passwordHash, expectedRevision = null)
    }

    /**
     * Set the per-user language (V1). Returns 1, or 0 when the id is unknown or
     * soft-deleted (the route 404s). Idempotent.
     */
    suspend fun setLanguage(id: UInt, language: String): Int = suspendTransaction(database) {
        validateLanguage(language) // re-checked service-side so direct callers stay guarded
        Users.update({ (Users.id eq id) and Users.active() }) {
            it[Users.language] = language
        }
    }

    suspend fun list(filter: UserListFilter, paging: PageRequest): UserListResult =
        pagedRead(database) {
            val predicate: Op<Boolean> = buildPredicate(filter) and Users.active()
            val total = Users.selectAll().where { predicate }.count()
            val rows = Users.selectAll()
                .where { predicate }
                .applyPaging(paging, SORTABLE_COLUMNS)
                .toList()
            // One batch query for the page's disabled sets — not a per-row lookup.
            val ids = rows.map { it[Users.id].value }
            val featuresByUser = UserGrants.disabledFeaturesByUserIds(ids)
            val permissionsByUser = UserGrants.permissionsByUserIds(ids)
            val personByUser = linkedPersonIds(ids)
            val items = rows.map { row ->
                val id = row[Users.id].value
                row.toUser(featuresByUser[id].orEmpty().toSet(), permissionsByUser[id].orEmpty().toSet(), personByUser[id])
                    .toResponse(id)
            }
            UserListResult(items = items, total = total)
        }

    /**
     * Wholesale-replace the user's disabled-feature set (V5). Returns 1, or 0 when the id is
     * unknown or soft-deleted (the route 404s). Idempotent. The work is [UserGrants.replaceDisabledFeatures].
     */
    suspend fun setDisabledFeatures(id: UInt, features: Set<Feature>): Int = suspendTransaction(database) {
        UserGrants.replaceDisabledFeatures(id, features)
    }

    /**
     * Whether [userId] holds [permission] (V11): ONE uncached read per call, the per-request check behind
     * `requireRoadmapEditorOrAdmin` (see [UserGrants.hasPermission]).
     */
    suspend fun hasPermission(userId: UInt, permission: Permission): Boolean = suspendTransaction(database) {
        UserGrants.hasPermission(userId, permission)
    }

    /**
     * Wholesale-replace the user's granted-permission set (V11) and return the set it replaced, or null when the id is
     * unknown or soft-deleted (the route 404s); the user row is locked `FOR NO KEY UPDATE` for the replace
     * (see [UserGrants.replacePermissions]).
     */
    suspend fun replacePermissions(id: UInt, permissions: Set<Permission>): Set<Permission>? =
        suspendTransaction(database) { UserGrants.replacePermissions(id, permissions) }

    /** Outcome of a last-admin-guarded mutation (see [updateGuarded]/[deleteGuarded]). */
    enum class GuardedMutation { DONE, NOT_FOUND, LAST_ADMIN }

    /**
     * Updates the identity fields + role inside ONE transaction with the last-admin check —
     * password and passwordChangedAt stay untouched. The check and the mutation share the
     * transaction (admin rows locked, see [UserAdminGuard]), so two concurrent demotes
     * cannot both observe "two admins left".
     */
    suspend fun updateGuarded(id: UInt, name: String, email: String, role: UserRole): GuardedMutation =
        suspendTransaction(database) { UserAdminGuard.update(id, name, email, role) }

    /**
     * Soft delete with the last-admin check in the SAME transaction (see [updateGuarded]):
     * blocks login, refresh rejects `user_gone`, the V1 partial index frees the email.
     */
    suspend fun deleteGuarded(id: UInt): GuardedMutation = suspendTransaction(database) {
        UserAdminGuard.delete(id)
    }

    /** Backs the routes' fast-path 409 pre-checks (the ordering gate; correctness lives in
     *  the guarded mutations above). */
    suspend fun countActiveAdmins(): Long = suspendTransaction(database) {
        UserAdminGuard.countActiveAdmins()
    }

    private fun buildPredicate(filter: UserListFilter): Op<Boolean> {
        var op: Op<Boolean> = Op.TRUE
        filter.name?.takeIf { it.isNotBlank() }?.let { op = op and (Users.name.containsNormalized(it)) }
        filter.email?.takeIf { it.isNotBlank() }?.let { op = op and (Users.email.containsNormalized(it)) }
        filter.role?.let { op = op and (Users.role eq it.name) }
        filter.feature?.let { f ->
            // The route guarantees featureEnabled is non-null whenever feature is set.
            val disabled = UserDisabledFeatures
                .select(UserDisabledFeatures.userId)
                .where { UserDisabledFeatures.feature eq f.name }
            op = op and if (filter.featureEnabled == false) {
                Users.id inSubQuery disabled
            } else {
                Users.id notInSubQuery disabled
            }
        }
        return op
    }

    /** Bootstrap: rotate a user's password only while they still carry [expectedHash]. */
    suspend fun rotatePasswordIfHashMatches(email: String, expectedHash: String, newHash: String): Int =
        suspendTransaction(database) {
            Users.update({ (Users.email eq email) and (Users.passwordHash eq expectedHash) and Users.active() }) {
                it[passwordHash] = newHash
                it[passwordChangedAt] = nowMillis()
                it[credentialRevision] = Users.credentialRevision + 1
            }
        }

    /** Bootstrap: how many active accounts still carry [hash] (the well-known seed password). */
    suspend fun countActiveWithPasswordHash(hash: String): Long = suspendTransaction(database) {
        Users.selectAll().where { (Users.passwordHash eq hash) and Users.active() }.count()
    }

    private fun ResultRow.toUser(
        disabledFeatures: Set<Feature> = emptySet(),
        permissions: Set<Permission> = emptySet(),
        personId: UInt? = null,
    ): User = User(
        name = this[Users.name],
        email = this[Users.email],
        passwordHash = this[Users.passwordHash],
        role = UserRole.valueOf(this[Users.role]),
        disabledFeatures = disabledFeatures,
        passwordChangedAt = this[Users.passwordChangedAt],
        credentialRevision = this[Users.credentialRevision],
        language = this[Users.language],
        permissions = permissions,
        personId = personId,
    )
}

/**
 * The ONE password write for the admin PUT and the reset confirmation (both land here; the only other writer is the
 * boot-time seed rotation, [UserService.rotatePasswordIfHashMatches], conditional on the old hash); the caller owns the
 * transaction, so a reset grant's consumption and the credential change commit together. A non-null
 * [expectedRevision] makes the write conditional on the account's credential generation. The revision
 * increment shares the hash update, so no token can observe a new password with the old credential
 * generation (or vice versa).
 */
internal suspend fun updatePasswordInTransaction(
    id: UInt,
    passwordHash: String,
    expectedRevision: Long?,
    changedAt: Long = nowMillis(),
): Int = with(UserService.Users) {
    update({
        (UserService.Users.id eq id) and active() and
            (expectedRevision?.let { credentialRevision eq it } ?: Op.TRUE)
    }) {
        it[UserService.Users.passwordHash] = passwordHash
        it[passwordChangedAt] = changedAt
        it[credentialRevision] = credentialRevision + 1
    }
}
