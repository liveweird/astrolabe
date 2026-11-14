import { describe, expect, test } from "vitest";
import { parseTeamLoadFilter } from "./teamLoadFilters";
import { teamLoadPath, teamLoadWarningPath } from "./teamLoadLinks";

describe("team load links", () => {
  test("the route", () => {
    expect(teamLoadPath).toBe("/team-load");
  });

  test("a warning path per kind, read back by the page's own parser", () => {
    expect(teamLoadWarningPath("overloaded")).toBe("/team-load?warning=overloaded");
    expect(teamLoadWarningPath("wip")).toBe("/team-load?warning=wip");
    expect(teamLoadWarningPath("any")).toBe("/team-load?warning=any");
    for (const warning of ["overloaded", "wip", "any"] as const) {
      expect(parseTeamLoadFilter(new URLSearchParams(teamLoadWarningPath(warning).split("?")[1]))).toEqual({ warning });
    }
  });
});
