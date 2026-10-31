import { ActionIcon, Anchor, AppShell, Autocomplete, Badge, Chip, Code, createTheme, Fieldset, Menu, Modal, MultiSelect, NavLink, Select, Table, TagsInput, Tooltip, type MantineColorsTuple } from "@mantine/core";
import classes from "./theme.module.css";
import { foldedOptionsFilter } from "./utils/text";

// "Astrolabe" brand palette = deep CYAN — Mantine's stock cyan scale shifted one step deeper
// (light → dark, indices 0–9; the 9-shade #095c6b is new). Contrast pins (theme.test.ts): white
// on 8 5.6:1, white on 9 7.6:1, 4 on dark-8 8.3:1. Mantine's own shade 7/8 pair falls short of
// 4.5:1 for white text on this hue, so the primary shades sit one step deeper (8/9, not 7/8) —
// same primaryShade/autoContrast mechanism, just the pair that actually clears AA on this hue.
// Cyan and teal tints are near-identical, so SUCCESS is green (see the design-language note below).
const astrolabe: MantineColorsTuple = [
  "#e3fafc",
  "#c5f6fa",
  "#99e9f2",
  "#66d9e8",
  "#3bc9db", // accent ink in the dark scheme (--astrolabe-accent-ink)
  "#15aabf",
  "#1098ad",
  "#0c8599",
  "#0b7285", // primary (light scheme); accent ink in the light scheme
  "#095c6b", // primary (dark scheme); light-variant ink
];

// Inter is bundled (via @fontsource-variable/inter, imported in main.tsx) so it loads same-origin
// and satisfies the CSP `font-src 'self'`; the system stack is the fallback (e.g. in tests).
const sans =
  "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Design language (the Lettuce/Toadie "clean enterprise SaaS" posture): the brand cyan is
