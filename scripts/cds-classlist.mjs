// Regenerates server/cds/classlist.txt, the class list the Dockerfile dumps its AppCDS archive from
// (build-times.md WHY 27). The list is what a REAL run of the image loads: this script boots the image against a throwaway
// compose project (own containers, volume and ports), drives a representative workload
// through the API (login, MFA-free admin lists, users and teams, feature flags, telemetry, password reset mail),
// stops the app gracefully and keeps the JVM's `-XX:DumpLoadedClassList` output in canonical form (sorted, deduplicated, no ids).
// Classes missing from the list are simply loaded from the jars at runtime, so a stale list only costs startup time and
// ~metaspace, never correctness; regenerate when CdsClassListTest warns, before a release, or after a big dependency/code move.
//
//   node scripts/cds-classlist.mjs [--image <tag>] [--keep]
//
// By default it BUILDS the image itself from the working tree under its own project (`docker compose -p astrolabe-cds-train build app`, the
// image `astrolabe-cds-train-app`, removed again with the project), so the list can never be trained on a stale image. The build needs a
// plain checkout: `COPY .git` fails in a git worktree (its .git is a file), where you pass `--image <tag>` of an image built from a
// scratch copy instead. `--keep` leaves the project up for inspection. The list is only written when the run looks healthy (see
// `validate`): a truncated or unhealthy run never overwrites the committed file.
// Needs Docker, Node >= 24 and free loopback ports 8590 / 5941 / 8534 / 8600. Never touches another compose project.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const image = option("--image", null);
const project = "astrolabe-cds-train";
const base = "http://127.0.0.1:8590";
const work = mkdtempSync(join(tmpdir(), "astrolabe-cds-"));
const cdsDir = join(work, "cds");
const override = join(work, "compose.override.yaml");

mkdirSync(cdsDir);
chmodSync(cdsDir, 0o777); // the image runs as uid 10001
writeFileSync(
  override,
  `services:
  postgres:
    container_name: ${project}-postgres
    ports: !override
      - "127.0.0.1:5941:5432"
  mailpit:
    container_name: ${project}-mailpit
    ports: !override
      - "127.0.0.1:8534:8025"
  app:${image ? `\n    image: ${image}\n    pull_policy: never` : ""}
    container_name: ${project}-app
    ports: !override
      - "127.0.0.1:8590:8086"
    volumes:
      - ${cdsDir}:/cds
    environment:
      MAIL_APP_URL: ${base}
      TELEMETRY_SAMPLE_INTERVAL_SECONDS: "60"
      # Record every class the JVM loads; the image's own archive is switched off so the list is the full set, not what it served.
      JAVA_OPTS: "-XX:DumpLoadedClassList=/cds/classes.lst"
      SERVER_OPTS: ""
`,
);

