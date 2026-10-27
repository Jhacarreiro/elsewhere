// Replay harness (Phase 3 step 3). Runs one stage again from an adequate checkpoint bundle, in a fresh
// copy of everything the stage consumed, inside the sandbox adapter's bwrap sandbox and behind its
// network boundary, and records what happened. It never writes to the run, the adapter state or the
// repository it reads from: the copies live under --out, which must be outside all of them.
//
//   node decision-map/replay.mjs --bundle <dir> --repository <git-dir> --spec <spec.json> --out <dir> [--change <change.json>] [--probe]
//
// Materializing, under --out:
//   worktree/  a new repository holding only the checkpoint's commit and its history: fetched by id,
//              with no remote and no other refs, so nothing after the decision is in it;
//   run/       the checkpoint's run inputs at their pointers, and nothing else of the run;
//   adapter/   the checkpoint's adapter inputs at their pointers, in otherwise empty adapter state;
//   home/      an empty home directory;
//   logs/      the stage's stdout and stderr and the proxy's tunnel log;
//   replay.json  the record of the replay (written last, also when the stage fails).
//
// The spec says how the stage is run and where it expects its inputs. Each mount shows one of those
// directories at a path the original stage used, so its prompt and configuration, which name those
// paths, stay byte for byte what the run recorded:
//
//   { "command": [argv...], "env": { recorded variables }, "pass_env": [names taken from here],
//     "home": "/path", "mounts": [{ "at": "/path", "from": "worktree|run|adapter|home", "writable": bool }],
//     "hide": [...], "readable": [...], "allow_hosts": [...], "timeout_seconds": n,
//     "max_output_bytes": n, "max_write_bytes": n, "min_free_bytes": n, "max_files": n,
//     "limits": { "pids": n, "memory_bytes": n, "cpus": n }, "known_differences": [{ "subject", "recorded", "replay", "note" }] }
//
// A branch is the checkpoint plus one recorded change (--change): { "root": "run|adapter",
// "pointer": "...", "mode": "replace|append", "content_file": "/path", "note": "..." }, applied to the
// copy before the stage starts. Without it the replay is a control.
//
// --probe runs the sandbox adapter's probe in the same sandbox, mounts and network boundary instead
// of the stage, so the isolation can be proven before any model runs.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assessCheckpoint } from "./checkpoint.mjs";
import { startAllowProxy } from "./net-allow.mjs";
import { modelCommand, modelEnv, networkProbeCommand, probeCommand } from "./prompt-command.mjs";

