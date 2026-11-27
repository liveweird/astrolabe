import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { forgetRevalidated } from "../api/revalidate";
import { TEAM_LOAD_KEY } from "../api/teamLoad";
import { deferred } from "../test/deferred";
import { jsonResponse } from "../test/http";
import { clientWithKeptHome, homeReadIsStale } from "../test/home";
import { teamLoadView } from "../test/teamLoad";
import { type FetchMock, DETAIL, PAGE, ROLES_KEY, ROWS, TOKEN_KEY, findCall, renderPage, serve } from "../test/teamsRegistry";

describe("Teams page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    forgetRevalidated();
  });

  test("a regular user gets the read-only table with the team names as links and the description under the name", async () => {
    localStorage.setItem(ROLES_KEY, "[]");
    serve(mockFetch);
    renderPage();
    expect(await screen.findByRole("link", { name: "Open team Payments" })).toHaveAttribute("href", "/teams/1");
    const payments = screen.getByRole("link", { name: "Open team Payments" }).closest("tr")!;
    expect(within(payments).getByText("Money movers")).toBeInTheDocument();
    // A team without a description shows no placeholder line at all.
    expect(within(screen.getByRole("link", { name: "Open team Identity" }).closest("tr")!).queryByText("—")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Manager" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open person Mia Manager" })).toHaveAttribute("href", "/people/7"); // the manager is a person
    expect(screen.queryByRole("columnheader", { name: "Members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new team/i })).not.toBeInTheDocument();
    // The read-only list never opens the editor, so it never runs the people search either.
    expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.startsWith("/api/v1/people"))).toBe(false);
    expect(screen.queryByRole("button", { name: /operations for/i })).not.toBeInTheDocument();
    // No empty Operations column either: the figures and the names are all there is.
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });

  test("an admin's rows carry the kebab beside the load figures, in an Operations column", async () => {
    serve(mockFetch);
    renderPage();
    const payments = (await screen.findByRole("link", { name: "Open team Payments" })).closest("tr")!;
    expect(within(payments).getByText("1 week overloaded")).toBeInTheDocument();
    expect(within(payments).getByRole("link", { name: "2 not scheduled: team Payments" })).toHaveAttribute("href", "/teams/1");
    expect(within(payments).getByRole("button", { name: "Operations for Payments" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Operations" })).toBeInTheDocument();
  });

  test("no team at all says so, with the New team button still there", async () => {
    serve(mockFetch);
    mockFetch.mockImplementation((url: string) => Promise.resolve(url === "/api/v1/views/team-load" ? jsonResponse(200, teamLoadView([])) : jsonResponse(200, { ...PAGE, items: [], total: 0 })));
    renderPage();
    expect(await screen.findByText("No teams yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: /new team/i })).toBeInTheDocument();
  });

  test("the name column sorts: a click reverses the document's order, remembers the direction and says so in aria-sort", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "Open team Payments" });
    const names = () => screen.getAllByRole("link", { name: /^Open team / }).map((link) => link.textContent);
    expect(names()).toEqual(["Payments", "Identity"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Identity", "Payments"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.teams.sortDir")!)).toBe("desc");
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Payments", "Identity"]);
  });

  test("a remembered descending order is read back", async () => {
    localStorage.setItem("astrolabe.viewSettings.teams.sortDir", JSON.stringify("desc"));
    serve(mockFetch);
    renderPage();
    await screen.findByRole("link", { name: "Open team Payments" });
    expect(screen.getAllByRole("link", { name: /^Open team / }).map((link) => link.textContent)).toEqual(["Identity", "Payments"]);
  });

  test("an admin creates a team through the modal and lands on its page", async () => {
    serve(mockFetch, { "POST /api/v1/teams": { status: 201, body: { ...DETAIL, id: 9, name: "Ledger" } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new team/i }));
    const modal = screen.getByRole("dialog");
    // Both teams hold INDIGO, so the least-used key is the next one, TEAL: the editor preselects it once the teams are read.
    await waitFor(() => expect(within(modal).getByRole("radio", { name: "Teal" })).toBeChecked());
    await user.type(within(modal).getByLabelText("Name"), "Ledger");
    await user.type(within(modal).getByLabelText("Description"), " keeps the books ");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/teams")).toBeDefined());
    const body = JSON.parse((findCall(mockFetch, "POST", "/api/v1/teams")![1] as RequestInit).body as string);
    expect(body).toEqual({ name: "Ledger", description: "keeps the books", managerPersonId: null, colour: "TEAL" });
    expect(await screen.findByText("at /teams/9")).toBeInTheDocument();
  });

  test("modal validation blocks an empty name", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new team/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("Name must be 1–100 characters")).toBeInTheDocument();
    expect(findCall(mockFetch, "POST", "/api/v1/teams")).toBeUndefined();
  });

  test("an admin edits a team — the modal prefills from the detail and PUTs", async () => {
    serve(mockFetch, { "PUT /api/v1/teams/1": { status: 204 } });
    const user = userEvent.setup();
    const queryClient = clientWithKeptHome();
    renderPage(queryClient);
    await user.click(await screen.findByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Name")).toHaveValue("Payments");
    await user.clear(within(modal).getByLabelText("Description"));
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/teams/1")).toBeDefined());
    const body = JSON.parse((findCall(mockFetch, "PUT", "/api/v1/teams/1")![1] as RequestInit).body as string);
    // The manager and the name are on Home ("Yours"), which keeps its read for a minute: the save marks it stale, and re-reads this page's document.
    await waitFor(() => expect(homeReadIsStale(queryClient)).toBe(true));
    await waitFor(() => expect(mockFetch.mock.calls.filter(([url]) => url === "/api/v1/views/team-load")).toHaveLength(2));
    // Edit keeps the stored manager (a PUT is a full replace).
    // The colour was not touched, so the PUT omits it and keeps the stored one.
    expect(body).toEqual({ name: "Payments", description: null, managerPersonId: 7 });
  });

  test("the manager picker searches people, sends the picked id, and clearing sends null", async () => {
    serve(mockFetch, { "PUT /api/v1/teams/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    const modal = await screen.findByRole("dialog");
    const picker = within(modal).getByRole("combobox", { name: "Manager" });
    // The stored manager prefills by name.
    expect(picker).toHaveValue("Mia Manager");
    await user.click(picker);
    await user.clear(picker);
    await user.type(picker, "cara");
    await waitFor(() => expect(mockFetch.mock.calls.some(([u]) => typeof u === "string" && u.startsWith("/api/v1/people?") && u.includes("name=cara"))).toBe(true));
    await user.click(await screen.findByRole("option", { name: "Cara New (cara@example.com)" }));
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/teams/1")).toBeDefined());
    expect(JSON.parse((findCall(mockFetch, "PUT", "/api/v1/teams/1")![1] as RequestInit).body as string)).toEqual({
      name: "Payments",
      description: "Money movers",
      managerPersonId: 12,
    });
  });

  test("clearing the manager sends managerPersonId null", async () => {
    serve(mockFetch, { "PUT /api/v1/teams/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    const modal = await screen.findByRole("dialog");
    // Mantine marks its clear button aria-hidden (a mouse affordance; the keyboard clears by emptying the box).
    await user.click(within(modal).getByLabelText("Clear the manager"));
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/teams/1")).toBeDefined());
    expect(JSON.parse((findCall(mockFetch, "PUT", "/api/v1/teams/1")![1] as RequestInit).body as string)).toMatchObject({ managerPersonId: null });
  });

  test("each row carries its team's colour as a swatch before the name link (the name stays the information)", async () => {
    serve(mockFetch);
    renderPage();
    const link = await screen.findByRole("link", { name: "Open team Payments" });
    const swatch = link.parentElement?.querySelector("[data-team-colour]");
    expect(swatch).toHaveAttribute("data-team-colour", "INDIGO");
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch).toHaveTextContent("");
    expect(swatch?.compareDocumentPosition(link)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test("the editor offers the twelve colours as a radio group, each with its visible name, and says who else holds the picked one", async () => {
    serve(mockFetch, { "PUT /api/v1/teams/1": { status: 204 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    const modal = await screen.findByRole("dialog");
    const group = within(modal).getByRole("radiogroup", { name: "Colour" });
    expect(within(group).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([
      "INDIGO", "TEAL", "LIME", "RASPBERRY", "GRAPE", "PINK", "VIOLET", "COBALT", "AZURE", "LAVENDER", "SAPPHIRE", "GREEN",
    ]);
    expect(within(group).getAllByRole("radio")[0]).toBeChecked();
    // A swatch inside every option, hidden from the accessible name, beside the visible name.
    expect(group.querySelectorAll("[data-team-colour][aria-hidden='true']")).toHaveLength(12);
    // Payments is edited; Identity holds INDIGO too: a dimmed hint (sharing is allowed), and picking another colour removes it.
    expect(await within(modal).findByText("Also used by: Identity")).toBeInTheDocument();
    await user.click(within(group).getByRole("radio", { name: "Raspberry" }));
    expect(within(modal).queryByText(/Also used by/)).not.toBeInTheDocument();
    await user.click(within(modal).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(findCall(mockFetch, "PUT", "/api/v1/teams/1")).toBeDefined());
    expect(JSON.parse((findCall(mockFetch, "PUT", "/api/v1/teams/1")![1] as RequestInit).body as string)).toMatchObject({ colour: "RASPBERRY" });
  });

  test("a pick made before the teams read answers wins over the least-used colour that read would give", async () => {
    serve(mockFetch, { "POST /api/v1/teams": { status: 201, body: { ...DETAIL, id: 9, name: "Ledger" } } });
    const served = mockFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    const gate = deferred<Response>();
    // The editor's teams read (100 a page) waits; the registry's own list (20 a page) answers.
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" && url.startsWith("/api/v1/teams?") && url.includes("pageSize=100") ? gate.promise : served(url, init),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new team/i }));
    const modal = screen.getByRole("dialog");
    expect(within(modal).queryByRole("radio", { checked: true })).toBeNull();
    await user.click(within(modal).getByRole("radio", { name: "Raspberry" }));
    await user.type(within(modal).getByLabelText("Name"), "Ledger");
    await act(async () => gate.resolve(jsonResponse(200, PAGE)));
    // The read settles with TEAL as the least-used key, and the pick stays.
    expect(within(modal).getByRole("radio", { name: "Raspberry" })).toBeChecked();
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/teams")).toBeDefined());
    expect(JSON.parse((findCall(mockFetch, "POST", "/api/v1/teams")![1] as RequestInit).body as string)).toMatchObject({ colour: "RASPBERRY" });
  });

  test("a new team's editor preselects the least-used colour and a pick overrides it", async () => {
    serve(mockFetch, { "POST /api/v1/teams": { status: 201, body: { ...DETAIL, id: 9, name: "Ledger" } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new team/i }));
    const modal = screen.getByRole("dialog");
    await waitFor(() => expect(within(modal).getByRole("radio", { name: "Teal" })).toBeChecked());
    expect(within(modal).queryByText(/Also used by/)).not.toBeInTheDocument();
    await user.click(within(modal).getByRole("radio", { name: "Indigo" }));
    // INDIGO is held by both existing teams, named in the hint.
    expect(within(modal).getByText("Also used by: Payments, Identity")).toBeInTheDocument();
    await user.type(within(modal).getByLabelText("Name"), "Ledger");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(findCall(mockFetch, "POST", "/api/v1/teams")).toBeDefined());
    expect(JSON.parse((findCall(mockFetch, "POST", "/api/v1/teams")![1] as RequestInit).body as string)).toMatchObject({ colour: "INDIGO" });
  });

  test("a 409 on save marks the name field", async () => {
    serve(mockFetch, { "POST /api/v1/teams": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /new team/i }));
    const modal = screen.getByRole("dialog");
    await user.type(within(modal).getByLabelText("Name"), "Payments");
    await user.click(within(modal).getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("A team with this name already exists")).toBeInTheDocument();
    expect(within(modal).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  test("an admin deletes a team after confirming; a 409 names the conflict", async () => {
    serve(mockFetch, { "DELETE /api/v1/teams/2": { status: 204 }, "DELETE /api/v1/teams/1": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    const queryClient = clientWithKeptHome();
    renderPage(queryClient);
    await user.click(await screen.findByRole("button", { name: "Operations for Identity" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Identity" }));
    expect(await screen.findByText(/"Identity" will be deleted/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(findCall(mockFetch, "DELETE", "/api/v1/teams/2")).toBeDefined());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(homeReadIsStale(queryClient)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Payments" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/still referenced elsewhere/)).toBeInTheDocument();
  });

  test("deleting while a re-read of the document is in flight cannot bring the deleted row back", async () => {
    const stale = deferred<Response>();
    let deleted = false;
    let reads = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && url === "/api/v1/teams/2") {
        deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === "GET" && url === "/api/v1/views/team-load") {
        reads++;
        // The second read (the re-read) is held, and answers with the document as it was BEFORE the delete.
        if (reads === 2) return stale.promise;
        return Promise.resolve(jsonResponse(200, teamLoadView(deleted ? ROWS.slice(0, 1) : ROWS)));
      }
      if (method === "GET" && url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, PAGE));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    const user = userEvent.setup();
    const queryClient = clientWithKeptHome();
    renderPage(queryClient);
    await screen.findByText("Identity");
    void queryClient.refetchQueries({ queryKey: TEAM_LOAD_KEY });
    await waitFor(() => expect(reads).toBe(2));

    await user.click(screen.getByRole("button", { name: "Operations for Identity" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Identity" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.queryByText("Identity")).not.toBeInTheDocument());

    stale.resolve(jsonResponse(200, teamLoadView(ROWS)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Identity")).not.toBeInTheDocument();
    expect(screen.getByText("Payments")).toBeInTheDocument();
  });

  test("the Name filter works on the rows already read: no request, and the editor still opens on a filtered row", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Money movers");
    const before = mockFetch.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Name"), "pay");
    expect(screen.queryByRole("link", { name: "Open team Identity" })).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.slice(before).some(([url]) => typeof url === "string" && url.includes("name="))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    expect(within(await screen.findByRole("dialog")).getByLabelText("Name")).toHaveValue("Payments");
  });

  test("shows the load-failure alert", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { title: "boom", status: 500 })));
    renderPage();
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument();
  });
});
