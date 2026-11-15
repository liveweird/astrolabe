package ch.nokillswit

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper
import io.swagger.v3.parser.OpenAPIV3Parser
import io.swagger.v3.parser.core.models.ParseOptions
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Static sanity checks on the OpenAPI spec itself — no server or database boot. The runtime
 * conformance validation (every test-client /api/ interaction checked against the spec) lives in
 * [OpenApiConformance]; these tests pin the structural invariants that validation relies on.
 */
class OpenApiSpecTest {

    @Test
    fun `spec parses with no parser messages`() {
        val result = OpenAPIV3Parser().readContents(OpenApiSpec.validatorYaml, null, ParseOptions().apply { isResolve = true })
        assertNotNull(result.openAPI, "spec failed to parse")
        assertEquals(emptyList(), result.messages ?: emptyList(), "spec should parse without warnings/errors")
    }

    /**
     * The spec declares `openapi: 3.1.0` but is validated at test time as 3.0.3 (in-memory relabel
     * in [OpenApiSpec] — swagger-request-validator's 3.1 support is unreliable). That relabel is
     * only sound while the document uses no 3.1-only constructs; this guard pins it. If it fails:
     * remove the 3.1-only construct, or rework the relabel in OpenApiConformance.kt.
     */
    @Test
    fun `spec uses only 3_0-compatible constructs`() {
        val offenders = listOf(
            Regex("""type:\s*\["""),
            Regex("""\bconst:"""),
            Regex("""\bprefixItems:"""),
            Regex("""-\s+['"]?null['"]?\s*$""", RegexOption.MULTILINE),
            Regex("""\bpatternProperties:"""),
            Regex("""\bunevaluated(Properties|Items):"""),
            Regex("""\bjsonSchemaDialect:"""),
            Regex("""^webhooks:""", RegexOption.MULTILINE),
        ).mapNotNull { regex -> regex.find(OpenApiSpec.rawYaml)?.value }
        assertEquals(
            emptyList(), offenders,
            "documentation.yaml contains OpenAPI 3.1-only constructs, but conformance validation " +
                "relabels it to 3.0.3 (see OpenApiConformance.kt) — use the 3.0 idiom (e.g. nullable:) instead",
        )
    }

    @Test
    fun `every path is under api v1`() {
        val outside = OpenApiSpec.parsed.paths.keys.filterNot { it.startsWith("/api/v1/") }
        assertEquals(emptyList(), outside, "all API paths must live under /api/v1/")
    }

    @Test
    fun `every operation has a unique operationId`() {
        val ids = OpenApiSpec.parsed.paths.flatMap { (path, item) ->
            item.readOperationsMap().map { (method, op) -> Triple(path, method, op.operationId) }
        }
        val missing = ids.filter { it.third.isNullOrBlank() }.map { "${it.second} ${it.first}" }
        assertEquals(emptyList(), missing, "operations without an operationId")
        val duplicated = ids.groupBy { it.third }.filterValues { it.size > 1 }.keys
        assertEquals(emptySet(), duplicated, "duplicated operationIds")
    }

