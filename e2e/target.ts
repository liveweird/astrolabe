/**
 * The stack the suite runs against, named by four environment variables and nothing else: no file under e2e/ holds a host URL.
 * The suite writes rows through the API of the stack it is given and flips the scenarios of its stubs, so it never guesses one.
 * This is the ONE reader of the environment for them. `readTarget` never throws (the Playwright config, knip and `test:setup`
 * import it); `targetProblems` says what is wrong, and global setup refuses to start on any of it.
 */
export const TARGET_VARIABLES = ["E2E_BASE_URL", "E2E_MAILPIT_URL", "E2E_JIRA_STUB_URL", "E2E_FLOW_STUB_URL"] as const;

type TargetEnv = Readonly<Record<string, string | undefined>>;

export interface Target {
  /** The app (SPA + API, single origin). */
  baseUrl: string;
  /** The stack's Mailpit catcher (the two email specs read it). */
  mailpitUrl: string;
  /** The Jira stub's admin API. */
  jiraStubUrl: string;
  /** The Flow stub's admin API. */
  flowStubUrl: string;
}

function valueOf(env: TargetEnv, name: (typeof TARGET_VARIABLES)[number]): string {
  return (env[name] ?? "").trim();
}

/** The four values; an empty string for one that is not set. */
export function readTarget(env: TargetEnv): Target {
  return {
    baseUrl: valueOf(env, "E2E_BASE_URL"),
    mailpitUrl: valueOf(env, "E2E_MAILPIT_URL"),
    jiraStubUrl: valueOf(env, "E2E_JIRA_STUB_URL"),
    flowStubUrl: valueOf(env, "E2E_FLOW_STUB_URL"),
  };
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** One line per variable that is missing, blank or not an absolute http(s) URL; empty when the target is named. */
export function targetProblems(env: TargetEnv): string[] {
  const problems: string[] = [];
  for (const name of TARGET_VARIABLES) {
    const raw = env[name];
    if (raw === undefined) problems.push(`${name} is not set`);
    else if (raw.trim() === "") problems.push(`${name} is blank`);
    else if (!isAbsoluteHttpUrl(raw.trim())) problems.push(`${name} is not an absolute http(s) URL`);
  }
  return problems;
}
