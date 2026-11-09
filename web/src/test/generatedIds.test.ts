import { describe, expect, test } from "vitest";
import { withoutGeneratedIds } from "./generatedIds";

describe("withoutGeneratedIds", () => {
  test("a Mantine id of any length up to 9, bare or suffixed, is replaced wherever an id attribute carries it", () => {
    for (const id of ["mantine-abcdefghi", "mantine-abcdefgh", "mantine-abc", "mantine-a"]) {
      expect(withoutGeneratedIds(`<label for="${id}-week"></label><input id="${id}-week" aria-labelledby="x ${id}">`)).toBe(
        '<label for="ID-week"></label><input id="ID-week" aria-labelledby="x ID">',
      );
    }
  });

  test("React's, dnd-kit's and the style blocks go; Mantine's static class tokens and variables stay", () => {
    expect(withoutGeneratedIds('<style>a{}</style><p id=":r1a:" class="mantine-focus-auto mantine-Button-root" style="color:var(--mantine-color-dimmed)"><i id="_r_2_"></i><b id="DndLiveRegion-3"></b></p>')).toBe(
      '<p id="ID" class="mantine-focus-auto mantine-Button-root" style="color:var(--mantine-color-dimmed)"><i id="ID"></i><b id="ID"></b></p>',
    );
  });
});
