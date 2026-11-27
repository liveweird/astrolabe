# Team colours

Owns: a team's colour: the palette, how a colour is assigned and stored, who edits it, the wire shape and where the SPA draws it. Not here: the registry's guards and the audit catalogue (`authorization.md`, `observability.md`), the table list (`persistence.md`), the Timeline component (`timeline.md`). Added in 1.29; the server half (V35, the teams API) and the web half (the palette, the swatch, the editor, where it shows) are below; the Timeline's `tint` and where the timelines show it are below.

## Rules

- **The palette is fixed: twelve keys, in assignment order.** `INDIGO`, `TEAL`, `LIME`, `RASPBERRY`, `GRAPE`, `PINK`, `VIOLET`, `COBALT`, `AZURE`, `LAVENDER`, `SAPPHIRE`, `GREEN` (`teams/TeamColour.kt`, the spec's `TeamColour` enum, `ck_teams_colour`: `TeamColourTest` pins the three against each other, in this order). A key is stored by name and never renamed or removed; a new colour is appended and needs a migration widening the CHECK.
- **A team always has a colour.** Every response that names a team's own record carries it (`TeamResponse`, `TeamListItem`, `TeamViewTeam`); no `null`, no "unset".
- **Sharing is allowed.** Two teams may hold one colour, the editor only hints at it. Nothing enforces distinctness, so nothing locks.
- **Colour is never the only cue.** A key names a pair of shades (light, dark) in the SPA; the team's name stays beside every mark (a hard rule for the web half).

## Assignment and storage

- **Column.** `teams.colour VARCHAR(16) NOT NULL DEFAULT 'INDIGO'` (V35), Exposed `enumerationByName<TeamColour>`. The `DEFAULT` stays on purpose: a 1.28 build rolled back onto V35 can still insert a team (it writes `INDIGO`), and the raw `INSERT`s of the tests rely on it.
- **Backfill (V35).** Existing teams get distinct colours up to twelve: numbered by `ROW_NUMBER() OVER (ORDER BY marked_as_deleted, id)` (the ACTIVE teams first, by id), key `n` of the palette, wrapping after twelve. Run once, on the rows the migration finds; a team created later never goes through it.
- **A new team.** `POST /teams` uses the request's `colour`, else `TeamColour.leastUsed` over the ACTIVE teams' colours, counted by one grouped read INSIDE the create's transaction (ties go to the earlier palette key; an unused key counts 0).
  An omitted colour is chosen under a transaction-scoped advisory lock (`TEAM_COLOUR_LOCK_KEY`, the ASCII bytes of "AstroTCl", the house idiom of `JiraBindingService`), taken before the count and released by the create's commit, so concurrent creates (the sample loader's workers) come out as even as the sequential application of `leastUsed`.
  An explicit colour takes no lock (sharing is allowed). Nothing else is held but the manager's person row `FOR SHARE`, so no order to invert.
- **An update.** `PUT /teams/{id}` writes the colour only when the body names one. It is the one field that is NOT a full replace (an omitted `managerPersonId` clears the manager; an omitted `colour` keeps the colour), because "omitted = unset" has no meaning for a field that is never unset. `updatedAt` moves on every PUT as before, so a team view's tag moves with a recolour (its tag hashes the document).
- **Who edits.** ADMIN only, through the registry's guard: `requireAdmin` BEFORE `call.receive`, so a non-admin's unknown colour stays `403`; an admin's is `400` (an enum that does not decode; the lower-case spelling is unknown too). `null` in the body is the same as omitted.
- **Audit.** `team.created` and `team.updated` carry `colour` (`observability.md` "Teams and capacity"); no new event.

## Wire

