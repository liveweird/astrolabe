// The Jira import modal's test harness: a fetch stub with the plan, people and teams the scope step reads and a handler per import call,
// plus the clicks that fill the scope step. Shared by the modal's test files (knip counts test files as entries).
import { expect, vi } from "vitest";
import type userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import type { PlanView } from "../api/plan";
import { jsonResponse } from "./http";

const PLAN = {
  revision: 4,
  can: { createWorkStream: true },
  workStreams: [
    {
      id: 3,
      name: "Platform",
      endDate: null,
      programs: [{ id: 4, name: "Billing", projects: [{ id: 9, name: "Invoices" }] }],
    },
  ],
} as unknown as PlanView;

const PEOPLE = {
  items: [
    { id: 8, name: "Ola Owner", email: null, userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
    { id: 9, name: "Pat Planner", email: null, userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};
const TEAMS = {
  items: [
    { id: 5, name: "IMP Team", description: null, managerPersonId: null, managerName: null, createdAt: 1, updatedAt: 2 },
    { id: 6, name: "Default Team", description: null, managerPersonId: null, managerName: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 100,
  total: 2,
};

export type Handler = (body: unknown, init: RequestInit) => Response | Promise<Response>;
type Call = { url: string; body: unknown };

const IMPORT_BASE = "/api/v1/integrations/jira/connections/1";

/** Installs the fetch stub; `previews()` / `applies()` are the JSON bodies POSTed so far, in order. */
export function installImportApi(handlers: { preview: Handler; apply?: Handler }) {
  const calls: Call[] = [];
  const mock = vi.fn((url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, body });
    if (url === `${IMPORT_BASE}/import-preview`) return Promise.resolve(handlers.preview(body, init));
    if (url === `${IMPORT_BASE}/import`) return Promise.resolve((handlers.apply ?? (() => jsonResponse(500, { title: "x", status: 500 })))(body, init));
    if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, PLAN));
    if (url.startsWith("/api/v1/people?")) return Promise.resolve(jsonResponse(200, PEOPLE));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, TEAMS));
    return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
  });
  vi.stubGlobal("fetch", mock);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
  const bodies = (url: string) => calls.filter((call) => call.url === url).map((call) => call.body);
  return { mock, previews: () => bodies(`${IMPORT_BASE}/import-preview`), applies: () => bodies(`${IMPORT_BASE}/import`) };
}

/** A fetch that never answers until its signal aborts, then rejects the way a real fetch does. */
export const hangUntilAborted: Handler = (_body, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });

type User = ReturnType<typeof userEvent.setup>;

/** Picks the work stream and the owner (the two required fields) on the scope step. */
export async function fillScope(user: User) {
  await user.click(screen.getByRole("combobox", { name: /^Work stream/ }));
  await user.click(await screen.findByRole("option", { name: "Platform" }));
  await user.click(screen.getByRole("combobox", { name: "Owner of the new items" }));
  await user.click(await screen.findByRole("option", { name: "Ola Owner" }));
}

/** Fills the scope step and previews; resolves once the preview phase is on screen. A rooted dialog (1.14) has both required fields preset (`rooted`: nothing to fill). */
export async function previewScope(user: User, rooted = false) {
  if (!rooted) await fillScope(user);
  await user.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "What the import would do" })).toBeInTheDocument());
}
