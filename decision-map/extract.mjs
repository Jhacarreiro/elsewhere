#!/usr/bin/env node
// Read-only extractor: Development Cycle run artifacts (and optionally the Octopus
// adapter's results) -> decision records v0, one JSON object per line.
// It never writes into the run or adapter directories.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export const PRODUCER = { name: "elsewhere-decision-extractor", version: "0.1.0", mode: "extracted" };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const clip = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
// Time from an epoch-seconds stamp in an adapter file name; an impossible stamp is unknown, not fatal.
const epochTime = (seconds) => {
  const t = Number(seconds) * 1000;
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15
    ? { value: new Date(t).toISOString(), source: "artifact_header" }
    : { value: null, source: "unknown" };
};

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const fdPath = (fd) => `/proc/self/fd/${fd}`;
export const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Pins a root as an open directory descriptor. Every later read walks from that descriptor one
// path component at a time, so renaming or replacing the root path cannot redirect it. Like the
// Development Cycle's own reader, a root reached through a symlink (at the root or any ancestor)
// is refused. This needs Linux /proc/self/fd, as the cycle's pinned reads do.
export function pinRoot(flag, dir) {
  if (!existsSync("/proc/self/fd")) throw new Error("The decision-map reader needs Linux /proc/self/fd.");
  const path = resolve(dir);
  let fd = null;
  try {
    const expected = lstatSync(path);
    fd = openSync(path, DIR_FLAGS);
    const opened = fstatSync(fd);
    if (!expected.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino || realpathSync(fdPath(fd)) !== path) throw new Error();
    return { path, fd };
  } catch {
    if (fd !== null) closeSync(fd);
    throw new Error(`${flag} must be a directory not reached through a symlink: ${dir}`);
  }
}

// Opens rel under the pinned root without following any symlink on the way. Directories are
// opened with O_DIRECTORY; the last component with the given flags. Returns a descriptor or null.
function openUnder(root, rel, lastFlags) {
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  let dirFd = root.fd;
  try {
    for (let i = 0; i < parts.length; i += 1) {
      const last = i === parts.length - 1;
      const next = openSync(`${fdPath(dirFd)}/${parts[i]}`, last ? lastFlags : DIR_FLAGS);
      if (dirFd !== root.fd) closeSync(dirFd);
      dirFd = next;
    }
    return parts.length ? dirFd : null;
  } catch {
    if (dirFd !== root.fd) closeSync(dirFd);
    return null;
  }
}

// Reads one regular file that lives under the pinned root: no symlinks (at the file or in a
// parent directory), no special files, nothing larger than maxBytes. Anything else is unreadable.
function readContained(root, rel, maxBytes) {
  // O_NONBLOCK so a FIFO cannot stall the open; the descriptor is then checked to be a file.
  const fd = openUnder(root, rel, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (fd === null) return null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { buf: buf.subarray(0, off), mtime: st.mtime.toISOString() };
  } finally {
    closeSync(fd);
  }
}

// One reader per extraction: caches file contents and hashes. Call close() when done.
// A caller that already pinned the run directory passes it as runRoot; the reader then reads from that
// same descriptor and leaves closing it to the caller.
export function createReader({ runDir, adapterDir = null, maxBytes = MAX_ARTIFACT_BYTES, runRoot = null }) {
  const roots = { run: runRoot || (runDir && pinRoot("--run", runDir)) };
  const owned = new Set(runRoot ? [] : ["run"]);
  try {
    roots.adapter = adapterDir && pinRoot("--adapter", adapterDir);
    owned.add("adapter");
  } catch (e) {
    if (roots.run && owned.has("run")) closeSync(roots.run.fd);
    throw e;
  }
  const cache = new Map();
  const read = (root, rel) => {
    const pinned = roots[root];
    if (!pinned) return null;
    const key = `${root}:${rel}`;
    if (!cache.has(key)) {
      try {
        const f = readContained(pinned, rel, maxBytes);
        cache.set(key, f && { text: f.buf.toString("utf8"), sha: sha256(f.buf), mtime: f.mtime });
      } catch {
        cache.set(key, null);
      }
    }
    return cache.get(key);
  };
  const json = (root, rel) => {
    const f = read(root, rel);
    if (!f) return null;
    try { return JSON.parse(f.text); } catch { return null; }
  };
  const jsonl = (root, rel) => {
    const f = read(root, rel);
    if (!f) return [];
    return f.text.split("\n").flatMap((line, i) => {
      if (!line.trim()) return [];
      try { return [{ line: i + 1, value: JSON.parse(line) }]; } catch { return []; }
    });
  };
  const list = (root, rel = "") => {
    const pinned = roots[root];
    if (!pinned) return [];
    if (!rel.split("/").some((p) => p && p !== ".")) {
      try { return readdirSync(fdPath(pinned.fd)); } catch { return []; }
    }
    const fd = openUnder(pinned, rel, DIR_FLAGS);
    if (fd === null) return [];
    try { return readdirSync(fdPath(fd)); } catch { return []; } finally { closeSync(fd); }
  };
  const close = () => {
    for (const [name, r] of Object.entries(roots)) if (r && owned.has(name)) closeSync(r.fd);
  };
  return { read, json, jsonl, list, close };
}

