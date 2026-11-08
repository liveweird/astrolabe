import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import { formatDateTime } from "../utils/formatDate";
import ConnectionTestBadge from "./ConnectionTestBadge";

const AT = Date.UTC(2026, 10, 8, 10, 30);

describe("ConnectionTestBadge", () => {
  test("untested: the key's text, plain in a fact and dimmed in a row", () => {
    const { container, rerender } = renderWithProviders(<ConnectionTestBadge lastTestOk={null} lastTestedAt={null} untestedKey="jira.details.neverTested" layout="fact" />);
    expect(container).toHaveTextContent("Never tested");
    expect(container.querySelector(".mantine-Text-root")).toBeNull();
    rerender(<ConnectionTestBadge lastTestOk={null} lastTestedAt={null} untestedKey="jira.details.neverTested" layout="row" />);
    expect(screen.getByText("Never tested")).toHaveClass("mantine-Text-root");
  });

  test.each([
    ["fact", ["date", "badge"]],
    ["row", ["badge", "date"]],
  ] as const)("tested, layout %s: the verdict badge and the date in order %j", (layout, order) => {
    renderWithProviders(<ConnectionTestBadge lastTestOk={false} lastTestedAt={AT} untestedKey="jira.details.neverTested" layout={layout} />);
    const group = screen.getByText("Failed").closest(".mantine-Group-root");
    const parts = Array.from(group?.children ?? []).map((child) => (child.textContent === formatDateTime(AT) ? "date" : "badge"));
    expect(parts).toEqual(order);
  });

  test("a passing verdict says so", () => {
    renderWithProviders(<ConnectionTestBadge lastTestOk lastTestedAt={AT} untestedKey="jira.details.neverTested" layout="row" />);
    expect(screen.getByText("Passed")).toBeInTheDocument();
  });
});
