import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import BadgeLink from "./BadgeLink";

describe("BadgeLink", () => {
  test("is a real link carrying the visible text", () => {
    renderWithProviders(
      <BadgeLink to="/roadmap?flagged=true" color="orange">
        3 warnings
      </BadgeLink>,
    );
    expect(screen.getByRole("link", { name: "3 warnings" })).toHaveAttribute("href", "/roadmap?flagged=true");
  });

  test("takes the accessible name it is given, which starts with the visible text", () => {
    renderWithProviders(
      <BadgeLink to="/teams?warning=wip" color="gray" ariaLabel="3 warnings: elsewhere">
        3 warnings
      </BadgeLink>,
    );
    const link = screen.getByRole("link", { name: "3 warnings: elsewhere" });
    expect(link).toHaveTextContent("3 warnings");
    expect(link).toHaveAttribute("aria-label", "3 warnings: elsewhere");
  });
});
