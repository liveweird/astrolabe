import { describe, expect, test } from "vitest";
import PageHeader from "./PageHeader";
import { renderWithProviders, screen } from "../test/render";

describe("PageHeader", () => {
  test("renders the title as the page's level-2 heading with the optional parts", () => {
    renderWithProviders(
      <PageHeader
        title="Labels"
        description="The only labels files may carry."
        backTo={{ to: "/files", label: "Back to files" }}
        actions={<button type="button">New label</button>}
        toolbar={<div data-testid="toolbar" />}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Labels" })).toBeInTheDocument();
    expect(screen.getByText("The only labels files may carry.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to files" })).toHaveAttribute("href", "/files");
    expect(screen.getByRole("button", { name: "New label" })).toBeInTheDocument();
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
  });

  test("the title alone renders nothing else", () => {
    renderWithProviders(<PageHeader title="Users" />);
    expect(screen.getByRole("heading", { level: 2, name: "Users" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("names the tab after the title, in the \"{page} · Astrolabe\" form", () => {
    renderWithProviders(<PageHeader title="Teams" />);
    expect(document.title).toBe("Teams · Astrolabe");
  });

  test("a title that is the brand sets the brand alone", () => {
    renderWithProviders(<PageHeader title="Astrolabe" />);
    expect(document.title).toBe("Astrolabe");
  });

  test("a blank title (an entity name that has not arrived) never reads \" · Astrolabe\"", () => {
    renderWithProviders(<PageHeader title="  " />);
    expect(document.title).toBe("Astrolabe");
  });

  test("a changed title replaces the tab title", () => {
    const { rerender } = renderWithProviders(<PageHeader title="Alpha" />);
    expect(document.title).toBe("Alpha · Astrolabe");
    rerender(<PageHeader title="Beta" />);
    expect(document.title).toBe("Beta · Astrolabe");
  });
});
