import type { ParseKeys, TFunction } from "i18next";
import type { JiraAuthScheme, JiraConnection, JiraConnectionRequest } from "../api/jira";
import { nameRule } from "./formRules";
import { saveErrorMessage } from "./saveError";

// Server limits (jira/JiraConnection.kt) mirrored client-side.
export const MAX_JIRA_CONNECTION_NAME_LENGTH = 100;
const MAX_SITE_URL_LENGTH = 253;
const MAX_JIRA_EMAIL_LENGTH = 254;
export const MAX_API_TOKEN_LENGTH = 1000;
const MIN_PROJECT_KEYS = 1;
export const MAX_PROJECT_KEYS = 50;

/** The Jira Cloud project-key shape: one uppercase letter, then 1-9 uppercase letters/digits/underscores. */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}$/;

/** The issue-key shape Peek and the bind dialog accept (`ABC-12`), the OpenAPI `pattern` of `key`. */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}-\d{1,10}$/;

/**
 * The allow-list boundary's shape (`JIRA_SITE_URL_PATTERN`): a Jira Cloud site's ORIGIN only - no path, no query, no port, no trailing
 * slash. The single capturing group is the tenant label, checked against {@link ATLASSIAN_RESERVED_SITE_LABELS}.
 */
const JIRA_SITE_URL_PATTERN = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/;

/** Labels under `*.atlassian.net` that are Atlassian's own surfaces, never a customer tenant (`ATLASSIAN_RESERVED_SITE_LABELS`). */
const ATLASSIAN_RESERVED_SITE_LABELS = new Set([
  "api", "id", "admin", "www", "auth", "start", "home", "status", "developer",
  "support", "community", "marketplace", "my", "team",
]);

export type JiraFormValues = {
  name: string;
  siteUrl: string;
  email: string;
  /** Blank on edit means "keep the current token" - never prefilled from a response (write-only). */
  apiToken: string;
  authScheme: JiraAuthScheme;
  projectKeys: string[];
  enabled: boolean;
};

export const EMPTY_JIRA_FORM: JiraFormValues = {
  name: "",
  siteUrl: "",
  email: "",
  apiToken: "",
  authScheme: "BASIC",
  projectKeys: [],
  enabled: true,
};

/** The form values of a stored connection; the token field stays empty (the server never returns it). */
export function fromJiraConnection(connection: JiraConnection): JiraFormValues {
  return {
    name: connection.name,
    siteUrl: connection.siteUrl,
    email: connection.email,
    apiToken: "",
    authScheme: connection.authScheme,
    projectKeys: connection.projectKeys,
    enabled: connection.enabled,
  };
}

/**
 * Validation rules shared by the create/edit modal AND its Test-connection button (they mirror the server's checks).
 * `isEdit` makes the token optional ("leave blank to keep").
 */
export function jiraFormValidation(t: TFunction, isEdit: boolean) {
  return {
    name: nameRule(t, "jira.validation.nameLength", MAX_JIRA_CONNECTION_NAME_LENGTH),
    siteUrl: (value: string) => {
      const v = value.trim();
      if (v.length > MAX_SITE_URL_LENGTH) return t("jira.validation.siteUrlInvalid");
      const label = JIRA_SITE_URL_PATTERN.exec(v)?.[1];
      return label && !ATLASSIAN_RESERVED_SITE_LABELS.has(label) ? null : t("jira.validation.siteUrlInvalid");
    },
    email: (value: string) => {
      const v = value.trim();
      if (v.length > MAX_JIRA_EMAIL_LENGTH) return t("jira.validation.emailTooLong");
      return v.includes("@") ? null : t("jira.validation.emailInvalid");
    },
    apiToken: (value: string) => {
      const v = value.trim();
      if (v === "") return isEdit ? null : t("jira.validation.apiTokenRequired");
      return v.length <= MAX_API_TOKEN_LENGTH ? null : t("jira.validation.apiTokenTooLong");
    },
    projectKeys: (value: string[]) => {
      if (value.length < MIN_PROJECT_KEYS || value.length > MAX_PROJECT_KEYS) return t("jira.validation.projectKeysCount");
      const bad = value.find((key) => !PROJECT_KEY_PATTERN.test(key));
      if (bad) return t("jira.validation.projectKeysInvalid", { key: bad });
      return new Set(value).size === value.length ? null : t("jira.validation.projectKeysDistinct");
    },
  };
}

/**
 * The wire body. A PUT is a full replace: `authScheme` and `enabled` always travel, and the site is the connection's identity (the
 * editor shows it read-only on edit, the server answers a different one with 409). A blank token is omitted - on edit that keeps the
 * stored one - and the token is NEVER logged or echoed.
 */
export function toJiraConnectionRequest(values: JiraFormValues): JiraConnectionRequest {
  const apiToken = values.apiToken.trim();
  return {
    name: values.name.trim(),
    siteUrl: values.siteUrl.trim(),
    email: values.email.trim(),
    apiToken: apiToken === "" ? undefined : apiToken,
    authScheme: values.authScheme,
    projectKeys: values.projectKeys.map((key) => key.trim().toUpperCase()),
    enabled: values.enabled,
  };
}

/** The Jira save vocabulary; a 409 is handled by the editor (the name clash, or a changed site). */
export function jiraSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "jira.saveForbidden",
    notFound: "jira.saveGone",
    invalid: "jira.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

/** The Test-connection failure vocabulary (the `jira-test` bucket's 429, a malformed ad-hoc body, ...). */
export function jiraTestErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "jira.saveForbidden",
    notFound: "jira.saveGone",
    tooManyRequests: "jira.test.rateLimited",
    invalid: "jira.saveInvalid",
    failedStatus: "common.error.actionFailedStatus",
    failed: "jira.test.failedGeneric",
  });
}

/**
 * Whether the form's account, scheme or project keys differ from the saved connection's: what a test probes (the site is fixed, the name
 * and `enabled` do not change a probe). The server invalidates the last test on exactly these (and on a new token), so the same set
 * decides whether a stored probe would test something other than the form shows, and whether a save asks for a new test.
 */
export function probeSettingsDiffer(values: JiraFormValues, saved: JiraConnection): boolean {
  const keys = values.projectKeys.map((key) => key.trim().toUpperCase());
  return (
    values.email.trim().toLowerCase() !== saved.email ||
    values.authScheme !== saved.authScheme ||
    keys.length !== saved.projectKeys.length ||
    keys.some((key, index) => key !== saved.projectKeys[index])
  );
}

/** The "no verdict" text of a connection: "Never tested", or - when an earlier discovery exists - that the last edit cleared the verdict. */
export function untestedKey(connection: Pick<JiraConnection, "discoveredAt">): ParseKeys {
  return connection.discoveredAt === null ? "jira.details.neverTested" : "jira.details.testedBefore";
}
