import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { milestoneItem, milestonePage } from "../test/milestones";
import { jsonResponse } from "../test/http";
import { renderWithProviders, screen } from "../test/render";
import MilestoneSelect from "./MilestoneSelect";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn(() => Promise.resolve(jsonResponse(200, milestonePage([milestoneItem({ id: 1, name: "Design", projectId: 7, projectName: "Invoices" })]))));
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const lastQuery = () => new URL(String(mockFetch.mock.calls.at(-1)?.[0]), "http://test").searchParams;

describe("MilestoneSelect", () => {
  test("without a project it searches every project's milestones, with the predecessor's texts", async () => {
    renderWithProviders(<MilestoneSelect picked={null} onPick={() => undefined} />);
    expect(await screen.findByRole("combobox", { name: "Predecessor" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Predecessor" }));
    expect(await screen.findByRole("option", { name: "Design · Invoices" })).toBeInTheDocument();
    expect(lastQuery().has("projectId")).toBe(false);
    expect(lastQuery().get("sort")).toBe("name");
  });

  test("with a project it asks for that project's milestones only, in a query of its own, and takes the caller's label and clear text", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(
      <MilestoneSelect projectId={7} label="Successor" clearLabel="Clear the successor" picked={{ value: "1", label: "Design · Invoices" }} onPick={() => undefined} />,
      { queryClient },
    );
    expect(await screen.findByRole("combobox", { name: "Successor" })).toHaveValue("Design · Invoices");
    expect(screen.getByLabelText("Clear the successor")).toBeInTheDocument();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(lastQuery().get("projectId")).toBe("7");
    expect(queryClient.getQueryCache().getAll().some((query) => query.queryKey[3] === 7)).toBe(true);
  });
});
