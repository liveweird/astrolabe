import { describe, expect, test } from "vitest";
import type { JiraBinding } from "../api/jira";
import type { PlanView } from "../api/plan";
import { rootOf, rootOfBinding } from "./jiraImportRoot";

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

describe("rootOfBinding", () => {
  const PLAN = {
    workStreams: [{ id: 3, programs: [{ ...NODE, id: 12, projects: [{ ...NODE, id: 20, name: "Invoices", ownerPersonId: 5, ownerName: "Piotr Project" }] }] }],
  } as unknown as PlanView;
  const row = (kind: "PROGRAM" | "PROJECT" | "MILESTONE", id: number, over: Partial<JiraBinding> = {}) =>
    ({ id: 1, issueKey: "IMC-1", node: { kind, id, name: "x" }, ...over }) as unknown as JiraBinding;

  test("a program row and a project row are looked up in the plan view and go through the page's connection", () => {
    expect(rootOfBinding(PLAN, row("PROGRAM", 12), 4)).toEqual(rootOf("PROGRAM", NODE, { issueKey: "IMC-1", connectionId: 4 }));
    const project = rootOfBinding(PLAN, row("PROJECT", 20, { issueKey: "IMC-2" }), 4);
    expect(project).toMatchObject({ level: "PROJECT", nodeId: 20, name: "Invoices", issueKey: "IMC-2", connectionId: 4, owner: { value: "5", label: "Piotr Project" } });
  });

  test("the observation's gone flag is carried, true and false alike; no observation = not known", () => {
    const observation = (gone: boolean) => ({ observedAt: 1, statusCategory: "DONE", gone }) as JiraBinding["observation"];
    expect(rootOfBinding(PLAN, row("PROGRAM", 12, { observation: observation(true) }), 4)?.gone).toBe(true);
    expect(rootOfBinding(PLAN, row("PROGRAM", 12, { observation: observation(false) }), 4)?.gone).toBe(false);
    expect(rootOfBinding(PLAN, row("PROGRAM", 12), 4)).not.toHaveProperty("gone");
  });

  test("null for a milestone row, an unread plan view and a node the plan no longer holds", () => {
    expect(rootOfBinding(PLAN, row("MILESTONE", 12), 4)).toBeNull();
    expect(rootOfBinding(undefined, row("PROGRAM", 12), 4)).toBeNull();
    expect(rootOfBinding(PLAN, row("PROGRAM", 99), 4)).toBeNull();
    expect(rootOfBinding(PLAN, row("PROJECT", 99), 4)).toBeNull();
  });
});
