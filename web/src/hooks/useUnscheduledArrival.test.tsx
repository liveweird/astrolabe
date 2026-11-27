import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useUnscheduledArrival } from "./useUnscheduledArrival";

// The project page's not-scheduled address (`?milestones=unscheduled`): the heading takes the focus once the view is here, then the parameter leaves the address.

function setup(route: string, ready = true, withHeading = true) {
  const heading = document.createElement("h3");
  heading.tabIndex = -1;
  document.body.append(heading);
  const headingRef = { current: withHeading ? heading : null };
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  const hook = renderHook(
    (props: { ready: boolean }) => {
      useUnscheduledArrival(props.ready, headingRef);
      return { location: useLocation(), navigate: useNavigate() };
    },
    { wrapper, initialProps: { ready } },
  );
  return { ...hook, heading };
}

describe("useUnscheduledArrival", () => {
  test("the heading takes the focus once and the parameter leaves the address (replace, the others kept)", () => {
    const { result, heading } = setup("/projects/7?milestones=unscheduled&other=keep");
    expect(heading).toHaveFocus();
    expect(result.current.location.search).toBe("?other=keep");
    heading.remove();
  });

  test("nothing happens while the view is not ready: the address stays and nothing is focused; once it is, the focus is taken", () => {
    const { result, rerender, heading } = setup("/projects/7?milestones=unscheduled", false);
    expect(heading).not.toHaveFocus();
    expect(result.current.location.search).toBe("?milestones=unscheduled");
    act(() => rerender({ ready: true }));
    expect(heading).toHaveFocus();
    expect(result.current.location.search).toBe("");
    heading.remove();
  });

  test("a second arrival on the mounted page (the address visited again) takes the focus again, then drops the parameter again", () => {
    const { result, heading } = setup("/projects/7?milestones=unscheduled");
    expect(heading).toHaveFocus();
    heading.blur();
    act(() => result.current.navigate("/projects/7?milestones=unscheduled&other=keep"));
    expect(heading).toHaveFocus();
    expect(result.current.location.search).toBe("?other=keep");
    heading.remove();
  });

  test("the focus is not taken again once it moved on: a later render finds no parameter", () => {
    const { rerender, heading } = setup("/projects/7?milestones=unscheduled");
    heading.blur();
    act(() => rerender({ ready: true }));
    expect(heading).not.toHaveFocus();
    heading.remove();
  });

  test("no heading (a project without milestones): the parameter is still dropped, nothing is focused", () => {
    const { result, heading } = setup("/projects/7?milestones=unscheduled", true, false);
    expect(heading).not.toHaveFocus();
    expect(result.current.location.search).toBe("");
    heading.remove();
  });

  test.each(["scheduled", "all", "bogus", ""])("any other word (%j) is ignored and dropped, with no focus", (word) => {
    const { result, heading } = setup(`/projects/7?milestones=${word}`);
    expect(heading).not.toHaveFocus();
    expect(result.current.location.search).toBe("");
    heading.remove();
  });

  test("an address without the parameter is left alone", () => {
    const { result, heading } = setup("/projects/7?other=keep");
    expect(heading).not.toHaveFocus();
    expect(result.current.location.search).toBe("?other=keep");
    heading.remove();
  });

  test("a milestone's address (?milestone=) is its own: this hook stands aside and leaves the address to it", () => {
    const { result, heading } = setup("/projects/7?milestone=3&milestones=unscheduled");
    expect(heading).not.toHaveFocus();
    expect(result.current.location.search).toBe("?milestone=3&milestones=unscheduled");
    heading.remove();
  });
});
