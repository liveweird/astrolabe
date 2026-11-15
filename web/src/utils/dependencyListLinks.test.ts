import { expect, test } from "vitest";
import { dependenciesFilteredPath, dependenciesPath, violatedDependenciesPath } from "./dependencyListLinks";
import { dependencyListFilterParams, parseDependencyListFilter } from "./dependencyListFilters";

test("the bare route and a filtered one", () => {
  expect(dependenciesPath).toBe("/dependencies");
  expect(dependenciesFilteredPath({})).toBe("/dependencies");
  expect(dependenciesFilteredPath({ projectId: 5 })).toBe("/dependencies?projectId=5");
  expect(dependenciesFilteredPath({ teamId: 4 })).toBe("/dependencies?teamId=4");
});

test("the violated link, optionally narrowed, in one stable order", () => {
  expect(violatedDependenciesPath()).toBe("/dependencies?status=violated");
  expect(violatedDependenciesPath({ teamId: 4 })).toBe("/dependencies?status=violated&teamId=4");
  expect(violatedDependenciesPath({ projectId: 5 })).toBe("/dependencies?status=violated&projectId=5");
  expect(violatedDependenciesPath({ teamId: 4, projectId: 5 })).toBe("/dependencies?status=violated&teamId=4&projectId=5");
});

test("the page reads back exactly what a link wrote", () => {
  const url = new URL(violatedDependenciesPath({ teamId: 4, projectId: 5 }), "http://x");
  expect(parseDependencyListFilter(url.searchParams)).toEqual({ status: "violated", teamId: 4, projectId: 5 });
  expect(dependencyListFilterParams(parseDependencyListFilter(url.searchParams)).toString()).toBe(url.search.slice(1));
});
