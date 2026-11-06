package ch.nokillswit.infra.validation

/**
 * Canonical email identity: trimmed + case-folded. Applied at EVERY entry point - user create/update, login, password reset, the
 * `UserService` lookup itself and the Jira connection's account email - so one mailbox is one identity (`ADMIN@x` cannot create a second
 * account beside `admin@x`, and a padded/case-variant login matches). A pure fold that never throws: login must stay a uniform 401 on
 * garbage. Moved here from `users/Validation.kt` when a second feature (`jira/`) needed it.
 */
fun canonicalEmail(raw: String): String = raw.trim().lowercase()