function evidence(reader, root, rel, pointer = "", excerpt = "") {
  const f = reader.read(root, rel);
  if (!f) return null;
  const e = { artifact: artifactName(rel), root, pointer: `${rel}${pointer}`, sha256: f.sha };
  if (excerpt) e.excerpt = clip(excerpt, 300);
  return e;
}

function artifactName(rel) {
  const name = basename(rel);
  const rules = [
    [/^status\.json$/, "run_status"],
    [/^intervention\.json$/, "intervention_request"],
    [/^implementation_intervention\.json$/, "intervention"],
    [/^implementation_intervention_response\.json$/, "intervention_response"],
    [/^main_update_events\.jsonl$/, "failure_classification"],
    [/^validation_result\.json$/, "mechanical_validation"],
    [/^final_validation_response\.md$/, "final_validation"],
    [/^repository_delivery\.json$/, "repository_delivery"],
    [/^summary\.json$/, "council_summary"],
    [/^review-debate-/, "review_debate"],
    [/^review-findings-/, "review_findings"],
    [/^tangle-review-corrections-/, "correction_report"],
    [/^tangle-validation-/, "quality_gate"],
    [/^sync-result-/, "seat_output"],
    [/^implementation_plan\.md$/, "approved_plan"],
  ];
  for (const [re, label] of rules) if (re.test(name)) return label;
  return name.replace(/\.[a-z]+$/, "");
}

function makeRecord(runId, base, primary, anchor) {
  const id = `dec_${sha256(`${runId}\n${primary.root}:${primary.pointer}\n${anchor}`).slice(0, 16)}`;
  return { schema_version: 0, id, ...base, producer: PRODUCER };
}

// The record's overall classification is the weakest of its parts.
const ORDER = ["observed", "agent-stated", "post-hoc-inferred"];
function weakest(...classes) {
  return classes.filter(Boolean).reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "observed");
}

function finish(record) {
  record.classification = weakest(
    record.chosen?.classification,
    record.chosen?.outcome?.classification,
    record.rationale?.classification,
    record.question_classification,
    ...(record.alternatives?.items || []).map((item) => item.classification),
  );
  delete record.question_classification;
  if (!record.uncertainty) record.uncertainty = { level: "unknown" };
  if (!record.relevance) record.relevance = { impact: "unknown", reversibility: "unknown", cost: "unknown", uncertainty: "unknown" };
  record.evidence = record.evidence.filter(Boolean);
  return record;
}

const UNKNOWN_ALTERNATIVES = { status: "unknown", items: [] };

// ---------- control-plane artifacts (run directory) ----------

