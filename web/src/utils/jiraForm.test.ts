import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { CONNECTION } from "../test/jira";
import { DEFAULT_POLL_INTERVAL_MINUTES, EMPTY_JIRA_FORM, fromJiraConnection, ISSUE_KEY_PATTERN, jiraFormValidation, probeSettingsDiffer, toJiraConnectionRequest, untestedKey } from "./jiraForm";

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

  test("the polling interval is a whole number of minutes from 5 to 1440; with Manual only the number is not looked at", () => {
    const rule = create.pollIntervalMinutes;
    const polling = { ...EMPTY_JIRA_FORM, manualOnly: false };
    for (const good of [5, 15, 1440, "30"]) expect(rule(good, polling), String(good)).toBeNull();
    for (const bad of [4, 0, -5, 1441, 7.5, "", "  ", "abc"]) expect(rule(bad, polling), String(bad)).not.toBeNull();
    expect(rule("", { ...polling, manualOnly: true })).toBeNull();
    expect(rule(4, { ...polling, manualOnly: true })).toBeNull();
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
      pollIntervalMinutes: 15,
    });
    expect(toJiraConnectionRequest({ ...base, apiToken: "  secret  ", authScheme: "BEARER", enabled: false })).toMatchObject({ apiToken: "secret", authScheme: "BEARER", enabled: false });
  });

  test("pollIntervalMinutes ALWAYS travels (a PUT is a full replace and an omitted member resets the server to 15): the number, or an explicit null", () => {
    const polling = toJiraConnectionRequest({ ...EMPTY_JIRA_FORM, pollIntervalMinutes: 45 });
    expect(polling.pollIntervalMinutes).toBe(45);
    const manual = toJiraConnectionRequest({ ...EMPTY_JIRA_FORM, manualOnly: true });
    expect(manual).toHaveProperty("pollIntervalMinutes", null);
    expect(JSON.stringify(manual)).toContain('"pollIntervalMinutes":null');
    // A typed string is turned into the number; a value the form refuses (the probe sends the body unvalidated) falls back to the default, never undefined.
    expect(toJiraConnectionRequest({ ...EMPTY_JIRA_FORM, pollIntervalMinutes: "20" }).pollIntervalMinutes).toBe(20);
    for (const refused of ["", 4, 1441, "abc"]) {
      expect(toJiraConnectionRequest({ ...EMPTY_JIRA_FORM, pollIntervalMinutes: refused }).pollIntervalMinutes, String(refused)).toBe(DEFAULT_POLL_INTERVAL_MINUTES);
    }
  });

  test("a manual-only connection round-tripped through an edit (a rename) is still manual only, and the body is exactly the stored settings", () => {
    const stored = { ...CONNECTION, pollIntervalMinutes: null };
    const values = fromJiraConnection(stored);
    expect(values).toMatchObject({ manualOnly: true, pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES });
    expect(JSON.parse(JSON.stringify(toJiraConnectionRequest({ ...values, name: "Renamed" })))).toEqual({
      name: "Renamed",
      siteUrl: "https://acme.atlassian.net",
      email: "robot@acme.example",
      authScheme: "BASIC",
      projectKeys: ["E2E", "PF"],
      enabled: true,
      pollIntervalMinutes: null,
    });
    // A polling connection keeps its own number.
    expect(toJiraConnectionRequest(fromJiraConnection({ ...CONNECTION, pollIntervalMinutes: 45 })).pollIntervalMinutes).toBe(45);
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
