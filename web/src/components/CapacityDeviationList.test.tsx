import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "../test/render";
import { GONE_ROW, acknowledgedRow, differsRow, missingRow, staleAcknowledgedRow } from "../test/flow";
import type { CapacityDeviation } from "../api/capacityDeviations";
import type { CapacityAcknowledge } from "../hooks/useCapacityAcknowledge";
import type { CapacityAckContext } from "./CapacityAckCell";
import CapacityDeviationList from "./CapacityDeviationList";

const ROW_2 = differsRow();
const ROW_3 = differsRow({ sprintId: 90003, sprintName: "E2E Flow Sprint 3", start: "2047-02-04", end: "2047-02-15", planMd: 44, flowMd: 48 });

function ack(over: Partial<CapacityAckContext> = {}): CapacityAckContext {
  const hook: CapacityAcknowledge = { busyKey: null, notice: null, run: vi.fn() };
  return { can: { acknowledge: true }, bindingId: 5, hook, ...over };
}
const missingRows = (count: number, acknowledged: readonly number[] = []): CapacityDeviation[] =>
  Array.from({ length: count }, (_, n) => {
    const row = missingRow(90010 + n, `2047-0${n + 1}-07`, `2047-0${n + 1}-18`);
    return acknowledged.includes(n) ? acknowledgedRow(row) : row;
  });