function controlPlaneRecords(reader, status, runId) {
  const out = [];
  const run = { run_id: runId };
  if (status.followUp?.rootRunId) run.root_run_id = status.followUp.rootRunId;
  if (Number.isInteger(status.followUp?.generation)) run.generation = status.followUp.generation;

  // Plan approval.
  if (status.canonicalPlanGit?.commit || reader.read("run", "implementation_plan.md")) {
    const ev = [evidence(reader, "run", "status.json", "#/canonicalPlanGit"), evidence(reader, "run", "implementation_plan.md")].filter(Boolean);
    const commit = status.canonicalPlanGit?.commit;
    // The run records no approval time; the approved plan file's time is the closest evidence.
    const plan = reader.read("run", "implementation_plan.md");
    out.push(finish(makeRecord(runId, {
      run, stage: "planning",
      time: plan ? { value: plan.mtime, source: "file_mtime" } : { value: null, source: "unknown" },
      decided_by: { kind: "human" },
      question: "Approve the implementation plan for this run.",
      state: "decided",
      chosen: { summary: commit ? `Plan approved and tracked as commit ${commit}.` : "Plan approved.", classification: "observed", executed: "yes", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: null,
      evidence: ev,
    }, ev[0], "plan")));
  }

  // Continuation from follow-up issues.
  if (status.followUp?.fromRunId) {
    const f = status.followUp;
    const ev = [evidence(reader, "run", "status.json", "#/followUp")];
    out.push(finish(makeRecord(runId, {
      run, stage: "follow_up",
      time: status.createdAt ? { value: status.createdAt, source: "artifact_field" } : { value: null, source: "unknown" },
      decided_by: { kind: "control_plane" },
      question: "Continue the parent run's open issues instead of starting a new run.",
      state: "decided",
      chosen: { summary: clip(`Continue run ${f.fromRunId} on its delivery branch${f.pullRequest?.number ? ` (PR #${f.pullRequest.number})` : ""}, working issues ${(f.issues || []).map((i) => `#${i.number ?? i}`).join(", ") || "none listed"}.`, 500), classification: "observed", executed: "yes", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: null,
      evidence: ev,
    }, ev[0], "follow-up")));
  }

  // Failure classifications: one record per distinct class and phase.
  const seen = new Set();
  for (const { line, value: e } of reader.jsonl("run", "main_update_events.jsonl")) {
    const c = e.classification;
    if (!c?.failureClass) continue;
    const key = `${c.failureClass}|${e.phase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = [evidence(reader, "run", "main_update_events.jsonl", `#L${line}`)];
    out.push(finish(makeRecord(runId, {
      run, stage: "recovery",
      time: { value: e.createdAt || null, source: e.createdAt ? "artifact_field" : "unknown" },
      decided_by: { kind: "control_plane" },
      question: clip(`Classify the failure seen in phase ${e.phase || "unknown"}.`, 500),
      state: "decided",
      chosen: { summary: clip(`${c.failureClass}: ${c.recommendedAction || "no recommended action recorded"}`, 500), classification: "observed", executed: "unknown", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: c.matched?.pattern ? { text: clip(`Matched rule ${c.matched.name || ""}: ${c.matched.pattern}`, 1000), classification: "observed" } : null,
      relevance: {
        impact: c.severity === "error" || c.autoStopRecommended ? "high" : c.severity === "warning" ? "medium" : "unknown",
        reversibility: "unknown", cost: "unknown", uncertainty: "unknown",
      },
      evidence: ev,
    }, ev[0], key)));
  }

  // Human interventions: every attempt's request, plus the durable copy and any answer.
  const response = reader.json("run", "implementation_intervention_response.json");
  const requests = [];
  for (const session of ["implementation_session", "corrections_session"]) {
    for (const attempt of reader.list("run", `${session}/attempts`)) {
      const rel = `${session}/attempts/${attempt}/intervention.json`;
      const value = reader.json("run", rel);
      if (value?.question) requests.push({ rel, value, attempt });
    }
  }
  const durable = reader.json("run", "implementation_intervention.json");
  if (durable?.question && !requests.some((r) => (r.value.id || "") === (durable.id || "") && r.value.question === durable.question)) {
    requests.push({ rel: "implementation_intervention.json", value: durable, attempt: durable.sourceAttemptId || undefined });
  }
  for (const { rel, value, attempt } of requests) {
    // An answer belongs to one request: matched by id, or, when ids are missing, to the durable
    // request it was written for (or the only request there is).
    const isDurable = rel === "implementation_intervention.json" || (durable?.question === value.question && (durable.id || "") === (value.id || ""));
    const answered = Boolean(response) && (response.id && value.id
      ? response.id === value.id
      : (durable ? isDurable : requests.length === 1));
    const items = (Array.isArray(value.options) ? value.options : []).map((o) => {
      if (o && typeof o === "object") {
        const item = { summary: clip(o.summary || o.id || JSON.stringify(o), 500), classification: "agent-stated", executed: "no" };
        if (o.id) item.option_id = String(o.id);
        if (o.advantages) item.advantages = [clip(o.advantages, 300)];
        if (o.limitations) item.limitations = [clip(o.limitations, 300)];
        return item;
      }
      return { summary: clip(o, 500), classification: "agent-stated", executed: "no" };
    });
    const ev = [evidence(reader, "run", rel, "#/question"), answered ? evidence(reader, "run", "implementation_intervention_response.json", "#/response") : null];
    out.push(finish(makeRecord(runId, {
      run: attempt ? { ...run, attempt_id: attempt } : run,
      stage: "implementation",
      time: value.createdAt ? { value: value.createdAt, source: "artifact_field" } : { value: null, source: "unknown" },
      decided_by: { kind: "human" },
      question: clip(value.question, 500),
      question_classification: "agent-stated",
      state: answered ? "decided" : "pending",
      chosen: answered ? { summary: clip(response.response, 500), classification: "observed", executed: "unknown", validated: "unknown" } : null,
      alternatives: items.length ? { status: "listed", items } : UNKNOWN_ALTERNATIVES,
      rationale: value.context ? { text: clip(value.context, 1000), classification: "agent-stated" } : null,
      uncertainty: value.recommendedOption == null && items.length ? { level: "high", note: "The asking agent recommended no option." } : undefined,
      evidence: ev,
    }, ev[0], `intervention:${value.id || ""}`)));
  }

  // Runner attempts: what the control plane launched and how each one ended.
  for (const [session, stage] of [["implementation_session", "implementation"], ["corrections_session", "correction"]]) {
    for (const attempt of reader.list("run", `${session}/attempts`)) {
      const rel = `${session}/attempts/${attempt}/status.json`;
      const st = reader.json("run", rel);
      if (!st) continue;
      const ev = [evidence(reader, "run", rel, "#/status")];
      const ended = st.status ? `${st.status}${st.exitCode != null ? ` (exit ${st.exitCode})` : ""}` : "unknown";
      out.push(finish(makeRecord(runId, {
        run: { ...run, attempt_id: attempt }, stage,
        time: { value: st.createdAt || null, source: st.createdAt ? "artifact_field" : "unknown" },
        decided_by: { kind: "control_plane" },
        question: stage === "implementation" ? "Launch an implementation attempt for the approved plan." : "Launch a corrections attempt for the review feedback.",
        state: "decided",
        chosen: {
          summary: clip(`Launched ${st.command || "the runner"}; it ended ${ended}${st.updatedAt ? ` at ${st.updatedAt}` : ""}.`, 500),
          classification: "observed", executed: "yes",
          validated: ["failed", "interrupted"].includes(st.status) ? "no" : "unknown",
          outcome: { text: clip(st.message || ended, 1000), classification: "observed" },
        },
        alternatives: UNKNOWN_ALTERNATIVES,
        rationale: null,
        evidence: ev,
      }, ev[0], `attempt:${attempt}`)));
    }
  }

  // Mechanical final validation.
  const validation = reader.json("run", "validation_result.json");
  if (validation?.decision) {
    const ev = [evidence(reader, "run", "validation_result.json", "#/decision")];
    const failures = Array.isArray(validation.failures) ? validation.failures : [];
    out.push(finish(makeRecord(runId, {
      run, stage: "final_validation",
      time: { value: validation.generatedAt || null, source: validation.generatedAt ? "artifact_field" : "unknown" },
      decided_by: { kind: "control_plane", role: "mechanical-validation" },
      question: "Do the mechanical validation checks pass for the delivered checkout?",
      state: "decided",
      chosen: { summary: clip(`${validation.decision}${validation.reason ? ` (${validation.reason})` : ""}`, 500), classification: "observed", executed: "yes", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: failures.length ? { text: clip(failures.map((f) => f.reason || f.check || JSON.stringify(f)).join("; "), 1000), classification: "observed" } : null,
      evidence: ev,
    }, ev[0], "mechanical-validation")));
  }

  // Council code review runs stored under the run directory.
  for (const councilId of reader.list("run", "council-code-review")) {
    for (const stamp of reader.list("run", `council-code-review/${councilId}`)) {
      const rel = `council-code-review/${councilId}/${stamp}/summary.json`;
      const summary = reader.json("run", rel);
      if (!summary) continue;
      const seats = Array.isArray(summary.seats) ? summary.seats : [];
      const verdicts = seats.map((s) => `${s.persona || s.seat}: ${s.verdict || s.status || "no verdict"}`).join("; ");
      const met = summary.quorum?.met === true;
      // Octopus can report quorum "not met" (for example, too few approving providers) while
      // enough seats answered; the cycle then acts on their verdicts, so that is a decision.
      const answered = seats.map((s) => String(s.verdict || "").toLowerCase()).filter(Boolean);
      const verdict = answered.length && answered.every((v) => v === answered[0]) ? answered[0] : null;
      const decided = met || answered.length >= Number(summary.quorum?.required_non_chair ?? Infinity);
      const ev = [evidence(reader, "run", rel, "#/quorum")];
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp);
      out.push(finish(makeRecord(runId, {
        run, stage: "review",
        time: m ? { value: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, source: "artifact_header" } : { value: null, source: "unknown" },
        decided_by: { kind: "council", role: "code-review-council" },
        question: "Does the council approve the delivered code?",
        state: decided ? "decided" : "not_completed",
        chosen: decided ? { summary: clip(`${verdict ? `All ${answered.length} answering seats: ${verdict}` : "Split verdicts"}${met ? "" : " (quorum not met)"}. ${verdicts}`, 500), classification: "observed", executed: "unknown", validated: "unknown" } : null,
        alternatives: UNKNOWN_ALTERNATIVES,
        rationale: { text: clip(`Status ${summary.status || "unknown"}; quorum ${met ? "met" : "not met"} (${summary.quorum?.received_non_chair ?? "?"} of ${summary.quorum?.required_non_chair ?? "?"} required non-chair responses). Seats: ${verdicts || "none"}`, 1000), classification: "observed" },
        evidence: ev,
      }, ev[0], "council")));
    }
  }

  // Final decision (go / revise / stop). Automatic council rounds overwrite this file.
  const final = reader.read("run", "final_validation_response.md");
  if (final) {
    // Same boundary as the cycle's own parser: "REVISE: ..." and "go." are decisions too.
    const first = /^(go|revise|stop)\b/i.exec(final.text.trimStart())?.[1]?.toLowerCase();
    if (first) {
      const ev = [evidence(reader, "run", "final_validation_response.md", "#L1")];
      const council = /^revise\W+Council code review/i.test(final.text.trimStart());
      out.push(finish(makeRecord(runId, {
        run, stage: "final_validation",
        time: { value: final.mtime, source: "file_mtime" },
        decided_by: { kind: council ? "council" : "unknown" },
        question: "Ship, revise or stop the delivered work?",
        state: "decided",
        chosen: { summary: first, classification: "observed", executed: "unknown", validated: "unknown" },
        alternatives: UNKNOWN_ALTERNATIVES,
        rationale: { text: clip(final.text.trimStart().slice(first.length), 1000) || "No reason recorded.", classification: council ? "agent-stated" : "observed" },
        uncertainty: { level: "unknown", note: "This file is overwritten on every automatic council round; earlier decisions are not kept here." },
        evidence: ev,
      }, ev[0], "final")));
    }
  }

  // Delivery.
  const delivery = reader.json("run", "repository_delivery.json");
  if (delivery) {
    const ev = [evidence(reader, "run", "repository_delivery.json")];
    const pr = delivery.pullRequest?.number ? `PR #${delivery.pullRequest.number} (${delivery.pullRequest.state || "state unknown"})` : "no pull request";
    const issues = (delivery.issues || []).map((i) => `#${i.number}`).join(", ");
    out.push(finish(makeRecord(runId, {
      run, stage: "delivery",
      time: { value: delivery.completedAt || null, source: delivery.completedAt ? "artifact_field" : "unknown" },
      decided_by: { kind: "control_plane" },
      question: "How is this run's work delivered to the repository?",
      state: "decided",
      chosen: { summary: clip(`${delivery.classification || "delivery"}: ${pr}, merged ${delivery.merged ? "yes" : "no"}${issues ? `, follow-up issues ${issues}` : ""}, commit ${delivery.commit || "unknown"}.`, 500), classification: "observed", executed: delivery.ok ? "yes" : "unknown", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: null,
      relevance: { impact: "unknown", reversibility: delivery.merged ? "costly" : "easy", cost: "unknown", uncertainty: "unknown" },
      evidence: ev,
    }, ev[0], "delivery")));
  }
  return out;
}

// ---------- Octopus adapter artifacts ----------

function debateSummary(decision) {
  const d = String(decision).toLowerCase();
  if (["include", "retain", "keep", "confirm", "confirmed"].includes(d)) return "Keep the finding.";
  if (["exclude", "drop", "dismiss", "reject", "rejected"].includes(d)) return "Drop the finding.";
  return clip(decision, 500);
}
const toEpoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// Find the adapter run ledgers whose seats worked on one of this run's attempts.
function octopusLedgers(reader, attemptIds) {
  const ledgers = [];
  for (const runName of reader.list("adapter", "runs")) {
    const ledger = reader.json("adapter", `runs/${runName}/run.json`);
    const seats = Array.isArray(ledger?.seats) ? ledger.seats : [];
    // The attempt id must be a whole path segment: attempt-1 must not match attempt-10.
    const segments = (p) => String(p || "").split(/[\\/]/);
    const touches = seats.some((s) => [s.execution?.worktree, s.artifacts?.output].some((p) => segments(p).some((seg) => attemptIds.includes(seg))));
    if (touches) ledgers.push({ runName, seats });
  }
  return ledgers;
}

function octopusRecords(reader, status, runId) {
  const out = [];
  const attemptIds = [status.implementationAttemptId, status.correctionsAttemptId, ...reader.list("run", "implementation_session/attempts"), ...reader.list("run", "corrections_session/attempts")].filter(Boolean);
  const ledgers = octopusLedgers(reader, [...new Set(attemptIds)]);
  const run = { run_id: runId };
  const results = new Set(reader.list("adapter", "results"));
  const resultRel = (output) => {
    const name = basename(String(output || ""));
    return results.has(name) ? `results/${name}` : null;
  };

  for (const { runName, seats } of ledgers) {
    // Design review ceremony: conflicts between planning seats and their resolution.
    for (const seat of seats.filter((s) => s.execution?.phase === "ceremony" && s.execution?.role === "design-synthesizer")) {
      const rel = resultRel(seat.artifacts?.output);
      const body = rel && reader.read("adapter", rel);
      if (!body) continue;
      let synth = null;
      try { synth = JSON.parse(body.text.split("\n## Status")[0]); } catch { continue; }
      (synth.conflicts || []).forEach((conflict, i) => {
        const text = String(conflict);
        const [positions, resolution] = text.split(/\bResolution:\s*/);
        const parts = positions.split(/(?=\bSeats?\s+\d)/).map((p) => p.trim().replace(/[;.]\s*$/, "")).filter((p) => /^Seats?\s+\d/.test(p));
        const head = positions.split(/:\s/)[0];
        const topic = /^Seats?\s+\d/.test(head) ? "a point of the plan" : clip(head, 120);
        const ev = [evidence(reader, "adapter", rel, `#/conflicts/${i}`), evidence(reader, "adapter", `runs/${runName}/run.json`)];
        out.push(finish(makeRecord(runId, {
          run, stage: "plan_review",
          time: { value: seat.timestamp || null, source: seat.timestamp ? "artifact_field" : "unknown" },
          decided_by: { kind: "council", role: "design-synthesizer", configured_model: [seat.requested?.provider, seat.requested?.model].filter(Boolean).join("/") || undefined },
          question: clip(`Resolve the planning seats' disagreement on ${topic}.`, 500),
          state: resolution ? "decided" : "unknown",
          chosen: resolution ? { summary: clip(resolution, 500), classification: "agent-stated", executed: "unknown", validated: "unknown" } : null,
          alternatives: parts.length >= 2 ? { status: "listed", items: parts.map((p) => ({ summary: clip(p, 500), classification: "agent-stated", executed: "no" })) } : UNKNOWN_ALTERNATIVES,
          rationale: null,
          evidence: ev,
        }, ev[0], `ceremony:${i}`)));
      });
    }

    // Review rounds, ordered by their marker timestamp.
    const markers = [...new Set(seats.map((s) => /(\d{9,})-octopus-tangle-review-marker\.[A-Za-z0-9]+/.exec(String(s.seat_id || ""))?.[0]).filter(Boolean))]
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
    markers.forEach((marker, round) => {
      const stamp = marker.split("-")[0];
      const findingsRel = results.has(`review-findings-${marker}.json`) ? `results/review-findings-${marker}.json` : null;
      const findings = findingsRel && reader.json("adapter", findingsRel);
      if (findings) {
        const kept = Array.isArray(findings.findings) ? findings.findings : [];
        const excluded = Array.isArray(findings.excluded) ? findings.excluded : [];
        const bySeverity = {};
        for (const f of kept) bySeverity[f.severity || "unknown"] = (bySeverity[f.severity || "unknown"] || 0) + 1;
        const ev = [evidence(reader, "adapter", findingsRel)];
        out.push(finish(makeRecord(runId, {
          run: { ...run, round }, stage: "review",
          time: epochTime(stamp),
          decided_by: { kind: "council", role: "review-synthesis" },
          question: `Which findings stand after review round ${round}?`,
          state: "decided",
          chosen: { summary: clip(`${kept.length} findings kept (${Object.entries(bySeverity).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}), ${excluded.length} excluded by debate.`, 500), classification: "observed", executed: "unknown", validated: "unknown" },
          alternatives: UNKNOWN_ALTERNATIVES,
          rationale: null,
          relevance: { impact: (bySeverity.normal || bySeverity.blocking || bySeverity.high || bySeverity.critical) ? "high" : kept.length ? "low" : "unknown", reversibility: "unknown", cost: "unknown", uncertainty: "unknown" },
          evidence: ev,
        }, ev[0], `round:${marker}`)));
      }
      const debateRel = results.has(`review-debate-${marker}.json`) ? `results/review-debate-${marker}.json` : null;
      const debate = debateRel && reader.json("adapter", debateRel);
      (debate?.decisions || []).forEach((d, i) => {
        const ev = [evidence(reader, "adapter", debateRel, `#/decisions/${i}`, d.evidence)];
        const severity = d.finding?.severity;
        out.push(finish(makeRecord(runId, {
          run: { ...run, round }, stage: "review",
          time: epochTime(stamp),
          decided_by: { kind: "council", role: "review-debater", configured_model: debate.provider || undefined },
          question: clip(`Keep or drop the contested finding: ${d.finding?.title || d.debate_id}`, 500),
          state: d.decision ? "decided" : "unknown",
          chosen: d.decision ? { summary: debateSummary(d.decision), classification: "observed", executed: "unknown", validated: "unknown" } : null,
          alternatives: UNKNOWN_ALTERNATIVES,
          rationale: d.reason ? { text: clip(d.reason, 1000), classification: "agent-stated" } : null,
          relevance: { impact: severity === "nit" ? "low" : severity ? "medium" : "unknown", reversibility: "unknown", cost: "unknown", uncertainty: d.finding?.verdict === "needs-debate" ? "high" : "unknown" },
          evidence: ev,
        }, ev[0], `debate:${marker}:${d.debate_id || i}`)));
      });
    });

    // Correction rounds: a correction report carries no run id, so it is linked through
    // the implementer seat that wrote it or, failing that, by falling inside this
    // ledger's window (first review round to last recorded seat).
    const implementerStamps = new Set(seats.filter((s) => s.execution?.phase === "tangle" && s.execution?.role === "implementer")
      .map((s) => /sync-result-(\d+)-/.exec(String(s.artifacts?.output || ""))?.[1]).filter(Boolean));
    const seatTimes = seats.map((s) => toEpoch(s.timestamp)).filter(Number.isFinite);
    const windowStart = markers.length ? Number(markers[0].split("-")[0]) : Infinity;
    const windowEnd = seatTimes.length ? Math.max(...seatTimes) : -Infinity;
    for (const name of [...results].filter((n) => /^tangle-review-corrections-\d+-\d+\.md$/.test(n)).sort()) {
      const [, n, stamp] = /^tangle-review-corrections-(\d+)-(\d+)\.md$/.exec(name);
      const inWindow = Number(stamp) >= windowStart && Number(stamp) <= windowEnd;
      if (!implementerStamps.has(stamp) && !inWindow) continue;
      const rel = `results/${name}`;
      const body = reader.read("adapter", rel);
      if (!body) continue;
      const stalled = /Status:\s*STALLED/i.test(body.text);
      const ev = [evidence(reader, "adapter", rel)];
      out.push(finish(makeRecord(runId, {
        run: { ...run, round: Number(n) }, stage: "correction",
        time: epochTime(stamp),
        decided_by: { kind: "agent", role: "implementer" },
        question: `How should correction round ${n} fix the standing findings?`,
        state: stalled ? "not_completed" : "decided",
        chosen: stalled ? null : { summary: clip(body.text.replace(/^#+\s.*$/gm, ""), 500) || "Correction applied.", classification: "agent-stated", executed: "yes", validated: "unknown" },
        alternatives: UNKNOWN_ALTERNATIVES,
        rationale: null,
        uncertainty: stalled ? { level: "high", note: "The correction stalled and wrote only partial results." } : undefined,
        evidence: ev,
      }, ev[0], `correction:${n}:${stamp}`)));
    }
  }

  // Quality gate decisions for this run's attempts.
  for (const attempt of [...new Set(attemptIds)]) {
    const name = `tangle-validation-${attempt}.md`;
    if (!results.has(name)) continue;
    const rel = `results/${name}`;
    const file = reader.read("adapter", rel);
    if (!file) continue;
    const body = file.text;
    const gate = /Quality Gate:\s*([A-Z_-]+)/.exec(body)?.[1];
    const branch = /Decision Branch:\s*([\w-]+)/.exec(body)?.[1];
    if (!branch) continue;
    const ev = [evidence(reader, "adapter", rel, "#Decision-Branch")];
    out.push(finish(makeRecord(runId, {
      run: { ...run, attempt_id: attempt }, stage: "review",
      time: generatedAt(body) ? { value: generatedAt(body), source: "artifact_header" } : { value: file.mtime, source: "file_mtime" },
      decided_by: { kind: "adapter_rule", role: "quality-gate" },
      question: "Proceed, retry or stop after the adapter's quality gate?",
      state: "decided",
      chosen: { summary: clip(`${branch}${gate ? ` (gate ${gate})` : ""}`, 500), classification: "observed", executed: "yes", validated: "unknown" },
      alternatives: UNKNOWN_ALTERNATIVES,
      rationale: null,
      evidence: ev,
    }, ev[0], `gate:${attempt}`)));
  }
  return out;
}

// "Generated:" header written by the adapter, either ISO 8601 or date(1)'s default format
// ("Mon Jun  8 08:00:10 WEST 2026"). Unknown zone names give null rather than a guess.
const ZONES = { UTC: "+00:00", GMT: "+00:00", WET: "+00:00", WEST: "+01:00", CET: "+01:00", CEST: "+02:00" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function generatedAt(text) {
  const raw = /^[#\s]*Generated:\s*(.+?)\s*$/m.exec(text)?.[1];
  if (!raw) return null;
  const d = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([A-Z]+)\s+(\d{4})$/.exec(raw);
  let iso = null;
  if (d) {
    const month = MONTHS.indexOf(d[1]) + 1;
    if (month && ZONES[d[4]]) iso = `${d[5]}-${String(month).padStart(2, "0")}-${d[2].padStart(2, "0")}T${d[3]}${ZONES[d[4]]}`;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    iso = raw;
  }
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Records are ordered by the instant they name, whatever offset it is written in; unknown times last.
const instant = (r) => {
  const t = Date.parse(r.time?.value ?? "");
  return Number.isNaN(t) ? Infinity : t;
};

export function extract({ runDir, adapterDir = null, maxBytes, runRoot = null }) {
  const reader = createReader({ runDir, adapterDir, maxBytes, runRoot });
  let records;
  try {
    const status = reader.json("run", "status.json");
    if (!status) throw new Error(`No readable status.json in ${runDir}`);
    const runId = String(status.runId || basename(runDir));
    records = [...controlPlaneRecords(reader, status, runId), ...(adapterDir ? octopusRecords(reader, status, runId) : [])];
  } finally {
    reader.close();
  }
  // Records whose evidence could not be read are not emitted: every claim needs a source.
  return records
    .filter((r) => r.evidence.length > 0)
    .sort((a, b) => instant(a) - instant(b));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--run") args.runDir = argv[++i];
    else if (a === "--adapter") args.adapterDir = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runDir || !existsSync(args.runDir)) {
    process.stderr.write("Usage: node decision-map/extract.mjs --run <run-dir> [--adapter <octopus-home>] > decisions.jsonl\n");
    process.exit(args.help ? 0 : 2);
  }
  for (const record of extract(args)) process.stdout.write(`${JSON.stringify(record)}\n`);
}
