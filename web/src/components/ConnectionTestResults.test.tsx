import { describe, expect, test } from "vitest";
import { renderWithProviders, screen, within } from "../test/render";
import { FAILING_TEST, PASSING_TEST } from "../test/jira";
import ConnectionTestResults from "./ConnectionTestResults";

describe("ConnectionTestResults", () => {
  test("a passing set is one green OK row per probe, with the cloud id and no note", () => {
    renderWithProviders(<ConnectionTestResults result={PASSING_TEST} />);
    const table = screen.getByRole("table", { name: "Connection test results" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    rows.forEach((row) => expect(within(row).getByText("OK")).toBeInTheDocument());
    expect(within(table).getByText("project:E2E")).toBeInTheDocument();
    expect(screen.getByText("Cloud id: 8a1a2b3c-0000-4000-8000-000000000001")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("a failed row shows the status, the failure in words with its code, and the scope the probe needs", () => {
    renderWithProviders(<ConnectionTestResults result={FAILING_TEST} />);
    const search = screen.getByText("search").closest("tr")!;
    expect(within(search).getByText("Failed")).toBeInTheDocument();
    expect(within(search).getByText("401 · Jira refused the credentials (AUTHENTICATION_FAILED) · needs scope: read:jql:jira")).toBeInTheDocument();
    const issue = screen.getByText("issue").closest("tr")!;
    expect(within(issue).getByText("Optional")).toBeInTheDocument();
    expect(within(issue).getByText(/read:issue-details:jira/)).toBeInTheDocument();
  });

  test("a 401 on one probe while myself passes explains the missing scope", () => {
    renderWithProviders(<ConnectionTestResults result={FAILING_TEST} />);
    expect(screen.getByRole("note")).toHaveTextContent(/missing that probe's scope, not that the credentials are wrong/);
  });

  test("no scope note when myself fails too (the credentials are the problem)", () => {
    const rows = FAILING_TEST.rows.map((row) => (row.name === "myself" ? { ...row, ok: false, status: 401, code: "AUTHENTICATION_FAILED" } : row));
    renderWithProviders(<ConnectionTestResults result={{ ...FAILING_TEST, rows }} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("a stored token that cannot be decrypted reads in words", () => {
    const rows = [{ name: "stored_token", path: "stored API token", required: true, ok: false, code: "TOKEN_UNREADABLE" }];
    renderWithProviders(<ConnectionTestResults result={{ rows, recorded: true }} />);
    expect(screen.getByText("The stored token cannot be decrypted; enter it again (TOKEN_UNREADABLE)")).toBeInTheDocument();
  });

  test("rows skipped after a failed tenant_info read Skipped, not Failed, with a plain reason", () => {
    const rows = [
      { name: "tenant_info", path: "/_edge/tenant_info", required: true, ok: false, status: 404, code: "NOT_FOUND" },
      { name: "myself", path: "/rest/api/3/myself", required: true, ok: false, code: "SKIPPED" },
      { name: "field", path: "/rest/api/3/field", required: true, ok: false, code: "SKIPPED" },
    ];
    renderWithProviders(<ConnectionTestResults result={{ rows, recorded: true }} />);
    const myself = screen.getByText("myself").closest("tr")!;
    expect(within(myself).getByText("Skipped")).toBeInTheDocument();
    expect(within(myself).queryByText("Failed")).not.toBeInTheDocument();
    expect(within(myself).getByText("Not run: an earlier probe failed")).toBeInTheDocument();
    expect(within(screen.getByText("tenant_info").closest("tr")!).getByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getAllByText("Skipped")).toHaveLength(2);
  });
});
