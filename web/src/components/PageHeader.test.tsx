import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
import PageHeader from "./PageHeader";
import { openPageInfo } from "../test/pageInfo";
import { renderWithProviders, screen, waitFor, within } from "../test/render";

const ABOUT = { name: "About this page: Labels" };

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
    expect(screen.getByRole("link", { name: "Back to files" })).toHaveAttribute("href", "/files");
    expect(screen.getByRole("button", { name: "New label" })).toBeInTheDocument();
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
  });

  test("the title alone renders nothing else: no info button", () => {
    renderWithProviders(<PageHeader title="Users" />);
    expect(screen.getByRole("heading", { level: 2, name: "Users" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("a description is behind an info button: named, collapsed, hidden print-wise and nothing shows until it is clicked", () => {
    renderWithProviders(<PageHeader title="Labels" description="The only labels files may carry." />);
    const button = screen.getByRole("button", ABOUT);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).not.toHaveAttribute("aria-controls");
    expect(button).toHaveAttribute("data-print", "hide");
    expect(screen.queryByText("The only labels files may carry.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("facts are on the page, not behind the button: visible with no description, the button only for a description", () => {
    renderWithProviders(<PageHeader title="Payments" facts={<span>Manager: Cara</span>} />);
    expect(screen.getByText("Manager: Cara")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^About this page/ })).not.toBeInTheDocument();
  });

  test("the info button sits right after the title, in a nowrap group with the lead, before the addon", () => {
    renderWithProviders(<PageHeader title="Payments" titleLead={<i data-testid="lead" />} titleAddon={<b data-testid="addon" />} description="About payments." />);
    const group = screen.getByRole("heading", { level: 2, name: "Payments" }).parentElement as HTMLElement;
    expect(Array.from(group.children).map((child) => child.getAttribute("data-testid") ?? child.tagName)).toEqual(["lead", "H2", "BUTTON"]);
    expect(group.nextElementSibling).toHaveAttribute("data-testid", "addon");
    expect(screen.getByRole("button", { name: "About this page: Payments" })).toHaveAttribute("aria-label", "About this page: Payments");
  });

  test("the button is at least 24 px (WCAG 2.5.8)", () => {
    renderWithProviders(<PageHeader title="Labels" description="x" />);
    expect(screen.getByRole("button", ABOUT).getAttribute("style") ?? "").toMatch(/--ai-size:[^;]*(1\.5rem|24px)/);
  });

  test("facts are on the page and never print-only; a generic description has no print copy, an entity's own written text has one", () => {
    const { unmount } = renderWithProviders(<PageHeader title="Labels" description="A generic intro." facts="A status." />);
    expect(screen.getByText("A status.")).toBeVisible();
    expect(document.querySelector('[data-print="only"]')).toBeNull();
    unmount();
    renderWithProviders(<PageHeader title="Payments" description="Money movers." printDescription />);
    const copy = document.querySelector('[data-print="only"]') as HTMLElement;
    expect(copy).toHaveTextContent("Money movers.");
    expect(screen.getByRole("button", { name: /^About this page/ })).toHaveAttribute("data-print", "hide");
  });

  test("a click opens the description in a dialog the button names and controls", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PageHeader title="Labels" description="The only labels files may carry." />);
    const dialog = await openPageInfo(user);
    const button = screen.getByRole("button", ABOUT);
    expect(within(dialog).getByText("The only labels files may carry.")).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", dialog.id);
    expect(screen.getByRole("heading", { level: 2, name: "Labels" })).toBeInTheDocument();
  });

  test("Escape closes it and the focus returns to the button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PageHeader title="Labels" description="The only labels files may carry." />);
    await openPageInfo(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("The only labels files may carry.")).not.toBeInTheDocument());
    expect(screen.getByRole("button", ABOUT)).toHaveFocus();
    expect(screen.getByRole("button", ABOUT)).toHaveAttribute("aria-expanded", "false");
  });

  test("a click outside closes it", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <PageHeader title="Labels" description="The only labels files may carry." />
        <p>Elsewhere</p>
      </>,
    );
    await openPageInfo(user);
    await user.click(screen.getByText("Elsewhere"));
    await waitFor(() => expect(screen.queryByText("The only labels files may carry.")).not.toBeInTheDocument());
  });

  test("a link inside the description stays a usable link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PageHeader title="Labels" description={<Link to="/files">The files</Link>} />);
    const dialog = await openPageInfo(user);
    expect(within(dialog).getByRole("link", { name: "The files" })).toHaveAttribute("href", "/files");
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
