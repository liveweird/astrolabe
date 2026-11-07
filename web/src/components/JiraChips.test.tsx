import { describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { theme } from "../theme";
import type { JiraMark, JiraMarks } from "../utils/jiraMarks";
import { markKey } from "../utils/jiraMarks";
import { ProjectJiraButton, ProjectJiraChip, TeamJiraChip } from "./JiraChips";

const mark = (over: Partial<JiraMark> = {}): JiraMark => ({ bindingId: 1, key: "E2E-3", siteUrl: "https://acme.atlassian.net", warnings: 0, infos: 0, ...over });
const marks = (entries: [string, JiraMark][], warnings = 0, infos = 0): JiraMarks => ({ byNode: new Map(entries), warnings, infos });

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

  test("the count is the marks' open flags (3 here), and the key of a site that is not https reads as plain text", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([[markKey("PROJECT", 7), mark({ key: "E2E-1", siteUrl: "http://plain.example" })]], 2, 1)} />);
    expect(screen.getByRole("link", { name: "3 Jira deviations" })).toHaveAttribute("href", "/deviations?projectId=7");
    expect(screen.getByText(/E2E-1/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /E2E-1/ })).not.toBeInTheDocument();
  });

  test("the project's own key without milestones: the key and 'No deviations seen', both link-shaped", () => {
    show(<ProjectJiraChip projectId={7} marks={marks([[markKey("PROJECT", 7), mark({ key: "E2E-1" })]])} />);
    expect(screen.getByRole("link", { name: /E2E-1/ })).toHaveAttribute("href", "https://acme.atlassian.net/browse/E2E-1");
    expect(screen.getByRole("link", { name: "No deviations seen" })).toHaveAttribute("href", "/deviations?projectId=7");
    expect(screen.queryByText(/milestone.* linked to Jira/)).not.toBeInTheDocument();
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

  test("nothing without the project's can.edit", () => {
    show(<ProjectJiraButton project={{ id: 7, can: { edit: false } }} marks={marks([])} onLink={() => undefined} onUnlink={() => undefined} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
