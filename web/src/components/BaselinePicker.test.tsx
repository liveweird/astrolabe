import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import BaselinePicker from "./BaselinePicker";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const item = (id: number, name: string) => ({ id, name, description: null, planRevision: id, createdAt: id, createdBy: null, milestoneCount: 1, projectCount: 1 });

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const answer = (items: ReturnType<typeof item>[]) => mockFetch.mockResolvedValue(jsonResponse(200, { items, can: { manage: false } }));

describe("BaselinePicker", () => {
  test("options are None then the baselines as the server lists them (newest first), the first marked latest", async () => {
    const user = userEvent.setup();
    answer([item(3, "Q3"), item(2, "Q2"), item(1, "Q1")]);
    renderWithProviders(<BaselinePicker pick={null} onPick={vi.fn()} />);
    const picker = screen.getByRole("combobox", { name: "Baseline" });
    expect(picker).toHaveValue("None");
    await screen.findByText("Baseline");
    await user.click(picker);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["None", "Q3 (latest)", "Q2", "Q1"]);
  });

  test("choosing a baseline picks its id, choosing None clears the pick", async () => {
    const user = userEvent.setup();
    answer([item(3, "Q3"), item(2, "Q2")]);
    const onPick = vi.fn();
    renderWithProviders(<BaselinePicker pick={2} onPick={onPick} />);
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: "Q3 (latest)" }));
    expect(onPick).toHaveBeenLastCalledWith(3);
    await user.click(screen.getByRole("combobox", { name: "Baseline" }));
    await user.click(await screen.findByRole("option", { name: "None" }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  test("a pick the list does not hold (still loading) is named by the view that answered for it", async () => {
    answer([item(3, "Q3")]);
    renderWithProviders(<BaselinePicker pick={9} onPick={vi.fn()} current={{ id: 9, name: "Elsewhere" }} />);
    expect(screen.getByRole("combobox", { name: "Baseline" })).toHaveValue("Elsewhere");
  });

  test("a pick that is not among the options (the list is loading, or it was just deleted) stays an option of its own: never a blank field", async () => {
    answer([item(3, "Q3")]);
    renderWithProviders(<BaselinePicker pick={9} onPick={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Baseline" })).toHaveValue("Baseline 9");
  });

  test("the page can disable it while a write is in flight", async () => {
    answer([item(3, "Q3")]);
    renderWithProviders(<BaselinePicker pick={null} onPick={vi.fn()} disabled />);
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeDisabled();
    expect(screen.queryByText("Baselines could not be loaded.")).toBeNull();
  });

  test("a list that could not be loaded disables the picker and says so", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { title: "x", status: 500 }));
    renderWithProviders(<BaselinePicker pick={null} onPick={vi.fn()} />);
    expect(await screen.findByText("Baselines could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Baseline" })).toBeDisabled();
  });
});
