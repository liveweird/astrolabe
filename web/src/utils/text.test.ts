import { describe, expect, test } from "vitest";
import type { ComboboxItem } from "@mantine/core";
import { foldDiacritics, foldedOptionsFilter, foldedMatchRange } from "./text";

describe("foldDiacritics", () => {
  test("lowercases and strips combining diacritics", () => {
    expect(foldDiacritics("Żółw")).toBe("zolw");
    expect(foldDiacritics("ĄĆĘŃŚŹŻ")).toBe("acenszz");
  });

  test("maps the non-decomposing letters and ligatures", () => {
    expect(foldDiacritics("Łódź")).toBe("lodz");
    expect(foldDiacritics("Søren")).toBe("soren");
    expect(foldDiacritics("Straße")).toBe("strasse");
    expect(foldDiacritics("Æther œuvre đen")).toBe("aether oeuvre den");
  });
});

describe("foldedOptionsFilter", () => {
  const options: ComboboxItem[] = [
    { value: "1", label: "Żółw Kowalski" },
    { value: "2", label: "Zolw Plain" },
    { value: "3", label: "Bob" },
  ];

  test("matches accent-insensitively in both directions", () => {
    expect(foldedOptionsFilter({ options, search: "zolw", limit: 10 })).toEqual([
      options[0],
      options[1],
    ]);
    expect(foldedOptionsFilter({ options, search: "żółw", limit: 10 })).toEqual([
      options[0],
      options[1],
    ]);
  });

  test("filters grouped options and drops emptied groups", () => {
    const grouped = [
      { group: "Turtles", items: [options[0], options[1]] },
      { group: "Builders", items: [options[2]] },
    ];
    expect(foldedOptionsFilter({ options: grouped, search: "zolw", limit: 10 })).toEqual([
      { group: "Turtles", items: [options[0], options[1]] },
    ]);
  });
});

describe("foldedMatchRange", () => {
  const marked = (text: string, query: string) => {
    const range = foldedMatchRange(text, query);
    return range === null ? null : text.slice(range[0], range[1]);
  };

  test("marks exactly the letters the user sees, whatever the case and accents", () => {
    expect(marked("Billing", "ill")).toBe("ill");
    expect(marked("Żółw Platform", "ZOLW")).toBe("Żółw");
    expect(marked("Zażółć gęślą", "gesl")).toBe("gęśl");
    expect(marked("Plan A", "n a")).toBe("n A");
  });

  test("a letter that folds to two (ß) is marked whole, and a query may start or end inside it", () => {
    expect(marked("Straße", "strass")).toBe("Straß");
    expect(marked("Straße", "strasse")).toBe("Straße");
    expect(marked("Straße", "ss")).toBe("ß");
    expect(marked("Straße", "sse")).toBe("ße");
  });

  test("a decomposed accent travels with its letter", () => {
    expect(marked("Café bar", "cafe")).toBe("Café");
  });

  test("the first occurrence wins; a blank query or an absent one marks nothing", () => {
    expect(foldedMatchRange("banana", "an")).toEqual([1, 3]);
    expect(foldedMatchRange("banana", "   ")).toBeNull();
    expect(foldedMatchRange("banana", "")).toBeNull();
    expect(foldedMatchRange("banana", "x")).toBeNull();
  });
});
