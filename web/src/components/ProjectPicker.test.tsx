import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import ProjectPicker from "./ProjectPicker";
import { deferred } from "../test/deferred";
import { jsonResponse, routeFetch } from "../test/http";
import { milestoneItem, milestonePage } from "../test/milestones";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

const PLAN = planOf([
  {
    id: 2,
    name: "Platform",
    programs: [
      { id: 21, name: "Billing", projects: [{ id: 211, name: "Invoices", ownerName: "Ola Owner" }, { id: 213, name: "Reports", ownerName: "Żaneta Żółw" }] },
      { id: 20, name: "Access", projects: [{ id: 201, name: "Login", ownerName: "Piotr Project" }] },
    ],
  },
  { id: 1, name: "Legacy", endDate: "2026-06-30", programs: [{ id: 11, name: "Archive", projects: [{ id: 111, name: "Migration", ownerName: "Ola Owner" }] }] },
]);

/** Where the router is, and how it got there (a push or a replace). */
function Where() {
  const location = useLocation();
  return <p>{`at ${location.pathname} by ${useNavigationType()}`}</p>;
}

/** What `GET /milestones` answers; the default finds none. */
let milestoneAnswer: () => Response | object = () => milestonePage([]);
let mockFetch: ReturnType<typeof routeFetch>;
/** The milestone searches made, by the `name` they carried (the whole query is pinned in the first test of the search). */
const searches = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/milestones"));

function renderPicker(projectId: number | null, currentName?: string) {
  mockFetch = routeFetch({
    "GET /api/v1/views/plan": PLAN,
    "GET /api/v1/milestones": () => milestoneAnswer(),
  });
  vi.stubGlobal("fetch", mockFetch);
  return renderWithProviders(
    <>
      <ProjectPicker projectId={projectId} currentName={currentName} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </>,
    { route: "/projects/211" },
  );
}

const picker = () => screen.getByRole("combobox", { name: "Project" });

beforeEach(() => {
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  milestoneAnswer = () => milestonePage([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ProjectPicker", () => {
  test("it shows the project it is given, named 'Project', and offers no way to clear it", async () => {
    renderPicker(211);
    await vi.waitFor(() => expect(picker()).toHaveValue("Invoices"));
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  test("the options are grouped 'Work stream › Program', a closed work stream marked", async () => {
    const user = userEvent.setup();
    renderPicker(null);
    await user.click(picker());
    expect(await screen.findByRole("option", { name: "Invoices" })).toBeInTheDocument();
    const groups = screen.getAllByRole("group").map((g) => [g.getAttribute("aria-label") ?? within(g).queryByText(/›/)?.textContent, within(g).getAllByRole("option").map((o) => o.textContent)]);
    expect(groups).toEqual([
      ["Platform › Access", ["Login"]],
      ["Platform › Billing", ["Invoices", "Reports"]],
      ["Legacy (closed) › Archive", ["Migration"]],
    ]);
  });

  test("typing an owner or a program finds its projects, accents folded", async () => {
    const user = userEvent.setup();
    renderPicker(null);
    await user.click(picker());
    await screen.findByRole("option", { name: "Invoices" });
    const found = async (search: string) => {
      await user.clear(picker());
      await user.type(picker(), search);
      return screen.queryAllByRole("option").map((o) => o.textContent);
    };
    expect(await found("ola")).toEqual(["Invoices", "Migration"]);
    expect(await found("Billing")).toEqual(["Invoices", "Reports"]);
    expect(await found("zolw")).toEqual(["Reports"]);
    expect(await found("legacy")).toEqual(["Migration"]);
    expect(await found("nothing like this")).toEqual([]);
    // Said once the milestone search for this term has answered, not before.
    expect(await screen.findByText("No project matches")).toBeInTheDocument();
  });

  test("a pick is a push to the project's page", async () => {
    const user = userEvent.setup();
    renderPicker(211);
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "Login" }));
    expect(await screen.findByText("at /projects/201 by PUSH")).toBeInTheDocument();
  });

  test("picking the project already shown goes nowhere", async () => {
    const user = userEvent.setup();
    renderPicker(211);
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "Invoices" }));
    expect(screen.getByText("at /projects/211 by POP")).toBeInTheDocument();
    expect(picker()).toHaveValue("Invoices");
  });

  test("a project the plan does not hold is still named by the page that has loaded it", async () => {
    renderPicker(999, "Elsewhere");
    await vi.waitFor(() => expect(picker()).toHaveValue("Elsewhere"));
  });
});

