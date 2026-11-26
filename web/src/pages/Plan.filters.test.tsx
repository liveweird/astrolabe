import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation, useNavigate } from "react-router-dom";
import Plan from "./Plan";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf, planStatus } from "../test/planView";
import { renderWithProviders } from "../test/render";

const COLLAPSED_KEY = "astrolabe.viewSettings.plan.collapsed";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    ownerPersonId: 4,
    ownerName: "Ola Owner",
    programs: [
      {
        id: 10,
        name: "Billing",
        ownerPersonId: 6,
        ownerName: "Pola Program",
        projects: [
          { id: 100, name: "Invoices", ownerPersonId: 5, ownerName: "Piotr Project" },
          { id: 101, name: "Taxes", ownerPersonId: 8, ownerName: "Tania Tax" },
        ],
      },
      { id: 11, name: "Identity", ownerPersonId: 6, ownerName: "Pola Program", projects: [{ id: 102, name: "Żółw", ownerPersonId: 5, ownerName: "Piotr Project" }] },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31", ownerPersonId: 4, ownerName: "Ola Owner", programs: [{ id: 12, name: "Archive", ownerPersonId: 6, ownerName: "Pola Program", projects: [{ id: 103, name: "Old ledger", ownerPersonId: 5, ownerName: "Piotr Project" }] }] },
]);

/** The address, and a link that changes it from outside the page (as Back or a pasted link would). */
function Where() {
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="where">{useLocation().search}</div>
      <button type="button" onClick={() => navigate("/plan?q=other")}>
        go elsewhere
      </button>
    </>
  );
}

