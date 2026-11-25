import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import DeviationsFilters from "./DeviationsFilters";
import { jsonResponse } from "../test/http";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

// The work stream filter lists the plan's streams: the plan view comes in the SHARED order (a hand arrangement of the Plan page: a closed
// stream first, Zulu before alpha), and the filter sorts explicitly, open first by name, never by that order.
const ARRANGED = planOf([
  { id: 1, name: "Aardvark", endDate: "2026-06-30" },
  { id: 3, name: "Zulu" },
  { id: 2, name: "alpha" },
]);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/v1/views/plan") return Promise.resolve(jsonResponse(200, ARRANGED));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 100, total: 0 }));
      return Promise.resolve(jsonResponse(404, { title: "x", status: 404 }));
    }),
  );
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("DeviationsFilters: the work stream filter does not follow the plan's shared order", () => {
  test("open streams by name, then the closed ones", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeviationsFilters filter={{}} connections={[]} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("combobox", { name: "Work stream" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["alpha", "Zulu", "Aardvark"]);
  });
});