const compose = (...a) => execFileSync("docker", ["compose", "-p", project, "-f", join(root, "docker-compose.yaml"), "-f", override, ...a], { stdio: ["ignore", "inherit", "inherit"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (m) => console.log(`[cds-classlist] ${m}`);
// A run is only worth committing when it looks like the real thing (a half-started or half-failed run would write a truncated list).
const MIN_READ_SUCCESS = 0.85; // share of the GETs of the read sweep answering 2xx
const MIN_CLASSES = 8_000;
const MIN_APP_CLASSES = 300; // `ch/nokillswit/` entries; the same floor as CdsClassListTest
const fail = (m) => {
  throw new Error(`refusing to write server/cds/classlist.txt: ${m}`);
};

let token = "";
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML or empty body */ }
  return { status: res.status, json };
};
const must = (res, what) => {
  if (res.status >= 300) throw new Error(`${what} answered ${res.status}: ${JSON.stringify(res.json)?.slice(0, 300)}`);
  return res.json;
};
const until = async (what, probe, seconds) => {
  for (let i = 0; i < seconds; i++) {
    const v = await probe();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
let ok = false;
try {
  if (image === null) {
    log(`building the app image under project ${project} (a git worktree needs --image, see the header)`);
    compose("build", "app");
  }
  compose("up", "-d", "postgres", "mailpit");
  compose("up", "-d", "--no-deps", "app");
  await until("the app to answer /health", async () => (await fetch(`${base}/api/v1/health`).catch(() => null))?.ok, 90);

  log("workload: auth");
  await call("POST", "/api/v1/login", { email: "admin@astrolabe.local", password: "wrong-password-0" }); // the failure path
  const session = must(await call("POST", "/api/v1/login", { email: "admin@astrolabe.local", password: "changeme" }), "login");
  token = session.token;
  await fetch(`${base}/`); // the SPA catch-all

  log("workload: user + team + feature flags + language");
  const user = must(await call("POST", "/api/v1/users", { name: "CDS Training", email: "cds-training@astrolabe.local", password: "cds-training-pass-1" }), "creating the user").id;
  const team = must(await call("POST", "/api/v1/teams", { name: "cds-training-team", description: "trained", managerUserId: user }), "creating the team").id;
  must(await call("PUT", `/api/v1/teams/${team}`, { name: "cds-training-team", description: "renamed", managerUserId: user }), "updating the team");
  must(await call("PUT", `/api/v1/users/${user}/features`, { disabledFeatures: ["MFA"] }), "setting the feature flags");
  must(await call("PUT", `/api/v1/users/${user}/language`, { language: "pl" }), "setting the language");
  must(await call("PUT", `/api/v1/users/${user}`, { name: "CDS Training 2", email: "cds-training@astrolabe.local", roles: ["USER"] }), "updating the user");
  await call("POST", "/api/v1/password-reset", { email: "cds-training@astrolabe.local" }); // renders and sends the mail (Mailpit)

  log("workload: reads");
  const paths = [
    "/api/v1/users", "/api/v1/teams", "/api/v1/ready", `/api/v1/users/${user}`, `/api/v1/teams/${team}`,
    "/api/v1/users?sort=-name&name=cds", "/api/v1/teams?name=cds",
    "/api/v1/telemetry/current", ...["memory", "jvm", "requests", "storage"].map((g) => `/api/v1/telemetry/history?group=${g}&range=24h`),
  ];
  const statuses = {};
  for (let round = 0; round < 2; round++) {
    for (const p of paths) {
      const { status } = await call("GET", p);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  }
  log(`reads answered ${JSON.stringify(statuses)}`);
  const answered = Object.values(statuses).reduce((a, b) => a + b, 0);
  const good = Object.entries(statuses).filter(([code]) => code.startsWith("2")).reduce((a, [, n]) => a + n, 0);
  if (good / answered < MIN_READ_SUCCESS) fail(`only ${good} of ${answered} reads answered 2xx (need ${MIN_READ_SUCCESS * 100} %): ${JSON.stringify(statuses)}`);
  await call("DELETE", `/api/v1/teams/${team}`);
  await call("DELETE", `/api/v1/users/${user}`);
  must(await call("POST", "/api/v1/refresh", { refreshToken: session.refreshToken }), "refreshing the session");
  await call("POST", "/api/v1/logout", {});

  log("stopping the app so the JVM flushes the class list");
  compose("stop", "-t", "30", "app");
  const lines = readFileSync(join(cdsDir, "classes.lst"), "utf8").split("\n");
  const unique = (xs) => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // code-point order, locale-free
  const plain = lines.filter((l) => l && !l.startsWith("#") && !l.startsWith("@")).map((l) => l.replace(/ id: \d+$/, ""));
  const proxies = lines.filter((l) => l.startsWith("@lambda-proxy"));
  const invokers = lines.filter((l) => l.startsWith("@lambda-form-invoker"));
  const header = ["# AppCDS class list (build-times.md WHY 27), generated by scripts/cds-classlist.mjs from a real run of the image:", "# classes, then lambda proxies, then lambda-form invokers, each sorted. Regenerate it, never edit it."];
  const classes = unique(plain);
  const appClasses = classes.filter((c) => c.startsWith("ch/nokillswit/")).length;
  if (classes.length < MIN_CLASSES) fail(`only ${classes.length} classes were recorded (need ${MIN_CLASSES}): did the app stop cleanly?`);
  if (appClasses < MIN_APP_CLASSES) fail(`only ${appClasses} application classes were recorded (need ${MIN_APP_CLASSES})`);
  if (unique(proxies).length === 0 || unique(invokers).length === 0) fail("no lambda proxies / form invokers were recorded");
  const out = [...header, ...classes, ...unique(proxies), ...unique(invokers)].join("\n") + "\n";
  const target = join(root, "server", "cds", "classlist.txt");
  writeFileSync(`${target}.tmp`, out);
  renameSync(`${target}.tmp`, target); // never a half-written list
  log(`wrote server/cds/classlist.txt: ${classes.length} classes (${appClasses} application), ${unique(proxies).length} lambda proxies, ${unique(invokers).length} invokers`);
  ok = true;
} finally {
  if (!flag("--keep")) {
    try { compose("down", "-v", "--rmi", "local", "--remove-orphans"); } catch { /* best effort: the project is throwaway */ }
    rmSync(work, { recursive: true, force: true });
  } else {
    log(`--keep: project ${project} is still up (app ${base}); remove it with: docker compose -p ${project} down -v --rmi local`);
  }
}
process.exit(ok ? 0 : 1);
