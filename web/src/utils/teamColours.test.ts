/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_THEME, type MantineColorsTuple } from "@mantine/core";
import { deltaE2000 } from "../test/colorDifference";
import { contrast } from "../test/contrast";
import { theme } from "../theme";
import { cssVariablesResolver, DARK_TOKENS, LIGHT_TOKENS } from "../themeVariables";
import { leastUsedColour, teamColourHex, teamColourVar, teamColourVariables, teamTint, TEAM_COLOURS, TEAM_COLOUR_KEYS, type TeamColour } from "./teamColours";

const COLORS = { ...DEFAULT_THEME.colors, ...theme.colors } as Record<string, MantineColorsTuple>;
const SCHEMES = ["light", "dark"] as const;
const NON_TEXT = 3; // WCAG 1.4.11: a graphic that carries meaning

// The three surfaces a swatch or a bar sits on, per scheme: the table row (white / dark-7, Mantine's own), the canvas and the table's hover tint.
const SURFACES = {
  light: { row: "#ffffff", canvas: LIGHT_TOKENS.canvas, hover: LIGHT_TOKENS.tableHover },
  dark: { row: DEFAULT_THEME.colors.dark[7], canvas: DARK_TOKENS.canvas, hover: DARK_TOKENS.tableHover },
} as const;

const hex = (colour: TeamColour, scheme: (typeof SCHEMES)[number]) => teamColourHex(TEAM_COLOURS[colour][scheme], COLORS);

describe("the team palette", () => {
  test("is the generated enum: the same twelve keys, in the same (assignment) order", () => {
    // `components["schemas"]["TeamColour"]` is a type, so the order is read off the generated file's text (the spec's enum, `gen:api`).
    const generated = readFileSync(resolve(process.cwd(), "src/api/schema.ts"), "utf8");
    const union = /\bTeamColour: ((?:"[A-Z]+"(?: \| )?)+);/.exec(generated);
    expect(union, "TeamColour is declared in schema.ts").not.toBeNull();
    const keys = [...(union?.[1] ?? "").matchAll(/"([A-Z]+)"/g)].map((match) => match[1]);
    expect(TEAM_COLOUR_KEYS).toEqual(keys);
    expect(keys).toHaveLength(12);
  });

  test.each(TEAM_COLOUR_KEYS.flatMap((colour) => SCHEMES.map((scheme) => [colour, scheme] as const)))(
    "%s (%s) clears WCAG 1.4.11 (3:1) on the row, the canvas and the table hover",
    (colour, scheme) => {
      for (const [surface, ground] of Object.entries(SURFACES[scheme])) {
        expect(contrast(hex(colour, scheme), ground), `${colour} ${scheme} on the ${surface} ${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    },
  );

  test("tells keys apart in each scheme: the first eight at least ΔE2000 15 apart, all twelve at least 9", () => {
    for (const scheme of SCHEMES) {
      TEAM_COLOUR_KEYS.forEach((a, i) => {
        TEAM_COLOUR_KEYS.slice(i + 1).forEach((b, offset) => {
          const apart = deltaE2000(hex(a, scheme), hex(b, scheme));
          expect(apart, `${a} / ${b} (${scheme})`).toBeGreaterThanOrEqual(i + 1 + offset < 8 ? 15 : 9);
        });
      });
    }
  });

  test("the documented shades: three keys read off the plan, in hex", () => {
    expect(hex("INDIGO", "light")).toBe("#5c7cfa");
    expect(hex("GREEN", "dark")).toBe("#b2f2bb");
    expect(hex("RASPBERRY", "light")).toBe("#a61e4d");
  });
});

describe("the resolver and the mark", () => {
  test("every key is one custom property per scheme, holding the shade's hex", () => {
    const resolved = cssVariablesResolver({ ...DEFAULT_THEME, ...theme, colors: COLORS } as Parameters<typeof cssVariablesResolver>[0]);
    for (const scheme of SCHEMES) {
      const variables = resolved[scheme];
      expect(Object.keys(variables).filter((name) => name.startsWith("--astrolabe-team-"))).toHaveLength(12);
      for (const colour of TEAM_COLOUR_KEYS) {
        expect(variables[`--astrolabe-team-${colour.toLowerCase()}`]).toBe(hex(colour, scheme));
      }
      expect(teamColourVariables(scheme, COLORS)).toMatchObject({ "--astrolabe-team-indigo": hex("INDIGO", scheme) });
    }
    expect(teamColourVar("LAVENDER")).toBe("var(--astrolabe-team-lavender)");
  });

  test("a shade of a hue the theme lacks is refused loudly", () => {
    expect(() => teamColourHex("nope.5", COLORS)).toThrow(/nope/);
  });
});

describe("leastUsedColour (the server's rule)", () => {
  test("no team: the first key", () => {
    expect(leastUsedColour([])).toBe("INDIGO");
  });

  test("an unused key counts 0 and the earlier key wins a tie", () => {
    expect(leastUsedColour(["INDIGO"])).toBe("TEAL");
    expect(leastUsedColour(["INDIGO", "TEAL", "INDIGO"])).toBe("LIME");
    expect(leastUsedColour(["TEAL", "LIME"])).toBe("INDIGO");
  });

  test("once every key is used it is the least used, the earlier of equals", () => {
    const all = [...TEAM_COLOUR_KEYS];
    expect(leastUsedColour(all)).toBe("INDIGO");
    expect(leastUsedColour([...all, "INDIGO", "GREEN"])).toBe("TEAL");
    expect(leastUsedColour(all.filter((colour) => colour !== "COBALT").concat("INDIGO"))).toBe("COBALT");
  });
});

describe("teamTint", () => {
  const colours = new Map<number, TeamColour>([[3, "TEAL"]]);

  test("a known team tints with its key's variable; a missing team, a null id and an empty lookup add nothing (the neutral bar)", () => {
    expect(teamTint(colours, 3)).toEqual({ tint: "var(--astrolabe-team-teal)" });
    expect(teamTint(colours, 4)).toEqual({});
    expect(teamTint(colours, null)).toEqual({});
    expect(teamTint(new Map(), 3)).toEqual({});
  });
});
