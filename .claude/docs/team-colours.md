# Team colours

Owns: a team's colour: the palette, how a colour is assigned and stored, who edits it, the wire shape and where the SPA draws it. Not here: the registry's guards and the audit catalogue (`authorization.md`, `observability.md`), the table list (`persistence.md`), the Timeline component (`timeline.md`). Added in 1.29; the server half (V35, the teams API) is below, the web half is added with the steps that build it.

## Rules

- **The palette is fixed: twelve keys, in assignment order.** `INDIGO`, `TEAL`, `LIME`, `RASPBERRY`, `GRAPE`, `PINK`, `VIOLET`, `COBALT`, `AZURE`, `LAVENDER`, `SAPPHIRE`, `GREEN` (`teams/TeamColour.kt`, the spec's `TeamColour` enum, `ck_teams_colour`: `TeamColourTest` pins the three against each other, in this order). A key is stored by name and never renamed or removed; a new colour is appended and needs a migration widening the CHECK.
- **A team always has a colour.** Every response that names a team's own record carries it (`TeamResponse`, `TeamListItem`, `TeamViewTeam`); no `null`, no "unset".
- **Sharing is allowed.** Two teams may hold one colour, the editor only hints at it. Nothing enforces distinctness, so nothing locks.
- **Colour is never the only cue.** A key names a pair of shades (light, dark) in the SPA; the team's name stays beside every mark (a hard rule for the web half).

## Assignment and storage

- **Column.** `teams.colour VARCHAR(16) NOT NULL DEFAULT 'INDIGO'` (V35), Exposed `enumerationByName<TeamColour>`. The `DEFAULT` stays on purpose: a 1.28 build rolled back onto V35 can still insert a team (it writes `INDIGO`), and the raw `INSERT`s of the tests rely on it.
- **Backfill (V35).** Existing teams get distinct colours up to twelve: numbered by `ROW_NUMBER() OVER (ORDER BY marked_as_deleted, id)` (the ACTIVE teams first, by id), key `n` of the palette, wrapping after twelve. Run once, on the rows the migration finds; a team created later never goes through it.
- **A new team.** `POST /teams` uses the request's `colour`, else `TeamColour.leastUsed` over the ACTIVE teams' colours, counted by one grouped read INSIDE the create's transaction (ties go to the earlier palette key; an unused key counts 0). No lock: two creates racing may pick the same key, which sharing allows.
- **An update.** `PUT /teams/{id}` writes the colour only when the body names one. It is the one field that is NOT a full replace (an omitted `managerPersonId` clears the manager; an omitted `colour` keeps the colour), because "omitted = unset" has no meaning for a field that is never unset. `updatedAt` moves on every PUT as before, so a team view's tag moves with a recolour (its tag hashes the document).
- **Who edits.** ADMIN only, through the registry's guard: `requireAdmin` BEFORE `call.receive`, so a non-admin's unknown colour stays `403`; an admin's is `400` (an enum that does not decode; the lower-case spelling is unknown too). `null` in the body is the same as omitted.
- **Audit.** `team.created` and `team.updated` carry `colour` (`observability.md` "Teams and capacity"); no new event.

## Wire

- `colour` is optional on `TeamCreateRequest` and `TeamUpdateRequest`, required on `TeamResponse`, `TeamListItem` and `TeamViewTeam` (the team page's editor prefills its full-replace PUT from the view's `team`). No other document names a team's colour: the views carry `teamId`/`teamName` and the SPA joins the colour from the one cached teams read.
- The spec spells the wire, the column and the enum `colour` (the repo's English), never `color`.

## Tests

- `TeamColourTest`: pure `leastUsed`; the enum equals the spec enum and the migration's CHECK and backfill list.
- `TeamTest`: a round trip through create, read, list and the team view; a PUT without it keeps it; unknown colour `400`, a non-admin's `403`; the audit fields. An omitted colour equals `leastUsed` of the ACTIVE teams' counts read right before the POST, and a deleted team no longer counts (a fork runs its classes one after another on its own container, so nothing else writes a team in between).
- `ViewValidatorInputsTest`: a recolour moves the team view's tag. `MigrationChecksumTest`: V35's pin.
- `TeamColourMigrationTest`, the `PersonMigrationTest` pattern: a scratch database migrated to V34 with sixteen teams, four soft-deleted, then to V35. The active ones read the palette in id order, the deleted ones follow and wrap; the `DEFAULT`, `ck_teams_colour` (23514) and NOT NULL are exercised. Still read the backfill on a copy of real data (`pg_dump -Fc` first) before a deploy.
