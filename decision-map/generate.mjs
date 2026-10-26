// Generator of contextual alternatives (Phase 2 step 2).
// For each selected decision it collects the run artifacts that provably existed, unchanged, before
// the decision, hands only those to a configured command, and keeps what the command proposes only
// where it cites them verbatim. It never writes into the run or adapter directories, and no model or
// provider is fixed: the command is whatever the operator configures.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { closeSync } from "node:fs";
import { createReader, extract, pinRoot } from "./extract.mjs";
import { applyGeneratedRules } from "./generated.mjs";

export const GENERATOR = { name: "elsewhere-alternatives-generator", version: "0.1.0" };
export const MAX_ARTIFACTS = 8;
export const MAX_ARTIFACT_CHARS = 12000;
export const DEFAULT_TIMEOUT_MS = 300000;
const LEVELS = ["low", "medium", "high", "unknown"];

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const instant = (value) => (typeof value === "string" ? Date.parse(value) : NaN);
const filePart = (pointer) => pointer.split("#")[0];

// Every artifact any record of the run points to, once per file.
function pointedFiles(records) {
  const files = new Map();
  for (const record of records) {
    for (const e of record.evidence || []) {
      const rel = filePart(e.pointer || "");
      if (rel && (e.root === "run" || e.root === "adapter")) files.set(`${e.root}:${rel}`, { root: e.root, rel });
    }
  }
  return [...files.values()];
}

// An artifact counts as pre-decision only when its last write is strictly earlier than the decision:
// then the version read now is the version that existed at decision time. Both the modification time
// and the change time must be earlier, because a file can be renamed into place, or have its
// modification time set back, after the decision; either moves its change time, which cannot be set.
// A file written at or after the decision (including the decision's own artifact) is excluded.
function preDecisionArtifacts(reader, files, decidedAt) {
  const found = [];
  for (const { root, rel } of files) {
    const f = reader.read(root, rel);
    if (!f || !(instant(f.mtime) < decidedAt) || !(instant(f.ctime) < decidedAt)) continue;
    found.push({ root, rel, sha256: f.sha, written_at: f.mtime, text: f.text });
  }
  // The latest artifacts before the decision are the closest to what it was taken on.
  found.sort((a, b) => instant(b.written_at) - instant(a.written_at));
  return found.slice(0, MAX_ARTIFACTS).map((a, i) => ({ ...a, ref: `a${i + 1}` }));
}

function request(record, artifacts) {
  return {
    task: "Propose zero or more reasonable alternatives to this decision, using only the artifacts given. "
      + "Cite each grounded assumption with the artifact ref and a verbatim quote from it; an assumption "
      + "without a citation is shown as unsupported. Do not rank alternatives or predict outcomes as facts.",
    // Only what was known when the decision was asked. The chosen option, its outcome and the listed
    // alternatives are summarised by the extractor from artifacts that may be written later (an
    // attempt's summary carries its final status), so they would let hindsight in; what the run knew
    // reaches the command only through the pre-decision artifacts below.
    decision: {
      id: record.id,
      stage: record.stage,
      question: record.question,
      decided_at: record.time.value,
    },
    artifacts: artifacts.map((a) => ({
      ref: a.ref,
      root: a.root,
      path: a.rel,
      written_at: a.written_at,
      truncated: a.text.length > MAX_ARTIFACT_CHARS,
      content: a.text.slice(0, MAX_ARTIFACT_CHARS),
    })),
    reply_format: {
      alternatives: [{
        summary: "string",
        assumptions: [{ text: "string", citations: [{ ref: "a1", quote: "verbatim text from that artifact" }] }],
        potential_consequences: ["string"],
        uncertainty: { level: "low|medium|high|unknown", note: "string" },
      }],
    },
  };
}

