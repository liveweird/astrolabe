import { describe, expect, test } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import LegacyMilestonesRedirect from "./LegacyMilestonesRedirect";

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

const landing = async (route: string) => {
  renderWithProviders(
    <Routes>
      <Route path="/milestones" element={<LegacyMilestonesRedirect />} />
      <Route path="*" element={<Landed />} />
    </Routes>,
    { route },
  );
  return (await screen.findByTestId("landed")).textContent;
};

describe("LegacyMilestonesRedirect", () => {
  test("a project's old address opens its Milestones table with the Schedule word, and nothing else of the old query is kept", async () => {
    expect(await landing("/milestones?scheduled=false&projectId=7&name=x")).toBe("/projects/7?milestones=unscheduled");
  });

  test("a team alone goes to the team's page, the bare route to the Projects page", async () => {
    expect(await landing("/milestones?scheduled=false&teamId=4")).toBe("/teams/4");
  });

  test("the bare route goes to the Projects page", async () => {
    expect(await landing("/milestones")).toBe("/projects");
  });
});
