import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import ProgramSelect from "./ProgramSelect";
import type { PickedOption } from "./SearchPicker";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const PROGRAMS = {
  items: [
    { id: 20, workStreamId: 200, workStreamName: "Platform", name: "Billing", description: null, ownerPersonId: 1, ownerName: "O", createdAt: 1, updatedAt: 2 },
    { id: 21, workStreamId: 201, workStreamName: "Growth", name: "Billing", description: null, ownerPersonId: 1, ownerName: "O", createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};
const NONE = { items: [], page: 1, pageSize: 50, total: 0 };

function Harness({ initial = null, onChange }: { initial?: PickedOption | null; onChange: (p: PickedOption | null) => void }) {
  const [picked, setPicked] = useState<PickedOption | null>(initial);
  return (
    <ProgramSelect
      picked={picked}
      onPick={(p) => {
        setPicked(p);
        onChange(p);
      }}
    />
  );
}

describe("ProgramSelect", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn((url: string) => {
      if (url.startsWith("/api/v1/programs?")) return Promise.resolve(jsonResponse(200, url.includes("name=zzz") ? NONE : PROGRAMS));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    // A regular session: the program list is open to every signed-in user.
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", "[]");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists programs as `name · work stream` sorted by name, and reports the pick", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Program" }));
    expect(await screen.findByRole("option", { name: "Billing · Platform" })).toBeInTheDocument();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/v1/programs?page=1&pageSize=50&sort=name");
    await user.click(screen.getByRole("option", { name: "Billing · Growth" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "21", label: "Billing · Growth" });
  });

  test("typing searches server-side through `name`, and the picked entry survives a new search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ value: "9", label: "Held Over · Platform" }} onChange={() => {}} />);
    const box = screen.getByRole("combobox", { name: "Program" });
    expect(box).toHaveValue("Held Over · Platform");
    await user.click(box);
    await user.clear(box);
    await user.type(box, "bil");
    await waitFor(() => expect(mockFetch.mock.calls.some(([u]) => typeof u === "string" && u.includes("name=bil"))).toBe(true));
    expect(await screen.findByRole("option", { name: "Billing · Platform" })).toBeInTheDocument();
  });

  test("a completed search with no hit says no matching programs", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={() => {}} />);
    const box = screen.getByRole("combobox", { name: "Program" });
    await user.click(box);
    await user.type(box, "zzz");
    expect(await screen.findByText("No matching programs")).toBeInTheDocument();
  });

  test("clearing reports null", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ value: "20", label: "Billing · Platform" }} onChange={onChange} />);
    await user.click(screen.getByLabelText("Clear the program"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  test("a field error is shown on the picker", () => {
    renderWithProviders(<ProgramSelect picked={null} onPick={() => {}} error="Pick a plan item" />);
    expect(screen.getByText("Pick a plan item")).toBeInTheDocument();
  });
});
