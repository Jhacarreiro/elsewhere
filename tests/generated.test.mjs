import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGeneratedRules } from "../decision-map/generated.mjs";

const HASH = "a".repeat(64);
const proof = (version_proof = "pre_decision_hash") => ({ root: "run", pointer: "plan/approved.md#L1-L4", sha256: HASH, version_proof });

function record(section) {
  return {
    schema_version: 0,
    id: "dec_0123456789abcdef",
    state: "decided",
    time: { value: "2026-01-15T16:40:00Z", source: "artifact_field" },
    alternatives: { status: "unknown", items: [] },
    generated_alternatives: {
      status: "generated",
      boundary: { value: "2026-01-15T16:40:00Z", source: "artifact_field" },
      generator: { name: "test-generator", version: "0.0.0", generated_at: "2026-02-01T00:00:00Z" },
      items: [],
      ...section,
    },
  };
}

const alternative = (option_id, assumptions) => ({
  option_id,
  summary: `Alternative ${option_id}`,
  assumptions,
  potential_consequences: ["Might shorten review"],
  uncertainty: { level: "high" },
  classification: "agent-stated",
  executed: "yes",
});

test("kept alternatives are always generated and unexecuted, whatever the generator wrote", () => {
  const { record: out } = applyGeneratedRules(record({
    items: [alternative("a", [{ text: "The plan named two options", basis: "grounded", evidence: [proof()] }])],
  }));
  const [item] = out.generated_alternatives.items;
  assert.equal(item.classification, "generated");
  assert.equal(item.executed, "no");
});

test("evidence without a version proof cannot ground an assumption, and an alternative left without one is dropped", () => {
  const input = record({
    items: [
      alternative("unproven", [
        { text: "Read from a file that changed later", basis: "grounded", evidence: [{ ...proof(), version_proof: undefined }] },
        { text: "A guess", basis: "unsupported", evidence: [] },
      ]),
      alternative("mixed", [
        { text: "Grounded", basis: "grounded", evidence: [proof("immutable_copy"), { ...proof(), sha256: "short" }] },
        { text: "A guess", basis: "unsupported", evidence: [] },
      ]),
    ],
  });
  const { record: out, dropped } = applyGeneratedRules(input);
  assert.deepEqual(out.generated_alternatives.items.map((i) => i.option_id), ["mixed"]);
  assert.deepEqual(dropped, [{ option_id: "unproven", summary: "Alternative unproven", reason: "no grounded assumption" }]);
  const [grounded, guess] = out.generated_alternatives.items[0].assumptions;
  assert.equal(grounded.evidence.length, 1, "the malformed evidence entry is removed");
  assert.equal(guess.basis, "unsupported");
  assert.equal(input.generated_alternatives.items.length, 2, "the input record is not mutated");
});

test("an unsupported assumption never carries evidence, so it cannot look grounded", () => {
  const { record: out } = applyGeneratedRules(record({
    items: [alternative("a", [
      { text: "Grounded", basis: "grounded", evidence: [proof()] },
      { text: "Claimed without basis", basis: "unsupported", evidence: [proof()] },
    ])],
  }));
  assert.deepEqual(out.generated_alternatives.items[0].assumptions[1].evidence, []);
});

test("without a decision time nothing is generated, even if the generator supplied a boundary", () => {
  const { record: out, dropped } = applyGeneratedRules({
    ...record({ items: [alternative("a", [{ text: "Grounded", basis: "grounded", evidence: [proof()] }])] }),
    time: { value: null, source: "unknown" },
  });
  assert.equal(out.generated_alternatives.status, "withheld");
  assert.deepEqual(out.generated_alternatives.items, []);
  assert.match(out.generated_alternatives.reason, /decision time/);
  assert.equal(dropped[0].reason, "no decision time");
});

test("a boundary later than the decision time is not trusted as the cutoff", () => {
  const { record: out, dropped } = applyGeneratedRules(record({
    boundary: { value: "2026-01-20T00:00:00Z", source: "artifact_field" },
    items: [alternative("a", [{ text: "Grounded", basis: "grounded", evidence: [proof()] }])],
  }));
  assert.equal(out.generated_alternatives.status, "withheld");
  assert.deepEqual(out.generated_alternatives.items, []);
  assert.equal(dropped[0].reason, "boundary is not the decision time");
});

test("a withheld section keeps its reason and drops any items", () => {
  const { record: out } = applyGeneratedRules(record({
    status: "withheld",
    reason: "The plan file was overwritten after the decision.",
    items: [alternative("a", [{ text: "Grounded", basis: "grounded", evidence: [proof()] }])],
  }));
  assert.equal(out.generated_alternatives.reason, "The plan file was overwritten after the decision.");
  assert.deepEqual(out.generated_alternatives.items, []);
});

test("zero generated alternatives is a valid result, not a withheld one", () => {
  const { record: out } = applyGeneratedRules(record({ items: [] }));
  assert.equal(out.generated_alternatives.status, "generated");
  assert.deepEqual(out.generated_alternatives.items, []);
});

test("the extractor never writes generated alternatives, so records without the section stay valid under the earlier v0 schema", async () => {
  const { extract } = await import("../decision-map/extract.mjs");
  const fixtures = new URL("./fixtures/", import.meta.url).pathname;
  const records = extract({ runDir: `${fixtures}run-a`, adapterDir: `${fixtures}octopus` });
  assert.ok(records.length > 0);
  assert.ok(records.every((r) => !("generated_alternatives" in r)));
});

test("the map still renders a record that carries generated alternatives", async () => {
  const { renderMap } = await import("../decision-map/render.mjs");
  const { record: out } = applyGeneratedRules(record({
    items: [alternative("a", [{ text: "The plan named two options", basis: "grounded", evidence: [proof()] }])],
  }));
  const html = renderMap([{ ...out, run: { run_id: "r" }, stage: "planning", decided_by: { kind: "human" }, question: "Q?", chosen: null, classification: "observed", evidence: [], producer: { name: "x", version: "0", mode: "extracted" } }]);
  assert.match(html, /Q\?/);
});
