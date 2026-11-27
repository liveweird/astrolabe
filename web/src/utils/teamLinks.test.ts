import { describe, expect, test } from "vitest";
import { teamPath, teamsPath, teamsWarningPath } from "./teamLinks";
import { parseTeamLoadFilter } from "./teamLoadFilters";

describe("teamLinks", () => {
  test("builds the list and detail paths", () => {
    expect(teamsPath).toBe("/teams");
    expect(teamPath(7)).toBe("/teams/7");
  });

  test("the warning path is the list with ?warning=, in the words the page reads back", () => {
    expect(teamsWarningPath("overloaded")).toBe("/teams?warning=overloaded");
    expect(teamsWarningPath("wip")).toBe("/teams?warning=wip");
    expect(teamsWarningPath("any")).toBe("/teams?warning=any");
    for (const warning of ["overloaded", "wip", "any"] as const) {
      expect(parseTeamLoadFilter(new URLSearchParams(teamsWarningPath(warning).split("?")[1]))).toEqual({ warning });
    }
  });
});
