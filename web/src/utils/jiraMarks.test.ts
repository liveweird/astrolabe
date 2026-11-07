import { describe, expect, test } from "vitest";
import { DEV_CONNECTION, endLater, item, view } from "../test/deviations";
import { EMPTY_MARKS, jiraMarksOf, markKey } from "./jiraMarks";

describe("jiraMarksOf", () => {
  test("one mark per linked node: the key, the connection's site, the deviations by severity and the server's totals", () => {
    const project = item({
      bindingId: 2,
      level: "PROJECT",
      node: { ...item().node, kind: "PROJECT", id: 7, name: "Invoices" },
      jira: { ...item().jira, key: "E2E-1" },
      deviations: [],
    });
    const milestone = item({ deviations: [endLater(3), { kind: "ESTIMATE_NOT_COMPARABLE", severity: "INFO", detail: { jira: "8", plan: "5", days: null } }] });
    const marks = jiraMarksOf(view({ items: [project, milestone] }));
    expect(marks.byNode.get(markKey("PROJECT", 7))).toMatchObject({ key: "E2E-1", siteUrl: DEV_CONNECTION.siteUrl, warnings: 0, infos: 0, gone: false });
    expect(marks.byNode.get(markKey("MILESTONE", 11))).toMatchObject({ key: "E2E-3", warnings: 1, infos: 0 });
    expect(marks.warnings).toBe(1);
    expect(marks.byNode.has(markKey("MILESTONE", 7))).toBe(false);
  });

  test("a binding whose connection is not in the connections block still gets its mark, without a site (its key then reads as plain text)", () => {
    const marks = jiraMarksOf(view({ items: [item({ connectionId: 99 })], connections: [DEV_CONNECTION] }));
    expect(marks.byNode.get(markKey("MILESTONE", 11))?.siteUrl).toBeNull();
  });

  test("only OPEN deviations are counted: a current acknowledgement keeps the mark but not its counts, a changed-since one counts again", () => {
    const ack = { at: 1, by: "Anna", current: true };
    const acknowledged = item({ bindingId: 5, acknowledgement: ack });
    const changed = item({ bindingId: 6, level: "PROJECT", node: { ...item().node, kind: "PROJECT", id: 7 }, acknowledgement: { ...ack, current: false }, deviations: [endLater(2)] });
    const marks = jiraMarksOf(view({ items: [acknowledged, changed] }));
    expect(marks.byNode.get(markKey("MILESTONE", 11))).toMatchObject({ bindingId: 5, key: "E2E-3", warnings: 0, infos: 0 });
    expect(marks.byNode.get(markKey("PROJECT", 7))).toMatchObject({ bindingId: 6, warnings: 1, infos: 0 });
  });

  test("a gone issue is marked gone", () => {
    const gone = item({ jira: { ...item().jira, gone: true } });
    expect(jiraMarksOf(view({ items: [gone] })).byNode.get(markKey("MILESTONE", 11))?.gone).toBe(true);
  });

  test("answered, the connections and 'stale' come with the marks: stale only for a connection one of the marked items uses", () => {
    const failing = { ...DEV_CONNECTION, lastRun: { ...DEV_CONNECTION.lastRun!, outcome: "FAILED" as const, errorCode: "TIMEOUT" } };
    const unrelated = { ...DEV_CONNECTION, id: 2, name: "Other", mappingOk: false };
    const fresh = jiraMarksOf(view({ items: [item()], connections: [DEV_CONNECTION, unrelated] }));
    expect(fresh).toMatchObject({ answered: true, stale: false });
    expect(fresh.connections).toHaveLength(2);
    expect(jiraMarksOf(view({ items: [item()], connections: [failing] })).stale).toBe(true);
    expect(jiraMarksOf(view({ items: [item()], connections: [{ ...DEV_CONNECTION, enabled: false }] })).stale).toBe(true);
    expect(jiraMarksOf(view({ items: [], connections: [failing] })).stale).toBe(false);
    expect(EMPTY_MARKS).toMatchObject({ answered: false, connections: null });
  });
});
