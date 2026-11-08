import { afterEach, describe, expect, test, vi } from "vitest";
import i18n from "../i18n";
import { CONNECTION } from "../test/flow";
import {
  allowedOriginsHint,
  clearsVerdict,
  DEFAULT_FLOW_POLL_INTERVAL_MINUTES,
  EMPTY_FLOW_FORM,
  flowFormValidation,
  flowReady,
  fromFlowConnection,
  canonicalTimeZone,
  normaliseBaseUrl,
  toFlowConnectionRequest,
  untestedKey,
} from "./flowForm";

const t = i18n.t.bind(i18n);
const TOKEN = `flow_int_${"a".repeat(43)}`;

describe("normaliseBaseUrl", () => {
  test.each([
    ["HTTPS://Flow.Example.COM", "https://flow.example.com"],
    ["https://flow.example.com/", "https://flow.example.com"],
    ["https://flow.example.com:443", "https://flow.example.com"],
    ["http://flow-stub:80/", "http://flow-stub"],
    ["  http://flow-app:8084  ", "http://flow-app:8084"],
    ["http://flow-stub:8080", "http://flow-stub:8080"],
  ])("%s is written the canonical way", (typed, canonical) => {
    expect(normaliseBaseUrl(typed)).toBe(canonical);
  });

  test.each(["https://flow.example.com/app", "https://flow.example.com?x=1", "https://flow.example.com/#top", "https://user:pw@flow.example.com", "ftp://flow.example.com", "flow.example.com", ""])(
    "%j is left as typed (trimmed) for the form to refuse, never silently cut",
    (typed) => {
      expect(normaliseBaseUrl(typed)).toBe(typed.trim());
    },
  );
});

