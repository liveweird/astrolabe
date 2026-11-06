import { describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { theme } from "../theme";
import type { JiraMark, JiraMarks } from "../utils/jiraMarks";
import { markKey } from "../utils/jiraMarks";
import { JiraRowMark, ProjectJiraButton, ProjectJiraChip, TeamJiraChip } from "./JiraChips";

const mark = (over: Partial<JiraMark> = {}): JiraMark => ({ bindingId: 1, connectionId: 1, key: "E2E-3", siteUrl: "https://acme.atlassian.net", warnings: 0, infos: 0, gone: false, ...over });
const marks = (entries: [string, JiraMark][], warnings = 0, infos = 0, over: Partial<JiraMarks> = {}): JiraMarks => ({ byNode: new Map(entries), warnings, infos, answered: true, stale: false, connections: [], ...over });

function show(ui: React.ReactElement) {
  return render(
    <MantineProvider env="test" theme={theme}>
      <MemoryRouter>{ui}</MemoryRouter>
    </MantineProvider>,
  );
}

describe("ProjectJiraChip", () => {
  test("renders nothing while nothing is linked", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([])} />);
    expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
  });

  test("the project's own key without milestones: the key and 'No deviations seen', both link-shaped", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([[markKey("PROJECT", 7), mark({ key: "E2E-1" })]])} />);
    expect(screen.getByRole("link", { name: /E2E-1/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(screen.getByRole("link", { name: "No deviations seen" })).toHaveAttribute("href", "/deviations?projectId=7");
    expect(screen.queryByText(/milestone.* linked to Jira/)).not.toBeInTheDocument();
  });

  test("the zero state says 'may be out of date' when a connection behind it is stale", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([[markKey("PROJECT", 7), mark()]], 0, 0, { stale: true })} />);
    expect(screen.getByRole("link", { name: "No deviations seen, may be out of date" })).toBeInTheDocument();
  });

  test("milestones only, infos only: the count is a link and no project key is shown", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([[markKey("MILESTONE", 11), mark()]], 0, 2)} />);
    expect(screen.getByText("1 milestone linked to Jira")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 Jira deviations" })).toHaveAttribute("href", "/deviations?projectId=7");
    expect(screen.queryByText("Jira:")).not.toBeInTheDocument();
  });
});

describe("TeamJiraChip", () => {
  test("nothing linked renders nothing; linked milestones link to the team-filtered page", () => {
    const { unmount } = show(<TeamJiraChip teamId={3} marks={marks([])} />);
    expect(screen.queryByRole("group", { name: "Links to Jira" })).not.toBeInTheDocument();
    unmount();
    show(<TeamJiraChip teamId={3} marks={marks([[markKey("MILESTONE", 1), mark()], [markKey("MILESTONE", 2), mark({ key: "E2E-4" })]], 1, 0)} />);
    expect(screen.getByText("2 milestones linked to Jira")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 Jira deviation" })).toHaveAttribute("href", "/deviations?teamId=3");
  });
});

describe("JiraRowMark", () => {
  test("an unlinked row has no mark; a linked one shows its key and, when it deviates, the count in words", () => {
    const { unmount } = show(<JiraRowMark mark={undefined} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    unmount();
    show(<JiraRowMark mark={mark({ warnings: 1, infos: 1 })} />);
    expect(screen.getByRole("link", { name: /E2E-3/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("2 deviations")).toBeInTheDocument();
  });

  test("a linked row without a deviation shows no count", () => {
    show(<JiraRowMark mark={mark()} />);
    expect(screen.queryByText(/deviation/)).not.toBeInTheDocument();
  });
});

describe("ProjectJiraButton", () => {
  const project = { id: 7, can: { edit: true } };
  test("Link to Jira… while the project is not linked; Unlink from Jira, handing over the mark, once it is", () => {
    const linked: string[] = [];
    const unlinked: JiraMark[] = [];
    const { unmount } = show(<ProjectJiraButton project={project} marks={marks([])} onLink={() => linked.push("x")} onUnlink={(m) => unlinked.push(m)} />);
    screen.getByRole("button", { name: "Link to Jira…" }).click();
    expect(linked).toEqual(["x"]);
    unmount();
    const own = mark({ bindingId: 9 });
    show(<ProjectJiraButton project={project} marks={marks([[markKey("PROJECT", 7), own]])} onLink={() => undefined} onUnlink={(m) => unlinked.push(m)} />);
    expect(screen.queryByRole("button", { name: "Link to Jira…" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Unlink from Jira" }).click();
    expect(unlinked).toEqual([own]);
  });

  test("neither without can.edit, and neither until the chip query has answered (no flash of Link on a linked project, nothing after a failure)", () => {
    const first = show(<ProjectJiraButton project={{ id: 7, can: { edit: false } }} marks={marks([])} onLink={() => undefined} onUnlink={() => undefined} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    first.unmount();
    show(<ProjectJiraButton project={project} marks={marks([], 0, 0, { answered: false })} onLink={() => undefined} onUnlink={() => undefined} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
