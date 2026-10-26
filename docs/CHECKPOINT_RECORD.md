# Checkpoint record v0

**Status:** proposed for [roadmap](ROADMAP.md) Phase 3 step 1. Schema: [`checkpoint-record.v0.schema.json`](../schemas/checkpoint-record.v0.schema.json). Rules: [`decision-map/checkpoint.mjs`](../decision-map/checkpoint.mjs).

A checkpoint record describes the point just before one decision, as the stage that made it saw it. A replay (Phase 3 step 3) starts from it; nothing else about the original run may reach the replay. It is a separate record from the [decision record](DECISION_RECORD.md) and points at one by `decision_id`, so decision records stay unchanged.

## Fields

- **`at`.** When the stage started consuming its inputs, with its source, as in the decision record's `time`. It is the cutoff for every input. Use the earliest time the stage is recorded reading its inputs, not a later one.
- **`inputs`.** Everything the stage consumed, each with a `role`, a root and pointer as in decision record evidence, and a `version_proof` from the same set Phase 2 uses: `immutable_copy`, `pre_decision_hash` or `pre_decision_time`. A `repository_commit` carries its full `commit` id and is proven as an `immutable_copy`, because the id fixes its content. Every other input carries a `sha256`; with `pre_decision_time` it also carries `written_at`, the later of its last write and change times. `complete` says whether the input is all the stage saw. A diff cut off mid-change, or a copy of part of a file, is `complete: false` with an `incomplete_reason`.
- **`known_differences`.** What differs between the run and the replay environment: tool versions, models, provider routing, caps. `recorded` is what the run recorded (null when it recorded nothing) and `replay` is what the replay will use. An empty list means it was checked and nothing differs; a missing list is never read as that.
- **`excluded`.** Artifacts the replay must not see: anything written after `at`, the decision's own outcome, and anything whose version cannot be established. The replay harness hides them.
- **`adequacy`.** Computed, never trusted from the producer.

## When a checkpoint is adequate

`decision-map/checkpoint.mjs` recomputes `adequacy`. A checkpoint is `inadequate`, and `failed` names each input and why, when:

- `at` has no value, so nothing can be proven to predate it;
- there is no `repository_commit`, so the replay has no code to start from;
- an input lacks a hash (or a full commit id), lacks a version proof, or has a time proof whose `written_at` is missing or not strictly before `at`;
- an input is not shown to be complete;
- `known_differences` is missing; or
- an input is also listed in `excluded`.

An inadequate checkpoint is reported as it is. It is not patched by hand; the replay moves to an earlier checkpoint that is adequate, or does not run.

A known difference does not make a checkpoint inadequate: models and tools change, and a replay rarely runs with exactly the original ones. It limits what the replay can show, and results must state it.

## Example

Synthetic, shaped like a review round whose input diff was stored truncated:

```json
{
  "schema_version": 0,
  "id": "chk_7a1e5c3b9d2f4068",
  "decision_id": "dec_0123456789abcdef",
  "run": { "run_id": "example-run-0001", "round": 0 },
  "stage": "review",
  "at": { "value": "2026-01-15T16:40:02Z", "source": "artifact_field" },
  "inputs": [
    { "role": "repository_commit", "root": "repository", "pointer": "refs/heads/run-base", "commit": "0123456789abcdef0123456789abcdef01234567", "version_proof": "immutable_copy", "complete": true },
    { "role": "working_tree_change", "root": "adapter", "pointer": "results/review-input-initial.diff", "sha256": "1111111111111111111111111111111111111111111111111111111111111111", "version_proof": "pre_decision_time", "written_at": "2026-01-15T16:40:00Z", "complete": false, "incomplete_reason": "diff cut off mid-hunk; the diff stat counts more changed lines" },
    { "role": "stage_context", "root": "adapter", "pointer": "worktree/results/review-context-initial.md", "sha256": "2222222222222222222222222222222222222222222222222222222222222222", "version_proof": "pre_decision_time", "written_at": "2026-01-15T16:40:00Z", "complete": true }
  ],
  "known_differences": [
    { "subject": "adapter version", "recorded": null, "replay": "example-adapter 2.0.0", "note": "The run did not record its adapter version; the adapter was upgraded since." }
  ],
  "excluded": [
    { "root": "adapter", "pointer": "results/review-findings-round-1.json", "reason": "written_after_checkpoint" }
  ],
  "adequacy": {
    "status": "inadequate",
    "failed": [
      { "role": "working_tree_change", "pointer": "results/review-input-initial.diff", "reason": "incomplete: diff cut off mid-hunk; the diff stat counts more changed lines" }
    ]
  },
  "producer": { "name": "example-checkpoint-builder", "version": "0.0.0" }
}
```

## Open questions

- Whether a working tree can be rebuilt adequately from a stage's later outputs (for example an agent's transcript of the edits it made), and what proof that would carry. Step 2 tries it on the baseline run and reports the result either way.
- Which configuration a Development Cycle run records at all. Where it records nothing, `recorded` is null and the difference cannot be ruled out.
