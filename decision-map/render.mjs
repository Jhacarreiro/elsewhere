#!/usr/bin/env node
// Static, self-contained HTML map of decision records (Phase 1 step 4).
// One-line summaries first; source, evidence, alternatives and uncertainty on expansion.
import { readFileSync, writeFileSync } from "node:fs";
import { filterDecisions } from "./filter.mjs";

const STAGES = ["planning", "plan_review", "implementation", "review", "correction", "final_validation", "delivery", "follow_up", "recovery", "other"];
const STAGE_LABEL = {
  planning: "Planning", plan_review: "Plan review", implementation: "Implementation", review: "Review",
  correction: "Correction", final_validation: "Final validation", delivery: "Delivery", follow_up: "Follow-up",
  recovery: "Recovery", other: "Other",
};
const STATE_LABEL = { decided: "Decided", pending: "Pending: asked, no answer", not_completed: "Not completed", superseded: "Superseded", unknown: "Unknown" };
const CLASS_LABEL = { observed: "Observed", "agent-stated": "Agent-stated", "post-hoc-inferred": "Inferred after the run" };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const badge = (kind, value, label) => `<span class="badge ${kind}-${esc(value)}">${esc(label ?? value)}</span>`;

function claim(title, c) {
  if (!c) return "";
  return `<div class="claim"><h4>${esc(title)} ${badge("cls", c.classification, CLASS_LABEL[c.classification])}</h4><p>${esc(c.text)}</p></div>`;
}

function alternatives(record) {
  const a = record.alternatives || { status: "unknown", items: [] };
  if (a.status === "unknown") return `<p class="muted">Alternatives: unknown. Nothing in the source says which other options were weighed.</p>`;
  if (a.status === "none_considered") return `<p class="muted">Alternatives: the source says none was considered.</p>`;
  const items = a.items.map((item) => `<li>
      <div><strong>${esc(item.option_id ? `${item.option_id}: ` : "")}</strong>${esc(item.summary)} ${badge("hyp", "no", "Hypothesis, not executed")} ${badge("cls", item.classification, CLASS_LABEL[item.classification])}</div>
      ${item.advantages?.length ? `<div class="pro">For: ${esc(item.advantages.join("; "))}</div>` : ""}
      ${item.limitations?.length ? `<div class="con">Against: ${esc(item.limitations.join("; "))}</div>` : ""}
    </li>`).join("");
  return `<h4>Alternatives (${a.items.length})</h4><ul class="alts">${items}</ul>`;
}

function decision(record) {
  const c = record.chosen;
  const when = record.time?.value ? `${record.time.value.replace("T", " ").slice(0, 16)}Z` : "time unknown";
  const who = [record.decided_by?.kind, record.decided_by?.role].filter(Boolean).join(" · ");
  const altCount = record.alternatives?.status === "listed" ? record.alternatives.items.length : null;
  const summary = `<summary>
      <span class="when">${esc(when)}</span>
      ${badge("state", record.state, STATE_LABEL[record.state])}
      <span class="q">${esc(record.question)}</span>
      <span class="meta">${esc(who)}${altCount != null ? ` · ${altCount} alternative${altCount === 1 ? "" : "s"}` : ""}</span>
    </summary>`;
  const chosen = c
    ? `<div class="claim"><h4>Chosen ${badge("cls", c.classification, CLASS_LABEL[c.classification])}</h4><p>${esc(c.summary)}</p>
        <p class="muted">Executed: ${esc(c.executed ?? "unknown")} · Validated: ${esc(c.validated ?? "unknown")}</p></div>
       ${c.outcome ? claim(c.outcome.classification === "observed" ? "Observed outcome" : "Stated consequence", c.outcome) : ""}`
    : `<p class="muted">${record.state === "pending" ? "No answer recorded yet." : record.state === "not_completed" ? "The attempt produced no result." : "No choice recorded."}</p>`;
  const rel = record.relevance || {};
  const unc = record.uncertainty || { level: "unknown" };
  const evidence = (record.evidence || []).map((e) => `<li><code>${esc(e.root)}:${esc(e.pointer)}</code> <span class="muted">${esc(e.artifact)} · sha256 ${esc(e.sha256.slice(0, 12))}…</span>${e.excerpt ? `<blockquote>${esc(e.excerpt)}</blockquote>` : ""}</li>`).join("");
  return `<details class="decision decision-${esc(record.state)}" id="${esc(record.id)}">
    ${summary}
    <div class="body">
      ${chosen}
      ${alternatives(record)}
      ${claim("Rationale", record.rationale) || `<p class="muted">Rationale: none recorded.</p>`}
      <p class="muted">Uncertainty: ${esc(unc.level)}${unc.note ? ` (${esc(unc.note)})` : ""} · Impact: ${esc(rel.impact ?? "unknown")} · Reversibility: ${esc(rel.reversibility ?? "unknown")} · Cost: ${esc(rel.cost ?? "unknown")}</p>
      <p class="muted">Record: ${badge("cls", record.classification, CLASS_LABEL[record.classification])} <code>${esc(record.id)}</code> · time source ${esc(record.time?.source ?? "unknown")}</p>
      <h4>Evidence</h4><ul class="evidence">${evidence}</ul>
    </div>
  </details>`;
}

