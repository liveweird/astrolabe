import { describe, expect, test } from "vitest";
import i18n from "../i18n";
import { ApiError, DATABASE_TIMEOUT_PROBLEM, MalformedAnswerError } from "../api/http";
import { loadErrorMessage, saveErrorMessage } from "./saveError";

const t = i18n.t;

const KEYS = {
  forbidden: "users.lastAdminError",
  notFound: "users.userGone",
  conflict: "users.emailAlreadyInUse",
  invalid: "common.error.actionFailed",
  failedStatus: "common.error.createFailedStatus",
  failed: "common.error.createFailedNetwork",
} as const;

const timeout = new DOMException("timed out", "TimeoutError");
const databaseTimeout = new ApiError(500, { type: DATABASE_TIMEOUT_PROBLEM, status: 500, detail: "The database did not answer in time. Try again shortly." });

describe("saveErrorMessage", () => {
  test("maps each status to its key and falls back per class", () => {
    expect(saveErrorMessage(new ApiError(403, null), t, KEYS)).toBe(t(KEYS.forbidden));
    expect(saveErrorMessage(new ApiError(404, null), t, KEYS)).toBe(t(KEYS.notFound));
    expect(saveErrorMessage(new ApiError(409, null), t, KEYS)).toBe(t(KEYS.conflict));
    expect(saveErrorMessage(new ApiError(400, null), t, KEYS)).toBe(t(KEYS.invalid));
    expect(saveErrorMessage(new ApiError(500, null), t, KEYS)).toBe("Create failed (500)");
    expect(saveErrorMessage(timeout, t, KEYS)).toBe(t("common.error.timeout"));
    expect(saveErrorMessage(new Error("net"), t, KEYS)).toBe(t(KEYS.failed));
  });

  test("the database time-out 500 says the request timed out, before the status keys and a page's own 500 wording", async () => {
    expect(saveErrorMessage(databaseTimeout, t, KEYS)).toBe("The request timed out. Try again.");
    expect(saveErrorMessage(databaseTimeout, t, { ...KEYS, failedStatus: undefined })).toBe("The request timed out. Try again.");
    // An untyped 500, or one whose type is something else, keeps the status wording.
    expect(saveErrorMessage(new ApiError(500, { type: "urn:astrolabe:problem:other" }), t, KEYS)).toBe("Create failed (500)");
    await i18n.changeLanguage("pl");
    try {
      expect(saveErrorMessage(databaseTimeout, t, KEYS)).toBe("Przekroczono limit czasu żądania. Spróbuj ponownie.");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  test("an unmapped status routes through the generic fallbacks when keys are omitted", () => {
    const minimal = { failed: KEYS.failed } as const;
    expect(saveErrorMessage(new ApiError(404, null), t, minimal)).toBe(t(KEYS.failed));
  });
});

describe("loadErrorMessage", () => {
  test("tags ApiErrors with the status and falls back per class", () => {
    expect(loadErrorMessage(new ApiError(502, null), t)).toBe("Load failed (502)");
    expect(loadErrorMessage(new ApiError(429, null), t)).toBe("Too many requests. Wait a minute and try again.");
    expect(loadErrorMessage(timeout, t)).toBe(t("common.error.timeout"));
    expect(loadErrorMessage(new Error("net"), t)).toBe(t("common.error.network"));
    expect(loadErrorMessage(new MalformedAnswerError("x"), t)).toBe(t("common.error.malformedAnswer"));
  });

  test("the database time-out 500 says the request timed out, not 'Load failed (500)'", async () => {
    expect(loadErrorMessage(databaseTimeout, t)).toBe("The request timed out. Try again.");
    expect(loadErrorMessage(new ApiError(500, { type: "urn:astrolabe:problem:other" }), t)).toBe("Load failed (500)");
    await i18n.changeLanguage("pl");
    try {
      expect(loadErrorMessage(databaseTimeout, t)).toBe("Przekroczono limit czasu żądania. Spróbuj ponownie.");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
