import type { ParseKeys, TFunction } from "i18next";
import type { FlowConnection, FlowConnectionRequest } from "../api/flow";
import { nameRule } from "./formRules";
import { pollIntervalRule, validPollInterval, type PollingValues } from "./pollingForm";
import { saveErrorMessage } from "./saveError";

// Server limits (flow/FlowConnection.kt) mirrored client-side.
export const MAX_FLOW_CONNECTION_NAME_LENGTH = 100;
const MAX_BASE_URL_LENGTH = 255;
const MAX_TIME_ZONE_LENGTH = 64;
/** The polling interval's default, in minutes (`DEFAULT_FLOW_POLL_INTERVAL_MINUTES`: a sprint calendar moves a few times a week; the bounds are `pollingForm.ts`'s). */
export const DEFAULT_FLOW_POLL_INTERVAL_MINUTES = 60;
/** Flow's own metrics zone by default (`MetricsSettings`): the editor pre-fills it so a sprint's instants become the dates Flow shows. */
const DEFAULT_TIME_ZONE = "Europe/Warsaw";

/** The Flow service token's shape (`FLOW_TOKEN_PATTERN`): the prefix and 43 base64url characters. The token is write-only and never shown. */
const FLOW_TOKEN_PATTERN = /^flow_int_[A-Za-z0-9_-]{43}$/;

export type FlowFormValues = {
  name: string;
  baseUrl: string;
  timeZone: string;
  /** Blank on edit means "keep the current token" - never prefilled from a response (write-only). */
  apiToken: string;
  enabled: boolean;
} & PollingValues;

export const EMPTY_FLOW_FORM: FlowFormValues = {
  name: "",
  baseUrl: "",
  timeZone: DEFAULT_TIME_ZONE,
  apiToken: "",
  enabled: true,
  pollIntervalMinutes: DEFAULT_FLOW_POLL_INTERVAL_MINUTES,
  manualOnly: false,
};

/** The form values of a stored connection; the token field stays empty (the server never returns it). */
export function fromFlowConnection(connection: FlowConnection): FlowFormValues {
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    timeZone: connection.timeZone,
    apiToken: "",
    enabled: connection.enabled,
    // `null` = manual only; the field then keeps the default, which is what unticking the box brings back.
    pollIntervalMinutes: connection.pollIntervalMinutes ?? DEFAULT_FLOW_POLL_INTERVAL_MINUTES,
    manualOnly: connection.pollIntervalMinutes === null,
  };
}

/**
 * The origin the server stores, spelled the one canonical way (`FlowOrigins.baseUrlAllowed` accepts no other): lowercase scheme and host, the
 * scheme's default port dropped, no trailing slash. Only that: an address with a path, query, fragment or credentials comes back as typed
 * (trimmed), for the form to refuse - the path is never silently thrown away, and the operator's allow-list stays the server's decision.
 */
export function normaliseBaseUrl(raw: string): string {
  const typed = raw.trim();
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return typed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return typed;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return typed;
  return url.origin;
}

/** Whether the (normalised) address is a bare http(s) origin; whether it is one the OPERATOR listed is the server's answer. */
function isOrigin(address: string): boolean {
  try {
    const url = new URL(address);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === address;
  } catch {
    return false;
  }
}

/** A zone id's outline: a region (`Area/City`) or a legacy single-segment id (`CET`, `Poland`, `EST5EDT`, `UTC`); never an offset (`+02:00`). The engine decides the rest. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

let zoneList: ReadonlySet<string> | null | undefined;

/** The engine's canonical zone ids, or null when it cannot list them (`Intl.supportedValuesOf` is missing). Read once. */
function supportedZones(): ReadonlySet<string> | null {
  if (zoneList === undefined) {
    try {
      zoneList = new Set(Intl.supportedValuesOf("timeZone"));
    } catch {
      zoneList = null;
    }
  }
  return zoneList;
}

/**
 * The zone id spelled the way the server (the JDK) knows it, or null when it is no zone. `Intl.supportedValuesOf("timeZone")` lists canonical ids
 * only (no `UTC`, no aliases, no legacy ids such as `CET`), so an id the list lacks is asked of the engine's formatter: it accepts any case
 * (`europe/warsaw`) and tells the canonical spelling back, which is what is kept; an alias the engine resolves to another name
 * (`Asia/Calcutta`) stays as typed when it is written like an id. Without the function the formatter decides alone. A bare offset
 * (`+02:00`) is never a zone: the server refuses it.
 */
