package ch.nokillswit.infra.db

import org.jetbrains.exposed.v1.core.CustomFunction
import org.jetbrains.exposed.v1.core.Expression
import org.jetbrains.exposed.v1.core.LikeEscapeOp
import org.jetbrains.exposed.v1.core.LikePattern
import org.jetbrains.exposed.v1.core.LowerCase
import org.jetbrains.exposed.v1.core.Op
import org.jetbrains.exposed.v1.core.TextColumnType
import org.jetbrains.exposed.v1.core.stringParam

/**
 * Case- and diacritics-insensitive contains-match: renders
 * `LOWER(public.unaccent(col)) LIKE LOWER(public.unaccent(?)) ESCAPE '\'`, so "zolw" matches
 * "Żółw" and vice versa. Both sides fold through PG's unaccent (extension enabled in V4) — the
 * rules can't drift between query and stored text (ł→l, ß→ss, æ→ae, …), and unaccent never
 * touches ASCII `% _ \`, so [containsPattern]'s escaping survives the folding. unaccent runs
 * BEFORE LOWER on purpose: unaccent maps to same-case ASCII base letters, which LOWER folds
 * correctly under any DB locale — in a C-locale database (the postgres:18-alpine default),
 * `LOWER('Ż')` alone would leave the letter uppercase and uppercase-diacritic input would
 * silently stop matching. Every per-column substring filter MUST use this — never hand-roll
 * `lowerCase() like`.
 */
fun Expression<out String?>.containsNormalized(raw: String): Op<Boolean> {
    val pattern = containsPattern(raw)
    return LikeEscapeOp(
        normalizedLower(),
        stringParam(pattern.pattern).normalizedLower(),
        like = true,
        escapeChar = pattern.escapeChar,
    )
}

/** PostgreSQL's C-locale LOWER misses letters such as `Ż`; unaccent first gives sorting and matching one stable fold. */
internal fun Expression<out String?>.normalizedLower(): Expression<String> = LowerCase(unaccent(this))

// Schema-qualified so resolution never depends on search_path. Accepts nullable string
// expressions too: a NULL value never LIKE-matches, which is exactly what a substring filter
// over an optional column should do.
private fun unaccent(expr: Expression<*>): CustomFunction<String> =
    CustomFunction("public.unaccent", TextColumnType(), expr)

/**
 * Case-insensitive contains-match pattern with SQL LIKE metacharacters escaped — the escaping
 * is correctness-sensitive and must not drift. Used only via [containsNormalized]; internal so
 * no filter site can bypass the diacritics folding.
 */
internal fun containsPattern(raw: String): LikePattern {
    val escaped = raw.lowercase()
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    return LikePattern("%$escaped%", escapeChar = '\\')
}
