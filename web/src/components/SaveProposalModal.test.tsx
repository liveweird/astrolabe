import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import SaveProposalModal from "./SaveProposalModal";
import { RUN, SAVED, SAVED_URL, STALE_REVISION, STALE_SCOPE } from "../test/crossTeamRun";
import { jsonResponse, routeFetch } from "../test/http";
import { renderWithProviders } from "../test/render";

let answer: Response;
let mockFetch: ReturnType<typeof routeFetch>;
const onClose = vi.fn();
const onSaved = vi.fn(() => Promise.resolve());
const onProposeAgain = vi.fn();

const saves = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  answer = jsonResponse(201, SAVED);
  mockFetch = routeFetch({ [`POST ${SAVED_URL}`]: () => answer });
  vi.stubGlobal("fetch", mockFetch);
  localStorage.setItem("astrolabe.auth.token", "fake-token");
  onClose.mockClear();
  onSaved.mockClear();
  onProposeAgain.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderModal = () => renderWithProviders(<SaveProposalModal run={RUN} selected={new Set([21, 11])} onClose={onClose} onSaved={onSaved} onProposeAgain={onProposeAgain} />);

describe("SaveProposalModal", () => {
  test("posts the trimmed name with the run's day, teams, revision and token and the ticks in ascending order, then reports the save", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "  Q1 plan  ");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saves()).toEqual([{ name: "Q1 plan", asOf: "2042-01-05", teamIds: [1, 2], expectedRevision: 12, scopeHash: RUN.scopeHash, selectedMilestoneIds: [11, 21] }]);
  });

  test("a blank name is refused in the form and sends nothing", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "   ");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText("Enter a name of 1 to 100 characters")).toBeInTheDocument();
    expect(saves()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  test.each([
    ["stale-scope", STALE_SCOPE],
    ["stale-revision", STALE_REVISION],
  ])("a %s 409 says the run is out of date inline and offers Propose again instead of Save", async (_name, problem) => {
    answer = jsonResponse(409, problem);
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText(/The plan changed since this proposal was computed, so it was not saved/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save proposal" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Propose again" }));
    expect(onProposeAgain).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a 403 is worded inline and the form stays open to retry", async () => {
    answer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText("Only an administrator or the manager of every team in the run can save it")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
  });

  test("a 429 is the shared wait-and-retry sentence", async () => {
    answer = jsonResponse(429, { title: "Too Many Requests", status: 429 });
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText("Too many requests. Wait a minute and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save proposal" })).toBeEnabled();
  });

  test("a 403 after the lock (a re-guard) leaves the form open and a retry that the server accepts saves", async () => {
    answer = jsonResponse(403, { title: "Forbidden", status: 403 });
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await screen.findByText("Only an administrator or the manager of every team in the run can save it");
    answer = jsonResponse(201, SAVED);
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saves()).toHaveLength(2);
  });

  test("a 400 is not blamed on a stale run: it says the proposal could not be saved as sent", async () => {
    answer = jsonResponse(400, { title: "Bad Request", status: 400, detail: "selectedMilestoneIds must name each milestone once" });
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText("The proposal could not be saved as sent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose again" })).toBeNull();
  });

  test("a control character in the name is refused in the form, in words about the name, with no request", async () => {
    const user = userEvent.setup();
    renderModal();
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.click(name);
    await user.paste("Q1\tplan");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    expect(await screen.findByText("The name must not contain control characters")).toBeInTheDocument();
    expect(saves()).toEqual([]);
  });

  test("after a refused save the focus moves to Propose again", async () => {
    answer = jsonResponse(409, STALE_SCOPE);
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose again" })).toHaveFocus());
  });

  test("the dialog cannot be closed while the save is on its way (Escape and the X do nothing), and closes again once it is answered", async () => {
    let release!: (response: Response) => void;
    mockFetch = routeFetch({ [`POST ${SAVED_URL}`]: () => new Promise<Response>((resolve) => (release = resolve)) });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Q1");
    await user.click(screen.getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await act(async () => {
      release(jsonResponse(201, SAVED));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  test("Cancel closes without a request", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saves()).toEqual([]);
  });
});
