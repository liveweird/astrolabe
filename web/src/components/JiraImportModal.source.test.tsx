import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import JiraImportModal from "./JiraImportModal";
import { jsonResponse } from "../test/http";
import { fillScope, installImportApi } from "../test/jiraImportHarness";
import { PREVIEW_ITEMS, previewOf } from "../test/jiraImport";
import { renderWithProviders } from "../test/render";
import type { ImportConnection, ImportSource } from "../utils/jiraImport";

const ACME: ImportConnection = { id: 1, name: "Acme Jira", siteUrl: "https://acme.atlassian.net", projectKeys: ["E2E", "PF"] };
const BETA: ImportConnection = { id: 2, name: "Beta Jira", siteUrl: "https://beta.atlassian.net", projectKeys: ["IMP"] };

let api: ReturnType<typeof installImportApi>;

beforeEach(() => {
  api = installImportApi({ preview: () => jsonResponse(200, previewOf(PREVIEW_ITEMS)) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function open(source: Partial<ImportSource>, initialWorkStreamId?: number) {
  const whole: ImportSource = { connections: null, failed: false, retry: () => undefined, ...source };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithProviders(<JiraImportModal source={whole} initialWorkStreamId={initialWorkStreamId} onClose={vi.fn()} />, { queryClient });
}

const preview = () => screen.getByRole("button", { name: "Preview" });
const keyPills = () => Array.from(document.querySelectorAll(".mantine-MultiSelect-pill")).map((pill) => pill.textContent);
const connectionField = () => screen.getByRole("combobox", { name: /^Jira connection/ });

describe("JiraImportModal: where the connection comes from", () => {
  test("several connections: a Select picks one, Preview waits for it, and the Jira projects follow the pick", async () => {
    const user = userEvent.setup();
    open({ connections: [BETA, ACME] });
    expect(connectionField()).toHaveValue("");
    await fillScope(user);
    expect(preview()).toBeDisabled();
    await user.click(connectionField());
    await user.click(await screen.findByRole("option", { name: "Beta Jira" }));
    expect(keyPills()).toEqual(["IMP"]);
    await user.click(connectionField());
    await user.click(await screen.findByRole("option", { name: "Acme Jira" }));
    expect(keyPills()).toEqual(["E2E", "PF"]);
    expect(preview()).toBeEnabled();
    await user.click(preview());
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: { excludeDone: true, updatedWithinDays: 365 } }]);
  });

  test("several connections and none picked: the field says to choose one", () => {
    open({ connections: [BETA, ACME] });
    expect(screen.getByText("Choose a connection to link through.")).toBeInTheDocument();
  });

  test("a picked connection that leaves the list is forgotten: the only one left is picked again, several wait for a new pick", async () => {
    const user = userEvent.setup();
    const THIRD: ImportConnection = { id: 3, name: "Third Jira", siteUrl: "https://third.atlassian.net", projectKeys: ["OUT"] };
    const view = open({ connections: [BETA, ACME, THIRD] });
    await user.click(connectionField());
    await user.click(await screen.findByRole("option", { name: "Beta Jira" }));
    expect(keyPills()).toEqual(["IMP"]);
    const rerenderWith = (list: ImportConnection[]) =>
      view.rerender(<JiraImportModal source={{ connections: list, failed: false, retry: () => undefined }} onClose={vi.fn()} />);
    rerenderWith([ACME, THIRD]);
    expect(connectionField()).toHaveValue("");
    expect(screen.getByText("Choose a connection to link through.")).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    rerenderWith([ACME]);
    await waitFor(() => expect(connectionField()).toHaveValue("Acme Jira"));
    expect(keyPills()).toEqual(["E2E", "PF"]);
    expect(screen.queryByText("Choose a connection to link through.")).not.toBeInTheDocument();
  });

  test("one connection: preselected (the bind dialog's read-only idiom), its keys ticked", () => {
    open({ connections: [ACME] });
    expect(connectionField()).toHaveValue("Acme Jira");
    expect(keyPills()).toEqual(["E2E", "PF"]);
  });

  test("a connection list that arrives after the dialog opened preselects it and fills the keys", async () => {
    const view = open({ connections: null });
    expect(screen.getByText("Loading the Jira connections…")).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    view.rerender(<JiraImportModal source={{ connections: [ACME], failed: false, retry: () => undefined }} onClose={vi.fn()} />);
    await waitFor(() => expect(connectionField()).toHaveValue("Acme Jira"));
    expect(keyPills()).toEqual(["E2E", "PF"]);
  });

  test("none usable: the note, and Preview stays disabled", async () => {
    const user = userEvent.setup();
    open({ connections: [] });
    expect(screen.getByText("No Jira connection can import right now: an administrator has to add, enable and test one.")).toBeInTheDocument();
    await fillScope(user);
    expect(preview()).toBeDisabled();
  });

  test("a failed load: the alert and a Retry that calls the source's retry", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    open({ failed: true, retry });
    expect(screen.getByText("Could not load the Jira connections")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(preview()).toBeDisabled();
  });

  test("a preset work stream is shown read-only and goes into the preview", async () => {
    const user = userEvent.setup();
    open({ connections: [ACME] }, 3);
    const stream = screen.getByRole("combobox", { name: /^Work stream/ });
    await waitFor(() => expect(stream).toHaveValue("Platform"));
    expect(stream).toHaveAttribute("readonly");
    expect(preview()).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Owner of the new items" }));
    await user.click(await screen.findByRole("option", { name: "Ola Owner" }));
    await user.click(preview());
    await screen.findByRole("heading", { level: 3, name: "What the import would do" });
    expect(api.previews()).toEqual([{ workStreamId: 3, ownerPersonId: 8, copyDates: true, filter: { excludeDone: true, updatedWithinDays: 365 } }]);
  });
});
