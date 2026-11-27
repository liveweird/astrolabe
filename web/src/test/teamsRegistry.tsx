/* eslint-disable react-refresh/only-export-components */
// -- test scaffolding: the page's fixtures and its renderer beside a small route probe; fast-refresh is irrelevant under vitest
// Shared by the Teams page's registry tests (`pages/Teams.test.tsx`, `pages/Teams.focus.test.tsx`): the document the page reads, the teams read behind the
// editor, one served stub and the page at /teams beside a probe of /teams/:id.
import { vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import Teams from "../pages/Teams";
import { jsonResponse } from "./http";
import { renderWithProviders } from "./render";
import { teamLoadRow, teamLoadView } from "./teamLoad";

export const TOKEN_KEY = "astrolabe.auth.token";
export const ROLES_KEY = "astrolabe.auth.roles";

export type FetchMock = ReturnType<typeof vi.fn>;

export const PAGE = {
  items: [
    { id: 1, name: "Payments", description: "Money movers", managerPersonId: 7, managerName: "Mia Manager", colour: "INDIGO", createdAt: 1, updatedAt: 2 },
    { id: 2, name: "Identity", description: null, managerPersonId: null, managerName: null, colour: "INDIGO", createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};
/** The document the page reads: Payments with figures and a manager, Identity bare. */
export const ROWS = [
  teamLoadRow({ id: 1, name: "Payments", description: "Money movers", managerPersonId: 7, managerName: "Mia Manager", milestones: 12, unscheduledMilestones: 2, overloadedWeeks: 1 }),
  teamLoadRow({ id: 2, name: "Identity", description: null, managerPersonId: null, managerName: null, milestones: 3 }),
];
export const DETAIL = {
  id: 1,
  name: "Payments",
  description: "Money movers",
  managerPersonId: 7,
  managerName: "Mia Manager",
  colour: "INDIGO",
  createdAt: 1,
  updatedAt: 2,
};
export const PEOPLE = {
  items: [
    { id: 7, name: "Mia Manager", email: "mia@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
    { id: 12, name: "Cara New", email: "cara@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

export function serve(mockFetch: FetchMock, mutations: Record<string, { status: number; body?: unknown }> = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    if (mutations[key]) {
      const m = mutations[key];
      return Promise.resolve(m.body === undefined ? new Response(null, { status: m.status }) : jsonResponse(m.status, m.body));
    }
    if (method === "GET" && url === "/api/v1/views/team-load") return Promise.resolve(jsonResponse(200, teamLoadView(ROWS)));
    if (method === "GET" && url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, PAGE));
    if (method === "GET" && url === "/api/v1/teams/1") return Promise.resolve(jsonResponse(200, DETAIL));
    if (method === "GET" && url.startsWith("/api/v1/people?")) return Promise.resolve(jsonResponse(200, PEOPLE));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
}

export function findCall(mockFetch: FetchMock, method: string, url: string) {
  return mockFetch.mock.calls.find(([u, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && u === url);
}

function Probe() {
  const { pathname } = useLocation();
  return <p>at {pathname}</p>;
}

export function renderPage(queryClient?: QueryClient) {
  // The shell's focus target (`useFocusMainOnNavigation`, and where `useDialogFocus` sends a focus whose opener has gone).
  return renderWithProviders(
    <main id="main-content" tabIndex={-1}>
      <Routes>
        <Route path="/teams" element={<Teams />} />
        <Route path="/teams/:id" element={<Probe />} />
      </Routes>
    </main>,
    { route: "/teams", queryClient },
  );
}
