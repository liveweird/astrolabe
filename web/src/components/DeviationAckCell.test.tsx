import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import type { DeviationItem, DeviationLine } from "../api/deviations";
import type { Acknowledge } from "../hooks/useAcknowledge";
import { endLater, item, renamed, startEarlier, stamped } from "../test/deviations";
import { theme } from "../theme";
import DeviationAckCell, { DeviationAckAll, DeviationAckOrphanNotice } from "./DeviationAckCell";

const AT = Date.UTC(2026, 10, 6, 12, 30);

const ack = (over: Partial<Acknowledge> = {}): Acknowledge => ({ busyKey: null, notice: null, run: vi.fn(), ...over });
const can = { can: { acknowledge: true } };
const wrap = (children: React.ReactNode) => (
  <MantineProvider env="test" theme={theme}>
    {children}
  </MantineProvider>
);

function renderLine(line: DeviationLine, over: Partial<DeviationItem> = {}, state: Acknowledge = ack(), neighbours: readonly string[] = []) {
  const it = item({ deviations: [line], ...over });
  return { it, ...render(wrap(<DeviationAckCell item={it} line={line} ack={state} neighbours={neighbours} />)) };
}

describe("a line's acknowledgement cell: the button matrix (can x none / current / stale)", () => {
  // [name, can, line state, offers Acknowledge, offers Unacknowledge]
  const matrix = [
    ["no rights, never acknowledged", false, null, false, false],
    ["no rights, current", false, { at: AT, by: "Ada Lovelace", current: true }, false, false],
    ["no rights, stale", false, { at: AT, by: "Ada Lovelace", current: false }, false, false],
    ["rights, never acknowledged", true, null, true, false],
    ["rights, current", true, { at: AT, by: "Ada Lovelace", current: true }, false, true],
    ["rights, stale (open again)", true, { at: AT, by: "Ada Lovelace", current: false }, true, false],
  ] as const;

  test.each(matrix)("%s", (_name, allowed, acknowledgement, offersAck, offersUnack) => {
    renderLine({ ...endLater(3), acknowledgement }, { can: { acknowledge: allowed } });
    expect(screen.queryByRole("button", { name: "Acknowledge E2E-3: End" }) !== null).toBe(offersAck);
    expect(screen.queryByRole("button", { name: "Unacknowledge E2E-3: End" }) !== null).toBe(offersUnack);
  });

  test("an estimate that cannot be compared (shown under 'all') is a line like any other: it can be acknowledged", () => {
    const line: DeviationLine = { kind: "ESTIMATE_NOT_COMPARABLE", severity: "INFO", detail: { jira: "5", plan: "3.00", days: null, count: null }, acknowledgement: null };
    renderLine(line, can);
    expect(screen.getByRole("button", { name: "Acknowledge E2E-3: Estimate" })).toBeInTheDocument();
  });
});

describe("a line's acknowledgement cell: the words", () => {
  test("a current acknowledgement says who and when (the date in UTC, the exact time in the title)", () => {
    renderLine(stamped(endLater(3)), can);
    expect(screen.getByText("Acknowledged by Ada Lovelace on 2026-11-06")).toHaveAttribute("title", "2026-11-06 12:30");
  });

  test("a stale acknowledgement says it was changed since, and a deleted acknowledger is left out, never made up", () => {
    const { unmount } = renderLine(stamped(endLater(3), { current: false }), can);
    expect(screen.getByText("Acknowledged on 2026-11-06 by Ada Lovelace · changed since")).toBeInTheDocument();
    unmount();
    const nameless = renderLine(stamped(endLater(3), { by: null }));
    expect(screen.getByText("Acknowledged on 2026-11-06")).toBeInTheDocument();
    nameless.unmount();
    renderLine(stamped(endLater(3), { by: null, current: false }));
    expect(screen.getByText("Acknowledged on 2026-11-06 · changed since")).toBeInTheDocument();
  });

  test("a line that was never acknowledged says nothing", () => {
    renderLine(endLater(3));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/cknowledged/)).not.toBeInTheDocument();
  });
});

