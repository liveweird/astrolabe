import { describe, expect, test } from "vitest";
import { ApiError } from "./http";
import { isPersonEmailTaken, isPersonLoginTaken } from "./people";

const problem = (status: number, type?: string, detail?: string) => new ApiError(status, { type, title: "Conflict", status, detail });

describe("the person conflicts are told apart by problem type", () => {
  test.each([
    { type: "urn:astrolabe:problem:person-email-taken", email: true, login: false },
    { type: "urn:astrolabe:problem:person-login-taken", email: false, login: true },
    { type: "about:blank", email: false, login: false },
    { type: undefined, email: false, login: false },
  ])("a 409 of type $type: email $email, login $login", ({ type, email, login }) => {
    // The sentence never decides: both of these carry the other case's wording.
    const err = problem(409, type, "Another person is already linked to this user; a person with this email already exists");
    expect(isPersonEmailTaken(err)).toBe(email);
    expect(isPersonLoginTaken(err)).toBe(login);
  });

  test("only a 409 counts, and only an ApiError", () => {
    expect(isPersonEmailTaken(problem(400, "urn:astrolabe:problem:person-email-taken"))).toBe(false);
    expect(isPersonLoginTaken(problem(403, "urn:astrolabe:problem:person-login-taken"))).toBe(false);
    expect(isPersonEmailTaken(new Error("net"))).toBe(false);
    expect(isPersonLoginTaken(null)).toBe(false);
  });
});
