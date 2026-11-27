import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { forgetRevalidated } from "../api/revalidate";
import { deferred } from "../test/deferred";
import { jsonResponse } from "../test/http";
import { teamLoadView } from "../test/teamLoad";
import { type FetchMock, PAGE, PEOPLE, DETAIL, ROLES_KEY, ROWS, TOKEN_KEY, renderPage, serve } from "../test/teamsRegistry";

// Where the focus goes around the Teams page's dialogs (a row's delete and edit dialogs, the New team button's).
describe("Teams page: the focus around its dialogs", () => {
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

  test("after a successful delete the focus moves to the page heading, the row's kebab and the dialog being gone", async () => {
    // Fake clock (real time still flows for waitFor): Mantine's 10 ms focus return is advanced by hand while the DELETE is held at a gate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const deleteGate = deferred<Response>();
    let deleted = false;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && url === "/api/v1/teams/2") {
        deleted = true;
        // The DELETE is held at a gate across Mantine's return-focus timer (`useFocusReturn`, 10 ms after the row menu closes), which may put
        // the focus on the kebab if the body holds it then; a synchronous mock lets the confirm click land inside that window, which no person can.
        return deleteGate.promise;
      }
      if (method === "GET" && url === "/api/v1/views/team-load") {
        return Promise.resolve(jsonResponse(200, teamLoadView(deleted ? ROWS.slice(0, 1) : ROWS)));
      }
      if (method === "GET" && url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, PAGE));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Identity" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Identity" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await act(() => vi.advanceTimersByTimeAsync(30));
    deleteGate.resolve(new Response(null, { status: 204 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Operations for Identity" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Teams" })).toHaveFocus());
    // Mantine's own focus return (10 ms after the close) finds the focus taken and leaves it.
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(screen.getByRole("heading", { level: 2, name: "Teams" })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "Teams" })).toHaveAttribute("tabindex", "-1");
  });

  test("a delete right after an edit of the same team ends with the focus on the page heading (1.23)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let deleted = false;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && url === "/api/v1/teams/1") return Promise.resolve(new Response(null, { status: 204 }));
      if (method === "DELETE" && url === "/api/v1/teams/1") {
        deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === "GET" && url === "/api/v1/views/team-load") {
        return Promise.resolve(jsonResponse(200, teamLoadView(deleted ? ROWS.slice(1) : ROWS)));
      }
      if (method === "GET" && url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, PAGE));
      if (method === "GET" && url === "/api/v1/teams/1") return Promise.resolve(jsonResponse(200, DETAIL));
      if (method === "GET" && url.startsWith("/api/v1/people?")) return Promise.resolve(jsonResponse(200, PEOPLE));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Payments" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Payments" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Operations for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete Payments" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Operations for Payments" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Teams" })).toHaveFocus());
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(screen.getByRole("heading", { level: 2, name: "Teams" })).toHaveFocus();
  });

  test("a failed delete keeps the focus in the open dialog; Cancel then returns it to the row's menu button", async () => {
    serve(mockFetch, { "DELETE /api/v1/teams/1": { status: 409, body: { title: "Conflict", status: 409 } } });
    const user = userEvent.setup();
    renderPage();
    const kebab = await screen.findByRole("button", { name: "Operations for Payments" });
    await user.click(kebab);
    await user.click(await screen.findByRole("menuitem", { name: "Delete Payments" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/still referenced elsewhere/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Teams" })).not.toHaveFocus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(kebab).toHaveFocus());
    expect(screen.getByRole("heading", { level: 2, name: "Teams" })).not.toHaveFocus();
  });

  test("a delete dialog opened from the keyboard and dismissed with Escape returns the focus to the row's menu button", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    const kebab = await screen.findByRole("button", { name: "Operations for Payments" });
    kebab.focus();
    await user.keyboard("{Enter}");
    (await screen.findByRole("menuitem", { name: "Delete Payments" })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/"Payments" will be deleted/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(kebab).toHaveFocus());
  });

  test("an edit dialog (opened after a fetch) dismissed with Escape returns the focus to the row's menu button; the New button's dialog returns it to that button", async () => {
    serve(mockFetch);
    const user = userEvent.setup();
    renderPage();
    const kebab = await screen.findByRole("button", { name: "Operations for Payments" });
    kebab.focus();
    await user.keyboard("{Enter}");
    (await screen.findByRole("menuitem", { name: "Edit Payments" })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(kebab).toHaveFocus());

    // A later dialog from a plain button returns to that button, not to the old kebab.
    const newTeam = screen.getByRole("button", { name: /new team/i });
    await user.click(newTeam);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(newTeam).toHaveFocus());
  });
});
