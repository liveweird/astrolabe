/* eslint-disable react-refresh/only-export-components */
// -- test scaffolding: helpers beside a small component; fast-refresh is irrelevant under vitest
// Shared scaffolding of the Teams page's load tests (`pages/Teams.load.test.tsx`): the page at /teams with the
// location it ended at, and the reads of the team-load document itself.
import type { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import Teams from "../pages/Teams";
import { renderWithProviders } from "./render";

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <p data-testid="where">{location.pathname + location.search}</p>
      <p data-testid="nav">{type}</p>
    </>
  );
}

/** The Teams page at `route` (with the shell's focus target), beside the address it ended at (`where`) and how it got there (`nav`). */
export function renderTeamsPage(route = "/teams", queryClient?: QueryClient) {
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route
          path="/teams"
          element={
            <>
              <Teams />
              <Where />
            </>
          }
        />
      </Routes>
    </main>,
    { route, queryClient },
  );
}

/** The reads of the document itself: the page also reads the teams (their colours, `useTeamColours`), which these counts must not include. */
export const loadReads = (mockFetch: { mock: { calls: unknown[][] } }) => mockFetch.mock.calls.filter(([url]) => url === "/api/v1/views/team-load");
