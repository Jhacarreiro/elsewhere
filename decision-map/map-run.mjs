// Writes a finished run's decision records and map next to the run, for use as a run-end hook.
import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extract } from "./extract.mjs";
import { renderMap } from "./render.mjs";

export const OUTPUT_DIR = "decision-map";

// The output folder must be a real directory inside the run, never a link to somewhere else.
function outputDir(runDir) {
  const dir = join(runDir, OUTPUT_DIR);
  let stat = null;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!stat) mkdirSync(dir);
  else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  return dir;
}

// Each file is written beside its final name and renamed, so a reader never sees half a map.
function writeAtomic(dir, name, text) {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, join(dir, name));
}

export function mapRun({ runDir, adapterDir = null }) {
  const records = extract({ runDir, adapterDir });
  const dir = outputDir(runDir);
  const runId = records[0]?.run?.run_id || basename(runDir);
  writeAtomic(dir, "decisions.jsonl", records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  writeAtomic(dir, "map.html", renderMap(records, { title: `Decision map: ${runId}` }));
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