function runCommand(command, input, timeoutMs) {
  const result = spawnSync(command.file, command.args || [], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: timeoutMs,
    // A command can then stop its own work in time, as prompt-command.mjs does.
    env: { ...process.env, DECISION_MAP_GENERATOR_TIMEOUT_MS: String(timeoutMs), DECISION_MAP_GENERATOR_DEADLINE: String(Date.now() + timeoutMs) },
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) return { error: result.error.code === "ETIMEDOUT" ? "timed out" : "could not be started" };
  if (result.status !== 0) return { error: `exited with status ${result.status ?? result.signal}` };
  try {
    const reply = JSON.parse(result.stdout);
    if (!Array.isArray(reply?.alternatives)) return { error: "replied without an alternatives list" };
    return { alternatives: reply.alternatives };
  } catch {
    return { error: "replied with invalid JSON" };
  }
}

// A citation becomes evidence only if its ref is one of the artifacts given and its quote appears
// verbatim in what the command was shown. Hash and proof come from the reader, never from the reply.
function citedEvidence(citations, artifacts) {
  const evidence = [];
  for (const c of Array.isArray(citations) ? citations : []) {
    const artifact = artifacts.find((a) => a.ref === c?.ref);
    const quote = typeof c?.quote === "string" ? c.quote.trim() : "";
    if (!artifact || !quote || !artifact.text.slice(0, MAX_ARTIFACT_CHARS).includes(quote)) continue;
    evidence.push({ root: artifact.root, pointer: artifact.rel, sha256: artifact.sha256, version_proof: "pre_decision_time", excerpt: clip(quote, 300) });
  }
  return evidence;
}

function toItems(proposals, artifacts) {
  const items = [];
  for (const [i, p] of proposals.entries()) {
    if (typeof p?.summary !== "string" || !p.summary.trim()) continue;
    const assumptions = (Array.isArray(p.assumptions) ? p.assumptions : [])
      .filter((a) => typeof a?.text === "string" && a.text.trim())
      .map((a) => {
        const evidence = citedEvidence(a.citations, artifacts);
        // An assumption whose citations all fail is kept as grounded with no evidence, so the rules
        // drop it instead of showing a refuted claim as a plain guess.
        const cited = Array.isArray(a.citations) && a.citations.length > 0;
        return { text: clip(a.text.trim(), 300), basis: cited ? "grounded" : "unsupported", evidence };
      });
    const level = LEVELS.includes(p.uncertainty?.level) ? p.uncertainty.level : "unknown";
    const uncertainty = { level };
    if (typeof p.uncertainty?.note === "string" && p.uncertainty.note.trim()) uncertainty.note = clip(p.uncertainty.note.trim(), 300);
    items.push({
      option_id: `generated-${i + 1}`,
      summary: clip(p.summary.trim(), 500),
      assumptions,
      potential_consequences: (Array.isArray(p.potential_consequences) ? p.potential_consequences : [])
        .filter((c) => typeof c === "string" && c.trim()).map((c) => clip(c.trim(), 300)),
      uncertainty,
      classification: "generated",
      executed: "no",
    });
  }
  return items;
}

/**
 * Adds a generated_alternatives section to each selected record.
 * @param {object} options
 * @param {object[]} options.records the run's decision records v0
 * @param {object} options.reader a reader from createReader, pinned to the same run (and adapter)
 * @param {{ file: string, args?: string[], label?: string }} options.command reads one JSON request on stdin, writes one JSON reply on stdout
 * @param {(record: object) => boolean} [options.select] which decisions to generate for; default all
 * @param {number} [options.timeoutMs]
 * @param {() => Date} [options.now]
 * @returns {{ records: object[], dropped: object[] }}
 */
