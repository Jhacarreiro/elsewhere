import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMap } from "../decision-map/render.mjs";

const HASH = "c".repeat(64);
const base = (generated_alternatives) => ({
  schema_version: 0,
  id: "dec_00000000000000aa",
  run: { run_id: "run-x" },
  stage: "planning",
  time: { value: "2026-01-15T16:40:00Z", source: "artifact_field" },
  decided_by: { kind: "human" },
  question: "Approve the plan?",
  state: "decided",
  chosen: { summary: "Approved", classification: "observed", executed: "yes", validated: "unknown" },
  alternatives: { status: "unknown", items: [] },
  classification: "observed",
  evidence: [{ artifact: "plan", root: "run", pointer: "plan.md", sha256: HASH }],
  producer: { name: "x", version: "0", mode: "extracted" },
  ...(generated_alternatives ? { generated_alternatives } : {}),
});
const section = (items, extra = {}) => ({
  status: "generated",
  boundary: { value: "2026-01-15T16:40:00Z", source: "artifact_field" },
  generator: { name: "gen", version: "1.0", command: "stub", generated_at: "2026-02-01T00:00:00Z" },
  items,
  ...extra,
});
const item = (summary, assumptions) => ({ summary, assumptions, potential_consequences: ["Slower start"], uncertainty: { level: "high" }, classification: "generated", executed: "no" });
const grounded = (text) => ({ text, basis: "grounded", evidence: [{ root: "run", pointer: "plan.md", sha256: HASH, version_proof: "pre_decision_time", excerpt: "needs approval" }] });

test("generated alternatives are shown apart from the run's own, with assumptions, proof and excerpt", () => {
  const html = renderMap([base(section([item("Ask a second reviewer", [grounded("The plan asks for approval"), { text: "Reviewers are free", basis: "unsupported", evidence: [] }])]))]);
  assert.match(html, /Generated alternatives \(1\)/);
  assert.match(html, /Ask a second reviewer <span class="badge gen-generated">Generated hypothesis<\/span>/);
  assert.match(html, /Grounded before the decision<\/span> The plan asks for approval/);
  assert.match(html, /Unsupported<\/span> Reviewers are free/);
  assert.match(html, /pre_decision_time/);
  assert.match(html, /<blockquote>needs approval<\/blockquote>/);
  assert.match(html, /Potential consequences \(hypothesized\)/);
  assert.match(html, /· 1 generated<\/span>/);
  assert.match(html, /Alternatives: unknown/, "the run's own alternatives stay unknown");
});

test("a records file edited by hand cannot show an ungrounded alternative as generated", () => {
  const html = renderMap([base(section([item("Only a guess", [{ text: "No basis", basis: "unsupported", evidence: [] }])]))]);
  assert.doesNotMatch(html, /Only a guess/);
  assert.match(html, /the generator proposed none/);
});

test("a withheld section says why, and a record without the section shows nothing extra", () => {
  const withheld = renderMap([base(section([], { status: "withheld", reason: "No artifact could be shown to predate the decision unchanged." }))]);
  assert.match(withheld, /Generated alternatives: withheld\. No artifact could be shown to predate the decision unchanged\./);
  assert.doesNotMatch(renderMap([base()]), /Generated alternatives/);
});

test("generated text is escaped", () => {
  const html = renderMap([base(section([item("<script>alert(1)</script>", [grounded("<b>x</b>")])]))]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
