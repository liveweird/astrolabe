package ch.nokillswit

import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.STORED_PROPOSAL_FORMAT
import ch.nokillswit.planning.SavedProposalTeam
import ch.nokillswit.planning.ScheduleCheckResponse
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.StructureKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * The tripwire of the stored proposal's shape (V32 `format`). A saved proposal keeps the server's `CrossTeamProposal` and
 * `ScheduleCheckResponse` as JSON (and its `teams` and `selected` columns as small JSON arrays), and that JSON outlives the code that
 * wrote it: a field renamed, retyped, added without a default or removed would make every stored row fail to decode. So the serial
 * descriptors of those documents, and of everything they nest, are fingerprinted here, and a DTO change that does not bump
 * `STORED_PROPOSAL_FORMAT` fails this test.
 *
 * When it fails: bump `STORED_PROPOSAL_FORMAT`, ADD the new fingerprint below under the new format (never edit an old line), and
 * decide what the old rows are: they read as UNREADABLE (no migration needed), which is the intended outcome of a shape change.
 */
class StoredProposalFormatTest {
    /** Format -> the fingerprint of the stored shapes when that format was current. Append-only. */
    private val history = mapOf(
        1 to "aa01f7b679143cc7978ea14ddb055d1bce6866c01b482ab95c6619660babc3eb",
        2 to "2fc5e33419abd2bcba1f8eeb9c1718d25621aec570f97c286bf3579e39f4e438",
        3 to "6833c65b95e00983a331ff3d41f422cdb1a6cf8fc2ac7fcf5dec29fc0777ecef",
        4 to "6d6a6f3ef5dd4b00c89bb03b361819a575ba691440787274bda54ab6abe79d98",
    )

    @Test
    fun `the stored documents' serial shape matches the current format's fingerprint`() {
        val current = STORED_PROPOSAL_FORMAT.toInt()
        assertEquals(current, history.keys.max(), "the newest fingerprint below is the current format's: append a line when bumping")
        assertEquals(
            history.getValue(current),
            fingerprint(
                CrossTeamProposal.serializer().descriptor,
                ScheduleCheckResponse.serializer().descriptor,
                ListSerializer(SavedProposalTeam.serializer()).descriptor, // the `teams` column
                ListSerializer(UInt.serializer()).descriptor, // the `selected` column
            ),
            "a stored shape changed: bump STORED_PROPOSAL_FORMAT and add the new line",
        )
    }

    @Serializable
    @SerialName("Fixture.Root")
    private data class RootV1(val first: List<FirstItem>, val second: List<SecondItemV1>, val byName: Map<String, SecondItemV1>)

    @Serializable
    @SerialName("Fixture.Root")
    private data class RootV2(val first: List<FirstItem>, val second: List<SecondItemV2>, val byName: Map<String, SecondItemV2>)

    @Serializable
    @SerialName("Fixture.First")
    private data class FirstItem(val a: Int)

    @Serializable
    @SerialName("Fixture.Second")
    private data class SecondItemV1(val b: Int)

    @Serializable
    @SerialName("Fixture.Second")
    private data class SecondItemV2(val b: Long)

    @Test
    fun `the fingerprint sees a field of a list element, however many lists come first`() {
        // Every List<T> is `kotlin.collections.ArrayList` by name: keyed by that name alone, only the FIRST list would ever be walked.
        val v1 = fingerprint(RootV1.serializer().descriptor)
        val v2 = fingerprint(RootV2.serializer().descriptor)
        assertNotEquals(v1, v2, "the second list's element changed type: the fingerprint must change")
        assertEquals(v1, fingerprint(RootV1.serializer().descriptor), "and it is stable")
    }

    /**
     * The sha256 of every reachable descriptor's kind, nullability and elements (name, optionality, type), in a stable order. Classes,
     * enums and objects are keyed by their serial name; a list or map is NOT (every list shares one name): it is written as
     * `List<X>` / `Map<K,V>` after its element types, and its elements are walked wherever it occurs.
     */
    // `isElementOptional` and `PolymorphicKind` are the read-only half of an experimental API.
    @OptIn(ExperimentalSerializationApi::class)
    private fun fingerprint(vararg roots: SerialDescriptor): String {
        val lines = sortedMapOf<String, String>()
        fun label(d: SerialDescriptor): String = when (d.kind) {
            StructureKind.LIST -> "List<${label(d.getElementDescriptor(0))}>" + if (d.isNullable) "?" else ""
            StructureKind.MAP ->
                "Map<${label(d.getElementDescriptor(0))},${label(d.getElementDescriptor(1))}>" + if (d.isNullable) "?" else ""
            else -> d.serialName
        }

        fun walk(d: SerialDescriptor) {
            when {
                d.kind == StructureKind.LIST || d.kind == StructureKind.MAP -> {
                    for (i in 0 until d.elementsCount) walk(d.getElementDescriptor(i))
                }
                d.kind is PolymorphicKind -> error("polymorphic ${d.serialName}: describe its subclasses before storing it")
                d.serialName !in lines -> {
                    val elements = (0 until d.elementsCount).joinToString(",") { i ->
                        "${d.getElementName(i)}${if (d.isElementOptional(i)) "?" else ""}:${label(d.getElementDescriptor(i))}"
                    }
                    lines[d.serialName] = "${d.kind}|${d.isNullable}|$elements"
                    for (i in 0 until d.elementsCount) walk(d.getElementDescriptor(i))
                }
            }
        }
        roots.forEach(::walk)
        roots.forEach { lines["root:${label(it)}"] = "" }
        return sha256Hex(lines.entries.joinToString("\n") { "${it.key}=${it.value}" })
    }
}