export function generateAlternatives({ records, reader, command, select = () => true, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() }) {
  const files = pointedFiles(records);
  const generator = { ...GENERATOR, command: command.label || basename(command.file) };
  const dropped = [];
  const out = records.map((record) => {
    if (!select(record)) return record;
    const section = (status, extra) => ({
      status,
      boundary: { ...record.time },
      generator: { ...generator, generated_at: now().toISOString() },
      items: [],
      ...extra,
    });
    const decidedAt = instant(record.time?.value);
    let result;
    if (Number.isNaN(decidedAt)) {
      result = section("withheld", { reason: "No decision time, so no pre-decision cutoff." });
    } else {
      const artifacts = preDecisionArtifacts(reader, files, decidedAt);
      if (!artifacts.length) {
        result = section("withheld", { reason: "No artifact could be shown to predate the decision unchanged." });
      } else {
        const reply = runCommand(command, request(record, artifacts), timeoutMs);
        result = reply.error
          ? section("withheld", { reason: `The generator command ${reply.error}.` })
          : section("generated", { items: toItems(reply.alternatives, artifacts) });
      }
    }
    const applied = applyGeneratedRules({ ...record, generated_alternatives: result });
    for (const d of applied.dropped) dropped.push({ decision: record.id, ...d });
    return applied.record;
  });
  return { records: out, dropped };
}

const USAGE = "Usage: node decision-map/generate.mjs [--adapter <octopus-home>] [--decision <id>]... [--timeout-seconds <n>] [--label <name>] <run-dir> -- <command> [args...]";

function parseArgs(argv) {
  const args = { decisions: [] };
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const [file, ...commandArgs] = split === -1 ? [] : argv.slice(split + 1);
  const value = (i, flag) => {
    if (i + 1 >= own.length) throw new Error(`${flag} needs a value. ${USAGE}`);
    return own[i + 1];
  };
  for (let i = 0; i < own.length; i += 1) {
    const a = own[i];
    if (a === "--adapter") args.adapterDir = value(i++, a);
    else if (a === "--decision") args.decisions.push(value(i++, a));
    else if (a === "--label") args.label = value(i++, a);
    else if (a === "--timeout-seconds") {
      const n = Number(value(i++, a));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout-seconds needs a positive number. ${USAGE}`);
      args.timeoutMs = n * 1000;
    } else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.runDir) args.runDir = a;
    else throw new Error(`Unknown argument: ${a}. ${USAGE}`);
  }
  if (!args.help && !args.runDir) throw new Error(`Missing run directory. ${USAGE}`);
  if (!args.help && !file) throw new Error(`Missing generator command after --. ${USAGE}`);
  args.command = { file, args: commandArgs, label: args.label };
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // Records go to stdout as JSON lines; a summary or error goes to stderr as one JSON line.
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stderr.write(`${JSON.stringify({ ok: true, usage: USAGE })}\n`);
    } else {
      // Records and artifacts are read from the same pinned run and adapter directories, so swapping
      // either path between extraction and generation cannot make them come from different trees.
      const runRoot = pinRoot("run directory", args.runDir);
      let adapterRoot = null;
      let reader = null;
      try {
        if (args.adapterDir) adapterRoot = pinRoot("--adapter", args.adapterDir);
        const records = extract({ runDir: args.runDir, runRoot, adapterRoot });
        reader = createReader({ runDir: args.runDir, runRoot, adapterRoot });
        const wanted = new Set(args.decisions);
        const result = generateAlternatives({
          records,
          reader,
          command: args.command,
          timeoutMs: args.timeoutMs,
          select: wanted.size ? (r) => wanted.has(r.id) : undefined,
        });
        for (const record of result.records) process.stdout.write(`${JSON.stringify(record)}\n`);
        const sections = result.records.map((r) => r.generated_alternatives).filter(Boolean);
        process.stderr.write(`${JSON.stringify({
          ok: true,
          decisions: sections.length,
          generated: sections.filter((s) => s.status === "generated").length,
          withheld: sections.filter((s) => s.status === "withheld").length,
          alternatives: sections.reduce((n, s) => n + s.items.length, 0),
          dropped: result.dropped.length,
        })}\n`);
      } finally {
        reader?.close();
        if (adapterRoot) closeSync(adapterRoot.fd);
        closeSync(runRoot.fd);
      }
    }
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}
