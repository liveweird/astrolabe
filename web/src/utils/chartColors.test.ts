import { describe, expect, test } from "vitest";
import { DEFAULT_THEME, type MantineColorsTuple } from "@mantine/core";
import { deltaE2000 } from "../test/colorDifference";
import { contrast } from "../test/contrast";
import { theme } from "../theme";
import { DARK_TOKENS, LIGHT_TOKENS } from "../themeVariables";
import { CATEGORY_PALETTE } from "./chartColors";

/** "violet.5" → the hex, resolved through the app theme first (the `astrolabe` tuple), then Mantine's defaults. */
function shade(color: string): string {
  const [name, index] = color.split(".");
  const tuple = (theme.colors?.[name] ?? DEFAULT_THEME.colors[name]) as MantineColorsTuple;
  return tuple[Number(index)];
}

const LIGHT_SURFACES = ["#ffffff", LIGHT_TOKENS.canvas];
// dark-6 is the surface chart cards and table heads sit on in the dark scheme.
const DARK_SURFACES = [DEFAULT_THEME.colors.dark[6], DARK_TOKENS.canvas];

describe("the categorical chart palette", () => {
  test.each(CATEGORY_PALETTE.map((color) => [color]))("%s clears WCAG 1.4.11 (3:1) on every chart surface in both schemes", (color) => {
    for (const surface of [...LIGHT_SURFACES, ...DARK_SURFACES]) {
      expect(contrast(shade(color), surface), `${color} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("wears no semantic hue, no stock cyan (the brand's twin) and no hue twice", () => {
    const hues = CATEGORY_PALETTE.map((color) => color.split(".")[0]);
    for (const reserved of ["green", "teal", "lime", "orange", "red", "cyan"]) expect(hues).not.toContain(reserved);
    expect(new Set(hues).size).toBe(hues.length);
  });

  test("neighbouring entries (the wrap-around included) are ΔE2000 ≥ 15 apart", () => {
    CATEGORY_PALETTE.forEach((color, i) => {
      const next = CATEGORY_PALETTE[(i + 1) % CATEGORY_PALETTE.length];
      expect(deltaE2000(shade(color), shade(next)), `${color} → ${next}`).toBeGreaterThanOrEqual(15);
    });
  });

  test("every entry is ΔE2000 ≥ 15 from the three semantic colours (green.8, orange.8, red.7)", () => {
    for (const color of CATEGORY_PALETTE) {
      for (const meaning of ["green.8", "orange.8", "red.7"]) {
        expect(deltaE2000(shade(color), shade(meaning)), `${color} vs ${meaning}`).toBeGreaterThanOrEqual(15);
      }
    }
  });

  test("the documented palette: the order and the figures of the comment table", () => {
    expect(CATEGORY_PALETTE).toEqual(["astrolabe.6", "violet.5", "pink.6", "indigo.5", "gray.6"]);
    expect(contrast(shade("violet.5"), "#ffffff")).toBeCloseTo(4.26, 2);
    expect(deltaE2000(shade("astrolabe.6"), shade("violet.5"))).toBeCloseTo(30.4, 1);
    expect(deltaE2000(shade("indigo.5"), shade("gray.6"))).toBeCloseTo(17.5, 1);
  });
});
