import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import type { JiraImportItem, JiraImportPreview } from "../api/jira";
import { jsonResponse } from "../test/http";
import type { Handler } from "../test/jiraImportHarness";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { hangUntilAborted, installImportApi, previewScope } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

// Suggested matches (1.15): "Link instead" only records a pending change; "Preview again" re-reads with `matches`; Import waits until then.

const SUGGESTION = { nodeId: 41, nodeName: "Old epic six" };
const ROW = "IMP-10";

/** The first preview: IMP-10 is a CREATE under an existing project that looks like the unlinked plan item "Old epic six". */
const suggested = (): JiraImportItem[] => PREVIEW_ITEMS.map((item) => (item.issueKey === ROW ? { ...item, suggestion: SUGGESTION } : item));
/** The preview after the user confirmed it: the same row is a BIND to that node, flagged `MATCH_CONFIRMED`. */
const confirmed = (): JiraImportItem[] =>
  PREVIEW_ITEMS.map((item) =>
    item.issueKey === ROW ? { ...item, action: "BIND", parent: null, team: null, estimateMd: null, target: { nodeId: 41, nodeName: "Old epic six" }, infos: ["MATCH_CONFIRMED"] } : item,
  );

let answers: JiraImportPreview[];
let api: ReturnType<typeof installImportApi>;

