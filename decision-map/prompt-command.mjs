// Generator command for generate.mjs that turns its JSON request into a plain-text prompt for any
// model CLI that reads a prompt on stdin and prints its answer on stdout, and turns the answer back
// into the JSON reply generate.mjs expects. Which CLI and model is the operator's choice.
//
//   node decision-map/generate.mjs <run-dir> -- node decision-map/prompt-command.mjs [--keep <dir>] -- <cli> [args...]
//
// With --keep, every exchange is written to <dir>/<decision id>.json (request, raw answer, parsed
// reply), so counts that need what the model proposed before any rule dropped it can be recomputed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "Usage: node decision-map/prompt-command.mjs [--keep <dir>] [--timeout-seconds <n>] -- <cli> [args...]";

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

function parseArgs(argv) {
  const split = argv.indexOf("--");
  if (split === -1 || split === argv.length - 1) throw new Error(`Missing model command after --. ${USAGE}`);
  const own = argv.slice(0, split);
  const args = { cli: argv[split + 1], cliArgs: argv.slice(split + 2), timeoutMs: 600000 };
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--keep" && i + 1 < own.length) args.keep = own[++i];
    else if (own[i] === "--timeout-seconds" && Number(own[i + 1]) > 0) args.timeoutMs = Number(own[++i]) * 1000;
    else throw new Error(`Unknown argument: ${own[i]}. ${USAGE}`);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = spawnSync(args.cli, args.cliArgs, {
    input: prompt(request),
    encoding: "utf8",
    timeout: args.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const answer = result.stdout || "";
  const reply = result.status === 0 ? parseAnswer(answer) : null;
  if (args.keep) {
    writeFileSync(join(args.keep, `${request.decision.id}.json`), `${JSON.stringify({
      request,
      exit: result.status ?? result.signal ?? (result.error ? String(result.error.code || result.error) : null),
      answer,
      reply,
    }, null, 2)}\n`);
  }
  if (result.status !== 0) {
    process.stderr.write((result.stderr || "").slice(-2000));
    process.exit(result.status || 1);
  }
  if (!reply) {
    process.stderr.write("The model's answer had no JSON object with an alternatives list.\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(reply));
}
