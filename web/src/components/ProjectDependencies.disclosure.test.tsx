import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import type { DependencyEndpoint, ProjectDependency } from "../api/dependencies";
import type { ProjectView } from "../api/milestones";
import ProjectDependencies from "./ProjectDependencies";

// 1.29: the project page's dependency list can be hidden (the arrows stay); the header says what is hidden. The table itself is `ProjectDependencies.test.tsx`.

const KEY = "astrolabe.viewSettings.project.dependenciesOpen";

const endpoint = (id: number, name: string): DependencyEndpoint => ({
  kind: "MILESTONE",
  id,
  name,
  projectId: 7,
  projectName: "Invoices",
  teamId: 3,
  teamName: "Backend",
  startDate: "2027-02-01",
  endDate: "2027-02-05",
});

const link = (id: number, status: ProjectDependency["check"]["status"]): ProjectDependency => ({
  id,
  predecessor: endpoint(id * 10, `p${id}`),
  successor: endpoint(id * 10 + 1, `s${id}`),
  type: "FS",
  lagDays: 0,
  check: { status, shortfallDays: status === "VIOLATED" ? 2 : null, slackDays: null, requiredDate: "2027-02-08", actualDate: "2027-02-04" },
  critical: false,
  can: { edit: false, delete: false },
});

const viewOf = (dependencies: ProjectDependency[], createDependency = true) => ({ project: { id: 7, can: { createDependency } }, dependencies }) as unknown as ProjectView;

function Where() {
  const location = useLocation();
  return <p data-testid="search">{location.search}</p>;
}

function render(view: ProjectView, route = "/projects/7", onAdd = () => undefined) {
  return renderWithProviders(
    <>
      <ProjectDependencies view={view} onAdd={onAdd} onEdit={() => undefined} />
      <Where />
    </>,
    { route },
  );
}

const TABLE = "Dependencies of the project";
const toggle = () => screen.getByRole("button", { name: /dependency list$/ });
const HELD_AND_VIOLATED = [link(1, "OK"), link(2, "VIOLATED"), link(3, "VIOLATED")];

describe("ProjectDependencies: show or hide (1.29)", () => {
  test("shown by default: the table, a toggle that says Hide and is expanded, the facts and the red violated count in the header", () => {
    render(viewOf(HELD_AND_VIOLATED));
    expect(screen.getByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(toggle()).toHaveAccessibleName("Hide the dependency list");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("3 dependencies")).toBeInTheDocument();
    expect(screen.getByText("2 violated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add dependency" })).toBeInTheDocument();
  });

  test("hiding removes the table and the Add button, keeps the heading, the focus and the words, and is remembered", async () => {
    const user = userEvent.setup();
    const first = render(viewOf(HELD_AND_VIOLATED));
    await user.click(toggle());
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(toggle()).toHaveAccessibleName("Show the dependency list");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toBeInTheDocument();
    expect(screen.getByText("3 dependencies")).toBeInTheDocument();
    expect(screen.getByText("2 violated")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("false");

    // Another visit (a remount) starts hidden; showing it again is remembered too.
    first.unmount();
    render(viewOf(HELD_AND_VIOLATED));
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    await user.click(toggle());
    expect(screen.getByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("true");
  });

  test("no link at all: hidden or shown the header still says so, and the empty state is the body", async () => {
    const user = userEvent.setup();
    render(viewOf([], false));
    expect(screen.getByText("0 dependencies")).toBeInTheDocument();
    expect(screen.queryByText(/violated/)).toBeNull();
    expect(screen.getByText("No dependencies yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    await user.click(toggle());
    expect(screen.queryByText("No dependencies yet")).toBeNull();
  });

  test("?dependencies=all opens a section remembered as hidden, without writing the memory, and moves the focus to the heading; hiding it takes the parameter away", async () => {
    const user = userEvent.setup();
    localStorage.setItem(KEY, "false");
    render(viewOf(HELD_AND_VIOLATED), "/projects/7?dependencies=all&other=keep");
    expect(screen.getByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus();
    expect(localStorage.getItem(KEY)).toBe("false");
    await user.click(toggle());
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent("?other=keep");
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  test.each(["all", "violated", "ok", "unscheduled"])("the Roadmap panel's word %s opens it too (the list has no filter, so the word only opens it)", (word) => {
    localStorage.setItem(KEY, "false");
    render(viewOf(HELD_AND_VIOLATED), `/projects/7?dependencies=${word}`);
    expect(screen.getByRole("table", { name: TABLE })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toHaveFocus();
  });

  test("any other value of the parameter is no choice: a hidden section stays hidden and the focus is left alone", () => {
    localStorage.setItem(KEY, "false");
    render(viewOf(HELD_AND_VIOLATED), "/projects/7?dependencies=bogus");
    expect(screen.queryByRole("table", { name: TABLE })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).not.toHaveFocus();
  });

  test("a stored value that is not a boolean reads as the default (shown)", () => {
    localStorage.setItem(KEY, JSON.stringify("nope"));
    render(viewOf(HELD_AND_VIOLATED));
    expect(screen.getByRole("table", { name: TABLE })).toBeInTheDocument();
  });

  test("Add dependency still asks the page to open the editor", async () => {
    const user = userEvent.setup();
    let added = 0;
    render(viewOf(HELD_AND_VIOLATED), "/projects/7", () => {
      added += 1;
    });
    await user.click(screen.getByRole("button", { name: "Add dependency" }));
    expect(added).toBe(1);
  });
});
