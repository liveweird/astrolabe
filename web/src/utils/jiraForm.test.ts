import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { CONNECTION } from "../test/jira";
import { EMPTY_JIRA_FORM, fromJiraConnection, ISSUE_KEY_PATTERN, jiraFormValidation, probeSettingsDiffer, toJiraConnectionRequest, untestedKey } from "./jiraForm";

const t = i18n.t.bind(i18n);
const create = jiraFormValidation(t, false);
const edit = jiraFormValidation(t, true);

describe("jiraFormValidation (mirrors JiraConnection.kt)", () => {
  test("the site is exactly https://<tenant>.atlassian.net", () => {
    expect(create.siteUrl("https://acme.atlassian.net")).toBeNull();
    for (const bad of ["acme.atlassian.net", "http://acme.atlassian.net", "https://acme.atlassian.net/", "https://acme.atlassian.net/jira", "https://acme.atlassian.net:443", "https://api.atlassian.net", "https://acme.example.com", ""]) {
      expect(create.siteUrl(bad), bad).not.toBeNull();
    }
  });

  test("the token is required on create and optional on edit (blank keeps it)", () => {
    expect(create.apiToken("   ")).not.toBeNull();
    expect(edit.apiToken("")).toBeNull();
    expect(create.apiToken("x".repeat(1000))).toBeNull();
    expect(edit.apiToken("x".repeat(1001))).not.toBeNull();
  });

  test("project keys: 1 to 50, the Jira key shape, no duplicates", () => {
    expect(create.projectKeys([])).not.toBeNull();
    expect(create.projectKeys(["E2E", "PF"])).toBeNull();
    expect(create.projectKeys(["e2e"])).not.toBeNull();
    expect(create.projectKeys(["A"])).not.toBeNull();
    expect(create.projectKeys(["PF", "PF"])).not.toBeNull();
    expect(create.projectKeys(Array.from({ length: 51 }, (_, i) => `K${String(i).padStart(2, "0")}`))).not.toBeNull();
  });

  test("name 1..100 characters, email needs an @", () => {
    expect(create.name("  ")).not.toBeNull();
    expect(create.name("x".repeat(101))).not.toBeNull();
    expect(create.name("Acme")).toBeNull();
    expect(create.email("nobody")).not.toBeNull();
    expect(create.email("robot@acme.example")).toBeNull();
  });
});

describe("the wire body", () => {
  test("a blank token is omitted, a typed one is trimmed and sent; authScheme and enabled always travel", () => {
    const base = { ...fromJiraConnection(CONNECTION), apiToken: "" };
    expect(toJiraConnectionRequest(base)).toEqual({
      name: "Acme Jira",
      siteUrl: "https://acme.atlassian.net",
      email: "robot@acme.example",
      apiToken: undefined,
      authScheme: "BASIC",
      projectKeys: ["E2E", "PF"],
      enabled: true,
    });
    expect(toJiraConnectionRequest({ ...base, apiToken: "  secret  ", authScheme: "BEARER", enabled: false })).toMatchObject({ apiToken: "secret", authScheme: "BEARER", enabled: false });
  });

  test("the stored token is never copied into the edit form", () => {
    expect(fromJiraConnection(CONNECTION).apiToken).toBe("");
    expect(EMPTY_JIRA_FORM.apiToken).toBe("");
  });
});

describe("ISSUE_KEY_PATTERN", () => {
  test("matches ABC-12 style keys only", () => {
    expect(ISSUE_KEY_PATTERN.test("E2E-1")).toBe(true);
    expect(ISSUE_KEY_PATTERN.test("e2e-1")).toBe(false);
    expect(ISSUE_KEY_PATTERN.test("E2E1")).toBe(false);
    expect(ISSUE_KEY_PATTERN.test("E2E-1 ")).toBe(false);
  });
});

describe("probeSettingsDiffer (what the server's last-test invalidation also watches)", () => {
  const same = fromJiraConnection(CONNECTION);

  test("the saved form differs from nothing", () => {
    expect(probeSettingsDiffer(same, CONNECTION)).toBe(false);
  });

  test("the account, the scheme and the keys count; the name, the flag and key case or padding do not", () => {
    expect(probeSettingsDiffer({ ...same, email: "other@acme.example" }, CONNECTION)).toBe(true);
    expect(probeSettingsDiffer({ ...same, authScheme: "BEARER" }, CONNECTION)).toBe(true);
    expect(probeSettingsDiffer({ ...same, projectKeys: ["E2E"] }, CONNECTION)).toBe(true);
    expect(probeSettingsDiffer({ ...same, projectKeys: ["PF", "E2E"] }, CONNECTION)).toBe(true);
    expect(probeSettingsDiffer({ ...same, name: "Renamed", enabled: false }, CONNECTION)).toBe(false);
    expect(probeSettingsDiffer({ ...same, email: " Robot@ACME.example ", projectKeys: ["e2e", " pf "] }, CONNECTION)).toBe(false);
  });
});

describe("untestedKey", () => {
  test("never tested, or - with an earlier discovery - cleared by the last change", () => {
    expect(untestedKey({ discoveredAt: null })).toBe("jira.details.neverTested");
    expect(untestedKey({ discoveredAt: 1 })).toBe("jira.details.testedBefore");
  });
});
