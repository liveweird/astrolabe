import { afterEach, describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useProgramPick } from "./useProgramPick";
import { renderWithProviders } from "../test/render";

const KEY = "planning.programPick";
const stored = () => JSON.parse(localStorage.getItem(`astrolabe.viewSettings.${KEY}`) ?? "null") as unknown;

/** Shows what the hook answers and the address, and gives the test the user's changes and two navigations. */
function Probe() {
  const [pick, setPick] = useProgramPick();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="shown">{JSON.stringify(pick)}</output>
      <output data-testid="url">{location.search}</output>
      <output data-testid="nav">{useNavigationType()}</output>
      <button onClick={() => setPick([22, 21])}>pick 21 22</button>
      <button onClick={() => setPick([])}>clear pick</button>
      <button onClick={() => navigate("/programs?programId=30")}>go 30</button>
      <button onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

const shown = () => JSON.parse(screen.getByTestId("shown").textContent ?? "null") as number[];
const url = () => screen.getByTestId("url").textContent;
const nav = () => screen.getByTestId("nav");

/** The view-settings keys the browser holds (the test setup may keep others, such as the language). */
const viewSettings = () => Object.keys(localStorage).filter((key) => key.startsWith("astrolabe.viewSettings."));
const remember = (value: string) => localStorage.setItem(`astrolabe.viewSettings.${KEY}`, value);

afterEach(() => localStorage.clear());

describe("useProgramPick", () => {
  test("a bare address with nothing remembered shows no pick, stays bare and writes nothing", () => {
    renderWithProviders(<Probe />, { route: "/programs" });
    expect(shown()).toEqual([]);
    expect(url()).toBe("");
    expect(nav()).toHaveTextContent("POP");
    expect(viewSettings()).toEqual([]);
  });

  test("a bare address with a pick remembered shows it and is rewritten by replace; the memory is untouched", async () => {
    remember("[12,11]");
    renderWithProviders(<Probe />, { route: "/programs" });
    expect(await screen.findByText("?programId=11&programId=12")).toBeInTheDocument();
    expect(shown()).toEqual([11, 12]);
    expect(nav()).toHaveTextContent("REPLACE");
    expect(stored()).toEqual([12, 11]);
  });

  test("a remembered value that fails its validator reads as no pick", () => {
    remember('["a"]');
    renderWithProviders(<Probe />, { route: "/programs" });
    expect(shown()).toEqual([]);
    expect(url()).toBe("");
  });

  test("a link is shown as written (canonical order, foreign parameter kept) and the memory is untouched", () => {
    remember("[11]");
    renderWithProviders(<Probe />, { route: "/programs?programId=22&programId=21&programId=21&x=1" });
    expect(shown()).toEqual([21, 22]);
    expect(url()).toBe("?programId=22&programId=21&programId=21&x=1");
    expect(nav()).toHaveTextContent("POP");
    expect(stored()).toEqual([11]);
  });

  test("a malformed programId alone is a linked view with no pick and restores nothing", () => {
    remember("[11]");
    renderWithProviders(<Probe />, { route: "/programs?programId=abc" });
    expect(shown()).toEqual([]);
    expect(url()).toBe("?programId=abc");
    expect(nav()).toHaveTextContent("POP");
    expect(stored()).toEqual([11]);
  });

  test("a change on a linked view writes the memory and rewrites the address by replace, keeping a foreign parameter", async () => {
    remember("[11]");
    renderWithProviders(<Probe />, { route: "/programs?programId=30&x=1" });
    await userEvent.setup().click(screen.getByText("pick 21 22"));
    expect(url()).toBe("?x=1&programId=21&programId=22");
    expect(shown()).toEqual([21, 22]);
    expect(nav()).toHaveTextContent("REPLACE");
    expect(stored()).toEqual([22, 21]);
  });

  test("clearing the pick leaves a bare address and [] stored, and it stays bare", async () => {
    remember("[11]");
    renderWithProviders(<Probe />, { route: "/programs" });
    const user = userEvent.setup();
    expect(await screen.findByText("?programId=11")).toBeInTheDocument();
    await user.click(screen.getByText("clear pick"));
    expect(url()).toBe("");
    expect(shown()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  test("Back shows the earlier address's pick and stores nothing", async () => {
    renderWithProviders(<Probe />, { route: "/programs" });
    const user = userEvent.setup();
    await user.click(screen.getByText("go 30"));
    expect(shown()).toEqual([30]);
    expect(viewSettings()).toEqual([]);
    await user.click(screen.getByText("back"));
    expect(url()).toBe("");
    expect(shown()).toEqual([]);
    expect(viewSettings()).toEqual([]);
  });

  test("it writes the shared pick key only, never one of the Roadmap's four other keys", async () => {
    renderWithProviders(<Probe />, { route: "/programs" });
    await userEvent.setup().click(screen.getByText("pick 21 22"));
    expect(viewSettings()).toEqual([`astrolabe.viewSettings.${KEY}`]);
  });
});
