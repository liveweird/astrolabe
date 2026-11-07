import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "../test/render";
import { jsonResponse } from "../test/http";
import { view } from "../test/deviations";
import { programsViewKey } from "../api/programs";
import { roadmapViewKey } from "../api/roadmap";
import { projectViewKey } from "../hooks/useMilestoneSchedule";
import { teamViewKey } from "../hooks/useTeamSchedule";
import { AT, ackHarness, acknowledged, isPrefix, keyArraysOf, keysOf, row } from "../test/deviationsAckHarness";

describe("Deviations page - acknowledge and unacknowledge", () => {
  const h = ackHarness();
  const { renderPage, viewCalls, writes } = h;

  describe("acknowledging", () => {
    test("Acknowledge POSTs exactly the fingerprint of the row as read, then the page, the Jira keys AND the timeline views are re-read", async () => {
      const cancel = vi.spyOn(h.queryClient, "cancelQueries");
      const invalidate = vi.spyOn(h.queryClient, "invalidateQueries");
      h.onWrite = () => {
        h.doc = view({ items: [], totals: { warnings: 0, infos: 0, bindings: 0, gone: 0, acknowledged: 1 } });
        return jsonResponse(200, { bindingId: 1, fingerprint: "1".repeat(64), acknowledgedAt: AT, acknowledgedBy: "Ada Lovelace" });
      };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      const [url, init] = writes()[0];
      expect(url).toBe("/api/v1/integrations/jira/bindings/1/acknowledge");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ fingerprint: "1".repeat(64) });
      await waitFor(() => expect(screen.getByText("Nothing is open.")).toBeInTheDocument());
      // The Jira queries (the page itself), and the flags every timeline view carries: plan/project/team under ["plan"], roadmap/programs under ["roadmap"].
      expect(keysOf(cancel)).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]']));
      expect(keysOf(invalidate)).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]']));
      expect(viewCalls().length).toBeGreaterThan(1);
    });

    test("a row that leaves the Open list hands the focus to the next row's button; the last row, to the previous one", async () => {
      h.doc = view({ items: [row(1, "E2E-3"), row(2, "E2E-4"), row(3, "E2E-5")] });
      h.onWrite = (_method, id) => {
        h.doc = view({ items: h.doc.items.filter((i) => i.bindingId !== id) });
        return jsonResponse(200, { bindingId: id, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: null });
      };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-4" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge E2E-4" })).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge E2E-5" })).toHaveFocus());
      await user.click(screen.getByRole("button", { name: "Acknowledge E2E-5" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge E2E-3" })).toHaveFocus());
    });

    test("the last row of the list: the focus goes to the list's heading, never to body", async () => {
      h.onWrite = () => {
        h.doc = view({ items: [] });
        return jsonResponse(200, { bindingId: 1, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: null });
      };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3" }));
      await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Differences" })).toHaveFocus());
      expect(document.body).not.toHaveFocus();
    });

    test("a row that stays in the list (All) keeps the focus on its own button, which now offers Unacknowledge", async () => {
      h.doc = view({ items: [row(1, "E2E-3"), row(2, "E2E-4")] });
      h.onWrite = (_method, id) => {
        h.doc = view({ items: h.doc.items.map((i) => (i.bindingId === id ? { ...i, ...acknowledged() } : i)) });
        return jsonResponse(200, { bindingId: id, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: "Ada Lovelace" });
      };
      const user = userEvent.setup();
      renderPage("/deviations?all=true");
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3" }));
      const button = await screen.findByRole("button", { name: "Unacknowledge E2E-3" });
      await waitFor(() => expect(button).toHaveFocus());
      expect(screen.getByText("Acknowledged by Ada Lovelace on 2026-11-06")).toBeInTheDocument();
    });

    test("a row the user has no rights on gets no button, and neither does a clean one under 'all'", async () => {
      h.doc = view({ items: [row(1, "E2E-3", { can: { acknowledge: false } }), row(2, "E2E-4", { deviations: [] }), row(3, "E2E-5")] });
      renderPage("/deviations?all=true");
      await screen.findByRole("table", { name: "Differences between the plan and Jira" });
      expect(screen.getAllByRole("button", { name: /^Acknowledge E2E-/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Acknowledge E2E-5"]);
    });

    test("a second click while the write runs is ignored", async () => {
      let release: ((response: Response) => void) | undefined;
      h.onWrite = () => new Promise<Response>((resolve) => (release = resolve));
      const user = userEvent.setup();
      renderPage();
      const button = await screen.findByRole("button", { name: "Acknowledge E2E-3" });
      await user.click(button);
      await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
      await user.click(button);
      expect(writes()).toHaveLength(1);
      release?.(jsonResponse(200, { bindingId: 1, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: null }));
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    });

    test("the refreshed keys are prefixes of the REAL keys of the roadmap, programs, project and team views (so a renamed key breaks this test, not the flags)", async () => {
      const invalidate = vi.spyOn(h.queryClient, "invalidateQueries");
      h.onWrite = () => {
        h.doc = view({ items: [] });
        return jsonResponse(200, { bindingId: 1, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: null });
      };
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3" }));
      await waitFor(() => expect(keysOf(invalidate)).toEqual(expect.arrayContaining(['["jira"]', '["plan"]', '["roadmap"]'])));
      const refreshed = keyArraysOf(invalidate);
      for (const real of [roadmapViewKey(null), programsViewKey(null), projectViewKey(7, null), teamViewKey(3, null), ["jira", "deviations", "view", {}]]) {
        expect(refreshed.some((prefix) => isPrefix(prefix, real)), JSON.stringify(real)).toBe(true);
      }
    });

    test("Enter on the button of a write that is still running is ignored too (aria-disabled keeps the focus, so the key reaches it)", async () => {
      let release: ((response: Response) => void) | undefined;
      h.onWrite = () => new Promise<Response>((resolve) => (release = resolve));
      const user = userEvent.setup();
      renderPage();
      const button = await screen.findByRole("button", { name: "Acknowledge E2E-3" });
      await user.click(button);
      await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
      expect(button).toHaveFocus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      expect(writes()).toHaveLength(1);
      release?.(jsonResponse(200, { bindingId: 1, fingerprint: "x", acknowledgedAt: AT, acknowledgedBy: null }));
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    });
  });

  describe("unacknowledging", () => {
    test("Unacknowledge DELETEs with no body; in the Acknowledged list the row leaves and the next one takes the focus", async () => {
      h.doc = view({ items: [row(1, "E2E-3", acknowledged()), row(2, "E2E-4", acknowledged())] });
      h.onWrite = (_method, id) => {
        h.doc = view({ items: h.doc.items.filter((i) => i.bindingId !== id) });
        return new Response(null, { status: 204 });
      };
      const user = userEvent.setup();
      renderPage("/deviations?acknowledged=true");
      await user.click(await screen.findByRole("button", { name: "Unacknowledge E2E-3" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0][0]).toBe("/api/v1/integrations/jira/bindings/1/acknowledge");
      expect(writes()[0][1].method).toBe("DELETE");
      expect(writes()[0][1].body).toBeUndefined();
      await waitFor(() => expect(screen.getByRole("button", { name: "Unacknowledge E2E-4" })).toHaveFocus());
    });

    test("a stale acknowledgement reads 'changed since', the item is open again, and Acknowledge is offered (not Unacknowledge)", async () => {
      h.doc = view({ items: [row(1, "E2E-3", { acknowledgement: { at: AT, by: "Ada Lovelace", current: false } })] });
      renderPage();
      expect(await screen.findByText("Acknowledged on 2026-11-06 by Ada Lovelace · changed since")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Acknowledge E2E-3" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Unacknowledge E2E-3" })).not.toBeInTheDocument();
    });
  });

});
