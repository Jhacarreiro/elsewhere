import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessCheckpoint } from "../decision-map/checkpoint.mjs";

const HASH = "b".repeat(64);
const COMMIT = "c".repeat(40);

const commit = { role: "repository_commit", root: "repository", pointer: "HEAD", commit: COMMIT, version_proof: "immutable_copy", complete: true };
const change = (over = {}) => ({
  role: "working_tree_change", root: "adapter", pointer: "results/review-input.diff", sha256: HASH,
  version_proof: "pre_decision_time", written_at: "2026-01-15T16:39:58Z", complete: true, ...over,
});

function checkpoint(over = {}) {
  return {
    schema_version: 0,
    id: "chk_0123456789abcdef",
    decision_id: "dec_0123456789abcdef",
    run: { run_id: "example-run-0001" },
    stage: "review",
    at: { value: "2026-01-15T16:40:00Z", source: "artifact_field" },
    inputs: [commit, change()],
    known_differences: [],
    excluded: [],
    adequacy: { status: "adequate", failed: [] },
    producer: { name: "test", version: "0.0.0" },
    ...over,
  };
}

const reasons = (record) => assessCheckpoint(record).adequacy.failed.map((f) => f.reason);

test("a checkpoint whose inputs are all proven, complete and pre-checkpoint is adequate", () => {
  assert.deepEqual(assessCheckpoint(checkpoint()).adequacy, { status: "adequate", failed: [] });
});

test("a truncated input makes the checkpoint inadequate even with a valid proof, and says which input", () => {
  const out = assessCheckpoint(checkpoint({ inputs: [commit, change({ complete: false, incomplete_reason: "diff cut off mid-hunk" })] }));
  assert.equal(out.adequacy.status, "inadequate");
  assert.deepEqual(out.adequacy.failed, [{ role: "working_tree_change", pointer: "results/review-input.diff", reason: "incomplete: diff cut off mid-hunk" }]);
});

test("an input without a completeness claim is not assumed complete", () => {
  const { complete, ...unclaimed } = change();
  assert.deepEqual(reasons(checkpoint({ inputs: [commit, unclaimed] })), ["not shown to be complete"]);
});

test("an input written at or after the checkpoint time fails, so later state cannot pass as the starting point", () => {
  assert.deepEqual(reasons(checkpoint({ inputs: [commit, change({ written_at: "2026-01-15T16:40:00Z" })] })), ["written at or after the checkpoint time"]);
  assert.deepEqual(reasons(checkpoint({ inputs: [commit, change({ written_at: "2026-01-16T09:00:00Z" })] })), ["written at or after the checkpoint time"]);
});

test("inputs without a version proof or hash fail", () => {
  assert.deepEqual(reasons(checkpoint({ inputs: [commit, change({ version_proof: "looks_unchanged" })] })), ["no version proof"]);
  assert.deepEqual(reasons(checkpoint({ inputs: [commit, change({ sha256: undefined })] })), ["no content hash"]);
});

test("without a repository commit there is no code to start from", () => {
  assert.deepEqual(reasons(checkpoint({ inputs: [change()] })), ["no repository commit"]);
  assert.deepEqual(reasons(checkpoint({ inputs: [{ ...commit, commit: "abc123" }, change()] })), ["no full commit id"]);
});

test("without a checkpoint time nothing can be proven pre-decision", () => {
  assert.deepEqual(reasons(checkpoint({ at: { value: null, source: "unknown" } })), ["no checkpoint time"]);
});

test("unrecorded configuration differences are not read as no differences", () => {
  const { known_differences, ...rest } = checkpoint();
  assert.deepEqual(reasons(rest), ["differences since the run are not recorded"]);
});

test("an input that is also excluded from the replay is a contradiction", () => {
  assert.deepEqual(reasons(checkpoint({ excluded: [{ root: "adapter", pointer: "results/review-input.diff", reason: "written_after_checkpoint" }] })), ["also listed as excluded"]);
});

test("a stated adequacy is recomputed, never trusted", () => {
  const out = assessCheckpoint(checkpoint({ inputs: [change()], adequacy: { status: "adequate", failed: [] } }));
  assert.equal(out.adequacy.status, "inadequate");
});

test("the documented example is the shape the schema describes", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/checkpoint-record.v0.schema.json", import.meta.url), "utf8"));
  const doc = await readFile(new URL("../docs/CHECKPOINT_RECORD.md", import.meta.url), "utf8");
  const example = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  for (const field of schema.required) assert.ok(field in example, `example lacks ${field}`);
  for (const field of Object.keys(example)) assert.ok(field in schema.properties, `schema lacks ${field}`);
  assert.equal(assessCheckpoint(example).adequacy.status, example.adequacy.status);
});
