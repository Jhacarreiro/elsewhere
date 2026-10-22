import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "../decision-map/extract.mjs";
import { filterDecisions } from "../decision-map/filter.mjs";
import { renderMap } from "../decision-map/render.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const runDir = join(fixtures, "run-a");
const adapterDir = join(fixtures, "octopus");
const records = () => extract({ runDir, adapterDir });
const byStage = (list, stage) => list.filter((r) => r.stage === stage);

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out[p] = `${s.size}:${s.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test("extraction leaves the run and adapter directories untouched", () => {
  const before = snapshot(fixtures);
  records();
  assert.deepEqual(snapshot(fixtures), before);
});

test("an unanswered intervention is pending, keeps its options as unexecuted hypotheses and invents no choice", () => {
  const [intervention] = records().filter((r) => r.decided_by.kind === "human" && r.stage === "implementation");
  assert.equal(intervention.state, "pending");
  assert.equal(intervention.chosen, null);
  assert.equal(intervention.alternatives.status, "listed");
  assert.deepEqual(intervention.alternatives.items.map((i) => i.option_id), ["one_time_token", "operator_only"]);
  assert.ok(intervention.alternatives.items.every((i) => i.executed === "no" && i.classification === "agent-stated"));
  assert.equal(intervention.uncertainty.level, "high");
});

test("a recorded answer turns the intervention into an observed decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-map-"));
  try {
    cpSync(runDir, dir, { recursive: true });
    writeFileSync(join(dir, "implementation_intervention_response.json"), JSON.stringify({ id: "approval-auth", response: "operator_only" }));
    const [intervention] = extract({ runDir: dir }).filter((r) => r.decided_by.kind === "human" && r.stage === "implementation");
    assert.equal(intervention.state, "decided");
    assert.equal(intervention.chosen.summary, "operator_only");
    assert.equal(intervention.chosen.classification, "observed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an answer to another request leaves this one pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-map-"));
  try {
    cpSync(runDir, dir, { recursive: true });
    writeFileSync(join(dir, "implementation_intervention.json"), JSON.stringify({ id: "different-request", question: "Which publish window?", options: ["now", "later"] }));
    writeFileSync(join(dir, "implementation_intervention_response.json"), JSON.stringify({ id: "different-request", response: "later" }));
    const humans = extract({ runDir: dir }).filter((r) => r.decided_by.kind === "human" && r.stage === "implementation");
    const decided = humans.filter((r) => r.state === "decided");
    assert.equal(humans.length, 2);
    assert.deepEqual(decided.map((r) => [r.question, r.chosen.summary]), [["Which publish window?", "later"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every evidence pointer names a real file whose content hash matches", () => {
  for (const record of records()) {
    assert.ok(record.evidence.length > 0, record.id);
    for (const e of record.evidence) {
      const file = join(e.root === "run" ? runDir : adapterDir, e.pointer.split("#")[0]);
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), e.sha256, e.pointer);
    }
  }
});

test("ids are stable across extractions and unique within a run", () => {
  const first = records().map((r) => r.id);
  assert.deepEqual(records().map((r) => r.id), first);
  assert.equal(new Set(first).size, first.length);
});

test("records keep the schema's state and alternatives invariants", () => {
  for (const r of records()) {
    assert.equal(r.chosen !== null, ["decided", "superseded"].includes(r.state), `${r.id} ${r.state}`);
    assert.equal(r.alternatives.items.length > 0, r.alternatives.status === "listed", r.id);
  }
});

test("adapter artifacts are linked to this run only", () => {
  const list = records();
  const ceremony = byStage(list, "plan_review");
  assert.equal(ceremony.length, 2, "only the related ledger's two conflicts");
  assert.ok(!ceremony.some((r) => /Unrelated/.test(r.question)));
  const corrections = byStage(list, "correction").filter((r) => r.decided_by.kind === "agent");
  assert.deepEqual(corrections.map((r) => r.state), ["decided", "not_completed"]);
});

test("the seats' positions become listed alternatives; agreement leaves them unknown", () => {
  const [approval, scope] = byStage(records(), "plan_review");
  assert.equal(approval.alternatives.status, "listed");
  assert.equal(approval.alternatives.items.length, 2);
  assert.equal(approval.classification, "agent-stated");
  assert.equal(scope.alternatives.status, "unknown");
  assert.equal(scope.state, "unknown");
});

test("a failed corrections attempt, a council that never answered, a unanimous council without formal quorum and repeated failure events are recorded as observed", () => {
  const list = records();
  const attempt = byStage(list, "correction").find((r) => r.decided_by.kind === "control_plane");
  assert.equal(attempt.chosen.validated, "no");
  assert.match(attempt.chosen.outcome.text, /non-zero/);
  const [silent, unanimous] = list.filter((r) => r.decided_by.role === "code-review-council");
  assert.equal(silent.state, "not_completed");
  assert.equal(unanimous.state, "decided", "enough answering seats is a verdict even when quorum is reported as not met");
  assert.match(unanimous.chosen.summary, /All 3 answering seats: revise \(quorum not met\)/);
  assert.equal(byStage(list, "recovery").length, 1, "duplicate classification in the same phase is folded");
});

test("the relevance filter hides low-impact decisions but never pending or unfinished ones", () => {
  const list = records();
  const { shown, hidden, criteria } = filterDecisions(list, { minImpact: "high", includeUnknown: false });
  assert.ok(criteria.length > 0);
  assert.equal(shown.length + hidden.length, list.length);
  assert.ok(shown.every((r) => r.relevance.impact === "high" || ["pending", "not_completed"].includes(r.state)));
  assert.ok(shown.some((r) => r.state === "pending"));
  assert.ok(hidden.some((r) => r.relevance.impact === "low"));
  const withUnknown = filterDecisions(list, { minImpact: "high" });
  assert.ok(withUnknown.shown.length > shown.length, "unknown impact is kept unless excluded");
});

test("the map escapes recorded text and labels alternatives as hypotheses", () => {
  const list = records();
  list[0] = { ...list[0], question: "<script>alert(1)</script>" };
  const html = renderMap(list, { title: "Example" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(html, /Hypothesis, not executed/);
  assert.match(html, /need attention/);
});
