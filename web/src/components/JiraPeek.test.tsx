import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import type { JiraPeekResponse } from "../api/jira";
import JiraPeek from "./JiraPeek";

const TOKEN_KEY = "astrolabe.auth.token";

const RESULT: JiraPeekResponse = {
  issue: { id: "10042", key: "E2E-1", summary: "Checkout <b>flow</b>", typeName: "Epic", hierarchyLevel: 1, statusCategory: "IN_PROGRESS", parentKey: "E2E-9" },
  resolved: { level: "MILESTONE", start: "2044-03-01", end: "2044-03-31", estimate: 8, unit: "POINTS", teamName: "Payments" },
  raw: {
    customfield_10020: "2044-03-01",
    customfield_10028: 8,
    customfield_10001: { id: "t-1", name: "Payments" },
    customfield_10099: "<img src=x onerror=alert(1)>",
  },
};

type FetchMock = ReturnType<typeof vi.fn>;

describe("JiraPeek", () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function peek(key: string) {
    const user = userEvent.setup();
    renderWithProviders(<JiraPeek connectionId={1} siteUrl="https://acme.atlassian.net" resetKey="a" />);
    await user.type(screen.getByLabelText("Issue key"), key);
    await user.click(screen.getByRole("button", { name: "Peek" }));
    return user;
  }

  test("a key that is not an issue key is refused before the request", async () => {
    await peek("nonsense");
    expect(await screen.findByText("Enter an issue key like ABC-12")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("the result is a table of the issue, what the mapping resolves and the raw values, all as text", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, RESULT));
    await peek(" e2e-1 ");
    const table = await screen.findByRole("table", { name: "Peek result" });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/v1/integrations/jira/connections/1/peek?key=E2E-1");
    expect(within(table).getByRole("link", { name: /E2E-1/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(within(table).getByText("Checkout <b>flow</b>")).toBeInTheDocument();
    expect(within(table).getByText("In progress")).toBeInTheDocument();
    // Resolved by the mapping.
    expect(within(table).getByText("Milestone")).toBeInTheDocument();
    expect(within(table).getByText("2044-03-31")).toBeInTheDocument();
    expect(within(table).getByText("8 Story points")).toBeInTheDocument();
    expect(within(table).getAllByText("Payments").length).toBeGreaterThan(0);
    // Raw: strings as they are, other JSON as JSON - and a markup string is text, never an element.
    expect(within(table).getByText('{"id":"t-1","name":"Payments"}')).toBeInTheDocument();
    expect(within(table).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(table.querySelector("img")).toBeNull();
    expect(table.querySelector("b")).toBeNull();
  });

  test.each([
    [400, { detail: "Project ZZ is not one of the connection's project keys" }, "This key cannot be read:", "Project ZZ is not one of the connection's project keys"],
    [404, {}, "Jira does not know this issue (or the connection is gone).", null],
    [409, { type: "urn:astrolabe:problem:jira-not-discovered" }, "Test the connection first.", null],
    [409, { type: "urn:astrolabe:problem:jira-token-unreadable" }, "The stored token cannot be decrypted. Edit the connection and enter the token again.", null],
    [409, { type: "urn:astrolabe:problem:jira-mapping-invalid", detail: "The connection's mapping no longer fits the site (customfield_99999)" }, "The mapping in force (the saved one, or the defaults when none is saved) no longer fits the Jira site, or cannot be read.", "customfield_99999"],
    [502, { type: "urn:astrolabe:problem:jira-upstream", detail: "Jira did not answer (AUTHENTICATION_FAILED)" }, "Jira could not be reached or refused the request:", "Jira refused the credentials (AUTHENTICATION_FAILED)"],
    [429, {}, "Too many tests in a minute. Wait a moment and try again.", null],
  ])("a %i answer is shown inline", async (status, problem, message, detail) => {
    mockFetch.mockResolvedValue(jsonResponse(status, { title: "x", status, ...problem }));
    await peek("E2E-404");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    if (detail) expect(alert).toHaveTextContent(detail);
    await waitFor(() => expect(screen.queryByRole("table", { name: "Peek result" })).not.toBeInTheDocument());
  });

  test("what Peek showed belongs to the mapping it was read under: a new saved mapping clears the result, the typed key stays", async () => {
    // A fresh Response per call: a body can be read once.
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(200, RESULT)));
    const user = userEvent.setup();
    const view = renderWithProviders(<JiraPeek connectionId={1} siteUrl="https://acme.atlassian.net" resetKey="mapping-1" />);
    await user.type(screen.getByLabelText("Issue key"), "E2E-1");
    await user.click(screen.getByRole("button", { name: "Peek" }));
    expect(await screen.findByRole("table", { name: "Peek result" })).toBeInTheDocument();
    view.rerender(<JiraPeek connectionId={1} siteUrl="https://acme.atlassian.net" resetKey="mapping-1" />);
    expect(screen.getByRole("table", { name: "Peek result" })).toBeInTheDocument();
    view.rerender(<JiraPeek connectionId={1} siteUrl="https://acme.atlassian.net" resetKey="mapping-2" />);
    expect(screen.queryByRole("table", { name: "Peek result" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Issue key")).toHaveValue("E2E-1");
    // Reading again under the new mapping shows it again.
    await user.click(screen.getByRole("button", { name: "Peek" }));
    expect(await screen.findByRole("table", { name: "Peek result" })).toBeInTheDocument();
  });
});
