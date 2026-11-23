import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TimelineHeader from "./TimelineHeader";
import { makeScale, toEpochDay } from "../utils/timelineScale";
import i18n from "../i18n";

const LEFT_WIDTH = 260;
const NARROW = makeScale("year", { from: toEpochDay("2040-01-01"), to: toEpochDay("2045-12-31") });
const WIDE = makeScale("year", { from: toEpochDay("2040-01-01"), to: toEpochDay("2999-12-31") });

/** A scroller with a size and a scroll position (happy-dom lays nothing out). */
function scrollerAt(scrollLeft: number): RefObject<HTMLDivElement | null> {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 900 });
  element.scrollLeft = scrollLeft;
  const ref = createRef<HTMLDivElement>();
  (ref as { current: HTMLDivElement | null }).current = element;
  return ref;
}

const header = (scale: typeof WIDE, scrollRef: RefObject<HTMLDivElement | null>) => (
  <TimelineHeader scale={scale} columns={[]} leftWidth={LEFT_WIDTH} today="2040-01-01" scrollRef={scrollRef} />
);

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("TimelineHeader scroll window", () => {
  test.each([
    ["with ResizeObserver", true],
    ["without ResizeObserver", false],
  ])("entering the windowed mode at a non-zero scroll renders that position's cells at once, no event needed (%s)", (_name, hasObserver) => {
    if (!hasObserver) vi.stubGlobal("ResizeObserver", undefined);
    else vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    const scrollRef = scrollerAt(WIDE.xOf(toEpochDay("2999-10-01")));
    const { rerender } = render(header(NARROW, scrollRef));
    // Not windowed: the exact full row.
    expect(screen.queryByText("2999-Q4")).not.toBeInTheDocument();
    // A zoom change widens the track while the scroller keeps its position; no scroll or resize callback follows.
    rerender(header(WIDE, scrollRef));
    expect(screen.getByText("2999-Q4")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-timeline-header-cell]").length).toBeLessThan(50);
  });
});