describe("canonicalTimeZone", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("an IANA region passes as is; a bare offset, a blank, a made-up region and a too long id do not", () => {
    for (const ok of ["Europe/Warsaw", "America/Argentina/Buenos_Aires", "UTC"]) expect(canonicalTimeZone(ok), ok).toBe(ok);
    for (const bad of ["+02:00", "-05:00", "", "  ", "Mars/Olympus_Mons", "Europe/", "x".repeat(65)]) expect(canonicalTimeZone(bad), bad).toBeNull();
  });

  test("the wrong case is corrected to the canonical spelling, and a trimmed id is accepted", () => {
    expect(canonicalTimeZone("Europe/warsaw")).toBe("Europe/Warsaw");
    expect(canonicalTimeZone("europe/warsaw")).toBe("Europe/Warsaw");
    expect(canonicalTimeZone(" Europe/Warsaw ")).toBe("Europe/Warsaw");
  });

  test("the JDK's legacy single-segment ids that the engine resolves are zones too", () => {
    expect(canonicalTimeZone("CET")).toBe("CET");
    // The engine renames an alias (CET is Europe/Brussels to it), so a wrong-case alias cannot be spelled back: the form refuses it.
    expect(canonicalTimeZone("cet")).toBeNull();
    expect(canonicalTimeZone("EST5EDT")).toBe("EST5EDT");
    expect(canonicalTimeZone("Poland")).not.toBeNull();
    expect(canonicalTimeZone("Nowhere")).toBeNull();
  });

  test("without Intl.supportedValuesOf the engine's formatter decides, and a region is still told from garbage", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, supportedValuesOf: undefined, DateTimeFormat: Intl.DateTimeFormat });
    const fresh = await import("./flowForm");
    expect(fresh.canonicalTimeZone("Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(fresh.canonicalTimeZone("europe/warsaw")).toBe("Europe/Warsaw");
    expect(fresh.canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("flowFormValidation", () => {
  const rules = flowFormValidation(t, false);

  test("a create needs a name, an origin, a zone and a well-formed token", () => {
    expect(rules.name("")).toMatch(/1–100/);
    expect(rules.name("Acme")).toBeNull();
    expect(rules.baseUrl("https://flow.example.com/app")).toMatch(/origin only/);
    expect(rules.baseUrl("flow.example.com")).toMatch(/origin only/);
    expect(rules.baseUrl("HTTPS://FLOW.example.com:443/")).toBeNull();
    expect(rules.baseUrl(`https://${"a".repeat(260)}.example.com`)).toMatch(/origin only/);
    expect(rules.timeZone("+02:00")).toMatch(/IANA/);
    expect(rules.timeZone(" Europe/Warsaw ")).toBeNull();
    expect(rules.timeZone("europe/warsaw")).toBeNull();
    expect(rules.timeZone("CET")).toBeNull();
    expect(rules.timeZone("Mars/Olympus_Mons")).toMatch(/IANA/);
    expect(rules.apiToken("")).toBe("The service token is required");
    expect(rules.apiToken("tok-123")).toMatch(/flow_int_ followed by 43/);
    expect(rules.apiToken(`  ${TOKEN}  `)).toBeNull();
    expect(rules.pollIntervalMinutes(3, { ...EMPTY_FLOW_FORM })).toMatch(/from 5 to 1440/);
    expect(rules.pollIntervalMinutes(60, { ...EMPTY_FLOW_FORM })).toBeNull();
    expect(rules.pollIntervalMinutes("", { ...EMPTY_FLOW_FORM, manualOnly: true })).toBeNull();
  });

  test("on edit the token is optional (blank keeps the stored one) but a typed one is still checked", () => {
    const edit = flowFormValidation(t, true);
    expect(edit.apiToken("")).toBeNull();
    expect(edit.apiToken("nope")).toMatch(/flow_int_/);
  });
});

describe("toFlowConnectionRequest", () => {
  test("the origin is canonical, the token trimmed, and the interval is the default Flow one", () => {
    const body = toFlowConnectionRequest({ ...EMPTY_FLOW_FORM, name: "  Acme  ", baseUrl: "HTTPS://Flow.Example.com:443/", apiToken: `  ${TOKEN} ` });
    expect(body).toEqual({ name: "Acme", baseUrl: "https://flow.example.com", timeZone: "Europe/Warsaw", apiToken: TOKEN, enabled: true, pollIntervalMinutes: 60 });
  });

  test("the zone travels in its canonical spelling", () => {
    expect(toFlowConnectionRequest({ ...EMPTY_FLOW_FORM, timeZone: " europe/warsaw " }).timeZone).toBe("Europe/Warsaw");
    expect(toFlowConnectionRequest({ ...EMPTY_FLOW_FORM, timeZone: "CET" }).timeZone).toBe("CET");
    // A value the form would refuse travels as typed (the probe sends it unvalidated): the server's 400 answers it.
    expect(toFlowConnectionRequest({ ...EMPTY_FLOW_FORM, timeZone: "+02:00" }).timeZone).toBe("+02:00");
  });

  test("a blank token is omitted and the interval is NEVER omitted: a number, or an explicit null for manual only", () => {
    const keep = toFlowConnectionRequest({ ...fromFlowConnection(CONNECTION), pollIntervalMinutes: 90 });
    expect(keep.apiToken).toBeUndefined();
    expect(keep.pollIntervalMinutes).toBe(90);
    const manual = toFlowConnectionRequest({ ...fromFlowConnection({ ...CONNECTION, pollIntervalMinutes: null }) });
    expect("pollIntervalMinutes" in manual && manual.pollIntervalMinutes).toBeNull();
    for (const refused of [3, 2000, "", 7.5]) {
      expect(toFlowConnectionRequest({ ...EMPTY_FLOW_FORM, pollIntervalMinutes: refused }).pollIntervalMinutes, String(refused)).toBe(DEFAULT_FLOW_POLL_INTERVAL_MINUTES);
    }
  });

  test("a stored connection fills the form; manual only keeps the default number for when the box is unticked", () => {
    expect(fromFlowConnection(CONNECTION)).toMatchObject({ name: "Acme Flow", baseUrl: "https://flow.acme.example", timeZone: "Europe/Warsaw", apiToken: "", manualOnly: false, pollIntervalMinutes: 60 });
    expect(fromFlowConnection({ ...CONNECTION, pollIntervalMinutes: null })).toMatchObject({ manualOnly: true, pollIntervalMinutes: DEFAULT_FLOW_POLL_INTERVAL_MINUTES });
  });
});

describe("what a connection says about its test", () => {
  test("a new token or another zone clears the verdict; the rest of an edit does not", () => {
    const values = fromFlowConnection(CONNECTION);
    expect(clearsVerdict(values, CONNECTION)).toBe(false);
    expect(clearsVerdict({ ...values, name: "Renamed", enabled: false, pollIntervalMinutes: 15 }, CONNECTION)).toBe(false);
    expect(clearsVerdict({ ...values, apiToken: TOKEN }, CONNECTION)).toBe(true);
    expect(clearsVerdict({ ...values, timeZone: "UTC" }, CONNECTION)).toBe(true);
    // The same zone in another case is not another zone.
    expect(clearsVerdict({ ...values, timeZone: "europe/warsaw" }, CONNECTION)).toBe(false);
  });

  test("never tested until a run has mirrored Flow; then 'not tested since the change'", () => {
    expect(untestedKey({ teamsAt: null })).toBe("flow.details.neverTested");
    expect(untestedKey({ teamsAt: 1 })).toBe("flow.details.testedBefore");
  });

  test("ready (pollable) after a passing test or once a document was mirrored", () => {
    expect(flowReady({ lastTestOk: null, teamsAt: null })).toBe(false);
    expect(flowReady({ lastTestOk: false, teamsAt: null })).toBe(false);
    expect(flowReady({ lastTestOk: true, teamsAt: null })).toBe(true);
    expect(flowReady({ lastTestOk: null, teamsAt: 1 })).toBe(true);
  });
});

describe("allowedOriginsHint", () => {
  test("the plain hint alone until the list is known", () => {
    expect(allowedOriginsHint("Hint.", undefined, t)).toBe("Hint.");
  });

  test("the hint, then the allowed origins joined", () => {
    expect(allowedOriginsHint("Hint.", ["http://flow-stub:8080", "http://flow-app:8084"], t)).toBe(
      "Hint. Allowed on this server: http://flow-stub:8080, http://flow-app:8084",
    );
  });

  test("an empty list says nothing is configured", () => {
    expect(allowedOriginsHint("Hint.", [], t)).toMatch(/^Hint\. No Flow origin is configured on this server yet/);
  });
});
