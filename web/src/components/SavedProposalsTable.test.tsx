import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import SavedProposalsTable from "./SavedProposalsTable";
import { savedProposalKey } from "../api/savedProposals";
import { SAVED, SAVED_RECORD, SAVED_URL } from "../test/crossTeamRun";
import { headingOutline } from "../test/headings";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";

let items: unknown[];
let deleteAnswer: Response;
let listAnswer: Response | null;
let mockFetch: ReturnType<typeof routeFetch>;

const OTHER = { ...SAVED, id: 6, name: "Hands off", createdBy: null, teams: [{ id: 3, name: "Billing" }], can: { delete: false } };
const deletes = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([url]) => String(url));

beforeEach(() => {
  items = [SAVED, OTHER];
  deleteAnswer = new Response(null, { status: 204 });
  listAnswer = null;
  mockFetch = routeFetch({
    [`GET ${SAVED_URL}`]: () => listAnswer ?? { items },
    [`DELETE ${SAVED_URL}/:id`]: () => deleteAnswer,
  });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SavedProposalsTable", () => {
  test("lists the saved proposals under an h3: the name is the link, the teams, the day, the ticked moves, who and when; Delete only where the row's can allows", async () => {
    renderWithProviders(<SavedProposalsTable />);
    const table = await screen.findByRole("table", { name: "Saved proposals" });
    expect(headingOutline()).toEqual([[3, "Saved proposals"]]);
    expect(await within(table).findByRole("link", { name: "Open Q1 plan" })).toHaveAttribute("href", "/schedule-proposals/saved/5");
    const row = within(table).getByRole("link", { name: "Open Q1 plan" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Platform, Payments")).toBeInTheDocument();
    expect(within(row).getByText("2042-01-05")).toBeInTheDocument();
    expect(within(row).getByText("2 of 3")).toBeInTheDocument();
    expect(within(row).getByText("Ada")).toBeInTheDocument();
    expect(within(row).getByText("2042-01-05 09:30")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete Q1 plan" })).toBeInTheDocument();
    const other = within(table).getByRole("link", { name: "Open Hands off" }).closest("tr") as HTMLElement;
    expect(within(other).queryByRole("button")).toBeNull();
    expect(within(other).getByText("—")).toBeInTheDocument();
  });

  test("who saved it is the person's page while the login has an active person, plain text when it has none; the teams are text (the list cannot tell a gone team)", async () => {
    items = [{ ...SAVED, createdBy: { userId: 3, name: "Ada", personId: 9 } }, { ...OTHER, createdBy: { userId: 4, name: "Bob", personId: null } }];
    renderWithProviders(<SavedProposalsTable />);
    const table = await screen.findByRole("table", { name: "Saved proposals" });
    expect(await within(table).findByRole("link", { name: "Open person Ada" })).toHaveAttribute("href", "/people/9");
    expect(within(table).getByText("Bob")).toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: /Open (person Bob|team )/ })).toBeNull();
  });

  test("an empty list says so", async () => {
    items = [];
    renderWithProviders(<SavedProposalsTable />);
    expect(await screen.findByText("No saved proposals yet")).toBeInTheDocument();
  });

  test("a failed load is an inline alert, not an empty list", async () => {
    listAnswer = jsonResponse(500, { title: "Boom", status: 500 });
    renderWithProviders(<SavedProposalsTable />);
    expect(await screen.findByText("Could not load the saved proposals")).toBeInTheDocument();
    expect(screen.queryByText("No saved proposals yet")).toBeNull();
  });

  test("Delete confirms in a dialog, deletes by id and reloads the list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavedProposalsTable />);
    await user.click(await screen.findByRole("button", { name: "Delete Q1 plan" }));
    expect(await screen.findByText("Delete the saved proposal “Q1 plan”? The plan is not affected.")).toBeInTheDocument();
    items = [OTHER];
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open Q1 plan" })).toBeNull());
    expect(deletes()).toEqual([`${SAVED_URL}/5`]);
  });

  test("a delete (and a delete that finds the row gone) drops that proposal's page copy from the cache, so it cannot be opened for an Accept", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const status of [204, 404]) {
      deleteAnswer = status === 204 ? new Response(null, { status }) : jsonResponse(404, { title: "Not Found", status: 404 });
      client.setQueryData(savedProposalKey(5), SAVED_RECORD);
      const user = userEvent.setup();
      const { unmount } = renderWithProviders(<SavedProposalsTable />, { queryClient: client });
      await user.click(await screen.findByRole("button", { name: "Delete Q1 plan" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(client.getQueryData(savedProposalKey(5))).toBeUndefined());
      unmount();
    }
  });

  test("after a delete the focus goes to the section heading; a cancel never leaves it on the body (the opener or the heading)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavedProposalsTable />);
    const open = await screen.findByRole("button", { name: "Delete Q1 plan" });
    await user.click(open);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    const heading = screen.getByRole("heading", { level: 3, name: "Saved proposals" });
    await waitFor(() => expect([open, heading]).toContain(document.activeElement));
    await user.click(open);
    items = [OTHER];
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Saved proposals" })).toHaveFocus());
  });

  test("a delete that finds the row gone says so in the dialog and reloads the list", async () => {
    deleteAnswer = jsonResponse(404, { title: "Not Found", status: 404 });
    const user = userEvent.setup();
    renderWithProviders(<SavedProposalsTable />);
    await user.click(await screen.findByRole("button", { name: "Delete Q1 plan" }));
    items = [OTHER];
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("dialog")).findByText("This saved proposal is already gone — the list was reloaded")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open Q1 plan" })).toBeNull());
  });

  test("a 403 on delete is worded in the dialog and the row stays", async () => {
    deleteAnswer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderWithProviders(<SavedProposalsTable />);
    await user.click(await screen.findByRole("button", { name: "Delete Q1 plan" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("dialog")).findByText("Only an administrator or the manager of every team in it can delete a saved proposal")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Q1 plan" })).toBeInTheDocument();
  });
});
