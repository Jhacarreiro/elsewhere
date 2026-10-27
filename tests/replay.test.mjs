import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { buildCheckpoint, writeBundle } from "../decision-map/checkpoint-build.mjs";
import { loadBundle, materialize, readSpec, stageSandbox } from "../decision-map/replay.mjs";
import { modelCommand, probeCommand } from "../decision-map/prompt-command.mjs";

const harness = new URL("../decision-map/replay.mjs", import.meta.url).pathname;
const fakeBwrap = new URL("./fixtures/generator/fake-bwrap.sh", import.meta.url).pathname;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const commit = (dir, message) => gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", message);

// A repository whose base commit a run started from, then a later commit the replay must not see; a
// run with its plan, its start record and a file written after the checkpoint; and a bundle of it.
async function fixture() {
  const top = mkdtempSync(join(tmpdir(), "elsewhere-replay-test-"));
  const repo = join(top, "repo");
  const run = join(top, "run");
  for (const d of [repo, run]) mkdirSync(d);
  gitIn(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "base\n");
  gitIn(repo, "add", ".");
  commit(repo, "base");
  const base = gitIn(repo, "rev-parse", "HEAD");
  writeFileSync(join(run, "plan.md"), "# Plan\n");
  writeFileSync(join(run, "start.json"), `${JSON.stringify({ sourceCommit: base })}\n`);
  await pause(30);
  const at = new Date().toISOString();
  await pause(30);
  writeFileSync(join(run, "outcome.md"), "what happened after the decision\n");
  writeFileSync(join(repo, "a.txt"), "after\n");
  commit(repo, "after the decision");
  gitIn(repo, "tag", "delivered");
  const reader = createReader({ runDir: run });
  let built;
  try {
    built = buildCheckpoint({
      spec: {
        decision_id: "dec_0123456789abcdef",
        run: { run_id: "example-run-0001", round: 0 },
        stage: "implementation",
        at: { value: at, source: "artifact_field" },
        inputs: [
          { role: "repository_commit", commit: base, recorded_in: { root: "run", path: "start.json" } },
          { role: "plan", root: "run", path: "plan.md" },
        ],
        known_differences: [{ subject: "adapter version", recorded: null, replay: "v2", note: "not recorded then" }],
      },
      reader,
      repository: repo,
    });
  } finally {
    reader.close();
  }
  assert.equal(built.record.adequacy.status, "adequate", JSON.stringify(built.record.adequacy));
  const bundle = join(top, "bundle");
  writeBundle(bundle, built, [run, repo]);
  return { top, repo, run, bundle, base };
}