describe("a line's acknowledgement cell: the actions", () => {
  test("the buttons ask for their line - the item as the page read it and the line - with the neighbours that take the focus", async () => {
    const run = vi.fn();
    const user = userEvent.setup();
    const open = renderLine(endLater(3), can, ack({ run }), ["8:all", "8:END_DIFFERS"]);
    await user.click(screen.getByRole("button", { name: "Acknowledge E2E-3: End" }));
    expect(run).toHaveBeenCalledWith({ kind: "acknowledge", item: open.it, line: endLater(3) }, ["8:all", "8:END_DIFFERS"]);
    open.unmount();
    const done = renderLine(stamped(endLater(3)), can, ack({ run }), ["8:all"]);
    await user.click(screen.getByRole("button", { name: "Unacknowledge E2E-3: End" }));
    expect(run).toHaveBeenLastCalledWith({ kind: "unacknowledge", item: done.it, line: stamped(endLater(3)) }, ["8:all"]);
  });

  test("while a write runs the buttons are aria-disabled, not disabled (a disabled button would lose the focus), and carry the line's key for the focus rule", () => {
    renderLine(endLater(3), can, ack({ busyKey: "1:all" }));
    const button = screen.getByRole("button", { name: "Acknowledge E2E-3: End" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-ack-for", "1:END_DIFFERS");
    // Mantine's own disabled look, without the attribute.
    expect(button).toHaveAttribute("data-disabled", "true");
  });

  test("a message for THIS line shows under its button (the note as a status, the refusal as an alert); one for another line does not", () => {
    const { unmount } = renderLine(endLater(3), can, ack({ notice: { key: "1:END_DIFFERS", kind: "stale" } }));
    expect(screen.getByRole("status")).toHaveTextContent("The deviations changed since you looked.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    const refusal = renderLine(endLater(3), can, ack({ notice: { key: "1:END_DIFFERS", kind: "failure", text: "Action failed (500)" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Action failed (500)");
    refusal.unmount();
    renderLine(endLater(3), can, ack({ notice: { key: "1:RENAMED", kind: "failure", text: "Action failed (500)" } }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Acknowledge all (N) / Withdraw all (N)", () => {
  const renderAll = (over: Partial<DeviationItem>, state: Acknowledge = ack(), order: readonly string[] = []) => {
    const it = item(over);
    return { it, ...render(wrap(<DeviationAckAll item={it} ack={state} order={order} />)) };
  };

  test("two open lines offer 'Acknowledge all (2)' named by the Jira key; one open line has only its own button", () => {
    renderAll({ ...can, deviations: [endLater(3), startEarlier()] });
    expect(screen.getByRole("button", { name: "Acknowledge all (2) open deviations of E2E-3" })).toHaveTextContent("Acknowledge all (2)");
    expect(screen.queryByRole("button", { name: /^Withdraw all/ })).not.toBeInTheDocument();
  });

  test("one open line, or a line that is acknowledged-but-stale among open ones, counts honestly: a stale stamp is open", () => {
    const { unmount } = renderAll({ ...can, deviations: [endLater(3), stamped(startEarlier())] });
    expect(screen.queryByRole("button", { name: /^Acknowledge all/ })).not.toBeInTheDocument();
    unmount();
    renderAll({ ...can, deviations: [endLater(3), stamped(startEarlier(), { current: false }), stamped(renamed())] });
    expect(screen.getByRole("button", { name: "Acknowledge all (2) open deviations of E2E-3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Withdraw all/ })).not.toBeInTheDocument();
  });

  test("two currently acknowledged lines offer 'Withdraw all (2)'; a mixed row offers both, each with its own count", () => {
    const { unmount } = renderAll({ ...can, deviations: [stamped(endLater(3)), stamped(startEarlier())] });
    expect(screen.getByRole("button", { name: "Withdraw all (2) acknowledged deviations of E2E-3" })).toHaveTextContent("Withdraw all (2)");
    expect(screen.queryByRole("button", { name: /^Acknowledge all/ })).not.toBeInTheDocument();
    unmount();
    renderAll({ ...can, deviations: [endLater(3), startEarlier(), renamed(), stamped({ ...endLater(1), kind: "TARGET_DIFFERS" }), stamped({ ...endLater(1), kind: "PROGRESS_MISMATCH" })] });
    expect(screen.getByRole("button", { name: "Acknowledge all (3) open deviations of E2E-3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw all (2) acknowledged deviations of E2E-3" })).toBeInTheDocument();
  });

  test("without can.acknowledge there is no batch button at all", () => {
    renderAll({ deviations: [endLater(3), startEarlier()] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("the batch asks for the whole item (no line), with the order for the focus, and shares the binding's all-key", async () => {
    const run = vi.fn();
    const user = userEvent.setup();
    const first = renderAll({ ...can, deviations: [endLater(3), startEarlier()] }, ack({ run }), ["1:all", "2:all"]);
    const button = screen.getByRole("button", { name: /^Acknowledge all/ });
    expect(button).toHaveAttribute("data-ack-for", "1:all");
    await user.click(button);
    expect(run).toHaveBeenCalledWith({ kind: "acknowledgeAll", item: first.it }, ["1:all", "2:all"]);
    first.unmount();
    const second = renderAll({ ...can, deviations: [stamped(endLater(3)), stamped(startEarlier())] }, ack({ run }));
    await user.click(screen.getByRole("button", { name: /^Withdraw all/ }));
    expect(run).toHaveBeenLastCalledWith({ kind: "unacknowledgeAll", item: second.it }, []);
  });

  test("while any write runs the batch buttons are aria-disabled, not disabled", () => {
    renderAll({ ...can, deviations: [endLater(3), startEarlier()] }, ack({ busyKey: "1:END_DIFFERS" }));
    const button = screen.getByRole("button", { name: /^Acknowledge all/ });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
  });

  test("the batch's note shows at the head whether or not a button is left; another key's does not", () => {
    const { unmount } = renderAll({ ...can, deviations: [endLater(3)] }, ack({ notice: { key: "1:all", kind: "stale" } }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The deviations changed since you looked.");
    unmount();
    renderAll({ ...can, deviations: [endLater(3)] }, ack({ notice: { key: "1:END_DIFFERS", kind: "stale" } }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("the orphan notice", () => {
  const orphan = (notice: Acknowledge["notice"], listed: string[]) => render(wrap(<DeviationAckOrphanNotice ack={ack({ notice })} listedKeys={new Set(listed)} />));

  test("a message for a key no rendered row holds is shown on its own; one for a listed key, or none, is not", () => {
    const { unmount } = orphan({ key: "1:END_DIFFERS", kind: "failure", text: "Action failed (403)" }, ["2:all"]);
    expect(screen.getByRole("alert")).toHaveTextContent("Action failed (403)");
    unmount();
    const listed = orphan({ key: "1:END_DIFFERS", kind: "failure", text: "Action failed (403)" }, ["1:END_DIFFERS"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    listed.unmount();
    orphan(null, []);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
