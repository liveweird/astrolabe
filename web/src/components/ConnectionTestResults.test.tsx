import { describe, expect, test } from "vitest";
import { renderWithProviders, screen, within } from "../test/render";
import { FAILING_TEST, PASSING_TEST } from "../test/jira";
import { PASSING_TEST as FLOW_PASSING, REVOKED_TEST } from "../test/flow";
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

  test("a stub-answered Jira result says so in a gray note; a genuine one and a Flow result do not", () => {
    const { unmount } = renderWithProviders(<ConnectionTestResults result={{ ...PASSING_TEST, stub: true }} />);
    expect(screen.getByRole("note")).toHaveTextContent(/answered by the built-in development Jira stub, not by Atlassian/);
    unmount();
    const genuine = renderWithProviders(<ConnectionTestResults result={PASSING_TEST} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    genuine.unmount();
    renderWithProviders(<ConnectionTestResults result={FLOW_PASSING} kind="FLOW" />);
    expect(screen.queryByText(/development Jira stub/)).not.toBeInTheDocument();
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
    renderWithProviders(<ConnectionTestResults result={{ rows, recorded: true, stub: false }} />);
    expect(screen.getByText("The stored token cannot be decrypted; enter it again (TOKEN_UNREADABLE)")).toBeInTheDocument();
  });

  test("rows skipped after a failed tenant_info read Skipped, not Failed, with a plain reason", () => {
    const rows = [
      { name: "tenant_info", path: "/_edge/tenant_info", required: true, ok: false, status: 404, code: "NOT_FOUND" },
      { name: "myself", path: "/rest/api/3/myself", required: true, ok: false, code: "SKIPPED" },
      { name: "field", path: "/rest/api/3/field", required: true, ok: false, code: "SKIPPED" },
    ];
    renderWithProviders(<ConnectionTestResults result={{ rows, recorded: true, stub: false }} />);
    const myself = screen.getByText("myself").closest("tr")!;
    expect(within(myself).getByText("Skipped")).toBeInTheDocument();
    expect(within(myself).queryByText("Failed")).not.toBeInTheDocument();
    expect(within(myself).getByText("Not run: an earlier probe failed")).toBeInTheDocument();
    expect(within(screen.getByText("tenant_info").closest("tr")!).getByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getAllByText("Skipped")).toHaveLength(2);
  });

  describe("a Flow result", () => {
    test("the probes are worded, the document's size is told, and there is no Jira scope note or cloud id", () => {
      renderWithProviders(<ConnectionTestResults result={FLOW_PASSING} kind="FLOW" />);
      const table = screen.getByRole("table", { name: "Connection test results" });
      expect(within(table).getByText("Service token")).toBeInTheDocument();
      expect(within(table).getByText("Teams document")).toBeInTheDocument();
      expect(within(table).getByText("/api/v1/integration/me")).toBeInTheDocument();
      expect(within(table).getAllByText("OK")).toHaveLength(2);
      expect(screen.getByText("Flow's document · teams: 18 · sprints: 640")).toBeInTheDocument();
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
      expect(screen.queryByText(/Cloud id/)).not.toBeInTheDocument();
    });

    test("a revoked token reads in Flow's words next to a Skipped teams row, and a 401 never says 'missing scope'", () => {
      renderWithProviders(<ConnectionTestResults result={REVOKED_TEST} kind="FLOW" />);
      const me = screen.getByText("Service token").closest("tr")!;
      expect(within(me).getByText("Failed")).toBeInTheDocument();
      expect(
        within(me).getByText("401 · Flow rejected the token: it was revoked or expired - issue a new one in Flow and update the connection (AUTHENTICATION_FAILED)"),
      ).toBeInTheDocument();
      // The version hint belongs to a 404 alone, and is that sentence's own words: a Flow row never repeats it as a hint.
      expect(within(me).queryByText(/1\.57/)).not.toBeInTheDocument();
      const teams = screen.getByText("Teams document").closest("tr")!;
      expect(within(teams).getByText("Skipped")).toBeInTheDocument();
      expect(within(teams).getByText("Not run: an earlier probe failed")).toBeInTheDocument();
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
      expect(screen.queryByText(/Flow's document:/)).not.toBeInTheDocument();
    });

    test("a 404 says Flow 1.57.0 once, in the code's sentence, not again as a hint", () => {
      const rows = [{ name: "me", path: "/api/v1/integration/me", required: true, ok: false, status: 404, code: "NOT_FOUND", scopeHint: "Flow 1.57.0 or later" }];
      renderWithProviders(<ConnectionTestResults result={{ ...FLOW_PASSING, rows }} kind="FLOW" />);
      const text = screen.getByText(/^404 · /).textContent!;
      expect(text).toBe("404 · Flow does not serve this endpoint; it needs Flow 1.57.0 or later (NOT_FOUND)");
    });

    test("a truncated document is an orange note; an unknown probe name reads as itself", () => {
      const rows = [...FLOW_PASSING.rows, { name: "extra", path: "/x", required: false, ok: true }];
      renderWithProviders(<ConnectionTestResults result={{ ...FLOW_PASSING, rows, truncated: true }} kind="FLOW" />);
      expect(screen.getByRole("note")).toHaveTextContent(/Flow cut its document at its limits/);
      expect(screen.getByText("extra")).toBeInTheDocument();
    });
  });
});
