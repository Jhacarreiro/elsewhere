// Writes a finished run's decision records and map next to the run, for use as a run-end hook.
import { closeSync, constants, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { DIR_FLAGS, extract, fdPath, pinRoot } from "./extract.mjs";
import { renderMap } from "./render.mjs";

export const OUTPUT_DIR = "decision-map";
const FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// Opens the output folder from the pinned run directory. A link or a non-directory in its place is
// refused (O_NOFOLLOW, O_DIRECTORY), and the open descriptor keeps later writes inside it even if
// the path is swapped afterwards.
export function openOutputDir(runRoot) {
  const path = `${fdPath(runRoot.fd)}/${OUTPUT_DIR}`;
  try {
    mkdirSync(path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  try {
    return openSync(path, DIR_FLAGS);
  } catch {
    throw new Error(`${runRoot.path}/${OUTPUT_DIR} is not a plain directory`);
  }
}

// Each file is written beside its final name and renamed, both through the pinned folder, so a
// reader never sees half a map and nothing is written outside the run.
export function writeAtomic(dirFd, name, text) {
  const tmp = `.${name}.${process.pid}.tmp`;
  const fd = openSync(`${fdPath(dirFd)}/${tmp}`, FILE_FLAGS, 0o644);
  try {
    const buf = Buffer.from(text);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
  renameSync(`${fdPath(dirFd)}/${tmp}`, `${fdPath(dirFd)}/${name}`);
}

export function mapRun({ runDir, adapterDir = null }) {
  const runRoot = pinRoot("run directory", runDir);
  let records;
  let runId;
  try {
    records = extract({ runDir, adapterDir });
    runId = records[0]?.run?.run_id || basename(runDir);
    const outFd = openOutputDir(runRoot);
    try {
      writeAtomic(outFd, "decisions.jsonl", records.map((r) => `${JSON.stringify(r)}\n`).join(""));
      writeAtomic(outFd, "map.html", renderMap(records, { title: `Decision map: ${runId}` }));
    } finally {
      closeSync(outFd);
    }
  } finally {
    closeSync(runRoot.fd);
  }
  return {
    ok: true,
    runId,
    records: records.length,
    pending: records.filter((r) => r.state === "pending").length,
    output: OUTPUT_DIR,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--adapter") args.adapterDir = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.runDir) args.runDir = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runDir) {
    process.stderr.write("Usage: node decision-map/map-run.mjs [--adapter <octopus-home>] <run-dir>\n");
    process.exit(args.help ? 0 : 2);
  }
  try {
    process.stdout.write(`${JSON.stringify(mapRun(args))}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}
