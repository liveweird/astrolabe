import { afterEach, describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import EntityLink from "./EntityLink";

const ROLES_KEY = "astrolabe.auth.roles";

afterEach(() => localStorage.clear());

describe("EntityLink", () => {
  test("a name is a link to its entity's page, its accessible name saying what it opens", () => {
    renderWithProviders(<EntityLink entity={{ kind: "project", id: 7 }} name="Invoices" />);
    const link = screen.getByRole("link", { name: "Open project Invoices" });
    expect(link).toHaveAttribute("href", "/projects/7");
    expect(link).toHaveTextContent("Invoices");
  });

  test.each([
    [{ kind: "team", id: 3 }, "Open team Backend", "/teams/3"],
    [{ kind: "person", id: 5 }, "Open person Backend", "/people/5"],
    [{ kind: "program", id: 4 }, "Open program Backend", "/roadmap?mode=overview&programId=4"],
    [{ kind: "workStream", id: 2 }, "Open work stream Backend", "/roadmap?mode=overview&workStreamId=2"],
    [{ kind: "milestone", id: 11, projectId: 7 }, "Open milestone Backend", "/projects/7?milestone=11"],
  ] as const)("%j opens as %s", (entity, name, href) => {
    renderWithProviders(<EntityLink entity={entity} name="Backend" />);
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  });

  test("a bare link takes its surroundings' font; an explicit size keeps its own", () => {
    renderWithProviders(
      <>
        <EntityLink entity={{ kind: "team", id: 3 }} name="Bare" />
        <EntityLink entity={{ kind: "team", id: 4 }} name="Sized" size="xs" />
        <EntityLink entity={null} name="Plain" />
      </>,
    );
    expect(screen.getByRole("link", { name: "Open team Bare" })).toHaveAttribute("data-inherit", "true");
    expect(screen.getByRole("link", { name: "Open team Sized" })).not.toHaveAttribute("data-inherit");
    expect(screen.getByText("Plain")).toHaveAttribute("data-inherit", "true");
  });

  test("children replace the visible text, the accessible name stays the entity's", () => {
    renderWithProviders(
      <EntityLink entity={{ kind: "team", id: 3 }} name="Backend">
        <span>[swatch] Backend</span>
      </EntityLink>,
    );
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveTextContent("[swatch] Backend");
  });

  test("a null entity (id unknown) and a current one (the page's own subject) are plain text, never a link", () => {
    renderWithProviders(
      <>
        <EntityLink entity={null} name="Nameless" size="sm" />
        <EntityLink entity={{ kind: "project", id: 7 }} name="Itself" current size="sm" />
      </>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Nameless")).toBeInTheDocument();
    expect(screen.getByText("Itself")).toBeInTheDocument();
  });

  test("a login's name is a link for an administrator only", () => {
    const { unmount } = renderWithProviders(<EntityLink entity={{ kind: "user", id: 9 }} name="Ola" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Ola")).toBeInTheDocument();
    unmount();
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    renderWithProviders(<EntityLink entity={{ kind: "user", id: 9 }} name="Ola" />);
    expect(screen.getByRole("link", { name: "Open user Ola" })).toHaveAttribute("href", "/users/9/edit");
  });

  test("`to` and `aria-label` replace the destination and the accessible name; `secondary` leaves the tab order, `stop` joins the grid", () => {
    renderWithProviders(
      <>
        <EntityLink entity={{ kind: "project", id: 7 }} name="Invoices" to="/elsewhere" aria-label="Invoices - elsewhere" />
        <EntityLink entity={{ kind: "team", id: 3 }} name="Backend" secondary />
        <EntityLink entity={{ kind: "team", id: 4 }} name="Payments" stop={{ "data-grid-pos": "1,2", "data-grid-end": 2, tabIndex: 0 }} />
      </>,
    );
    expect(screen.getByRole("link", { name: "Invoices - elsewhere" })).toHaveAttribute("href", "/elsewhere");
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveAttribute("tabindex", "-1");
    const stop = screen.getByRole("link", { name: "Open team Payments" });
    expect(stop).toHaveAttribute("tabindex", "0");
    expect(stop).toHaveAttribute("data-grid-pos", "1,2");
  });

  test("a name that is not a link keeps the cell's roving stop", () => {
    const stop = { "data-grid-pos": "1,2", "data-grid-end": 2, tabIndex: 0 } as const;
    renderWithProviders(<EntityLink entity={{ kind: "project", id: 7 }} name="Itself" current stop={stop} />);
    const text = screen.getByText("Itself");
    expect(text).toHaveAttribute("data-grid-pos", "1,2");
    expect(text).toHaveAttribute("tabindex", "0");
  });

  test("`stop` and `secondary` exclude each other", () => {
    const stop = { "data-grid-pos": "1,2", "data-grid-end": 2, tabIndex: 0 } as const;
    // @ts-expect-error a link is the cell's stop or a secondary one, never both
    renderWithProviders(<EntityLink entity={{ kind: "team", id: 3 }} name="Backend" stop={stop} secondary />);
    expect(screen.getByRole("link", { name: "Open team Backend" })).toHaveAttribute("tabindex", "-1");
  });
});
