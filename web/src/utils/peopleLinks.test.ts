import { describe, expect, test } from "vitest";
import { peoplePath, personPath } from "./peopleLinks";

describe("peopleLinks", () => {
  test("builds the list and detail paths", () => {
    expect(peoplePath).toBe("/people");
    expect(personPath(7)).toBe("/people/7");
  });
});