    @Test
    fun `every operation declares a success status and a 500`() {
        val violations = OpenApiSpec.parsed.paths.flatMap { (path, item) ->
            item.readOperationsMap().mapNotNull { (method, op) ->
                val statuses = op.responses.keys
                val hasSuccess = statuses.any { it.startsWith("2") || it.startsWith("3") }
                when {
                    !hasSuccess -> "$method $path declares no 2xx/3xx response"
                    "500" !in statuses -> "$method $path declares no 500 response"
                    else -> null
                }
            }
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `every secured operation declares a 401`() {
        val violations = OpenApiSpec.parsed.paths.flatMap { (path, item) ->
            item.readOperationsMap().mapNotNull { (method, op) ->
                // op.security == null → inherits the global bearerAuth; an explicit `security: []`
                // (login, refresh, password-reset, password-reset/confirm) parses to an empty list and is exempt.
                val secured = op.security?.isNotEmpty() ?: true
                if (secured && "401" !in op.responses.keys) "$method $path is secured but declares no 401" else null
            }
        }
        assertEquals(emptyList(), violations)
    }

    @Test
    fun `every operation that takes a body declares the cross-cutting 413`() {
        // `413` is the global body ceiling (`RequestBodyLimit`): every body operation can answer it, so every one declares
        // it; the coverage gate exempts it (CROSS_CUTTING_STATUSES), so no per-operation test is owed.
        val violations = OpenApiSpec.parsed.paths.flatMap { (path, item) ->
            item.readOperationsMap().mapNotNull { (method, op) ->
                if (op.requestBody != null && "413" !in op.responses.keys) "$method $path takes a body but declares no 413" else null
            }
        }
        assertEquals(emptyList(), violations)
    }

    /**
     * A date-only string must say so: a schema property or parameter named `day`/`date`/`from`/`to`/`holidays`/`bucketStart`
     * or ending in `Day`/`Date` (`asOfDay`; not every `*Start`: `epicStart` is a field id) and typed `string` carries a
     * `format` (`date`, or `date-time` where it is one), arrays through their `items`. Enums are exempt. Scoped to the
     * component schemas and the component parameters, where every such field of this spec lives (a new inline one fails
     * the review, not this test).
     */
    @Test
    fun `date-like string properties and parameters carry a format`() {
        val dateLike = Regex("""^(day|date|from|to|holidays|bucketStart)$|(Day|Date)$""")
        val components = OpenApiSpec.parsed.components
        fun io.swagger.v3.oas.models.media.Schema<*>.undeclared(): Boolean {
            val target = if (type == "array") items else this
            return target != null && target.type == "string" && target.format == null && target.enum.isNullOrEmpty()
        }
        val schemaViolations = components.schemas.flatMap { (schema, definition) ->
            definition.properties.orEmpty().filter { (name, property) -> dateLike.containsMatchIn(name) && property.undeclared() }
                .keys.map { "schema $schema.$it" }
        }
        val parameterViolations = components.parameters.values
            .filter { dateLike.containsMatchIn(it.name) && it.schema.undeclared() }.map { "parameter ${it.name}" }
        assertEquals(emptyList(), schemaViolations + parameterViolations, "date-like strings without a `format:` in documentation.yaml")
    }

    @Test
    fun `spec path templates are unambiguous for coverage resolution`() {
        // Every concrete path derivable from one template must not match another template of the
        // same shape — guard the most-literal-first resolution in OpenApiCoverage by asserting no
        // two templates collapse to the same normalized form.
        val normalized = OpenApiSpec.parsed.paths.keys.groupBy { it.replace(Regex("""\{[^}]+}"""), "{}") }
        val ambiguous = normalized.filterValues { it.size > 1 }.values.flatten()
        assertEquals(emptyList(), ambiguous, "path templates that differ only in parameter names")
    }

    /**
     * `info.version` mirrors the app version (`APP_VERSION` in `web/src/changelog/version.ts`, the one source of truth;
     * `.claude/docs/app-releases.md`): the spec describes the build that serves it, and every version bump edits both.
     */
    @Test
    fun `spec info version equals the app version`() {
        val versionFile = File(System.getProperty("repo.root") ?: "..", "web/src/changelog/version.ts")
        assertTrue(versionFile.isFile, "${versionFile.absolutePath} not found")
        val appVersion = Regex("""APP_VERSION\s*=\s*"([^"]+)"""").find(versionFile.readText())?.groupValues?.get(1)
        assertNotNull(appVersion, "APP_VERSION literal not found in version.ts")
        assertEquals(
            appVersion, OpenApiSpec.parsed.info.version,
            "documentation.yaml info.version must equal APP_VERSION - bump both together",
        )
    }

    /**
     * A nullable enum cannot `$ref` its base (the validator reads a nullable enum behind an `allOf` as non-null), so the spec spells the
     * values of every `Nullable<X>` out again: each lists exactly `X`'s values, in order. `NullableDeviationKind` also follows the code.
     */
    @Test
    fun `every nullable enum lists exactly the values of its base enum`() {
        val schemas = OpenApiSpec.parsed.components.schemas
        val nullables = schemas.keys.filter { it.startsWith("Nullable") }
        assertTrue(nullables.isNotEmpty(), "no Nullable<X> schema found")
        for (name in nullables) {
            val base = name.removePrefix("Nullable")
            val baseValues = assertNotNull(schemas[base], "$name needs a $base schema").enum.filterNotNull().map { it.toString() }
            assertTrue(baseValues.isNotEmpty(), "$base is not an enum")
            val values = schemas.getValue(name).enum.filterNotNull().map { it.toString() }
            assertEquals(baseValues, values, "$name must list $base's values in order")
        }
        val kinds = ch.nokillswit.planning.DeviationKind.entries.map { it.name }
        val listed = schemas.getValue("DeviationKind").enum.filterNotNull().map { it.toString() }
        assertEquals(kinds, listed, "DeviationKind must list the entries in order")
    }

    /**
     * `ProblemDetail.type`'s description is the client's list of problem types: it names exactly the `urn:astrolabe:problem:` slugs
     * the server's sources declare (a constant or a mention in a comment alike), so a new type cannot ship unlisted.
     */
    @Test
    fun `the problem type's description names exactly the slugs the server's sources declare`() {
        val slug = Regex("""urn:astrolabe:problem:[a-z-]+""")
        val sources = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(sources.isDirectory, "${sources.absolutePath} not found")
        val declared = sources.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> slug.findAll(file.readText()).map { it.value.trimEnd('-') } }.toSortedSet()
        val type = assertNotNull(OpenApiSpec.parsed.components.schemas["ProblemDetail"]?.properties?.get("type"), "ProblemDetail.type")
        val listed = slug.findAll(type.description.orEmpty()).map { it.value.trimEnd('-') }.toSortedSet()
        assertEquals(declared.toList(), listed.toList(), "ProblemDetail.type must list exactly the slugs the server declares")
    }

    /**
     * A description states the contract and stays short: an operation's at most [OPERATION_LIMIT] characters, a schema's [SCHEMA_LIMIT],
     * every other one (a property, parameter, response, header, tag, request body) [MEMBER_LIMIT], `info` [INFO_LIMIT]. The two
     * [catalogues] are lists on purpose (one line an entry) and have a ceiling and a line length of their own. A longer text
     * moves its reasoning to the docs and its wire detail to the members it describes.
     */
    @Test
    fun `every description stays within the length limit of its kind`() {
        val over = specDescriptions().mapNotNull { description ->
            val catalogue = description.path in catalogues
            val longestLine = description.text.lines().maxOf { it.length }
            when {
                catalogue && description.text.length > CATALOGUE_LIMIT ->
                    "${description.location}: catalogue of ${description.text.length} characters, limit $CATALOGUE_LIMIT"
                catalogue && longestLine > MEMBER_LIMIT ->
                    "${description.location}: catalogue line of $longestLine characters, limit $MEMBER_LIMIT"
                !catalogue && description.text.length > description.limit ->
                    "${description.location}: ${description.text.length} characters, limit ${description.limit}"
                else -> null
            }
        }
        assertEquals(emptyList(), over, "descriptions over their limit in documentation.yaml")
    }

    /** No description (nor operation summary) carries a release tag, a migration id or a doc file name: they age, the contract stays. */
    @Test
    fun `no description names a release, a migration or a doc file`() {
        val offenders = specDescriptions().flatMap { description ->
            forbiddenInDescriptions.mapNotNull { (what, pattern) ->
                pattern.find(description.text)?.let { "${description.location}: $what `${it.value}`" }
            }
        }
        assertEquals(emptyList(), offenders, "descriptions that name a release, a migration id or a doc file in documentation.yaml")
    }

    /** The walks above mean something only while they reach every kind of description; a refactor cannot silently empty them. */
    @Test
    fun `the description walk reaches operations, schemas and members`() {
        val found = specDescriptions()
        assertTrue(found.count { it.limit == OPERATION_LIMIT } > 100, "operation descriptions found")
        assertTrue(found.count { it.limit == SCHEMA_LIMIT } > 100, "schema descriptions found")
        assertTrue(found.count { it.limit == MEMBER_LIMIT } > 500, "member, parameter and response descriptions found")
    }

    /** One description (or summary) of the spec: [path] is where it sits, [limit] the length its kind may have. */
    private class SpecDescription(val path: List<String>, val text: String, val limit: Int) {
        val location: String get() = path.joinToString(" > ")
    }

    /** Every textual `description` and `summary` of the committed spec, read from the raw YAML tree (no `$ref` is followed). */
    private fun specDescriptions(): List<SpecDescription> {
        val found = mutableListOf<SpecDescription>()
        fun walk(node: JsonNode, path: List<String>) {
            if (node.isArray) {
                node.forEachIndexed { index, child -> walk(child, path + "[$index]") }
            } else if (node.isObject) {
                for (key in node.fieldNames().asSequence().toList()) {
                    val child = node[key]
                    when {
                        (key == "description" || key == "summary") && child.isTextual ->
                            found += SpecDescription(path + key, child.asText(), if (key == "summary") SUMMARY_LIMIT else limitOf(path))
                        key != "example" && key != "examples" -> walk(child, path + key)
                    }
                }
            }
        }
        walk(YAMLMapper().readTree(OpenApiSpec.rawYaml), emptyList())
        return found
    }

    /** The limit of the description in the node at [path]: `info`, an operation (`paths > p > method`), a schema, else a member. */
    private fun limitOf(path: List<String>): Int = when {
        path == listOf("info") -> INFO_LIMIT
        path.size == 3 && path[0] == "paths" -> OPERATION_LIMIT
        path.size == 3 && path[0] == "components" && path[1] == "schemas" -> SCHEMA_LIMIT
        else -> MEMBER_LIMIT
    }

    private companion object {
        const val INFO_LIMIT = 1_500
        const val OPERATION_LIMIT = 1_200
        const val SCHEMA_LIMIT = 600
        const val MEMBER_LIMIT = 400
        const val SUMMARY_LIMIT = 200
        const val CATALOGUE_LIMIT = 3_500

        /** The descriptions that are lists on purpose: the problem types and the failure codes, one line each. */
        val catalogues = setOf(
            listOf("components", "schemas", "ProblemDetail", "properties", "type", "description"),
            listOf("components", "schemas", "SyncFailureCode", "description"),
        )

        val forbiddenInDescriptions = mapOf(
            "a release tag" to Regex("""\(\s*1\.\d+|\b(since|until|before|in|from|after|as of) 1\.\d+""", RegexOption.IGNORE_CASE),
            "a migration id" to Regex("""\bV\d{1,2}\b"""),
            "a doc file name" to Regex("""\.md\b"""),
        )
    }
}
