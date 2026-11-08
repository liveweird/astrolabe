import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import ConnectionTestStatus from "./ConnectionTestStatus";

describe("ConnectionTestStatus", () => {
  test("skipped rows are not counted as failed required probes: only the failed tenant_info is", () => {
    const rows = [
      { name: "tenant_info", path: "/_edge/tenant_info", required: true, ok: false, status: 404, code: "NOT_FOUND" },
      { name: "myself", path: "/rest/api/3/myself", required: true, ok: false, code: "SKIPPED" },
      { name: "issuetype", path: "/rest/api/3/issuetype", required: true, ok: false, code: "SKIPPED" },
    ];
    renderWithProviders(<ConnectionTestStatus result={{ rows, recorded: true, stub: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Test failed. Required probes that failed: 1 of 3.");
  });

  test("a payload of skipped rows alone is never read as a pass", () => {
    const rows = [
      { name: "myself", path: "/rest/api/3/myself", required: true, ok: false, code: "SKIPPED" },
      { name: "field", path: "/rest/api/3/field", required: true, ok: false, code: "SKIPPED" },
    ];
    renderWithProviders(<ConnectionTestStatus result={{ rows, recorded: true, stub: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Test failed. Required probes that failed: 2 of 2.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Test passed");
  });
});
