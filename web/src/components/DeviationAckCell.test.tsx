import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import type { DeviationItem } from "../api/deviations";
import type { Acknowledge } from "../hooks/useAcknowledge";
import { endLater, item } from "../test/deviations";
import { theme } from "../theme";
import { ackActions } from "../utils/deviations";
import DeviationAckCell from "./DeviationAckCell";

const AT = Date.UTC(2026, 10, 6, 12, 30);
const NONE = null;
const CURRENT = { at: AT, by: "Ada Lovelace", current: true };
const STALE = { at: AT, by: "Ada Lovelace", current: false };

const ack = (over: Partial<Acknowledge> = {}): Acknowledge => ({ busyId: null, notice: null, run: vi.fn(), ...over });

function renderCell(over: Partial<DeviationItem>, state: Acknowledge = ack(), neighbours: readonly number[] = []) {
  return render(
    <MantineProvider env="test" theme={theme}>
      <DeviationAckCell item={item(over)} ack={state} neighbours={neighbours} />
    </MantineProvider>,
  );
}

describe("the acknowledgement cell's button matrix (can x has a listed deviation x none / current / stale)", () => {
  // [name, can, has deviations, acknowledgement, offers Acknowledge, offers Unacknowledge]
  const matrix = [
    ["no rights, deviating, never acknowledged", false, true, NONE, false, false],
    ["no rights, deviating, current", false, true, CURRENT, false, false],
    ["no rights, deviating, stale", false, true, STALE, false, false],
    ["no rights, clean, never acknowledged", false, false, NONE, false, false],
    ["rights, deviating, never acknowledged", true, true, NONE, true, false],
    ["rights, deviating, current", true, true, CURRENT, false, true],
    ["rights, deviating, stale (open again)", true, true, STALE, true, false],
    // can.acknowledge is a pure rights flag: a clean item (shown under 'all') has nothing to acknowledge, a POST is a guaranteed 409.
    ["rights, clean, never acknowledged", true, false, NONE, false, false],
    ["rights, clean, current (the deviation list as listed is empty)", true, false, CURRENT, false, true],
    ["rights, clean, stale", true, false, STALE, false, false],
  ] as const;

  test.each(matrix)("%s", (_name, can, deviating, acknowledgement, offersAck, offersUnack) => {
    const over = { can: { acknowledge: can }, deviations: deviating ? [endLater(3)] : [], acknowledgement };
    expect(ackActions(item(over))).toEqual({ acknowledge: offersAck, unacknowledge: offersUnack });
    renderCell(over);
    expect(screen.queryByRole("button", { name: "Acknowledge E2E-3" })).toBe(offersAck ? screen.getByRole("button", { name: "Acknowledge E2E-3" }) : null);
    expect(screen.queryByRole("button", { name: "Unacknowledge E2E-3" })).toBe(offersUnack ? screen.getByRole("button", { name: "Unacknowledge E2E-3" }) : null);
  });

  test("an item whose only listed deviation is an estimate that cannot be compared (shown under 'all') can be acknowledged: the server allows it", () => {
    const only = { kind: "ESTIMATE_NOT_COMPARABLE" as const, severity: "INFO" as const, detail: { jira: "5", plan: "3.00", days: null, count: null } };
    renderCell({ can: { acknowledge: true }, deviations: [only] });
    expect(screen.getByRole("button", { name: "Acknowledge E2E-3" })).toBeInTheDocument();
  });
});

describe("the acknowledgement cell's words", () => {
  test("a current acknowledgement says who and when (the date in UTC, the exact time in the title), with Unacknowledge beside it", () => {
    renderCell({ can: { acknowledge: true }, acknowledgement: CURRENT });
    const sentence = screen.getByText("Acknowledged by Ada Lovelace on 2026-11-06");
    expect(sentence).toHaveAttribute("title", "2026-11-06 12:30");
  });

  test("a stale acknowledgement says it was changed since, and a deleted acknowledger is left out, never made up", () => {
    renderCell({ can: { acknowledge: true }, acknowledgement: STALE });
    expect(screen.getByText("Acknowledged on 2026-11-06 by Ada Lovelace · changed since")).toBeInTheDocument();
  });

  test("an acknowledger who is gone (by: null) reads without a name, current or stale", () => {
    const { unmount } = renderCell({ acknowledgement: { at: AT, by: null, current: true } });
    expect(screen.getByText("Acknowledged on 2026-11-06")).toBeInTheDocument();
    unmount();
    renderCell({ acknowledgement: { at: AT, by: null, current: false } });
    expect(screen.getByText("Acknowledged on 2026-11-06 · changed since")).toBeInTheDocument();
  });

  test("a row that was never acknowledged says nothing", () => {
    renderCell({ can: { acknowledge: false } });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/cknowledged/)).not.toBeInTheDocument();
  });
});

describe("the acknowledgement cell's actions", () => {
  test("the buttons ask for their row: the item as the page read it, and the neighbours that take the focus", async () => {
    const run = vi.fn();
    const user = userEvent.setup();
    const row = { can: { acknowledge: true } };
    const { unmount } = renderCell(row, ack({ run }), [8, 6]);
    await user.click(screen.getByRole("button", { name: "Acknowledge E2E-3" }));
    expect(run).toHaveBeenCalledWith({ kind: "acknowledge", item: item(row) }, [8, 6]);
    unmount();
    renderCell({ ...row, acknowledgement: CURRENT }, ack({ run }), [8]);
    await user.click(screen.getByRole("button", { name: "Unacknowledge E2E-3" }));
    expect(run).toHaveBeenLastCalledWith({ kind: "unacknowledge", item: item({ ...row, acknowledgement: CURRENT }) }, [8]);
  });

  test("while a write runs the buttons are aria-disabled, not disabled (a disabled button would lose the focus), and carry the binding for the focus rule", () => {
    renderCell({ can: { acknowledge: true } }, ack({ busyId: 1 }));
    const button = screen.getByRole("button", { name: "Acknowledge E2E-3" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-ack-for", "1");
    // Mantine's own disabled look, without the attribute.
    expect(button).toHaveAttribute("data-disabled", "true");
  });

  test("a message for THIS row shows under its button (the note as a status, the refusal as an alert); one for another row does not", () => {
    const { unmount } = renderCell({ can: { acknowledge: true } }, ack({ notice: { bindingId: 1, kind: "stale" } }));
    expect(screen.getByRole("status")).toHaveTextContent("The deviations changed since you looked.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    const refusal = renderCell({ can: { acknowledge: true } }, ack({ notice: { bindingId: 1, kind: "failure", text: "Action failed (500)" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Action failed (500)");
    refusal.unmount();
    renderCell({ can: { acknowledge: true } }, ack({ notice: { bindingId: 2, kind: "failure", text: "Action failed (500)" } }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
