import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { buildCheckpoint, writeBundle } from "../decision-map/checkpoint-build.mjs";
import { loadBundle, materialize, readSpec, runLogged, stageSandbox } from "../decision-map/replay.mjs";
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

test("a checkpoint from a SHA-256 repository is materialized in that object format", async () => {
  const top = mkdtempSync(join(tmpdir(), "elsewhere-replay-sha256-"));
  try {
    const repo = join(top, "repo");
    mkdirSync(repo);
    gitIn(repo, "init", "-q", "--object-format=sha256");
    writeFileSync(join(repo, "a.txt"), "base\n");
    gitIn(repo, "add", ".");
    commit(repo, "base");
    const base = gitIn(repo, "rev-parse", "HEAD");
    assert.equal(base.length, 64);
    const { dirs } = materialize({ bundle: { commit: base, copies: [] }, repository: repo, out: join(top, "replay") });
    assert.equal(gitIn(dirs.worktree, "rev-parse", "HEAD"), base);
  } finally {
    rmSync(top, { recursive: true, force: true });
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
    const result = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out, "--run", f.run], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(readFileSync(join(out, "replay.json"), "utf8"));
    assert.equal(record.exit, 3);
    assert.deepEqual(record.branch, { kind: "control" });
    assert.equal(record.commit, f.base);
    assert.equal(record.known_differences[0].subject, "adapter version");
    assert.ok(record.env.includes("STAGE_SETTING") && record.duration_ms >= 0);
    assert.equal(readFileSync(join(out, "logs", "stdout.log"), "utf8"), "stage-ran recorded\n");
    // A second replay into the same directory is refused rather than mixing two outcomes.
    const again = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.notEqual(again.status, 0);
    assert.ok(!existsSync(join(f.run, "replay")));
    // A sandbox that cannot start still leaves its record.
    const missing = join(f.top, "replay-missing");
    const failed = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", missing], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: join(f.top, "no-such-bwrap") } });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(JSON.parse(readFileSync(join(missing, "replay.json"), "utf8")).exit, "ENOENT");
    const probeMissing = spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", join(f.top, "probe-missing"), "--probe"], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: join(f.top, "no-such-bwrap") } });
    assert.equal(probeMissing.status, 1, probeMissing.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.top, "probe-missing", "probe.json"), "utf8")).ok, false);
    // A stage that exits cleanly when the timeout stops it still fails the replay.
    const slowSpec = join(f.top, "slow.json");
    writeFileSync(slowSpec, JSON.stringify(specFor({ command: ["sh", "-c", 'trap "exit 0" TERM; sleep 30 & wait'], timeout_seconds: 1 })));
    const slow = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", slowSpec, "--out", join(f.top, "replay-slow")], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.equal(slow.status, 1, slow.stderr);
    const slowRecord = JSON.parse(readFileSync(join(f.top, "replay-slow", "replay.json"), "utf8"));
    assert.equal(slowRecord.timed_out, true);
    assert.equal(slowRecord.exit, 0);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("the probe allows every copy mounted below one hidden directory, and nothing else there", () => {
  const top = mkdtempSync(join(tmpdir(), "replay-probe-"));
  try {
    const hidden = join(top, "state");
    for (const name of ["first", "second"]) mkdirSync(join(hidden, name), { recursive: true });
    const sandbox = { hide: [hidden], readable: [], writable: [], mounts: [{ from: join(top, "a"), at: join(hidden, "first"), writable: true }, { from: join(top, "b"), at: join(hidden, "second"), writable: true }] };
    const run = () => {
      const { cli, cliArgs } = probeCommand(sandbox);
      return spawnSync(cli, cliArgs, { encoding: "utf8" });
    };
    const ok = run();
    assert.match(ok.stdout, new RegExp(`hidden_empty ${hidden}`), ok.stdout);
    mkdirSync(join(hidden, "later"));
    assert.match(run().stdout, new RegExp(`hidden_not_empty ${hidden}`));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a stage stopped by its timeout leaves no delayed kill armed after it exits", async () => {
  const logs = mkdtempSync(join(tmpdir(), "replay-timeout-"));
  const kill = process.kill;
  const late = [];
  let settled = false;
  process.kill = (pid, signal) => {
    if (settled) late.push([pid, signal]);
    try { return kill.call(process, pid, signal); } catch { return false; }
  };
  try {
    const result = await runLogged({ file: "sh", args: ["-c", 'trap "exit 0" TERM; sleep 30 & wait'], env: process.env }, logs, { timeoutMs: 200, graceMs: 300 });
    settled = true;
    assert.equal(result.timedOut, true);
    // Past the grace period, nothing may signal a group id the system is free to reuse.
    await pause(600);
    assert.deepEqual(late, []);
  } finally {
    process.kill = kill;
    rmSync(logs, { recursive: true, force: true });
  }
});

test("the recorded environment reaches the stage only, never the launcher of the sandbox", async () => {
  const f = await fixture();
  try {
    // The operator's own PATH finds the launcher; a recorded PATH names a directory with another one.
    const trusted = join(f.top, "trusted");
    const recorded = join(f.top, "recorded");
    mkdirSync(trusted);
    mkdirSync(recorded);
    copyFileSync(fakeBwrap, join(trusted, "launcher"));
    execFileSync("chmod", ["+x", join(trusted, "launcher")]);
    const marker = join(f.top, "planted-launcher-ran");
    writeFileSync(join(recorded, "launcher"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const specFile = join(f.top, "spec.json");
    writeFileSync(specFile, JSON.stringify(specFor({ command: ["/bin/sh", "-c", 'echo "path=$PATH setting=$STAGE_SETTING"'], env: { STAGE_SETTING: "recorded", PATH: recorded } })));
    const out = join(f.top, "replay");
    const result = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out], { encoding: "utf8", env: { ...process.env, PATH: `${trusted}:${process.env.PATH}`, DECISION_MAP_BWRAP: "launcher" } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(marker));
    assert.equal(readFileSync(join(out, "logs", "stdout.log"), "utf8"), `path=${recorded} setting=recorded\n`);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("a stage that floods its output is cut at the limit, stopped, and fails the replay", async () => {
  const f = await fixture();
  try {
    const specFile = join(f.top, "spec.json");
    writeFileSync(specFile, JSON.stringify(specFor({ command: ["/bin/sh", "-c", "yes flood; yes err >&2"], max_output_bytes: 4096 })));
    const out = join(f.top, "replay");
    const result = spawnSync(process.execPath, [harness, "--no-limits", "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", out], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(readFileSync(join(out, "replay.json"), "utf8"));
    assert.deepEqual(record.output, { bytes: 4096, limit: 4096, truncated: true });
    assert.equal(record.timed_out, false);
    const kept = readFileSync(join(out, "logs", "stdout.log")).length + readFileSync(join(out, "logs", "stderr.log")).length;
    assert.equal(kept, 4096);
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("a stage that uses up the disk is stopped, by the space it used or the space left", async () => {
  const logs = mkdtempSync(join(tmpdir(), "replay-disk-"));
  try {
    const run = async (name, free, limits) => runLogged({ file: "sh", args: ["-c", "sleep 30"], env: process.env }, logs, { timeoutMs: 20000, name, graceMs: 300, disk: { path: logs, intervalMs: 20, free, ...limits } });
    // The stage writes 1000 bytes between checks.
    const falling = () => {
      let left = 1_000_000;
      return () => (left -= 1000) + 1000;
    };
    const byUse = await run("use-", falling(), { maxWriteBytes: 5000, minFreeBytes: 0 });
    assert.equal(byUse.diskStopped, true);
    assert.equal(byUse.timedOut, false);
    assert.ok(byUse.diskUsedBytes > 5000);
    const byFloor = await run("floor-", falling(), { maxWriteBytes: 1e12, minFreeBytes: 995_000 });
    assert.equal(byFloor.diskStopped, true);
    const quiet = await runLogged({ file: "true", args: [], env: process.env }, logs, { timeoutMs: 20000, name: "quiet-", disk: { path: logs, maxWriteBytes: 1, minFreeBytes: 0 } });
    assert.equal(quiet.diskStopped, false);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

test("materializing the commit ignores filters and attributes from the operator's own git configuration", async () => {
  const f = await fixture();
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const marker = join(f.top, "filter-ran");
    const attributes = join(f.top, "attributes");
    writeFileSync(attributes, "* filter=planted\n");
    const config = join(f.top, "gitconfig");
    writeFileSync(config, `[core]\n\tattributesFile = ${attributes}\n[filter "planted"]\n\tsmudge = sh -c 'touch ${marker}; cat'\n\trequired = true\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const { dirs } = materialize({ bundle: loadBundle(f.bundle), repository: f.repo, out: join(f.top, "replay"), roots: [f.run] });
    assert.ok(existsSync(join(dirs.worktree, ".git")));
    assert.ok(!existsSync(marker));
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("a replay runs in a cgroup with limits, or says it ran without them", async () => {
  const f = await fixture();
  try {
    const specFile = join(f.top, "spec.json");
    writeFileSync(specFile, JSON.stringify(specFor({ command: ["/bin/sh", "-c", "echo ran"], limits: { pids: 64 } })));
    const run = (out, extra) => spawnSync(process.execPath, [harness, "--bundle", f.bundle, "--repository", f.repo, "--spec", specFile, "--out", join(f.top, out), ...extra], { encoding: "utf8", env: { ...process.env, DECISION_MAP_BWRAP: fakeBwrap } });
    // Neither a cgroup nor an explicit --no-limits: refused before anything is laid out.
    const refused = run("none", []);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--cgroup/);
    assert.ok(!existsSync(join(f.top, "none")));
    // A cgroup that does not give its children the controllers is refused too.
    const parent = join(f.top, "cgroup");
    mkdirSync(parent);
    writeFileSync(join(parent, "cgroup.subtree_control"), "cpu\n");
    assert.equal(run("partial", ["--cgroup", parent]).status, 2);
    // With one, the stage starts inside it under the spec's limits and the defaults for the rest.
    writeFileSync(join(parent, "cgroup.subtree_control"), "cpu memory pids\n");
    const limited = run("limited", ["--cgroup", parent]);
    assert.equal(limited.status, 0, limited.stderr);
    const record = JSON.parse(readFileSync(join(f.top, "limited", "replay.json"), "utf8"));
    assert.deepEqual(record.limits, { pids: 64, memory_bytes: 8 * 1024 ** 3, cpus: 2, hit: null });
    const [child] = readdirSync(parent).filter((name) => name.startsWith("elsewhere-replay-"));
    assert.equal(readFileSync(join(parent, child, "pids.max"), "utf8"), "64");
    assert.equal(readFileSync(join(parent, child, "cpu.max"), "utf8"), "200000 100000");
    assert.match(readFileSync(join(parent, child, "cgroup.procs"), "utf8"), /^\d+\n$/);
    // Without, the record says so.
    const open = run("open", ["--no-limits"]);
    assert.equal(open.status, 0, open.stderr);
    const openRecord = JSON.parse(readFileSync(join(f.top, "open", "replay.json"), "utf8"));
    assert.equal(openRecord.limits, null);
    assert.ok(openRecord.known_differences.some((d) => d.subject === "resource limits"));
  } finally {
    rmSync(f.top, { recursive: true, force: true });
  }
});

test("a stage that reaches its cgroup's memory or process limit is stopped and the limit named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-cgroup-"));
  try {
    writeFileSync(join(dir, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
    writeFileSync(join(dir, "pids.events"), "max 0\n");
    const logs = join(dir, "logs");
    mkdirSync(logs);
    // The stage itself trips the limit, as the kernel's counter would.
    const result = await runLogged({ file: "sh", args: ["-c", `sleep 0.2; echo "max 3" > ${join(dir, "pids.events")}; sleep 30`], env: process.env }, logs, { timeoutMs: 20000, graceMs: 300, cgroup: dir, intervalMs: 50 });
    assert.equal(result.limitHit, "pids");
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
