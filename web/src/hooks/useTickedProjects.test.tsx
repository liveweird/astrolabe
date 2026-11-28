import { describe, expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTickedProjects } from "./useTickedProjects";

const span = (start: string, end: string) => ({ start, end });
const project = (projectId: number, end: string) => ({ projectId, name: `p${projectId}`, before: span("2042-01-01", "2042-01-02"), after: span("2042-01-03", end), endShiftDays: 1 });
const RUN = { projects: [project(1, "2042-02-01"), project(2, "2042-03-01")] };
const OTHER_RUN = { projects: [project(3, "2042-04-01")] };
const ANSWER = [project(2, "2042-01-20")];

type Props = { run: typeof RUN | null; mode: "all" | "some" | "none"; projects: typeof ANSWER | null; follows?: boolean };
const mount = (initial: Props) => renderHook((props: Props) => useTickedProjects(props.run, { mode: props.mode, projects: props.projects }, props.follows ?? true), { initialProps: initial });

describe("useTickedProjects", () => {
  test("every move ticked is the run's own projects, none ticked is none, an answered subset is the check's", () => {
    const { result, rerender } = mount({ run: RUN, mode: "all", projects: null });
    expect(result.current).toEqual({ projects: RUN.projects, ticked: false });
    rerender({ run: RUN, mode: "some", projects: ANSWER });
    expect(result.current).toEqual({ projects: ANSWER, ticked: true });
    rerender({ run: RUN, mode: "none", projects: null });
    expect(result.current).toEqual({ projects: [], ticked: true });
  });

  test("while a newer check is pending the LAST answered value stays, never the run's", () => {
    const { result, rerender } = mount({ run: RUN, mode: "some", projects: ANSWER });
    rerender({ run: RUN, mode: "some", projects: null });
    expect(result.current).toEqual({ projects: ANSWER, ticked: true });
    rerender({ run: RUN, mode: "none", projects: null });
    rerender({ run: RUN, mode: "some", projects: null });
    expect(result.current.projects).toEqual([]);
  });

  test("with nothing answered yet, or for another run, the run's own projects; a viewer whose ticks do not decide gets the run's whatever is asked", () => {
    const { result, rerender } = mount({ run: RUN, mode: "some", projects: null });
    expect(result.current).toEqual({ projects: RUN.projects, ticked: false });
    rerender({ run: RUN, mode: "some", projects: ANSWER });
    rerender({ run: OTHER_RUN, mode: "some", projects: null });
    expect(result.current).toEqual({ projects: OTHER_RUN.projects, ticked: false });
    rerender({ run: OTHER_RUN, mode: "some", projects: ANSWER, follows: false });
    expect(result.current).toEqual({ projects: OTHER_RUN.projects, ticked: false });
  });
});
