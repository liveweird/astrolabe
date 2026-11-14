import { afterEach, describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useRoadmapFilters } from "./useRoadmapFilters";
import { renderWithProviders } from "../test/render";

const KEY = (name: string) => `astrolabe.viewSettings.${name}`;
const stored = (name: string) => JSON.parse(localStorage.getItem(KEY(name)) ?? "null") as unknown;
const ALL_KEYS = ["roadmap.filter.workStream", "roadmap.filter.team", "roadmap.filter.owner", "roadmap.filter.flagged", "planning.programPick"];

/** Shows what the hook answers and the address, and gives the test the user's changes and two navigations. */
function Probe() {
  const { filters, pick, setFilters, setPick } = useRoadmapFilters();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="shown">{JSON.stringify({ filters, pick })}</output>
      <output data-testid="url">{location.search}</output>
      <output data-testid="nav">{useNavigationType()}</output>
      <button onClick={() => setFilters({ teamId: 4 })}>team 4</button>
      <button onClick={() => setFilters({ flaggedOnly: false, teamId: null, workStreamId: null })}>clear filters</button>
      <button onClick={() => setPick([])}>clear pick</button>
      <button onClick={() => setPick([21])}>pick 21</button>
      <button onClick={() => navigate("/roadmap?flagged=true")}>go flagged</button>
      <button onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

const shown = () => JSON.parse(screen.getByTestId("shown").textContent ?? "null") as { filters: Record<string, unknown>; pick: number[] };
const url = () => screen.getByTestId("url").textContent;

/** The view-settings keys the browser holds (the test setup may keep others, such as the language). */
const viewSettings = () => Object.keys(localStorage).filter((key) => key.startsWith("astrolabe.viewSettings."));

afterEach(() => localStorage.clear());

describe("useRoadmapFilters", () => {
  test("a bare URL with nothing remembered stays bare and writes nothing", () => {
    renderWithProviders(<Probe />, { route: "/roadmap" });
    expect(shown()).toEqual({ filters: { workStreamId: null, teamId: null, ownerPersonId: null, flaggedOnly: false }, pick: [] });
    expect(url()).toBe("");
    expect(screen.getByTestId("nav")).toHaveTextContent("POP");
    expect(viewSettings()).toEqual([]);
  });

  test("a bare URL shows the remembered filters and pick and is rewritten by replace; the memory is untouched", async () => {
    localStorage.setItem(KEY("roadmap.filter.workStream"), "2");
    localStorage.setItem(KEY("roadmap.filter.flagged"), "true");
    localStorage.setItem(KEY("planning.programPick"), "[12,11]");
    renderWithProviders(<Probe />, { route: "/roadmap" });
    expect(shown().filters).toMatchObject({ workStreamId: 2, flaggedOnly: true });
    expect(shown().pick).toEqual([11, 12]);
    expect(await screen.findByText("?programId=11&programId=12&workStreamId=2&flagged=true")).toBeInTheDocument();
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(stored("planning.programPick")).toEqual([12, 11]);
    expect(stored("roadmap.filter.workStream")).toBe(2);
  });

  test("a stored value that fails its validator reads as off", () => {
    localStorage.setItem(KEY("roadmap.filter.team"), '"x"');
    localStorage.setItem(KEY("roadmap.filter.flagged"), "1");
    localStorage.setItem(KEY("planning.programPick"), '["a"]');
    renderWithProviders(<Probe />, { route: "/roadmap" });
    expect(shown()).toEqual({ filters: { workStreamId: null, teamId: null, ownerPersonId: null, flaggedOnly: false }, pick: [] });
    expect(url()).toBe("");
  });

  test("a link is shown as written, anything it does not name is off, and every stored key is untouched", () => {
    localStorage.setItem(KEY("roadmap.filter.workStream"), "2");
    localStorage.setItem(KEY("planning.programPick"), "[11]");
    renderWithProviders(<Probe />, { route: "/roadmap?flagged=true" });
    expect(shown().filters).toEqual({ workStreamId: null, teamId: null, ownerPersonId: null, flaggedOnly: true });
    expect(shown().pick).toEqual([]);
    expect(url()).toBe("?flagged=true");
    expect(screen.getByTestId("nav")).toHaveTextContent("POP");
    expect(stored("roadmap.filter.workStream")).toBe(2);
    expect(stored("planning.programPick")).toEqual([11]);
    expect(localStorage.getItem(KEY("roadmap.filter.flagged"))).toBeNull();
  });

  test("a change on a linked view rewrites the address by replace and stores the WHOLE shown state", async () => {
    localStorage.setItem(KEY("roadmap.filter.workStream"), "2");
    localStorage.setItem(KEY("planning.programPick"), "[11]");
    renderWithProviders(<Probe />, { route: "/roadmap?flagged=true" });
    await userEvent.setup().click(screen.getByText("team 4"));
    expect(url()).toBe("?teamId=4&flagged=true");
    expect(screen.getByTestId("nav")).toHaveTextContent("REPLACE");
    expect(stored("roadmap.filter.workStream")).toBeNull();
    expect(stored("roadmap.filter.team")).toBe(4);
    expect(stored("roadmap.filter.owner")).toBeNull();
    expect(stored("roadmap.filter.flagged")).toBe(true);
    expect(stored("planning.programPick")).toEqual([]);
  });

  test("clearing the last filter leaves a bare address and empty stored keys, and it stays bare", async () => {
    localStorage.setItem(KEY("roadmap.filter.team"), "4");
    renderWithProviders(<Probe />, { route: "/roadmap" });
    const user = userEvent.setup();
    expect(await screen.findByText("?teamId=4")).toBeInTheDocument();
    await user.click(screen.getByText("clear filters"));
    expect(url()).toBe("");
    expect(shown().filters.teamId).toBeNull();
    for (const key of ALL_KEYS) expect(stored(key)).toEqual(key === "planning.programPick" ? [] : key === "roadmap.filter.flagged" ? false : null);
  });

  test("a pick change is written to the shared pick key and the address", async () => {
    renderWithProviders(<Probe />, { route: "/roadmap" });
    const user = userEvent.setup();
    await user.click(screen.getByText("pick 21"));
    expect(url()).toBe("?programId=21");
    expect(stored("planning.programPick")).toEqual([21]);
    await user.click(screen.getByText("clear pick"));
    expect(url()).toBe("");
    expect(stored("planning.programPick")).toEqual([]);
  });

  test("Back shows the earlier address's filters and stores nothing", async () => {
    renderWithProviders(<Probe />, { route: "/roadmap" });
    const user = userEvent.setup();
    await user.click(screen.getByText("go flagged"));
    expect(shown().filters.flaggedOnly).toBe(true);
    expect(viewSettings()).toEqual([]);
    await user.click(screen.getByText("back"));
    expect(url()).toBe("");
    expect(shown().filters.flaggedOnly).toBe(false);
    expect(viewSettings()).toEqual([]);
  });
});
