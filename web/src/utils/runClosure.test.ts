import { describe, expect, test } from "vitest";
import { upstreamTeamIds } from "./runClosure";

const link = (predecessorProjectId: number, successorProjectId: number) => ({ predecessorProjectId, successorProjectId });
const project = (id: number, ...teamIds: number[]) => ({ id, teamIds });

describe("upstreamTeamIds", () => {
  test("walks the whole chain, nearest first: the direct predecessor's teams before the predecessor's predecessor's", () => {
    // 1 waits on 2, which waits on 3, which waits on 4.
    const links = [link(3, 2), link(4, 3), link(2, 1)];
    const projects = [project(1, 10), project(2, 20, 21), project(3, 30), project(4, 40)];
    expect(upstreamTeamIds(links, projects, [1], 50)).toEqual({ ids: [20, 21, 30, 40], cut: false });
  });

  test("is nearest first whatever order the links and projects are listed in; one distance is taken by project id", () => {
    const links = [link(9, 5), link(5, 1), link(7, 1), link(8, 7)];
    const projects = [project(8, 80), project(9, 90), project(7, 70), project(5, 50), project(1, 10)];
    expect(upstreamTeamIds(links, projects, [1], 50).ids).toEqual([50, 70, 80, 90]);
    expect(upstreamTeamIds([...links].reverse(), [...projects].reverse(), [1], 50).ids).toEqual([50, 70, 80, 90]);
  });

  test("never walks downstream: a project that waits on the start is not in the closure", () => {
    expect(upstreamTeamIds([link(1, 2), link(3, 1)], [project(1, 10), project(2, 20), project(3, 30)], [1], 50)).toEqual({ ids: [30], cut: false });
  });

  test("is cycle-safe: a loop through the start, and a loop upstream, each end", () => {
    // 1 <- 2 <- 3 <- 1 (back to the start), and 3 <- 4 <- 3 (a loop of its own).
    const links = [link(2, 1), link(3, 2), link(1, 3), link(4, 3), link(3, 4)];
    const projects = [project(1, 10), project(2, 20), project(3, 30), project(4, 40)];
    expect(upstreamTeamIds(links, projects, [1], 50)).toEqual({ ids: [20, 30, 40], cut: false });
  });

  test("a diamond is walked once: a team of a shared project is returned once", () => {
    const links = [link(2, 1), link(3, 1), link(4, 2), link(4, 3)];
    const projects = [project(1, 10), project(2, 20), project(3, 20, 30), project(4, 40, 20)];
    expect(upstreamTeamIds(links, projects, [1], 50).ids).toEqual([20, 30, 40]);
  });

  test("teams already in the set are not returned again, and count toward the bound", () => {
    const links = [link(2, 1), link(3, 2)];
    const projects = [project(2, 20, 10), project(3, 30)];
    expect(upstreamTeamIds(links, projects, [1], 50, [10, 11])).toEqual({ ids: [20, 30], cut: false });
    // 2 held + 1 new fits 3; the next project's team would make 4.
    expect(upstreamTeamIds(links, projects, [1], 3, [10, 11])).toEqual({ ids: [20], cut: true });
  });

  test("a project with no teams adds nothing and the walk goes on through it; a project the document lacks is walked too", () => {
    const links = [link(2, 1), link(3, 2), link(4, 3)];
    expect(upstreamTeamIds(links, [project(1, 10), project(2), project(4, 40)], [1], 50)).toEqual({ ids: [40], cut: false });
  });

  test("nothing upstream, or only projects with no new teams, is an empty answer with no cut", () => {
    expect(upstreamTeamIds([], [project(1, 10)], [1], 50)).toEqual({ ids: [], cut: false });
    expect(upstreamTeamIds([link(2, 1)], [project(2, 10)], [1], 50, [10])).toEqual({ ids: [], cut: false });
    expect(upstreamTeamIds([link(2, 1)], [project(2)], [1], 1, [10, 11])).toEqual({ ids: [], cut: false });
  });

  test("stops BEFORE the project that would pass the bound, whole projects only: never a partial project, never a skip to a smaller one further out", () => {
    const links = [link(2, 1), link(3, 2), link(4, 3)];
    // 2 takes one team (1 held + 1 = 2), 3 would take two more (4 > 3): stop, though 4's single team would fit.
    const projects = [project(2, 20), project(3, 30, 31), project(4, 40)];
    expect(upstreamTeamIds(links, projects, [1], 3, [10])).toEqual({ ids: [20], cut: true });
  });

  test("reaches the bound exactly without a cut; one over is the cut", () => {
    const links = [link(2, 1)];
    const projects = [project(2, 20, 21)];
    expect(upstreamTeamIds(links, projects, [1], 3, [10])).toEqual({ ids: [20, 21], cut: false });
    expect(upstreamTeamIds(links, projects, [1], 2, [10])).toEqual({ ids: [], cut: true });
  });

  test("a start set of several projects walks them together", () => {
    const links = [link(3, 1), link(4, 2)];
    expect(upstreamTeamIds(links, [project(3, 30), project(4, 40)], [1, 2], 50).ids).toEqual([30, 40]);
  });
});
