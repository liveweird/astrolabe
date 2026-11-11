import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import JiraKeyWithPrevious from "./JiraKeyWithPrevious";

const SITE = "https://acme.atlassian.net";

describe("JiraKeyWithPrevious", () => {
  test("a moved key shows the current key as the link and a muted 'was' with the old one, named together", () => {
    renderWithProviders(<JiraKeyWithPrevious issueKey="NEW-6" previousKey="OLD-10" siteUrl={SITE} />);
    expect(screen.getByRole("link", { name: /NEW-6/ })).toHaveAttribute("href", `${SITE}/browse/NEW-6`);
    expect(screen.getByText("was OLD-10")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "NEW-6, was OLD-10" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /OLD-10/ })).not.toBeInTheDocument();
  });

  test.each([[null], [undefined], ["NEW-6"]])("with %s as the previous key only the link shows", (previousKey) => {
    renderWithProviders(<JiraKeyWithPrevious issueKey="NEW-6" previousKey={previousKey} siteUrl={SITE} />);
    expect(screen.getByRole("link", { name: /NEW-6/ })).toBeInTheDocument();
    expect(screen.queryByText(/^was /)).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
