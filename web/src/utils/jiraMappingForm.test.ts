import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { DEFAULT_MAPPING, DISCOVERY } from "../test/jira";
import { fieldOptions, fromMapping, levelOptions, mappingFormValidation, toMapping } from "./jiraMappingForm";

const t = i18n.t.bind(i18n);

describe("fromMapping / toMapping", () => {
  test("round-trips a mapping and leaves the optional levels null", () => {
    const form = fromMapping({ ...DEFAULT_MAPPING, levels: { milestone: DEFAULT_MAPPING.levels.milestone, program: null, project: null } });
    expect(form.levels.program.hierarchyLevel).toBeNull();
    expect(form.levels.milestone.hierarchyLevel).toBe("1");
    expect(toMapping(form)).toEqual({
      levels: {
        program: null,
        project: null,
        milestone: { hierarchyLevel: 1, fields: { start: "customfield_10020", end: "customfield_10021", estimate: "customfield_10028" } },
      },
      estimate: { unit: "POINTS", manDaysPerUnit: null },
      teamFieldId: "customfield_10001",
    });
  });

  test("the factor travels as a number for POINTS/HOURS and is dropped for DAYS", () => {
    const base = fromMapping(DEFAULT_MAPPING);
    expect(toMapping({ ...base, unit: "HOURS", manDaysPerUnit: "0.125" }).estimate?.manDaysPerUnit).toBe(0.125);
    expect(toMapping({ ...base, unit: "DAYS", manDaysPerUnit: "2" }).estimate).toEqual({ unit: "DAYS", manDaysPerUnit: null });
    expect(toMapping({ ...base, manDaysPerUnit: " " }).estimate?.manDaysPerUnit).toBeNull();
  });

  test("no mapping opens an empty form", () => {
    const form = fromMapping(null);
    expect(form.levels.milestone.hierarchyLevel).toBeNull();
    expect(() => toMapping(form)).toThrow();
  });
});

describe("mappingFormValidation", () => {
  const rules = mappingFormValidation(t);
  const form = fromMapping(DEFAULT_MAPPING);

  test("the milestone level is required", () => {
    expect(rules["levels.milestone.hierarchyLevel"](null)).not.toBeNull();
    expect(rules["levels.milestone.hierarchyLevel"]("1")).toBeNull();
  });

  test("levels strictly decrease program > project > milestone; a skipped level is fine", () => {
    expect(rules["levels.project.hierarchyLevel"]("2", form)).toBeNull();
    expect(rules["levels.program.hierarchyLevel"]("3", form)).toBeNull();
    const flat = { ...form, levels: { ...form.levels, project: { ...form.levels.project, hierarchyLevel: "1" } } };
    expect(rules["levels.project.hierarchyLevel"]("1", flat)).not.toBeNull();
    const skipped = { ...form, levels: { ...form.levels, project: { ...form.levels.project, hierarchyLevel: null } } };
    expect(rules["levels.program.hierarchyLevel"]("3", skipped)).toBeNull();
    const inverted = { ...form, levels: { ...form.levels, program: { ...form.levels.program, hierarchyLevel: "1" } } };
    expect(rules["levels.program.hierarchyLevel"]("1", inverted)).not.toBeNull();
  });

  test("the factor is > 0, <= 1000, two decimals; empty and DAYS skip it", () => {
    const points = { ...form, unit: "POINTS" as const };
    expect(rules.manDaysPerUnit("0.5", points)).toBeNull();
    expect(rules.manDaysPerUnit("", points)).toBeNull();
    expect(rules.manDaysPerUnit("0", points)).not.toBeNull();
    expect(rules.manDaysPerUnit("1000.01", points)).not.toBeNull();
    expect(rules.manDaysPerUnit("0.125", points)).not.toBeNull();
    expect(rules.manDaysPerUnit("abc", points)).not.toBeNull();
    expect(rules.manDaysPerUnit("0", { ...form, unit: "DAYS" })).toBeNull();
  });
});

describe("levelOptions", () => {
  test("labels the site's levels top-down with their type names - the default is marked by the editor, never in the label", () => {
    expect(levelOptions(DISCOVERY, "1", t).map((o) => o.label)).toEqual([
      "Level 3 — Program",
      "Level 2 — Initiative",
      "Level 1 — Epic",
      "Level 0 — Story",
    ]);
  });

  test("keeps a stored level the site lacks, flagged, so it can still be displayed and fixed", () => {
    expect(levelOptions(DISCOVERY, "5", t).at(-1)).toEqual({ value: "5", label: "Level 5 (not on this site)" });
  });
});

describe("fieldOptions", () => {
  test("filters by type: date fields for start/end, number for the estimate, the atlassian-team field for the team", () => {
    // Sorted by name: Due date, Start date, Target end, Target start.
    expect(fieldOptions(DISCOVERY, "date", null, t).map((o) => o.value)).toEqual(["duedate", "customfield_10015", "customfield_10021", "customfield_10020"]);
    expect(fieldOptions(DISCOVERY, "number", null, t).map((o) => o.value)).toEqual(["customfield_10028", "customfield_10030"]);
    expect(fieldOptions(DISCOVERY, "team", null, t).map((o) => o.value)).toEqual(["customfield_10001"]);
  });

  test("a label is name and id only, so a closed select shows no (default) suffix that a narrow column could cut off", () => {
    const labels = fieldOptions(DISCOVERY, "date", "customfield_10020", t).map((o) => o.label);
    expect(labels).toContain("Target start — customfield_10020");
    expect(labels.some((label) => label.includes("default"))).toBe(false);
  });

  test("a stored field of the wrong type or missing from the site stays selectable, flagged", () => {
    const wrongType = fieldOptions(DISCOVERY, "date", "customfield_10028", t).at(-1);
    expect(wrongType).toEqual({ value: "customfield_10028", label: "Story point estimate — customfield_10028 (a number field, not valid here)" });
    expect(fieldOptions(DISCOVERY, "date", "customfield_99999", t).at(-1)?.label).toBe("customfield_99999 (not found on this site)");
  });
});
