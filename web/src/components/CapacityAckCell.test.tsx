import { afterEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "../test/render";
import { GONE_ROW, acknowledgedRow, differsRow, staleAcknowledgedRow } from "../test/flow";
import type { CapacityAcknowledge } from "../hooks/useCapacityAcknowledge";
import CapacityAckCell, { CapacityAckOrphanNotice, type CapacityAckContext } from "./CapacityAckCell";

function hook(over: Partial<CapacityAcknowledge> = {}): CapacityAcknowledge {
  return { busyKey: null, notice: null, run: vi.fn(), ...over };
}
const context = (over: Partial<CapacityAckContext> = {}): CapacityAckContext => ({ can: { acknowledge: true }, bindingId: 5, team: "Platform", hook: hook(), ...over });
const NEIGHBOURS = ["5:90003"];

describe("CapacityAckCell", () => {
  test("an open row offers Acknowledge, named by its sprint, and asks the hook with the row and its neighbours", async () => {
    const ack = context();
    const row = differsRow();
    renderWithProviders(<CapacityAckCell row={row} ack={ack} neighbours={NEIGHBOURS} />);
    const button = screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" });
    expect(button).toHaveTextContent("Acknowledge");
    expect(button).toHaveAttribute("data-ack-for", "5:90002");
    expect(screen.queryByRole("button", { name: /Unacknowledge/ })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(ack.hook.run).toHaveBeenCalledWith({ kind: "acknowledge", bindingId: 5, row }, NEIGHBOURS);
  });

  test("a current acknowledgement reads who and when and offers only Unacknowledge", async () => {
    const ack = context();
    const row = acknowledgedRow(differsRow());
    renderWithProviders(<CapacityAckCell row={row} ack={ack} neighbours={NEIGHBOURS} />);
    expect(screen.getByText("Acknowledged by Ada Manager on 2026-11-08")).toHaveAttribute("title", "2026-11-08 10:00");
    expect(screen.queryByRole("button", { name: /^Acknowledge/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unacknowledge E2E Flow Sprint 2" }));
    expect(ack.hook.run).toHaveBeenCalledWith({ kind: "unacknowledge", bindingId: 5, row }, NEIGHBOURS);
  });

  test("an acknowledgement whose login is gone reads without a name", () => {
    renderWithProviders(<CapacityAckCell row={acknowledgedRow(differsRow(), null)} ack={context()} neighbours={[]} />);
    expect(screen.getByText("Acknowledged on 2026-11-08")).toBeInTheDocument();
  });

  test("a stale acknowledgement says it changed since, and the row (open again) offers Acknowledge", () => {
    renderWithProviders(<CapacityAckCell row={staleAcknowledgedRow(differsRow())} ack={context()} neighbours={[]} />);
    expect(screen.getByText("Acknowledged on 2026-11-08 by Ada Manager · changed since")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unacknowledge/ })).not.toBeInTheDocument();
  });

  test("without can.acknowledge there is no button, but the state is still told", () => {
    renderWithProviders(<CapacityAckCell row={acknowledgedRow(differsRow())} ack={context({ can: { acknowledge: false } })} neighbours={[]} />);
    expect(screen.getByText("Acknowledged by Ada Manager on 2026-11-08")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("an open row without can.acknowledge shows nothing at all", () => {
    const { container } = renderWithProviders(<CapacityAckCell row={differsRow()} ack={context({ can: { acknowledge: false } })} neighbours={[]} />);
    expect(container).not.toHaveTextContent("Acknowledge");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("the team's own row (TEAM_GONE, no sprint) is named \"the team's own row\" and keyed `team`", () => {
    renderWithProviders(<CapacityAckCell row={GONE_ROW} ack={context({ bindingId: 6 })} neighbours={[]} />);
    const button = screen.getByRole("button", { name: "Acknowledge the team's own row" });
    expect(button).toHaveAttribute("data-ack-for", "6:team");
  });

  test("a sprint without a name reads by its id", () => {
    renderWithProviders(<CapacityAckCell row={differsRow({ sprintName: null })} ack={context()} neighbours={[]} />);
    expect(screen.getByRole("button", { name: "Acknowledge Sprint 90002" })).toBeInTheDocument();
  });

  test("while a write runs every button is aria-disabled and ignores clicks, but is never the disabled attribute (the focus stays)", async () => {
    const ack = context({ hook: hook({ busyKey: "5:90003" }) });
    renderWithProviders(<CapacityAckCell row={differsRow()} ack={ack} neighbours={[]} />);
    const button = screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("data-disabled", "true");
    expect(button).not.toBeDisabled();
  });

  test("a note for THIS row shows under its buttons; one for another row does not", () => {
    const stale = hook({ notice: { key: "5:90002", kind: "stale" } });
    const view = renderWithProviders(<CapacityAckCell row={differsRow()} ack={context({ hook: stale })} neighbours={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("The deviations changed since you looked.");
    view.unmount();
    renderWithProviders(<CapacityAckCell row={differsRow()} ack={context({ hook: hook({ notice: { key: "5:90003", kind: "failure", text: "Nope" } }) })} neighbours={[]} />);
    expect(screen.queryByText("Nope")).not.toBeInTheDocument();
  });

  test("a refusal is the red inline message", () => {
    renderWithProviders(<CapacityAckCell row={differsRow()} ack={context({ hook: hook({ notice: { key: "5:90002", kind: "failure", text: "Only the team's manager" } }) })} neighbours={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Only the team's manager");
  });
});

describe("CapacityAckOrphanNotice", () => {
  const original = Element.prototype.scrollIntoView;
  afterEach(() => {
    // The suite shares its modules (isolate: false): a prototype patch must not outlive the test.
    Element.prototype.scrollIntoView = original;
  });

  test("a message for a row that left the list is shown above the list, and scrolled into view", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderWithProviders(<CapacityAckOrphanNotice hook={hook({ notice: { key: "5:90002", kind: "stale" } })} listedKeys={new Set(["5:90003"])} />);
    expect(screen.getByRole("status")).toHaveTextContent("The deviations changed since you looked.");
    expect(scroll).toHaveBeenCalled();
  });

  test("a message for a row that is still listed, or none at all, shows nothing here (the row's own cell has it)", () => {
    const view = renderWithProviders(<CapacityAckOrphanNotice hook={hook({ notice: { key: "5:90002", kind: "stale" } })} listedKeys={new Set(["5:90002"])} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<CapacityAckOrphanNotice hook={hook()} listedKeys={new Set()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
