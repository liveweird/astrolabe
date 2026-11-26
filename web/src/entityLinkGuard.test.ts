/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source guard for the entity links (1.31): an entity's name is a link only through `components/EntityLink.tsx` (its destination from `entityPath`, its accessible name
 * from `common.entity.open.<kind>`), so no page hand-assembles `to={projectPath(...)}` and its siblings for a work stream, program, project, milestone, team,
 * person or login. A figure that leads to an entity's page spells `to={entityPath({ kind, id })}`. The pattern is the JSX `to` prop, read over the WHOLE file text
 * (a wrapped `to={\n projectPath(` and a `to={cond ? projectPath(x) : y}` are caught, so is a hand-written `to="/projects/7"` or a template over a route-family constant);
 * a `navigate(...)` call and a `<Navigate>` redirect are not links and are not matched.
 *
 * Allowed: a MENU ITEM (`<Menu.Item ... to={projectPath(...)}>`) - its visible text is the action ("Open project", "Edit"), not the entity's name, so it keeps its own wording and label.
 * A match is allowed only when the JSX tag it sits in is a menu item, and only in the files listed here (the files that have one).
 */
const ENTITY_PATHS = ["workStreamPath", "programPath", "projectPath", "milestonePath", "teamPath", "personPath", "editUserPath"];
const ROUTE_FAMILIES = ["projectsPath", "teamsPath", "peoplePath", "usersPath"];

/** The `to` prop whose expression (up to its closing brace) calls an entity path helper, spells a route family's constant as the root of an address (`${projectsPath}/7`; the list page itself is no entity), or whose value is a literal entity route. */
const HAND_BUILT = new RegExp(
  [
    `\\bto=\\{[^}]*?\\b(?:${ENTITY_PATHS.join("|")})\\(`,
    `\\bto=\\{\\s*\`\\$\\{(?:${ROUTE_FAMILIES.join("|")})\\}\\/`,
    "\\bto=\\{?\\s*[`\"']\\/(?:projects|teams|people|users)\\/",
  ].join("|"),
  "g",
);

/** The files whose menu items (`Menu.Item component={RouterLink} to={projectPath(...)}`) are the only hand-built entity links they hold. */
const MENU_ITEM_FILES: ReadonlySet<string> = new Set(["components/PlanProjectCells.tsx", "components/TeamTimelineMenu.tsx", "components/UserTableRow.tsx"]);

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** The `file:line` of every hand-built entity `to` prop in `text`, minus the ones inside a menu item when `menuItemsAllowed`. */
function offendersIn(text: string, file: string, menuItemsAllowed: boolean): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HAND_BUILT)) {
    const before = text.slice(0, match.index);
    const tag = [...before.matchAll(/<([A-Za-z][\w.]*)/g)].at(-1)?.[1] ?? "";
    // A `<Navigate to={projectPath(...)}>` is a redirect, not a link.
    if (tag === "Navigate" || (menuItemsAllowed && /^(?:Menu\.Item|DestructiveMenuItem)$/.test(tag))) continue;
    found.push(`${file}:${before.split("\n").length}`);
  }
  return found;
}

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) found.push(relative(SRC_ROOT, full).split(sep).join("/"));
    }
  };
  walk(SRC_ROOT);
  return found;
}

describe("entity links", () => {
  const files = sources();

  it("the pattern matches every way of hand-building an entity link (a positive control)", () => {
    const samples = [
      "<Anchor component={RouterLink} to={projectPath(project.id)}>",
      "<Anchor to={\n  teamPath(team.id)\n}>",
      "<Anchor to={ready ? personPath(id) : peoplePath}>",
      "<Anchor to={`${projectsPath}/${id}`}>",
      "<Anchor to={`/teams/${id}`}>",
      '<Anchor to="/projects/7">',
      "<Menu.Item to={editUserPath(user.id)}>",
    ];
    for (const sample of samples) expect(offendersIn(sample, "sample.tsx", false), sample).toHaveLength(1);
  });

  it("the pattern leaves the legitimate forms alone", () => {
    const fine = [
      "<Anchor to={entityPath({ kind: 'team', id })}>",
      "<Anchor to={roadmapOverviewPath}>",
      "<Button to={usersPath}>",
      "<Anchor to={row.to}>",
      "<Navigate to={projectPath(remembered)} replace />",
      "<Menu.Item component={RouterLink} to={projectPath(id)} leftSection={<Icon />}>",
    ];
    for (const sample of fine) expect(offendersIn(sample, "sample.tsx", true), sample).toEqual([]);
    // A menu item is allowed only where the file says so, and only the menu item.
    expect(offendersIn("<Menu.Item to={projectPath(id)}>", "x.tsx", false)).toHaveLength(1);
    expect(offendersIn("<Anchor to={projectPath(id)}>", "x.tsx", true)).toHaveLength(1);
  });

  it("no page hand-builds an entity's link outside EntityLink and the menu items", () => {
    expect(files.length, "expected the web sources").toBeGreaterThan(100);
    const offenders = files
      .filter((file) => file !== "components/EntityLink.tsx" && !file.startsWith("test/"))
      .flatMap((file) => offendersIn(readFileSync(join(SRC_ROOT, file), "utf8"), file, MENU_ITEM_FILES.has(file)));
    expect(offenders, "use <EntityLink> (a name) or to={entityPath(...)} (a figure)").toEqual([]);
  });

  it("the menu-item allow-list holds only files that exist and still have a menu item that needs it", () => {
    for (const file of MENU_ITEM_FILES) {
      expect(files, `${file} is listed but gone`).toContain(file);
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(offendersIn(text, file, false).length, `${file} has no hand-built menu item any more: delist it`).toBeGreaterThan(0);
    }
  });
});
