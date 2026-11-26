import { expect, test } from "vitest";
import { dependenciesFilteredPath, violatedDependenciesPath } from "./dependencyListLinks";
import { namesPanel, PANEL_PARAMS, parseDependencyListFilter } from "./dependencyListFilters";

test("a link opens the Roadmap's panel, naming no mode; the status word is always written", () => {
  expect(dependenciesFilteredPath({})).toBe("/roadmap?dependencies=all");
  expect(dependenciesFilteredPath({ projectId: 5 })).toBe("/roadmap?dependencies=all&dependencyProjectId=5");
  expect(dependenciesFilteredPath({ teamId: 4 })).toBe("/roadmap?dependencies=all&dependencyTeamId=4");
});

test("the violated link, optionally narrowed, in one stable order", () => {
  expect(violatedDependenciesPath()).toBe("/roadmap?dependencies=violated");
  expect(violatedDependenciesPath({ teamId: 4 })).toBe("/roadmap?dependencies=violated&dependencyTeamId=4");
  expect(violatedDependenciesPath({ projectId: 5 })).toBe("/roadmap?dependencies=violated&dependencyProjectId=5");
  expect(violatedDependenciesPath({ teamId: 4, projectId: 5 })).toBe("/roadmap?dependencies=violated&dependencyTeamId=4&dependencyProjectId=5");
});

test("the panel reads back exactly what a link wrote, and is named by it", () => {
  const url = new URL(violatedDependenciesPath({ teamId: 4, projectId: 5 }), "http://x");
  expect(namesPanel(url.searchParams)).toBe(true);
  expect(parseDependencyListFilter(url.searchParams, PANEL_PARAMS)).toEqual({ status: "violated", teamId: 4, projectId: 5 });
  expect(namesPanel(new URL(dependenciesFilteredPath({}), "http://x").searchParams)).toBe(true);
});
