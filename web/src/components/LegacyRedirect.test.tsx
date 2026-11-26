import { describe, expect, test } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import LegacyRedirect from "./LegacyRedirect";

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

const renderAt = (route: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/old" element={<LegacyRedirect to="/new" params={{ mode: "overview" }} />} />
      <Route path="/plain" element={<LegacyRedirect to="/new" />} />
      <Route path="/new" element={<Landed />} />
    </Routes>,
    { route },
  );

describe("LegacyRedirect", () => {
  test("keeps the old address's query (a repeated key too) and hash, and sets the given parameters first", async () => {
    renderAt("/old?programId=2&programId=3&x=1#top");
    expect((await screen.findByTestId("landed")).textContent).toBe("/new?mode=overview&programId=2&programId=3&x=1#top");
  });

  test("a parameter it sets wins over the same name in the old address", async () => {
    renderAt("/old?mode=prioritization&programId=2");
    expect((await screen.findByTestId("landed")).textContent).toBe("/new?mode=overview&programId=2");
  });

  test("without parameters or a query it is a plain redirect", async () => {
    renderAt("/plain");
    expect((await screen.findByTestId("landed")).textContent).toBe("/new");
  });
});
