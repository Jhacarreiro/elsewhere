// Generator command for generate.mjs that turns its JSON request into a plain-text prompt for any
// model CLI that reads a prompt on stdin and prints its answer on stdout, and turns the answer back
// into the JSON reply generate.mjs expects. Which CLI and model is the operator's choice.
//
//   node decision-map/generate.mjs <run-dir> -- node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... [--writable <dir>]... -- <cli> [args...]
//   node decision-map/prompt-command.mjs --hide <dir>... [--writable <dir>]... --probe
//
// With --keep, every exchange is written to <dir>/<decision id>.json (request, raw answer, parsed
// reply), so counts that need what the model proposed before any rule dropped it can be recomputed.
//
// With --hide, the CLI runs under bwrap (Linux) in a sandbox: the host's root is read-only, each hidden
// directory is an empty tmpfs, /tmp is a private tmpfs, /dev and /proc are its own, and only the
// --writable directories (the CLI's own state, say) can be written. A CLI that can read files then does
// not see what happened after the decision, and cannot change anything else. Without bwrap the
// command fails rather than run the CLI unhidden. The CLI keeps network access to reach its model;
// keeping the commands it runs itself off the network is its own sandbox's job (for Codex,
// --sandbox read-only), which the operator names in the command line.
//
// --probe runs a shell in that same sandbox instead of a model and prints what it found: each hidden
// directory empty, the root not writable, each writable directory writable. It exits nonzero if any
// of that fails, so the result can be recorded as proof before a run.
//
// The model is stopped before generate.mjs's deadline (DECISION_MAP_GENERATOR_TIMEOUT_MS, or its
// default), so this command can keep the failed exchange instead of being killed with the model still
// running and nothing kept. The model runs in its own process group, and the whole group is stopped,
// so a CLI that forks the real model leaves nothing running into the next decision.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_TIMEOUT_MS } from "./generate.mjs";

// The model's deadline inside the generator's: a tenth of it, at most 30 s, is left to stop the
// model and write the kept exchange. Half of that is the grace between asking the model's process
// group to stop and killing it, so even a group that ignores the request is gone in time.
export function modelDeadline(generatorMs) {
  return generatorMs - Math.min(30000, generatorMs / 10);
}

export function killGrace(generatorMs) {
  return Math.min(30000, generatorMs / 10) / 2;
}

export const DEFAULT_MODEL_TIMEOUT_MS = modelDeadline(DEFAULT_TIMEOUT_MS);

// The most the model may print; past it the model is stopped and the decision withheld.
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

const USAGE = "Usage: node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... [--writable <dir>]... [--timeout-seconds <n, capped below generate.mjs's deadline>] -- <cli> [args...]\n       node decision-map/prompt-command.mjs --hide <dir>... [--writable <dir>]... --probe";

export function prompt(request) {
  const artifacts = request.artifacts.map((a) => [
    `### ${a.ref}: ${a.root}:${a.path} (written ${a.written_at}${a.truncated ? ", truncated" : ""})`,
    "",
    a.content,
  ].join("\n"));
  return [
    request.task,
    "",
    "Use only the artifacts below. Do not open files, run commands or look anything up: what happened after the decision must stay unknown to you.",
    "",
    `## Decision ${request.decision.id}`,
    "",
    `Stage: ${request.decision.stage}`,
    `Decided at: ${request.decision.decided_at}`,
    `Question: ${request.decision.question}`,
    "",
    "## Artifacts that existed before the decision",
    "",
    ...artifacts,
    "",
    "## Reply",
    "",
    "Reply with one JSON object and nothing else, in this shape (zero alternatives is a valid answer):",
    "",
    JSON.stringify(request.reply_format, null, 2),
  ].join("\n");
}

// The first JSON object with an alternatives list in the answer, allowing a fenced block or prose
// around it, braces in the prose included.
export function parseAnswer(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  for (const candidate of fenced ? [fenced[1], text] : [text]) {
    for (let start = candidate.indexOf("{"); start >= 0; start = candidate.indexOf("{", start + 1)) {
      const end = closingBrace(candidate, start);
      if (end < 0) continue;
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (Array.isArray(value?.alternatives)) return value;
      } catch {
        // not JSON: try the next opening brace
      }
    }
  }
  return null;
}

