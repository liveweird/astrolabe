import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { jsonResponse } from "../test/http";
import { ONE_CONNECTION_SOURCE } from "../test/jira";
import { fillScope, hangUntilAborted, installImportApi, previewScope, type Handler } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";

// Every way the two calls can fail: the 180 s client abort, a stopped preview, and 400/403/404/409/429/502 - inline, in words, never a toast.

const problem = (status: number, extra: Record<string, unknown> = {}) => jsonResponse(status, { title: "x", status, ...extra });
const ok: Handler = () => jsonResponse(200, previewOf(PREVIEW_ITEMS));

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = () => renderWithProviders(<JiraImportModal source={ONE_CONNECTION_SOURCE} onClose={vi.fn()} />, { queryClient });
const importButton = () => screen.getByRole("button", { name: /^Import \(\d+\)$/ });

describe("the preview call", () => {
  test("is aborted by the client at 180 s with a visible wait and an answer in words, and cannot be submitted twice meanwhile", async () => {
    const user = userEvent.setup();
    const api = installImportApi({ preview: hangUntilAborted });
    open();
    await fillScope(user);
    vi.useFakeTimers();
    const button = screen.getByRole("button", { name: "Preview" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByText(/Reading Jira… a large scope can take up to 3 minutes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(179_000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Reading Jira took longer than 3 minutes and was stopped. Narrow the Jira projects and try again.");
    expect(screen.queryByText(/Reading Jira… a large scope/)).not.toBeInTheDocument();
    expect(api.previews()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  test("Stop abandons the read quietly and leaves the form as it was", async () => {
    const user = userEvent.setup();
    const api = installImportApi({ preview: hangUntilAborted });
    open();
    await fillScope(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Work stream/ })).toHaveValue("Platform");
    expect(api.previews()).toHaveLength(1);
  });

  test.each([
    [502, { detail: "Jira did not answer (TIMEOUT)", type: "urn:astrolabe:problem:jira-upstream" }, /Jira could not be reached or refused the request:.*\(TIMEOUT\)/s],
    [429, {}, /Too many import requests: previews and imports share a limit of 5 a minute/],
    [403, { detail: "You do not own program Billing, under which IMP-7 would be created" }, /You may not import here:.*You do not own program Billing/s],
    [404, { detail: "Work stream not found" }, /no longer exists:.*Work stream not found/s],
    [400, { detail: "projectKeys: unknown key" }, /The import was refused:.*unknown key/s],
    [409, { type: "urn:astrolabe:problem:jira-mapping-invalid", detail: "level 2 is gone" }, /no longer fits the Jira site.*level 2 is gone/s],
    [409, { type: "urn:astrolabe:problem:jira-not-discovered" }, /has not been tested yet/],
  ])("a %i answer stays on the scope step as an inline alert", async (status, extra, message) => {
    const user = userEvent.setup();
    installImportApi({ preview: () => problem(status, extra) });
    open();
    await fillScope(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });
});

describe("the apply call", () => {
  test("a 409 (the mapping or discovery changed while it was read) rolls back whole and offers a fresh preview", async () => {
    const user = userEvent.setup();
    const api = installImportApi({
      preview: ok,
      apply: () => problem(409, { type: "urn:astrolabe:problem:jira-mapping-invalid", detail: "The connection's mapping or discovery changed while the import was read - preview again" }),
    });
    open();
    await previewScope(user);
    await user.click(importButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("changed while the import was read, so nothing was written");
    expect(alert).toHaveTextContent("preview again");
    // The preview and its ticks are still on screen, and Import can be retried.
    expect(screen.getByRole("table", { name: "Import preview" })).toBeInTheDocument();
    expect(importButton()).toBeEnabled();
    await user.click(screen.getAllByRole("button", { name: "Preview again" })[0]);
    await waitFor(() => expect(api.previews()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  test.each([
    [409, {}, /changed while importing. Nothing was written/],
    [400, { detail: "The connection's project keys changed - preview again" }, /The import was refused:.*project keys changed/s],
    [429, {}, /5 a minute/],
    [502, { detail: "Jira did not answer (RATE_LIMITED)" }, /could not be reached.*\(RATE_LIMITED\)/s],
    [403, { detail: "You do not own project Invoices" }, /You may not import here:.*Invoices/s],
  ])("a %i answer is told in words above the kept preview", async (status, extra, message) => {
    const user = userEvent.setup();
    installImportApi({ preview: ok, apply: () => problem(status, extra) });
    open();
    await previewScope(user);
    await user.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("table", { name: "Import preview" })).toBeInTheDocument();
  });

  test.each([
    ["a 500", () => problem(500)],
    ["a 504", () => problem(504)],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("%s leaves the write in doubt: it says so, offers a fresh preview and refreshes the plan", async (_name, apply) => {
    const user = userEvent.setup();
    installImportApi({ preview: ok, apply });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    open();
    await previewScope(user);
    await user.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("may still have been applied");
    expect(screen.getAllByRole("button", { name: "Preview again" }).length).toBeGreaterThan(0);
    await waitFor(() => expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === '["plan"]')).toBe(true));
  });

  test("the 180 s abort says the import may still have landed, offers a fresh preview and refreshes the plan", async () => {
    const user = userEvent.setup();
    const api = installImportApi({ preview: ok, apply: hangUntilAborted });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    open();
    await previewScope(user);
    vi.useFakeTimers();
    fireEvent.click(importButton());
    expect(screen.getByText("Importing… keep this window open.")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(screen.getByRole("alert")).toHaveTextContent("may still have been applied");
    expect(screen.getAllByRole("button", { name: "Preview again" }).length).toBeGreaterThan(0);
    expect(api.applies()).toHaveLength(1);
    expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === '["plan"]')).toBe(true);
  });
});
