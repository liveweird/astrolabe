import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { DEFAULT_MAPPING, DISCOVERY, MAPPING_DEFAULTS_ONLY } from "../test/jira";
import type { JiraMappingResponse } from "../api/jira";
import JiraMappingEditor from "./JiraMappingEditor";

const TOKEN_KEY = "astrolabe.auth.token";
const MAPPING_URL = "/api/v1/integrations/jira/connections/1/mapping";

type FetchMock = ReturnType<typeof vi.fn>;

function putCall(mockFetch: FetchMock) {
  return mockFetch.mock.calls.find(([url, init]) => url === MAPPING_URL && (init as RequestInit | undefined)?.method === "PUT");
}
function putBody(mockFetch: FetchMock) {
  return JSON.parse((putCall(mockFetch)![1] as RequestInit).body as string);
}

function renderEditor(response: JiraMappingResponse = MAPPING_DEFAULTS_ONLY, onSaved = vi.fn(() => Promise.resolve())) {
  renderWithProviders(<JiraMappingEditor connectionId={1} discovery={DISCOVERY} response={response} onSaved={onSaved} />);
  return { onSaved };
}

const level = (name: string) => within(screen.getByRole("group", { name }));

describe("JiraMappingEditor", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("with nothing saved the form opens on the defaults - the closed values are plain name and id, the default is noted under the select - and saving sends them as they are", async () => {
    const user = userEvent.setup();
    renderEditor();
    expect(screen.getByText(/Nothing is saved yet/)).toBeInTheDocument();
    const milestone = level("Milestone");
    // The closed value carries no "(default)" suffix a narrow column could cut off ...
    expect(milestone.getByRole("combobox", { name: "Jira level" })).toHaveValue("Level 1 — Epic");
    expect(milestone.getByRole("combobox", { name: "Start" })).toHaveValue("Target start — customfield_10020");
    expect(milestone.getByRole("combobox", { name: "Estimate" })).toHaveValue("Story point estimate — customfield_10028");
    expect(level("Program").getByRole("combobox", { name: "Jira level" })).toHaveValue("Level 3 — Program");
    expect(screen.getByRole("combobox", { name: "Team field" })).toHaveValue("Team — customfield_10001");
    // ... the default is said under it instead (and in the list, below), and only where the shown value IS the default.
    expect(milestone.getAllByText("Default")).toHaveLength(3);
    expect(milestone.getByText(/Required\. The Jira items that are milestones\. Default\./)).toBeInTheDocument();
    expect(screen.getByText(/which names a milestone's team\. Default\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(putCall(mockFetch)).toBeDefined());
    expect(putBody(mockFetch)).toEqual(DEFAULT_MAPPING);
  });

  test("the field lists are filtered by type: dates for start and end, numbers for the estimate", async () => {
    const user = userEvent.setup();
    renderEditor();
    const milestone = level("Milestone");
    await user.click(milestone.getByRole("combobox", { name: "Start" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Due date — duedate",
      "Start date — customfield_10015",
      "Target end — customfield_10021",
      // The list is where the default is marked.
      "Target start — customfield_10020(default)",
    ]);
    await user.keyboard("{Escape}");
    await user.click(milestone.getByRole("combobox", { name: "Estimate" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Story point estimate — customfield_10028(default)",
      "Time in status — customfield_10030",
    ]);
  });

  test("the level lists are the site's levels labelled with their types", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(level("Project").getByRole("combobox", { name: "Jira level" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Level 3 — Program",
      "Level 2 — Initiative(default)",
      "Level 1 — Epic",
      "Level 0 — Story",
    ]);
  });

  test("the program and project levels can be unset; their fields are then disabled and the document carries null", async () => {
    const user = userEvent.setup();
    renderEditor();
    // Mantine marks its clear button aria-hidden (a mouse affordance), so it is found by its class.
    const program = level("Program");
    const clear = screen.getAllByRole("button", { hidden: true }).filter((b) => b.className.includes("InputClearButton"));
    expect(clear.length).toBeGreaterThan(0);
    await user.click(clear[0]);
    expect(program.getByRole("combobox", { name: "Start" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(putCall(mockFetch)).toBeDefined());
    expect(putBody(mockFetch).levels.program).toBeNull();
    expect(putBody(mockFetch).levels.project).not.toBeNull();
  });

  test("the factor is hidden for DAYS (and not sent) and sent as a number for hours", async () => {
    const user = userEvent.setup();
    renderEditor();
    expect(screen.getByLabelText("Man-days per unit")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Estimate unit" }));
    await user.click(await screen.findByRole("option", { name: "Days" }));
    expect(screen.queryByLabelText("Man-days per unit")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Estimate unit" }));
    await user.click(await screen.findByRole("option", { name: "Hours" }));
    await user.type(screen.getByLabelText("Man-days per unit"), "0.5");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(putCall(mockFetch)).toBeDefined());
    expect(putBody(mockFetch).estimate).toEqual({ unit: "HOURS", manDaysPerUnit: 0.5 });
  });

  test("levels that do not decrease are refused before the request", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(level("Project").getByRole("combobox", { name: "Jira level" }));
    await user.click(await screen.findByRole("option", { name: "Level 1 — Epic" }));
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(await screen.findAllByText("Levels must decrease from program to project to milestone")).not.toHaveLength(0);
    expect(putCall(mockFetch)).toBeUndefined();
  });

  test("a saved mapping that no longer fits shows as saved, flags the stale level and field, and lists the server's problems in amber", async () => {
    const stale: JiraMappingResponse = {
      ...MAPPING_DEFAULTS_ONLY,
      mapping: {
        levels: { program: null, project: null, milestone: { hierarchyLevel: 5, fields: { start: "customfield_99999", end: "customfield_10021", estimate: "customfield_10015" } } },
        estimate: { unit: "POINTS", manDaysPerUnit: null },
        teamFieldId: null,
      },
      problems: ["No issue type at hierarchy level 5 (the milestone level)", "Field customfield_99999 (the milestone start) is not a date field of this site"],
    };
    renderEditor(stale);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("The saved mapping no longer fits this site");
    expect(note).toHaveTextContent("No issue type at hierarchy level 5 (the milestone level)");
    expect(screen.getByText("This is the saved mapping.")).toBeInTheDocument();
    const milestone = level("Milestone");
    expect(milestone.getByRole("combobox", { name: "Jira level" })).toHaveValue("Level 5 (not on this site)");
    expect(milestone.getByRole("combobox", { name: "Start" })).toHaveValue("customfield_99999 (not found on this site)");
    expect(milestone.getByRole("combobox", { name: "Estimate" })).toHaveValue("Start date — customfield_10015 (a date field, not valid here)");
  });

  test("a 400 shows the server's sentence next to the form; correcting the level and saving works", async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(400, { title: "Bad Request", status: 400, detail: "No issue type at hierarchy level 5 (the milestone level)" })));
    const user = userEvent.setup();
    const { onSaved } = renderEditor({ ...MAPPING_DEFAULTS_ONLY, mapping: { ...DEFAULT_MAPPING, levels: { ...DEFAULT_MAPPING.levels, project: null, program: null, milestone: { hierarchyLevel: 5, fields: {} } } } });
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server rejected the mapping:");
    expect(alert).toHaveTextContent("No issue type at hierarchy level 5 (the milestone level)");
    await user.click(level("Milestone").getByRole("combobox", { name: "Jira level" }));
    await user.click(await screen.findByRole("option", { name: /Level 1 — Epic/ }));
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test.each([
    ["jira-not-discovered", /Test the connection first/],
    ["jira-token-unreadable", /token cannot be decrypted/],
  ])("a 409 %s is told in words", async (type, text) => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(409, { title: "Conflict", status: 409, type: `urn:astrolabe:problem:${type}` })));
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  test("Use the defaults puts the discovery's defaults back", async () => {
    const user = userEvent.setup();
    renderEditor({ ...MAPPING_DEFAULTS_ONLY, mapping: { ...DEFAULT_MAPPING, teamFieldId: null } });
    expect(screen.getByRole("combobox", { name: "Team field" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Use the defaults" }));
    expect(screen.getByRole("combobox", { name: "Team field" })).toHaveValue("Team — customfield_10001");
  });
});
