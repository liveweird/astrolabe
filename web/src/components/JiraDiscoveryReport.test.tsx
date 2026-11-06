import { afterEach, describe, expect, test } from "vitest";
import i18n from "../i18n";
import { renderWithProviders, screen, within } from "../test/render";
import { DISCOVERY } from "../test/jira";
import JiraDiscoveryReport from "./JiraDiscoveryReport";

describe("JiraDiscoveryReport", () => {
  test("counts, the levels and one line per marker found, with the schema.custom that identified it", () => {
    renderWithProviders(<JiraDiscoveryReport discovery={DISCOVERY} />);
    expect(screen.getByText("On the site: 61 fields and 7 issue types, read 2026-11-06 09:30 UTC.")).toBeInTheDocument();
    expect(screen.getByText(/Hierarchy levels: Level 3 — Program; Level 2 — Initiative; Level 1 — Epic; Level 0 — Story\./)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "What the defaults rest on" });
    expect(within(list).getByText(/Target start found as “Target start” \(customfield_10020, com\.atlassian\.jpo:jpo-custom-field-baseline-start\)/)).toBeInTheDocument();
    expect(within(list).getByText(/Team field found as “Team” \(customfield_10001, .*atlassian-team\)/)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("every marker that was not found is a visible amber line", () => {
    const markers = { ...DISCOVERY.markers, targetStart: undefined, targetEnd: undefined, team: undefined };
    renderWithProviders(<JiraDiscoveryReport discovery={{ ...DISCOVERY, markers }} />);
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(3);
    expect(notes[0]).toHaveTextContent("Target start was not found");
    expect(notes[1]).toHaveTextContent("Target end was not found");
    expect(notes[2]).toHaveTextContent("No Team field was found");
  });

  test("a legacy Parent Link field is an informational line, absent otherwise", () => {
    const legacy = { id: "customfield_10050", name: "Parent Link", type: null, custom: "com.atlassian.jpo:jpo-custom-field-parent" };
    renderWithProviders(<JiraDiscoveryReport discovery={{ ...DISCOVERY, markers: { ...DISCOVERY.markers, legacyParentLink: legacy } }} />);
    expect(screen.getByText(/A legacy Parent Link field exists: “Parent Link” \(customfield_10050/)).toBeInTheDocument();
    expect(screen.queryByText(/Epic Link/)).not.toBeInTheDocument();
  });

  test("a truncated snapshot says some fields cannot be chosen", () => {
    renderWithProviders(<JiraDiscoveryReport discovery={{ ...DISCOVERY, fieldsTruncated: true }} />);
    expect(screen.getByRole("note")).toHaveTextContent(/some fields cannot be chosen/);
  });

  test("the counts take the plural of their number: EN one/other", () => {
    const text = (fields: number, types: number) => {
      const { unmount } = renderWithProviders(<JiraDiscoveryReport discovery={{ ...DISCOVERY, fieldCount: fields, issueTypeCount: types }} />);
      const line = screen.getByText(/^On the site:/).textContent;
      unmount();
      return line;
    };
    expect(text(1, 1)).toBe("On the site: 1 field and 1 issue type, read 2026-11-06 09:30 UTC.");
    expect(text(2, 2)).toBe("On the site: 2 fields and 2 issue types, read 2026-11-06 09:30 UTC.");
    expect(text(23, 60)).toBe("On the site: 23 fields and 60 issue types, read 2026-11-06 09:30 UTC.");
  });

  describe("in Polish", () => {
    afterEach(() => i18n.changeLanguage("en"));

    test.each([
      [1, 1, "Na witrynie: 1 pole i 1 typ zgłoszenia, odczytane 2026-11-06 09:30 UTC."],
      [2, 2, "Na witrynie: 2 pola i 2 typy zgłoszeń, odczytane 2026-11-06 09:30 UTC."],
      [23, 23, "Na witrynie: 23 pola i 23 typy zgłoszeń, odczytane 2026-11-06 09:30 UTC."],
      [60, 60, "Na witrynie: 60 pól i 60 typów zgłoszeń, odczytane 2026-11-06 09:30 UTC."],
    ])("%i fields and %i types take the few/many forms", async (fields, types, expected) => {
      await i18n.changeLanguage("pl");
      renderWithProviders(<JiraDiscoveryReport discovery={{ ...DISCOVERY, fieldCount: fields, issueTypeCount: types }} />);
      expect(screen.getByText(/^Na witrynie:/).textContent).toBe(expected);
    });
  });
});
