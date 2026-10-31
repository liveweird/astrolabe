import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/http";
import { personFormValidation, personSaveErrorMessage, toPersonBody, toPersonFormValues } from "./personForm";

const t = i18n.t;

describe("personForm", () => {
  test("validation mirrors the server's rules; the email is optional", () => {
    const rules = personFormValidation(t);
    expect(rules.name("")).toBe("Name must be 1–100 characters");
    expect(rules.name("x".repeat(101))).not.toBeNull();
    expect(rules.name("Anna Nowak")).toBeNull();
    expect(rules.email("")).toBeNull();
    expect(rules.email("   ")).toBeNull();
    expect(rules.email("anna@example.com")).toBeNull();
    expect(rules.email("no-at-sign")).toBe("Enter a valid email address");
    expect(rules.email(`${"a".repeat(250)}@t.io`)).toBe("Email must be at most 254 characters");
  });

  test("the body trims and sends a blank email and no login as null", () => {
    expect(toPersonBody({ name: "  Anna ", email: "   ", userId: null, userLabel: null })).toEqual({
      name: "Anna",
      email: null,
      userId: null,
    });
    expect(toPersonBody({ name: "A", email: " a@x.io ", userId: "7", userLabel: "a@x.io" })).toEqual({
      name: "A",
      email: "a@x.io",
      userId: 7,
    });
  });

  test("values round-trip from a response", () => {
    const base = { id: 1, name: "A", createdAt: 0, updatedAt: 0 };
    expect(toPersonFormValues({ ...base, email: null, userId: null, userEmail: null })).toEqual({
      name: "A",
      email: "",
      userId: null,
      userLabel: null,
    });
    expect(toPersonFormValues({ ...base, email: "a@x.io", userId: 7, userEmail: "login@x.io" })).toEqual({
      name: "A",
      email: "a@x.io",
      userId: "7",
      userLabel: "login@x.io",
    });
    // The editor passes the picker's own `name (email)` label once it has resolved the linked user.
    expect(toPersonFormValues({ ...base, email: null, userId: 7, userEmail: "login@x.io" }, "Lou Login (login@x.io)").userLabel).toBe(
      "Lou Login (login@x.io)",
    );
  });

  test("save errors map to the fixed vocabulary", () => {
    expect(personSaveErrorMessage(new ApiError(403, null), t)).toBe(t("people.saveForbidden"));
    expect(personSaveErrorMessage(new ApiError(404, null), t)).toBe(t("people.saveGone"));
    expect(personSaveErrorMessage(new ApiError(400, null), t)).toBe(t("people.saveInvalid"));
    expect(personSaveErrorMessage(new ApiError(500, null), t)).toBe("Save failed (500)");
    expect(personSaveErrorMessage(new DOMException("t", "TimeoutError"), t)).toBe(t("common.error.timeout"));
    expect(personSaveErrorMessage(new Error("net"), t)).toBe(t("common.error.saveFailedNetwork"));
  });
});
