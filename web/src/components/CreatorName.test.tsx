import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import CreatorName from "./CreatorName";

describe("CreatorName", () => {
  test("a login with an active person is the person's page", () => {
    renderWithProviders(<CreatorName creator={{ name: "Ada Admin", personId: 8 }} />);
    expect(screen.getByRole("link", { name: "Open person Ada Admin" })).toHaveAttribute("href", "/people/8");
  });

  test("a login without a person is plain text, and a gone login is a dimmed dash", () => {
    const first = renderWithProviders(<CreatorName creator={{ name: "Ada Admin", personId: null }} />);
    expect(screen.getByText("Ada Admin")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    first.unmount();
    renderWithProviders(<CreatorName creator={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
