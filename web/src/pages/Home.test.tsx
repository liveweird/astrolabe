import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { HomeView } from "../api/home";
import { HOME_VIEW_KEY } from "../api/home";
import i18n from "../i18n";
import { connectionIn, view } from "../test/deviations";
import { CAPACITY_CONNECTION, capacityView } from "../test/flow";
import { homeMe, homeView } from "../test/home";
import { headingOutline } from "../test/headings";
import { jsonResponse } from "../test/http";
import { act, renderWithProviders, screen, waitFor, within } from "../test/render";
import Home from "./Home";

const JIRA_URL = "/api/v1/views/deviations?acknowledged=true";
const FLOW_URL = "/api/v1/views/capacity-deviations?acknowledged=true";
const HOME_URL = "/api/v1/views/home";

const CARDS = [
  [2, "Astrolabe"],
  [3, "Plan"],
  [3, "Roadmap"],
  [3, "Deviations"],
];
/** The cards and the "Yours" section (shown while the read is pending and once it has answered; absent after a failed first read). */
const OUTLINE = [...CARDS, [3, "Yours"]];

type JiraConnection = ReturnType<typeof connectionIn>;

/** The two deviation views as the server answers `acknowledged=true`: the OPEN totals, no acknowledged item, the connections as given (honest ones). */
function jiraView(warnings: number, infos: number, connections: JiraConnection[] = [connectionIn("CURRENT")]) {
  return view({ connections, items: [], totals: { warnings, infos, bindings: 0, gone: 0, stillInJira: 0, acknowledged: 0 } });
}
function flowView(warnings: number, infos: number, connections = [CAPACITY_CONNECTION]) {
  return capacityView({ connections, items: [], totals: { warnings, infos, gone: 0, acknowledged: 0, teams: 0 } });
}

type Answers = { jira?: () => Response; flow?: () => Response; home?: () => Response | Promise<Response> };

/** The three reads of Home; an unset answer is a quiet good one (no open deviation, the sample document). */
function stubViews(answers: Answers = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === JIRA_URL) return Promise.resolve((answers.jira ?? (() => jsonResponse(200, jiraView(0, 0))))());
    if (url === FLOW_URL) return Promise.resolve((answers.flow ?? (() => jsonResponse(200, flowView(0, 0))))());
    if (url === HOME_URL) return Promise.resolve((answers.home ?? (() => jsonResponse(200, homeView())))());
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PROJECT = { id: 7, name: "Ledger", programName: "Core", rankPosition: 3, milestones: 10, unscheduledMilestones: 2, flags: { warnings: 2, infos: 1 }, conflicts: 0 };
const TEAM = {
  id: 4,
  name: "Payments",
  milestones: 67,
  unscheduledMilestones: 7,
  conflicts: 0,
  overloadedWeeks: 0,
  wipExceededWeeks: 0,
  jira: { warnings: 0, infos: 0 },
  flags: [],
};

const homeWith = (over: Partial<HomeView>) => () => jsonResponse(200, homeView(over));

