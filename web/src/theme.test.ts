/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
// A CSS module imported with `?raw` still goes through the CSS-module plugin (a class-name proxy, not the text), so the source is read from disk (vitest runs from web/).
const themeCss = readFileSync(resolve(process.cwd(), "src/theme.module.css"), "utf8");
// The dropdown surfaces (Popover.css: white; dark-6 in the dark scheme) and the item hover Mantine paints without a `--menu-item-hover`
// (Menu.css: gray-1 / dark-4), read from the package's own stylesheets so a Mantine change fails here instead of drifting under the pins.
const popoverCss = readFileSync(resolve(process.cwd(), "node_modules/@mantine/core/styles/Popover.css"), "utf8");
const menuCss = readFileSync(resolve(process.cwd(), "node_modules/@mantine/core/styles/Menu.css"), "utf8");
const WHITE = "#ffffff";
const AA = 4.5;
const NON_TEXT = 3; // WCAG 1.4.11: a graphic that carries meaning

/** A `var(--mantine-color-…)` reference of theme.module.css resolved to a hex in one scheme (the theme's own text/dimmed tokens included). */
function resolveColor(ref: string, scheme: "light" | "dark"): string {
  const tokens = scheme === "light" ? LIGHT_TOKENS : DARK_TOKENS;
  if (ref === "var(--mantine-color-text)") return tokens.text;
  if (ref === "var(--mantine-color-dimmed)") return tokens.dimmed;
  const shade = /^var\(--mantine-color-([a-z]+)-(\d)\)$/.exec(ref);
  if (shade === null) throw new Error(`cannot resolve ${ref}`);
  return scaleOf(shade[1])[Number(shade[2])];
}

