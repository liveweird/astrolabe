// The shape of the instruction docs (node built-ins only): a line, a section and a heading each stay small enough to
// read, every long area doc opens with `## Rules`, CLAUDE.md's table matches the docs folder, in-doc anchors and section
// references resolve. Beside check-docs-budget.mjs (same reason: a Markdown-only PR skips the `server` job, `e2e-static` always runs).
//
//   node scripts/check-docs-shape.mjs                          the gate (exit 1 on a violation)
//   node scripts/check-docs-shape.mjs --only <doc>             limits 1-5 and 7 for one file, ignoring NOT_YET (what a restructure proves itself with)
//   node scripts/check-docs-shape.mjs --report                 the table of every covered file (exit 0)
//   node scripts/check-docs-shape.mjs --refs [--into <doc>]    the section references (the unresolved ones, or every one naming <doc>) (exit 0)
//
// Test knobs of the self-test (scripts/check-docs-shape.test.mjs), harmless elsewhere: --root <dir> measures another tree,
// --not-yet a.md,b.md replaces NOT_YET, --enforce-refs turns ENFORCE_REFS on.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- The limits (change one only with the reason that moves it) --------------------------------------------------------

// Limit 1. A line outside a code fence. 600 is what the repo's well-formed docs already keep (dependencies.md's longest line is
// exactly 600): past it a line is a paragraph nobody can diff or quote.
const MAX_LINE_CHARS = 600;
// Limit 2. The text between two headings. 8,000 bytes is the largest section that still reads as one thing; it lets CLAUDE.md's
// 6,612-byte "Package layout" stand. A `## Rules` section is measured through its `###` children too: it is the part every change reads.
const MAX_SECTION_BYTES = 8_000;
// Limit 3. A heading names the thing, never a version (`v?N.N[.N]`): tags rot and break every reference to the heading.
// Astrolabe's releases are 0.x and 1.x, so another major ("3.0-compatible", an OpenAPI version) is not a release tag.
const RELEASE_TAG = /(?<![\w./-])v?[01]\.\d+(?:\.\d+)?(?!\d)/;
//   product.md is the one exception: its release history's headings ARE versions.
const RELEASE_TAG_EXEMPT = new Set([".claude/docs/product.md"]);
// Limit 4. A doc under .claude/docs/ over this size opens with `## Rules` (the reading law: the Rules in full, then the sections of what you touch).
const RULES_REQUIRED_OVER_BYTES = 30_000;
//   product.md is a record, not an area; web-internals.md's rules are web/CLAUDE.md's, loaded for every web edit.
const RULES_EXEMPT = new Set([".claude/docs/product.md", ".claude/docs/web-internals.md"]);
// Limit 5. A parked move (`## To place (from <doc>)`) is emptied by the destination's own commit; a restructured doc keeps none.
const TO_PLACE = /^to place\b/i;
// Limit 6 (CLAUDE.md's table names exactly the on-demand docs), limit 7 (an in-doc anchor names a heading of that doc) and
// limit 8 (a section reference resolves) carry no number.

// Limit 8 is counted, not enforced, until D26 has swept the references and set this true with zero misses.
const ENFORCE_REFS = false;

// The docs that do not pass limits 1-5 yet. The list can only shrink: a listed file that passes fails ("remove it from NOT_YET"),
// an entry that names no file fails. The main session edits it when it commits a D step; nobody else.
const NOT_YET = [
  ".claude/docs/build-times.md",
  ".claude/docs/ci.md",
  ".claude/docs/conventions.md",
  ".claude/docs/flow-sync.md",
  ".claude/docs/jira-sync.md",
  ".claude/docs/list-endpoints.md",
  ".claude/docs/observability.md",
  ".claude/docs/planning-model.md",
  ".claude/docs/testing.md",
  ".claude/docs/web-internals.md",
  "CLAUDE.md",
];

// ---- What is read ------------------------------------------------------------------------------------------------------
const COVERED_FIXED = ["CLAUDE.md", "AGENTS.md", "web/CLAUDE.md", "e2e/README.md", "e2e/scenarios/README.md"];

