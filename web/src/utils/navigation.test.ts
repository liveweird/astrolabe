import { describe, expect, test } from "vitest";
import { ACCOUNT_NAV, activeNavPath, homePath, visibleSections } from "./navigation";

describe("visibleSections", () => {
  test("a regular session sees Overview, Planning and Administration — Plan, Roadmap, Programs, Teams, People and Public holidays stay, the admin-only leaves drop", () => {
    const sections = visibleSections(false);
    expect(sections.map((s) => s.label)).toEqual(["appShell.section.overview", "appShell.section.planning", "appShell.section.administration"]);
    const paths = sections.flatMap((s) => s.items.map((l) => l.to));
    expect(paths).toEqual(["/", "/plan", "/roadmap", "/programs", "/teams", "/people", "/public-holidays"]);
  });

  test("an admin session gets Teams, People, Public holidays, Users and Feature flags in the Administration section", () => {
    const admin = visibleSections(true).find((s) => s.label === "appShell.section.administration");
    expect(admin?.items.map((l) => l.to)).toEqual(["/teams", "/people", "/public-holidays", "/users", "/feature-flags"]);
  });

  test("Planning sits above Administration and holds the Plan, Roadmap and Programs leaves for everyone", () => {
    for (const admin of [false, true]) {
      const labels = visibleSections(admin).map((s) => s.label);
      expect(labels.indexOf("appShell.section.planning")).toBeLessThan(labels.indexOf("appShell.section.administration"));
      const planning = visibleSections(admin).find((s) => s.label === "appShell.section.planning");
      expect(planning?.items.map((l) => l.to)).toEqual(["/plan", "/roadmap", "/programs"]);
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
    expect(activeNavPath("/users/3/edit", leaves)).toBe("/users");
    expect(activeNavPath("/feature-flags", leaves)).toBe("/feature-flags");
    expect(activeNavPath("/teams/3", leaves)).toBe("/teams");
    expect(activeNavPath("/people/3", leaves)).toBe("/people");
    expect(activeNavPath("/public-holidays", leaves)).toBe("/public-holidays");
    expect(activeNavPath("/plan", leaves)).toBe("/plan");
    expect(activeNavPath("/roadmap", leaves)).toBe("/roadmap");
    expect(activeNavPath("/programs", leaves)).toBe("/programs");
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
