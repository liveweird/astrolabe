package ch.nokillswit.jira

import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.planning.MAX_PLAN_NAME_LENGTH
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.Normalizer
import java.util.Locale

/** A plan name made from a summary: [truncated] = the (collapsed) summary was longer than [MAX_PLAN_NAME_LENGTH] and was cut. */
class ImportName(val text: String, val truncated: Boolean)

/** A milestone estimate in man-days at two decimals; [notConverted] = a figure was there and could not be converted (stored as 0.00). */
class EstimateConversion(val manDays: BigDecimal, val notConverted: Boolean)

/**
 * The Jira import's decisions as ONE pure function (1.2): which browsed issue becomes a new program, project or milestone, which one
 * binds an existing node, which is skipped and why, where each lands, which team and dates a milestone gets, and (for an apply) which
 * ticked rows are written. No database, no clock beyond [ImportInput.asOf], no HTTP: the preview runs it over one snapshot, the apply
 * runs the SAME code over rows re-read under the plan lock, so what the user saw and what is written cannot drift apart in rules.
 *
 * The rules are the "hard cases" table of the 1.2 plan:
 * - Rows come top-down (programs, projects, milestones; Jira ids ascending inside a level) and a child's parent is, in order: the node
 *   bound to its nearest Jira ancestor at the parent's plan level (only when that node lies under the picked work stream); else the
 *   batch row of that ancestor (CREATE = the new node, BIND = its target); else the level's default parent; else NO_PARENT. The default
 *   is for GENUINE orphans only (no Jira parent at that level, or one that is neither in the plan nor in the browse). A child whose
 *   ancestor IS in the browse and was skipped (NAME_TAKEN, NO_PARENT, LEVEL_UNMAPPED, or itself PARENT_SKIPPED) is PARENT_SKIPPED, in a
 *   preview as in an apply, and never re-homed; an ALREADY_BOUND ancestor stays usable through its bound node (under the stream).
 *   The same reason covers a parent row the CLIENT left out of an apply (unticked, or itself PARENT_SKIPPED/CHANGED) - the rows
 *   are decided in full first and the ticks applied after, so claims never depend on ticks.
 * - A ROOTED import (1.15, [ImportInput.root]) writes only under its root, for every caller: a row whose parent resolves to an
 *   EXISTING node outside the root's subtree is OUTSIDE_ROOT (a skip, in a preview as in an apply), never created or bound there.
 * - Names are compared case-insensitively with Kotlin's `lowercase()`; the unique indexes use PostgreSQL's `LOWER()`. They agree for
 *   every real name; an exotic mismatch is caught by the indexes as a whole-request `409`, never as a wrong row.
 * - An apply computes every row with the client's team overrides, then compares each ticked row with its `expected` block. A ticked row
 *   the kernel skips is reported with the kernel's own reason (a re-import answers ALREADY_BOUND); a row that is still CREATE/BIND but
 *   differs from `expected` is CHANGED; an id the browse no longer holds is CHANGED without a key.
 */
object JiraImportKernels {
    fun plan(input: ImportInput): ImportPlan = ImportPlanner(input).run()

    private val WHITESPACE = Regex("\\s+")
    private val COMBINING_MARKS = Regex("\\p{M}+")
    private val NON_DECOMPOSING = mapOf('ł' to "l", 'đ' to "d", 'ø' to "o", 'æ' to "ae", 'œ' to "oe", 'ß' to "ss")
    private const val ESTIMATE_SCALE = 2
    private val ESTIMATE_LIMIT = BigDecimal(1_000_000)

    /**
     * The plan name of an issue: control characters become spaces, whitespace is collapsed and trimmed, the text is cut at
     * [MAX_PLAN_NAME_LENGTH] without splitting a surrogate pair (and trimmed again, so a cut never leaves a trailing space), and a
     * summary that is blank or only invisible characters becomes the issue key.
     */
    fun importName(summary: String?, issueKey: String): ImportName {
        val cleaned = summary.orEmpty().map { if (it.isISOControl()) ' ' else it }.joinToString("").replace(WHITESPACE, " ").trim()
        val text = sanitizeSingleLine(cleaned, "Name")
        if (text.isEmpty()) return ImportName(issueKey, false)
        val cut = text.length > MAX_PLAN_NAME_LENGTH
        return ImportName(if (cut) text.take(MAX_PLAN_NAME_LENGTH).fitted().trimEnd() else text, cut)
    }

    /**
     * The fold teams are matched by: trimmed, lowercased, accents stripped (NFD, then the letters with no decomposition: ł, đ, ø, æ, œ, ß -
     * the SPA's `foldDiacritics` rule), so "Zespół Płatności" and "zespol platnosci" are the same team.
     */
    fun foldName(name: String): String =
        Normalizer.normalize(name.trim().lowercase(Locale.ROOT), Normalizer.Form.NFD)
            .replace(COMBINING_MARKS, "")
            .map { NON_DECOMPOSING[it] ?: it.toString() }
            .joinToString("")

    /**
     * Jira's [figure] in man-days: times 1 for `DAYS`, else times the declared factor, at two decimals half-up. No figure = 0.00 with
     * nothing to report; a figure with no declared factor, or a result outside the milestone range (negative, or a million or more),
     * is 0.00 and [EstimateConversion.notConverted] (the settled rule: nothing assumes points convert).
     */
    fun convertEstimate(figure: BigDecimal?, estimate: JiraEstimateMapping): EstimateConversion {
        val zero = BigDecimal.ZERO.setScale(ESTIMATE_SCALE)
        if (figure == null) return EstimateConversion(zero, false)
        val factor = if (estimate.unit == JiraEstimateUnit.DAYS) BigDecimal.ONE else estimate.manDaysPerUnit?.let(BigDecimal::valueOf)
        val product = factor?.let(figure::multiply)
        if (product == null || product.signum() < 0) return EstimateConversion(zero, true)
        val rounded = product.setScale(ESTIMATE_SCALE, RoundingMode.HALF_UP)
        return if (rounded >= ESTIMATE_LIMIT) EstimateConversion(zero, true) else EstimateConversion(rounded, false)
    }
}
