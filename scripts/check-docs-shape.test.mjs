// Self-test of scripts/check-docs-shape.mjs (node built-ins only: `node --test scripts/check-docs-shape.test.mjs`). Each case builds a
// small tree in a temporary directory and runs the script against it with `--root` (and `--not-yet` / `--enforce-refs`, the test knobs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-docs-shape.mjs");
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A tree: `docs` are .claude/docs/<name>, `extra` any other path. CLAUDE.md gets a table row per doc unless given in `extra`. */
function tree({ docs = {}, extra = {} }) {
  const root = mkdtempSync(join(tmpdir(), "docs-shape-"));
  made.push(root);
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  for (const [name, text] of Object.entries(docs)) put(`.claude/docs/${name}`, text);
  const rows = Object.keys(docs).map((n) => `| \`.claude/docs/${n}\` | something |`);
  put("CLAUDE.md", `# CLAUDE.md\n\nShort.\n\n| Doc | Read before you touch |\n|---|---|\n${rows.join("\n")}\n`);
  for (const [rel, text] of Object.entries(extra)) put(rel, text);
  return root;
}

function run(root, ...args) {
  // An empty NOT_YET unless the case names one: the real list describes the real tree.
  const notYet = args.includes("--not-yet") ? [] : ["--not-yet", ""];
  const r = spawnSync(process.execPath, [script, "--root", root, ...notYet, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const bigSection = (bytes) => `${"x".repeat(79)}\n`.repeat(Math.ceil(bytes / 80));

describe("limit 1: a line", () => {
  const long = "word ".repeat(130); // 650 characters
  it("fails outside a fence", () => {
    const r = run(tree({ docs: { "a.md": `# A\n\n${long}\n` } }));
    assert.equal(r.code, 1);
    assert.match(r.out, /a\.md:3: \[limit 1\]/);
  });
  it("passes inside a fence", () => {
    const r = run(tree({ docs: { "a.md": `# A\n\n\`\`\`\n${long}\n\`\`\`\n` } }));
    assert.equal(r.code, 0, r.out);
  });
  it("passes at exactly 600 characters", () => {
    assert.equal(run(tree({ docs: { "a.md": `# A\n\n${"y".repeat(600)}\n` } })).code, 0);
    assert.equal(run(tree({ docs: { "a.md": `# A\n\n${"y".repeat(601)}\n` } })).code, 1);
  });
});

describe("limit 2: a section", () => {
  it("fails over 8,000 bytes and passes under", () => {
    const over = run(tree({ docs: { "a.md": `# A\n\n## Big\n\n${bigSection(8100)}` } }));
    assert.equal(over.code, 1);
    assert.match(over.out, /\[limit 2\].*under "Big"/);
    assert.equal(run(tree({ docs: { "a.md": `# A\n\n## Fine\n\n${bigSection(7000)}` } })).code, 0);
  });
  it("counts two small sections separately", () => {
    const text = `# A\n\n## One\n\n${bigSection(6000)}\n## Two\n\n${bigSection(6000)}`;
    assert.equal(run(tree({ docs: { "a.md": text } })).code, 0);
  });
  it("measures Rules through its sub-sections", () => {
    const text = `# A\n\n## Rules\n\n### One\n\n${bigSection(5000)}\n### Two\n\n${bigSection(5000)}\n## Next\n\nx\n`;
    const r = run(tree({ docs: { "a.md": text } }));
    assert.equal(r.code, 1);
    assert.match(r.out, /"Rules" with its sub-sections/);
  });
});

describe("limit 3: a release tag in a heading", () => {
  it("fails in a doc, passes in product.md", () => {
    const text = "# T\n\n## Home page (1.10)\n\nx\n\n## Release v0.8.0 notes\n\nx\n";
    const r = run(tree({ docs: { "a.md": text } }));
    assert.equal(r.code, 1);
    assert.equal((r.out.match(/\[limit 3\]/g) ?? []).length, 2);
    assert.equal(run(tree({ docs: { "product.md": text } })).code, 0);
  });
  it("lets a non-release number through", () => {
    assert.equal(run(tree({ docs: { "a.md": "# T\n\n## Keep it 3.0-compatible\n\nx\n" } })).code, 0);
  });
});

describe("limit 4: Rules first", () => {
  const sections = (n) => Array.from({ length: n }, (_, i) => `## Part ${i}\n\n${bigSection(7000)}`).join("\n");
  it("fails a doc over 30,000 bytes whose first ## is not Rules", () => {
    const r = run(tree({ docs: { "a.md": `# A\n\n${sections(5)}` } }));
    assert.equal(r.code, 1);
    assert.match(r.out, /\[limit 4\].*"Part 0"/);
  });
  it("passes with Rules as the first ##", () => {
    const r = run(tree({ docs: { "a.md": `# A\n\n## Rules\n\n- one\n\n${sections(5)}` } }));
    assert.equal(r.code, 0, r.out);
  });
  it("exempts product.md and web-internals.md, and leaves a small doc alone", () => {
    for (const name of ["product.md", "web-internals.md"]) assert.equal(run(tree({ docs: { [name]: `# A\n\n${sections(5)}` } })).code, 0);
    assert.equal(run(tree({ docs: { "a.md": "# A\n\n## Part\n\nx\n" } })).code, 0);
  });
});

describe("limit 5: a parked move", () => {
  it("fails a ## To place heading", () => {
    const r = run(tree({ docs: { "a.md": "# A\n\n## To place (from timeline.md)\n\nx\n" } }));
    assert.equal(r.code, 1);
    assert.match(r.out, /\[limit 5\]/);
  });
});

describe("NOT_YET", () => {
  const bad = "# A\n\n" + "word ".repeat(130) + "\n";
  it("skips a listed file that fails", () => {
    const r = run(tree({ docs: { "a.md": bad } }), "--not-yet", ".claude/docs/a.md");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 still in NOT_YET/);
  });
  it("fails a listed file that passes", () => {
    const r = run(tree({ docs: { "a.md": "# A\n\nfine\n" } }), "--not-yet", ".claude/docs/a.md");
    assert.equal(r.code, 1);
    assert.match(r.out, /remove it from NOT_YET/);
  });
  it("fails an entry that names no file", () => {
    const r = run(tree({ docs: { "a.md": "# A\n\nfine\n" } }), "--not-yet", ".claude/docs/gone.md");
    assert.equal(r.code, 1);
    assert.match(r.out, /gone\.md.*remove the entry/);
  });
  it("is ignored by --only", () => {
    const root = tree({ docs: { "a.md": bad } });
    const r = run(root, "--only", ".claude/docs/a.md", "--not-yet", ".claude/docs/a.md");
    assert.equal(r.code, 1);
    assert.match(r.out, /\[limit 1\]/);
    assert.equal(run(tree({ docs: { "a.md": "# A\n\nfine\n" } }), "--only", "a.md").code, 0);
  });
});

describe("limit 6: CLAUDE.md's table", () => {
  it("fails a missing row", () => {
    const root = tree({ docs: { "a.md": "# A\n\nx\n", "b.md": "# B\n\nx\n" }, extra: { "CLAUDE.md": "# C\n\n| Doc | When |\n|---|---|\n| `.claude/docs/a.md` | x |\n" } });
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /no row for \.claude\/docs\/b\.md/);
  });
  it("fails a row that names no on-demand doc, and does not ask for an @ import", () => {
    const claude = "# C\n\n@.claude/docs/imp.md\n\n| Doc | When |\n|---|---|\n| `.claude/docs/a.md` | x |\n| `.claude/docs/ghost.md` | x |\n";
    const root = tree({ docs: { "a.md": "# A\n\nx\n", "imp.md": "### Imp\n\nx\n" }, extra: { "CLAUDE.md": claude } });
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /names \.claude\/docs\/ghost\.md/);
    assert.doesNotMatch(r.out, /no row for/);
  });
});

