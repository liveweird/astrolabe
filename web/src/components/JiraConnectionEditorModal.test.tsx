import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { CONNECTION, FAILING_TEST, PASSING_TEST } from "../test/jira";
import type { JiraConnection } from "../api/jira";
import JiraConnectionEditorModal from "./JiraConnectionEditorModal";

const TOKEN_KEY = "astrolabe.auth.token";
type FetchMock = ReturnType<typeof vi.fn>;

function call(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
}
function body(mockFetch: FetchMock, method: string, url: string) {
  return JSON.parse((call(mockFetch, method, url)![1] as RequestInit).body as string);
}

describe("JiraConnectionEditorModal", () => {
  let mockFetch: FetchMock;
  const onClose = vi.fn();
  const onSaved = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    onSaved.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function open(target: JiraConnection | null) {
    renderWithProviders(<JiraConnectionEditorModal target={target} onClose={onClose} onSaved={onSaved} />);
    return { user: userEvent.setup(), dialog: screen.getByRole("dialog") };
  }

  async function fillCreate(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.type(within(dialog).getByLabelText("Name"), "Acme Jira");
    await user.type(within(dialog).getByLabelText("Site"), "https://acme.atlassian.net");
    await user.type(within(dialog).getByLabelText("Account email"), "robot@acme.example");
    await user.type(within(dialog).getByLabelText("API token"), "tok-123");
    await user.type(within(dialog).getByRole("combobox", { name: "Project keys" }), "e2e,pf,");
  }

  test("create validates like the server: site, token, keys", async () => {
    const { user, dialog } = open(null);
    await user.type(within(dialog).getByLabelText("Site"), "https://acme.atlassian.net/");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText(/Name must be 1–100 characters/)).toBeInTheDocument();
    expect(within(dialog).getByText(/The site must be exactly https:\/\/your-tenant\.atlassian\.net/)).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the email address of the Atlassian account")).toBeInTheDocument();
    expect(within(dialog).getByText("The API token is required")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter 1 to 50 project keys")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("create POSTs the full body: keys upper-cased, authScheme and enabled included, the token trimmed", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { ...CONNECTION, id: 9 }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(call(mockFetch, "POST", "/api/v1/integrations/jira/connections")).toBeDefined());
    expect(body(mockFetch, "POST", "/api/v1/integrations/jira/connections")).toEqual({
      name: "Acme Jira",
      siteUrl: "https://acme.atlassian.net",
      email: "robot@acme.example",
      apiToken: "tok-123",
      authScheme: "BASIC",
      projectKeys: ["E2E", "PF"],
      enabled: true,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 9 })));
  });

  test("a name clash (409) marks the name field", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, { title: "Conflict", status: 409 }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A connection with this name already exists")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("on edit the token is write-only: never pre-filled, 'leave blank to keep' with hasApiToken shown, a blank save omits it", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { user, dialog } = open(CONNECTION);
    const token = within(dialog).getByLabelText("API token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
    expect(within(dialog).getByText(/A token is stored\. Leave blank to keep the current token/)).toBeInTheDocument();
    // The site is the connection's identity: read-only.
    expect(within(dialog).getByLabelText("Site")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("Site")).toHaveValue("https://acme.atlassian.net");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1")).toBeDefined());
    const sent = body(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1");
    expect(sent).not.toHaveProperty("apiToken");
    // A PUT is a full replace: the scheme and the flag always travel.
    expect(sent).toMatchObject({ authScheme: "BASIC", enabled: true, siteUrl: "https://acme.atlassian.net", projectKeys: ["E2E", "PF"] });
  });

  test("on edit a typed token rotates it; a connection without a stored token says so", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const first = open({ ...CONNECTION, hasApiToken: false });
    expect(within(first.dialog).getByText("No token is stored. Enter one.")).toBeInTheDocument();
    await first.user.type(within(first.dialog).getByLabelText("API token"), "new-token");
    await first.user.click(within(first.dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1")).toBeDefined());
    expect(body(mockFetch, "PUT", "/api/v1/integrations/jira/connections/1").apiToken).toBe("new-token");
  });

  test("Test connection with a typed token probes ad hoc and shows every row", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...PASSING_TEST, recorded: false }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const table = await within(dialog).findByRole("table", { name: "Connection test results" });
    expect(within(table).getAllByText("OK")).toHaveLength(4);
    expect(call(mockFetch, "POST", "/api/v1/integrations/jira/connections/test")).toBeDefined();
    expect(body(mockFetch, "POST", "/api/v1/integrations/jira/connections/test").apiToken).toBe("tok-123");
  });

  test("Test connection when editing with a blank token probes the STORED connection (no body)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FAILING_TEST));
    const { user, dialog } = open(CONNECTION);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText(/needs scope: read:jql:jira/)).toBeInTheDocument();
    const stored = call(mockFetch, "POST", "/api/v1/integrations/jira/connections/1/test");
    expect(stored).toBeDefined();
    expect((stored![1] as RequestInit).body).toBeUndefined();
  });

  test("Test connection checks the probe fields first and says when the bucket is empty (429)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(429, { title: "Too Many Requests", status: 429 }));
    const { user, dialog } = open(null);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("The API token is required")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Too many tests in a minute. Wait a moment and try again.")).toBeInTheDocument();
  });

  test("Test connection needs the name too: the server's probe body requires it, so a blank name is refused before any request", async () => {
    const { user, dialog } = open(null);
    await user.type(within(dialog).getByLabelText("Site"), "https://acme.atlassian.net");
    await user.type(within(dialog).getByLabelText("Account email"), "robot@acme.example");
    await user.type(within(dialog).getByLabelText("API token"), "tok-123");
    await user.type(within(dialog).getByRole("combobox", { name: "Project keys" }), "e2e,");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Name must be 1–100 characters")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a stored probe under an edited form says it tests the SAVED settings, and entering a token takes the note away", async () => {
    const { user, dialog } = open(CONNECTION);
    const note = "With the token field empty, this tests the saved settings, not the changes made here. Enter the token to test these changes.";
    expect(within(dialog).queryByText(note)).not.toBeInTheDocument();
    // The name and the enabled flag do not change what a test probes.
    await user.type(within(dialog).getByLabelText("Name"), " renamed");
    expect(within(dialog).queryByText(note)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Account email"), ".uk");
    expect(await within(dialog).findByText(note)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("API token"), "new-token");
    expect(within(dialog).queryByText(note)).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("API token"));
    expect(within(dialog).getByText(note)).toBeInTheDocument();
    // Restoring the email, or changing the keys or the scheme, moves the note the same way.
    await user.clear(within(dialog).getByLabelText("Account email"));
    await user.type(within(dialog).getByLabelText("Account email"), CONNECTION.email);
    expect(within(dialog).queryByText(note)).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox", { name: "Project keys" }), "new,");
    expect(within(dialog).getByText(note)).toBeInTheDocument();
  });

  test("a create has no stored settings to confuse with the form: no note", async () => {
    const { user, dialog } = open(null);
    await user.type(within(dialog).getByLabelText("Account email"), "robot@acme.example");
    expect(within(dialog).queryByText(/tests the saved settings/)).not.toBeInTheDocument();
  });

  test("the test's verdict is in a polite status region, and a new attempt clears the old result first", async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, FAILING_TEST)));
    mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(429, { title: "Too Many Requests", status: 429 })));
    const { user, dialog } = open(CONNECTION);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const verdict = await within(dialog).findByText("Test failed. Required probes that failed: 1 of 4.");
    expect(verdict.closest('[role="status"]')).toHaveAttribute("aria-live", "polite");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Too many tests in a minute. Wait a moment and try again.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Test failed/)).not.toBeInTheDocument();
  });

  test("a 400 on save shows the server's own sentence under the fixed lead", async () => {
    mockFetch.mockResolvedValue(jsonResponse(400, { title: "Bad Request", status: 400, detail: "Invalid project key: e2e (must match ^[A-Z][A-Z0-9_]{1,9}$)" }));
    const { user, dialog } = open(CONNECTION);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("One or more fields are invalid");
    expect(alert).toHaveTextContent("Invalid project key: e2e (must match ^[A-Z][A-Z0-9_]{1,9}$)");
  });
});
