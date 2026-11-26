import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import Plan from "./Plan";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf, planStatus } from "../test/planView";
import { renderWithProviders } from "../test/render";

const PLAN = planOf([
  {
    id: 1,
    name: "Platform",
    programs: [
      { id: 10, name: "Billing", projects: [{ id: 100, name: "Invoices" }, { id: 101, name: "Taxes" }] },
      { id: 11, name: "Identity", projects: [{ id: 102, name: "Login" }] },
    ],
  },
  { id: 2, name: "Legacy", endDate: "2025-12-31", programs: [{ id: 12, name: "Archive", projects: [{ id: 103, name: "Old taxes" }] }] },
]);

function Where() {
  return <div data-testid="where">{useLocation().search}</div>;
}

const keys = () =>
  within(screen.getByRole("table", { name: "Work streams, programs and projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-key"));
const address = () => screen.getByTestId("where").textContent;
const status = planStatus;
const crumbs = () => within(screen.getByRole("navigation", { name: "Part of the plan shown" }));

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

describe("Plan page: Show only this", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("a work stream in the address restricts the table to it and what is under it, with a breadcrumb", async () => {
    show("/plan?workStreamId=1");
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102"]);
    expect(crumbs().getByRole("link", { name: "All work streams" })).toHaveAttribute("href", "/plan");
    expect(crumbs().getByText("Platform")).toHaveAttribute("aria-current", "location");
    expect(crumbs().queryByRole("link", { name: "Platform" })).not.toBeInTheDocument();
  });

  test("the focus root has no disclosure button (it is always open) and no Show only this", async () => {
    const user = userEvent.setup();
    show("/plan?workStreamId=1");
    await findPlanTree();
    expect(screen.queryByRole("button", { name: "Work stream Platform" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Program Billing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Operations for Platform" }));
    expect((await screen.findAllByRole("menuitem")).map((el) => el.getAttribute("aria-label"))).toEqual(["Pin: Platform", "Edit Platform", "Close work stream Platform", "Import from Jira into Platform", "Delete Platform"]);
  });

  test("a program in the address starts the table at the program; its breadcrumb steps back to the work stream", async () => {
    show("/plan?programId=10");
    await findPlanTree();
    expect(keys()).toEqual(["pg:10", "pj:100", "pj:101"]);
    expect(crumbs().getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/plan?workStreamId=1");
    expect(crumbs().getByText("Billing")).toHaveAttribute("aria-current", "location");
  });

  test("a focus on something the plan does not hold shows the whole plan, with no breadcrumb", async () => {
    show("/plan?programId=999");
    await findPlanTree();
    expect(keys()).toHaveLength(9);
    expect(screen.queryByRole("navigation", { name: "Part of the plan shown" })).not.toBeInTheDocument();
  });

  test("Show only this is a real link that keeps the filters, narrows the table, says so, and leaves the focus on the menu button", async () => {
    const user = userEvent.setup();
    show("/plan?hideClosed=true");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Operations for Identity" }));
    const link = await screen.findByRole("menuitem", { name: "Show only this: Identity" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/plan?hideClosed=true&programId=11");
    await user.click(link);
    expect(address()).toBe("?hideClosed=true&programId=11");
    expect(keys()).toEqual(["pg:11", "pj:102"]);
    expect(status()).toHaveTextContent("Showing only Identity");
    await waitFor(() => expect(screen.getByRole("button", { name: "Operations for Identity" })).toHaveFocus());
  });

  test("the breadcrumb leads back to the whole plan: it says so and sends the focus to the row of the node that was focused", async () => {
    const user = userEvent.setup();
    show("/plan?programId=10&q=tax");
    await findPlanTree();
    expect(keys()).toEqual(["pg:10", "pj:101"]);
    await user.click(crumbs().getByRole("link", { name: "All work streams" }));
    expect(address()).toBe("?q=tax");
    expect(status()).toHaveTextContent("Showing the whole plan");
    await waitFor(() => expect(document.querySelector('tr[data-scope="tree"][data-key="pg:10"] button')).toHaveFocus());
    expect(screen.queryByRole("navigation", { name: "Part of the plan shown" })).not.toBeInTheDocument();
  });

  test("a step back up the breadcrumb widens a program focus to its work stream", async () => {
    const user = userEvent.setup();
    show("/plan?programId=10");
    await findPlanTree();
    await user.click(crumbs().getByRole("link", { name: "Platform" }));
    expect(address()).toBe("?workStreamId=1");
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:100", "pj:101", "pg:11", "pj:102"]);
    expect(status()).toHaveTextContent("Showing only Platform");
    // The focus goes back to the row of the node the user left (the program), not to the step's own row.
    await waitFor(() => expect(document.querySelector('tr[data-scope="tree"][data-key="pg:10"] button')).toHaveFocus());
  });

  test("a ctrl-click on a breadcrumb step opens it elsewhere: nothing is said and no focus move waits for the next address change", async () => {
    const user = userEvent.setup();
    show("/plan?programId=10");
    await findPlanTree();
    await user.keyboard("{Control>}");
    await user.click(crumbs().getByRole("link", { name: "All work streams" }));
    await user.keyboard("{/Control}");
    expect(address()).toBe("?programId=10");
    expect(status()).toHaveTextContent("");
    // A later, unrelated address change (the search) leaves the focus in the box.
    const box = screen.getByRole("textbox", { name: "Search work streams, programs and projects" });
    await user.type(box, "tax");
    await waitFor(() => expect(address()).toBe("?q=tax&programId=10"));
    expect(box).toHaveFocus();
  });

  test("a ctrl-click on Show only this says nothing", async () => {
    const user = userEvent.setup();
    show("/plan");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Operations for Billing" }));
    const item = await screen.findByRole("menuitem", { name: "Show only this: Billing" });
    await user.keyboard("{Control>}");
    await user.click(item);
    await user.keyboard("{/Control}");
    expect(status()).toHaveTextContent("");
  });

  test("an unknown program falls back to a valid work stream of the same address", async () => {
    show("/plan?programId=99&workStreamId=2");
    await findPlanTree();
    expect(keys()).toEqual(["ws:2", "pg:12", "pj:103"]);
    expect(crumbs().getByText("Legacy")).toBeInTheDocument();
  });

  test("a program focus has nothing to fold, and Collapse all under a work stream focus folds its programs, never the root", async () => {
    const user = userEvent.setup();
    const first = show("/plan?programId=10");
    await findPlanTree();
    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    first.unmount();
    show("/plan?workStreamId=1");
    await findPlanTree();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(JSON.parse(localStorage.getItem("astrolabe.viewSettings.plan.collapsed") ?? "null")).toEqual(["pg:10", "pg:11"]);
  });

  test("a search inside a focus stays inside it, and Clear filters keeps the focus", async () => {
    const user = userEvent.setup();
    show("/plan?workStreamId=1&q=tax");
    await findPlanTree();
    expect(keys()).toEqual(["ws:1", "pg:10", "pj:101"]);
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(address()).toBe("?workStreamId=1"));
    expect(keys()).toHaveLength(6);
  });

  test("an empty search inside a focus offers Clear filters, which keeps the focus", async () => {
    const user = userEvent.setup();
    show("/plan?programId=11&q=zzz");
    expect(await screen.findByText("No row matches")).toBeInTheDocument();
    expect(crumbs().getByText("Identity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(address()).toBe("?programId=11"));
    expect(keys()).toEqual(["pg:11", "pj:102"]);
  });

  test("a focused plan prints with the filtered-view line", async () => {
    show("/plan?workStreamId=2");
    await findPlanTree();
    expect(screen.getByText("Filtered view: not every row of the plan is shown.")).toHaveAttribute("data-print", "only");
    expect(keys()).toEqual(["ws:2", "pg:12", "pj:103"]);
  });
});
