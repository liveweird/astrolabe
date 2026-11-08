import { describe, expect, it } from "vitest";
import { growSeenRange } from "./seenRange";

describe("growSeenRange", () => {
  it("stores the first dates it sees", () => {
    expect(growSeenRange(null, ["2027-03-05", "2027-03-01", "2027-03-09"])).toEqual({ min: "2027-03-01", max: "2027-03-09" });
  });

  it("has nothing to store without dates or when the range already covers them", () => {
    expect(growSeenRange(null, [])).toBeNull();
    expect(growSeenRange({ min: "2027-03-01", max: "2027-03-31" }, ["2027-03-10", "2027-03-31"])).toBeNull();
  });

  it("only ever grows, on either side", () => {
    const seen = { min: "2027-03-10", max: "2027-03-20" };
    expect(growSeenRange(seen, ["2027-03-12", "2027-04-01"])).toEqual({ min: "2027-03-10", max: "2027-04-01" });
    expect(growSeenRange(seen, ["2027-02-01", "2027-03-12"])).toEqual({ min: "2027-02-01", max: "2027-03-20" });
    expect(growSeenRange(seen, ["2027-02-01", "2027-05-01"])).toEqual({ min: "2027-02-01", max: "2027-05-01" });
  });
});
