// Checkpoint builder (Phase 3 step 2).
// Reconstructs the checkpoint before one decision from a finished run's artifacts, read-only, and
// writes it as a private bundle: checkpoint.json, plus a copy of each input when the checkpoint is
// adequate. It never writes into the run, the adapter state or the repository; git is only asked to
// read objects, and the completeness check of a diff uses a throwaway index outside the repository.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createReader } from "./extract.mjs";
import { assessCheckpoint } from "./checkpoint.mjs";

export const BUILDER = { name: "elsewhere-checkpoint-builder", version: "0.1.0" };
const DECISION_ID = /^dec_[0-9a-f]{16}$/;
const TIME_SOURCES = new Set(["artifact_field", "artifact_header", "file_mtime", "commit_time", "unknown"]);
const MAX_EXCLUDED = 500;

const instant = (value) => (typeof value === "string" ? Date.parse(value) : NaN);
const later = (a, b) => (instant(a) >= instant(b) ? a : b);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function git(repository, args, { input, env } = {}) {
  const r = spawnSync("git", ["-C", repository, ...args], { input, env: { ...process.env, ...env }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ? r.stdout.toString("utf8").trim() : "", err: r.stderr ? r.stderr.toString("utf8").trim() : "" };
}

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Only a full commit id is accepted: a ref names whatever it points to now, not what the stage saw.
function resolveCommit(repository, id) {
  if (!repository || !FULL_COMMIT.test(id || "")) return null;
  const r = git(repository, ["rev-parse", "--verify", "--end-of-options", `${id}^{commit}`]);
  return r.ok && r.out === id ? id : null;
}

// The artifact that records which commit the stage started from. It counts only if it names the id;
// whether it was written before the checkpoint is decided by checkpoint.mjs from written_at.
function commitRecord(reader, recordedIn, commit) {
  if (!recordedIn || (recordedIn.root !== "run" && recordedIn.root !== "adapter") || !commit) return null;
  const f = reader.read(recordedIn.root, recordedIn.path);
  if (!f || !f.text.includes(commit)) return null;
  return { root: recordedIn.root, pointer: recordedIn.path, sha256: f.sha, written_at: later(f.mtime, f.ctime) };
}

// Changed lines per path, as git itself reads the diff (`--numstat -z`, so quoted or escaped
// paths come back verbatim). A binary change counts as null. A rename is listed under its new path.
function diffStat(repository, bytes, env) {
  const r = spawnSync("git", ["-C", repository, "apply", "--numstat", "-z", "-"], { input: bytes, env: { ...process.env, ...env }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const fields = r.stdout.toString("utf8").split("\0");
  const stat = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { path = fields[i + 2]; i += 2; }
    const changes = m[1] === "-" ? null : Number(m[1]) + Number(m[2]);
    stat.set(path, changes);
  }
  return stat;
}

// A diff is complete only when it applies cleanly to its base commit and its changed-line count per
// path matches what the stage recorded (`expect_stat`, from a diff stat written before the decision).
// Applying alone proves nothing about completeness: a diff cut off at a file or hunk boundary still
// applies. Without recorded counts there is nothing to check against, so completeness stays unproven.
function diffCompleteness(repository, commit, bytes, expectStat) {
  const scratch = mkdtempSync(join(tmpdir(), "elsewhere-checkpoint-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (!git(repository, ["read-tree", commit], { env }).ok) return "base commit cannot be read";
    const applied = git(repository, ["apply", "--cached", "--check", "-"], { input: bytes, env });
    if (!applied.ok) return `does not apply to its base commit (${applied.err.split("\n")[0] || "git apply failed"})`;
    if (!Array.isArray(expectStat)) return "no recorded change counts to check it against";
    const got = diffStat(repository, bytes, env);
    if (!got) return "git cannot count its changes";
    const want = new Map(expectStat.map((e) => [e.path, e.changes ?? null]));
    if (got.size !== want.size || [...want].some(([path, changes]) => !got.has(path) || got.get(path) !== changes)) {
      return `its changed lines per path do not match the ${want.size} path(s) the stage recorded`;
    }
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function fileInput(reader, spec) {
  const f = reader.read(spec.root, spec.path);
  // No hash for an unreadable input, so checkpoint.mjs fails it.
  if (!f) return { input: { role: spec.role, root: spec.root, pointer: spec.path, version_proof: "pre_decision_time", complete: false, incomplete_reason: "unreadable" }, bytes: null };
  // The later of the write and change times: a file renamed into place, or with its write time set
  // back, after the checkpoint still has a later change time. checkpoint.mjs compares it with the
  // checkpoint time.
  const input = { role: spec.role, root: spec.root, pointer: spec.path, sha256: f.sha, version_proof: "pre_decision_time", written_at: later(f.mtime, f.ctime), complete: true };
  return { input, bytes: f.bytes };
}

// Files next to each input that were written at or after the checkpoint time: later rounds' results
// usually sit beside the round's own input, so these are the likeliest leaks. The replay harness
// hides the roots as a whole; this list is what the record names.
function excludedSiblings(reader, inputs, at) {
  const seen = new Set();
  const out = [];
  for (const input of inputs) {
    if (input.root !== "run" && input.root !== "adapter") continue;
    const dir = input.pointer.includes("/") ? input.pointer.slice(0, input.pointer.lastIndexOf("/")) : "";
    const dirKey = `${input.root}:${dir}`;
    if (seen.has(dirKey)) continue;
    seen.add(dirKey);
    for (const name of reader.list(input.root, dir).sort()) {
      const rel = dir ? `${dir}/${name}` : name;
      const st = reader.stat(input.root, rel);
      if (!st || !st.isFile) continue;
      if (instant(st.mtime) >= at || instant(st.ctime) >= at) {
        if (out.length >= MAX_EXCLUDED) return { excluded: out, truncated: true };
        out.push({ root: input.root, pointer: rel, reason: "written_after_checkpoint" });
      }
    }
  }
  return { excluded: out, truncated: false };
}

/**
 * Builds a checkpoint record from a spec. The spec names what the stage consumed; the builder proves
 * versions and completeness itself and never takes them from the spec.
 * @param {{ spec: object, reader: object, repository: string|null }} options
 * @returns {{ record: object, copies: { root: string, pointer: string, bytes: Buffer }[], excludedTruncated: boolean }}
 */
export function buildCheckpoint({ spec, reader, repository }) {
  if (!DECISION_ID.test(spec.decision_id || "")) throw new Error("spec.decision_id must be a decision record id");
  if (!spec.run?.run_id || !spec.stage) throw new Error("spec.run.run_id and spec.stage are required");
  if (!TIME_SOURCES.has(spec.at?.source)) throw new Error("spec.at.source must be a decision record time source");
  // Repository content is captured by its commit, so a file input from the repository root would only
  // duplicate it; and the reader pins the run and adapter roots alone.
  for (const s of spec.inputs || []) {
    if (s.role !== "repository_commit" && s.root !== "run" && s.root !== "adapter") {
      throw new Error(`input ${s.path ?? "(no path)"}: file inputs must be rooted at run or adapter; repository content comes from a repository_commit input`);
    }
  }
  const at = instant(spec.at?.value);
  const inputs = [];
  const copies = [];
  const commits = new Map();
  for (const s of spec.inputs || []) {
    if (s.role !== "repository_commit") continue;
    const commit = resolveCommit(repository, s.commit);
    const recorded = commitRecord(reader, s.recorded_in, commit);
    inputs.push({ role: s.role, root: "repository", pointer: String(s.commit ?? ""), ...(commit ? { commit } : {}), ...(recorded ? { recorded_in: recorded } : {}), version_proof: "immutable_copy", complete: Boolean(commit) });
    if (commit) commits.set(commit, commit);
  }
  for (const s of spec.inputs || []) {
    if (s.role === "repository_commit") continue;
    const { input, bytes } = fileInput(reader, s);
    // A working-tree change is a diff against some commit; without that commit nothing about its
    // completeness can be checked, so it is never taken as complete on its own.
    if (bytes && (s.diff_base !== undefined || s.role === "working_tree_change")) {
      const base = s.diff_base === undefined ? null : commits.get(s.diff_base);
      const problem = s.diff_base === undefined ? "no base commit to check it against"
        : base ? diffCompleteness(repository, base, bytes, s.expect_stat) : "its base commit is not an input";
      if (problem) Object.assign(input, { complete: false, incomplete_reason: problem });
    }
    inputs.push(input);
    if (bytes) copies.push({ root: input.root, pointer: input.pointer, bytes });
  }
  const { excluded, truncated } = Number.isNaN(at) ? { excluded: [], truncated: false } : excludedSiblings(reader, inputs, at);
  const id = `chk_${sha256(`${spec.decision_id}\n${spec.at.value}\n${inputs.map((i) => `${i.root}:${i.pointer}`).join("\n")}`).slice(0, 16)}`;
  const record = assessCheckpoint({
    schema_version: 0,
    id,
    decision_id: spec.decision_id,
    run: spec.run,
    stage: spec.stage,
    at: { value: spec.at.value ?? null, source: spec.at.source },
    inputs,
    ...(Array.isArray(spec.known_differences) ? { known_differences: spec.known_differences } : {}),
    excluded,
    producer: BUILDER,
  });
  return { record, copies, excludedTruncated: truncated };
}

function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Writes the bundle into a new directory. checkpoint.json is always written, so an inadequate
 * checkpoint is reported as it is; input copies are written only for an adequate one.
 */
export function writeBundle(out, { record, copies }, roots) {
  const target = join(realpathSync(dirname(resolve(out))), basename(resolve(out)));
  for (const root of roots.filter(Boolean)) {
    if (within(target, realpathSync(root))) throw new Error("--out must not be inside a run, adapter or repository root");
  }
  // The bundle holds private run artifacts: owner-only, whatever the umask.
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "checkpoint.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (record.adequacy.status !== "adequate") return;
  for (const c of copies) {
    const dest = join(target, "inputs", c.root, c.pointer);
    if (!within(dest, join(target, "inputs"))) throw new Error(`input pointer escapes the bundle: ${c.pointer}`);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, c.bytes, { flag: "wx", mode: 0o600 });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--spec", "--run", "--adapter", "--repository", "--out"].includes(flag) || value === undefined) {
      throw new Error("usage: checkpoint-build.mjs --spec FILE --run DIR [--adapter DIR] --repository DIR --out NEW_DIR");
    }
    args[flag.slice(2)] = value;
  }
  if (!args.spec || !args.run || !args.repository || !args.out) throw new Error("--spec, --run, --repository and --out are required");
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let reader = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    const { readFileSync } = await import("node:fs");
    const spec = JSON.parse(readFileSync(args.spec, "utf8"));
    reader = createReader({ runDir: args.run, adapterDir: args.adapter || null });
    const built = buildCheckpoint({ spec, reader, repository: resolve(args.repository) });
    writeBundle(args.out, built, [args.run, args.adapter, args.repository]);
    const { status, failed } = built.record.adequacy;
    process.stdout.write(`${JSON.stringify({ id: built.record.id, status, failed, excluded: built.record.excluded.length, excluded_truncated: built.excludedTruncated })}\n`);
    process.exitCode = status === "adequate" ? 0 : 2;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  } finally {
    reader?.close();
  }
}
