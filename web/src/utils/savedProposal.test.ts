import { describe, expect, test } from "vitest";
import { sameIds, sameRun, storedCheckState, withoutProposal, withProposal } from "./savedProposal";
import { SAVED_RECORD } from "../test/crossTeamRun";

describe("sameRun", () => {
  const run = { asOf: "2042-01-05", revision: 12, scopeHash: "a" };

  test("the day, the revision and the token all have to match", () => {
    expect(sameRun(run, { ...run })).toBe(true);
    expect(sameRun(run, { ...run, asOf: "2042-01-06" })).toBe(false);
    expect(sameRun(run, { ...run, revision: 13 })).toBe(false);
    expect(sameRun(run, { ...run, scopeHash: "b" })).toBe(false);
  });
});

describe("sameIds", () => {
  test("the same set whatever the order; a missing or extra id is a difference", () => {
    expect(sameIds(new Set([2, 1]), [1, 2])).toBe(true);
    expect(sameIds(new Set([1]), [1, 2])).toBe(false);
    expect(sameIds(new Set([1, 2, 3]), [1, 2])).toBe(false);
    expect(sameIds(new Set([1, 3]), [1, 2])).toBe(false);
  });
});

describe("storedCheckState", () => {
  test("a subset is the stored check, answered: the verdicts by team, never pending or failed", () => {
    const state = storedCheckState(SAVED_RECORD);
    expect(state).toMatchObject({ mode: "some", pending: false, failed: false });
    expect([...(state.byTeam?.keys() ?? [])]).toEqual([1, 2]);
  });

  test("every move ticked is the run's own verdicts: mode all and no check", () => {
    expect(storedCheckState({ ...SAVED_RECORD, selectedMilestoneIds: [11, 12, 21], check: null })).toEqual({ mode: "all", byTeam: null, pending: false, failed: false });
  });

  test("a subset whose check is missing shows the run's own verdicts (no map) rather than inventing one", () => {
    expect(storedCheckState({ ...SAVED_RECORD, check: null })).toMatchObject({ mode: "some", byTeam: null });
  });
});

describe("the proposal parameter", () => {
  test("is set beside every other parameter, replaced when there already, and taken out again", () => {
    const current = new URLSearchParams("mode=overview&programId=3&programId=4");
    expect(withProposal(current, 5).toString()).toBe("mode=overview&programId=3&programId=4&proposal=5");
    expect(withProposal(withProposal(current, 5), 6).toString()).toBe("mode=overview&programId=3&programId=4&proposal=6");
    expect(withoutProposal(withProposal(current, 5)).toString()).toBe(current.toString());
  });
});
