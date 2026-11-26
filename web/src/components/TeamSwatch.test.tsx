import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import TeamSwatch from "./TeamSwatch";

describe("TeamSwatch", () => {
  test("is a decorative mark: aria-hidden, no text, the key in data-team-colour, the fill the key's per-scheme variable", () => {
    const { container } = render(<TeamSwatch colour="TEAL" />);
    const swatch = container.querySelector("span") as HTMLElement;
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch).toHaveAttribute("data-team-colour", "TEAL");
    expect(swatch).toHaveTextContent("");
    expect(swatch.style.backgroundColor).toBe("var(--astrolabe-team-teal)");
  });

  test("a size overrides the square's side", () => {
    const { container } = render(<TeamSwatch colour="INDIGO" size={16} />);
    const swatch = container.querySelector("span") as HTMLElement;
    expect([swatch.style.width, swatch.style.height]).toEqual(["16px", "16px"]);
  });

  test("a team without a colour yet keeps its box as an unmarked, hidden placeholder (no layout shift when the colour arrives)", () => {
    const { container } = render(<TeamSwatch colour={undefined} size={16} />);
    const placeholder = container.querySelector("span") as HTMLElement;
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder).not.toHaveAttribute("data-team-colour");
    expect(placeholder.style.backgroundColor).toBe("");
    expect([placeholder.style.width, placeholder.style.height]).toEqual(["16px", "16px"]);
  });
});
