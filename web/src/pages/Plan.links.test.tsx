import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import Plan from "./Plan";
import { routeFetch } from "../test/http";
import { linksView } from "../test/jiraLinks";
import { findPlanTree, planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The Plan tree's names as links (1.31): a work stream or program leads to the Roadmap overview narrowed to it, a project to its page, an owner to the person;
// the disclosure button is chevron-only beside the name, and a pinned row's links carry the "(pinned)" suffix like its other controls.

const PLAN = planOf([
  { id: 1, name: "Platform", ownerPersonId: 4, ownerName: "Ola Owner", programs: [{ id: 10, name: "Billing", ownerPersonId: 6, ownerName: "Pola Program", projects: [{ id: 100, name: "Invoices", ownerPersonId: 5, ownerName: "Piotr Project" }] }] },
  { id: 2, name: "Legacy", programs: [{ id: 12, name: "Archive" }] },
]);

const row = (key: string) => within(screen.getByRole("table", { name: "Work streams, programs and projects" })).getAllByRole("row").find((candidate) => candidate.getAttribute("data-key") === key)!;

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": PLAN, "GET /api/v1/views/jira-links": linksView() }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Plan page: the names are links", () => {
  test("a work stream, a program and a project each link to their page, and each owner to the person", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(within(row("ws:1")).getByRole("link", { name: "Open work stream Platform" })).toHaveAttribute("href", "/roadmap?mode=overview&workStreamId=1");
    expect(within(row("pg:10")).getByRole("link", { name: "Open program Billing" })).toHaveAttribute("href", "/roadmap?mode=overview&programId=10");
    expect(within(row("pj:100")).getByRole("link", { name: "Open project Invoices" })).toHaveAttribute("href", "/projects/100");
    expect(within(row("ws:1")).getByRole("link", { name: "Open person Ola Owner" })).toHaveAttribute("href", "/people/4");
    expect(within(row("pg:10")).getByRole("link", { name: "Open person Pola Program" })).toHaveAttribute("href", "/people/6");
    expect(within(row("pj:100")).getByRole("link", { name: "Open person Piotr Project" })).toHaveAttribute("href", "/people/5");
  });

  test("the disclosure button is the chevron alone, named by its level, and folding does not follow the link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Plan />);
    await findPlanTree();
    const stream = row("ws:1");
    const button = within(stream).getByRole("button", { name: "Work stream Platform" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveTextContent("");
    expect(button.contains(within(stream).getByRole("link", { name: "Open work stream Platform" }))).toBe(false);
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(row("ws:1").querySelector("a[href='/roadmap?mode=overview&workStreamId=1']")).not.toBeNull();
  });

  test("a childless node has no button, only the link", async () => {
    renderWithProviders(<Plan />);
    await findPlanTree();
    expect(within(row("pg:12")).queryByRole("button", { name: /^Program / })).toBeNull();
    expect(within(row("pg:12")).getByRole("link", { name: "Open program Archive" })).toHaveAttribute("href", "/roadmap?mode=overview&programId=12");
  });
});