// The index of the brace that closes the one at start, skipping braces inside JSON strings, or -1.
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseArgs(argv, env) {
  if (argv.at(-1) === "--probe") argv = [...argv.slice(0, -1), "--", "sh"];
  const split = argv.indexOf("--");
  if (split === -1 || split === argv.length - 1) throw new Error(`Missing model command after --. ${USAGE}`);
  const own = argv.slice(0, split);
  const generatorMs = Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) > 0 ? Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const limit = modelDeadline(generatorMs);
  const args = { cli: argv[split + 1], cliArgs: argv.slice(split + 2), timeoutMs: limit, graceMs: killGrace(generatorMs), hide: [], writable: [] };
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--keep" && i + 1 < own.length) args.keep = own[++i];
    else if (own[i] === "--hide" && i + 1 < own.length) args.hide.push(resolve(own[++i]));
    else if (own[i] === "--writable" && i + 1 < own.length) args.writable.push(resolve(own[++i]));
    else if (own[i] === "--timeout-seconds" && Number(own[i + 1]) > 0) args.timeoutMs = Math.min(Number(own[++i]) * 1000, limit);
    else throw new Error(`Unknown argument: ${own[i]}. ${USAGE}`);
  }
  if (args.writable.length && !args.hide.length) throw new Error(`--writable only applies with --hide. ${USAGE}`);
  return args;
}

// The CLI as it is run: in the bwrap sandbox when anything is hidden.
export function modelCommand({ cli, cliArgs, hide, writable = [] }, bwrap = "bwrap") {
  if (!hide.length) return { file: cli, args: cliArgs };
  return {
    file: bwrap,
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      ...writable.flatMap((dir) => ["--bind", dir, dir]),
      ...hide.flatMap((dir) => ["--tmpfs", dir]),
      "--unshare-pid", "--die-with-parent",
      "--", cli, ...cliArgs,
    ],
  };
}

// Run in the sandbox by --probe, with the hidden directories, then "--", then the writable ones.
const PROBE = `ok=0
while [ "$1" != -- ]; do
  if [ -z "$(ls -A "$1")" ]; then echo "hidden_empty $1"; else echo "hidden_not_empty $1"; ok=1; fi
  shift
done
shift
if : 2>/dev/null >/.prompt-command-probe; then echo "root_writable"; ok=1; else echo "root_read_only"; fi
for dir; do
  if : 2>/dev/null >"$dir/.prompt-command-probe"; then rm -f "$dir/.prompt-command-probe"; echo "writable $dir"; else echo "not_writable $dir"; ok=1; fi
done
exit $ok`;

export function probeCommand({ hide, writable }) {
  return { cli: "sh", cliArgs: ["-c", PROBE, "probe", ...hide, "--", ...writable], hide, writable };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

function run({ file, args }, input, timeoutMs, graceMs) {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let bytes = 0;
    let stderr = "";
    let signal = null;
    let error = null;
    const stop = (reason) => {
      if (signal) return;
      signal = reason;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs).unref();
    };
    child.stdout.on("data", (d) => {
      if (signal) return;
      bytes += d.length;
      if (bytes > MAX_ANSWER_BYTES) stop("output_limit");
      else stdout += decoder.write(d);
    });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = (stderr + d).slice(-8000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => stop("SIGTERM"), timeoutMs);
    child.on("error", (err) => { error = err; });
    child.on("close", (status, closeSignal) => {
      clearTimeout(timer);
      // Whatever the CLI left behind in its group goes too.
      if (child.pid) killGroup(child.pid, "SIGKILL");
      done({ status: signal || error ? null : status, signal: signal || closeSignal, error, stdout, stderr });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const bwrap = process.env.DECISION_MAP_BWRAP || "bwrap";
  if (args.cli === "sh" && process.argv.at(-1) === "--probe") {
    if (!args.hide.length) {
      process.stderr.write(`--probe needs --hide. ${USAGE}\n`);
      process.exit(2);
    }
    const sandbox = modelCommand(probeCommand(args), bwrap);
    const result = await run(sandbox, "", args.timeoutMs, args.graceMs);
    process.stdout.write(`${JSON.stringify({ sandbox: [sandbox.file, ...sandbox.args.slice(0, sandbox.args.indexOf("--"))], exit: result.status ?? result.signal ?? String(result.error?.code || result.error), found: result.stdout.trim().split("\n").filter(Boolean) }, null, 2)}\n`);
    process.exit(result.status === 0 ? 0 : 1);
  }
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = await run(modelCommand(args, bwrap), prompt(request), args.timeoutMs, args.graceMs);
  const answer = result.stdout;
  const reply = result.status === 0 ? parseAnswer(answer) : null;
  if (args.keep) {
    writeFileSync(join(args.keep, `${request.decision.id}.json`), `${JSON.stringify({
      request,
      exit: result.status ?? result.signal ?? (result.error ? String(result.error.code || result.error) : null),
      answer,
      reply,
    }, null, 2)}\n`);
  }
  if (result.error) {
    process.stderr.write(`Could not start ${args.hide.length ? "bwrap, which --hide needs" : args.cli}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr.slice(-2000));
    process.exit(result.status || 1);
  }
  if (!reply) {
    process.stderr.write("The model's answer had no JSON object with an alternatives list.\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(reply));
}
