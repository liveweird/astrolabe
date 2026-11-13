import { describe, expect, test } from "vitest";
import { rootOf } from "./jiraImportRoot";

const NODE = { id: 12, name: "Billing", workStreamId: 3, ownerPersonId: 6, ownerName: "Pola Program" };

describe("rootOf", () => {
  test("a program's root carries the node, its link and the node's own owner as an option", () => {
    expect(rootOf("PROGRAM", NODE, { issueKey: "IMC-1", connectionId: 4 })).toEqual({
      level: "PROGRAM",
      nodeId: 12,
      name: "Billing",
      issueKey: "IMC-1",
      connectionId: 4,
      workStreamId: 3,
      owner: { value: "6", label: "Pola Program" },
    });
  });

  test("a project's root has the PROJECT level", () => {
    expect(rootOf("PROJECT", NODE, { issueKey: "IMC-2", connectionId: 4 }).level).toBe("PROJECT");
  });

  test("gone is carried only when the link says so (absent = not known), true and false alike", () => {
    expect(rootOf("PROJECT", NODE, { issueKey: "IMC-2", connectionId: 4 })).not.toHaveProperty("gone");
    expect(rootOf("PROJECT", NODE, { issueKey: "IMC-2", connectionId: 4, gone: true }).gone).toBe(true);
    expect(rootOf("PROJECT", NODE, { issueKey: "IMC-2", connectionId: 4, gone: false }).gone).toBe(false);
  });
});
