import { DEFAULT_THEME } from "@mantine/core";
import { describe, expect, it } from "vitest";
import indexCss from "./index.css?raw";
import { deltaE2000 } from "./test/colorDifference";
import { contrast } from "./test/contrast";
import { theme } from "./theme";
import { DARK_TOKENS, LIGHT_TOKENS, LIGHT_VARIANT_INKS } from "./themeVariables";

// Mantine's own `darken(color, alpha)`: each channel scaled by (1 - alpha), rounded — the dark
// scheme's light-variant surface is `darken(<hue>-9, 0.5)` (get-css-color-variables.mjs).
function darken(hex: string, alpha: number): string {
  const scaled = [1, 3, 5].map((o) => Math.round(Number.parseInt(hex.slice(o, o + 2), 16) * (1 - alpha)));
  return `#${scaled.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
const WHITE = "#ffffff";
const AA = 4.5;

/** The hue's scale: the app theme's own (`astrolabe`) first, then Mantine's defaults. */
function scaleOf(hue: string): readonly string[] {
  return theme.colors?.[hue] ?? DEFAULT_THEME.colors[hue];
}

describe("theme motion", () => {
  it("honors the OS reduced-motion preference (Mantine's default is off)", () => {
    expect(theme.respectReducedMotion).toBe(true);
  });
});

describe("theme colour tokens (WCAG AA)", () => {
  it("light text tokens clear 4.5:1 on white, the canvas, and the surface tint", () => {
    // The surface tint is the FilterPanelBody ground — dimmed labels sit on it.
    const surfaces = [WHITE, LIGHT_TOKENS.canvas, LIGHT_TOKENS.surfaceTint];
    for (const ink of [LIGHT_TOKENS.text, LIGHT_TOKENS.dimmed, LIGHT_TOKENS.error, LIGHT_TOKENS.inkWarning, LIGHT_TOKENS.inkError]) {
      for (const surface of surfaces) {
        expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("every light-variant ink clears 4.5:1 on its hue's light surface (the 1-shade)", () => {
    // Mantine 9 paints a light-variant surface with the hue's SOLID 1-shade in the light scheme
    // (`--mantine-color-<hue>-light: var(--mantine-color-<hue>-1)`) — the ink must clear AA on it.
    for (const [hue, ink] of Object.entries(LIGHT_VARIANT_INKS)) {
      const surface = scaleOf(hue)[1];
      expect(surface, `unknown hue ${hue}`).toBeDefined();
      expect(contrast(ink, surface), `${hue} ink ${ink} on ${surface}`).toBeGreaterThanOrEqual(AA);
      // The same ink also sits on white/canvas surfaces (links, filled-on-light text).
      expect(contrast(ink, WHITE), `${hue} ink ${ink} on white`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("the dark scheme keeps Mantine's own light-variant pairs (0-shade over a darkened 9-shade)", () => {
    for (const hue of Object.keys(LIGHT_VARIANT_INKS)) {
      const scale = scaleOf(hue);
      expect(contrast(scale[0], darken(scale[9], 0.5)), `${hue} dark light-variant`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("dark text tokens clear 4.5:1 on the dark surfaces", () => {
    // dark-7 = body, dark-6 = table heads, the canvas, and the surface tint (FilterPanelBody).
    const surfaces = [DEFAULT_THEME.colors.dark[7], DEFAULT_THEME.colors.dark[6], DARK_TOKENS.canvas, DARK_TOKENS.surfaceTint];
    for (const ink of [DARK_TOKENS.text, DARK_TOKENS.dimmed, DARK_TOKENS.error, DARK_TOKENS.inkWarning, DARK_TOKENS.inkError]) {
      for (const surface of surfaces) {
        expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("the brand accent stays usable as filled button, focus ring and accent ink in both schemes", () => {
    const brand = theme.colors!.astrolabe!;
    expect(theme.primaryColor).toBe("astrolabe");
    expect(theme.primaryShade).toEqual({ light: 8, dark: 9 });
    // Light scheme: white text on the shade-8 fill (#0b7285, 5.6:1), and the shade itself as a focus ring (3:1
    // floor) — Mantine's stock shade-7 falls short of 4.5:1 for white CTA text on this hue.
    expect(brand[8]).toBe("#0b7285");
    expect(contrast(brand[8], WHITE)).toBeGreaterThanOrEqual(AA);
    expect(contrast(brand[8], WHITE)).toBeCloseTo(5.59, 2);
    expect(contrast(brand[8], LIGHT_TOKENS.canvas)).toBeGreaterThanOrEqual(3);
    expect(LIGHT_TOKENS.accentInk).toBe(brand[8]);
    // Dark scheme: white text on the shade-9 fill (#095c6b, 7.6:1); the hue itself is too dark to be SEEN on
    // dark-8, so the accent ink flips to shade 4 there — readable as text on every dark surface.
    expect(brand[9]).toBe("#095c6b");
    expect(contrast(brand[9], WHITE)).toBeGreaterThanOrEqual(AA);
    expect(contrast(brand[9], WHITE)).toBeCloseTo(7.62, 2);
    expect(DARK_TOKENS.accentInk).toBe(brand[4]);
    for (const surface of [DEFAULT_THEME.colors.dark[7], DEFAULT_THEME.colors.dark[6], DARK_TOKENS.canvas, DARK_TOKENS.surfaceTint]) {
      expect(contrast(brand[4], surface), `accent ink on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
    // The light-variant ink of the brand is its 9-shade, like every hue's.
    expect(LIGHT_VARIANT_INKS.astrolabe).toBe(brand[9]);
  });

  it("success is green, never teal: the brand and success tints and fills are clearly different colours (CIEDE2000)", () => {
    const brand = theme.colors!.astrolabe!;
    const green = DEFAULT_THEME.colors.green;
    // Cyan and teal light tints are only ~8.8 apart (teal-1 vs the brand 1-shade) — that is why success left teal.
    expect(deltaE2000(brand[1], DEFAULT_THEME.colors.teal[1])).toBeLessThan(10);
    // Light variant (Alert / Badge surface = the hue's 1-shade): green is ≥ 10 from the brand.
    expect(deltaE2000(brand[1], green[1]), "light tints").toBeGreaterThanOrEqual(10);
    // Filled (primary shade 8 in the light scheme): ≥ 20.
    expect(deltaE2000(brand[8], green[8]), "filled, light scheme").toBeGreaterThanOrEqual(20);
    // …and in the dark scheme (filled shade 9; the light-variant surface is the darkened 9-shade).
    expect(deltaE2000(brand[9], green[9]), "filled, dark scheme").toBeGreaterThanOrEqual(20);
    expect(deltaE2000(darken(brand[9], 0.5), darken(green[9], 0.5)), "light variant, dark scheme").toBeGreaterThanOrEqual(5);
    // The inks (text on the tints) are far apart too.
    expect(deltaE2000(LIGHT_VARIANT_INKS.astrolabe, LIGHT_VARIANT_INKS.green), "inks").toBeGreaterThanOrEqual(20);
    // Success ink is the AA-tested green one, and teal has no entry any more.
    expect(LIGHT_VARIANT_INKS.green).toBe("#236b34");
    expect(Object.keys(LIGHT_VARIANT_INKS)).not.toContain("teal");
  });

  it("index.css paints the first-paint canvas with the same hexes as the canvas tokens", () => {
    // The bundle's CSS variables don't exist before Mantine mounts, so index.css repeats the
    // two canvas hexes literally — keep them in lockstep with themeVariables.ts.
    const match = /background-color:\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/i.exec(indexCss);
    expect(match, "index.css first-paint canvas rule").not.toBeNull();
    expect(match![1]).toBe(LIGHT_TOKENS.canvas);
    expect(match![2]).toBe(DARK_TOKENS.canvas);
  });
});
