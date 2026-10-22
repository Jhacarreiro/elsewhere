// Writes a finished run's decision records and map next to the run, for use as a run-end hook.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { DIR_FLAGS, extract, fdPath, pinRoot } from "./extract.mjs";
import { renderMap } from "./render.mjs";

export const OUTPUT_DIR = "decision-map";
export const OUTPUT_FILES = ["decisions.jsonl", "map.html"];
const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const under = (fd, name) => `${fdPath(fd)}/${name}`;
const entry = (fd, name) => {
  try {
    return lstatSync(under(fd, name));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

// Creates a new, randomly named folder in the pinned run and opens it. Files are only ever created in
// it (O_EXCL), never replaced, so even if another folder were swapped in under that name, nothing
// that already exists anywhere can be overwritten.
function createStagingDir(runRoot) {
  const name = `.${OUTPUT_DIR}.${randomBytes(8).toString("hex")}`;
  mkdirSync(under(runRoot.fd, name), { mode: 0o755 });
  const made = entry(runRoot.fd, name);
  const fd = openSync(under(runRoot.fd, name), DIR_FLAGS);
  const opened = fstatSync(fd);
  if (!made || made.ino !== opened.ino || made.dev !== opened.dev) {
    closeSync(fd);
    throw new Error(`${runRoot.path}/${name} changed while it was being created`);
  }
  return { name, fd };
}

export function writeNew(dirFd, name, text) {
  const fd = openSync(under(dirFd, name), NEW_FILE_FLAGS, 0o644);
  try {
    const buf = Buffer.from(text);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

// Removes a previous map folder that was moved aside: only the files map-run writes, then the folder
// if it is empty. Anything else in it is left alone.
function removeOldOutput(runRoot, name) {
  let fd;
  try {
    fd = openSync(under(runRoot.fd, name), DIR_FLAGS);
  } catch {
    return;
  }
  try {
    for (const file of OUTPUT_FILES) {
      try { unlinkSync(under(fd, file)); } catch { /* already gone */ }
    }
  } finally {
    closeSync(fd);
  }
  try { rmdirSync(under(runRoot.fd, name)); } catch { /* not empty: left for a person */ }
}

// Builds the new map in a staging folder, then swaps it in for the old one. Every rename names
// entries of the pinned run directory, so nothing outside the run is moved or replaced.
export function publishOutput(runRoot, files) {
  const current = entry(runRoot.fd, OUTPUT_DIR);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) {
    throw new Error(`${runRoot.path}/${OUTPUT_DIR} is not a plain directory`);
  }
  const staging = createStagingDir(runRoot);
  try {
    for (const [name, text] of Object.entries(files)) writeNew(staging.fd, name, text);
  } finally {
    closeSync(staging.fd);
  }
  let old = null;
  if (current) {
    old = `.${OUTPUT_DIR}.old.${randomBytes(8).toString("hex")}`;
    renameSync(under(runRoot.fd, OUTPUT_DIR), under(runRoot.fd, old));
  }
  renameSync(under(runRoot.fd, staging.name), under(runRoot.fd, OUTPUT_DIR));
  if (old) removeOldOutput(runRoot, old);
}

export function mapRun({ runDir, adapterDir = null }) {
  const runRoot = pinRoot("run directory", runDir);
  try {
    // Records are read from the same pinned directory the map is written into.
    const records = extract({ runDir, adapterDir, runRoot });
    const runId = records[0]?.run?.run_id || basename(runDir);
    publishOutput(runRoot, {
      "decisions.jsonl": records.map((r) => `${JSON.stringify(r)}\n`).join(""),
      "map.html": renderMap(records, { title: `Decision map: ${runId}` }),
    });
    return {
      ok: true,
      runId,
      records: records.length,
      pending: records.filter((r) => r.state === "pending").length,
      output: OUTPUT_DIR,
    };
  } finally {
    closeSync(runRoot.fd);
  }
}

const USAGE = "Usage: node decision-map/map-run.mjs [--adapter <octopus-home>] <run-dir>";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--adapter") {
      if (i + 1 >= argv.length) throw new Error(`--adapter needs a directory. ${USAGE}`);
      args.adapterDir = argv[++i];
    } else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.runDir) args.runDir = a;
    else throw new Error(`Unknown argument: ${a}. ${USAGE}`);
  }
  if (!args.help && !args.runDir) throw new Error(`Missing run directory. ${USAGE}`);
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // Every outcome, including a bad invocation, is one JSON line, so a caller can always parse it.
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${JSON.stringify({ ok: true, usage: USAGE })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(mapRun(args))}\n`);
    }
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}
