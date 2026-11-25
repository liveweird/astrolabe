import type { ComboboxItem, OptionsFilter } from "@mantine/core";

// NFD decomposition misses letters that have no combining mark: ł/Ł is L-with-stroke, so it
// survives the \p{M} strip and needs an explicit mapping (same for đ, ø and the ligatures).
// Lowercase-only keys — folding lowercases first. Mirrors the server's unaccent() rules
// (infra/db/Sql.kt containsNormalized) closely enough for the option labels shown here.
const NON_DECOMPOSING: Record<string, string> = {
  ł: "l",
  đ: "d",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
};

/** Case- and accent-insensitive fold: "Żółw" → "zolw". */
export function foldDiacritics(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[łđøæœß]/g, (c) => NON_DECOMPOSING[c]);
}

const matches = (item: ComboboxItem, query: string) => foldDiacritics(item.label).includes(query);

// Drop-in replacement for Mantine's defaultOptionsFilter — the same label-contains-search
// contract (grouped options included), but diacritics-insensitive on both sides so typing
// "zolw" finds "Żółw". Wired app-wide as the Select/MultiSelect/TagsInput default in theme.ts.
export const foldedOptionsFilter: OptionsFilter = ({ options, search }) => {
  const query = foldDiacritics(search.trim());
  return options
    .map((option) =>
      "group" in option
        ? { ...option, items: option.items.filter((item) => matches(item, query)) }
        : option,
    )
    .filter((option) =>
      "group" in option ? option.items.length > 0 : matches(option as ComboboxItem, query),
    );
};

/** Two names in locale order, case-insensitively ("alpha" and "Alpha" tie); the building block of the lists sorted "by name, then by id". */
export const compareNames = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** The order of every list sorted by name (case-insensitive), ties broken by id. */
export const byNameThenId = (a: { name: string; id: number }, b: { name: string; id: number }) => compareNames(a.name, b.name) || a.id - b.id;

/**
 * Where a case- and accent-insensitive `query` sits in `text`, as `[start, end)` offsets into the ORIGINAL string (so a caller can wrap exactly the
 * letters the user sees: a query "zolw" marks all of "Żółw"); `null` when it is absent or blank. Folding changes lengths ("ß" is "ss", an accent
 * is nothing), so each character is folded on its own and the folded offsets are mapped back; the folding itself is {@link foldDiacritics}.
 */
export function foldedMatchRange(text: string, query: string): [number, number] | null {
  const needle = foldDiacritics(query.trim());
  if (needle === "") return null;
  let folded = "";
  // The original offset each folded character came from (and where the next original character starts).
  const origin: number[] = [];
  let offset = 0;
  for (const char of text) {
    const piece = foldDiacritics(char);
    for (let i = 0; i < piece.length; i++) origin.push(offset);
    folded += piece;
    offset += char.length;
  }
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  const last = at + needle.length - 1;
  // The end is the start of the character after the last folded one (the whole original character is marked).
  let end = offset;
  for (let i = last + 1; i < origin.length; i++) {
    if (origin[i] !== origin[last]) {
      end = origin[i];
      break;
    }
  }
  return [origin[at], end];
}
