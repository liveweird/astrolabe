import type { Target } from "./target.ts";

/**
 * The suite starts nothing and stops nothing: it runs against a stack somebody started and named (`target.ts`). The refusal comes
 * BEFORE any request, because the suite writes rows through the API of the stack it is given and flips the scenarios of its stubs;
 * the repository's default stack is a working stack, so it is never assumed. Name a throwaway one.
 */
function refusal(problems: readonly string[]): string {
  return [
    "E2E refuses to run: the stack under test was not named.",
    ...problems.map((problem) => `  - ${problem}`),
    "The suite writes rows through the API of the stack it is given and flips its stubs' scenarios.",
    "This repository's default stack is a working stack, so no stack is assumed: start a throwaway one yourself",
    "and set E2E_BASE_URL, E2E_MAILPIT_URL, E2E_JIRA_STUB_URL and E2E_FLOW_STUB_URL to its app, Mailpit and the two stubs (e2e/README.md \"Run\").",
  ].join("\n");
}

export async function requireReadyTarget(
  problems: readonly string[],
  target: Target,
  responds: (url: string) => Promise<boolean>,
): Promise<void> {
  if (problems.length > 0) throw new Error(refusal(problems));
  const probes = [
    ["E2E_BASE_URL", target.baseUrl, "/api/v1/ready"],
    ["E2E_MAILPIT_URL", target.mailpitUrl, "/api/v1/messages"],
  ] as const;
  for (const [name, origin, path] of probes) {
    if (!(await responds(new URL(path, origin).href))) {
      throw new Error(`${name} (${origin}) is not ready: start that stack first`);
    }
  }
}
