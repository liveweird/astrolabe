import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import TeamSelect from "./TeamSelect";
import type { PickedOption } from "./SearchPicker";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const TEAMS = {
  items: [
    { id: 3, name: "Backend", description: null, managerPersonId: null, managerName: null, createdAt: 1, updatedAt: 2 },
    { id: 4, name: "Design", description: null, managerPersonId: null, managerName: null, createdAt: 1, updatedAt: 2 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

function Harness({ onChange }: { onChange: (p: PickedOption | null) => void }) {
  const [picked, setPicked] = useState<PickedOption | null>(null);
  return (
    <TeamSelect
      picked={picked}
      onPick={(p) => {
        setPicked(p);
        onChange(p);
      }}
    />
  );
}

describe("TeamSelect", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn((url: string) =>
      Promise.resolve(url.startsWith("/api/v1/teams?") ? jsonResponse(200, TEAMS) : jsonResponse(404, { title: "x", status: 404 })),
    );
    vi.stubGlobal("fetch", mockFetch);
    // A regular session: the teams registry is open to every signed-in user.
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.roles", "[]");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists the teams by name for any session and reports the pick", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    expect(await screen.findByRole("option", { name: "Backend" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Design" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "4", label: "Design" });
    const first = mockFetch.mock.calls[0][0] as string;
    expect(first).toContain("pageSize=50");
    expect(first).toContain("sort=name");
  });

  test("typing searches the teams server-side by name", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={vi.fn()} />);
    await user.type(screen.getByRole("combobox", { name: "Team" }), "des");
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => (url as string).includes("name=des"))).toBe(true));
  });
});
