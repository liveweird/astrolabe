import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { renderWithProviders, screen } from "../test/render";
import EntityLink from "./EntityLink";
import EntitySentence from "./EntitySentence";

describe("EntitySentence", () => {
  test("the translated sentence keeps its words around the links, in the translator's order", () => {
    renderWithProviders(
      <p data-testid="sentence">
        <EntitySentence
          text={(marks) => `Acknowledged on 2026-11-06 by ${marks.by} · changed since`}
          slots={{ by: <EntityLink entity={{ kind: "person", id: 5 }} name="Ada" /> }}
        />
      </p>,
    );
    expect(screen.getByTestId("sentence")).toHaveTextContent("Acknowledged on 2026-11-06 by Ada · changed since");
    expect(screen.getByRole("link", { name: "Open person Ada" })).toHaveAttribute("href", "/people/5");
  });

  test("several slots, a slot twice used or none at all: every mark is replaced and nothing else is touched", () => {
    renderWithProviders(
      <p data-testid="sentence">
        <EntitySentence
          text={(marks) => `${marks.a} then ${marks.b}, ${marks.a} again`}
          slots={{ a: <b>one</b>, b: "two" }}
        />
      </p>,
    );
    expect(screen.getByTestId("sentence")).toHaveTextContent("one then two, one again");
    expect(screen.getAllByText("one")).toHaveLength(2);
  });

  test.each(["<b>x</b>by", "\uE000by\uE001", "{{by}} by"])("a name like %j renders literally: a name is only ever a slot's content, never parsed as a mark or markup", (name) => {
    renderWithProviders(
      <p data-testid="sentence">
        <EntitySentence text={(marks) => `Acknowledged by ${marks.by}.`} slots={{ by: <EntityLink entity={{ kind: "person", id: 5 }} name={name} /> }} />
      </p>,
    );
    expect(screen.getByTestId("sentence")).toHaveTextContent(`Acknowledged by ${name}.`);
    expect(screen.getByRole("link", { name: `Open person ${name}` })).toHaveTextContent(name);
    expect(document.querySelector("b")).toBeNull();
  });

  test("a real translated sentence in Polish puts the name where its grammar wants it", async () => {
    await i18n.changeLanguage("pl");
    try {
      renderWithProviders(
        <p data-testid="sentence">
          <EntitySentence text={(marks) => i18n.t("teams.managerLine", { name: marks.manager })} slots={{ manager: <EntityLink entity={{ kind: "person", id: 1 }} name="Ada" /> }} />
        </p>,
      );
      expect(screen.getByTestId("sentence")).toHaveTextContent("Kierownik/czka: Ada");
      expect(screen.getByRole("link", { name: "Otwórz osobę Ada" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
