/**
 * Chart colours (telemetry trend charts today; the v0.3 timeline will add its own vocabulary here).
 *
 * The categorical palette: the colour of the Nth line of a chart whose series are arbitrary NAMES (a process role, a database
 * schema). Such a name must not wear a colour that MEANS something (green = success, orange = warning, red = blocking), so those
 * three hues are excluded, and so is the stock `cyan` (it is the brand's hue, `astrolabe`). Each entry is the ONE shade of its hue
 * that clears 3:1 on all four chart surfaces, so there is no per-scheme pair. Series are coloured by position
 * (`palette[index % length]`), and the order maximises the CIEDE2000 distance between NEIGHBOURS (dataviz floor ≥ 15).
 * `chartColors.test.ts` recomputes every ratio and distance from the theme (white / canvas | dark paper / dark canvas | ΔE to the
 * next entry):
 *
 *   astrolabe.6  3.43 / 3.20 | 3.96 / 4.80   ΔE 30.4
 *   violet.5     4.26 / 3.98 | 3.18 / 3.87   ΔE 29.4
 *   pink.6       3.73 / 3.48 | 3.64 / 4.42   ΔE 35.4
 *   indigo.5     3.67 / 3.42 | 3.70 / 4.49   ΔE 17.5
 *   gray.6       3.32 / 3.10 | 4.09 / 4.96   ΔE (to the first entry again)
 *
 * Five is all the passing hues give, so from the 6th series on the first colour repeats: a chart on this palette still carries
 * identity without colour through the legend and the table beside the chart.
 */
export const CATEGORY_PALETTE: ReadonlyArray<string> = ["astrolabe.6", "violet.5", "pink.6", "indigo.5", "gray.6"];
