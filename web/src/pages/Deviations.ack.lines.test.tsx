import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "../test/render";
import { jsonResponse } from "../test/http";
import { endLater, renamed, startEarlier, stamped, view } from "../test/deviations";
import type { DeviationItem } from "../api/deviations";
import { AT, STALE_PROBLEM, ackHarness, row } from "../test/deviationsAckHarness";

const TABLE = "Differences between the plan and Jira";
const fingerprint = (id: number) => String(id).repeat(64).slice(0, 64);

describe("Deviations page - per-line acknowledge, Acknowledge all (N) and Withdraw all (N)", () => {
  const h = ackHarness();
  const { renderPage, writes } = h;
  const withLines = (id: number, key: string, deviations: DeviationItem["deviations"], over: Partial<DeviationItem> = {}) => row(id, key, { deviations, ...over });
  /** Re-stamp (or clear) the kinds of one item in the document the view answers next. */
  const restamp = (id: number, stampedKinds: readonly string[]) => {
    h.doc = view({
      items: h.doc.items.map((i) => (i.bindingId !== id ? i : { ...i, deviations: i.deviations.map((line) => (stampedKinds.includes(line.kind) ? stamped({ ...line, acknowledgement: null }) : { ...line, acknowledgement: null })) })),
    });
  };
  const ok = (id: number) => jsonResponse(200, { bindingId: id, kind: null, fingerprint: fingerprint(id), acknowledgedAt: AT, acknowledgedBy: "Ada Lovelace" });

  test("every line of a row has its own button; acknowledging one POSTs {fingerprint, kind}, the row stays (every line shows, whatever the Status) and the other line is still open", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()])] });
    h.onWrite = (_method, id) => {
      restamp(id, ["START_DIFFERS"]);
      return ok(id);
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: Start" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ fingerprint: fingerprint(1), kind: "START_DIFFERS" });
    const button = await screen.findByRole("button", { name: "Unacknowledge E2E-3: Start" });
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.getByText("Acknowledged by Ada Lovelace on 2026-11-06")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge E2E-3: End" })).toBeInTheDocument();
    // One open line left: its own button only.
    expect(screen.queryByRole("button", { name: /^Acknowledge all/ })).not.toBeInTheDocument();
  });

  test("the batch buttons show their counts at two lines of a state; N is the lines the row lists, and a stale stamp is open", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier(), renamed(), stamped({ ...endLater(1), kind: "TARGET_DIFFERS" }), stamped({ ...endLater(1), kind: "PROGRESS_MISMATCH" })]), withLines(2, "E2E-4", [endLater(2), stamped(startEarlier(), { current: false })])] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Acknowledge all (3) open deviations of E2E-3" })).toHaveTextContent("Acknowledge all (3)");
    expect(screen.getByRole("button", { name: "Withdraw all (2) acknowledged deviations of E2E-3" })).toHaveTextContent("Withdraw all (2)");
    // E2E-4: one open line and one stale stamp = two open lines; nothing currently acknowledged.
    expect(screen.getByRole("button", { name: "Acknowledge all (2) open deviations of E2E-4" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Withdraw all .* of E2E-4/ })).not.toBeInTheDocument();
    expect(screen.getByText("Acknowledged on 2026-11-06 by Ada Lovelace · changed since")).toBeInTheDocument();
  });

  test("Acknowledge all POSTs the fingerprint with NO kind, then offers Withdraw all (N) on the same key and keeps the focus there", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()])] });
    h.onWrite = (_method, id) => {
      restamp(id, ["END_DIFFERS", "START_DIFFERS"]);
      return ok(id);
    };
    const user = userEvent.setup();
    renderPage();
    const all = await screen.findByRole("button", { name: "Acknowledge all (2) open deviations of E2E-3" });
    expect(all).toHaveAttribute("data-ack-for", "1:all");
    await user.click(all);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe("/api/v1/integrations/jira/bindings/1/acknowledge");
    expect(writes()[0][1].method).toBe("POST");
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ fingerprint: fingerprint(1) });
    const withdraw = await screen.findByRole("button", { name: "Withdraw all (2) acknowledged deviations of E2E-3" });
    expect(withdraw).toHaveAttribute("data-ack-for", "1:all");
    await waitFor(() => expect(withdraw).toHaveFocus());
  });

  test("Withdraw all DELETEs the binding's acknowledgement with no kind and no body, and offers Acknowledge all (N) again", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [stamped(endLater(3)), stamped(startEarlier())])] });
    h.onWrite = (_method, id) => {
      restamp(id, []);
      return new Response(null, { status: 204 });
    };
    const user = userEvent.setup();
    renderPage("/deviations?all=true");
    await user.click(await screen.findByRole("button", { name: "Withdraw all (2) acknowledged deviations of E2E-3" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe("/api/v1/integrations/jira/bindings/1/acknowledge");
    expect(writes()[0][1].method).toBe("DELETE");
    expect(writes()[0][1].body).toBeUndefined();
    expect(await screen.findByRole("button", { name: "Acknowledge all (2) open deviations of E2E-3" })).toHaveFocus();
  });

  test("when Acknowledge all takes the row off the Open list, the focus goes to the next row's button", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()]), row(2, "E2E-4")] });
    h.onWrite = (_method, id) => {
      h.doc = view({ items: h.doc.items.filter((i) => i.bindingId !== id) });
      return ok(id);
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Acknowledge all \(2\)/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Acknowledge all/ })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge E2E-4: End" })).toHaveFocus());
  });

  test("without can.acknowledge the lines and their acknowledgements are read, but no button is offered", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [stamped(endLater(3)), stamped(startEarlier()), renamed()], { can: { acknowledge: false } })] });
    renderPage("/deviations?all=true");
    expect(await screen.findAllByText("Acknowledged by Ada Lovelace on 2026-11-06")).toHaveLength(2);
    const table = screen.getByRole("table", { name: TABLE });
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
  });

  test("a 409 on Acknowledge all is the orange note under the batch buttons, nothing else changes, and the page is re-read", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()])] });
    h.onWrite = () => jsonResponse(409, STALE_PROBLEM);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Acknowledge all \(2\)/ }));
    const note = await screen.findByText(/The deviations changed since you looked\./);
    const cellOfRow = within(screen.getByRole("table", { name: TABLE })).getAllByRole("row")[1];
    expect(cellOfRow).toContainElement(note);
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a 403 on Withdraw all is the red forbidden message; its 404 says already withdrawn, not that the link is gone", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [stamped(endLater(3)), stamped(startEarlier())])] });
    const user = userEvent.setup();
    renderPage("/deviations?all=true");
    const button = await screen.findByRole("button", { name: /^Withdraw all \(2\)/ });
    h.onWrite = () => jsonResponse(403, { title: "x", status: 403 });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner of this plan item, the manager of the milestone's team or an administrator can acknowledge its deviations.");
    h.onWrite = () => jsonResponse(404, { title: "x", status: 404 });
    await user.click(screen.getByRole("button", { name: /^Withdraw all \(2\)/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That acknowledgement was already withdrawn. The list has been read again."));
    expect(screen.queryByText(/no longer exists/)).not.toBeInTheDocument();
  });

  test("a message for a line that is gone after the re-read is shown above the table instead", async () => {
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()])] });
    h.onWrite = () => {
      // What the server found: the Start deviation no longer exists, so the re-read lists the End line only.
      h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3)])] });
      return jsonResponse(409, STALE_PROBLEM);
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: Start" }));
    const note = await screen.findByText(/The deviations changed since you looked\./);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge E2E-3: Start" })).not.toBeInTheDocument());
    expect(within(screen.getByRole("table", { name: TABLE })).queryByText(/changed since you looked/)).not.toBeInTheDocument();
    expect(note).toBeInTheDocument();
  });

  test("while one write runs every line and batch button of the page is aria-disabled, and a click on another is ignored", async () => {
    let release: ((response: Response) => void) | undefined;
    h.doc = view({ items: [withLines(1, "E2E-3", [endLater(3), startEarlier()])] });
    h.onWrite = () => new Promise<Response>((resolve) => (release = resolve));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Acknowledge E2E-3: End" }));
    const other = screen.getByRole("button", { name: "Acknowledge E2E-3: Start" });
    await waitFor(() => expect(other).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("button", { name: /^Acknowledge all/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(other);
    expect(writes()).toHaveLength(1);
    release?.(ok(1));
    await waitFor(() => expect(other).not.toHaveAttribute("aria-disabled"));
  });
});