export const HARNESS = { name: "elsewhere-replay-harness", version: "0.1.0" };
const FROM = new Set(["worktree", "run", "adapter", "home"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function within(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Reads a checkpoint bundle and refuses it unless its recomputed adequacy is adequate and every copy
 * in it still has the hash the record gives.
 * @returns {{record: object, copies: {root: string, pointer: string, path: string}[], commit: string}}
 */
export function loadBundle(dir) {
  const record = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
  const assessed = assessCheckpoint(record);
  if (assessed.adequacy.status !== "adequate") {
    throw new Error(`checkpoint is not adequate: ${assessed.adequacy.failed.map((f) => `${f.pointer ?? f.role}: ${f.reason}`).join("; ")}`);
  }
  const copies = [];
  let commit = null;
  for (const input of record.inputs) {
    if (input.role === "repository_commit") {
      if (commit && commit !== input.commit) throw new Error("the harness replays from one repository commit");
      commit = input.commit;
      continue;
    }
    const path = join(dir, "inputs", input.root, input.pointer);
    if (!within(path, join(dir, "inputs"))) throw new Error(`input pointer escapes the bundle: ${input.pointer}`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== input.sha256) throw new Error(`bundle copy changed since the checkpoint was built: ${input.root}:${input.pointer}`);
    copies.push({ root: input.root, pointer: input.pointer, path });
  }
  return { record, copies, commit };
}

// Git runs on the host, before the sandbox and the proxy exist, so it runs without the operator's
// system and global configuration or any GIT_ variables: a filter, hook or credential helper named
// there (Git LFS, say) would otherwise act on what the checkpoint's commit asks for, with the host's
// network. A checkout then writes the files as they are in the commit.
function git(args, cwd, { raw = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" });
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, maxBuffer });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.code || result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return raw ? result.stdout : result.stdout.trim();
}

function applyChange(dirs, change) {
  if (!["run", "adapter"].includes(change.root) || typeof change.pointer !== "string" || !change.pointer) throw new Error("a change needs a run or adapter root and a pointer");
  if (!["replace", "append"].includes(change.mode)) throw new Error("a change's mode is replace or append");
  const target = join(dirs[change.root], change.pointer);
  if (!within(target, dirs[change.root]) || target === dirs[change.root]) throw new Error(`change pointer escapes its root: ${change.pointer}`);
  const content = readFileSync(change.content_file);
  const before = existsSync(target) ? readFileSync(target) : null;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, change.mode === "append" && before ? Buffer.concat([before, content]) : content, { mode: 0o600 });
  return {
    root: change.root,
    pointer: change.pointer,
    mode: change.mode,
    content_sha256: sha256(content),
    before_sha256: before ? sha256(before) : null,
    after_sha256: sha256(readFileSync(target)),
    note: change.note ?? null,
  };
}

/**
 * Lays out a fresh copy of the checkpoint under out. The repository is only read from.
 * @returns {{dirs: object, change: object|null}}
 */
// Laying out the copies runs on the host before the stage's disk watch or cgroup exist, so everything
// it will write is measured first, from the source: the commit's history as it is stored there, the
// files of its tree, the run and adapter inputs and the recorded change. More than maxWriteBytes in
// all, more than maxFiles files, or less than minFreeBytes left afterwards, and nothing is written.
export const DEFAULT_MAX_FILES = 1_000_000;

function layoutFits({ repository, commit, copies, change, out, maxWriteBytes, minFreeBytes, maxFiles, free = freeBytes }) {
  const history = Number(git(["rev-list", "--objects", "--disk-usage", commit], repository));
  // Only each entry's size, about ten bytes a file, so the limit's worth of files fits the buffer; a
  // listing too long for it is a tree past the limit anyway.
  let sizes;
  try {
    sizes = git(["ls-tree", "-r", "-z", "--format=%(objectsize)", commit], repository, { raw: true, maxBuffer: 32 * Math.max(maxFiles, 1) + 1024 }).split("\0").filter(Boolean);
  } catch (err) {
    if (/ENOBUFS|maxBuffer/.test(err.message)) throw new Error(`the checkpoint's commit has more files than the limit of ${maxFiles}`);
    throw err;
  }
  const tree = sizes.reduce((sum, size) => sum + (Number(size) || 0), 0);
  const inputs = copies.reduce((sum, copy) => sum + statSync(copy.path).size, 0);
  const changed = change?.content_file ? statSync(change.content_file).size : 0;
  const files = sizes.length + copies.length;
  const bytes = history + tree + inputs + changed;
  const parts = `history ${history}, files ${tree}, inputs ${inputs}, change ${changed}`;
  if (files > maxFiles) throw new Error(`the checkpoint has ${files} files, more than the limit of ${maxFiles}`);
  if (bytes > maxWriteBytes) throw new Error(`laying out the checkpoint takes ${bytes} bytes (${parts}), more than the limit of ${maxWriteBytes}`);
  if (free(dirname(out)) - bytes < minFreeBytes) throw new Error(`laying out the checkpoint (${bytes} bytes) would leave less than ${minFreeBytes} bytes free`);
}

/**
 * Lays out a fresh copy of the checkpoint under out. The repository is only read from.
 * @returns {{dirs: object, change: object|null}}
 */
export function materialize({ bundle, repository, out, roots = [], change = null, disk = {} }) {
  const limits = { maxWriteBytes: DEFAULT_MAX_WRITE_BYTES, minFreeBytes: DEFAULT_MIN_FREE_BYTES, maxFiles: DEFAULT_MAX_FILES, ...disk };
  const target = join(realpathSync(dirname(resolve(out))), basename(resolve(out)));
  for (const root of [repository, ...roots].filter(Boolean)) {
    if (within(target, realpathSync(root))) throw new Error("--out must not be inside the run, adapter or repository it replays from");
  }
  layoutFits({ repository: resolve(repository), commit: bundle.commit, copies: bundle.copies, change, out: target, ...limits });
  mkdirSync(target, { mode: 0o700 });
  const dirs = Object.fromEntries(["worktree", "run", "adapter", "home", "logs"].map((name) => [name, join(target, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  // Only the commit and its history: no remote to push to or fetch from, no refs past it.
  // In the source's own object format, so a SHA-256 commit id can be fetched.
  git(["init", "-q", `--object-format=${git(["rev-parse", "--show-object-format"], resolve(repository))}`], dirs.worktree);
  git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", resolve(repository), bundle.commit], dirs.worktree);
  git(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", bundle.commit], dirs.worktree);
  if (git(["rev-parse", "HEAD"], dirs.worktree) !== bundle.commit) throw new Error("the worktree is not at the checkpoint's commit");
  if (git(["for-each-ref", "--format=%(refname)"], dirs.worktree)) throw new Error("the worktree has refs besides HEAD");
  for (const copy of bundle.copies) {
    const dest = join(dirs[copy.root], copy.pointer);
    if (!within(dest, dirs[copy.root])) throw new Error(`input pointer escapes its root: ${copy.pointer}`);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, readFileSync(copy.path), { flag: "wx", mode: 0o600 });
  }
  return { dirs, change: change ? applyChange(dirs, change) : null };
}

export function readSpec(spec) {
  if (!Array.isArray(spec.command) || !spec.command.length || !spec.command.every((a) => typeof a === "string")) throw new Error("the spec needs a command");
  if (!isAbsolute(spec.home || "")) throw new Error("the spec needs an absolute home");
  for (const m of spec.mounts || []) {
    if (!FROM.has(m.from) || !isAbsolute(m.at || "")) throw new Error(`bad mount: ${JSON.stringify(m)}`);
  }
  if (!(spec.hide || []).length) throw new Error("the spec must hide something: the run's own state at least");
  if (!(spec.allow_hosts || []).length) throw new Error("the spec needs the providers' hosts: a replay always runs behind the network boundary");
  return {
    command: spec.command,
    env: spec.env || {},
    passEnv: spec.pass_env || [],
    home: spec.home,
    mounts: spec.mounts || [],
    hide: spec.hide.map((d) => resolve(d)),
    readable: (spec.readable || []).map((d) => resolve(d)),
    allow: spec.allow_hosts,
    timeoutMs: (Number(spec.timeout_seconds) > 0 ? Number(spec.timeout_seconds) : 4 * 3600) * 1000,
    maxOutputBytes: Number(spec.max_output_bytes) > 0 ? Number(spec.max_output_bytes) : DEFAULT_MAX_OUTPUT_BYTES,
    maxWriteBytes: Number(spec.max_write_bytes) > 0 ? Number(spec.max_write_bytes) : DEFAULT_MAX_WRITE_BYTES,
    minFreeBytes: Number(spec.min_free_bytes) > 0 ? Number(spec.min_free_bytes) : DEFAULT_MIN_FREE_BYTES,
    maxFiles: Number(spec.max_files) > 0 ? Number(spec.max_files) : DEFAULT_MAX_FILES,
    limits: { ...DEFAULT_LIMITS, ...(spec.limits || {}) },
    knownDifferences: spec.known_differences || [],
  };
}

// The sandbox for the stage: the spec's hidden and readable directories, its mounts pointing at this
// replay's copies, HOME at the spec's home (the fresh home is mounted there), and the network boundary.
export function stageSandbox(spec, dirs, network, cli = spec.command[0], cliArgs = spec.command.slice(1)) {
  const mounts = [
    ...spec.mounts.map((m) => ({ from: dirs[m.from], at: m.at, writable: m.writable === true })),
    ...(spec.mounts.some((m) => m.from === "home" && m.at === spec.home) ? [] : [{ from: dirs.home, at: spec.home, writable: true }]),
  ];
  return { cli, cliArgs, hide: spec.hide, readable: spec.readable, writable: [], mounts, home: spec.home, network };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

// Resource limits. The stage runs in a cgroup of its own, made under one the operator delegates to the
// harness (--cgroup), with a cap on its processes, its memory (and no swap) and its CPU time; whatever
// it starts stays in that cgroup. Without --cgroup the replay is refused, unless the operator passes
// --no-limits, which the record keeps as a known difference.
export const DEFAULT_LIMITS = { pids: 4096, memory_bytes: 8 * 1024 * 1024 * 1024, cpus: 2 };
const CGROUP_CONTROLLERS = ["pids", "memory", "cpu"];

export function makeCgroup(parent, limits) {
  const delegated = readFileSync(join(parent, "cgroup.subtree_control"), "utf8").split(/\s+/);
  for (const controller of CGROUP_CONTROLLERS) {
    if (!delegated.includes(controller)) throw new Error(`the cgroup ${parent} does not give its children the ${controller} controller`);
  }
  const dir = mkdtempSync(join(parent, "elsewhere-replay-"));
  writeFileSync(join(dir, "pids.max"), String(limits.pids));
  writeFileSync(join(dir, "memory.max"), String(limits.memory_bytes));
  if (existsSync(join(dir, "memory.swap.max"))) writeFileSync(join(dir, "memory.swap.max"), "0");
  writeFileSync(join(dir, "cpu.max"), `${Math.round(limits.cpus * 100000)} 100000`);
  return dir;
}

const eventCount = (file, key) => {
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${key} `));
    return line ? Number(line.split(" ")[1]) : 0;
  } catch {
    return 0;
  }
};

export function cgroupLimitHit(dir) {
  if (eventCount(join(dir, "memory.events"), "oom_kill") > 0) return "memory";
  if (eventCount(join(dir, "pids.events"), "max") > 0) return "pids";
  return null;
}

export function closeCgroup(dir) {
  try {
    writeFileSync(join(dir, "cgroup.kill"), "1");
  } catch {
    // an older kernel; the process group was killed already
  }
  // The kernel empties a killed cgroup shortly after; it can only be removed once empty.
  for (let i = 0; i < 50; i += 1) {
    try {
      rmdirSync(dir);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// The stage's argv, started inside the cgroup: a shell moves itself in and then becomes the sandbox.
export function inCgroup(dir, { file, args }) {
  return { file: "/bin/sh", args: ["-c", 'echo $$ > "$0/cgroup.procs" || exit 125; exec "$@"', dir, file, ...args] };
}

// The stage's output goes to its logs through the harness, which counts it: past maxOutputBytes (both
// streams together) the rest is dropped and the stage is stopped as on a timeout, so a stage that
// floods its output cannot fill the operator's disk.
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// What the stage writes to its writable copies and its home lands on the operator's disk too. With disk
// set, the harness watches the free space where they are, every second: once the stage has used more
// than maxWriteBytes of it, or less than minFreeBytes is left, the stage is stopped. A second is long
// enough for a fast writer to pass the limit by some way, so the floor keeps a margin; an operator
// replaying a stage they do not trust puts the output directory on a filesystem with its own quota.
export const DEFAULT_MAX_WRITE_BYTES = 16 * 1024 * 1024 * 1024;
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const freeBytes = (path) => {
  const fs = statfsSync(path);
  return fs.bavail * fs.bsize;
};

export function runLogged({ file, args, env }, logs, { timeoutMs, name = "", graceMs = 30000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, disk = null, cgroup = null, intervalMs = 1000 }) {
  return new Promise((done) => {
    const out = openSync(join(logs, `${name}stdout.log`), "wx", 0o600);
    const err = openSync(join(logs, `${name}stderr.log`), "wx", 0o600);
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env });
    let timedOut = false;
    let truncated = false;
    let written = 0;
    let killTimer = null;
    const stop = () => {
      if (killTimer) return;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    let diskStopped = false;
    let used = 0;
    let watch = null;
    let sampleDisk = () => {};
    if (disk) {
      const free = disk.free || freeBytes;
      const start = free(disk.path);
      sampleDisk = () => {
        const now = free(disk.path);
        used = Math.max(used, start - now);
        if (!diskStopped && (used > disk.maxWriteBytes || now < disk.minFreeBytes)) {
          diskStopped = true;
          stop();
        }
      };
      watch = setInterval(sampleDisk, disk.intervalMs || 1000);
      watch.unref();
    }
    // A stage in a cgroup that reached its memory or process limit is stopped rather than left to
    // limp on, and the record says which limit it was.
    let limitHit = null;
    let limitWatch = null;
    if (cgroup) {
      limitWatch = setInterval(() => {
        const hit = cgroupLimitHit(cgroup);
        if (hit && !limitHit) {
          limitHit = hit;
          stop();
        }
      }, intervalMs);
      limitWatch.unref();
    }
    const keep = (fd) => (chunk) => {
      const room = maxOutputBytes - written;
      if (chunk.length > room) {
        if (room > 0) writeSync(fd, chunk, 0, room);
        written = maxOutputBytes;
        if (!truncated) {
          truncated = true;
          stop();
        }
        return;
      }
      writeSync(fd, chunk);
      written += chunk.length;
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    // A child that cannot start emits both error and close; the outcome is settled once.
    let settled = false;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      clearInterval(limitWatch);
      // A stage that went past a limit and exited between two checks is caught here, not let through.
      sampleDisk();
      if (cgroup && !limitHit) limitHit = cgroupLimitHit(cgroup);
      // Once the child is gone its group id can be reused, so the delayed kill must not fire.
      clearTimeout(killTimer);
      closeSync(out);
      closeSync(err);
      if (child.pid) killGroup(child.pid, "SIGKILL");
      done({ status, signal, error, timedOut, truncated, outputBytes: written, diskStopped, diskUsedBytes: used, limitHit });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (status, signal) => finish(status, signal, null));
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (["--bundle", "--repository", "--spec", "--out", "--change", "--run", "--adapter", "--cgroup"].includes(flag) && argv[i + 1]) args[flag.slice(2)] = argv[++i];
    else if (flag === "--probe") args.probe = true;
    else if (flag === "--no-limits") args.noLimits = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const need of ["bundle", "repository", "spec", "out"]) if (!args[need]) throw new Error(`Missing --${need}. Usage: node decision-map/replay.mjs --bundle <dir> --repository <git-dir> --spec <spec.json> --out <dir> [--run <dir>] [--adapter <dir>] [--change <change.json>] (--cgroup <dir> | --no-limits) [--probe]`);
  if (!args.probe && !args.cgroup && !args.noLimits) throw new Error("A replay runs in a cgroup with resource limits: pass --cgroup <a cgroup delegated to you>, or --no-limits to run without them (recorded as a known difference).");
  if (args.cgroup && args.noLimits) throw new Error("--cgroup and --no-limits contradict each other");
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  let spec;
  let bundle;
  try {
    args = parseArgs(process.argv.slice(2));
    spec = readSpec(JSON.parse(readFileSync(args.spec, "utf8")));
    bundle = loadBundle(args.bundle);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const change = args.change ? JSON.parse(readFileSync(args.change, "utf8")) : null;
  let dirs;
  let applied;
  try {
    ({ dirs, change: applied } = materialize({ bundle, repository: args.repository, out: args.out, roots: [args.run, args.adapter], change, disk: { maxWriteBytes: spec.maxWriteBytes, minFreeBytes: spec.minFreeBytes, maxFiles: spec.maxFiles } }));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const bwrap = process.env.DECISION_MAP_BWRAP || "bwrap";
  const socketDir = mkdtempSync(join(tmpdir(), "net-allow-"));
  process.on("exit", () => rmSync(socketDir, { recursive: true, force: true }));
  const network = { socket: join(socketDir, "proxy.sock") };
  const tunnelLog = join(dirs.logs, "tunnels.jsonl");
  // Tunnels asked for, those refused at once, and admitted ones closed later for their TLS server name.
  let tunnels = 0;
  let refused = 0;
  let closedAtTls = 0;
  const server = await startAllowProxy({
    socket: network.socket,
    allow: spec.allow,
    onTunnel: (entry) => {
      if (entry.stage === "tls") closedAtTls += 1;
      else {
        tunnels += 1;
        if (!entry.allowed) refused += 1;
      }
      appendFileSync(tunnelLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    },
  });
  server.unref();
  const sandboxArgs = stageSandbox(spec, dirs, network);
  const launcher = modelEnv(spec.passEnv, process.env);
  const env = { ...launcher, ...spec.env };
  const record = {
    harness: HARNESS,
    checkpoint: bundle.record.id,
    decision_id: bundle.record.decision_id,
    commit: bundle.commit,
    branch: applied ? { kind: "change", change: applied } : { kind: "control" },
    command: spec.command,
    env: Object.keys(env).sort(),
    allow_hosts: spec.allow,
    known_differences: [...(bundle.record.known_differences || []), ...spec.knownDifferences],
  };
  if (args.probe) {
    const files = await runLogged({ ...modelCommand(probeCommand(sandboxArgs), bwrap), env: modelEnv([], process.env) }, dirs.logs, { timeoutMs: 60000, name: "probe-files-" });
    const check = networkProbeCommand({ ...sandboxArgs, allow: spec.allow, deny: ["github.com"] });
    const net = await runLogged({ ...modelCommand(check, bwrap), env: modelEnv([], process.env) }, dirs.logs, { timeoutMs: 60000, name: "probe-network-" });
    const found = ["probe-files-", "probe-network-"].flatMap((name) => readFileSync(join(dirs.logs, `${name}stdout.log`), "utf8").split("\n")).filter(Boolean);
    const ok = [files, net].every((r) => r.status === 0 && !r.timedOut && !r.truncated);
    writeFileSync(join(args.out, "probe.json"), `${JSON.stringify({ ...record, files_exit: files.status, network_exit: net.status, timed_out: files.timedOut || net.timedOut, found, tunnels, refused, closed_at_tls: closedAtTls, ok }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok, files_exit: files.status, network_exit: net.status, found }, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  }
  // The recorded environment goes to the stage only, through bwrap's --setenv. bwrap itself is found
  // and started with the operator's own variables (and the provider logins the spec names from it), so
  // a recorded PATH or loader variable cannot choose or alter it.
  const stage = modelCommand({ ...sandboxArgs, setenv: spec.env }, bwrap);
  record.sandbox = [stage.file, ...stage.args.slice(0, stage.args.indexOf("--"))];
  let cgroup = null;
  if (args.cgroup) {
    try {
      cgroup = makeCgroup(args.cgroup, spec.limits);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    record.limits = { ...spec.limits };
  } else {
    record.limits = null;
    record.known_differences.push({ subject: "resource limits", recorded: null, replay: "none", note: "run with --no-limits: no cap on the stage's processes, memory or CPU" });
  }
  record.started_at = new Date().toISOString();
  const result = await runLogged({ ...(cgroup ? inCgroup(cgroup, stage) : stage), env: launcher }, dirs.logs, { timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes, disk: { path: args.out, maxWriteBytes: spec.maxWriteBytes, minFreeBytes: spec.minFreeBytes }, cgroup });
  if (cgroup) {
    closeCgroup(cgroup);
    record.limits.hit = result.limitHit;
  }
  record.finished_at = new Date().toISOString();
  record.duration_ms = Date.parse(record.finished_at) - Date.parse(record.started_at);
  record.exit = result.error ? String(result.error.code || result.error) : result.status ?? result.signal;
  record.timed_out = result.timedOut;
  record.output = { bytes: result.outputBytes, limit: spec.maxOutputBytes, truncated: result.truncated };
  record.disk = { used_bytes: result.diskUsedBytes, max_write_bytes: spec.maxWriteBytes, min_free_bytes: spec.minFreeBytes, stopped: result.diskStopped };
  record.tunnels = { asked: tunnels, refused, closed_at_tls: closedAtTls, log: "logs/tunnels.jsonl" };
  writeFileSync(join(args.out, "replay.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ exit: record.exit, timed_out: record.timed_out, output: record.output, duration_ms: record.duration_ms, tunnels: record.tunnels }, null, 2)}\n`);
  process.exit(record.exit === 0 && !record.timed_out && !result.truncated && !result.diskStopped && !result.limitHit ? 0 : 1);
}