/** Both settled: the plan's figures drawn and the two deviation reads answered. */
async function settled(fetchMock: ReturnType<typeof stubViews>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await screen.findByText("5 work streams");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Home", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  test("is a landing: the intro, three cards with their own links, and three reads (the deviation counts asked with acknowledged=true)", async () => {
    const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(3, 0)), flow: () => jsonResponse(200, flowView(0, 2)) });
    renderWithProviders(<Home />);
    expect(screen.getByRole("heading", { level: 2, name: "Astrolabe" })).toBeInTheDocument();
    expect(screen.getByText(/see where the plan differs from Jira and from Flow/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
    expect(screen.getByRole("link", { name: "Open the roadmap" })).toHaveAttribute("href", "/roadmap");
    expect(screen.getByRole("link", { name: "Open the deviations" })).toHaveAttribute("href", "/deviations");
    expect(headingOutline()).toEqual(OUTLINE);
    await waitFor(() => expect(screen.getByText("Open differences from Jira:")).toBeInTheDocument());
    await settled(fetchMock);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([FLOW_URL, HOME_URL, JIRA_URL].sort());
  });

  test("shows the positive open counts of each source and omits a zero badge", async () => {
    stubViews({ jira: () => jsonResponse(200, jiraView(3, 0)), flow: () => jsonResponse(200, flowView(1, 2)) });
    renderWithProviders(<Home />);
    expect(await screen.findByText("3 warnings")).toBeInTheDocument();
    expect(screen.getByText("Open differences from Jira:")).toBeInTheDocument();
    expect(screen.getByText("Open capacity differences from Flow:")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.getByText("2 infos")).toBeInTheDocument();
    // Jira has no open info: no "0 infos" badge, only Flow's "2 infos" exists in the Deviations card.
    const deviations = within(screen.getByRole("heading", { name: "Deviations" }).closest("div[class*=Paper]") as HTMLElement);
    expect(deviations.getAllByText(/infos?$/)).toHaveLength(1);
  });

  test("says nothing at zero and nothing without a connection (no 'nothing open' claim)", async () => {
    const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(0, 0)), flow: () => jsonResponse(200, flowView(4, 4, [])) });
    renderWithProviders(<Home />);
    await settled(fetchMock);
    const deviations = within(screen.getByRole("heading", { name: "Deviations" }).closest("div[class*=Paper]") as HTMLElement);
    expect(screen.queryByText("Open differences from Jira:")).not.toBeInTheDocument();
    expect(screen.queryByText("Open capacity differences from Flow:")).not.toBeInTheDocument();
    expect(deviations.queryByText(/warning|info/)).not.toBeInTheDocument();
    expect(deviations.queryByText(/nothing|no open/i)).not.toBeInTheDocument();
  });

  test("a failed deviation read is an inline alert in the Deviations card; the links stay, the other source still shows", async () => {
    stubViews({ jira: () => jsonResponse(500, { title: "Boom", status: 500 }), flow: () => jsonResponse(200, flowView(2, 0)) });
    renderWithProviders(<Home />);
    expect(await screen.findByText("Could not read the open deviations")).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(await screen.findByText("2 warnings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
    expect(screen.getByRole("link", { name: "Open the deviations" })).toHaveAttribute("href", "/deviations");
    expect(headingOutline()).toEqual(OUTLINE);
  });

  describe("the plan's figures", () => {
    test("the Plan card's group holds the five lines, a zero count shown", async () => {
      stubViews({ home: homeWith({ plan: { ...homeView().plan, unscheduledMilestones: 0 } }) });
      renderWithProviders(<Home />);
      const group = within(await screen.findByRole("group", { name: "The plan in figures" }));
      await group.findByText("5 work streams");
      expect(group.getAllByText(/./).map((node) => node.textContent)).toEqual(["5 work streams", "20 programs", "100 projects", "1000 milestones", "0 not scheduled yet"]);
    });

    test("the Roadmap card's group holds the two counts and the badges; a zero badge is absent", async () => {
      stubViews({ home: homeWith({ plan: { ...homeView().plan, flags: { warnings: 208, infos: 0 }, conflicts: 9, overloadedTeams: 1, wipExceededTeams: 0 } }) });
      renderWithProviders(<Home />);
      const group = within(await screen.findByRole("group", { name: "The roadmap in figures" }));
      expect(await group.findByText("80 ranked")).toBeInTheDocument();
      expect(group.getByText("20 unranked")).toBeInTheDocument();
      expect(group.getByText("208 warnings")).toBeInTheDocument();
      expect(group.getByText("9 violated dependencies")).toBeInTheDocument();
      expect(group.getByText("1 team with an overloaded week")).toBeInTheDocument();
      expect(group.queryByText(/infos?$/)).not.toBeInTheDocument();
      expect(group.queryByText(/over the WIP limit/)).not.toBeInTheDocument();
      expect(group.queryByText(/out of date/)).not.toBeInTheDocument();
    });

    test("the capacity badges read in the plural, and the conflicts are not worded as a Roadmap figure or linked", async () => {
      stubViews({ home: homeWith({ plan: { ...homeView().plan, overloadedTeams: 3, wipExceededTeams: 2 } }) });
      renderWithProviders(<Home />);
      const group = within(await screen.findByRole("group", { name: "The roadmap in figures" }));
      expect(await group.findByText("3 teams with an overloaded week")).toBeInTheDocument();
      expect(group.getByText("2 teams over the WIP limit")).toBeInTheDocument();
      expect(group.queryByRole("link", { name: /violated|conflict/ })).not.toBeInTheDocument();
      expect(group.getByText("9 violated dependencies").closest("a")).toBeNull();
      expect(screen.queryByText(/arrow|conflict/i)).not.toBeInTheDocument();
    });

    test("five figures are links with their href and a name that contains their visible text; the violated dependencies and the counts are not", async () => {
      stubViews();
      renderWithProviders(<Home />);
      const roadmap = within(await screen.findByRole("group", { name: "The roadmap in figures" }));
      const plan = within(screen.getByRole("group", { name: "The plan in figures" }));
      const notScheduled = await plan.findByRole("link", { name: "100 not scheduled yet" });
      expect(notScheduled).toHaveAttribute("href", "/milestones?scheduled=false");
      const warnings = await roadmap.findByRole("link", { name: "208 warnings: the flagged projects on the roadmap" });
      expect(warnings).toHaveAttribute("href", "/roadmap?flagged=true");
      expect(warnings).toHaveTextContent("208 warnings");
      const infos = roadmap.getByRole("link", { name: "52 infos: the flagged projects on the roadmap" });
      expect(infos).toHaveAttribute("href", "/roadmap?flagged=true");
      expect(infos).toHaveTextContent("52 infos");
      expect(roadmap.getByRole("link", { name: "3 teams with an overloaded week" })).toHaveAttribute("href", "/team-load?warning=overloaded");
      expect(roadmap.getByRole("link", { name: "1 team over the WIP limit" })).toHaveAttribute("href", "/team-load?warning=wip");
      expect(roadmap.getAllByRole("link")).toHaveLength(4);
      expect(roadmap.getByText("9 violated dependencies").closest("a")).toBeNull();
      expect(roadmap.getByText("80 ranked").closest("a")).toBeNull();
      expect(plan.getAllByRole("link")).toHaveLength(1);
    });

    test("a zero figure is neither a badge nor a link", async () => {
      stubViews({ home: homeWith({ plan: { ...homeView().plan, unscheduledMilestones: 0, flags: { warnings: 0, infos: 0 }, overloadedTeams: 0, wipExceededTeams: 0 } }) });
      renderWithProviders(<Home />);
      const plan = within(await screen.findByRole("group", { name: "The plan in figures" }));
      expect(await plan.findByText("0 not scheduled yet")).toBeInTheDocument();
      expect(plan.queryByRole("link")).not.toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "The roadmap in figures" })).queryByRole("link")).not.toBeInTheDocument();
    });

    test("before the read answers there is no figure-link, and the three card links are there", () => {
      stubViews({ home: () => new Promise<Response>(() => {}) });
      renderWithProviders(<Home />);
      expect(within(screen.getByRole("group", { name: "The plan in figures" })).queryByRole("link")).not.toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "The roadmap in figures" })).queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /^Open the (plan|roadmap|deviations)$/ })).toHaveLength(3);
    });

    test("'Yours' is a section under the cards: its h3 and one h4 per table shown", async () => {
      stubViews({ home: homeWith({ me: homeMe({ projects: [PROJECT], teams: [TEAM] }) }) });
      renderWithProviders(<Home />);
      await screen.findByRole("table", { name: "Your projects" });
      expect(headingOutline()).toEqual([...OUTLINE, [4, "Your projects"], [4, "Your teams"]]);
      expect(screen.getByText("Your login is linked to the person Alex Example.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Ledger" })).toHaveAttribute("href", "/projects/7");
      expect(screen.getByRole("link", { name: "Open team Payments" })).toHaveAttribute("href", "/teams/4");
    });

    test("a login without a person reads the sentence under 'Yours'", async () => {
      stubViews();
      renderWithProviders(<Home />);
      expect(await screen.findByText(/Your login is not linked to a person/)).toBeInTheDocument();
      expect(headingOutline()).toEqual(OUTLINE);
    });

    test("while the read is pending 'Yours' shows its heading and the one spinner, and the cards are there", () => {
      stubViews({ home: () => new Promise<Response>(() => {}) });
      renderWithProviders(<Home />);
      expect(headingOutline()).toEqual(OUTLINE);
      expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
    });

    test("the cards and their links render, and their groups exist empty, before any read answers", () => {
      stubViews({ home: () => new Promise<Response>(() => {}), jira: () => new Promise<Response>(() => {}) as unknown as Response });
      renderWithProviders(<Home />);
      expect(screen.getByRole("group", { name: "The plan in figures" })).toBeEmptyDOMElement();
      expect(screen.getByRole("group", { name: "The roadmap in figures" })).toBeEmptyDOMElement();
      expect(screen.getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "/plan");
      expect(screen.getByRole("link", { name: "Open the roadmap" })).toHaveAttribute("href", "/roadmap");
      expect(screen.getByRole("link", { name: "Open the deviations" })).toHaveAttribute("href", "/deviations");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    test("a failed first read is ONE alert under the cards: no figure, the links and the Deviations lines stay", async () => {
      stubViews({ home: () => jsonResponse(500, { title: "Boom", status: 500 }), jira: () => jsonResponse(200, jiraView(3, 0)) });
      renderWithProviders(<Home />);
      expect(await screen.findByText("Could not read the plan's figures")).toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("group", { name: "The plan in figures" })).toBeEmptyDOMElement();
      expect(screen.getByRole("group", { name: "The roadmap in figures" })).toBeEmptyDOMElement();
      expect(screen.getByRole("link", { name: "Open the plan" })).toBeInTheDocument();
      expect(await screen.findByText("3 warnings")).toBeInTheDocument();
      expect(headingOutline()).toEqual(CARDS);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    test("a re-read that fails after a good one keeps the figures and shows the alert", async () => {
      let ok = true;
      stubViews({ home: () => (ok ? jsonResponse(200, homeView()) : jsonResponse(500, { title: "Boom", status: 500 })) });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderWithProviders(<Home />, { queryClient });
      expect(await screen.findByText("5 work streams")).toBeInTheDocument();
      ok = false;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: HOME_VIEW_KEY });
      });
      expect(await screen.findByText("Could not read the plan's figures")).toBeInTheDocument();
      expect(screen.getByText("5 work streams")).toBeInTheDocument();
      expect(screen.getByText("80 ranked")).toBeInTheDocument();
    });

    test("a re-read that fails keeps 'Yours' with its rows, the alert above it", async () => {
      let ok = true;
      stubViews({ home: () => (ok ? jsonResponse(200, homeView({ me: homeMe({ projects: [PROJECT] }) })) : jsonResponse(500, { title: "Boom", status: 500 })) });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderWithProviders(<Home />, { queryClient });
      expect(await screen.findByRole("link", { name: "Open Ledger" })).toBeInTheDocument();
      ok = false;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: HOME_VIEW_KEY });
      });
      const alert = await screen.findByText("Could not read the plan's figures");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("link", { name: "Open Ledger" })).toBeInTheDocument();
      const yours = screen.getByRole("heading", { level: 3, name: "Yours" });
      expect(alert.compareDocumentPosition(yours) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe("'may be out of date'", () => {
    const site = (state: "NEVER_SYNCED" | "CURRENT" | "STALE" | "FAILED" | "DISABLED", mappingOk = true) => ({ connectionId: 1, siteUrl: "https://stub-sample.atlassian.net", state, mappingOk });
    const roadmapGroup = async () => within(await screen.findByRole("group", { name: "The roadmap in figures" }));

    test.each([
      ["NEVER_SYNCED", site("NEVER_SYNCED")],
      ["STALE", site("STALE")],
      ["FAILED", site("FAILED")],
      ["DISABLED", site("DISABLED")],
      ["a CURRENT site whose mapping does not fit", site("CURRENT", false)],
    ])("a Jira site that is %s adds the sentence to the Roadmap card", async (_name, jiraSite) => {
      stubViews({ home: homeWith({ jiraSites: [jiraSite] }) });
      renderWithProviders(<Home />);
      const group = await roadmapGroup();
      expect(await group.findByText("Jira data may be out of date")).toBeInTheDocument();
    });

    test.each([
      ["a CURRENT site", [site("CURRENT")]],
      ["no site", []],
    ])("%s adds none", async (_name, jiraSites) => {
      const fetchMock = stubViews({ home: homeWith({ jiraSites }) });
      renderWithProviders(<Home />);
      await settled(fetchMock);
      expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
    });

    test.each(["NEVER_SYNCED", "STALE", "FAILED", "FAILED_RUNNING", "FAILED_INTERRUPTED"] as const)("a %s Jira connection adds the sentence under the Jira line", async (shape) => {
      stubViews({ jira: () => jsonResponse(200, jiraView(3, 0, [connectionIn(shape)])) });
      renderWithProviders(<Home />);
      expect(await screen.findByText("Jira data may be out of date")).toBeInTheDocument();
      expect(screen.getByText("Open differences from Jira:")).toBeInTheDocument();
    });

    test("a Jira connection whose mapping does not fit adds it; a CURRENT, a running refresh on a CURRENT and a DISABLED one add none", async () => {
      stubViews({ jira: () => jsonResponse(200, jiraView(3, 0, [connectionIn("CURRENT", { mappingOk: false })])) });
      const first = renderWithProviders(<Home />);
      expect(await screen.findByText("Jira data may be out of date")).toBeInTheDocument();
      first.unmount();
      for (const shape of ["CURRENT", "CURRENT_RUNNING", "DISABLED"] as const) {
        const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(3, 0, [connectionIn(shape)])) });
        const rendered = renderWithProviders(<Home />);
        await settled(fetchMock);
        expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
        rendered.unmount();
      }
    });

    test("the Jira sentence shows only while the Jira line does (no figure, no qualifier)", async () => {
      const fetchMock = stubViews({ jira: () => jsonResponse(200, jiraView(0, 0, [connectionIn("FAILED")])) });
      renderWithProviders(<Home />);
      await settled(fetchMock);
      expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
    });

    test.each(["NEVER_SYNCED", "STALE", "FAILED"] as const)("a %s Flow connection adds Flow's own sentence under the Flow line", async (state) => {
      const connection = { ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state, lastSucceededAt: null } };
      stubViews({ flow: () => jsonResponse(200, flowView(1, 0, [connection])) });
      renderWithProviders(<Home />);
      expect(await screen.findByText("Flow data may be out of date")).toBeInTheDocument();
      expect(screen.getByText("Open capacity differences from Flow:")).toBeInTheDocument();
      expect(screen.queryByText("Jira data may be out of date")).not.toBeInTheDocument();
    });

    test("a CURRENT Flow connection, a DISABLED one and a stale one under a zero count add no Flow sentence", async () => {
      const disabled = { ...CAPACITY_CONNECTION, enabled: false, status: { ...CAPACITY_CONNECTION.status, state: "DISABLED" as const } };
      const stale = { ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "STALE" as const } };
      for (const flow of [flowView(1, 0), flowView(1, 0, [disabled]), flowView(0, 0, [stale])]) {
        const fetchMock = stubViews({ flow: () => jsonResponse(200, flow) });
        const rendered = renderWithProviders(<Home />);
        await settled(fetchMock);
        expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
        rendered.unmount();
      }
    });
  });

  test("speaks Polish in both languages' own words", async () => {
    await i18n.changeLanguage("pl");
    stubViews({
      home: homeWith({ jiraSites: [{ connectionId: 1, siteUrl: "https://stub-sample.atlassian.net", state: "STALE", mappingOk: true }] }),
      flow: () => jsonResponse(200, flowView(1, 0, [{ ...CAPACITY_CONNECTION, status: { ...CAPACITY_CONNECTION.status, state: "FAILED" } }])),
    });
    renderWithProviders(<Home />);
    expect(await screen.findByRole("group", { name: "Plan w liczbach" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Roadmapa w liczbach" })).toBeInTheDocument();
    expect(await screen.findByText("jeszcze niezaplanowanych: 100")).toBeInTheDocument();
    expect(screen.getByText("9 naruszonych zależności")).toBeInTheDocument();
    expect(screen.getByText("3 zespoły z przeciążonym tygodniem")).toBeInTheDocument();
    expect(screen.getByText("1 zespół ponad limitem WIP")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "208 ostrzeżeń: projekty z flagami na roadmapie" })).toHaveAttribute("href", "/roadmap?flagged=true");
    expect(screen.getByText("Dane z Jiry mogą być nieaktualne")).toBeInTheDocument();
    expect(await screen.findByText("Dane z Flow mogą być nieaktualne")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Twoje" })).toBeInTheDocument();
  });
});