/** A timeline token declared on `.timelineGrid` as `light-dark(<var>, <var>)` or a plain `<var>`, as its light and dark hex. */
function timelineInk(name: string): { light: string; dark: string } {
  const declared = new RegExp(`--${name}:\\s*(?:light-dark\\((var\\([^)]+\\)),\\s*(var\\([^)]+\\))\\)|(var\\([^)]+\\)));`).exec(themeCss);
  if (declared === null) throw new Error(`--${name} is not a light-dark()/var() token in theme.module.css`);
  const [, light, dark, plain] = declared;
  return { light: resolveColor(light ?? plain, "light"), dark: resolveColor(dark ?? plain, "dark") };
}

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

  it("every ink used in table rows clears AA on the hover tint, and the tint stays visible against the row", () => {
    // The tint is theme-owned: `tableHover` in themeVariables.ts, applied by `table.table` in theme.module.css.
    const lightTint = LIGHT_TOKENS.tableHover;
    const darkTint = DARK_TOKENS.tableHover;
    const darkScale = (hue: string) => scaleOf(hue)[0]; // the dark scheme's light-variant ink is the hue's 0-shade
    const schemes = [
      {
        name: "light",
        tint: lightTint,
        row: WHITE, // Table's own background: --mantine-color-body
        inks: {
          text: LIGHT_TOKENS.text,
          dimmed: LIGHT_TOKENS.dimmed,
          error: LIGHT_TOKENS.error,
          inkWarning: LIGHT_TOKENS.inkWarning,
          inkError: LIGHT_TOKENS.inkError,
          accentInk: LIGHT_TOKENS.accentInk,
          redInk: LIGHT_VARIANT_INKS.red,
          orangeInk: LIGHT_VARIANT_INKS.orange,
          greenInk: LIGHT_VARIANT_INKS.green,
          grayInk: LIGHT_VARIANT_INKS.gray,
          grayOutline: scaleOf("gray")[8], // the outline Badge of Users: --mantine-color-gray-outline = gray-<primary light shade 8>
        },
      },
      {
        name: "dark",
        tint: darkTint,
        row: DEFAULT_THEME.colors.dark[7],
        inks: {
          text: DARK_TOKENS.text,
          dimmed: DARK_TOKENS.dimmed,
          error: DARK_TOKENS.error,
          inkWarning: DARK_TOKENS.inkWarning,
          inkError: DARK_TOKENS.inkError,
          accentInk: DARK_TOKENS.accentInk,
          redInk: darkScale("red"),
          orangeInk: darkScale("orange"),
          greenInk: darkScale("green"),
          grayInk: darkScale("gray"),
          grayOutline: scaleOf("gray")[5], // dark: gray-<primary dark shade 9 - 4>
        },
      },
    ];
    for (const { name, tint, row, inks } of schemes) {
      for (const [ink, hex] of Object.entries(inks)) {
        expect(contrast(hex, tint), `${name}: ${ink} ${hex} on the hover tint ${tint}`).toBeGreaterThanOrEqual(AA);
      }
      // Visible: the tint reads as a different surface from the row it replaces.
      expect(contrast(tint, row), `${name}: hover tint ${tint} against the row ${row}`).toBeGreaterThanOrEqual(1.1);
    }
  });

  it("the destructive menu item's ink clears AA on the dropdown, on its own hover tint and on Mantine's item hover", () => {
    // The dropdown surface, read from Popover.css: white in the light scheme, dark-6 in the dark one (NOT the body's dark-7).
    expect(popoverCss).toMatch(/data-mantine-color-scheme='light'\]\) \.m_38a85659 \{[^}]*background-color: var\(--mantine-color-white\)/);
    expect(popoverCss).toMatch(/data-mantine-color-scheme='dark'\]\) \.m_38a85659 \{[^}]*background-color: var\(--mantine-color-dark-6\)/);
    // Mantine's own item hover/focus (Menu.css): gray-1 / dark-4, the surface a plain item's text sits on while hovered.
    expect(menuCss).toMatch(/'light'\]\) \.m_99ac2aa1:where\(:hover[^{]*\{\s*background-color: var\(--menu-item-hover, var\(--mantine-color-gray-1\)\)/);
    expect(menuCss).toMatch(/'dark'\]\) \.m_99ac2aa1:where\(:hover[^{]*\{\s*background-color: var\(--menu-item-hover, var\(--mantine-color-dark-4\)\)/);
    const schemes = [
      { name: "light", tokens: LIGHT_TOKENS, dropdown: WHITE, itemHover: DEFAULT_THEME.colors.gray[1] },
      { name: "dark", tokens: DARK_TOKENS, dropdown: DEFAULT_THEME.colors.dark[6], itemHover: DEFAULT_THEME.colors.dark[4] },
    ];
    for (const { name, tokens, dropdown, itemHover } of schemes) {
      expect(contrast(tokens.inkError, dropdown), `${name}: destructive ink on the dropdown`).toBeGreaterThanOrEqual(AA);
      expect(contrast(tokens.destructiveHover, dropdown), `${name}: destructive hover tint against the dropdown`).toBeGreaterThanOrEqual(1.05);
      expect(contrast(tokens.inkError, tokens.destructiveHover), `${name}: destructive ink on its hover tint`).toBeGreaterThanOrEqual(AA);
      expect(contrast(tokens.text, itemHover), `${name}: a plain item's text on Mantine's item hover`).toBeGreaterThanOrEqual(AA);
    }
    // Mantine's `color="red"` ink (red-6, what the dark scheme's dropdown used to show) is the reason for the component: below AA on both.
    expect(contrast(scaleOf("red")[6], WHITE)).toBeLessThan(AA);
    expect(contrast(scaleOf("red")[6], DEFAULT_THEME.colors.dark[6])).toBeLessThan(AA);
    // Mantine's dark hover would leave the AA ink under 4.5:1: the reason the tint is a token of its own.
    expect(contrast(DARK_TOKENS.inkError, DEFAULT_THEME.colors.dark[4])).toBeLessThan(AA);
  });

  it("theme.module.css wires the destructive tokens, and the theme drops the menu's focus placeholder", () => {
    expect(themeCss).toMatch(/\.menuItemDestructive\s*\{[^}]*--menu-item-color:\s*var\(--astrolabe-ink-error\)[^}]*--menu-item-hover:\s*var\(--astrolabe-destructive-hover\)/);
    // A focus the browser does not show (the pointer opened the menu) must not tint the first item.
    expect(themeCss).toMatch(/\.menuItem:focus:not\(:focus-visible, :hover\)\s*\{[^}]*background-color:\s*transparent/);
    // axe aria-required-children: the invisible placeholder is a `role="presentation"` child of `role="menu"`.
    expect(theme.components?.Menu?.defaultProps?.withInitialFocusPlaceholder).toBe(false);
  });

  it("the timeline's bar, ghost, baseline shadow, proposal, window and warning inks are visible on the row (WCAG 1.4.11, 3:1)", () => {
    // None of these carries text (a bar's dates live in its accessible name), so the bar is a graphic: 3:1 against the row's own surface, the
    // body (white / dark-7). The ghost's outline and the summary's border are `--timeline-bar`; the baseline shadow bar is `--timeline-arrow` (dimmed);
    // the proposal's dashed outline and the critical outline are the text colour.
    const body = { light: WHITE, dark: DEFAULT_THEME.colors.dark[7] };
    for (const token of ["timeline-bar", "timeline-window-edge", "timeline-drift-edge", "timeline-overload", "timeline-violation", "timeline-arrow", "timeline-critical"]) {
      const ink = timelineInk(token);
      expect(contrast(ink.light, body.light), `light: --${token} ${ink.light} on the row`).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrast(ink.dark, body.dark), `dark: --${token} ${ink.dark} on the row`).toBeGreaterThanOrEqual(NON_TEXT);
    }
    // The proposal bar's text-colour outline and the baseline bar's dimmed fill resolve to the theme's AA tokens, not to a stock shade.
    expect(timelineInk("timeline-arrow")).toEqual({ light: LIGHT_TOKENS.dimmed, dark: DARK_TOKENS.dimmed });
    expect(timelineInk("timeline-critical")).toEqual({ light: LIGHT_TOKENS.text, dark: DARK_TOKENS.text });
    expect(themeCss).toMatch(/\.timelineBarBaseline\s*\{\s*background:\s*var\(--timeline-arrow\)/);
    expect(themeCss).toMatch(/\.timelineBarProposal\s*\{[^}]*border:\s*2px dashed var\(--mantine-color-text\)/);
    expect(themeCss).toMatch(/\.timelineBarGhost\s*\{[^}]*border:\s*1px dashed var\(--timeline-bar\)/);
  });

  it("theme.module.css applies the hover tint token to every table", () => {
    // `table.table` (not `.table`) outranks Mantine's :where() scheme defaults whatever the stylesheet order.
    expect(themeCss).toMatch(/table\.table\s*\{[^}]*--table-hover-color:\s*var\(--astrolabe-table-hover\)/);
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