describe("limit 7: in-doc anchors", () => {
  it("fails an anchor that names no heading and passes one that does", () => {
    const r = run(tree({ docs: { "a.md": "# A\n\n[x](#nowhere)\n\n## Real `thing` (here)\n\n[ok](#real-thing-here)\n" } }));
    assert.equal(r.code, 1);
    assert.match(r.out, /a\.md:3: \[limit 7\] anchor #nowhere/);
    assert.doesNotMatch(r.out, /real-thing-here/);
  });
  it("ignores an anchor inside code", () => {
    assert.equal(run(tree({ docs: { "a.md": "# A\n\n`[x](#nowhere)`\n\n```\n[y](#nowhere)\n```\n" } })).code, 0);
  });
});

describe("limit 8: section references", () => {
  const target = "# T\n\n## View validators (the ten)\n\nx\n\n## Caching\n\nx\n";
  it("fails a reference to a missing heading (ENFORCE_REFS is on)", () => {
    const root = tree({ docs: { "t.md": target, "r.md": '# R\n\nSee `t.md` "Nothing like it".\n' } });
    const hard = run(root);
    assert.equal(hard.code, 1);
    assert.match(hard.out, /r\.md:3: \[limit 8\]/);
  });
  it("resolves an exact heading and the beginning of one, case- and whitespace-insensitively", () => {
    const refs = '`t.md` "Caching" and t.md "view  VALIDATORS" and `t.md`, "View validators (the ten)"\n';
    const root = tree({ docs: { "t.md": target }, extra: { "notes.md": refs } });
    const r = run(root, "--enforce-refs");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /3 section references, 0 unresolved/);
  });
  it("resolves a reference broken across a KDoc line", () => {
    const kt = '/**\n * Rule in t.md\n * "Caching" and in `t.md` "View\n * validators".\n */\nclass A\n';
    const root = tree({ docs: { "t.md": target }, extra: { "server/A.kt": kt } });
    const r = run(root, "--enforce-refs");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 section references, 0 unresolved/);
  });
  it('resolves a bare `web-internals "…"` reference', () => {
    const webClaude = '# Web\n\nMechanics: web-internals "Transport and session layer". Gone: web-internals "Never existed".\n';
    const root = tree({ docs: { "web-internals.md": "# W\n\n## Transport and session layer\n\nx\n" }, extra: { "web/CLAUDE.md": webClaude } });
    const r = run(root, "--refs");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /web\/CLAUDE\.md:3: web-internals\.md "Never existed" UNRESOLVED/);
    assert.match(r.out, /1 reference\(s\) unresolved, 1 unresolved/);
    assert.doesNotMatch(r.out, /Transport and session layer/);
  });
  it("lists every reference into a doc with --refs --into, resolved or not", () => {
    const root = tree({ docs: { "t.md": target }, extra: { "x.md": '`t.md` "Caching" `t.md` "Missing"\n' } });
    const r = run(root, "--refs", "--into", "t.md");
    assert.equal(r.code, 0);
    assert.match(r.out, /x\.md:1: t\.md "Caching" ok/);
    assert.match(r.out, /x\.md:1: t\.md "Missing" UNRESOLVED/);
    assert.match(r.out, /2 reference\(s\) into t\.md, 1 unresolved/);
  });
  it("skips this script's own text and unknown documents", () => {
    const root = tree({
      docs: { "t.md": target },
      extra: { "scripts/check-docs-shape.test.mjs": '`t.md` "Missing"\n', "x.md": 'other.md "Whatever" and README.md "Missing"\n' },
    });
    assert.match(run(root).out, /0 unresolved/);
  });
});

describe("--report", () => {
  it("lists every file, the failing limits, and the NOT_YET candidate list, and never fails", () => {
    const root = tree({ docs: { "a.md": "# A\n\n" + "word ".repeat(130) + "\n", "b.md": "# B\n\nfine\n" } });
    const r = run(root, "--report");
    assert.equal(r.code, 0);
    assert.match(r.out, /\.claude\/docs\/a\.md\s+\d+ B\s+L1x1\s+NOT LISTED/);
    assert.match(r.out, /\.claude\/docs\/b\.md\s+\d+ B\s+passes/);
    assert.match(r.out, /1 of 3 covered files fail limits 1-5/);
  });
});