describe("CapacityDeviationList with the acknowledge", () => {
  test("every sentence carries its cell: Acknowledge on an open row, who and when with Unacknowledge on an acknowledged one", () => {
    renderWithProviders(<CapacityDeviationList deviations={[ROW_2, acknowledgedRow(ROW_3)]} ack={ack()} />);
    const [warning, info] = screen.getAllByRole("listitem");
    expect(warning).toHaveTextContent("the plan has 36.00 man-days, Flow 30.00");
    expect(within(warning).getByRole("button", { name: "Acknowledge E2E Flow Sprint 2" })).toBeInTheDocument();
    // The acknowledged row keeps its sentence and its badge; the state is the cell's.
    expect(info).toHaveTextContent("the plan has 44.00 man-days, Flow 48.00");
    expect(info).toHaveTextContent("Acknowledged by Ada Manager on 2026-11-08");
    expect(within(info).getByRole("button", { name: "Unacknowledge E2E Flow Sprint 3" })).toBeInTheDocument();
  });

  test("a current acknowledgement dims a WARNING's badge to gray; an open or a stale one keeps its orange", () => {
    const styleOf = (item: HTMLElement) => item.querySelector(".mantine-Badge-root")?.getAttribute("style") ?? "";
    const stale = staleAcknowledgedRow(differsRow({ sprintId: 90004, sprintName: "E2E Flow Sprint 4" }));
    const acknowledged = acknowledgedRow(differsRow({ sprintId: 90005, sprintName: "E2E Flow Sprint 5" }));
    renderWithProviders(<CapacityDeviationList deviations={[ROW_2, stale, acknowledged]} ack={ack()} />);
    const [open, staleItem, ackedItem] = screen.getAllByRole("listitem");
    expect(styleOf(open)).toContain("orange");
    expect(styleOf(staleItem)).toContain("orange");
    expect(styleOf(ackedItem)).toContain("gray");
    expect(styleOf(ackedItem)).not.toContain("orange");
  });

  test("an acknowledged WARNING row is gray, with its severity word kept", () => {
    renderWithProviders(<CapacityDeviationList deviations={[acknowledgedRow(ROW_2)]} ack={ack()} />);
    const badge = screen.getByRole("listitem").querySelector(".mantine-Badge-root");
    expect(badge?.getAttribute("style")).toContain("gray");
    expect(badge).toHaveTextContent("Warning:");
  });

  test("a click hands the hook the row, its binding and the rows beside it in the WHOLE list (next first)", async () => {
    const context = ack();
    const third = differsRow({ sprintId: 90004, sprintName: "E2E Flow Sprint 4", planMd: 20 });
    renderWithProviders(<CapacityDeviationList deviations={[ROW_2, ROW_3, third]} ack={context} />);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 3" }));
    expect(context.hook.run).toHaveBeenCalledWith({ kind: "acknowledge", bindingId: 5, row: ROW_3 }, ["5:90004", "5:90002"]);
  });

  test("the gone team's row is acknowledgeable as the team's own row", async () => {
    const context = ack({ bindingId: 6 });
    renderWithProviders(<CapacityDeviationList deviations={[GONE_ROW]} ack={context} />);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge the team's own row" }));
    expect(context.hook.run).toHaveBeenCalledWith({ kind: "acknowledge", bindingId: 6, row: GONE_ROW }, []);
  });

  test("without can.acknowledge the sentences stand alone, the acknowledged state included", () => {
    renderWithProviders(<CapacityDeviationList deviations={[ROW_2, acknowledgedRow(ROW_3)]} ack={ack({ can: { acknowledge: false } })} />);
    expect(screen.queryByRole("button", { name: /cknowledge/ })).not.toBeInTheDocument();
    expect(screen.getByText("Acknowledged by Ada Manager on 2026-11-08")).toBeInTheDocument();
  });

  test("the folded line counts the OPEN sprints and the table carries the acknowledgement column and a cell per sprint", async () => {
    const context = ack();
    renderWithProviders(<CapacityDeviationList deviations={missingRows(4, [0])} ack={context} />);
    // 4 sprints, one acknowledged: 3 open, dated by the first OPEN one (the acknowledged first sprint is 2047-01-07).
    expect(screen.getByText("3 sprints without capacity in the plan (from 2047-02-07)")).toBeInTheDocument();
    expect(screen.getByText("· 1 acknowledged", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show the sprints" }));
    const table = await screen.findByRole("table", { name: "Sprints without capacity in the plan" });
    expect(within(table).getByRole("columnheader", { name: "Acknowledgement" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(5);
    expect(within(rows[1]).getByRole("button", { name: "Unacknowledge E2E Flow Sprint 10" })).toBeInTheDocument();
    await userEvent.click(within(rows[2]).getByRole("button", { name: "Acknowledge E2E Flow Sprint 11" }));
    expect(context.hook.run).toHaveBeenCalledWith({ kind: "acknowledge", bindingId: 5, row: expect.objectContaining({ detail: expect.objectContaining({ sprintId: 90011 }) }) }, ["5:90012", "5:90010"]);
  });

  test("when every folded sprint is acknowledged the line says so instead of counting zero open", () => {
    renderWithProviders(<CapacityDeviationList deviations={missingRows(3, [0, 1, 2])} ack={ack()} />);
    expect(screen.getByText("3 sprints without capacity in the plan, all acknowledged")).toBeInTheDocument();
    expect(screen.queryByText(/· \d+ acknowledged/)).not.toBeInTheDocument();
    // The folded line itself reads quiet: every sprint of it is acknowledged (it is an INFO, gray anyway).
    expect(screen.getByText("3 sprints without capacity in the plan, all acknowledged").closest("div")?.querySelector(".mantine-Badge-root")?.getAttribute("style")).toContain("gray");
  });

  test("a single sprint without capacity is its sentence with its cell, not a folded line", () => {
    renderWithProviders(<CapacityDeviationList deviations={missingRows(1)} ack={ack()} />);
    expect(screen.getByText(/no capacity in the plan, Flow has 40.00 man-days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge E2E Flow Sprint 10" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show the sprints" })).not.toBeInTheDocument();
  });

  test("the lines past the fifth keep their cells behind the disclosure", async () => {
    const rows = Array.from({ length: 7 }, (_, n) => differsRow({ sprintId: 90100 + n, sprintName: `Sprint ${n}`, planMd: 36 + n }));
    renderWithProviders(<CapacityDeviationList deviations={rows} ack={ack()} />);
    expect(screen.queryByRole("button", { name: "Acknowledge Sprint 6" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(await screen.findByRole("button", { name: "Acknowledge Sprint 6" })).toBeInTheDocument();
  });
});

describe("CapacityDeviationList without the acknowledge", () => {
  test("keeps the plain lines and the three-column table", async () => {
    renderWithProviders(<CapacityDeviationList deviations={[ROW_2, ...missingRows(2)]} />);
    expect(screen.queryByRole("button", { name: /cknowledge/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show the sprints" }));
    const table = await screen.findByRole("table", { name: "Sprints without capacity in the plan" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  });
});
