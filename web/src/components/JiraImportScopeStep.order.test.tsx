import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { jsonResponse } from "../test/http";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { installImportApi } from "../test/jiraImportHarness";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The scope step lists the plan's work streams, programs and projects as pickers: the plan view comes in the SHARED order (a hand arrangement
// of the Plan page: here a closed stream first, Zulu before alpha, Yak before Ant), and the pickers sort explicitly, never by that order.
const ARRANGED = planOf(
  [
    { id: 1, name: "Aardvark", endDate: "2026-06-30" },
    { id: 3, name: "Zulu", programs: [{ id: 31, name: "Yak", projects: [{ id: 311, name: "Beta" }] }, { id: 32, name: "Ant", projects: [{ id: 321, name: "Alpha" }] }] },
    { id: 2, name: "alpha" },
  ],
  { revision: 4 },
);

beforeEach(() => {
  const api = installImportApi({ preview: () => jsonResponse(500, { title: "x", status: 500 }) });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (url === "/api/v1/views/plan" ? Promise.resolve(jsonResponse(200, ARRANGED)) : api.mock(url, init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("JiraImportScopeStep: pickers do not follow the plan's shared order", () => {
  test("work streams are open first by name then closed; programs and projects by name", async () => {
    const user = userEvent.setup();
    renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={vi.fn()} />, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    await user.click(screen.getByRole("combobox", { name: /^Work stream/ }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["alpha", "Zulu", "Aardvark (closed)"]);
    await user.click(screen.getByRole("option", { name: "Zulu" }));
    await user.click(screen.getByRole("combobox", { name: "Default program" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Ant", "Yak"]);
    await user.click(screen.getByRole("option", { name: "Ant" }));
    await user.click(screen.getByRole("combobox", { name: "Default project" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Alpha · Ant", "Beta · Yak"]);
  });
});
