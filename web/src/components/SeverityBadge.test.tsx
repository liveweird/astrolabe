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
});
