import { readTarget, targetProblems } from "./target.ts";
import { requireReadyTarget } from "./stack.ts";

async function responds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  const target = readTarget(process.env);
  await requireReadyTarget(targetProblems(process.env), target, responds);
  console.log(
    `[e2e] Using app ${target.baseUrl}, Mailpit ${target.mailpitUrl}, Jira stub ${target.jiraStubUrl}, Flow stub ${target.flowStubUrl};` +
      " nothing is started or stopped, and the stack's data is left intact.",
  );
}
