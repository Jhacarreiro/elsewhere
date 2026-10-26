# Decision record v0

**Status:** proposal for Phase 1 step 2 of the [roadmap](ROADMAP.md). The read-only [decision map](DECISION_MAP.md) prototype extracts these records from finished runs (`mode: extracted`) and renders them; no runner or adapter emits them yet. The schema is [`schemas/decision-record.v0.schema.json`](../schemas/decision-record.v0.schema.json).

A decision record describes one consequential decision in a development run and where the evidence for it lives. It is **additive**: it never replaces or edits the run's own artifacts, and a run without records works exactly as before. It is **adapter-neutral**: Octopus can be the first producer, but nothing in the record depends on Octopus.

## Two ways to produce records

| Mode | When | Who | Strength |
| --- | --- | --- | --- |
| `extracted` | after a run, read-only | an extractor reading the artifacts in the [provenance inventory](DECISION_PROVENANCE.md) | works on existing runs; rationale is limited to what was written down |
| `emitted` | at decision time | any implementation adapter, optionally | can record alternatives the agent actually weighed, before the outcome is known |

An emitting adapter appends one record per line to `decisions.jsonl` in its attempt directory. The control plane does not need to understand it. Phase 1 starts with `extracted` only.

## Rules

1. **Evidence first.** Every record points to at least one source file, by root (`run`, `adapter` or `repository`), relative path and SHA-256, so a reader can find it and check that it has not changed since extraction.
2. **Classify each claim.** `observed`: the artifact records it as a fact (a phase change, a matched rule, a recorded answer). `agent-stated`: an agent wrote it in its own output. `post-hoc-inferred`: the extractor concluded it. The chosen option, its outcome, the rationale and each alternative carry their own classification; the record's overall classification is the weakest of its parts.
3. **Never invent reasoning.** `rationale` is null when nothing was written. Hidden reasoning is never reconstructed.
4. **Unknown is not zero.** `alternatives.status` is `unknown` unless the source lists alternatives (`listed`) or says none was considered (`none_considered`). Any number of alternatives is valid, including zero. There are no fixed categories or option counts.
5. **Alternatives are hypotheses.** An alternative is always `executed: "no"`. If a later run executes it, that run gets its own record.
6. **Unfinished states are first-class.** `pending` is a question asked with no answer recorded. `not_completed` is an attempt that produced no result, such as a stalled correction round. The schema enforces that `chosen` is set exactly when the state is `decided` or `superseded`, and that `alternatives.items` is non-empty exactly when the status is `listed`.
7. **Time has a source.** `time.source` says whether the time came from a field in the artifact, a header, a commit or only the file time.
8. **Stable ids.** The id is derived from the run id, the primary evidence pointer and an anchor, so extracting the same run twice gives the same ids.
9. **Public examples are sanitized.** Excerpts are short, and records published in this repository must pass `npm run audit:public`.

## Generated alternatives (Phase 2)

`generated_alternatives` is an optional section for alternatives proposed after the run by a generator. It is kept apart from `alternatives`, which only reports what the run's own artifacts say, so a reader never confuses the two.

- **Status.** `generated` means the generator ran on verified pre-decision evidence; zero items is a valid result. `withheld` means nothing was generated, and `reason` says why. A decision without a known time is always withheld, because there is no cutoff for the evidence.
- **Boundary.** `boundary` is the decision time used as the cutoff, with its source. It must be the record's own `time` (same instant and source); any other boundary withholds the section, so a later cutoff cannot let post-decision evidence count.
- **Assumptions.** Each alternative lists its assumptions. A `grounded` assumption cites evidence with a `version_proof` showing which version of the artifact existed at the decision time: `immutable_copy`, `pre_decision_hash` or `pre_decision_time`. An `unsupported` assumption carries no evidence and is shown as such. Every alternative has at least one grounded assumption.
- **Consequences and classification.** `potential_consequences` are always hypotheses. Each item is classified `generated` and is never executed.

[`decision-map/generated.mjs`](../decision-map/generated.mjs) applies these rules to a record. It drops evidence without a version proof, then drops assumptions left without evidence and alternatives left without a grounded assumption, and reports what it dropped and why. Whether a version proof is true is checked against the files by the generator, which is Phase 2 step 2.

## Mapping from existing artifacts

| Source | `stage` | `decided_by.kind` | `state` | `alternatives.status` | Classification |
| --- | --- | --- | --- | --- | --- |
| approved plan and canonical plan commit | planning | human | decided | unknown | observed |
| design ceremony conflict and resolution | plan_review | council | decided | listed (the seats' positions) | agent-stated |
| `intervention.json` with no response | implementation | human | pending | listed | agent-stated question, observed state |
| intervention plus recorded response | implementation | human | decided | listed | observed |
| review debate, include or exclude a finding | review | council | decided | unknown | observed decision, agent-stated reason |
| correction report, fix per finding | correction | agent | decided | unknown | agent-stated |
| stalled correction round | correction | agent | not_completed | unknown | observed |
| quality gate `Decision Branch` | review | adapter_rule | decided | unknown | observed |
| failure classification in `main_update_events.jsonl` | recovery | control_plane | decided | unknown | observed |
| final validation `go`, `revise` or `stop` | final_validation | human or council | decided | unknown | observed |
| delivery as an open PR with follow-up issues | delivery | control_plane | decided | unknown | observed |
| continuation from issues | follow_up | control_plane | decided | unknown | observed |

## Example

Synthetic, shaped like a real pending intervention:

```json
{
  "schema_version": 0,
  "id": "dec_3f9c2a7b1d4e8f60",
  "run": { "run_id": "example-run-0002", "root_run_id": "example-run-0001", "generation": 1, "attempt_id": "attempt-b" },
  "stage": "implementation",
  "time": { "value": "2026-01-15T16:40:00Z", "source": "artifact_field" },
  "decided_by": { "kind": "human" },
  "question": "Which mechanism should authenticate the operator's approval before a post is published?",
  "state": "pending",
  "chosen": null,
  "alternatives": {
    "status": "listed",
    "items": [
      { "option_id": "one_time_token", "summary": "A one-time token sent to the operator out of band", "advantages": ["The agent cannot precompute it"], "limitations": ["Needs an issuer and a delivery channel"], "classification": "agent-stated", "executed": "no" },
      { "option_id": "operator_only_path", "summary": "Only the operator approves, outside the agent", "advantages": ["Strongest separation"], "limitations": ["Less convenient"], "classification": "agent-stated", "executed": "no" },
      { "option_id": "none", "summary": "Keep the interim check only", "classification": "agent-stated", "executed": "no" }
    ]
  },
  "rationale": { "text": "The interim check relies on values the agent supplies itself.", "classification": "agent-stated" },
  "uncertainty": { "level": "high", "note": "No option recommended by the agent." },
  "relevance": { "impact": "high", "reversibility": "costly", "cost": "unknown", "uncertainty": "high" },
  "classification": "agent-stated",
  "evidence": [
    { "artifact": "intervention", "root": "run", "pointer": "implementation_session/attempts/attempt-b/intervention.json#/question", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
  ],
  "producer": { "name": "example-extractor", "version": "0.0.0", "mode": "extracted" }
}
```

## Open questions

- Whether records for automatic council rounds should be grouped under one parent decision per round, or kept flat with `related`.
- How much of the relevance axes can be set from evidence alone, and how often they stay `unknown`. Step 5 measures this.
- Where an adapter's `decisions.jsonl` should be copied when the control plane delivers, so it survives cleanup of the attempt directory.