const keys = () =>
  within(screen.getByRole("table", { name: "Work streams, programs and projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-key"));
const row = (key: string) => document.querySelector(`tr[data-key="${key}"]`) as HTMLElement;
const address = () => screen.getByTestId("where").textContent;
const status = planStatus;

function show(route: string) {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": PLAN, "GET /api/v1/views/jira-links": linksView() }));
  return renderWithProviders(
    <>
      <Plan />
      <Where />
    </>,
    { route },
  );
}

describe("Plan page: filters in the address", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a search in the address shows the matches with their way down as dimmed context rows, the matched letters marked", async () => {
    show("/plan?q=tax");
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
    expect(row("ws:1")).toHaveAttribute("data-context", "true");
    expect(row("pg:10")).toHaveAttribute("data-context", "true");
    expect(row("pj:101")).not.toHaveAttribute("data-context");
    expect(row("pj:101").querySelector("mark")).toHaveTextContent("Tax");
    expect(row("pg:10").querySelector("mark")).toBeNull();
    // The counts stay the document's own: Billing holds two projects although one shows.
    expect(within(row("pg:10")).getByText("2 projects")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search work streams, programs and projects" })).toHaveValue("tax");
  });

  test("the search ignores case and accents, and the whole accented word is marked", async () => {
    show("/plan?q=ZOLW");
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:11", "pj:102"]);
    expect(row("pj:102").querySelector("mark")).toHaveTextContent("Żółw");
  });

  test("typing writes the trimmed text to the address after a pause, says how many rows match, and the focus stays in the box", async () => {
    const user = userEvent.setup();
    show("/plan");
    await findPlanTree();
    const box = screen.getByRole("textbox", { name: "Search work streams, programs and projects" });
    await user.click(box);
    await user.type(box, "tax ");
    expect(box).toHaveValue("tax ");
    expect(keys()).toHaveLength(9);
    await waitFor(() => expect(address()).toBe("?q=tax"));
    expect(box).toHaveValue("tax ");
    expect(box).toHaveFocus();
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
    expect(status()).toHaveTextContent("1 row matches");
    await user.type(box, "zzz");
    await waitFor(() => expect(address()).toBe("?q=tax+zzz"));
    expect(status()).toHaveTextContent("No row matches");
  });

  test("the clear button empties the search and brings every row back", async () => {
    const user = userEvent.setup();
    show("/plan?q=tax");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(address()).toBe(""));
    expect(keys()).toHaveLength(9);
  });

  test("while a search runs the stored folds do not apply and are not touched; clearing the search restores them", async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["ws:1"]));
    const user = userEvent.setup();
    show("/plan?q=tax");
    await findPlanTree();
    // Platform is folded in the stored set, yet the way to the match is open ("forced open": aria-expanded true).
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
    expect(screen.getByRole("button", { name: "Work stream Platform" })).toHaveAttribute("aria-expanded", "true");
    // A fold made now is transient: the stored set stays exactly as it was.
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    expect(keys()).toEqual(["ws:1", "pg:10"]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual(["ws:1"]);
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(address()).toBe(""));
    expect(keys()).toEqual(["ws:1", "ws:2", "pg:12", "pj:103"]);
    expect(screen.getByRole("button", { name: "Work stream Platform" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual(["ws:1"]);
  });

  test("another search starts its folds afresh", async () => {
    const user = userEvent.setup();
    show("/plan?q=tax");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Program Billing" }));
    expect(keys()).toEqual(["ws:1", "pg:10"]);
    const box = screen.getByRole("textbox", { name: "Search work streams, programs and projects" });
    await user.clear(box);
    await user.type(box, "tax");
    await waitFor(() => expect(status()).toBeInTheDocument());
    await user.type(box, "e");
    await waitFor(() => expect(address()).toBe("?q=taxe"));
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
  });

  test("Collapse all and Expand all act on the rows a search shows, not on the stored folds", async () => {
    const user = userEvent.setup();
    show("/plan?q=tax");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(keys()).toEqual(["ws:1"]);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
  });

  test("the owner filter shows what that person owns, says so, and lives in the address", async () => {
    const user = userEvent.setup();
    show("/plan");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    expect(screen.getByRole("option", { name: "Tania Tax" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Tania Tax" }));
    expect(address()).toBe("?ownerPersonId=8");
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
    expect(status()).toHaveTextContent("1 row matches");
    // The badge counts the filters that are on.
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");
    await user.click(screen.getByLabelText("Clear the owner filter"));
    expect(address()).toBe("");
    expect(keys()).toHaveLength(9);
  });

  test("an owner the plan does not hold is ignored", async () => {
    show("/plan?ownerPersonId=999");
    await findPlanTree();
    expect(keys()).toHaveLength(9);
  });

  test("Hide closed work streams drops the closed ones, keeps the stored folds, and is not a search", async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["pg:10"]));
    const user = userEvent.setup();
    show("/plan?workStreamId=1");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("switch", { name: "Hide closed work streams" }));
    expect(address()).toBe("?hideClosed=true&workStreamId=1");
    expect(keys()).toEqual(["ws:1", "pg:10", "pg:11", "pj:102"]);
    expect(screen.queryByRole("link", { name: "Open project Old ledger" })).not.toBeInTheDocument();
  });

  test("no row matching shows the empty state, whose button clears every filter and says so", async () => {
    const user = userEvent.setup();
    show("/plan?q=nothing&hideClosed=true&ownerPersonId=4");
    expect(await screen.findByText("No row matches")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(address()).toBe(""));
    expect(keys()).toHaveLength(9);
    expect(status()).toHaveTextContent("Filters cleared");
    expect(screen.getByRole("textbox", { name: "Search work streams, programs and projects" })).toHaveValue("");
  });

  test("a filtered plan carries the print-only line; the whole plan does not", async () => {
    const first = show("/plan?q=tax");
    await findPlanTree();
    const line = screen.getByText("Filtered view: not every row of the plan is shown.");
    expect(line).toHaveAttribute("data-print", "only");
    first.unmount();
    show("/plan");
    await findPlanTree();
    expect(screen.queryByText("Filtered view: not every row of the plan is shown.")).not.toBeInTheDocument();
  });

  test("an address changed from outside replaces the text in the box and the rows", async () => {
    const user = userEvent.setup();
    show("/plan?q=tax");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "go elsewhere" }));
    expect(screen.getByRole("textbox", { name: "Search work streams, programs and projects" })).toHaveValue("other");
    expect(await screen.findByText("No row matches")).toBeInTheDocument();
  });

  test("a Hide closed made within the pause of a keystroke is not undone by the delayed search write", async () => {
    const user = userEvent.setup();
    show("/plan");
    await findPlanTree();
    await user.type(screen.getByRole("textbox", { name: "Search work streams, programs and projects" }), "tax");
    // Synchronously, so the 300 ms pause has certainly not run out.
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("switch", { name: "Hide closed work streams" }));
    await waitFor(() => expect(address()).toBe("?q=tax&hideClosed=true"));
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
  });

  test("Clear filters pressed within the pause of a keystroke wins: the address stays empty, and the focus goes to the box", async () => {
    show("/plan?q=nothing");
    expect(await screen.findByText("No row matches")).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Search work streams, programs and projects" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(box, { target: { value: "nothingx" } });
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      // Well past the pause: the write the keystroke scheduled must have been cancelled.
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }
    expect(address()).toBe("");
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(keys()).toHaveLength(9);
  });

  test("a stale owner in the address is dropped by the next change, and a long search is cut to one name", async () => {
    const user = userEvent.setup();
    show("/plan?ownerPersonId=999");
    await findPlanTree();
    const box = screen.getByRole("textbox", { name: "Search work streams, programs and projects" });
    expect(box).toHaveAttribute("maxlength", "100");
    await user.type(box, "tax");
    await waitFor(() => expect(address()).toBe("?q=tax"));
  });

  test("a search that folds to nothing (a lone accent mark) is no search", async () => {
    show("/plan?q=%CC%81");
    await findPlanTree();
    expect(keys()).toHaveLength(9);
    expect(document.querySelector('tr[data-context="true"]')).toBeNull();
  });

  test("a context row says so in words, a match does not (colour is not the only cue)", async () => {
    show("/plan?q=tax");
    await findPlanTree();
    expect(within(row("ws:1")).getByText("Contains a match")).toBeInTheDocument();
    expect(within(row("pg:10")).getByText("Contains a match")).toBeInTheDocument();
    expect(within(row("pj:101")).queryByText("Contains a match")).not.toBeInTheDocument();
  });

  test("Collapse all and Expand all with only Hide closed on keep the folds of the hidden closed streams", async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["ws:2", "pg:12"]));
    const user = userEvent.setup();
    show("/plan?hideClosed=true");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(keys()).toEqual(["ws:1"]);
    expect([...(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!) as string[])].sort()).toEqual(["pg:10", "pg:11", "pg:12", "ws:1", "ws:2"]);
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(keys()).toHaveLength(6);
    expect([...(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!) as string[])].sort()).toEqual(["pg:12", "ws:2"]);
  });
});
