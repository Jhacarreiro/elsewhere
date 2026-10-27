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
//     "known_differences": [{ "subject", "recorded", "replay", "note" }] }
//
// A branch is the checkpoint plus one recorded change (--change): { "root": "run|adapter",
// "pointer": "...", "mode": "replace|append", "content_file": "/path", "note": "..." }, applied to the
// copy before the stage starts. Without it the replay is a control.
//
// --probe runs the sandbox adapter's probe in the same sandbox, mounts and network boundary instead
// of the stage, so the isolation can be proven before any model runs.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
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
export function materialize({ bundle, repository, out, roots = [], change = null }) {
  const target = join(realpathSync(dirname(resolve(out))), basename(resolve(out)));
  for (const root of [repository, ...roots].filter(Boolean)) {
    if (within(target, realpathSync(root))) throw new Error("--out must not be inside the run, adapter or repository it replays from");
  }
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

function runLogged({ file, args, env }, logs, timeoutMs, name = "") {
  return new Promise((done) => {
    const out = openSync(join(logs, `${name}stdout.log`), "wx", 0o600);
    const err = openSync(join(logs, `${name}stderr.log`), "wx", 0o600);
    const child = spawn(file, args, { stdio: ["ignore", out, err], detached: true, env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 30000).unref();
    }, timeoutMs);
    // A child that cannot start emits both error and close; the outcome is settled once.
    let settled = false;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(out);
      closeSync(err);
      if (child.pid) killGroup(child.pid, "SIGKILL");
      done({ status, signal, error, timedOut });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (status, signal) => finish(status, signal, null));
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (["--bundle", "--repository", "--spec", "--out", "--change", "--run", "--adapter"].includes(flag) && argv[i + 1]) args[flag.slice(2)] = argv[++i];
    else if (flag === "--probe") args.probe = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const need of ["bundle", "repository", "spec", "out"]) if (!args[need]) throw new Error(`Missing --${need}. Usage: node decision-map/replay.mjs --bundle <dir> --repository <git-dir> --spec <spec.json> --out <dir> [--run <dir>] [--adapter <dir>] [--change <change.json>] [--probe]`);
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
  const { dirs, change: applied } = materialize({ bundle, repository: args.repository, out: args.out, roots: [args.run, args.adapter], change });
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
  const env = { ...modelEnv(spec.passEnv, process.env), ...spec.env };
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
    const files = await runLogged({ ...modelCommand(probeCommand(sandboxArgs), bwrap), env: modelEnv([], process.env) }, dirs.logs, 60000, "probe-files-");
    const check = networkProbeCommand({ ...sandboxArgs, allow: spec.allow, deny: ["github.com"] });
    const net = await runLogged({ ...modelCommand(check, bwrap), env: modelEnv([], process.env) }, dirs.logs, 60000, "probe-network-");
    const found = ["probe-files-", "probe-network-"].flatMap((name) => readFileSync(join(dirs.logs, `${name}stdout.log`), "utf8").split("\n")).filter(Boolean);
    const ok = files.status === 0 && !files.timedOut && net.status === 0 && !net.timedOut;
    writeFileSync(join(args.out, "probe.json"), `${JSON.stringify({ ...record, files_exit: files.status, network_exit: net.status, timed_out: files.timedOut || net.timedOut, found, tunnels, refused, closed_at_tls: closedAtTls, ok }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok, files_exit: files.status, network_exit: net.status, found }, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  }
  const stage = modelCommand(sandboxArgs, bwrap);
  record.sandbox = [stage.file, ...stage.args.slice(0, stage.args.indexOf("--"))];
  record.started_at = new Date().toISOString();
  const result = await runLogged({ ...stage, env }, dirs.logs, spec.timeoutMs);
  record.finished_at = new Date().toISOString();
  record.duration_ms = Date.parse(record.finished_at) - Date.parse(record.started_at);
  record.exit = result.error ? String(result.error.code || result.error) : result.status ?? result.signal;
  record.timed_out = result.timedOut;
  record.tunnels = { asked: tunnels, refused, closed_at_tls: closedAtTls, log: "logs/tunnels.jsonl" };
  writeFileSync(join(args.out, "replay.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ exit: record.exit, timed_out: record.timed_out, duration_ms: record.duration_ms, tunnels: record.tunnels }, null, 2)}\n`);
  process.exit(record.exit === 0 && !record.timed_out ? 0 : 1);
}
