import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import { charCountDescription } from "./charCount";

describe("charCountDescription", () => {
  test("nearLimit (the default) shows nothing until 80 % of the limit", () => {
    expect(charCountDescription(10, 100)).toBeUndefined();
    expect(charCountDescription(79, 100)).toBeUndefined();
    expect(charCountDescription(80, 100)).toBeDefined();
  });

  test("always renders the counter as `current / max`", () => {
    renderWithProviders(<>{charCountDescription(5, 100, "always")}</>);
    expect(screen.getByText("5 / 100")).toBeInTheDocument();
  });
});
