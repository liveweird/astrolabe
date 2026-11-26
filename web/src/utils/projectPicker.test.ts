import { describe, expect, test } from "vitest";
import type { ComboboxItem, ComboboxItemGroup, ComboboxParsedItem } from "@mantine/core";
import { planOf } from "../test/planView";
import { projectOptionsFilter, projectPickerOptions, type ProjectPickerItem } from "./projectPicker";

const PLAN = planOf([
  {
    id: 2,
    name: "Platform",
    ownerName: "Stefan Stream",
    programs: [
      { id: 21, name: "Billing", projects: [{ id: 213, name: "Reports", ownerName: "Żaneta Żółw" }, { id: 211, name: "Invoices", ownerName: "Ola Owner" }] },
      { id: 20, name: "Access", projects: [{ id: 201, name: "Login", ownerName: "Piotr Project" }] },
      { id: 22, name: "Empty program" },
    ],
  },
  { id: 1, name: "Legacy", endDate: "2026-06-30", programs: [{ id: 11, name: "Archive", projects: [{ id: 111, name: "Migration", ownerName: "Ola Owner" }] }] },
  { id: 3, name: "Growth", programs: [{ id: 31, name: "Acquisition", projects: [{ id: 311, name: "Funnel", ownerName: "Fiona Funnel" }] }] },
]);

const groupsOf = (options: ReturnType<typeof projectPickerOptions>) => options as ComboboxItemGroup<ProjectPickerItem>[];
const labels = (options: ComboboxParsedItem[]) => options.map((o) => ("group" in o ? [String(o.group), o.items.map((i) => i.label)] : o.label));
const filtered = (options: ComboboxParsedItem[], search: string) => projectOptionsFilter({ options, search, limit: 100 });

describe("projectPickerOptions", () => {
  test("groups by 'Work stream › Program': open streams first then by name, a closed one marked, programs and projects by name, empty programs left out", () => {
    const groups = groupsOf(projectPickerOptions(PLAN, "(closed)"));
    expect(groups.map((g) => [g.group, g.items.map((i) => i.label)])).toEqual([
      ["Growth › Acquisition", ["Funnel"]],
      ["Platform › Access", ["Login"]],
      ["Platform › Billing", ["Invoices", "Reports"]],
      ["Legacy (closed) › Archive", ["Migration"]],
    ]);
    expect(groups[2].items.map((i) => i.value)).toEqual(["211", "213"]);
  });

  test("an empty or missing plan has no options; a project the plan does not hold stands alone, last, so the control can name it", () => {
    expect(projectPickerOptions(undefined, "(closed)")).toEqual([]);
    const withCurrent = projectPickerOptions(PLAN, "(closed)", { id: 999, name: "Elsewhere" });
    expect(withCurrent.at(-1)).toMatchObject({ value: "999", label: "Elsewhere" });
    // One the plan holds is not added a second time.
    expect(projectPickerOptions(PLAN, "(closed)", { id: 211, name: "Invoices" })).toHaveLength(4);
  });
});

describe("projectOptionsFilter", () => {
  const options = projectPickerOptions(PLAN, "(closed)") as ComboboxParsedItem[];

  test("an empty search keeps every option", () => {
    expect(filtered(options, "  ")).toEqual(options);
  });

  test("a project is found by its own name, its program's, its work stream's and its owner's", () => {
    expect(labels(filtered(options, "invoi"))).toEqual([["Platform › Billing", ["Invoices"]]]);
    expect(labels(filtered(options, "billing"))).toEqual([["Platform › Billing", ["Invoices", "Reports"]]]);
    expect(labels(filtered(options, "legacy"))).toEqual([["Legacy (closed) › Archive", ["Migration"]]]);
    expect(labels(filtered(options, "piotr"))).toEqual([["Platform › Access", ["Login"]]]);
    // One owner of two projects in two groups.
    expect(labels(filtered(options, "ola owner"))).toEqual([["Platform › Billing", ["Invoices"]], ["Legacy (closed) › Archive", ["Migration"]]]);
  });

  test("it folds diacritics and case on both sides, so 'zolw' finds an owner called Żółw", () => {
    expect(labels(filtered(options, "ZOLW"))).toEqual([["Platform › Billing", ["Reports"]]]);
    expect(labels(filtered(options, "żaneta"))).toEqual([["Platform › Billing", ["Reports"]]]);
  });

  test("a group with no match disappears and nothing found is an empty list; an ungrouped option is matched by its own name", () => {
    expect(filtered(options, "nothing like this")).toEqual([]);
    const lone: ComboboxItem = { value: "9", label: "Elsewhere" };
    expect(filtered([...options, lone], "where")).toEqual([lone]);
  });
});