- `colour` is optional on `TeamCreateRequest` and `TeamUpdateRequest`, required on `TeamResponse`, `TeamListItem` and `TeamViewTeam` (the team page's editor prefills its full-replace PUT from the view's `team`). No other document names a team's colour: the views carry `teamId`/`teamName` and the SPA joins the colour from the one cached teams read.
- The spec spells the wire, the column and the enum `colour` (the repo's English), never `color`.

## Tests

- `TeamColourTest`: pure `leastUsed`; the enum equals the spec enum and the migration's CHECK and backfill list.
- `TeamTest`: a round trip through create, read, list and the team view; a PUT without it keeps it; unknown colour `400`, a non-admin's `403`; the audit fields. An omitted colour equals `leastUsed` of the ACTIVE teams' counts read right before the POST, and a deleted team no longer counts; six concurrent creates end with the sequential run's colours and counts (a fork runs its classes one after another on its own container, so nothing else writes a team in between).
- `ViewValidatorInputsTest`: a recolour moves the team view's tag. `MigrationChecksumTest`: V35's pin.
- `TeamColourMigrationTest`, the `PersonMigrationTest` pattern: a scratch database migrated to V34 with sixteen teams, four soft-deleted, then to V35. The active ones read the palette in id order, the deleted ones follow and wrap; the `DEFAULT`, `ck_teams_colour` (23514) and NOT NULL are exercised. Still read the backfill on a copy of real data (`pg_dump -Fc` first) before a deploy.

## Web: the palette, the swatch, the editor

- **The palette.** `utils/teamColours.ts` `TEAM_COLOURS: Record<TeamColour, {light, dark}>`, typed on the generated enum (a key the server adds fails the build), each side a Mantine `hue.shade`; `cssVariablesResolver` (`themeVariables.ts`) emits `--astrolabe-team-<key>` (lower-case) per scheme as a hex, and `teamColourVar(key)` is the `var()` reader.
  `teamColours.test.ts` recomputes from the theme: every shade >= 3:1 (WCAG 1.4.11) on the row, the canvas and the table hover in its scheme; the first eight keys >= 15 and all twelve >= 9 ΔE2000 apart; the keys equal `schema.ts`' `TeamColour`, in order.
- **The mark.** `components/TeamSwatch.tsx`: a small square, `aria-hidden`, `data-team-colour="<KEY>"` (tests read it, never the colour), no text on it, `forced-color-adjust: none` (the colour IS the information) with a `CanvasText` border under `forced-colors`.  The name always stands beside it.
- **The lookup.** `hooks/useTeamColours.ts`: team id to key over the one cached `["teams","options"]` read (`useTeamOptions` carries `colour`; a team write refreshes it).
  A team the map lacks (deleted, or the read not answered) gets a hidden placeholder of the swatch's size. The Teams table reads this map; the team page its `team.colour` (`PageHeader`'s `titleLead`).
- **The editor.** `components/TeamColourField.tsx`: a `Radio.Group` of the twelve, each a swatch with its visible name (`teams.colour.name.<KEY>`, EN and PL); under it, dimmed in a polite live region, "Also used by: A, B" (`teams.colour.sharedWith`) while another team holds the pick.
  A new team preselects `leastUsedColour` of the read teams (the server's rule) once the read has settled, and sends it; before that nothing is preselected and the body omits `colour`, so the server picks. A POST carries `colour`; a PUT only when the user changed it (the prefill is a cached read, so an untouched colour must not overwrite another admin's recolour).
- **Where it shows (C2).** A swatch before the name in the Teams table, the team page title and Home "Your teams" (not the weeks table under the Teams table, deliberately).
  A swatch whose colour is not read yet keeps its box, hidden, so the name does not shift.

## Web: the timelines (C3)

- **The `tint`.** `TimelineBarData.tint?: string`, a CSS colour (`timeline.md` "Bar tones"): the Timeline still knows nothing of teams. A page spreads `teamTint(colours, teamId)` (`utils/teamColours.ts`: `{ tint: "var(--astrolabe-team-<key>)" }`, or `{}` for an unknown or null team, so the bar stays neutral). The bar's frame sets `--timeline-bar` inline and `data-tint`; tests read `data-tint`, never the colour.
  The held bar stays cyan and the critical outline is unchanged; the focus ring gains a gap so it holds 3:1 against every fill (`teamColours.test.ts` "the focus ring of a bar", `timeline.md` "Bar tones"). Under forced colours a tinted bar keeps its team colour with a `CanvasText` border, as the swatch does (`teams.spec.ts`).
