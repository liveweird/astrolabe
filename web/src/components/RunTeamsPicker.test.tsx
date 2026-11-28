import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import RunTeamsPicker from "./RunTeamsPicker";
import { routeFetch } from "../test/http";
import { TEAM_LIST } from "../test/overviewRun";
import { renderWithProviders } from "../test/render";

const DEFAULTS = [1, 2];

function Harness({ disabled = false, label, start = DEFAULTS }: { disabled?: boolean; label?: string; start?: number[] }) {
  const [value, setValue] = useState(start);
  return <RunTeamsPicker value={value} onChange={setValue} defaultIds={DEFAULTS} disabled={disabled} label={label} />;
}
const picker = () => screen.getByRole("combobox", { name: "Teams in the run" });
const pills = () => [...document.querySelectorAll(".mantine-Pill-root")].map((pill) => pill.textContent);

beforeEach(() => {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": TEAM_LIST }));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("RunTeamsPicker", () => {
  test("is named 'Teams in the run', holds the value as team names, and offers every active team", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta"]));
    await user.click(picker());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  test("the reset shows only while the value differs from the defaults, and puts them back", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta"]));
    expect(screen.queryByRole("button", { name: "Use this page's teams" })).toBeNull();
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "Delta" }));
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta", "Delta"]));
    await user.click(screen.getByRole("button", { name: "Use this page's teams" }));
    await waitFor(() => expect(pills()).toEqual(["Alpha", "Beta"]));
    expect(screen.queryByRole("button", { name: "Use this page's teams" })).toBeNull();
  });

  test("a disabled picker cannot be changed and offers no reset", () => {
    renderWithProviders(<Harness disabled start={[1]} />);
    expect(picker()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Use this page's teams" })).toBeNull();
  });

  test("when the teams cannot be read a held team reads 'Team 1', not '…' for ever", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/teams": () => new Response(JSON.stringify({ title: "x", status: 500 }), { status: 500, headers: { "Content-Type": "application/problem+json" } }) }));
    renderWithProviders(<Harness start={[1]} />);
    await waitFor(() => expect(pills()).toEqual(["Team 1"]));
  });

  test("a held team the settled list lacks reads 'Team 9'; a label replaces the default name", async () => {
    renderWithProviders(<Harness start={[9]} label="Plan together with" />);
    await waitFor(() => expect(pills()).toEqual(["Team 9"]));
    expect(screen.getByRole("combobox", { name: "Plan together with" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Teams in the run" })).toBeNull();
  });

  test("a page may word it itself and leave out one team: its own aria-label, placeholder and reset, and no option for the excluded team", async () => {
    const user = userEvent.setup();
    function Wording() {
      const [value, setValue] = useState<number[]>([]);
      return <RunTeamsPicker value={value} onChange={setValue} defaultIds={[]} ariaLabel="Plan together with" placeholder="Other teams" resetLabel="Plan this team alone" excludeId={1} />;
    }
    renderWithProviders(<Wording />);
    const combobox = await screen.findByRole("combobox", { name: "Plan together with" });
    expect(combobox).toHaveAttribute("placeholder", "Other teams");
    await user.click(combobox);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Beta", "Gamma", "Delta"]);
    await user.click(screen.getByRole("option", { name: "Gamma" }));
    await user.click(await screen.findByRole("button", { name: "Plan this team alone" }));
    await waitFor(() => expect(pills()).toEqual([]));
  });
});