export function canonicalTimeZone(raw: string): string | null {
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_TIME_ZONE_LENGTH || !ZONE_SHAPE.test(id)) return null;
  if (supportedZones()?.has(id)) return id;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en", { timeZone: id }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.toLowerCase() === id.toLowerCase()) return resolved;
  // The engine renamed it (an alias): keep it as typed when it already has an id's capitals, else it is a wrong-case guess we cannot spell.
  return /^[A-Z]/.test(id) ? id : null;
}

/** Validation rules shared by the create/edit modal AND its Test-connection button (they mirror the server's checks). `isEdit` makes the token optional. */
export function flowFormValidation(t: TFunction, isEdit: boolean) {
  return {
    name: nameRule(t, "flow.validation.nameLength", MAX_FLOW_CONNECTION_NAME_LENGTH),
    baseUrl: (value: string) => {
      const address = normaliseBaseUrl(value);
      return address.length <= MAX_BASE_URL_LENGTH && isOrigin(address) ? null : t("flow.validation.baseUrlInvalid");
    },
    timeZone: (value: string) => (canonicalTimeZone(value) !== null ? null : t("flow.validation.timeZoneInvalid")),
    apiToken: (value: string) => {
      const v = value.trim();
      if (v === "") return isEdit ? null : t("flow.validation.apiTokenRequired");
      return FLOW_TOKEN_PATTERN.test(v) ? null : t("flow.validation.apiTokenInvalid");
    },
    pollIntervalMinutes: pollIntervalRule(t),
  };
}

/**
 * The wire body. A PUT is a full replace: `enabled` and `pollIntervalMinutes` always travel, and the base URL is the connection's identity (the
 * editor shows it read-only on edit, the server answers a different one with 409). A blank token is omitted - on edit that keeps the stored
 * one - and the token is NEVER logged or echoed. **The interval is never omitted**: a number, or an explicit `null` for manual only, because an
 * omitted member means "60" to the server (a rename would silently re-enable polling). A value the form would refuse (the Test-connection
 * probe sends the body unvalidated) travels as the default; a save is validated first.
 */
export function toFlowConnectionRequest(values: FlowFormValues): FlowConnectionRequest & { pollIntervalMinutes: number | null } {
  const apiToken = values.apiToken.trim();
  return {
    name: values.name.trim(),
    baseUrl: normaliseBaseUrl(values.baseUrl),
    timeZone: canonicalTimeZone(values.timeZone) ?? values.timeZone.trim(),
    apiToken: apiToken === "" ? undefined : apiToken,
    enabled: values.enabled,
    pollIntervalMinutes: values.manualOnly ? null : (validPollInterval(values.pollIntervalMinutes) ?? DEFAULT_FLOW_POLL_INTERVAL_MINUTES),
  };
}

/** The Flow save vocabulary; a 409 is handled by the editor (the name clash, or a changed address). */
export function flowSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "flow.saveForbidden",
    notFound: "flow.saveGone",
    invalid: "flow.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}

/** The Test-connection failure vocabulary (the `flow-test` bucket's 429, a malformed ad-hoc body, ...). */
export function flowTestErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "flow.saveForbidden",
    notFound: "flow.saveGone",
    tooManyRequests: "flow.test.rateLimited",
    invalid: "flow.saveInvalid",
    failedStatus: "common.error.actionFailedStatus",
    failed: "flow.test.failedGeneric",
  });
}

/**
 * Whether saving these values clears the connection's last test verdict - a new token or another time zone (the server's own rule: the last
 * test judged the old ones) - so the toast asks for a new test.
 */
export function clearsVerdict(values: FlowFormValues, saved: FlowConnection): boolean {
  return values.apiToken.trim() !== "" || (canonicalTimeZone(values.timeZone) ?? values.timeZone.trim()) !== saved.timeZone;
}

/** The "no verdict" text of a connection: "Never tested", or - when a run has already mirrored Flow - that the last edit cleared the verdict. */
export function untestedKey(connection: Pick<FlowConnection, "teamsAt">): ParseKeys {
  return connection.teamsAt === null ? "flow.details.neverTested" : "flow.details.testedBefore";
}

/** Whether the connection is pollable: a passing test or a mirrored document (the server's `ready`, sticky once Flow has answered a run). */
export function flowReady(connection: Pick<FlowConnection, "lastTestOk" | "teamsAt">): boolean {
  return connection.lastTestOk === true || connection.teamsAt !== null;
}

/** The plain hint followed by what this server allows (or that nothing is configured); the plain hint alone until the list is known. */
export function allowedOriginsHint(hint: string, items: string[] | undefined, t: TFunction): string {
  if (items === undefined) return hint;
  return `${hint} ${items.length > 0 ? t("flow.field.baseUrlAllowed", { origins: items.join(", ") }) : t("flow.field.baseUrlNoneAllowed")}`;
}
