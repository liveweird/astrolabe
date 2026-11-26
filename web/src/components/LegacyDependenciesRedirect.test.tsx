import { describe, expect, test } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import LegacyDependenciesRedirect from "./LegacyDependenciesRedirect";

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

const landing = async (route: string) => {
  renderWithProviders(
    <Routes>
      <Route path="/dependencies" element={<LegacyDependenciesRedirect />} />
      <Route path="*" element={<Landed />} />
    </Routes>,
    { route },
  );
  return (await screen.findByTestId("landed")).textContent;
};

describe("LegacyDependenciesRedirect", () => {
  test("an old filtered address opens the Roadmap's panel with the same filters under the panel's names", async () => {
    expect(await landing("/dependencies?status=violated&teamId=4&projectId=5")).toBe("/roadmap?dependencies=violated&dependencyTeamId=4&dependencyProjectId=5");
  });

  test("the bare address opens the panel unfiltered", async () => {
    expect(await landing("/dependencies")).toBe("/roadmap?dependencies=all");
  });

  test("no other old parameter is kept", async () => {
    expect(await landing("/dependencies?programId=3&bogus=1")).toBe("/roadmap?dependencies=all");
  });
});
