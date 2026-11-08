import { describe, expect, test } from "vitest";
import { flowBaseHref, flowConnectionPath, flowConnectionsPath } from "./flowLinks";

describe("flowLinks", () => {
  test("the route family is spelled in one place", () => {
    expect(flowConnectionsPath).toBe("/integrations/flow");
    expect(flowConnectionPath(7)).toBe("/integrations/flow/7");
  });

  test("a Flow address becomes a link only for http and https, without a trailing slash", () => {
    expect(flowBaseHref("https://flow.example.com/")).toBe("https://flow.example.com");
    expect(flowBaseHref("http://flow-stub:8080")).toBe("http://flow-stub:8080");
    expect(flowBaseHref("javascript:alert(1)")).toBeUndefined();
    expect(flowBaseHref("")).toBeUndefined();
    expect(flowBaseHref(null)).toBeUndefined();
  });
});
