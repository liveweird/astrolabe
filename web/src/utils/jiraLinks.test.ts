import { describe, expect, test } from "vitest";
import { jiraBrowseUrl, jiraConnectionPath, jiraConnectionsPath } from "./jiraLinks";

describe("jiraLinks", () => {
  test("the route family is spelled out once", () => {
    expect(jiraConnectionsPath).toBe("/integrations/jira");
    expect(jiraConnectionPath(4)).toBe("/integrations/jira/4");
  });

  test("a browse URL joins the site and the encoded key, tolerating a trailing slash", () => {
    expect(jiraBrowseUrl("https://acme.atlassian.net", "ABC-12")).toBe("https://acme.atlassian.net/browse/ABC-12");
    expect(jiraBrowseUrl("https://acme.atlassian.net/", "ABC-12")).toBe("https://acme.atlassian.net/browse/ABC-12");
  });

  test("a site that is not https (or unknown) yields no link: never a javascript: or http: href", () => {
    expect(jiraBrowseUrl("javascript:alert(1)", "ABC-1")).toBeUndefined();
    expect(jiraBrowseUrl("http://acme.atlassian.net", "ABC-1")).toBeUndefined();
    expect(jiraBrowseUrl(undefined, "ABC-1")).toBeUndefined();
    expect(jiraBrowseUrl(null, "ABC-1")).toBeUndefined();
    expect(jiraBrowseUrl("  ", "ABC-1")).toBeUndefined();
  });
});
