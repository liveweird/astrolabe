import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "../test/render";
import { DEV_CONNECTION, endLater, startEarlier, stamped, view } from "../test/deviations";
import { ackHarness, row } from "../test/deviationsAckHarness";

describe("Deviations page - the Status filter, totals and empty Open list", () => {
  const h = ackHarness();
  const { renderPage, viewCalls } = h;

  describe("the Status filter", () => {
    const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
      await user.click(screen.getByRole("combobox", { name: "Status" }));
      await user.click(await screen.findByRole("option", { name }));
    };

    test("Open is the default and sends no parameter; Acknowledged sends acknowledged=true; All sends all=true; Open again sends nothing", async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("table", { name: "Differences between the plan and Jira" });
      expect(viewCalls()[0]).toBe("/api/v1/views/deviations");
      await user.click(screen.getByRole("button", { name: "Filters" }));
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("Open");
      await pick(user, "Acknowledged");
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?acknowledged=true"));
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?acknowledged=true"));
      await pick(user, "All");
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?all=true"));
      await pick(user, "Open");
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations"));
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/deviations$/);
    });

    test("it composes with a project scope as the server does: the scope reads All, Open sends the all=false override, Acknowledged keeps the scope", async () => {
      const user = userEvent.setup();
      renderPage("/deviations?projectId=7");
      await screen.findByRole("table", { name: "Differences between the plan and Jira" });
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("All");
      expect(viewCalls()[0]).toBe("/api/v1/views/deviations?projectId=7");
      await pick(user, "Open");
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?projectId=7&all=false"));
      await pick(user, "Acknowledged");
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?projectId=7&acknowledged=true"));
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("Acknowledged");
    });

    test("a scope added while Open keeps the list Open (the all=false override), and the Status still reads Open", async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("table", { name: "Differences between the plan and Jira" });
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      await user.click(screen.getByRole("combobox", { name: "Team" }));
      await user.click(await screen.findByRole("option", { name: "Backend" }));
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?teamId=3&all=false"));
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("Open");
    });

    test("Open under a project scope (all=false) loses the override with the chip, and the list is still Open", async () => {
      const user = userEvent.setup();
      renderPage("/deviations?projectId=7&all=false");
      await user.click(await screen.findByRole("button", { name: "Remove the project filter" }));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/deviations$/));
      expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations");
    });

    test("the All a project scope only implied goes with the chip: removing it falls back to the default Open list, while an explicit all=true stays", async () => {
      const user = userEvent.setup();
      renderPage("/deviations?projectId=7");
      await user.click(await screen.findByRole("button", { name: "Remove the project filter" }));
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations"));
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("Open");
      await user.click(screen.getByRole("combobox", { name: "Status" }));
      await user.click(await screen.findByRole("option", { name: "All" }));
      await waitFor(() => expect(viewCalls().at(-1)).toBe("/api/v1/views/deviations?all=true"));
    });

    test("a link with acknowledged=true opens on Acknowledged, and the Status choice counts as a filter on the panel's toggle", async () => {
      renderPage("/deviations?acknowledged=true");
      await screen.findByRole("table", { name: "Differences between the plan and Jira" });
      expect(viewCalls()[0]).toBe("/api/v1/views/deviations?acknowledged=true");
      expect(within(screen.getByRole("button", { name: /Filters/ })).getByText("1")).toBeInTheDocument();
    });
  });

  describe("the totals and the empty Open list", () => {
    test("the totals gain 'N acknowledged' (gray), and a list that can show more than the open items says the figures are open-only", async () => {
      h.doc = view({ items: [row(1, "E2E-3")], totals: { warnings: 1, infos: 0, bindings: 1, gone: 0, stillInJira: 0, acknowledged: 2 } });
      renderPage();
      expect(await screen.findByText("2 acknowledged")).toBeInTheDocument();
      expect(screen.queryByText(/count open items only/)).not.toBeInTheDocument();
      renderPage("/deviations?all=true");
      expect(await screen.findByText(/figures count open items only/)).toBeInTheDocument();
    });

    test("with every deviation acknowledged the Open list says nothing is open and where the hidden ones are - not the dated 'no deviations' claim", async () => {
      h.doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, stillInJira: 0, acknowledged: 2 } });
      renderPage();
      expect(await screen.findByText("Nothing is open.")).toBeInTheDocument();
      expect(screen.getByText(/2 acknowledged items are hidden/)).toBeInTheDocument();
      expect(screen.queryByText(/No deviations in the data read/)).not.toBeInTheDocument();
    });

    test("an acknowledged filter that matches nothing is not 'nothing here is linked', even under a scope that implies all", async () => {
      h.doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, stillInJira: 0, acknowledged: 0 } });
      renderPage("/deviations?projectId=7&acknowledged=true");
      expect(await screen.findByText("No items match the filters.")).toBeInTheDocument();
      expect(screen.queryByText("Nothing here is linked to Jira yet.")).not.toBeInTheDocument();
    });
  });

  test("a row listed under Acknowledged shows EVERY line with its own state: the acknowledged one offers Unacknowledge, the open one still offers Acknowledge", async () => {
    h.doc = view({ items: [row(1, "E2E-3", { deviations: [stamped(endLater(3)), startEarlier()] })] });
    renderPage("/deviations?acknowledged=true");
    expect(await screen.findByRole("button", { name: "Unacknowledge E2E-3: End" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge E2E-3: Start" })).toBeInTheDocument();
    expect(screen.getByText("Acknowledged by Ada Lovelace on 2026-11-06")).toBeInTheDocument();
    // One line of each state: no batch button.
    expect(screen.queryByRole("button", { name: /all \(/ })).not.toBeInTheDocument();
  });

  test("the Jira connection's own data is untouched by the Status filter (the sources table still renders)", async () => {
    renderPage("/deviations?acknowledged=true");
    expect(await screen.findByRole("table", { name: "Data from Jira" })).toHaveTextContent(DEV_CONNECTION.name);
  });
});