// the interactive accent — primary CTAs, the active nav item, focus — and NOTHING else: links
// are dark text with a hover underline, chips and badges are light tints, icon controls are
// neutral gray. One colour at one intensity for one job, so the few cyan elements on a
// screen are the ones that matter. Semantic colours never impersonate the brand: red =
// blocking error, orange = warning (soft finding, waived), GREEN = success — never teal, whose
// light tint is indistinguishable from the cyan brand's (theme.test.ts pins the CIEDE2000
// distance between the brand and success tints and fills). The canvas is a quiet near-white
// (dark: dark-8) that lets white surfaces lift on a soft, diffuse shadow scale. A
// filled 9-shade carries white text in the dark scheme, but is too dark to be SEEN against
// dark-8 — every place the hue itself must read on the dark canvas (nav marker, hover
// underline, focus) goes through `--astrolabe-accent-ink` (themeVariables.ts), which flips to the
// 4-shade there.
export const theme = createTheme({
  primaryColor: "astrolabe",
  // Shade 8 in light mode — one step deeper than Mantine's stock cyan 7, which falls short of
  // 4.5:1 for white CTA text (see the pins above).
  primaryShade: { light: 8, dark: 9 },
  // Pick readable text color on filled brand surfaces automatically.
  autoContrast: true,
  // Mantine transitions and animations (Modal, Menu, Collapse, Loader…) stand still under the OS
  // "reduce motion" preference — off by default in Mantine, so it is opted into here (WCAG 2.3.3).
  respectReducedMotion: true,
  defaultRadius: "md",
  colors: { astrolabe },
  fontFamily: sans,
  headings: {
    fontFamily: sans,
    fontWeight: "600",
    // Tighter than Mantine's defaults — pages title themselves with order={2}, and the
    // stock 1.625rem reads oversized next to 14-px body text.
    sizes: {
      h1: { fontSize: "1.625rem", lineHeight: "1.3" },
      h2: { fontSize: "1.3rem", lineHeight: "1.35" },
      h3: { fontSize: "1.125rem", lineHeight: "1.4" },
    },
  },
  // Soft, diffuse elevation (the modern-SaaS ambient look) — every `shadow="sm"` Paper picks
  // this up with zero call-site changes.
  shadows: {
    xs: "0 1px 2px rgba(16, 24, 40, 0.04)",
    sm: "0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.07)",
    md: "0 4px 8px -2px rgba(16, 24, 40, 0.08), 0 2px 4px -2px rgba(16, 24, 40, 0.06)",
    lg: "0 12px 16px -4px rgba(16, 24, 40, 0.1), 0 4px 6px -2px rgba(16, 24, 40, 0.05)",
    xl: "0 20px 24px -4px rgba(16, 24, 40, 0.1), 0 8px 8px -4px rgba(16, 24, 40, 0.04)",
  },
  components: {
    // Every data table in the app: a card-like frame on the quiet canvas, hoverable rows,
    // and a neutral, compact header row (see theme.module.css). New tables inherit all of it.
    // verticalSpacing xs (10px) + 14px/1.55 text = ~40px rows: the density of a data grid,
    // not a marketing table. Pages never pass a spacing of their own.
    Table: Table.extend({
      defaultProps: { highlightOnHover: true, verticalSpacing: "xs", horizontalSpacing: "md", fz: "sm" },
      classNames: { table: classes.table, thead: classes.tableHead },
    }),
    // The shell surfaces: white header/navbar over a tinted main canvas, crisp separators.
    AppShell: AppShell.extend({
      classNames: {
        main: classes.appMain,
        header: classes.appHeader,
        navbar: classes.appNavbar,
      },
    }),
    NavLink: NavLink.extend({ classNames: { root: classes.navLink, section: classes.navLinkSection } }),
    // Links are text-coloured and underline on hover — the accent is reserved for actions.
    Anchor: Anchor.extend({ defaultProps: { underline: "hover" }, classNames: { root: classes.anchor } }),
    // Filter chips (types, lifecycles, finding severities) are toggles, not calls to action: a
    // light tint when checked, never the filled brand colour.
    Chip: Chip.extend({ defaultProps: { variant: "light" } }),
    // Icon-only controls (row kebabs, edit/delete, tree toggles) are neutral by default;
    // a destructive one passes color="red" explicitly.
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: "subtle", color: "gray" } }),
    Menu: Menu.extend({ defaultProps: { position: "bottom-end", withinPortal: true, shadow: "md" } }),
    // Every searchable Select/MultiSelect/TagsInput matches accent-insensitively ("zolw" finds
    // "Żółw"), mirroring the server-side unaccent list filters. A per-site `filter` prop still
    // wins — don't pass one unless it preserves the diacritics folding (see utils/text.ts).
    Select: Select.extend({ defaultProps: { filter: foldedOptionsFilter } }),
    Autocomplete: Autocomplete.extend({ defaultProps: { filter: foldedOptionsFilter } }),
    MultiSelect: MultiSelect.extend({ defaultProps: { filter: foldedOptionsFilter } }),
    TagsInput: TagsInput.extend({ defaultProps: { filter: foldedOptionsFilter } }),
    Badge: Badge.extend({ defaultProps: { radius: "sm", variant: "light" } }),
    // Form sections (contract and registry forms): flat, headed by a small caps
    // legend over a hairline — the fieldset/legend semantics stay, the boxes go.
    Fieldset: Fieldset.extend({
      defaultProps: { variant: "unstyled" },
      classNames: { root: classes.formSection, legend: classes.formSectionLegend },
    }),
    Tooltip: Tooltip.extend({ defaultProps: { radius: "md" } }),
    Modal: Modal.extend({ defaultProps: { radius: "md" } }),
    // Mantine's Code root scrolls (`overflow: auto`), so a long finding code or schema value in a
    // narrow flex item becomes a scroll region with no keyboard access (axe
    // scrollable-region-focusable, found by the e2e sweep). Code here is read, never scrolled: wrap it.
    Code: Code.extend({ styles: { root: { overflow: "visible", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } }),
  },
});
