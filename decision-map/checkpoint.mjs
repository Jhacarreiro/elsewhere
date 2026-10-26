// Checkpoint record (Phase 3 step 1).
// Decides whether a checkpoint is adequate for a replay: every input the deciding stage consumed is
// proven to be the version that existed when the stage started, is complete, and is not also marked
// as something the replay must not see. The stated adequacy is never trusted; it is recomputed.

const PROOFS = new Set(["immutable_copy", "pre_decision_hash", "pre_decision_time"]);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ROOTS = new Set(["run", "adapter", "repository"]);

const instant = (value) => (typeof value === "string" ? Date.parse(value) : NaN);
const key = (root, pointer) => `${root}\u0000${pointer}`;

function inputProblem(input, at) {
  if (!ROOTS.has(input.root) || typeof input.pointer !== "string" || input.pointer.length === 0) {
    return "no usable root and pointer";
  }
  if (input.role === "repository_commit") {
    // A commit is its own immutable copy: its id fixes its content.
    if (!COMMIT.test(input.commit || "")) return "no full commit id";
    if (input.version_proof !== "immutable_copy") return "a commit must be proven as an immutable copy";
    // The id fixes the content, not that it was the code the stage started from: a ref resolved now
    // may have moved since. That takes an artifact written before the checkpoint that names the id.
    const rec = input.recorded_in;
    if (!rec || !ROOTS.has(rec.root) || rec.root === "repository" || !rec.pointer || !SHA256.test(rec.sha256 || "")) {
      return "not shown to be the commit the stage started from";
    }
    if (!(instant(rec.written_at) < at)) return "commit recorded only at or after the checkpoint time";
  } else if (!SHA256.test(input.sha256 || "")) {
    return "no content hash";
  }
  if (!PROOFS.has(input.version_proof)) return "no version proof";
  if (input.version_proof === "pre_decision_time") {
    const written = instant(input.written_at);
    if (Number.isNaN(written)) return "time proof without a write time";
    if (!(written < at)) return "written at or after the checkpoint time";
  }
  if (input.complete !== true) return input.incomplete_reason ? `incomplete: ${input.incomplete_reason}` : "not shown to be complete";
  return null;
}

/**
 * Recomputes a checkpoint record's adequacy.
 * - Without a checkpoint time nothing can be proven pre-decision, so the checkpoint is inadequate.
 * - At least one repository commit is required: without it the replay has no code to start from. It
 *   must be named by an artifact written before the checkpoint, so a ref that moved since cannot pass.
 * - Each input needs a version proof; a time proof needs a write time strictly before the checkpoint.
 * - An input that is not shown to be complete (a truncated diff, a partial copy) fails, even with a
 *   valid proof, because a replay from it would not see what the stage saw.
 * - Configuration differences between the run and the replay must be recorded, even as an empty list,
 *   so "none recorded" is never mistaken for "none".
 * - An input that is also listed as excluded is a contradiction and fails.
 * @param {object} record checkpoint record v0
 * @returns {object} the record with adequacy recomputed; the input is not mutated
 */
export function assessCheckpoint(record) {
  const failed = [];
  const at = instant(record.at?.value);
  const inputs = Array.isArray(record.inputs) ? record.inputs : [];
  if (Number.isNaN(at)) failed.push({ role: null, pointer: null, reason: "no checkpoint time" });
  if (!inputs.some((i) => i.role === "repository_commit")) {
    failed.push({ role: "repository_commit", pointer: null, reason: "no repository commit" });
  }
  if (!Array.isArray(record.known_differences)) {
    failed.push({ role: "configuration", pointer: null, reason: "differences since the run are not recorded" });
  }
  const excluded = new Set((record.excluded || []).map((e) => key(e.root, e.pointer)));
  for (const input of inputs) {
    const reason = Number.isNaN(at) ? null : inputProblem(input, at);
    if (reason) failed.push({ role: input.role ?? null, pointer: input.pointer ?? null, reason });
    else if (excluded.has(key(input.root, input.pointer))) {
      failed.push({ role: input.role ?? null, pointer: input.pointer, reason: "also listed as excluded" });
    }
  }
  const adequacy = failed.length ? { status: "inadequate", failed } : { status: "adequate", failed: [] };
  return { ...record, adequacy };
}
