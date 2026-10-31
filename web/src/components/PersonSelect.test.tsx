import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import PersonSelect from "./PersonSelect";
import type { PickedOption } from "./SearchPicker";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const PEOPLE = {
  items: [
    { id: 3, name: "Anna Nowak", email: "anna@example.com", userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
    { id: 4, name: "Ext Owner", email: null, userId: null, userEmail: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

function Harness({ initial = null, onChange }: { initial?: PickedOption | null; onChange: (p: PickedOption | null) => void }) {
  const [picked, setPicked] = useState<PickedOption | null>(initial);
  return (
    <PersonSelect
      label="Owner"
      placeholder="Search people…"
      clearLabel="Clear the owner"
      picked={picked}
      onPick={(p) => {
        setPicked(p);
        onChange(p);
      }}
    />
  );
}

describe("PersonSelect", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn((url: string) =>
      Promise.resolve(url.startsWith("/api/v1/people?") ? jsonResponse(200, PEOPLE) : jsonResponse(404, { title: "x", status: 404 })),
    );
    vi.stubGlobal("fetch", mockFetch);
    // A regular session: the people directory is open to every signed-in user.
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", "[]");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists people as `name (email)` or `name` for any session, and reports the pick", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    expect(await screen.findByRole("option", { name: "Anna Nowak (anna@example.com)" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Ext Owner" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "4", label: "Ext Owner" });
  });

  test("typing searches server-side by name, and the picked entry survives a new search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ value: "9", label: "Held Over" }} onChange={() => {}} />);
    const box = screen.getByRole("combobox", { name: "Owner" });
    expect(box).toHaveValue("Held Over");
    await user.click(box);
    await user.clear(box);
    await user.type(box, "ann");
    await waitFor(() => expect(mockFetch.mock.calls.some(([u]) => typeof u === "string" && u.includes("name=ann"))).toBe(true));
    expect(await screen.findByRole("option", { name: "Anna Nowak (anna@example.com)" })).toBeInTheDocument();
  });

  test("clearing reports null", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ value: "3", label: "Anna Nowak" }} onChange={onChange} />);
    await user.click(screen.getByLabelText("Clear the owner"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
