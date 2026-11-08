import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { CONNECTION, PASSING_TEST, REVOKED_TEST } from "../test/flow";
import type { FlowConnection } from "../api/flow";
import FlowConnectionEditorModal from "./FlowConnectionEditorModal";

const TOKEN_KEY = "astrolabe.auth.token";
const LIST = "/api/v1/integrations/flow/connections";
const TOKEN = `flow_int_${"b".repeat(43)}`;
type FetchMock = ReturnType<typeof vi.fn>;

function call(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
}
function body(mockFetch: FetchMock, method: string, url: string) {
  return JSON.parse((call(mockFetch, method, url)![1] as RequestInit).body as string);
}

describe("FlowConnectionEditorModal", () => {
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

  function open(target: FlowConnection | null) {
    renderWithProviders(<FlowConnectionEditorModal target={target} onClose={onClose} onSaved={onSaved} />);
    return { user: userEvent.setup(), dialog: screen.getByRole("dialog") };
  }

  async function fillCreate(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.type(within(dialog).getByLabelText("Name"), "Acme Flow");
    await user.type(within(dialog).getByLabelText("Base URL"), "https://flow.acme.example");
    await user.type(within(dialog).getByLabelText("Service token"), TOKEN);
  }

  test("a new connection opens on Flow's own zone and the 60-minute poll, with nothing filled in", () => {
    const { dialog } = open(null);
    expect(within(dialog).getByLabelText("Time zone")).toHaveValue("Europe/Warsaw");
    expect(within(dialog).getByLabelText("Polling interval (minutes)")).toHaveValue("60");
    expect(within(dialog).getByLabelText("Manual only (no polling)")).not.toBeChecked();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    expect(within(dialog).getByLabelText("Base URL")).toHaveValue("");
  });

  test("create validates like the server: name, origin, zone, token", async () => {
    const { user, dialog } = open(null);
    await user.type(within(dialog).getByLabelText("Base URL"), "https://flow.acme.example/app");
    await user.clear(within(dialog).getByLabelText("Time zone"));
    await user.type(within(dialog).getByLabelText("Time zone"), "+02:00");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText(/Name must be 1–100 characters/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Enter Flow's address as an origin only/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Enter an IANA time zone such as Europe\/Warsaw/)).toBeInTheDocument();
    expect(within(dialog).getByText("The service token is required")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a malformed token is refused before any request, and the token field is a password field", async () => {
    const { user, dialog } = open(null);
    expect(within(dialog).getByLabelText("Service token")).toHaveAttribute("type", "password");
    await fillCreate(user, dialog);
    await user.clear(within(dialog).getByLabelText("Service token"));
    await user.type(within(dialog).getByLabelText("Service token"), "tok-123");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A Flow service token is flow_int_ followed by 43 characters")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("leaving the address field writes it the canonical way: lowercase, default port and trailing slash gone", async () => {
    const { user, dialog } = open(null);
    const address = within(dialog).getByLabelText("Base URL");
    await user.type(address, "HTTPS://Flow.Acme.Example:443/");
    await user.tab();
    expect(address).toHaveValue("https://flow.acme.example");
  });

  test("create POSTs the canonical body: the origin normalised, the zone, the token trimmed, enabled and the 60-minute poll", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { ...CONNECTION, id: 9 }));
    const { user, dialog } = open(null);
    await user.type(within(dialog).getByLabelText("Name"), "Acme Flow");
    await user.type(within(dialog).getByLabelText("Base URL"), "HTTPS://Flow.Acme.Example/");
    await user.type(within(dialog).getByLabelText("Service token"), ` ${TOKEN} `);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(call(mockFetch, "POST", LIST)).toBeDefined());
    expect(body(mockFetch, "POST", LIST)).toEqual({
      name: "Acme Flow",
      baseUrl: "https://flow.acme.example",
      timeZone: "Europe/Warsaw",
      apiToken: TOKEN,
      enabled: true,
      pollIntervalMinutes: 60,
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

  test("an origin the operator did not list (400) shows the server's own sentence under the fixed lead", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(400, { title: "Bad Request", status: 400, detail: "baseUrl must be exactly one of the Flow origins this server is configured to allow" }),
    );
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("One or more fields are invalid");
    expect(alert).toHaveTextContent("baseUrl must be exactly one of the Flow origins this server is configured to allow");
  });

  test("the zone is written canonically when the field is left and sent that way", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { ...CONNECTION, id: 9 }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    const zone = within(dialog).getByLabelText("Time zone");
    await user.clear(zone);
    await user.type(zone, "europe/warsaw");
    await user.tab();
    expect(zone).toHaveValue("Europe/Warsaw");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(call(mockFetch, "POST", LIST)).toBeDefined());
    expect(body(mockFetch, "POST", LIST).timeZone).toBe("Europe/Warsaw");
  });

  test("a failure without a sentence of its own reads in the fixed vocabulary", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { title: "Forbidden", status: 403 }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only administrators can manage Flow connections");
  });

  test("on edit the token is write-only (never pre-filled, 'leave blank' with hasApiToken) and the address is read-only; a blank save omits the token", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { user, dialog } = open(CONNECTION);
    const token = within(dialog).getByLabelText("Service token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
    expect(within(dialog).getByText(/A token is stored\. Leave blank to keep the current token/)).toBeInTheDocument();
    const address = within(dialog).getByLabelText("Base URL");
    expect(address).toHaveAttribute("readonly");
    expect(address).toHaveValue("https://flow.acme.example");
    expect(within(dialog).getByText(/The address is the connection's identity/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", `${LIST}/1`)).toBeDefined());
    const sent = body(mockFetch, "PUT", `${LIST}/1`);
    expect(sent).not.toHaveProperty("apiToken");
    // A PUT is a full replace: the flag and the interval always travel.
    expect(sent).toEqual({ name: "Acme Flow", baseUrl: "https://flow.acme.example", timeZone: "Europe/Warsaw", enabled: true, pollIntervalMinutes: 60 });
  });

  test("on edit a typed token rotates it; a connection without a stored token says so", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { user, dialog } = open({ ...CONNECTION, hasApiToken: false });
    expect(within(dialog).getByText("No token is stored. Enter one.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Service token"), TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", `${LIST}/1`)).toBeDefined());
    expect(body(mockFetch, "PUT", `${LIST}/1`).apiToken).toBe(TOKEN);
  });

  test("renaming a MANUAL-ONLY connection sends an explicit null, never an omitted interval", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { user, dialog } = open({ ...CONNECTION, pollIntervalMinutes: null });
    expect(within(dialog).getByLabelText("Manual only (no polling)")).toBeChecked();
    expect(within(dialog).getByLabelText("Polling interval (minutes)")).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), " renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(call(mockFetch, "PUT", `${LIST}/1`)).toBeDefined());
    expect((call(mockFetch, "PUT", `${LIST}/1`)![1] as RequestInit).body).toContain('"pollIntervalMinutes":null');
  });

  test("an interval below 5 is refused with the shared sentence and nothing is sent", async () => {
    const { user, dialog } = open(CONNECTION);
    await user.clear(within(dialog).getByLabelText("Polling interval (minutes)"));
    await user.type(within(dialog).getByLabelText("Polling interval (minutes)"), "3");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("The polling interval must be a whole number of minutes from 5 to 1440")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("Test connection with a typed token probes ad hoc and shows the rows with the document's size", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...PASSING_TEST, recorded: false }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const table = await within(dialog).findByRole("table", { name: "Connection test results" });
    expect(within(table).getAllByText("OK")).toHaveLength(2);
    expect(within(dialog).getByText("Flow's document · teams: 18 · sprints: 640")).toBeInTheDocument();
    expect(within(dialog).getByText("Test passed. OK: 2 of 2.")).toBeInTheDocument();
    expect(body(mockFetch, "POST", `${LIST}/test`)).toMatchObject({ baseUrl: "https://flow.acme.example", apiToken: TOKEN, name: "Acme Flow" });
  });

  test("Test connection when editing with a blank token probes the STORED connection (no body) and says a revoked token in Flow's words", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, REVOKED_TEST));
    const { user, dialog } = open(CONNECTION);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText(/Flow rejected the token: it was revoked or expired/)).toBeInTheDocument();
    const stored = call(mockFetch, "POST", `${LIST}/1/test`);
    expect(stored).toBeDefined();
    expect((stored![1] as RequestInit).body).toBeUndefined();
    expect(within(dialog).getByText("Test failed. Required probes that failed: 1 of 2.")).toBeInTheDocument();
  });

  test("Test connection checks the probe fields first and says when the bucket is empty (429), clearing the old result", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, PASSING_TEST));
    mockFetch.mockResolvedValueOnce(jsonResponse(429, { title: "Too Many Requests", status: 429 }));
    const { user, dialog } = open(null);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("The service token is required")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    await within(dialog).findByRole("table", { name: "Connection test results" });
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Too many tests in a minute. Wait a moment and try again.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
  });

  test("a 400 on the ad-hoc test shows the server's own sentence under the fixed lead, like a save", async () => {
    mockFetch.mockResolvedValue(jsonResponse(400, { title: "Bad Request", status: 400, detail: "baseUrl must be exactly one of the Flow origins this server is configured to allow" }));
    const { user, dialog } = open(null);
    await fillCreate(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("One or more fields are invalid");
    expect(alert).toHaveTextContent("baseUrl must be exactly one of the Flow origins this server is configured to allow");
    expect(within(dialog).queryByRole("table", { name: "Connection test results" })).not.toBeInTheDocument();
  });

  test("a network failure of the test reads as the generic sentence", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { user, dialog } = open(CONNECTION);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("The test could not run. Check your connection and try again.")).toBeInTheDocument();
  });
});
