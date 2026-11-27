import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { TeamView, WeekLoad } from "../api/teams";
import { useWeeklyLoadArrival } from "./useWeeklyLoadArrival";

// A team page's weekly load address (1.36): when the table opens, what is focused and marked, what happens to the address.

const week = (weekStart: string, over: Partial<WeekLoad> = {}): WeekLoad => ({ weekStart, load: 8, capacity: 10, overloaded: false, overloadMd: null, maxWip: 1, wipExceeded: false, ...over });
const WEEKS = [week("2027-01-04", { overloaded: true }), week("2027-01-11"), week("2027-01-18", { overloaded: true }), week("2027-01-25", { wipExceeded: true }), week("2027-02-01", { capacity: null })];
const view = (weeks: WeekLoad[] = WEEKS) => ({ weeks }) as Pick<TeamView, "weeks">;

type Props = { settled: boolean; ready?: boolean; view?: Pick<TeamView, "weeks"> };

function setup(route: string, initial: Props = { settled: true }) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  return renderHook(
    (props: Props) => ({
      arrival: useWeeklyLoadArrival({ read: { isSuccess: props.settled, isFetching: false }, ready: props.ready ?? true, view: props.view ?? view(), today: "2027-01-13" }),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    { wrapper, initialProps: initial },
  );
}

/** The page's targets, mounted where the hook's refs say: a region (its scroller) with a header and one row per week. */
function mount(arrival: ReturnType<typeof useWeeklyLoadArrival>, weeks = WEEKS) {
  const region = document.createElement("div");
  region.tabIndex = 0;
  region.innerHTML = `<table><thead><tr><th>Week</th></tr></thead><tbody>${weeks.map((w) => `<tr data-load-week="${w.weekStart}"><td>${w.weekStart}</td></tr>`).join("")}</tbody></table>`;
  const heading = document.createElement("h3");
  heading.tabIndex = -1;
  document.body.append(region, heading);
  arrival.regionRef.current = region;
  arrival.headingRef.current = heading;
  return { region, heading };
}

describe("useWeeklyLoadArrival", () => {
  test("without the parameter nothing opens and the address is left alone", () => {
    const { result } = setup("/teams/1?x=1");
    expect(result.current.arrival.open).toBe(false);
    expect(result.current.location.search).toBe("?x=1");
  });

  test.each(["weeks", "overloaded", "wip", "nocapacity"])("a settled read with ?load=%s opens the table and drops the parameter (replace), the others kept", (word) => {
    const { result } = setup(`/teams/1?load=${word}&x=1`);
    expect(result.current.arrival.open).toBe(true);
    expect(result.current.location.search).toBe("?x=1");
  });

  test("a read still running, or a layout still growing, does nothing: the address waits and the table opens when both are settled", () => {
    const { result, rerender } = setup("/teams/1?load=wip", { settled: false });
    expect(result.current.arrival.open).toBe(false);
    expect(result.current.location.search).toBe("?load=wip");
    rerender({ settled: true, ready: false });
    expect(result.current.arrival.open).toBe(false);
    expect(result.current.location.search).toBe("?load=wip");
    rerender({ settled: true, ready: true });
    expect(result.current.arrival.open).toBe(true);
    expect(result.current.location.search).toBe("");
  });

  test("any other value opens nothing", () => {
    const { result } = setup("/teams/1?load=all");
    expect(result.current.arrival.open).toBe(false);
    expect(result.current.location.search).toBe("?load=all");
  });

  test("the region takes the focus and is scrolled to the centre, once per arrival: a refetch does not take it again, a new address does", () => {
    const { result, rerender } = setup("/teams/1", { settled: false });
    const { region } = mount(result.current.arrival);
    act(() => result.current.navigate("/teams/1?load=weeks"));
    rerender({ settled: true });
    expect(document.activeElement).toBe(region);
    document.body.focus();
    rerender({ settled: false });
    rerender({ settled: true });
    expect(document.activeElement).toBe(document.body);
    act(() => result.current.navigate("/teams/1?load=weeks"));
    expect(document.activeElement).toBe(region);
    document.body.innerHTML = "";
  });

  test("with no table mounted (no week listed) the heading takes the focus", () => {
    const { result, rerender } = setup("/teams/1", { settled: false });
    const { heading } = mount(result.current.arrival);
    result.current.arrival.regionRef.current = null;
    act(() => result.current.navigate("/teams/1?load=overloaded"));
    rerender({ settled: true });
    expect(document.activeElement).toBe(heading);
    expect(result.current.arrival.marked).toBeNull();
    document.body.innerHTML = "";
  });

  test("a kind marks the first such week at or after this week (the Monday of 2027-01-13 is 2027-01-11), the region's own scroller is moved to its row and the focus stays on the region", () => {
    const { result, rerender } = setup("/teams/1", { settled: false });
    const { region } = mount(result.current.arrival);
    // jsdom lays nothing out: the row sits 300 px below the region's top and the header is 40 px tall.
    const rows = region.querySelectorAll("tr[data-load-week]");
    for (const row of rows) {
      const week = (row as HTMLElement).dataset.loadWeek;
      row.getBoundingClientRect = () => ({ top: week === "2027-01-18" ? 400 : 0 }) as DOMRect;
    }
    region.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    region.querySelector("thead")!.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    // A viewport shorter than the region: the row itself is brought in after the inner scroll.
    const reveal = vi.fn();
    (region.querySelector('tr[data-load-week="2027-01-18"]') as HTMLElement).scrollIntoView = reveal;
    act(() => result.current.navigate("/teams/1?load=overloaded"));
    rerender({ settled: true });
    expect(result.current.arrival.marked).toBe("2027-01-18");
    expect(region.scrollTop).toBe(260);
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(document.activeElement).toBe(region);
    document.body.innerHTML = "";
  });

  test.each([
    ["wip", "2026-12-07"],
    ["nocapacity", "2026-12-14"],
  ])("with none of that kind at or after this week, ?load=%s marks the latest before it", (word, expected) => {
    const before = [week("2026-11-30", { wipExceeded: true, capacity: null }), week("2026-12-07", { wipExceeded: true }), week("2026-12-14", { capacity: null })];
    const { result, rerender } = setup("/teams/1", { settled: false, view: view(before) });
    mount(result.current.arrival, before);
    act(() => result.current.navigate(`/teams/1?load=${word}`));
    rerender({ settled: true, view: view(before) });
    expect(result.current.arrival.marked).toBe(expected);
    document.body.innerHTML = "";
  });

  test("none of that kind, or plain weeks, marks nothing", () => {
    for (const word of ["wip", "weeks"]) {
      const quiet = [week("2027-01-11")];
      const { result, rerender } = setup("/teams/1", { settled: false, view: view(quiet) });
      mount(result.current.arrival, quiet);
      act(() => result.current.navigate(`/teams/1?load=${word}`));
      rerender({ settled: true, view: view(quiet) });
      expect(result.current.arrival.open).toBe(true);
      expect(result.current.arrival.marked).toBeNull();
      document.body.innerHTML = "";
    }
  });

  test("the user may close the table afterwards and nothing opens it again", () => {
    const { result, rerender } = setup("/teams/1?load=weeks");
    expect(result.current.arrival.open).toBe(true);
    act(() => result.current.arrival.onOpenChange(false));
    expect(result.current.arrival.open).toBe(false);
    rerender({ settled: true });
    rerender({ settled: true, ready: true });
    expect(result.current.arrival.open).toBe(false);
  });
});