export function renderMap(records, { title = "Decision map", filter = {} } = {}) {
  const { shown, hidden, criteria } = filterDecisions(records, filter);
  const runs = [...new Set(records.map((r) => r.run?.run_id).filter(Boolean))];
  const counts = (list, key) => list.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
  const states = counts(records, "state");
  const sections = STAGES.map((stage) => {
    const items = shown.filter((r) => (STAGES.includes(r.stage) ? r.stage : "other") === stage);
    if (!items.length) return "";
    return `<section><h2>${esc(STAGE_LABEL[stage])} <span class="muted">(${items.length})</span></h2>${items.map(decision).join("")}</section>`;
  }).join("");
  const attention = shown.filter((r) => r.state === "pending" || r.state === "not_completed");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#6b6a64; --card:#ffffff; --line:#e4e1d8; --obs:#1f6f43; --agent:#8a5a00; --inf:#6b3fa0; --pend:#b3261e; --hyp:#3a5a8c; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#a3a29b; --card:#1f1f1c; --line:#33322e; --obs:#6fcf97; --agent:#f2c94c; --inf:#bb9af7; --pend:#ff8a80; --hyp:#8ab4f8; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; } h2 { font-size: 1.1rem; margin: 28px 0 8px; } h4 { margin: 12px 0 4px; font-size: .9rem; }
.muted { color: var(--muted); font-size: .88rem; }
.legend, .note { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 12px 0; }
details.decision { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin: 6px 0; }
details.decision.decision-pending, details.decision.decision-not_completed { border-left: 4px solid var(--pend); }
summary { cursor: pointer; padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
summary .when { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; }
summary .q { flex: 1 1 320px; } summary .meta { color: var(--muted); font-size: .82rem; }
.body { padding: 0 14px 12px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.badge { display: inline-block; font-size: .72rem; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.cls-observed { color: var(--obs); } .cls-agent-stated { color: var(--agent); } .cls-post-hoc-inferred { color: var(--inf); }
.state-pending, .state-not_completed { color: var(--pend); } .state-decided { color: var(--obs); } .state-unknown, .state-superseded { color: var(--muted); }
.hyp-no { color: var(--hyp); }
ul.alts, ul.evidence { padding-left: 18px; } ul.alts li { margin: 6px 0; } .pro, .con { font-size: .88rem; color: var(--muted); }
blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: .85rem; }
code { font-size: .82rem; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p class="muted">${esc(runs.join(", ") || "no run id")} · ${records.length} decisions (${Object.entries(states).map(([k, v]) => `${v} ${STATE_LABEL[k] || k}`).join(", ")})</p>
  ${criteria.length ? `<p class="note">Filtered by ${esc(criteria.join("; "))}: showing ${shown.length} of ${records.length}; ${hidden.length} hidden. Pending and not-completed decisions are always shown.</p>` : ""}
  ${attention.length ? `<p class="note"><strong>${attention.length} need attention:</strong> ${attention.map((r) => `<a href="#${esc(r.id)}">${esc(r.question)}</a>`).join(" · ")}</p>` : ""}
  <div class="legend muted">
    ${badge("cls", "observed", "Observed")} recorded as a fact by the run ·
    ${badge("cls", "agent-stated", "Agent-stated")} an agent wrote it ·
    ${badge("cls", "post-hoc-inferred", "Inferred after the run")} ·
    ${badge("hyp", "no", "Hypothesis, not executed")} an alternative nobody ran.
    "Alternatives: unknown" means the source does not say, not that there were none.
  </div>
  ${sections || `<p class="muted">No decisions to show.</p>`}
</main>
</body>
</html>
`;
}

function parseArgs(argv) {
  const args = { filter: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--in") args.input = argv[++i];
    else if (a === "--out") args.output = argv[++i];
    else if (a === "--title") args.title = argv[++i];
    else if (a === "--min-impact") args.filter.minImpact = argv[++i];
    else if (a === "--min-uncertainty") args.filter.minUncertainty = argv[++i];
    else if (a === "--min-cost") args.filter.minCost = argv[++i];
    else if (a === "--reversibility") args.filter.reversibility = argv[++i].split(",");
    else if (a === "--exclude-unknown") args.filter.includeUnknown = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) {
    process.stderr.write("Usage: node decision-map/render.mjs --in decisions.jsonl --out map.html [--title T] [--min-impact low|medium|high] [--min-uncertainty ...] [--min-cost ...] [--reversibility easy,costly,irreversible] [--exclude-unknown]\n");
    process.exit(args.help ? 0 : 2);
  }
  const records = readFileSync(args.input, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  writeFileSync(args.output, renderMap(records, { title: args.title, filter: args.filter }));
}
