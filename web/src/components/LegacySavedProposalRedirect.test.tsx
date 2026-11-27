import { describe, expect, test } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import LegacySavedProposalRedirect from "./LegacySavedProposalRedirect";

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

const landing = async (route: string) => {
  renderWithProviders(
    <Routes>
      <Route path="/schedule-proposals/saved/:id" element={<LegacySavedProposalRedirect />} />
      <Route path="*" element={<Landed />} />
    </Routes>,
    { route },
  );
  return (await screen.findByTestId("landed")).textContent;
};

describe("LegacySavedProposalRedirect", () => {
  test("a saved proposal's old address opens it on the Roadmap overview", async () => {
    expect(await landing("/schedule-proposals/saved/5")).toBe("/roadmap?mode=overview&proposal=5");
  });

  test("a malformed id lands on the overview alone, and the old query is not kept", async () => {
    expect(await landing("/schedule-proposals/saved/abc?x=1")).toBe("/roadmap?mode=overview");
  });
});