- **The project page** (`ProjectTimelineRows.tsx`, colours from `useTeamColours`): milestone bars, ghost ends with a team, and the Team cell of both (`TeamNameCell`: swatch and name, the key, so no legend). A whole-project end has no team and stays neutral, as do the summary row, the target window, the baseline and Jira bars.
- **The team page** (`TeamTimeline.tsx`): the team's own milestone bars take `view.team.colour` (the document names it, so no read is awaited); the critical chain's ghost rows take their own team's colour from the cached teams read (`chainGhostRows`; a whole-project member, a deleted team or an unanswered read stays neutral, the team's name a link in the same row). Proposal, baseline and Jira bars and the load strip stay neutral.
- **Stays neutral** (1.29): project, program and work-stream bars, the window, proposal, baseline and Jira tones, the load strip, the roadmap and programs rows. The Milestones table and swatches in proposals, deviations and the baseline comparison are not part of C3.
- **The focus ring (1.30).** A bar body's single 2 px inset accent ring measured 1.01-1.62:1 (light) and 1.04-1.88:1 (dark) against the twelve fills, 1.68 / 1.93 against the neutral bar, where WCAG 1.4.11 asks 3:1. `.timelineGrid` now declares `--timeline-ring` (`--astrolabe-accent-ink`) and `--timeline-ring-gap` (`--mantine-color-body`, the row's surface), and a focused filled (`:not([data-tone])`) or ghost (`[data-tone="ghost"]`) body adds `box-shadow: inset 0 0 0 4px var(--timeline-ring-gap)` inside the ring (the outline paints over the shadow's outer 2 px, so 2 px of gap show).
  Ring vs gap is 5.59:1 (light) / 7.81:1 (dark); for a FILLED bar, gap vs fill is the palette's own row contrast, 3.45-12.06:1 (the neutral bar 3.32 / 4.04); a ghost's faint fill has no such figure, its focus is ring vs gap. Inset on purpose (`.timelineTrack` clips, the handles sit at the edges), so a bar a few pixels wide is all ring and gap. The palette, the accent token and the cell and handle rings are unchanged.
- **Forced colours (1.30).** Under `@media (forced-colors: active)` a filled bar was not drawn (the browser paints a background Canvas, predating the tint). One block in `theme.module.css` points `--timeline-bar` and `--timeline-critical` at `CanvasText`, `--timeline-ring` at `Highlight` and `--timeline-ring-gap` at `Canvas`; a filled body gets `forced-color-adjust: none` and `border: 1px solid CanvasText`, the held bar is `Highlight`, the baseline's shadow bar `CanvasText`.
  A TINTED bar keeps its team colour (the frame's inline `--timeline-bar` beats the grid's token), like the swatch: the colour is the information, with the border and the name beside it as the other cues. Ghost, summary, proposal, window, Jira, handles, the today line, the load strip and the hatch are not part of this pass (`BACKLOG.md`).
- **Tests.** `teamColours.test.ts` "the focus ring of a bar" (every key and the neutral bar, both schemes: gap vs fill and ring vs gap >= 3:1, ring vs fill alone < 3:1), `theme.test.ts` (the ring's and the forced-colours block's CSS), e2e `teams.spec.ts` (computed structure under `emulateMedia({ forcedColors: "active" })`, never a colour). Also: `Timeline.test.tsx` ("the tint"), `ProjectTimeline.colours.test.tsx`, `TeamTimeline.chain.test.tsx` ("team colours"), `teamColours.test.ts` (`teamTint`); e2e `teams.spec.ts` (a recolour reaches the project page's bar and swatch).