describe("ProjectPicker: finding a project by a milestone's name (1.30)", () => {
  const LEDGER_AUDIT = milestoneItem({ id: 3, projectId: 201, projectName: "Login", name: "Ledger audit" });
  const type = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.click(picker());
    await user.clear(picker());
    await user.type(picker(), text);
  };

  test("a term of two characters asks the milestone list by name (first hundred, by name) once typing pauses, and a project found only that way is offered with its milestone", async () => {
    const user = userEvent.setup();
    milestoneAnswer = () => milestonePage([LEDGER_AUDIT]);
    renderPicker(null);
    await type(user, "ledg");
    const option = await screen.findByRole("option", { name: /Login/ });
    expect(option).toHaveTextContent("Milestone: Ledger audit");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    // One request for the settled term (the keystrokes before it asked nothing).
    expect(searches()).toEqual(["/api/v1/milestones?page=1&pageSize=100&sort=name&name=ledg"]);
  });

  test("a single character asks nothing, and the picked project's own name in the box is no search", async () => {
    // The debounce is the code's own timer: the clock jumps past it instead of the test waiting.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicker(211);
    await vi.waitFor(() => expect(picker()).toHaveValue("Invoices"));
    await user.click(picker());
    await vi.advanceTimersByTimeAsync(400);
    expect(searches()).toEqual([]);
    await user.clear(picker());
    await user.type(picker(), "i");
    expect(await screen.findByRole("option", { name: "Invoices" })).toBeInTheDocument();
    // Past the debounce, still nothing was asked.
    await vi.advanceTimersByTimeAsync(400);
    expect(searches()).toEqual([]);
  });

  test("several matching milestones show the first and how many more; an answer the term does not confirm lists no project", async () => {
    const user = userEvent.setup();
    milestoneAnswer = () =>
      milestonePage([
        milestoneItem({ id: 1, projectId: 213, name: "Ledger export" }),
        milestoneItem({ id: 2, projectId: 213, name: "Ledger review" }),
        // The server's answer for a term the local fold does not confirm: no project is listed for it.
        milestoneItem({ id: 4, projectId: 201, name: "Unrelated" }),
      ]);
    renderPicker(null);
    await type(user, "ledg");
    const option = await screen.findByRole("option", { name: /Reports/ });
    expect(option).toHaveTextContent("Milestone: Ledger export (+1 more)");
    expect(screen.queryByRole("option", { name: /Login/ })).toBeNull();
  });

  test("typing on past the answer drops the milestone the longer term no longer names at once, while the next answer is still on its way", async () => {
    const user = userEvent.setup();
    const second = deferred<Response>();
    milestoneAnswer = () => (searches().length === 1 ? milestonePage([LEDGER_AUDIT]) : (second.promise as unknown as Response));
    renderPicker(null);
    await type(user, "ledg");
    expect(await screen.findByRole("option", { name: /Login/ })).toHaveTextContent("Milestone: Ledger audit");
    await user.type(picker(), "x");
    await waitFor(() => expect(searches()).toHaveLength(2));
    // The old answer is rechecked against what the box now holds: no stale line, and no "nothing found" before the second answer.
    expect(screen.queryByRole("option", { name: /Login/ })).toBeNull();
    expect(screen.queryByText("No project matches")).toBeNull();
    second.resolve(jsonResponse(200, milestonePage([])));
    expect(await screen.findByText("No project matches")).toBeInTheDocument();
  });

  test("'No project matches' waits for the search; after it, it is said", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    milestoneAnswer = () => pending.promise as unknown as Response;
    renderPicker(null);
    await type(user, "zzz nothing");
    await waitFor(() => expect(searches()).toHaveLength(1));
    expect(screen.queryByText("No project matches")).toBeNull();
    pending.resolve(jsonResponse(200, milestonePage([])));
    expect(await screen.findByText("No project matches")).toBeInTheDocument();
  });

  test("more than a hundred milestones say the list is partial; a failed search says so and the project matches still show", async () => {
    const user = userEvent.setup();
    milestoneAnswer = () => milestonePage([LEDGER_AUDIT], { total: 340 });
    renderPicker(null);
    await type(user, "ola");
    expect(await screen.findByText(/We check only the first 100 milestones found/)).toBeInTheDocument();
    // The notice is no choice.
    expect(screen.getByRole("option", { name: /We check only the first 100/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Invoices" })).toBeInTheDocument();
  });

  test("a failed milestone search says so, and the matches by project, program and owner still show", async () => {
    const user = userEvent.setup();
    milestoneAnswer = () => jsonResponse(500, { title: "Internal error", status: 500 });
    renderPicker(null);
    await type(user, "ola");
    expect(await screen.findByText(/Could not search the milestones/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Invoices" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Migration" })).toBeInTheDocument();
    expect(screen.queryByText("No project matches")).toBeNull();
  });
});
