import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import JiraKeyLink from "./JiraKeyLink";

describe("JiraKeyLink", () => {
  test("links to the issue in Jira in a new tab with rel noopener, and says so to a screen reader", () => {
    renderWithProviders(<JiraKeyLink issueKey="E2E-1" siteUrl="https://acme.atlassian.net" />);
    const link = screen.getByRole("link", { name: /E2E-1/ });
    expect(link).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link).toHaveTextContent("(opens in Jira)");
  });

  test("an icon-only link carries the key in its name", () => {
    renderWithProviders(<JiraKeyLink issueKey="E2E-1" siteUrl="https://acme.atlassian.net" iconOnly />);
    expect(screen.getByRole("link", { name: "Open E2E-1 in Jira" })).toBeInTheDocument();
  });

  test("with no usable site the key is plain text", () => {
    renderWithProviders(<JiraKeyLink issueKey="E2E-1" siteUrl="javascript:alert(1)" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("E2E-1")).toBeInTheDocument();
  });
});
