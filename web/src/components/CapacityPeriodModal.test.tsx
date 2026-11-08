import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import CapacityPeriodModal from "./CapacityPeriodModal";
import type { CapacityPeriod } from "../api/teams";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

type FetchMock = ReturnType<typeof vi.fn>;

const PERIOD: CapacityPeriod = {
  id: 11,
  teamId: 1,
  effectiveFrom: "2027-02-03",
  mdPerWeek: 8,
  wipLimit: 1,
  createdAt: 1,
  updatedAt: 2,
  source: "MANUAL",
  flowSprintName: null,
};
/** Text only the SERVER sends: it must never reach the screen (the dialog speaks its own, translated, fixed vocabulary). */
const LEAK = "SERVER-DETAIL-MUST-NOT-SHOW";

let mockFetch: FetchMock;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onSaved: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  onClose = vi.fn<() => void>();
  onSaved = vi.fn<() => Promise<void>>(() => Promise.resolve());
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function answer(status: number) {
  mockFetch.mockResolvedValue(jsonResponse(status, { title: "Problem", status, detail: LEAK }));
}

/** Create mode needs the fields typed; edit mode starts from the period, so only Save is pressed. */
async function submit(target: CapacityPeriod | null) {
  const user = userEvent.setup();
  renderWithProviders(<CapacityPeriodModal teamId={1} target={target} onClose={onClose} onSaved={onSaved} />);
  const dialog = await screen.findByRole("dialog");
  if (target === null) {
    await user.type(within(dialog).getByRole("textbox", { name: "Effective from" }), "2027-03-02");
    await user.type(within(dialog).getByRole("textbox", { name: "Man-days per week" }), "10");
  }
  await user.click(within(dialog).getByRole("button", { name: target === null ? "Create" : "Save" }));
  return dialog;
}

describe.each([
  ["create", null, "POST", "/api/v1/teams/1/capacity"],
  ["edit", PERIOD, "PUT", "/api/v1/capacity-periods/11"],
] as const)("CapacityPeriodModal: %s", (_name, target, method, url) => {
  test("a 403 reads the page's own forbidden sentence, never the server's", async () => {
    answer(403);
    const dialog = await submit(target);
    expect(await within(dialog).findByText("Only the team's manager or an administrator can change the capacity")).toBeInTheDocument();
    expect(mockFetch.mock.calls.at(-1)).toMatchObject([url, { method }]);
    expect(screen.queryByText(new RegExp(LEAK))).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a 400 reads the invalid-fields sentence, never the server's", async () => {
    answer(400);
    const dialog = await submit(target);
    expect(await within(dialog).findByText("One or more fields are invalid — check the date, the man-days and the WIP limit")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(LEAK))).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a 409 marks the DATE field with 'another period starts on this date' and keeps the dialog open", async () => {
    answer(409);
    const dialog = await submit(target);
    expect(await within(dialog).findByText("Another period starts on this date")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Effective from" })).toHaveAccessibleDescription(/Another period starts on this date/);
    expect(screen.queryByText(new RegExp(LEAK))).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a 404 (the period or team is gone) says to reload", async () => {
    answer(404);
    const dialog = await submit(target);
    expect(await within(dialog).findByText("This no longer exists — reload the page")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(LEAK))).toBeNull();
  });

  test("after a refusal the same dialog can save once the server accepts", async () => {
    answer(409);
    const dialog = await submit(target);
    await within(dialog).findByText("Another period starts on this date");
    mockFetch.mockResolvedValue(target === null ? jsonResponse(201, { ...PERIOD, id: 12 }) : new Response(null, { status: 204 }));
    await userEvent.setup().click(within(dialog).getByRole("button", { name: target === null ? "Create" : "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});
