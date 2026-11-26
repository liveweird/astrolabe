import { describe, expect, test } from "vitest";
import { ACCOUNT_NAV, activeNavPath, homePath, visibleSections } from "./navigation";

describe("visibleSections", () => {
  test("a regular session sees the planning, team and integration pages without administrative controls", () => {
    const sections = visibleSections(false);
    expect(sections.map((s) => s.label)).toEqual(["appShell.section.overview", "appShell.section.planning", "appShell.section.teams", "appShell.section.integrations"]);
    const paths = sections.flatMap((s) => s.items.map((l) => l.to));
    expect(paths).toEqual(["/", "/plan", "/roadmap", "/projects", "/milestones", "/dependencies", "/baselines", "/teams", "/team-load", "/schedule-proposals", "/people", "/public-holidays", "/deviations"]);
  });

  test("an admin session gets account controls under Administration and connection settings under Integrations", () => {
    const admin = visibleSections(true).find((s) => s.label === "appShell.section.administration");
    expect(admin?.items.map((l) => l.to)).toEqual(["/users", "/feature-flags"]);
    const integrations = visibleSections(true).find((s) => s.label === "appShell.section.integrations");
    expect(integrations?.items.map((l) => l.to)).toEqual(["/deviations", "/integrations/jira", "/integrations/flow"]);
    // The Jira and Flow leaves are ADMIN only: a regular session never sees them (the routes sit under RequireAdmin too).
    const regular = visibleSections(false).flatMap((s) => s.items.map((l) => l.to));
    expect(regular).not.toContain("/integrations/jira");
    expect(regular).not.toContain("/integrations/flow");
  });

  test("the Projects leaf sits after the Roadmap and is findable in the palette by its old words", () => {
    const projects = visibleSections(false).flatMap((s) => s.items).find((l) => l.to === "/projects");
    expect(projects?.label).toBe("appShell.nav.projects");
    expect(projects?.keywords).toEqual(["project", "milestones", "kamienie milowe"]);
  });

  test("the Roadmap leaf is findable in the palette by the words of its two modes and of the retired Programs page", () => {
    const roadmap = visibleSections(false).flatMap((s) => s.items).find((l) => l.to === "/roadmap");
    expect(roadmap?.label).toBe("appShell.nav.roadmap");
    expect(roadmap?.keywords).toEqual(["programs", "programy", "overview", "prioritization", "rank"]);
  });

  test("the Flow leaf is findable in the palette by what it is for: flow, capacity, roster", () => {
    const flow = visibleSections(true).flatMap((s) => s.items).find((l) => l.to === "/integrations/flow");
    expect(flow?.label).toBe("appShell.nav.flow");
    expect(flow?.keywords).toEqual(["flow", "capacity", "roster"]);
  });

  test("Planning groups plan views and lists for every role", () => {
    for (const admin of [false, true]) {
      const planning = visibleSections(admin).find((s) => s.label === "appShell.section.planning");
      expect(planning?.items.map((l) => l.to)).toEqual(["/plan", "/roadmap", "/projects", "/milestones", "/dependencies", "/baselines"]);
    }
  });

  test("the account leaves never sit in a section", () => {
    const sectionPaths = visibleSections(true).flatMap((s) => s.items.map((l) => l.to));
    for (const leaf of ACCOUNT_NAV) expect(sectionPaths).not.toContain(leaf.to);
    expect(ACCOUNT_NAV.map((l) => l.to)).toEqual(["/change-password", "/changelog"]);
  });
});

describe("activeNavPath", () => {
  const leaves = visibleSections(true).flatMap((s) => s.items);

  test("resolves the longest matching prefix", () => {
    expect(activeNavPath("/users/new", leaves)).toBe("/users");
    expect(activeNavPath("/integrations/jira/3", leaves)).toBe("/integrations/jira");
    expect(activeNavPath("/integrations/flow/3", leaves)).toBe("/integrations/flow");
    expect(activeNavPath("/users/3/edit", leaves)).toBe("/users");
    expect(activeNavPath("/feature-flags", leaves)).toBe("/feature-flags");
    expect(activeNavPath("/teams/3", leaves)).toBe("/teams");
    expect(activeNavPath("/people/3", leaves)).toBe("/people");
    expect(activeNavPath("/public-holidays", leaves)).toBe("/public-holidays");
    expect(activeNavPath("/plan", leaves)).toBe("/plan");
    // A project's page is the Projects leaf's (Plan's `activeFor` was dropped: the two would tie on length 9).
    expect(activeNavPath("/projects", leaves)).toBe("/projects");
    expect(activeNavPath("/projects/42", leaves)).toBe("/projects");
    expect(activeNavPath("/roadmap", leaves)).toBe("/roadmap");
    // The old address redirects (LegacyRedirect); no leaf answers for it.
    expect(activeNavPath("/programs", leaves)).toBeNull();
    expect(activeNavPath("/milestones", leaves)).toBe("/milestones");
  });

  test("a leaf stays highlighted on every route it lists in activeFor, and still links to its own", () => {
    const custom = [
      { to: "/a", label: "appShell.nav.home", icon: leaves[0].icon, activeFor: ["/b/deep"] },
      { to: "/b", label: "appShell.nav.home", icon: leaves[0].icon },
    ] as const;
    // The longest match still wins across leaves.
    expect(activeNavPath("/b/deep/x", custom)).toBe("/a");
    expect(activeNavPath("/b/other", custom)).toBe("/b");
  });

  test("the root matches only exactly", () => {
    expect(activeNavPath(homePath, leaves)).toBe("/");
    expect(activeNavPath("/nowhere", leaves)).toBeNull();
  });
});