beforeEach(() => {
  // Each answer carries its own `asOf` (the step is keyed by it, so a re-preview starts with no pending change).
  answers = [previewOf(suggested(), { asOf: 1 }), previewOf(confirmed(), { asOf: 2 }), previewOf(suggested(), { asOf: 3 })];
  api = installImportApi({
    preview: (body) => {
      const sent = (body as { matches?: unknown[] }).matches;
      return jsonResponse(200, sent === undefined ? answers[0] : answers[1]);
    },
    apply: () => jsonResponse(200, { revision: 13, created: [], bound: [], skipped: [] }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = () =>
  renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={vi.fn()} />, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
const table = () => screen.getByRole("table", { name: "Import preview" });
const linkInstead = () => screen.getByRole("button", { name: `Link instead: ${ROW} to Old epic six` });
const createInstead = () => screen.getByRole("button", { name: `Create instead: ${ROW} as a new item` });
const importButton = () => screen.getByRole("button", { name: /^Import \(/ });
const previewAgain = () => screen.getByRole("button", { name: "Preview again" });
const shownKeys = () =>
  within(table())
    .queryAllByRole("checkbox", { name: /^Import / })
    .map((checkbox) => checkbox.getAttribute("aria-label")!.replace("Import ", ""));

async function previewed() {
  const user = userEvent.setup();
  open();
  await previewScope(user);
  return user;
}

describe("JiraImportModal: suggested matches", () => {
  test("a CREATE row with a suggestion says what it looks like and offers Link instead; no other row does", async () => {
    await previewed();
    expect(within(table()).getByText("Looks like “Old epic six” in the plan, which is not linked yet")).toBeInTheDocument();
    expect(linkInstead()).toHaveTextContent("Link instead");
    expect(screen.getAllByRole("button", { name: /^Link instead/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Create instead/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 item looks like a plan item that is not linked yet. “Link instead” avoids a duplicate.", { exact: false })).toBeInTheDocument();
  });

  test("a click only records a pending change: the row and a banner say so, Import is disabled and nothing is sent", async () => {
    const user = await previewed();
    await user.click(linkInstead());
    expect(within(table()).getByText("Will be linked to “Old epic six” after the next preview")).toBeInTheDocument();
    const banner = screen.getByText("1 change to the matches is waiting. Preview again to see what the import would do.").closest("[role=note]") as HTMLElement;
    expect(banner).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Preview again" })).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    // The footer's own "Preview again" steps aside, so the name is never doubled.
    expect(screen.getAllByRole("button", { name: "Preview again" })).toHaveLength(1);
    expect(api.previews()).toHaveLength(1);
    expect(api.applies()).toHaveLength(0);
  });

  test("Undo takes the pending change back and Import is enabled again", async () => {
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(screen.getByRole("button", { name: `Undo the change for ${ROW}` }));
    expect(linkInstead()).toBeInTheDocument();
    expect(screen.queryByText(/changes? to the matches/)).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
  });

  test("Preview again sends matches once and leaves the scope otherwise unchanged; the confirmed row then offers Create instead", async () => {
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(within(table()).getByText("Linked to a plan item with a different name, as you confirmed")).toBeInTheDocument());
    const [first, second] = api.previews() as Array<Record<string, unknown>>;
    expect(first).not.toHaveProperty("matches");
    expect(second).toEqual({ ...first, matches: [{ jiraId: "95010", nodeId: 41 }] });
    expect(createInstead()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Link instead/ })).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
    // The new preview starts with fresh ticks and no pending change.
    expect(screen.queryByText(/changes? to the matches/)).not.toBeInTheDocument();
  });

  test("undoing one of two confirmed links sends the next preview with the other entry only", async () => {
    // IMP-4 also carries a suggestion; the second answer shows both confirmed, the third only IMP-4.
    const other = { nodeId: 50, nodeName: "Old epic one" };
    const both = (...keys: string[]) => (list: JiraImportItem[]) =>
      list.map((item) =>
        item.issueKey !== null && keys.includes(item.issueKey) && item.issueKey === "IMP-4"
          ? { ...item, action: "BIND" as const, parent: null, team: null, target: { nodeId: 50, nodeName: "Old epic one" }, infos: ["MATCH_CONFIRMED" as const] }
          : item,
      );
    const withOther = (list: JiraImportItem[]) => list.map((item) => (item.issueKey === "IMP-4" ? { ...item, suggestion: other } : item));
    const answersByCall = [
      previewOf(withOther(suggested()), { asOf: 1 }),
      previewOf(both("IMP-4")(confirmed()), { asOf: 2 }),
      previewOf(both("IMP-4")(suggested()), { asOf: 3 }),
    ];
    api = installImportApi({ preview: () => jsonResponse(200, answersByCall[api.previews().length - 1]) });
    const user = userEvent.setup();
    open();
    await previewScope(user);
    await user.click(linkInstead());
    await user.click(screen.getByRole("button", { name: "Link instead: IMP-4 to Old epic one" }));
    expect(screen.getByText("2 changes to the matches are waiting. Preview again to see what the import would do.")).toBeInTheDocument();
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    await user.click(createInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(api.previews()).toHaveLength(3));
    const sent = api.previews() as Array<{ matches?: unknown }>;
    expect(sent[1].matches).toEqual(expect.arrayContaining([{ jiraId: "95010", nodeId: 41 }, { jiraId: "95004", nodeId: 50 }]));
    expect(sent[1].matches).toHaveLength(2);
    expect(sent[2].matches).toEqual([{ jiraId: "95004", nodeId: 50 }]);
  });

  test("the apply repeats the matches of the preview it was read under", async () => {
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    await user.click(importButton());
    await waitFor(() => expect(api.applies()).toHaveLength(1));
    expect((api.applies()[0] as { matches?: unknown }).matches).toEqual([{ jiraId: "95010", nodeId: 41 }]);
  });

  test("undoing the only confirmed link sends the next preview without the matches member", async () => {
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    await user.click(createInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(api.previews()).toHaveLength(3));
    expect(api.previews()[2]).not.toHaveProperty("matches");
  });

  test("Possible matches only narrows the rows, composes with the search and leaves the ticks alone", async () => {
    const user = await previewed();
    expect(shownKeys()).toHaveLength(7);
    const selected = screen.getByText("7 of 7 selected");
    await user.click(screen.getByRole("switch", { name: "Possible matches only" }));
    expect(shownKeys()).toEqual([ROW]);
    expect(screen.getByText("Showing 1 of 9")).toBeInTheDocument();
    expect(selected).toHaveTextContent("7 of 7 selected");
    // Composed with the search: a query that does not match the matching row leaves nothing.
    await user.type(screen.getByRole("textbox", { name: "Search the preview" }), "IMP-4");
    expect(screen.getByText("No rows match “IMP-4”.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Possible matches only" }));
    expect(shownKeys()).toEqual(["IMP-4"]);
  });

  test("under the import filter (the dialog's default) the extra sentence is shown; without a filter it is not", async () => {
    const user = await previewed();
    expect(screen.getByText(/Items the filter left out are not considered\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("switch", { name: /^Leave out done items/ }));
    const days = screen.getByRole("textbox", { name: /^Updated within/ });
    await user.clear(days);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "What the import would do" })).toBeInTheDocument());
    expect(screen.getByText(/looks like a plan item/)).toBeInTheDocument();
    expect(screen.queryByText(/Items the filter left out are not considered\./)).not.toBeInTheDocument();
  });

  test("a preview with no suggestion and no confirmed link shows no match note and no switch", async () => {
    api = installImportApi({ preview: () => jsonResponse(200, previewOf(PREVIEW_ITEMS)) });
    await previewed();
    expect(screen.queryByRole("switch", { name: "Possible matches only" })).not.toBeInTheDocument();
    expect(screen.queryByText(/looks like a plan item/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /instead/ })).not.toBeInTheDocument();
  });

  test("two previews that share an asOf still start the step afresh: the pending change is gone after Preview again", async () => {
    answers = [previewOf(suggested(), { asOf: 7 }), previewOf(confirmed(), { asOf: 7 })];
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    expect(screen.queryByText(/changes? to the matches/)).not.toBeInTheDocument();
    expect(screen.queryByText("Will be linked to “Old epic six” after the next preview")).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
  });

  test("a match-driven Preview again keeps the ticks, team overrides and owner picks of rows that keep their action, and drops those of the row whose action changed", async () => {
    const user = await previewed();
    const rowOf = (key: string) => within(table()).getByRole("checkbox", { name: `Import ${key}` }).closest("tr")!;
    await user.click(within(table()).getByRole("checkbox", { name: "Import IMP-5" }));
    await user.click(within(table()).getByRole("checkbox", { name: `Import ${ROW}` }));
    await user.selectOptions(await within(rowOf("IMP-5")).findByRole("combobox", { name: "Team for IMP-5" }), "IMP Team");
    await user.click(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" }));
    await user.click(await screen.findByRole("option", { name: "Pat Planner" }));
    await user.click(linkInstead());
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    // The unticked IMP-5 stays unticked with its team and IMP-2 keeps its owner; the confirmed row changed its action, so it starts ticked again.
    expect(within(table()).getByRole("checkbox", { name: "Import IMP-5" })).not.toBeChecked();
    expect(within(rowOf("IMP-5")).getByRole("combobox", { name: "Team for IMP-5" })).toHaveValue("5");
    expect(within(rowOf("IMP-2")).getByRole("combobox", { name: "Owner for IMP-2" })).toHaveValue("Pat Planner");
    expect(within(table()).getByRole("checkbox", { name: `Import ${ROW}` })).toBeChecked();
    expect(importButton()).toHaveTextContent("Import (6)");
    await user.click(within(table()).getByRole("checkbox", { name: "Import IMP-5" }));
    await user.click(importButton());
    await waitFor(() => expect(api.applies()).toHaveLength(1));
    const items = (api.applies()[0] as { items: Array<{ jiraId: string; overrides?: Record<string, number> }> }).items;
    expect(items.find((item) => item.jiraId === "95005")?.overrides).toEqual({ teamId: 5 });
    expect(items.find((item) => item.jiraId === "95002")?.overrides).toEqual({ ownerPersonId: 9 });
  });

  test("a plain Preview again (no change waiting) starts afresh: the ticks are reset as before", async () => {
    const user = await previewed();
    await user.click(within(table()).getByRole("checkbox", { name: "Import IMP-5" }));
    await user.click(previewAgain());
    await waitFor(() => expect(api.previews()).toHaveLength(2));
    expect(within(table()).getByRole("checkbox", { name: "Import IMP-5" })).toBeChecked();
  });

  test("a failed Preview again keeps the pending change and Import disabled; the banner's retry carries matches", async () => {
    let calls = 0;
    const handler: Handler = () => {
      calls += 1;
      return calls === 2 ? jsonResponse(500, { title: "x", status: 500 }) : jsonResponse(200, calls === 1 ? answers[0] : answers[1]);
    };
    api = installImportApi({ preview: handler });
    const user = await previewed();
    await user.click(linkInstead());
    await user.click(previewAgain());
    await screen.findByRole("alert");
    expect(screen.getByText("Will be linked to “Old epic six” after the next preview")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    await user.click(previewAgain());
    await waitFor(() => expect(createInstead()).toBeInTheDocument());
    const sent = api.previews() as Array<{ matches?: unknown }>;
    expect(sent).toHaveLength(3);
    expect(sent[1].matches).toEqual([{ jiraId: "95010", nodeId: 41 }]);
    expect(sent[2].matches).toEqual([{ jiraId: "95010", nodeId: 41 }]);
  });

  test("when the preview times out, the failure alert's own Preview again carries the pending matches too", async () => {
    let calls = 0;
    const handler: Handler = (body, init) => {
      calls += 1;
      return calls === 2 ? hangUntilAborted(body, init) : jsonResponse(200, calls === 1 ? answers[0] : answers[1]);
    };
    api = installImportApi({ preview: handler });
    const user = await previewed();
    await user.click(linkInstead());
    vi.useFakeTimers();
    try {
      fireEvent.click(previewAgain());
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("took longer than 3 minutes");
      expect(importButton()).toBeDisabled();
      vi.useRealTimers();
      await user.click(within(alert).getByRole("button", { name: "Preview again" }));
      await waitFor(() => expect(createInstead()).toBeInTheDocument());
      expect((api.previews()[2] as { matches?: unknown }).matches).toEqual([{ jiraId: "95010", nodeId: 41 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a suggested row whose parent is unticked keeps the fixed row: the badge and the button share a line, and the note and the sentence are one clamped line each", async () => {
    const withParent = suggested().map((item) =>
      item.issueKey === ROW ? { ...item, parent: { kind: "EXISTING" as const, nodeId: 77, nodeName: "Existing Project", rowJiraId: "95009" } } : item,
    );
    answers = [previewOf(withParent, { asOf: 1 })];
    api = installImportApi({ preview: () => jsonResponse(200, answers[0]) });
    const user = await previewed();
    await user.click(within(table()).getByRole("checkbox", { name: "Import IMP-9" }));
    const row = within(table()).getByRole("checkbox", { name: `Import ${ROW}` }).closest("tr")!;
    const note = within(row).getByText("Its parent IMP-9 is not ticked, so this is not imported.");
    const line = within(row).getByText("Looks like “Old epic six” in the plan, which is not linked yet");
    const badge = within(row).getByText("Not imported");
    const button = within(row).getByRole("button", { name: `Link instead: ${ROW} to Old epic six` });
    expect(button.parentElement).toBe(badge.closest(".mantine-Badge-root")!.parentElement);
    expect(note.style.getPropertyValue("--text-line-clamp")).toBe("1");
    expect(line.style.getPropertyValue("--text-line-clamp")).toBe("1");
    expect(line).toHaveAttribute("title", "Looks like “Old epic six” in the plan, which is not linked yet");
  });
});