const DOCS_DIR = ".claude/docs";
const REF_EXTENSIONS = new Set([".md", ".kt", ".kts", ".ts", ".tsx", ".mjs", ".yml", ".yaml", ".sh"]);
// This script and its self-test quote reference-shaped text on purpose.
const REF_SKIP_FILES = new Set(["scripts/check-docs-shape.mjs", "scripts/check-docs-shape.test.mjs"]);
const WALK_SKIP_DIRS = new Set([".git", "node_modules", "build", "dist", ".gradle", ".kotlin", "coverage"]);

// ---- Arguments ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { mode: "gate", root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), notYet: NOT_YET, enforceRefs: ENFORCE_REFS };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") (o.mode = "only"), (o.only = need(i++, a));
    else if (a === "--report") o.mode = "report";
    else if (a === "--refs") o.mode = "refs";
    else if (a === "--into") o.into = need(i++, a);
    else if (a === "--root") o.root = resolve(need(i++, a));
    else if (a === "--not-yet") o.notYet = need(i++, a).split(",").filter(Boolean);
    else if (a === "--enforce-refs") o.enforceRefs = true;
    else fail(`unknown argument ${a} (see the header comment)`);
  }
  if (o.into !== undefined && o.mode !== "refs") fail("--into belongs to --refs");
  return o;
}

function fail(msg) {
  console.error(`check-docs-shape: ${msg}`);
  process.exit(2);
}

// ---- Files -------------------------------------------------------------------------------------------------------------

function walk(root, dir, out, skipDirs = WALK_SKIP_DIRS) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name)) walk(root, rel, out, skipDirs);
    } else if (e.isFile()) out.push(rel);
  }
}

/** The covered Markdown files, as repo-relative paths, sorted. */
function coveredFiles(root) {
  const out = new Set(COVERED_FIXED.filter((f) => existsSync(join(root, f))));
  if (existsSync(join(root, DOCS_DIR))) {
    const all = [];
    walk(root, DOCS_DIR, all);
    for (const f of all) if (f.endsWith(".md")) out.add(f);
  }
  if (existsSync(join(root, "api-guidelines"))) {
    for (const e of readdirSync(join(root, "api-guidelines"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.add(`api-guidelines/${e.name}`);
    }
  }
  return [...out].sort();
}

/** Every tracked text file with a reference-bearing extension (a directory walk when `root` is not a git work tree), plus the covered docs. */
function referenceFiles(root, covered) {
  let files;
  try {
    if (!existsSync(join(root, ".git"))) throw new Error("not a work tree");
    files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
  } catch {
    files = [];
    walk(root, "", files);
  }
  const set = new Set([...files, ...covered]);
  return [...set]
    .filter((f) => REF_EXTENSIONS.has(f.slice(f.lastIndexOf("."))) && !REF_SKIP_FILES.has(f) && existsSync(join(root, f)))
    .sort();
}

// ---- Parsing a doc -----------------------------------------------------------------------------------------------------

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;

/** Lines with their code-fence state, headings (outside fences), and the section between consecutive headings. */
function parseDoc(text) {
  const lines = text.split("\n");
  const headings = [];
  const inFence = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {
      inFence[i] = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && lines[i].trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      inFence[i] = true;
      continue;
    }
    const h = HEADING.exec(lines[i]);
    if (h) headings.push({ level: h[1].length, text: h[2].trim(), line: i + 1, index: i });
  }
  // Sections: the preamble before the first heading, then each heading's body up to the next heading of any level.
  const sections = [];
  const starts = [{ heading: null, from: 0 }, ...headings.map((h) => ({ heading: h, from: h.index + 1 }))];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].from;
    const to = s + 1 < starts.length ? starts[s + 1].heading.index : lines.length;
    let bytes = 0;
    for (let i = from; i < to; i++) bytes += Buffer.byteLength(lines[i]) + 1;
    sections.push({ heading: starts[s].heading, bytes });
  }
  return { lines, headings, inFence, sections };
}

// ---- Limits 1-5 and 7 on one file --------------------------------------------------------------------------------------

