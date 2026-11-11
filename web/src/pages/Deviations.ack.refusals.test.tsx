import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { view } from "../test/deviations";
import { STALE_PROBLEM, ackHarness, acknowledged, keysOf, row } from "../test/deviationsAckHarness";

describe("Deviations page - acknowledge refusals", () => {
  const h = ackHarness();
  const { renderPage, viewCalls, writes } = h;

  describe("refusals", () => {
    test("a 409 stale-deviations is an inline note (not an error alert), the page is re-read and the focus stays put or moves on, never to body", async () => {
      const cancel = vi.spyOn(h.queryClient, "cancelQueries");
      h.onWrite = () => {
        // What the server found: the item no longer deviates, so the re-read takes the row off the Open list.
        h.doc = view({ items: [] });
        return jsonResponse(409, STALE_PROBLEM);
      };
      const user = userEvent.setup();
      renderPage();
      const before = viewCalls().length;
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: End" }));
      const note = await screen.findByText(/The deviations changed since you looked\./);
      expect(note.closest('[role="status"]')).not.toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await waitFor(() => expect(viewCalls().length).toBeGreaterThan(before));
      expect(keysOf(cancel)).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]']));
      await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Differences" })).toHaveFocus());
      // The note belongs to that list: changing the filters drops it, and the next attempt starts clean.
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      await user.click(screen.getByRole("switch", { name: /Show everything/ }));
      await waitFor(() => expect(screen.queryByText(/changed since you looked/)).not.toBeInTheDocument());
    });

    test.each([
      [403, "Only the owner of this plan item, the manager of the milestone's team or an administrator can acknowledge its deviations."],
      [404, "This link no longer exists. The list has been read again."],
      [500, "Action failed (500)"],
    ])("a %i is an inline red message, never a toast and never the stale note", async (status, text) => {
      h.onWrite = () => jsonResponse(status, { title: "x", status });
      const user = userEvent.setup();
      renderPage();
      const button = await screen.findByRole("button", { name: "Acknowledge E2E-3: End" });
      await user.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(screen.queryByText(/changed since you looked/)).not.toBeInTheDocument();
      // The button is still there and still has the focus: a refusal moves nothing.
      expect(screen.getByRole("button", { name: "Acknowledge E2E-3: End" })).toHaveFocus();
    });

    test("the message sits in the cell of the row it is about, not at the top of the page", async () => {
      h.doc = view({ items: [row(1, "E2E-3"), row(2, "E2E-4")] });
      h.onWrite = () => jsonResponse(500, { title: "x", status: 500 });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-4: End" }));
      const alert = await screen.findByRole("alert");
      const table = screen.getByRole("table", { name: "Differences between the plan and Jira" });
      const rows = within(table).getAllByRole("row");
      expect(rows.filter((r) => within(r).queryByRole("alert") !== null)).toHaveLength(1);
      expect(within(rows[2]).getByRole("alert")).toBe(alert);
      expect(rows[2]).toHaveTextContent("Milestone E2E-4");
    });

    test("a message for a row that has left the list is shown above the table instead, and 'Clear the filters' drops it", async () => {
      h.onWrite = () => {
        h.doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, stillInJira: 0, acknowledged: 0 } });
        return jsonResponse(403, { title: "x", status: 403 });
      };
      const user = userEvent.setup();
      renderPage("/deviations?severity=INFO");
      h.doc = view({ items: [row(1, "E2E-3")] });
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: End" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner of this plan item, the manager of the milestone's team or an administrator can acknowledge its deviations.");
      await user.click(await screen.findByRole("button", { name: "Clear the filters" }));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/deviations$/);
    });

    test("a write that settles after the filters changed sets no message on the new list", async () => {
      let release: ((response: Response) => void) | undefined;
      h.onWrite = () => new Promise<Response>((resolve) => (release = resolve));
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: End" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      await user.click(screen.getByRole("switch", { name: /Show everything/ }));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deviations?all=true"));
      release?.(jsonResponse(500, { title: "x", status: 500 }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge E2E-3: End" })).not.toHaveAttribute("aria-disabled"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/changed since you looked/)).not.toBeInTheDocument();
    });

    test("a DELETE's 404 says the acknowledgement was already withdrawn (not that the link is gone), and re-reads the Jira queries", async () => {
      const cancel = vi.spyOn(h.queryClient, "cancelQueries");
      h.doc = view({ items: [row(1, "E2E-3", acknowledged())] });
      h.onWrite = () => jsonResponse(404, { title: "x", status: 404 });
      const user = userEvent.setup();
      renderPage("/deviations?acknowledged=true");
      await user.click(await screen.findByRole("button", { name: "Unacknowledge E2E-3: End" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That acknowledgement was already withdrawn. The list has been read again.");
      expect(screen.queryByText(/no longer exists/)).not.toBeInTheDocument();
      expect(writes()[0][1].method).toBe("DELETE");
      await waitFor(() => expect(keysOf(cancel)).toEqual(['["jira"]']));
    });

    test("a 403 or 404 re-reads the Jira queries only (the rights or the link changed), a 500 re-reads nothing", async () => {
      const cancel = vi.spyOn(h.queryClient, "cancelQueries");
      const user = userEvent.setup();
      renderPage();
      const button = await screen.findByRole("button", { name: "Acknowledge E2E-3: End" });
      h.onWrite = () => jsonResponse(500, { title: "x", status: 500 });
      await user.click(button);
      await screen.findByRole("alert");
      expect(cancel).not.toHaveBeenCalled();
      h.onWrite = () => jsonResponse(403, { title: "x", status: 403 });
      await user.click(screen.getByRole("button", { name: "Acknowledge E2E-3: End" }));
      await waitFor(() => expect(cancel).toHaveBeenCalled());
      expect(keysOf(cancel)).toEqual(['["jira"]']);
    });
  });

});
