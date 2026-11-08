#!/usr/bin/env node
// Generates the Flow stub dataset: WireMock mappings + bodies under sample-data/flow-stub/ and the expected figures in
// sample-data/flow/expected.json, both derived from sample-data/plan/teams.json and the contract (contract.mjs). Node >= 24, zero
// dependencies, seeded, no clock: two runs write byte-identical files (generate.test.mjs and scripts/gates.sh pin that and that the
// committed files equal a fresh run).
//
// Usage: node sample-data/flow/generate.mjs [--seed 42] [--plan sample-data/plan] [--out sample-data/flow-stub] [--expected sample-data/flow/expected.json]
//
// Only `mappings/` and `__files/` under --out are (re)written; the stub image's Dockerfile beside them is hand-written and left alone.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExpected, renderExpected } from "./expected.mjs";
import { buildStub } from "./mappings.mjs";
import { buildWorld } from "./world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { seed: 42, plan: resolve(here, "../plan"), out: resolve(here, "../flow-stub"), expected: resolve(here, "expected.json") };

/** Pure: the whole output as { mappings, files, expected, world } (filename -> text, expected as text). */
export function generate({ seed = DEFAULTS.seed, plan = DEFAULTS.plan } = {}) {
  const planTeams = JSON.parse(readFileSync(join(plan, "teams.json"), "utf8"));
  const world = buildWorld(planTeams, seed);
  const stub = buildStub(world);
  return { mappings: stub.mappings, files: stub.files, expected: renderExpected(buildExpected(world, stub.counts, planTeams)), world };
}

/** Writes the output: --out/mappings and --out/__files are replaced wholesale, the expected file overwritten. */
export function write(output, { out = DEFAULTS.out, expected = DEFAULTS.expected } = {}) {
  for (const [dir, files] of [["mappings", output.mappings], ["__files", output.files]]) {
    rmSync(join(out, dir), { recursive: true, force: true });
    mkdirSync(join(out, dir), { recursive: true });
    for (const [name, text] of files) writeFileSync(join(out, dir, name), text);
  }
  writeFileSync(expected, output.expected);
}

function main(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--seed") options.seed = Number(value);
    else if (flag === "--plan") options.plan = resolve(value);
    else if (flag === "--out") options.out = resolve(value);
    else if (flag === "--expected") options.expected = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  const output = generate(options);
  write(output, options);
  console.log(`wrote ${output.mappings.size} mappings and ${output.files.size} bodies to ${options.out}, and ${options.expected}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
