import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { buildCheckpoint, writeBundle } from "../decision-map/checkpoint-build.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// A repository with one base commit, a run and an adapter directory. The diff is taken from a real
// edit, then the edit is undone, so the repository is back at the base commit as a run leaves it.
async function fixture() {
  const top = mkdtempSync(join(tmpdir(), "elsewhere-cp-test-"));
  const repo = join(top, "repo");
  const run = join(top, "run");
  const adapter = join(top, "adapter");
  for (const d of [repo, run, join(adapter, "results")]) mkdirSync(d, { recursive: true });
  gitIn(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "alpha\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "one\n2\nthree\nfour\n");
  writeFileSync(join(repo, "b.txt"), "alpha\nbeta\n");
  const diff = gitIn(repo, "diff") + "\n";
  gitIn(repo, "checkout", "-q", "--", ".");
  writeFileSync(join(adapter, "results", "review-input.diff"), diff);
  writeFileSync(join(run, "plan.md"), "# Plan\n");
  await pause(30);
  const at = new Date().toISOString();
  await pause(30);
  writeFileSync(join(adapter, "results", "review-findings-round-1.json"), "{}\n");
  return { top, repo, run, adapter, diff, at };
}

const spec = (f, over = {}) => ({
  decision_id: "dec_0123456789abcdef",
  run: { run_id: "example-run-0001", round: 0 },
  stage: "review",
  at: { value: f.at, source: "artifact_field" },
  inputs: [
    { role: "repository_commit", ref: "HEAD" },
    { role: "working_tree_change", root: "adapter", path: "results/review-input.diff", diff_base: "HEAD", expect_stat: [{ path: "a.txt", changes: 3 }, { path: "b.txt", changes: 1 }] },
    { role: "plan", root: "run", path: "plan.md" },
  ],
  known_differences: [],
  ...over,
});

function build(f, s) {
  const reader = createReader({ runDir: f.run, adapterDir: f.adapter });
  try {
    return buildCheckpoint({ spec: s, reader, repository: f.repo });
  } finally {
    reader.close();
  }
}

test("an adequate checkpoint is bundled with its inputs, and later files beside them are excluded", async () => {
  const f = await fixture();
  const before = { head: gitIn(f.repo, "rev-parse", "HEAD"), status: gitIn(f.repo, "status", "--porcelain"), objects: gitIn(f.repo, "count-objects", "-v") };
  const built = build(f, spec(f));
  assert.equal(built.record.adequacy.status, "adequate", JSON.stringify(built.record.adequacy));
  assert.equal(built.record.inputs[0].commit, before.head);
  assert.deepEqual(built.record.excluded, [{ root: "adapter", pointer: "results/review-findings-round-1.json", reason: "written_after_checkpoint" }]);
  const out = join(f.top, "bundle");
  writeBundle(out, built, [f.run, f.adapter, f.repo]);
  assert.equal(readFileSync(join(out, "inputs", "adapter", "results", "review-input.diff"), "utf8"), f.diff);
  assert.ok(existsSync(join(out, "inputs", "run", "plan.md")));
  assert.equal(JSON.parse(readFileSync(join(out, "checkpoint.json"), "utf8")).id, built.record.id);
  // Read-only: the repository is exactly as it was, with no new objects and no index change.
  assert.deepEqual({ head: gitIn(f.repo, "rev-parse", "HEAD"), status: gitIn(f.repo, "status", "--porcelain"), objects: gitIn(f.repo, "count-objects", "-v") }, before);
});

test("a diff cut off mid-change is incomplete, and the bundle holds only the report", async () => {
  const f = await fixture();
  const cut = f.diff.slice(0, f.diff.indexOf("+four") - 1);
  writeFileSync(join(f.adapter, "results", "cut.diff"), cut);
  await pause(30);
  const s = spec(f, { at: { value: new Date().toISOString(), source: "artifact_field" } });
  s.inputs[1] = { ...s.inputs[1], path: "results/cut.diff" };
  const built = build(f, s);
  assert.equal(built.record.adequacy.status, "inadequate");
  const [failure] = built.record.adequacy.failed;
  assert.equal(failure.pointer, "results/cut.diff");
  assert.match(failure.reason, /^incomplete: /);
  const out = join(f.top, "bundle");
  writeBundle(out, built, [f.run, f.adapter, f.repo]);
  assert.deepEqual(readdirSync(out), ["checkpoint.json"]);
});

test("a diff that applies but lacks a file the stage recorded is incomplete", async () => {
  const f = await fixture();
  const onlyA = f.diff.slice(0, f.diff.indexOf("diff --git a/b.txt"));
  writeFileSync(join(f.adapter, "results", "only-a.diff"), onlyA);
  await pause(30);
  const s = spec(f, { at: { value: new Date().toISOString(), source: "artifact_field" } });
  s.inputs[1] = { ...s.inputs[1], path: "results/only-a.diff" };
  const { record } = build(f, s);
  assert.deepEqual(record.adequacy.failed.map((x) => x.reason), ["incomplete: its changed lines per path do not match the 2 path(s) the stage recorded"]);
});

test("a diff cut between two hunks of one file is incomplete, though it applies and names every path", async () => {
  const f = await fixture();
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(f.repo, "c.txt"), long);
  gitIn(f.repo, "add", "c.txt");
  gitIn(f.repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c");
  writeFileSync(join(f.repo, "c.txt"), long.replace("line 1\n", "line one\n").replace("line 28\n", "line twenty-eight\n"));
  const diff = gitIn(f.repo, "diff", "-U1") + "\n";
  gitIn(f.repo, "checkout", "-q", "--", ".");
  const firstHunk = diff.slice(0, diff.lastIndexOf("@@ -"));
  writeFileSync(join(f.adapter, "results", "one-hunk.diff"), firstHunk);
  await pause(30);
  const s = spec(f, { at: { value: new Date().toISOString(), source: "artifact_field" } });
  s.inputs[1] = { ...s.inputs[1], path: "results/one-hunk.diff", expect_stat: [{ path: "c.txt", changes: 4 }] };
  const { record } = build(f, s);
  assert.deepEqual(record.adequacy.failed.map((x) => x.reason), ["incomplete: its changed lines per path do not match the 1 path(s) the stage recorded"]);
});

test("paths git quotes, such as non-ASCII names, are compared as git reads them", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "café.txt"), "x\n");
  gitIn(f.repo, "add", "-N", "café.txt");
  const diff = gitIn(f.repo, "diff");
  gitIn(f.repo, "rm", "-q", "--cached", "café.txt");
  rmSync(join(f.repo, "café.txt"));
  assert.match(diff, /"b\/caf\\303\\251\.txt"/);
  writeFileSync(join(f.adapter, "results", "quoted.diff"), diff + "\n");
  await pause(30);
  const s = spec(f, { at: { value: new Date().toISOString(), source: "artifact_field" } });
  s.inputs[1] = { ...s.inputs[1], path: "results/quoted.diff", expect_stat: [{ path: "café.txt", changes: 1 }] };
  assert.equal(build(f, s).record.adequacy.status, "adequate");
});

