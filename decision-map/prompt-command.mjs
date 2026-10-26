// Generator command for generate.mjs that turns its JSON request into a plain-text prompt for any
// model CLI that reads a prompt on stdin and prints its answer on stdout, and turns the answer back
// into the JSON reply generate.mjs expects. Which CLI and model is the operator's choice.
//
//   node decision-map/generate.mjs <run-dir> -- node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... -- <cli> [args...]
//
// With --keep, every exchange is written to <dir>/<decision id>.json (request, raw answer, parsed
// reply), so counts that need what the model proposed before any rule dropped it can be recomputed.
//
// With --hide, the CLI runs under bwrap (Linux) in a mount namespace where each given directory is an
// empty tmpfs, with its own /proc, so a CLI that can read files does not see what happened after the
// decision. Without bwrap the command fails rather than run the CLI unhidden. The CLI keeps network
// access to reach its model; whatever commands it runs itself are its own sandbox's business.
//
// The model is stopped before generate.mjs's deadline (DECISION_MAP_GENERATOR_TIMEOUT_MS, or its
// default), so this command can keep the failed exchange instead of being killed with the model still
// running and nothing kept. The model runs in its own process group, and the whole group is stopped,
// so a CLI that forks the real model leaves nothing running into the next decision.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./generate.mjs";

// The model's deadline inside the generator's: a tenth of it, at most 30 s, is left to stop the
// model and write the kept exchange.
export function modelDeadline(generatorMs) {
  return generatorMs - Math.min(30000, generatorMs / 10);
}

export const DEFAULT_MODEL_TIMEOUT_MS = modelDeadline(DEFAULT_TIMEOUT_MS);

const USAGE = "Usage: node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... [--timeout-seconds <n, capped below generate.mjs's deadline>] -- <cli> [args...]";
const KILL_GRACE_MS = 2000;

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

// The first top-level JSON object in the answer, allowing a fenced block or text around it.
export function parseAnswer(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    for (let end = candidate.lastIndexOf("}"); start >= 0 && end > start; end = candidate.lastIndexOf("}", end - 1)) {
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (Array.isArray(value?.alternatives)) return value;
      } catch {
        // keep shrinking towards the first object
      }
    }
  }
  return null;
}

function parseArgs(argv, env) {
  const split = argv.indexOf("--");
  if (split === -1 || split === argv.length - 1) throw new Error(`Missing model command after --. ${USAGE}`);
  const own = argv.slice(0, split);
  const generatorMs = Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) > 0 ? Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const limit = modelDeadline(generatorMs);
  const args = { cli: argv[split + 1], cliArgs: argv.slice(split + 2), timeoutMs: limit, hide: [] };
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--keep" && i + 1 < own.length) args.keep = own[++i];
    else if (own[i] === "--hide" && i + 1 < own.length) args.hide.push(resolve(own[++i]));
    else if (own[i] === "--timeout-seconds" && Number(own[i + 1]) > 0) args.timeoutMs = Math.min(Number(own[++i]) * 1000, limit);
    else throw new Error(`Unknown argument: ${own[i]}. ${USAGE}`);
  }
  return args;
}

// The CLI as it is run: under bwrap when anything is hidden.
export function modelCommand({ cli, cliArgs, hide }, bwrap = "bwrap") {
  if (!hide.length) return { file: cli, args: cliArgs };
  return {
    file: bwrap,
    args: ["--dev-bind", "/", "/", ...hide.flatMap((dir) => ["--tmpfs", dir]), "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", cli, ...cliArgs],
  };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

function run({ file, args }, input, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let signal = null;
    let error = null;
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = (stderr + d).slice(-8000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => {
      signal = "SIGTERM";
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
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
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = await run(modelCommand(args, process.env.DECISION_MAP_BWRAP || "bwrap"), prompt(request), args.timeoutMs);
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
