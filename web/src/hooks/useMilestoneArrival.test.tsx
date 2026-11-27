import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { ProjectView } from "../api/milestones";
import type { TimelineHandle } from "../components/Timeline";
import { useMilestoneArrival } from "./useMilestoneArrival";

// A milestone's address on the project page (1.31): what is marked and focused, what happens to the address, and the notice for a milestone that is not here.

const view = (scheduled: number[], unscheduled: number[]) => ({ scheduled: scheduled.map((id) => ({ id, startDate: `2027-01-${String(id + 10)}` })), unscheduled: unscheduled.map((id) => ({ id })) }) as unknown as ProjectView;

function setup(route: string, initial: { view: ProjectView | undefined; settled?: boolean }) {
  const focusRow = vi.fn(() => true);
  const scrollToDay = vi.fn();
  const timelineRef = { current: { focusRow, scrollToDay } as TimelineHandle };
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  const hook = renderHook(
    (props: { view: ProjectView | undefined; settled: boolean }) => ({
      arrival: useMilestoneArrival(props.view, props.settled, timelineRef),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    { wrapper, initialProps: { view: initial.view, settled: initial.settled ?? true } },
  );
  return { ...hook, focusRow, scrollToDay };
}

describe("useMilestoneArrival", () => {
  test("a scheduled milestone is marked and its timeline row focused once, and the parameter leaves the address (replace, the others kept)", () => {
    const { result, focusRow, scrollToDay } = setup("/projects/7?milestone=2&milestones=all", { view: view([1, 2], [3]) });
    expect(result.current.arrival.marked).toBe(2);
    expect(result.current.arrival.gone).toBe(false);
    expect(focusRow).toHaveBeenCalledExactlyOnceWith(2);
    // the track follows to the bar's start, after the focus
    expect(scrollToDay).toHaveBeenCalledExactlyOnceWith("2027-01-12");
    expect(focusRow.mock.invocationCallOrder[0]).toBeLessThan(scrollToDay.mock.invocationCallOrder[0]);
    expect(result.current.location.search).toBe("?milestones=all");
  });

  test("nothing happens before the view is here: the address stays and nothing is marked", () => {
    const { result, rerender, focusRow } = setup("/projects/7?milestone=2", { view: undefined });
    expect(result.current.arrival.marked).toBeNull();
    expect(result.current.location.search).toBe("?milestone=2");
    expect(focusRow).not.toHaveBeenCalled();
    rerender({ view: view([2], []), settled: true });
    expect(result.current.arrival.marked).toBe(2);
    expect(focusRow).toHaveBeenCalledExactlyOnceWith(2);
    expect(result.current.location.search).toBe("");
  });

  test("an unscheduled milestone is marked and its TRAY row focused, not the timeline", () => {
    document.body.innerHTML = '<table><tbody><tr data-tray-item="3" tabindex="-1"><td>Rollout</td></tr></tbody></table>';
    const { result, focusRow, scrollToDay } = setup("/projects/7?milestone=3", { view: view([1], [3]) });
    expect(result.current.arrival.marked).toBe(3);
    expect(focusRow).not.toHaveBeenCalled();
    expect(scrollToDay).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.querySelector('[data-tray-item="3"]'));
    document.body.innerHTML = "";
  });

  test("the focus is taken once: a later render, a new view and a refetch do not take it again", () => {
    const { result, rerender, focusRow } = setup("/projects/7?milestone=2", { view: view([1, 2], []) });
    rerender({ view: view([1, 2], []), settled: false });
    rerender({ view: view([1, 2], []), settled: true });
    expect(focusRow).toHaveBeenCalledTimes(1);
    expect(result.current.arrival.marked).toBe(2);
  });

  test("another milestone's address on the same page moves the mark (and the focus) to that one", () => {
    const { result, focusRow } = setup("/projects/7?milestone=1", { view: view([1, 2], []) });
    act(() => result.current.navigate("/projects/7?milestone=2"));
    expect(result.current.arrival.marked).toBe(2);
    expect(focusRow).toHaveBeenNthCalledWith(2, 2);
    expect(result.current.location.search).toBe("");
  });

  test("a milestone this project does not have is no error: the notice, the mark cleared, the parameter dropped, no focus", () => {
    const { result, focusRow } = setup("/projects/7?milestone=99", { view: view([1], [3]) });
    expect(result.current.arrival.marked).toBeNull();
    expect(result.current.arrival.gone).toBe(true);
    expect(focusRow).not.toHaveBeenCalled();
    expect(result.current.location.search).toBe("");
    act(() => result.current.arrival.dismiss());
    expect(result.current.arrival.gone).toBe(false);
  });

  test("a malformed id is the same notice", () => {
    const { result } = setup("/projects/7?milestone=abc", { view: view([1], []) });
    expect(result.current.arrival.gone).toBe(true);
    expect(result.current.location.search).toBe("");
  });

  test("the verdict 'not here' waits for the read in flight: a milestone created a moment ago is not reported gone from a cached copy", () => {
    const { result, rerender } = setup("/projects/7?milestone=5", { view: view([1], []), settled: false });
    expect(result.current.arrival.gone).toBe(false);
    expect(result.current.location.search).toBe("?milestone=5");
    rerender({ view: view([1, 5], []), settled: false });
    expect(result.current.arrival.marked).toBe(5);
    expect(result.current.arrival.gone).toBe(false);
  });

  test("the same address once the read settled and the milestone is still missing says so", () => {
    const { result, rerender } = setup("/projects/7?milestone=5", { view: view([1], []), settled: false });
    rerender({ view: view([1], []), settled: true });
    expect(result.current.arrival.gone).toBe(true);
  });

  test("a marked milestone that leaves the view (deleted, moved) is marked no more", () => {
    const { result, rerender } = setup("/projects/7?milestone=2", { view: view([1, 2], []) });
    expect(result.current.arrival.marked).toBe(2);
    rerender({ view: view([1], []), settled: true });
    expect(result.current.arrival.marked).toBeNull();
    expect(result.current.arrival.gone).toBe(false);
  });

  test("without the parameter nothing is marked, said or focused", () => {
    const { result, focusRow } = setup("/projects/7", { view: view([1], []) });
    expect(result.current.arrival).toMatchObject({ marked: null, gone: false });
    expect(focusRow).not.toHaveBeenCalled();
  });
});
