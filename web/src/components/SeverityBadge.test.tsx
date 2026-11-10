import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import SeverityBadge from "./SeverityBadge";

describe("SeverityBadge", () => {
  test("spells the severity in a visually hidden word before the text by default", () => {
    renderWithProviders(<SeverityBadge severity="WARNING">Dates differ</SeverityBadge>);
    expect(screen.getByText("Dates differ", { exact: false })).toHaveTextContent("Warning: Dates differ");
  });

  test("hiddenPrefix={false} renders the children alone", () => {
    renderWithProviders(
      <SeverityBadge severity="INFO" hiddenPrefix={false}>
        Info
      </SeverityBadge>,
    );
    expect(screen.getByText("Info")).toHaveTextContent(/^Info$/);
  });

  test("a warning is orange, and gray when dimmed - the severity word stays", () => {
    const { unmount } = renderWithProviders(<SeverityBadge severity="WARNING">Capacity</SeverityBadge>);
    expect(screen.getByText("Capacity", { exact: false }).closest(".mantine-Badge-root")?.getAttribute("style")).toContain("orange");
    unmount();
    renderWithProviders(
      <SeverityBadge severity="WARNING" dimmed>
        Capacity
      </SeverityBadge>,
    );
    const badge = screen.getByText("Capacity", { exact: false }).closest(".mantine-Badge-root");
    expect(badge?.getAttribute("style")).toContain("gray");
    expect(badge?.getAttribute("style")).not.toContain("orange");
    expect(badge).toHaveTextContent("Warning: Capacity");
  });
});