function slugOf(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function headingSlugs(headings) {
  const seen = new Map();
  const out = new Set();
  for (const h of headings) {
    const base = slugOf(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Limits 1-5: `[{limit, line, msg}]`. */
function shapeViolations(rel, text, doc) {
  const v = [];
  doc.lines.forEach((line, i) => {
    if (doc.inFence[i]) return;
    const n = [...line].length;
    if (n > MAX_LINE_CHARS) v.push({ limit: 1, line: i + 1, msg: `a line of ${n} characters (limit ${MAX_LINE_CHARS})` });
  });
  for (const s of doc.sections) {
    if (s.bytes > MAX_SECTION_BYTES) {
      const where = s.heading ? `under "${s.heading.text}"` : "before the first heading";
      v.push({ limit: 2, line: s.heading?.line ?? 1, msg: `${s.bytes} bytes ${where} (limit ${MAX_SECTION_BYTES})` });
    }
  }
  const rulesAt = doc.headings.findIndex((h) => h.level === 2 && /^rules$/i.test(h.text));
  if (rulesAt >= 0) {
    // The whole Rules section, its `###` children included: it is the part every change reads.
    const rules = doc.headings[rulesAt];
    const end = doc.headings.findIndex((h, i) => i > rulesAt && h.level <= 2);
    const stop = end < 0 ? doc.lines.length : doc.headings[end].index;
    let bytes = 0;
    for (let i = rules.index + 1; i < stop; i++) bytes += Buffer.byteLength(doc.lines[i]) + 1;
    const own = doc.sections.find((s) => s.heading === rules)?.bytes ?? 0;
    if (bytes > MAX_SECTION_BYTES && own <= MAX_SECTION_BYTES) {
      v.push({ limit: 2, line: rules.line, msg: `"Rules" with its sub-sections is ${bytes} bytes (limit ${MAX_SECTION_BYTES})` });
    }
  }
  if (!RELEASE_TAG_EXEMPT.has(rel)) {
    for (const h of doc.headings) {
      const m = RELEASE_TAG.exec(h.text);
      if (m) v.push({ limit: 3, line: h.line, msg: `heading "${h.text}" holds a release tag (${m[0]})` });
    }
  }
  if (rel.startsWith(`${DOCS_DIR}/`) && Buffer.byteLength(text) > RULES_REQUIRED_OVER_BYTES && !RULES_EXEMPT.has(rel)) {
    const first = doc.headings.find((h) => h.level === 2);
    if (!first || !/^rules$/i.test(first.text)) {
      v.push({ limit: 4, line: first?.line ?? 1, msg: `over ${RULES_REQUIRED_OVER_BYTES} bytes and the first "##" is ${first ? `"${first.text}"` : "missing"}, not "Rules"` });
    }
  }
  for (const h of doc.headings) {
    if (TO_PLACE.test(h.text)) v.push({ limit: 5, line: h.line, msg: `heading "${h.text}": a parked move is emptied by the destination's own commit` });
  }
  return v;
}

/** Limit 7: an in-doc anchor names a heading of the doc. */
function anchorViolations(doc) {
  const v = [];
  const slugs = headingSlugs(doc.headings);
  doc.lines.forEach((line, i) => {
    if (doc.inFence[i]) return;
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(/\]\(#([^)\s]+)\)/g)) {
      if (!slugs.has(decodeURIComponent(m[1]).toLowerCase())) v.push({ limit: 7, line: i + 1, msg: `anchor #${m[1]} names no heading of this doc` });
    }
  });
  return v;
}

// ---- Limit 6: CLAUDE.md's table ----------------------------------------------------------------------------------------

function tableViolations(root, covered) {
  const rel = "CLAUDE.md";
  if (!covered.includes(rel)) return [{ limit: 6, file: rel, line: 1, msg: "CLAUDE.md does not exist" }];
  const text = readFileSync(join(root, rel), "utf8");
  const lines = text.split("\n");
  const imports = new Set([...text.matchAll(/^@(\S+)$/gm)].map((m) => m[1].replace(/^\.\//, "")));
  const onDemand = covered.filter((f) => f.startsWith(`${DOCS_DIR}/`) && !imports.has(f));
  const named = new Map();
  lines.forEach((line, i) => {
    const m = /^\|\s*`([^`]+\.md)`\s*\|/.exec(line);
    if (m) named.set(m[1].replace(/^\.\//, ""), i + 1);
  });
  const v = [];
  for (const f of onDemand) if (!named.has(f)) v.push({ limit: 6, file: rel, line: 1, msg: `the table has no row for ${f}` });
  for (const [f, line] of named) {
    if (!onDemand.includes(f)) v.push({ limit: 6, file: rel, line, msg: `the table names ${f}, which is not an on-demand doc (missing, or an "@" import)` });
  }
  return v;
}

// ---- Limit 8: section references ---------------------------------------------------------------------------------------

const foldSection = (s) =>
  s
    .replace(/[`*]/g, "")
    .replace(/(?:\.\.\.|…)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// A comment's leader on a continuation line (`//`, `///`, ` * `, `#`, `>`), skipped when a reference breaks over two lines.
const LEADER = /^\s*(?:\/\/+|\/\*+|\*+(?!\/)|#+|>+|<!--)?\s*/;

/** Every `doc.md "Section"` reference of the files: `[{file, line, doc, section, target, resolved}]`. */
function collectReferences(root, covered, files, docs) {
  const byBase = new Map();
  for (const f of covered) {
    const b = basename(f);
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const stems = [...byBase.keys()].filter((b) => byBase.get(b).length === 1 && f_isDoc(byBase.get(b)[0])).map((b) => b.slice(0, -3));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = new RegExp(`\\.md|${stems.map(esc).join("|")}`);
  const re = new RegExp(
    `(?<![\\w./-])(?:((?:[\\w.-]+/)*[\\w-]+)\\.md|(${stems.map(esc).join("|")}))\`?,?\\s+["“]([^"“”]{2,200}?)["”]`,
    "g",
  );
  const out = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!pre.test(lines[i])) continue;
      const window = i + 1 < lines.length ? `${lines[i]} ${lines[i + 1].replace(LEADER, "")}` : lines[i];
      for (const m of window.matchAll(re)) {
        if (m.index >= lines[i].length) continue;
        const name = `${m[1] ? basename(m[1]) : m[2]}.md`;
        const targets = byBase.get(name);
        if (!targets || targets.length !== 1) continue;
        const target = targets[0];
        const want = foldSection(m[3]);
        const resolved = want !== "" && docs.get(target).headings.some((h) => foldSection(h.text).startsWith(want));
        out.push({ file, line: i + 1, doc: name, section: m[3], target, resolved });
      }
    }
  }
  return out;
}

// The bare-stem form (`web-internals "…"`) is for the instruction docs themselves, not for a basename like README.md.
const f_isDoc = (rel) => rel.startsWith(`${DOCS_DIR}/`) || rel === "CLAUDE.md" || rel === "web/CLAUDE.md";

// ---- Running -----------------------------------------------------------------------------------------------------------

const fmt = (file, x) => `${file}:${x.line}: [limit ${x.limit}] ${x.msg}`;

function load(root) {
  const covered = coveredFiles(root);
  const docs = new Map();
  const texts = new Map();
  for (const f of covered) {
    const text = readFileSync(join(root, f), "utf8");
    texts.set(f, text);
    docs.set(f, parseDoc(text));
  }
  return { covered, docs, texts };
}

function resolveDocArg(arg, covered, root) {
  const rel = relative(root, resolve(process.cwd(), arg));
  if (covered.includes(rel)) return rel;
  if (covered.includes(arg)) return arg;
  const bases = covered.filter((f) => basename(f) === basename(arg));
  if (bases.length === 1) return bases[0];
  fail(`${arg} is not a covered file${bases.length > 1 ? " (ambiguous basename)" : ""}`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { covered, docs, texts } = load(o.root);

  if (o.mode === "only") {
    const rel = resolveDocArg(o.only, covered, o.root);
    const v = [...shapeViolations(rel, texts.get(rel), docs.get(rel)), ...anchorViolations(docs.get(rel))];
    v.forEach((x) => console.error(fmt(rel, x)));
    const refs = collectReferences(o.root, covered, [rel], docs).filter((r) => !r.resolved);
    if (refs.length > 0) console.log(`${rel}: ${refs.length} section reference(s) unresolved (limit 8, not part of --only):`);
    refs.forEach((r) => console.log(`  ${r.file}:${r.line}: ${r.doc} "${r.section}"`));
    console.log(v.length === 0 ? `${rel}: limits 1-5 and 7 pass` : `${rel}: ${v.length} violation(s)`);
    process.exit(v.length === 0 ? 0 : 1);
  }

  if (o.mode === "refs") {
    const files = referenceFiles(o.root, covered);
    let refs = collectReferences(o.root, covered, files, docs);
    if (o.into !== undefined) {
      const into = resolveDocArg(o.into, covered, o.root);
      refs = refs.filter((r) => r.target === into);
    } else refs = refs.filter((r) => !r.resolved);
    refs.forEach((r) => console.log(`${r.file}:${r.line}: ${r.doc} "${r.section}" ${r.resolved ? "ok" : "UNRESOLVED"}`));
    const miss = refs.filter((r) => !r.resolved).length;
    console.log(`${refs.length} reference(s)${o.into ? ` into ${o.into}` : " unresolved"}, ${miss} unresolved`);
    process.exit(0);
  }

  const shape = new Map(covered.map((f) => [f, shapeViolations(f, texts.get(f), docs.get(f))]));

  if (o.mode === "report") {
    const failing = [];
    for (const f of covered) {
      const v = shape.get(f);
      const per = [1, 2, 3, 4, 5].map((l) => [l, v.filter((x) => x.limit === l).length]).filter(([, n]) => n > 0);
      if (per.length > 0) failing.push(f);
      const size = Buffer.byteLength(texts.get(f));
      const state = per.length === 0 ? "passes" : per.map(([l, n]) => `L${l}x${n}`).join(" ");
      const tag = o.notYet.includes(f) ? "NOT_YET" : per.length > 0 ? "NOT LISTED" : "";
      console.log(`${f.padEnd(44)} ${String(size).padStart(8)} B  ${state}  ${tag}`.trimEnd());
    }
    console.log(`\n${failing.length} of ${covered.length} covered files fail limits 1-5:`);
    console.log(`const NOT_YET = ${JSON.stringify(failing, null, 2)};`);
    const t6 = tableViolations(o.root, covered);
    console.log(`limit 6: ${t6.length === 0 ? "pass" : t6.map((x) => x.msg).join("; ")}`);
    const t7 = covered.reduce((n, f) => n + anchorViolations(docs.get(f)).length, 0);
    console.log(`limit 7: ${t7} unresolved anchor(s)`);
    const refs = collectReferences(o.root, covered, referenceFiles(o.root, covered), docs);
    console.log(`limit 8: ${refs.filter((r) => !r.resolved).length} of ${refs.length} section references unresolved`);
    process.exit(0);
  }

  // The gate.
  const errors = [];
  let anchorsPending = 0;
  for (const entry of o.notYet) {
    if (!covered.includes(entry)) errors.push(`NOT_YET names ${entry}, which is no covered file: remove the entry`);
  }
  for (const f of covered) {
    const v = shape.get(f);
    if (o.notYet.includes(f)) {
      if (v.length === 0) errors.push(`${f} passes limits 1-5: remove it from NOT_YET`);
      continue;
    }
    v.forEach((x) => errors.push(fmt(f, x)));
  }
  tableViolations(o.root, covered).forEach((x) => errors.push(fmt(x.file, x)));
  // A NOT_YET doc's anchors are counted, not enforced: its "Contents" block is regenerated by the commit that restructures it.
  for (const f of covered) {
    const a = anchorViolations(docs.get(f));
    if (o.notYet.includes(f)) anchorsPending += a.length;
    else a.forEach((x) => errors.push(fmt(f, x)));
  }

  const refs = collectReferences(o.root, covered, referenceFiles(o.root, covered), docs);
  const missed = refs.filter((r) => !r.resolved);
  if (o.enforceRefs) missed.forEach((r) => errors.push(`${r.file}:${r.line}: [limit 8] ${r.doc} "${r.section}" resolves to no heading`));

  console.log(
    `docs shape: ${covered.length} files, ${o.notYet.length} still in NOT_YET; ${refs.length} section references, ${missed.length} unresolved` +
      (o.enforceRefs ? "" : " (limit 8 not enforced yet)") +
      (anchorsPending > 0 ? `; ${anchorsPending} stale in-doc anchor(s) in NOT_YET docs` : ""),
  );
  if (!o.enforceRefs && missed.length > 0) {
    missed.slice(0, 5).forEach((r) => console.log(`  ${r.file}:${r.line}: ${r.doc} "${r.section}"`));
    if (missed.length > 5) console.log(`  ... ${missed.length - 5} more: node scripts/check-docs-shape.mjs --refs`);
  }
  if (errors.length > 0) {
    errors.forEach((e) => console.error(e));
    console.error(`docs shape: ${errors.length} violation(s)`);
    process.exit(1);
  }
}

main();
