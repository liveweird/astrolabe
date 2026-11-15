import { afterEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import type { HomeMe, HomeView } from "../api/home";
import { homeMe, homeView } from "../test/home";
import { headingOutline } from "../test/headings";
import { renderWithProviders, screen, within } from "../test/render";
import HomeMine from "./HomeMine";

const ROLES_KEY = "astrolabe.auth.roles";

const PROJECT: HomeMe["projects"][number] = {
  id: 7,
  name: "Ledger",
  programName: "Core",
  ownerName: "Alex Example",
  direct: true,
  rankPosition: 3,
  milestones: 10,
  unscheduledMilestones: 2,
  flags: { warnings: 2, infos: 1 },
  conflicts: 4,
};
const TEAM: HomeMe["teams"][number] = {
  id: 4,
  name: "Payments",
  milestones: 67,
  unscheduledMilestones: 7,
  conflicts: 2,
  overloadedWeeks: 3,
  wipExceededWeeks: 1,
  jira: { warnings: 3, infos: 1 },
  flags: [{ kind: "FLOW_CAPACITY", severity: "WARNING", count: 2 }],
};
const STREAM: HomeMe["workStreams"][number] = { id: 1, name: "Platform", endDate: null, programs: 4, projects: 20, flags: { warnings: 42, infos: 0 } };
const PROGRAM: HomeMe["programs"][number] = { id: 3, name: "Core", workStreamName: "Platform", ownerName: "Alex Example", direct: true, projects: 5, flags: { warnings: 0, infos: 3 } };

const INHERITED_PROJECT: HomeMe["projects"][number] = { ...PROJECT, id: 8, name: "Audit", programName: "Billing", ownerName: "Sam Other", direct: false, rankPosition: null };
const INHERITED_PROGRAM: HomeMe["programs"][number] = { ...PROGRAM, id: 4, name: "Billing", ownerName: "Sam Other", direct: false, projects: 2 };
const OWN_ONLY = "Only what I own myself";
const OWN_ONLY_KEY = "astrolabe.viewSettings.home.mine.ownOnly";

const viewWith = (me: HomeMe | null, over: Partial<HomeView> = {}) => homeView({ me, ...over });
const renderMine = (view: HomeView | undefined, flowStale = false) => renderWithProviders(<HomeMine view={view} flowStale={flowStale} />);

const site = (state: "NEVER_SYNCED" | "CURRENT" | "STALE" | "FAILED" | "DISABLED", mappingOk = true) => ({
  connectionId: 1,
  siteUrl: "https://stub-sample.atlassian.net",
  state,
  mappingOk,
});

afterEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("HomeMine: Yours", () => {
  test("pending: the heading and the one spinner, nothing else", () => {
    renderMine(undefined);
    expect(headingOutline()).toEqual([[3, "Yours"]]);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
  });

  test("the person line, and each table only when it has rows, under its h4 and with its accessible name", () => {
    renderMine(viewWith(homeMe({ projects: [PROJECT] })));
    expect(screen.getByText("Your login is linked to the person Alex Example.")).toBeInTheDocument();
    expect(headingOutline()).toEqual([
      [3, "Yours"],
      [4, "Your projects"],
    ]);
    expect(screen.getByRole("table", { name: "Your projects" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your teams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Your programs and work streams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the programs" })).not.toBeInTheDocument();
  });

  test("all three tables: the outline and every table inside a labelled, focusable scroll region", () => {
    renderMine(viewWith(homeMe({ projects: [PROJECT], teams: [TEAM], workStreams: [STREAM], programs: [PROGRAM] })));
    expect(headingOutline()).toEqual([
      [3, "Yours"],
      [4, "Your projects"],
      [4, "Your teams"],
      [4, "Your programs and work streams"],
    ]);
    for (const name of ["Your projects", "Your teams", "Your programs and work streams"]) {
      expect(screen.getByRole("region", { name })).toHaveAttribute("tabindex", "0");
      expect(within(screen.getByRole("region", { name })).getByRole("table", { name })).toBeInTheDocument();
    }
  });

  test("a project row: its name links to its page, the rank, the figures, the worded badges", () => {
    renderMine(viewWith(homeMe({ projects: [PROJECT] })));
    const table = within(screen.getByRole("table", { name: "Your projects" }));
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Project", "Program", "Owner", "Rank", "Milestones", "Not scheduled", "Flags", "Conflicts"]);
    expect(table.getByRole("link", { name: "Open Ledger" })).toHaveAttribute("href", "/projects/7");
    expect(table.getByText("Core")).toBeInTheDocument();
    expect(table.getByText("3")).toBeInTheDocument();
    expect(table.getByText("10")).toBeInTheDocument();
    expect(table.getByText("2 warnings")).toBeInTheDocument();
    expect(table.getByText("1 info")).toBeInTheDocument();
    const conflicts = table.getByRole("link", { name: "4 conflicts: Ledger" });
    expect(conflicts).toHaveAttribute("href", "/dependencies?status=violated&projectId=7");
    expect(conflicts).toHaveTextContent("4 conflicts");
  });

  test("an unranked project reads 'Unranked'; a zero badge is absent, a zero figure is shown", () => {
    renderMine(viewWith(homeMe({ projects: [{ ...PROJECT, rankPosition: null, unscheduledMilestones: 0, flags: { warnings: 0, infos: 0 }, conflicts: 0 }] })));
    const table = within(screen.getByRole("table", { name: "Your projects" }));
    expect(table.getByText("Unranked")).toBeInTheDocument();
    expect(table.getByText("0")).toBeInTheDocument();
    expect(table.queryByText(/warning|info|conflict/)).not.toBeInTheDocument();
    expect(table.queryByRole("link", { name: /conflict/ })).not.toBeInTheDocument();
  });

  test("a team row: its name links to its page; capacity, conflicts, the Jira count (a link into the filtered Deviations page) and the Flow sentence", () => {
    renderMine(viewWith(homeMe({ teams: [TEAM] })));
    const table = within(screen.getByRole("table", { name: "Your teams" }));
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Team", "Milestones", "Not scheduled", "Capacity", "Conflicts", "Jira", "Flow"]);
    expect(table.getByRole("link", { name: "Open team Payments" })).toHaveAttribute("href", "/teams/4");
    expect(table.getByText("67")).toBeInTheDocument();
    expect(table.getByText("3 weeks overloaded")).toBeInTheDocument();
    expect(table.getByText("1 week over WIP limit")).toBeInTheDocument();
    const conflicts = table.getByRole("link", { name: "2 conflicts: Payments" });
    expect(conflicts).toHaveAttribute("href", "/dependencies?status=violated&teamId=4");
    expect(conflicts).toHaveTextContent("2 conflicts");
    expect(table.getByRole("link", { name: "4 Jira deviations: team Payments" })).toHaveAttribute("href", "/deviations?teamId=4");
    const flow = table.getByText("Capacity differs from Flow: 2 open differences");
    expect(flow.closest("[data-team-flag]")).toHaveAttribute("data-team-flag", "FLOW_CAPACITY");
  });

  test("a quiet team row has no badge and no Jira link", () => {
    renderMine(viewWith(homeMe({ teams: [{ ...TEAM, unscheduledMilestones: 0, conflicts: 0, overloadedWeeks: 0, wipExceededWeeks: 0, jira: { warnings: 0, infos: 0 }, flags: [] }] })));
    const table = within(screen.getByRole("table", { name: "Your teams" }));
    expect(table.queryByText(/overloaded|WIP|conflict|Jira dev|Flow:/)).not.toBeInTheDocument();
    expect(table.getAllByRole("link")).toHaveLength(1);
  });

  test("programs and work streams link to the Roadmap filtered to them; a closed work stream says so; one link follows the table", () => {
    renderMine(viewWith(homeMe({ workStreams: [STREAM, { ...STREAM, id: 2, name: "Legacy", endDate: "2026-01-31" }], programs: [PROGRAM] })));
    const table = within(screen.getByRole("table", { name: "Your programs and work streams" }));
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Level", "In", "Owner", "Programs", "Projects", "Flags"]);
    expect(table.getAllByText("Platform")).toHaveLength(2); // the stream's name, and the program's "In"
    expect(table.getAllByText("Alex Example")).toHaveLength(3); // each work stream's Owner is the person (two streams); the program's is its own ownerName
    expect(table.getByText("Legacy (closed)")).toBeInTheDocument();
    expect(table.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/roadmap?workStreamId=1", "/roadmap?workStreamId=2", "/roadmap?programId=3"]);
    expect(table.getAllByText("Work stream")).toHaveLength(2);
    const programRow = within(table.getByText("Program", { selector: "td" }).closest("tr") as HTMLElement);
    expect(programRow.getByText("Core")).toBeInTheDocument();
    expect(programRow.getByText("Platform")).toBeInTheDocument();
    expect(programRow.getByText("3 infos")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the programs" })).toHaveAttribute("href", "/programs");
  });

  describe("the owner of each row", () => {
    test("the projects table names each row's owner: the person's own name on a direct row, the owner's on an inherited one", () => {
      renderMine(viewWith(homeMe({ projects: [PROJECT, INHERITED_PROJECT] })));
      const rows = within(screen.getByRole("table", { name: "Your projects" })).getAllByRole("row");
      expect(within(rows[1]).getAllByRole("cell")[2]).toHaveTextContent("Alex Example");
      expect(within(rows[2]).getAllByRole("cell")[2]).toHaveTextContent("Sam Other");
    });

    test("the nodes table: a work stream's Owner is the person, a program's is its own owner", () => {
      renderMine(viewWith(homeMe({ workStreams: [STREAM], programs: [INHERITED_PROGRAM] })));
      const rows = within(screen.getByRole("table", { name: "Your programs and work streams" })).getAllByRole("row");
      expect(within(rows[1]).getAllByRole("cell")[3]).toHaveTextContent("Alex Example");
      expect(within(rows[2]).getAllByRole("cell")[3]).toHaveTextContent("Sam Other");
    });

    test("one dimmed sentence says what is listed, under the person line, only when there is a row", () => {
      const scope = "Listed below: what you own, everything under a work stream or program you own, and the teams you manage.";
      const first = renderMine(viewWith(homeMe({ teams: [TEAM] })));
      expect(screen.getByText(scope)).toBeInTheDocument();
      first.unmount();
      const second = renderMine(viewWith(homeMe()));
      expect(screen.queryByText(/Listed below/)).not.toBeInTheDocument();
      second.unmount();
      renderMine(viewWith(null));
      expect(screen.queryByText(/Listed below/)).not.toBeInTheDocument();
    });
  });

  describe("the 'Only what I own myself' switch", () => {
    const mixed = () => viewWith(homeMe({ workStreams: [STREAM], programs: [PROGRAM, INHERITED_PROGRAM], projects: [PROJECT, INHERITED_PROJECT], teams: [TEAM] }));
    const names = (table: string) => within(screen.getByRole("table", { name: table })).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

    test("off by default: every row is listed, and the switch sits above the tables", () => {
      renderMine(mixed());
      const toggle = screen.getByRole("switch", { name: OWN_ONLY });
      expect(toggle).not.toBeChecked();
      expect(names("Your projects")).toEqual(["Ledger", "Audit"]);
      expect(names("Your programs and work streams")).toEqual(["Platform", "Core", "Billing"]);
      expect(toggle.compareDocumentPosition(screen.getByRole("table", { name: "Your projects" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("on: both tables keep the direct rows (a work stream is always the person's), the teams are untouched, the sentence follows", async () => {
      const user = userEvent.setup();
      renderMine(mixed());
      await user.click(screen.getByRole("switch", { name: OWN_ONLY }));
      expect(screen.getByRole("switch", { name: OWN_ONLY })).toBeChecked();
      expect(names("Your projects")).toEqual(["Ledger"]);
      expect(names("Your programs and work streams")).toEqual(["Platform", "Core"]);
      expect(names("Your teams")).toEqual(["Payments"]);
      expect(screen.getByText("Listed below: what you own yourself and the teams you manage.")).toBeInTheDocument();
      expect(screen.queryByText(/everything under a work stream/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("switch", { name: OWN_ONLY }));
      expect(names("Your projects")).toEqual(["Ledger", "Audit"]);
    });

    test("the choice is remembered in this browser under an astrolabe. key", async () => {
      const user = userEvent.setup();
      const first = renderMine(mixed());
      await user.click(screen.getByRole("switch", { name: OWN_ONLY }));
      expect(JSON.parse(localStorage.getItem(OWN_ONLY_KEY) ?? "null")).toBe(true);
      first.unmount();
      renderMine(mixed());
      expect(screen.getByRole("switch", { name: OWN_ONLY })).toBeChecked();
      expect(names("Your projects")).toEqual(["Ledger"]);
    });

    test("a corrupt stored value is ignored (off), and storage that throws never breaks the page", async () => {
      localStorage.setItem(OWN_ONLY_KEY, "not json");
      const first = renderMine(mixed());
      expect(screen.getByRole("switch", { name: OWN_ONLY })).not.toBeChecked();
      first.unmount();
      const user = userEvent.setup();
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      try {
        renderMine(mixed());
        await user.click(screen.getByRole("switch", { name: OWN_ONLY }));
        expect(names("Your projects")).toEqual(["Ledger"]);
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });

    test("a table the switch empties keeps its heading and says so; it never claims 'nothing' and the unfiltered list still has rows", async () => {
      const user = userEvent.setup();
      localStorage.setItem(OWN_ONLY_KEY, "true");
      renderMine(viewWith(homeMe({ programs: [INHERITED_PROGRAM], projects: [INHERITED_PROJECT], teams: [TEAM], truncated: true })));
      expect(headingOutline()).toEqual([
        [3, "Yours"],
        [4, "Your projects"],
        [4, "Your teams"],
        [4, "Your programs and work streams"],
      ]);
      expect(screen.queryByRole("table", { name: "Your projects" })).not.toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Your programs and work streams" })).not.toBeInTheDocument();
      expect(screen.getByText("You do not own any of the listed projects yourself.")).toBeInTheDocument();
      expect(screen.getByText("You do not own any of the listed programs yourself.")).toBeInTheDocument();
      expect(screen.queryByText(/owns no work stream, program or project/)).not.toBeInTheDocument();
      // The document cut its lists, so the empty sentence is about the listed rows only and the cut line stays beside it.
      expect(screen.getByText("Each list shows its first 100 rows.")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open the projects you own yourself on the roadmap" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("switch", { name: OWN_ONLY }));
      expect(names("Your projects")).toEqual(["Audit"]);
    });

    test("the switch is absent when no project or program is listed, and a stored 'on' then filters nothing", () => {
      localStorage.setItem(OWN_ONLY_KEY, "true");
      renderMine(viewWith(homeMe({ workStreams: [STREAM], teams: [TEAM] })));
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Your teams" })).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Your programs and work streams" })).toBeInTheDocument();
      expect(screen.getByText(/Listed below: what you own, everything under/)).toBeInTheDocument();
    });

    test("it speaks Polish", async () => {
      await i18n.changeLanguage("pl");
      localStorage.setItem(OWN_ONLY_KEY, "true");
      renderMine(viewWith(homeMe({ programs: [INHERITED_PROGRAM], projects: [INHERITED_PROJECT] })));
      expect(screen.getByRole("switch", { name: "Tylko to, czego jestem osobiście właścicielem/ką" })).toBeChecked();
      expect(screen.getByText("Poniżej: to, czego jesteś osobiście właścicielem/ką, oraz zespoły, którymi zarządzasz.")).toBeInTheDocument();
      expect(screen.getByText("Nie jesteś osobiście właścicielem/ką żadnego z wymienionych projektów.")).toBeInTheDocument();
      expect(screen.getByText("Nie jesteś osobiście właścicielem/ką żadnego z wymienionych programów.")).toBeInTheDocument();
    });
  });

  describe("the figures and names that lead somewhere", () => {
    test("a project's and a team's positive 'Not scheduled' open the filtered Milestones list, named with their row; a zero is plain text", () => {
      const first = renderMine(viewWith(homeMe({ projects: [PROJECT], teams: [TEAM] })));
      const project = screen.getByRole("link", { name: "2 not scheduled: Ledger" });
      expect(project).toHaveAttribute("href", "/milestones?scheduled=false&projectId=7");
      expect(project).toHaveTextContent("2");
      const team = screen.getByRole("link", { name: "7 not scheduled: Payments" });
      expect(team).toHaveAttribute("href", "/milestones?scheduled=false&teamId=4");
      expect(team).toHaveTextContent("7");
      first.unmount();
      renderMine(viewWith(homeMe({ projects: [{ ...PROJECT, unscheduledMilestones: 0 }], teams: [{ ...TEAM, unscheduledMilestones: 0 }] })));
      expect(screen.queryByRole("link", { name: /not scheduled/ })).not.toBeInTheDocument();
    });

    test("a work stream's and a program's name link to the Roadmap filtered to it, named with the visible text", () => {
      renderMine(viewWith(homeMe({ workStreams: [STREAM, { ...STREAM, id: 2, name: "Legacy", endDate: "2026-01-31" }], programs: [PROGRAM] })));
      expect(screen.getByRole("link", { name: "Open Platform on the roadmap" })).toHaveAttribute("href", "/roadmap?workStreamId=1");
      expect(screen.getByRole("link", { name: "Open Legacy (closed) on the roadmap" })).toHaveAttribute("href", "/roadmap?workStreamId=2");
      const program = screen.getByRole("link", { name: "Open Core on the roadmap" });
      expect(program).toHaveAttribute("href", "/roadmap?programId=3");
      expect(program).toHaveTextContent("Core");
    });

    test("a work stream or program with no project is plain text: the Roadmap has nothing to filter it to", () => {
      renderMine(viewWith(homeMe({ workStreams: [{ ...STREAM, projects: 0 }], programs: [{ ...PROGRAM, projects: 0 }] })));
      const table = within(screen.getByRole("table", { name: "Your programs and work streams" }));
      expect(table.queryByRole("link")).not.toBeInTheDocument();
      expect(table.getByText("Core")).toBeInTheDocument();
    });

    test("'Open the projects you own yourself on the roadmap' carries the person's id and shows only beside a listed project that is direct", () => {
      const link = { name: "Open the projects you own yourself on the roadmap" };
      const first = renderMine(viewWith(homeMe({ personId: 12, projects: [PROJECT, INHERITED_PROJECT] })));
      expect(screen.getByRole("link", link)).toHaveAttribute("href", "/roadmap?ownerPersonId=12");
      first.unmount();
      const inherited = renderMine(viewWith(homeMe({ personId: 12, projects: [INHERITED_PROJECT] })));
      expect(screen.getByRole("table", { name: "Your projects" })).toBeInTheDocument();
      expect(screen.queryByRole("link", link)).not.toBeInTheDocument();
      inherited.unmount();
      renderMine(viewWith(homeMe({ teams: [TEAM], workStreams: [STREAM] })));
      expect(screen.queryByRole("link", link)).not.toBeInTheDocument();
    });
  });

  describe("a login without a person", () => {
    test("one sentence; no table, and no People link for anyone but an administrator", () => {
      localStorage.setItem(ROLES_KEY, JSON.stringify(["USER"]));
      renderMine(viewWith(null));
      expect(screen.getByText(/Your login is not linked to a person, so nothing in the plan shows here as yours/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open the People page" })).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(headingOutline()).toEqual([[3, "Yours"]]);
    });

    test("an administrator also gets the link to the People page", () => {
      localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
      renderMine(viewWith(null));
      expect(screen.getByRole("link", { name: "Open the People page" })).toHaveAttribute("href", "/people");
    });
  });

  test("a person with nothing gets its own sentence, and no table", () => {
    renderMine(viewWith(homeMe()));
    expect(screen.getByText("Alex Example owns no work stream, program or project and manages no team.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("truncated shows its line; otherwise none", () => {
    const first = renderMine(viewWith(homeMe({ projects: [PROJECT], truncated: true })));
    expect(screen.getByText("Each list shows its first 100 rows.")).toBeInTheDocument();
    first.unmount();
    renderMine(viewWith(homeMe({ projects: [PROJECT] })));
    expect(screen.queryByText(/Each list shows/)).not.toBeInTheDocument();
  });

  describe("'may be out of date'", () => {
    test.each([
      ["NEVER_SYNCED", site("NEVER_SYNCED")],
      ["STALE", site("STALE")],
      ["FAILED", site("FAILED")],
      ["DISABLED", site("DISABLED")],
      ["a CURRENT site whose mapping does not fit", site("CURRENT", false)],
    ])("the Jira sentence shows for %s when the person has a row", (_name, jiraSite) => {
      renderMine(viewWith(homeMe({ projects: [PROJECT] }), { jiraSites: [jiraSite] }));
      expect(screen.getByText("Jira data may be out of date")).toBeInTheDocument();
    });

    test("not for a CURRENT site, no site, a person with no row or a login without a person", () => {
      for (const [me, jiraSites] of [
        [homeMe({ projects: [PROJECT] }), [site("CURRENT")]],
        [homeMe({ projects: [PROJECT] }), []],
        [homeMe(), [site("STALE")]],
        [null, [site("STALE")]],
      ] as const) {
        const rendered = renderMine(viewWith(me, { jiraSites: [...jiraSites] }));
        expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
        rendered.unmount();
      }
    });

    test("the Flow sentence shows only while a listed team carries a Flow flag and the Flow source is stale", () => {
      const stale = renderMine(viewWith(homeMe({ teams: [TEAM] })), true);
      expect(screen.getByText("Flow data may be out of date")).toBeInTheDocument();
      stale.unmount();
      const current = renderMine(viewWith(homeMe({ teams: [TEAM] })), false);
      expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
      current.unmount();
      renderMine(viewWith(homeMe({ teams: [{ ...TEAM, flags: [] }] })), true);
      expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
    });
  });

  test("speaks Polish", async () => {
    await i18n.changeLanguage("pl");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
    const first = renderMine(viewWith(homeMe({ projects: [PROJECT], teams: [TEAM], workStreams: [STREAM], programs: [PROGRAM] })));
    expect(headingOutline()).toEqual([
      [3, "Twoje"],
      [4, "Twoje projekty"],
      [4, "Twoje zespoły"],
      [4, "Twoje programy i strumienie pracy"],
    ]);
    expect(screen.getByText("Twój login jest powiązany z osobą Alex Example.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Otwórz programy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Otwórz na roadmapie projekty, których jesteś osobiście właścicielem/ką" })).toHaveAttribute("href", "/roadmap?ownerPersonId=12");
    expect(screen.getByRole("link", { name: "Niezaplanowane (2): Ledger" })).toHaveAttribute("href", "/milestones?scheduled=false&projectId=7");
    expect(screen.getByRole("link", { name: "Otwórz Platform na roadmapie" })).toHaveAttribute("href", "/roadmap?workStreamId=1");
    expect(within(screen.getByRole("table", { name: "Twoje zespoły" })).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Zespół",
      "Kamienie milowe",
      "Niezaplanowane",
      "Przepustowość",
      "Konflikty",
      "Jira",
      "Flow",
    ]);
    first.unmount();
    renderMine(viewWith(null));
    expect(screen.getByText(/Twój login nie jest powiązany z żadną osobą/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Otwórz stronę Osoby" })).toBeInTheDocument();
  });
});