test("without recorded change counts a diff's completeness stays unproven", async () => {
  const f = await fixture();
  const s = spec(f);
  const { expect_stat, ...noStat } = s.inputs[1];
  s.inputs[1] = noStat;
  const { record } = build(f, s);
  assert.deepEqual(record.adequacy.failed.map((x) => x.reason), ["incomplete: no recorded change counts to check it against"]);
});

test("an input written after the checkpoint time cannot be part of it", async () => {
  const f = await fixture();
  const s = spec(f);
  s.inputs.push({ role: "stage_context", root: "adapter", path: "results/review-findings-round-1.json" });
  const { record } = build(f, s);
  assert.equal(record.adequacy.status, "inadequate");
  assert.ok(record.adequacy.failed.some((x) => x.pointer === "results/review-findings-round-1.json" && x.reason === "written at or after the checkpoint time"));
});

test("a commit the repository does not have leaves no code to start from", async () => {
  const f = await fixture();
  const s = spec(f);
  s.inputs[0] = { role: "repository_commit", ref: "f".repeat(40) };
  s.inputs[1] = { ...s.inputs[1], diff_base: "f".repeat(40) };
  const { record } = build(f, s);
  const reasons = record.adequacy.failed.map((x) => x.reason);
  assert.ok(reasons.includes("no full commit id"));
  assert.ok(reasons.includes("incomplete: its base commit is not an input"));
});

test("the bundle is never written inside a run, adapter or repository root", async () => {
  const f = await fixture();
  const built = build(f, spec(f));
  for (const inside of [join(f.run, "bundle"), join(f.adapter, "results", "bundle"), join(f.repo, "bundle")]) {
    assert.throws(() => writeBundle(inside, built, [f.run, f.adapter, f.repo]), /must not be inside/);
    assert.equal(existsSync(inside), false);
  }
});

test("the bundle is readable only by its owner, even under a permissive umask", async () => {
  const f = await fixture();
  const built = build(f, spec(f));
  const out = join(f.top, "bundle");
  const previous = process.umask(0o000);
  try {
    writeBundle(out, built, [f.run, f.adapter, f.repo]);
  } finally {
    process.umask(previous);
  }
  for (const dir of [out, join(out, "inputs"), join(out, "inputs", "adapter", "results")]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  for (const file of [join(out, "checkpoint.json"), join(out, "inputs", "adapter", "results", "review-input.diff")]) assert.equal(statSync(file).mode & 0o777, 0o600, file);
});

test("a working-tree change without a base commit is never taken as complete", async () => {
  const f = await fixture();
  const s = spec(f);
  const { diff_base, expect_stat, ...bare } = s.inputs[1];
  s.inputs[1] = bare;
  const { record } = build(f, s);
  assert.deepEqual(record.adequacy.failed.map((x) => x.reason), ["incomplete: no base commit to check it against"]);
});

test("a file input from the repository root is refused, since its commit already captures it", async () => {
  const f = await fixture();
  const s = spec(f);
  s.inputs.push({ role: "plan", root: "repository", path: "a.txt" });
  assert.throws(() => build(f, s), /file inputs must be rooted at run or adapter/);
});