test("a bundle is refused when its checkpoint is not adequate or a copy changed since it was built", async () => {
  const f = await fixture();
  try {
    const loaded = loadBundle(f.bundle);
    assert.equal(loaded.commit, f.base);
    assert.deepEqual(loaded.copies.map((c) => [c.root, c.pointer]), [["run", "plan.md"]]);
    writeFileSync(join(f.bundle, "inputs", "run", "plan.md"), "# Another plan\n");
    assert.throws(() => loadBundle(f.bundle), /changed since the checkpoint was built: run:plan\.md/);
    const record = JSON.parse(readFileSync(join(f.bundle, "checkpoint.json"), "utf8"));
    record.known_differences = undefined;
    writeFileSync(join(f.bundle, "checkpoint.json"), JSON.stringify(record));
    assert.throws(() => loadBundle(f.bundle), /not adequate: .*differences since the run are not recorded/);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("materializing gives a worktree with only the checkpoint's commit and a run with only its inputs, and leaves the sources alone", async () => {
  const f = await fixture();
  try {
    const before = { head: gitIn(f.repo, "rev-parse", "HEAD"), refs: gitIn(f.repo, "for-each-ref"), status: gitIn(f.repo, "status", "--porcelain") };
    const content = join(f.top, "answer.md");
    writeFileSync(content, "\nThe owner's answer.\n");
    const out = join(f.top, "replay");
    const { dirs, change } = materialize({ bundle: loadBundle(f.bundle), repository: f.repo, out, roots: [f.run], change: { root: "run", pointer: "plan.md", mode: "append", content_file: content, note: "owner's answer" } });
    assert.equal(gitIn(dirs.worktree, "rev-parse", "HEAD"), f.base);
    assert.equal(readFileSync(join(dirs.worktree, "a.txt"), "utf8"), "base\n");
    // Nothing after the decision: no later commit, no tag, no remote to reach the original by.
    assert.equal(gitIn(dirs.worktree, "for-each-ref"), "");
    assert.equal(gitIn(dirs.worktree, "remote"), "");
    assert.equal(spawnSync("git", ["-C", dirs.worktree, "cat-file", "-e", gitIn(f.repo, "rev-parse", "delivered")]).status === 0, false);
    assert.deepEqual(readdirSync(dirs.run), ["plan.md"]);
    assert.equal(readFileSync(join(dirs.run, "plan.md"), "utf8"), "# Plan\n\nThe owner's answer.\n");
    assert.equal(change.mode, "append");
    assert.notEqual(change.before_sha256, change.after_sha256);
    assert.deepEqual(readdirSync(dirs.home), []);
    assert.deepEqual({ head: gitIn(f.repo, "rev-parse", "HEAD"), refs: gitIn(f.repo, "for-each-ref"), status: gitIn(f.repo, "status", "--porcelain") }, before);
    assert.throws(() => materialize({ bundle: loadBundle(f.bundle), repository: f.repo, out: join(f.run, "replay") , roots: [f.run] }), /must not be inside/);
    assert.throws(() => materialize({ bundle: loadBundle(f.bundle), repository: f.repo, out: join(f.top, "replay2"), change: { root: "run", pointer: "../escape", mode: "replace", content_file: content } }), /escapes its root/);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

const specFor = (over = {}) => ({
  command: ["sh", "-c", "echo stage-ran; exit 3"],
  env: { STAGE_SETTING: "recorded" },
  home: "/data",
  mounts: [
    { at: "/data/runs/example", from: "run" },
    { at: "/data/worktrees/example/integration", from: "worktree", writable: true },
    { at: "/data/.adapter", from: "adapter", writable: true },
  ],
  hide: ["/data/runs", "/data/.adapter"],
  readable: ["/opt/cli"],
  allow_hosts: ["api.anthropic.com"],
  ...over,
});

test("the stage's sandbox shows the replay's copies at the paths the run used, HOME fresh, behind the network boundary", () => {
  const spec = readSpec(specFor());
  const dirs = { worktree: "/r/worktree", run: "/r/run", adapter: "/r/adapter", home: "/r/home" };
  const { args } = modelCommand(stageSandbox(spec, dirs, { socket: "/tmp/net-allow-x/proxy.sock" }), "bwrap", ["/usr"]);
  const binds = args.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [[a, args[i + 1], args[i + 2]]] : []));
  for (const bind of [["--bind", "/r/home", "/data"], ["--ro-bind", "/r/run", "/data/runs/example"], ["--bind", "/r/worktree", "/data/worktrees/example/integration"], ["--bind", "/r/adapter", "/data/.adapter"]]) {
    assert.ok(binds.some((b) => b.join(" ") === bind.join(" ")), bind.join(" "));
  }
  // The fresh home goes first, then the hidden directories over it, then the copies over those.
  const home = args.indexOf("/r/home");
  const hidden = args.indexOf("/data/runs");
  const copy = args.indexOf("/r/run");
  assert.ok(home < hidden && hidden < copy, args.join(" "));
  assert.equal(args[args.indexOf("HOME") + 1], "/data");
  assert.ok(args.includes("--unshare-net"));
  // The probe checks the hidden directories for emptiness, except one a copy replaces outright, and
  // checks the writable copies where they are shown.
  const probeArgs = probeCommand(stageSandbox(spec, dirs, null)).cliArgs;
  const probed = probeArgs.slice(3, probeArgs.indexOf("--"));
  assert.ok(probed.includes("/data/runs") && !probed.includes("/data/.adapter"), probed.join(" "));
  assert.deepEqual(probeArgs.slice(probeArgs.indexOf("--") + 1), ["/data/worktrees/example/integration", "/data/.adapter", "/data"]);
  assert.throws(() => readSpec(specFor({ allow_hosts: [] })), /network boundary/);
  assert.throws(() => readSpec(specFor({ hide: [] })), /must hide/);
  assert.throws(() => readSpec(specFor({ mounts: [{ at: "relative", from: "run" }] })), /bad mount/);
});

test("a replay records its branch, exit, duration and logs, and the stage gets the recorded environment", async () => {
  const f = await fixture();
  try {
    const specFile = join(f.top, "spec.json");
    writeFileSync(specFile, JSON.stringify(specFor({ command: ["sh", "-c", 'echo "stage-ran $STAGE_SETTING"; exit 3'] })));
    const out = join(f.top, "replay");
    const result = spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out, "--run", f.run], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(readFileSync(join(out, "replay.json"), "utf8"));
    assert.equal(record.exit, 3);
    assert.deepEqual(record.branch, { kind: "control" });
    assert.equal(record.commit, f.base);
    assert.equal(record.known_differences[0].subject, "adapter version");
    assert.ok(record.env.includes("STAGE_SETTING") && record.duration_ms >= 0);
    assert.equal(readFileSync(join(out, "logs", "stdout.log"), "utf8"), "stage-ran recorded\n");
    // A second replay into the same directory is refused rather than mixing two outcomes.
    const again = spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.notEqual(again.status, 0);
    assert.ok(!existsSync(join(f.run, "replay")));
    // A sandbox that cannot start still leaves its record.
    const missing = join(f.top, "replay-missing");
    const failed = spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", missing], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: join(f.top, "no-such-bwrap") } });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(JSON.parse(readFileSync(join(missing, "replay.json"), "utf8")).exit, "ENOENT");
    const probeMissing = spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", join(f.top, "probe-missing"), "--probe"], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: join(f.top, "no-such-bwrap") } });
    assert.equal(probeMissing.status, 1, probeMissing.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.top, "probe-missing", "probe.json"), "utf8")).ok, false);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});
