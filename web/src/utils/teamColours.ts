import type { MantineColorsTuple } from "@mantine/core";
import type { components } from "../api/schema";

/** A team's colour key, as the server stores it (`teams.colour`, the spec's `TeamColour`). */
export type TeamColour = components["schemas"]["TeamColour"];

/**
 * The team palette (1.29, `.claude/docs/team-colours.md`): twelve fixed keys in ASSIGNMENT order, each a light and a dark shade written as
 * `hue.shade` of Mantine's own tuples. Typed on the generated enum, so a key the server adds fails the build here until it is drawn.
 * `teamColours.test.ts` recomputes every figure from the theme: each shade clears 3:1 (WCAG 1.4.11) on the table row, the canvas and the
 * table hover of its scheme, and the keys equal the spec's enum, in order. The keys are persisted: never renamed or removed.
 * A mark of a team colour never carries text (`TeamSwatch`), and the team's name always stands beside it.
 */
export const TEAM_COLOURS: Record<TeamColour, { light: string; dark: string }> = {
  INDIGO: { light: "indigo.5", dark: "indigo.5" },
  TEAL: { light: "teal.8", dark: "teal.4" },
  LIME: { light: "lime.9", dark: "lime.3" },
  RASPBERRY: { light: "pink.9", dark: "pink.6" },
  GRAPE: { light: "grape.6", dark: "grape.4" },
  PINK: { light: "pink.6", dark: "pink.3" },
  VIOLET: { light: "violet.8", dark: "violet.2" },
  COBALT: { light: "blue.9", dark: "blue.2" },
  AZURE: { light: "blue.6", dark: "blue.4" },
  LAVENDER: { light: "violet.5", dark: "violet.3" },
  SAPPHIRE: { light: "indigo.8", dark: "indigo.3" },
  GREEN: { light: "green.8", dark: "green.2" },
};

/** The keys in palette (assignment) order: object keys keep their insertion order. */
export const TEAM_COLOUR_KEYS = Object.keys(TEAM_COLOURS) as TeamColour[];

type Scheme = "light" | "dark";

/** `"indigo.5"` → the hex, out of the theme's colour tuples (Mantine's own plus the app's). */
export function teamColourHex(shade: string, colors: Readonly<Record<string, MantineColorsTuple>>): string {
  const [hue, index] = shade.split(".");
  const tuple = colors[hue] as MantineColorsTuple | undefined;
  if (tuple === undefined) throw new Error(`no colour tuple named ${hue}`);
  return tuple[Number(index)];
}

/** The CSS custom property of one key, `--astrolabe-team-indigo`: the one name `TeamSwatch` and the timelines read. */
const variableName = (colour: TeamColour) => `--astrolabe-team-${colour.toLowerCase()}`;

/** The `cssVariablesResolver` entries of one scheme: every key's variable, as a hex. */
export function teamColourVariables(scheme: Scheme, colors: Readonly<Record<string, MantineColorsTuple>>): Record<string, string> {
  return Object.fromEntries(TEAM_COLOUR_KEYS.map((colour) => [variableName(colour), teamColourHex(TEAM_COLOURS[colour][scheme], colors)]));
}

/** A CSS colour value for one key (`var(--astrolabe-team-indigo)`), resolved per scheme by the browser. */
export function teamColourVar(colour: TeamColour): string {
  return `var(${variableName(colour)})`;
}

/**
 * The colour a NEW team starts with: the key the fewest of `used` hold, a tie going to the earlier palette key, an unused key counting 0 (the
 * server's `TeamColour.leastUsed`, the same rule, so the editor shows what an omitted colour would get).
 */
export function leastUsedColour(used: readonly TeamColour[]): TeamColour {
  const count = (colour: TeamColour) => used.filter((other) => other === colour).length;
  return TEAM_COLOUR_KEYS.reduce((best, colour) => (count(colour) < count(best) ? colour : best));
}
